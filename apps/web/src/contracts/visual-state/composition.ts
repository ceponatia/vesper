import {
  AFFORDANCE_UNIT_ONE,
  AFFORDANCE_UNIT_ZERO,
  complementUnit,
  type UnitInterval,
} from "../affordances/core";
import { diag, type DiagnosticSink } from "../diagnostics";
import { VISUAL_STATE_RELATIONSHIP_CYCLE, VISUAL_STATE_RELATIONSHIP_TARGET_MISSING } from "./diagnostics";
import type { VisualStateFeature } from "./feature";
import type { VisualStateRelationship } from "./relationships";
import type { VisualStateSuppression } from "./suppression";

/**
 * The composition resolver.
 *
 * It answers one question for every feature in a snapshot: given the typed
 * edges the adapters asserted, what is still visible of this feature, and what
 * is acting on it?
 *
 * Two rules decide everything here.
 *
 * **Composition never deletes a feature.** A covered hairstyle, an occluded
 * shirt, natural hair under a hairpiece — all of them stay in the snapshot with
 * their key, fingerprint and provenance intact. An image render needs the
 * covered facts to hold the character together, the inspector needs them to
 * explain a selection, and a retake needs them to rebuild the same moment. Only
 * the ANNOTATION says a feature is hidden; observer and camera selection (slices
 * 4–5) read that annotation and leave the feature alone.
 *
 * **A broken edge is dropped, never followed.** A relationship naming a key the
 * snapshot does not hold, or one that closes a cycle, is suppressed with a
 * diagnostic and does not contribute to any annotation. Unknown composition
 * fails closed (spec invariant 3), and it fails at the EDGE rather than at the
 * feature, so one bad reference cannot silence a fact.
 */

// ---------------------------------------------------------------------------
// The resolved view
// ---------------------------------------------------------------------------

export interface VisualStateCompositionEntry {
  readonly key: string;
  /** This feature's own edges that survived resolution, in the order it declared them. */
  readonly relationships: readonly VisualStateRelationship[];
  /** Keys whose accepted `modifies` points here — wetness on a hairstyle, a smudge on makeup. */
  readonly modifiedBy: readonly string[];
  /**
   * The key that stands in front of this feature as the visible surface — a
   * hairpiece over natural hair. Present ⇒ `effectiveVisibility` is zero, and
   * the replaced feature is still in the snapshot.
   */
  readonly replacedBy?: string;
  /** Strongest accepted incoming `covers` degree — a garment over this surface. */
  readonly coverage: UnitInterval;
  /** Strongest accepted incoming `occludes` degree — another feature in front of it. */
  readonly occlusion: UnitInterval;
  /** Keys this feature hangs off: an earring on an ear, a brooch on a coat. */
  readonly attachedTo: readonly string[];
  /** Keys this feature is computed from — water beading from a wet material. */
  readonly derivedFrom: readonly string[];
  /**
   * How much of this feature composition leaves visible: `0` when something
   * replaces its surface, otherwise `1 − max(coverage, occlusion)`.
   *
   * This is COMPOSITION only. It says what is in front of the feature, not what
   * the observer can resolve — lighting, distance, angle, motion and framing are
   * the visibility read's inputs and multiply into this in `visibility.ts`. A
   * feature nobody covers reads as fully composed-visible here even in a
   * pitch-dark room.
   */
  readonly effectiveVisibility: UnitInterval;
}

export interface VisualStateComposition {
  /** One entry per input feature, in the input's order. */
  readonly entries: readonly VisualStateCompositionEntry[];
  /** Edges dropped for a missing target or a cycle, in resolution order. */
  readonly suppressions: readonly VisualStateSuppression[];
}

/** The empty composition — what a snapshot with no features resolves to. */
export function emptyVisualStateComposition(): VisualStateComposition {
  return { entries: [], suppressions: [] };
}

/** One feature's resolved annotation, or `undefined` when the key is not in the snapshot. */
export function visualStateCompositionFor(
  composition: VisualStateComposition,
  key: string,
): VisualStateCompositionEntry | undefined {
  return composition.entries.find((entry) => entry.key === key);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** One candidate edge, kept with its declaration index so suppression is addressable. */
interface CandidateEdge {
  readonly index: number;
  readonly relationship: VisualStateRelationship;
  readonly targetKey: string;
}

function edgeDetail(relationship: VisualStateRelationship): string {
  return `${relationship.kind}:${relationship.targetKey}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The degree arithmetic, and the contract it rests on.
 *
 * `maxUnit` and `complementUnit` take the `UnitInterval` brand at its word: a
 * clamped integer in `[0, 10_000]`. Nothing here re-validates, because every
 * feature reaching this module has been through `validateVisualStateFeature`,
 * which runs the wire schema and therefore the branded `degree` parser.
 *
 * That is a real coupling, so it is worth naming: an adapter that builds a
 * feature WITHOUT going through the validator can put a float or an
 * out-of-range number in a `degree`, and the result is an
 * `effectiveVisibility` of `9999.5` — silently, since nothing downstream
 * re-checks either. Every adapter in this folder ends in
 * `validateVisualStateFeature`; a sixth one must too.
 */
function maxUnit(left: UnitInterval, right: UnitInterval): UnitInterval {
  return left >= right ? left : right;
}

/** Mutable accumulator for one feature; frozen into a `VisualStateCompositionEntry` at the end. */
interface CompositionAccumulator {
  readonly key: string;
  relationships: VisualStateRelationship[];
  modifiedBy: string[];
  replacedBy?: string;
  coverage: UnitInterval;
  occlusion: UnitInterval;
  attachedTo: string[];
  derivedFrom: string[];
}

/**
 * Resolve every relationship in a feature list.
 *
 * DETERMINISM is structural rather than incidental: features are walked in the
 * order given (which is the snapshot's sort), each feature's edges in the order
 * it declared them, and every accumulated key list is sorted with explicit
 * comparators. The same committed truth therefore produces byte-equal
 * annotations and a byte-equal suppression list on every machine and every
 * replay.
 *
 * TWO PRECONDITIONS the caller owns, both met by `buildVisualStateSnapshot`,
 * which is the intended entry point:
 *
 * - **Keys are unique.** Duplicates do not throw and do not collapse: they share
 *   one accumulator and BOTH apply, so a key listed twice with an `attached_to`
 *   edge lands as `attachedTo: ["b", "b"]`. The snapshot builder deduplicates
 *   before calling, which is why that is harmless there and why a direct caller
 *   must deduplicate too.
 * - **Every feature passed `validateVisualStateFeature`.** The degree arithmetic
 *   below is fixed point over `UnitInterval`, and it trusts rather than re-checks
 *   the brand — see the note beside it.
 */
export function resolveVisualStateComposition(
  features: readonly VisualStateFeature[],
  sink?: DiagnosticSink,
  path = "visual_state.composition",
): VisualStateComposition {
  if (features.length === 0) return emptyVisualStateComposition();

  const known = new Set<string>();
  for (const feature of features) known.add(feature.key);

  const suppressions: VisualStateSuppression[] = [];

  // Pass 1 — drop edges whose target the snapshot does not hold, and every
  // self-reference. A feature that modifies itself is a degenerate cycle, and
  // catching it here keeps the graph walk below free of the special case.
  const candidates = new Map<string, CandidateEdge[]>();
  for (const feature of features) {
    const kept: CandidateEdge[] = [];
    feature.relationships.forEach((relationship, index) => {
      const targetKey = relationship.targetKey;
      if (targetKey === feature.key) {
        suppressions.push({
          key: feature.key,
          code: VISUAL_STATE_RELATIONSHIP_CYCLE,
          detail: edgeDetail(relationship),
        });
        sink?.push(
          diag("warn", VISUAL_STATE_RELATIONSHIP_CYCLE, `${feature.key} composes with itself`, {
            path,
            context: { key: feature.key, relationship: relationship.kind },
          }),
        );
        return;
      }
      if (!known.has(targetKey)) {
        suppressions.push({
          key: feature.key,
          code: VISUAL_STATE_RELATIONSHIP_TARGET_MISSING,
          detail: edgeDetail(relationship),
        });
        sink?.push(
          diag("warn", VISUAL_STATE_RELATIONSHIP_TARGET_MISSING, `No feature holds ${targetKey}`, {
            path,
            context: { key: feature.key, relationship: relationship.kind, targetKey },
          }),
        );
        return;
      }
      kept.push({ index, relationship, targetKey });
    });
    candidates.set(feature.key, kept);
  }

  // Pass 2 — drop the edges that close a cycle. One depth-first walk over the
  // whole graph finds every back edge, and removing back edges is exactly what
  // leaves a DAG behind. The walk is iterative rather than recursive so a deeply
  // chained composition cannot exhaust the stack.
  const cyclic = dropCyclicEdges(features, candidates, suppressions, sink, path);

  // Pass 3 — accumulate. Incoming aggregates are collected in feature order,
  // so "which replacement wins" is the first one the snapshot lists rather than
  // whichever adapter happened to run last.
  const accumulators = new Map<string, CompositionAccumulator>();
  for (const feature of features) {
    accumulators.set(feature.key, {
      key: feature.key,
      relationships: [],
      modifiedBy: [],
      coverage: AFFORDANCE_UNIT_ZERO,
      occlusion: AFFORDANCE_UNIT_ZERO,
      attachedTo: [],
      derivedFrom: [],
    });
  }

  for (const feature of features) {
    const source = accumulators.get(feature.key);
    if (source === undefined) continue;
    for (const edge of candidates.get(feature.key) ?? []) {
      if (cyclic.has(edgeId(feature.key, edge.index))) continue;
      const target = accumulators.get(edge.targetKey);
      if (target === undefined) continue;
      source.relationships.push(edge.relationship);
      switch (edge.relationship.kind) {
        case "modifies":
          target.modifiedBy.push(feature.key);
          break;
        case "replaces_visible_surface":
          target.replacedBy = target.replacedBy ?? feature.key;
          break;
        case "covers":
          target.coverage = maxUnit(target.coverage, edge.relationship.degree);
          break;
        case "occludes":
          target.occlusion = maxUnit(target.occlusion, edge.relationship.degree);
          break;
        case "attached_to":
          source.attachedTo.push(edge.targetKey);
          break;
        case "derived_from":
          source.derivedFrom.push(edge.targetKey);
          break;
      }
    }
  }

  const entries = features.map((feature): VisualStateCompositionEntry => {
    const accumulator = accumulators.get(feature.key);
    if (accumulator === undefined) {
      return {
        key: feature.key,
        relationships: [],
        modifiedBy: [],
        coverage: AFFORDANCE_UNIT_ZERO,
        occlusion: AFFORDANCE_UNIT_ZERO,
        attachedTo: [],
        derivedFrom: [],
        effectiveVisibility: AFFORDANCE_UNIT_ONE,
      };
    }
    const obstruction = maxUnit(accumulator.coverage, accumulator.occlusion);
    return {
      key: accumulator.key,
      relationships: accumulator.relationships,
      modifiedBy: [...accumulator.modifiedBy].sort(compareStrings),
      ...(accumulator.replacedBy === undefined ? {} : { replacedBy: accumulator.replacedBy }),
      coverage: accumulator.coverage,
      occlusion: accumulator.occlusion,
      attachedTo: [...accumulator.attachedTo].sort(compareStrings),
      derivedFrom: [...accumulator.derivedFrom].sort(compareStrings),
      effectiveVisibility:
        accumulator.replacedBy === undefined ? complementUnit(obstruction) : AFFORDANCE_UNIT_ZERO,
    };
  });

  return { entries, suppressions };
}

/**
 * A stable address for one declared edge. The separator is a control character,
 * so no feature key can contain one and two different edges cannot collide.
 */
function edgeId(sourceKey: string, index: number): string {
  return `${sourceKey}\u0000${index}`;
}

type WalkState = "visiting" | "done";

/**
 * Find and suppress every edge that closes a cycle, iteratively.
 *
 * The walk is a textbook colour-marking depth-first search: an edge into a node
 * still on the current path is a back edge, and back edges are exactly the edges
 * whose removal makes a directed graph acyclic. Roots are taken in feature order
 * and each node's edges in declaration order, so which edge of a cycle is
 * blamed is a property of the contract rather than of a hash iteration order.
 */
function dropCyclicEdges(
  features: readonly VisualStateFeature[],
  candidates: ReadonlyMap<string, readonly CandidateEdge[]>,
  suppressions: VisualStateSuppression[],
  sink: DiagnosticSink | undefined,
  path: string,
): ReadonlySet<string> {
  const cyclic = new Set<string>();
  const walk = new Map<string, WalkState>();

  for (const root of features) {
    if (walk.has(root.key)) continue;
    walk.set(root.key, "visiting");
    const stack: { key: string; next: number }[] = [{ key: root.key, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const edges = candidates.get(frame.key) ?? [];
      const edge = edges[frame.next];
      if (edge === undefined) {
        walk.set(frame.key, "done");
        stack.pop();
        continue;
      }
      frame.next += 1;
      const state = walk.get(edge.targetKey);
      if (state === "visiting") {
        cyclic.add(edgeId(frame.key, edge.index));
        suppressions.push({
          key: frame.key,
          code: VISUAL_STATE_RELATIONSHIP_CYCLE,
          detail: edgeDetail(edge.relationship),
        });
        sink?.push(
          diag("warn", VISUAL_STATE_RELATIONSHIP_CYCLE, `${frame.key} closes a composition cycle`, {
            path,
            context: { key: frame.key, relationship: edge.relationship.kind, targetKey: edge.targetKey },
          }),
        );
        continue;
      }
      if (state === "done") continue;
      walk.set(edge.targetKey, "visiting");
      stack.push({ key: edge.targetKey, next: 0 });
    }
  }

  return cyclic;
}
