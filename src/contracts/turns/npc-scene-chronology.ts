import type { NpcContactCandidate, NpcMovementCandidate, NpcRef } from "./npc-scene-decision";
import type { NpcSceneReplySpan } from "./npc-scene-evidence";

/**
 * NPC reply-scene CHRONOLOGY
 * (romantic-contact-affordances.spec.actor-control.md §"Chronology and
 * folding").
 *
 * The old fixed floor→movement→contact order is gone. Every admitted floor
 * result and tier-2 candidate carries ONE action span in the reply, and the
 * reply's own written order — absolute start offset — is the execution order:
 *
 * - "She squeezes your hand, then steps away." updates first, then separates.
 * - "She steps closer, then takes your hand." approaches first, so the start
 *   resolves against the nearer scene.
 *
 * If two state-changing actions cannot be totally ordered (their spans
 * overlap), the ambiguous TIER-2 candidates are dropped; the independently
 * valid frozen-floor result always survives — tier 2 is an overlay on the
 * floor, never a veto of it.
 *
 * When the floor ending and a tier-2 `depart` describe the SAME action span,
 * they are grouped into one `composite_departure` entry. That grouping is PURE
 * DATA: computing the allowable wider proximity from the pre-ending scene,
 * folding the `separated` endings, and applying the prevalidated proximity
 * intent are increment-1 authority work — this module only hands the future
 * executor both halves in one envelope so it can run the ending exactly once.
 *
 * The normalized ordered list this planner returns — not the schema's slot
 * order — is what the durable decision envelope records.
 */

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** The frozen floor's detected ending, with the source offsets the planner ordered it by. */
export interface NpcSceneFloorEntry {
  readonly reason: "withdrawn" | "separated";
  /**
   * The ending NPC as a digest ref, when the wiring could map the detector's
   * subject id; `null` when it could not. A null subject still orders — it
   * only stops the entry from compositing with a `depart`.
   */
  readonly subjectRef: NpcRef | null;
  readonly span: NpcSceneReplySpan;
}

/** One ADMITTED tier-2 candidate and the action span its congruence verifier returned. */
export interface NpcSceneTier2Entry {
  readonly candidate: NpcMovementCandidate | NpcContactCandidate;
  readonly span: NpcSceneReplySpan;
}

export type NpcSceneOrderedAction =
  | { readonly source: "floor"; readonly floor: NpcSceneFloorEntry }
  | { readonly source: "tier2"; readonly entry: NpcSceneTier2Entry }
  | {
      readonly source: "composite_departure";
      readonly floor: NpcSceneFloorEntry;
      readonly depart: NpcSceneTier2Entry;
    };

export interface NpcSceneDroppedAction {
  readonly entry: NpcSceneTier2Entry;
  readonly reason: "chronology_ambiguous";
}

export interface NpcSceneChronologyPlan {
  /** The normalized ordered action list — what the durable envelope records. */
  readonly actions: readonly NpcSceneOrderedAction[];
  readonly dropped: readonly NpcSceneDroppedAction[];
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/** The span of whichever entry shape, for uniform ordering. */
function spanOf(action: NpcSceneOrderedAction): NpcSceneReplySpan {
  switch (action.source) {
    case "floor":
      return action.floor.span;
    case "tier2":
      return action.entry.span;
    case "composite_departure":
      return action.floor.span;
  }
}

function spansOverlap(left: NpcSceneReplySpan, right: NpcSceneReplySpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function spansEqual(left: NpcSceneReplySpan, right: NpcSceneReplySpan): boolean {
  return left.start === right.start && left.end === right.end;
}

/** May this tier-2 entry composite with this floor ending? Same action span, same body. */
function compositesWith(floor: NpcSceneFloorEntry, entry: NpcSceneTier2Entry): boolean {
  return (
    entry.candidate.kind === "depart" &&
    spansEqual(floor.span, entry.span) &&
    (floor.subjectRef === null || floor.subjectRef === entry.candidate.actorRef)
  );
}

/**
 * Order one reply's admitted actions. Pure and total; same entries ⇒ same
 * plan. Three rules, applied in this order:
 *
 * 1. **Composite first.** A `depart` sharing the floor ending's exact span and
 *    body is the same written action; they merge into one composite entry.
 *    Two departs claiming the same span is unresolvable — both drop, the
 *    floor stands alone.
 * 2. **Overlap drops tier 2 only.** A tier-2 span overlapping the floor's (or
 *    another tier-2's) cannot be totally ordered against it; every tier-2
 *    party to the overlap drops as `chronology_ambiguous`. The floor entry is
 *    never dropped — its authority predates this planner.
 * 3. **Sort by absolute start offset.** After the drops, starts are distinct,
 *    so the order is total.
 */
export function planNpcSceneChronology(input: {
  readonly floor: NpcSceneFloorEntry | null;
  readonly tier2: readonly NpcSceneTier2Entry[];
}): NpcSceneChronologyPlan {
  const dropped: NpcSceneDroppedAction[] = [];
  const floor = input.floor;
  let floorAction: NpcSceneOrderedAction | null = floor === null ? null : { source: "floor", floor };
  let remaining = [...input.tier2];

  if (floor !== null) {
    const composites = remaining.filter((entry) => compositesWith(floor, entry));
    const sole = composites.length === 1 ? composites[0] : undefined;
    if (sole !== undefined) {
      floorAction = { source: "composite_departure", floor, depart: sole };
      remaining = remaining.filter((entry) => entry !== sole);
    } else if (composites.length > 1) {
      for (const entry of composites) dropped.push({ entry, reason: "chronology_ambiguous" });
      remaining = remaining.filter((entry) => !composites.includes(entry));
    }
  }

  // Tier-2 vs floor: an overlap that did not composite is unorderable.
  if (floorAction !== null) {
    const floorSpan = spanOf(floorAction);
    const conflicted = remaining.filter((entry) => spansOverlap(entry.span, floorSpan));
    for (const entry of conflicted) dropped.push({ entry, reason: "chronology_ambiguous" });
    remaining = remaining.filter((entry) => !conflicted.includes(entry));
  }

  // Tier-2 vs tier-2: every party to an overlap drops.
  const conflictedPairs = new Set<NpcSceneTier2Entry>();
  for (let i = 0; i < remaining.length; i += 1) {
    for (let j = i + 1; j < remaining.length; j += 1) {
      const left = remaining[i];
      const right = remaining[j];
      if (left !== undefined && right !== undefined && spansOverlap(left.span, right.span)) {
        conflictedPairs.add(left);
        conflictedPairs.add(right);
      }
    }
  }
  for (const entry of remaining) {
    if (conflictedPairs.has(entry)) dropped.push({ entry, reason: "chronology_ambiguous" });
  }
  remaining = remaining.filter((entry) => !conflictedPairs.has(entry));

  const actions: NpcSceneOrderedAction[] = remaining.map((entry) => ({ source: "tier2", entry }));
  if (floorAction !== null) actions.push(floorAction);
  actions.sort((left, right) => spanOf(left).start - spanOf(right).start || spanOf(left).end - spanOf(right).end);
  return { actions, dropped };
}
