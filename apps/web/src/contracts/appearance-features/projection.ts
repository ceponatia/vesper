import { z } from "zod";
import type { AttributeValue } from "../attributes";
import { diag, type DiagnosticSink } from "../diagnostics";
import { appearanceAttributeRecognitionAt, appearanceAttributeRecognitionCatalog } from "./attribute-recognition";
import { currentAnatomyStates, type AnatomyPartState } from "./anatomy-state";
import type { AppearanceFeaturePersistence } from "./definitions";
import {
  activeLocatedFacts,
  parseLocatedFactValue,
  APPEARANCE_FACT_KIND_UNKNOWN,
  APPEARANCE_FACT_LOCUS_NOT_ALLOWED,
  type LocatedAppearanceFact,
} from "./facts";
import { bodyLocusKey, validateBodyLocusRef, type BodyLocusRef } from "./locus";
import {
  appearanceDetailTierSchema,
  appearanceRecognitionPriorsSchema,
  defineAppearanceRecognitionPriors,
  type AppearanceDetailTier,
  type AppearanceRecognitionPriors,
} from "./priors";
import { appearanceFeatureKindRegistry } from "./registry";

/**
 * The recognizability projection — normalized, truth-level feature records.
 * Recognizability is a projection, never a stored list.
 *
 * Source records (attributes, located facts, anatomy state, conditions,
 * presentation) describe the body. This module's output is the lane-neutral
 * projection the affordance recognition layer consumes: what the feature IS,
 * where it sits, how stable it is, and its authored recognition priors —
 * never salience, never observer state, never prose.
 *
 * FROZEN SEAM (slice 7): the exported names and shapes below are the
 * interface consumed by `src/contracts/affordances/recognition/`. Add
 * exports freely; do not rename or reshape these.
 */

export const appearanceStabilities = [
  "inherent",
  "persistent",
  "transient",
  "presentation",
] as const;

export const appearanceStabilitySchema = z.enum(appearanceStabilities);

export type AppearanceStability = z.infer<typeof appearanceStabilitySchema>;

/** Where a projected feature's truth lives — provenance, not a value copy. */
export const appearanceSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attribute"), attributeId: z.string().min(1) }),
  z.object({ kind: z.literal("located_fact"), factId: z.string().min(1) }),
  z.object({ kind: z.literal("anatomy"), locusKey: z.string().min(1) }),
  z.object({ kind: z.literal("condition"), conditionKey: z.string().min(1) }),
  z.object({ kind: z.literal("presentation"), itemId: z.string().min(1) }),
]);

export type AppearanceSourceRef = z.infer<typeof appearanceSourceRefSchema>;

/**
 * The detail-tier + priors vocabulary lives in `./priors` (a leaf module, so
 * the registries this file consumes can depend on it without a cycle) and is
 * re-exported here UNCHANGED — `appearance-features/projection` remains the
 * import path for every one of these names.
 */
export { appearanceDetailTierSchema, appearanceRecognitionPriorsSchema, defineAppearanceRecognitionPriors };
export type { AppearanceDetailTier, AppearanceRecognitionPriors };

/**
 * One normalized truth-level feature record. `key` is stable for the
 * conceptual feature (`<subject>/<locusKey>/<aspect>`); `truthFingerprint`
 * changes with its value (`present` → `absent`), which is how observer
 * memory detects change without losing feature identity. Structured values
 * project into `semanticTags`; no final prose.
 */
export interface ProjectedFeatureTruth {
  readonly key: string;
  readonly subjectId: string;
  readonly locus: BodyLocusRef;
  readonly sourceRef: AppearanceSourceRef;
  readonly truthFingerprint: string;
  readonly semanticTags: readonly string[];
  readonly stability: AppearanceStability;
  readonly priors: AppearanceRecognitionPriors;
}

/** The one key builder — `subject/fingers:left:ring_finger/presence`. */
export function appearanceFeatureKey(
  subjectId: string,
  locus: BodyLocusRef,
  aspect: string,
): string {
  return `${subjectId}/${bodyLocusKey(locus)}/${aspect}`;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** An attribute in the catalog held a value the projector cannot read. */
export const APPEARANCE_ATTRIBUTE_VALUE_UNUSABLE = "appearance.projection.attribute_value_unusable";
/** Two sources projected the same feature key; the first one wins. */
export const APPEARANCE_FEATURE_KEY_DUPLICATE = "appearance.projection.duplicate_key";
/** The body-area view could not nest a record (a leaf and a node collided). */
export const APPEARANCE_BODY_AREA_CONFLICT = "appearance.body_area.node_conflict";

/** The aspect every topology record projects under. */
export const APPEARANCE_PRESENCE_ASPECT = "presence";

/**
 * CALIBRATION — topology's shared priors. A changed body TOPOLOGY (a missing
 * digit, a prosthetic) is both the rarest and the most identity-laden thing
 * this projector emits, so it sits well above every authored mark family.
 * Tier 2 rather than 1: a missing finger is plain in conversation but is not a
 * silhouette read the way a missing arm would be — a per-locus tier is the
 * obvious later refinement.
 */
export const APPEARANCE_ANATOMY_PRIORS: AppearanceRecognitionPriors = defineAppearanceRecognitionPriors({
  baseUniqueness: 8_000,
  baseImportance: 7_000,
  minimumDetailTier: 2,
  repeatFamily: "anatomy",
});

// ---------------------------------------------------------------------------
// Deterministic fingerprints
// ---------------------------------------------------------------------------

/**
 * Canonical JSON with sorted object keys — the whole point of a
 * `truthFingerprint`: the same body truth must produce the same string on
 * every machine and every replay, so observer memory can compare "what I
 * remember" with "what is true now". No clock, no randomness, no locale.
 */
/** `Array.isArray` on an `unknown` widens to `any[]`; this keeps it `unknown`. */
function isValueArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function appearanceCanonicalFingerprint(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (isValueArray(value)) return `[${value.map(appearanceCanonicalFingerprint).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${appearanceCanonicalFingerprint(item)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  return "null";
}

/** Every string leaf of a parsed value, in canonical (sorted-key) order. */
function valueTags(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (isValueArray(value)) return value.flatMap(valueTags);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([, item]) => valueTags(item));
  }
  return [];
}

function stabilityFor(persistence: AppearanceFeaturePersistence): AppearanceStability {
  switch (persistence) {
    case "stable":
      return "inherent";
    case "persistent":
      return "persistent";
    case "transient":
      return "transient";
  }
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export interface AppearanceProjectionInput {
  readonly subjectId: string;
  /** Already-resolved attribute values (overlays applied by the caller). */
  readonly attributes: readonly AttributeValue[];
  readonly locatedFacts?: readonly LocatedAppearanceFact[];
  readonly anatomy?: readonly AnatomyPartState[];
  /** Story-clock minutes: which validity windows and topology rows are in force. */
  readonly atMinutes: number;
  readonly sink?: DiagnosticSink;
}

function projectAttributes(input: AppearanceProjectionInput): ProjectedFeatureTruth[] {
  const values = new Map<string, AttributeValue["value"]>();
  for (const attribute of input.attributes) values.set(attribute.id, attribute.value);

  const projected: ProjectedFeatureTruth[] = [];
  for (const entry of appearanceAttributeRecognitionCatalog) {
    const raw = values.get(entry.attributeId);
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      input.sink?.push(
        diag("warn", APPEARANCE_ATTRIBUTE_VALUE_UNUSABLE, `${entry.attributeId} is not a single enum value`, {
          path: "appearance.projection.attribute",
          context: { attributeId: entry.attributeId },
        }),
      );
      continue;
    }
    // Ordinary vocabulary members are NOT recognition candidates — silence,
    // not a diagnostic ("no treating every non-default attribute as
    // recognition-worthy").
    if (!entry.eligibleValues.includes(raw)) continue;
    const locus: BodyLocusRef = { bodyLocationId: entry.bodyLocationId };
    projected.push({
      key: appearanceFeatureKey(input.subjectId, locus, entry.aspect),
      subjectId: input.subjectId,
      locus,
      sourceRef: { kind: "attribute", attributeId: entry.attributeId },
      truthFingerprint: raw,
      semanticTags: entry.semanticTagsFor(raw),
      stability: "inherent",
      priors: entry.priors,
    });
  }
  return projected;
}

function projectLocatedFacts(input: AppearanceProjectionInput): ProjectedFeatureTruth[] {
  const projected: ProjectedFeatureTruth[] = [];
  for (const fact of activeLocatedFacts(input.locatedFacts ?? [], input.atMinutes)) {
    if (fact.subjectId !== input.subjectId) continue;
    const kind = appearanceFeatureKindRegistry.byId(fact.kindId);
    if (!kind) {
      input.sink?.push(
        diag("warn", APPEARANCE_FACT_KIND_UNKNOWN, `Unknown appearance feature kind ${fact.kindId}`, {
          path: "appearance.projection.located_fact",
          context: { factId: fact.id, kindId: fact.kindId },
        }),
      );
      continue;
    }
    // Appearance-only read: an unsupported detail path heals to the coarse
    // locus (a mark on the ring finger is still on the fingers).
    const validation = validateBodyLocusRef(fact.locus, input.sink, "appearance.located_fact.locus");
    if (!validation.ok) continue;
    const locus = validation.locus;
    if (!appearanceFeatureKindRegistry.allowsBodyLocation(fact.kindId, locus.bodyLocationId)) {
      input.sink?.push(
        diag("warn", APPEARANCE_FACT_LOCUS_NOT_ALLOWED, `${fact.kindId} may not sit at ${locus.bodyLocationId}`, {
          path: "appearance.located_fact.locus",
          context: { factId: fact.id, kindId: fact.kindId },
        }),
      );
      continue;
    }
    const value = parseLocatedFactValue(appearanceFeatureKindRegistry, fact, input.sink);
    if (value === null) continue;
    const [family = fact.kindId] = fact.kindId.split(".");
    projected.push({
      key: appearanceFeatureKey(input.subjectId, locus, fact.kindId),
      subjectId: input.subjectId,
      locus,
      sourceRef: { kind: "located_fact", factId: fact.id },
      truthFingerprint: appearanceCanonicalFingerprint(value),
      semanticTags: [
        family,
        fact.kindId,
        locus.bodyLocationId,
        ...(locus.side === undefined ? [] : [locus.side]),
        ...valueTags(value),
      ],
      stability: stabilityFor(kind.persistence),
      priors: kind.recognition,
    });
  }
  return projected;
}

function projectAnatomy(input: AppearanceProjectionInput): ProjectedFeatureTruth[] {
  const projected: ProjectedFeatureTruth[] = [];
  for (const state of currentAnatomyStates(input.anatomy ?? [], input.atMinutes, input.sink)) {
    if (state.subjectId !== input.subjectId) continue;
    // An ordinary present part is not a feature — only a departure from the
    // baseline body is (absence, alteration, replacement).
    if (state.state === "present" && state.alterationKindId === undefined) continue;
    const locus = state.locus;
    projected.push({
      key: appearanceFeatureKey(input.subjectId, locus, APPEARANCE_PRESENCE_ASPECT),
      subjectId: input.subjectId,
      locus,
      sourceRef: { kind: "anatomy", locusKey: bodyLocusKey(locus) },
      truthFingerprint:
        state.alterationKindId === undefined ? state.state : `${state.state}:${state.alterationKindId}`,
      semanticTags: [
        "anatomy",
        state.state,
        ...(state.alterationKindId === undefined ? [] : [state.alterationKindId]),
        locus.bodyLocationId,
        ...(locus.side === undefined ? [] : [locus.side]),
        ...(locus.detail?.path ?? []),
      ],
      stability: "persistent",
      priors: APPEARANCE_ANATOMY_PRIORS,
    });
  }
  return projected;
}

/**
 * Body truth → normalized feature records, deterministically.
 *
 * Three sources, one contract: canonical attributes (inherent structure),
 * located appearance facts (authored or event-acquired marks), and evented
 * anatomy state (topology). Conditions and presentation are named by the spec
 * as the remaining two owners and project later through the same shape.
 *
 * Nothing here scores, ranks, or narrates: no visibility, no observer, no
 * prose. Output is sorted by key, and a duplicate key keeps the FIRST record
 * (attributes, then facts, then anatomy) with a warn diagnostic.
 */
export function projectAppearanceTruth(input: AppearanceProjectionInput): readonly ProjectedFeatureTruth[] {
  const candidates = [...projectAttributes(input), ...projectLocatedFacts(input), ...projectAnatomy(input)];
  const seen = new Set<string>();
  const kept: ProjectedFeatureTruth[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) {
      input.sink?.push(
        diag("warn", APPEARANCE_FEATURE_KEY_DUPLICATE, `Two sources claim ${candidate.key}`, {
          path: "appearance.projection",
          context: { key: candidate.key },
        }),
      );
      continue;
    }
    seen.add(candidate.key);
    kept.push(candidate);
  }
  return kept.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Derived body-area view
// ---------------------------------------------------------------------------

/** A nested, assembled-on-demand editor/diagnostics view. Never persisted. */
export type AppearanceBodyAreaView = Record<string, unknown>;

/** `{"density":"dense"}` → the object; `crooked` → the string. */
function fingerprintLeaf(fingerprint: string): unknown {
  if (!fingerprint.startsWith("{") && !fingerprint.startsWith("[")) return fingerprint;
  try {
    return JSON.parse(fingerprint) as unknown;
  } catch {
    return fingerprint;
  }
}

/** Where a record hangs under its locus, and whether that leaf holds a list. */
function bodyAreaLeafPath(record: ProjectedFeatureTruth): { path: readonly string[]; repeatable: boolean } {
  const aspect = record.key.slice(record.key.lastIndexOf("/") + 1);
  const kind = appearanceFeatureKindRegistry.byId(aspect);
  if (kind) return { path: kind.bodyAreaPath, repeatable: true };
  const attribute = appearanceAttributeRecognitionAt(record.locus.bodyLocationId, aspect);
  if (attribute) return { path: attribute.bodyAreaPath, repeatable: false };
  return { path: [aspect], repeatable: false };
}

/**
 * Assemble the nested body-area view the spec shows — locus (side, detail
 * path) → facet → feature. Source edits and replay rebuild it; it is never
 * stored, so it may safely lose information the projection keeps.
 */
export function deriveBodyAreaView(
  projected: readonly ProjectedFeatureTruth[],
  sink?: DiagnosticSink,
): AppearanceBodyAreaView {
  const view: AppearanceBodyAreaView = {};
  for (const record of projected) {
    const { path, repeatable } = bodyAreaLeafPath(record);
    const segments = [
      record.locus.bodyLocationId,
      ...(record.locus.side === undefined ? [] : [record.locus.side]),
      ...(record.locus.detail?.path ?? []),
      ...path,
    ];
    const leafName = segments[segments.length - 1];
    if (leafName === undefined) continue;
    let node = view;
    let conflicted = false;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next === undefined) {
        const created: AppearanceBodyAreaView = {};
        node[segment] = created;
        node = created;
        continue;
      }
      if (typeof next !== "object" || next === null || isValueArray(next)) {
        sink?.push(
          diag("warn", APPEARANCE_BODY_AREA_CONFLICT, `Cannot nest ${record.key} under ${segment}`, {
            path: "appearance.body_area",
            context: { key: record.key },
          }),
        );
        conflicted = true;
        break;
      }
      node = next as AppearanceBodyAreaView;
    }
    if (conflicted) continue;
    const leaf = fingerprintLeaf(record.truthFingerprint);
    if (!repeatable) {
      node[leafName] = leaf;
      continue;
    }
    const existing = node[leafName];
    node[leafName] = isValueArray(existing) ? [...existing, leaf] : [leaf];
  }
  return view;
}
