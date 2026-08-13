import { diag, type Diagnostic, type DiagnosticSink } from "../../diagnostics";
import { compareGuidanceFingerprints } from "./fingerprint";
import {
  normalizeGuidanceCandidates,
  NARRATOR_GUIDANCE_VERSION,
  type GuidanceCandidateInput,
  type GuidanceFingerprinted,
  type GuidancePriority,
  type NarratorPhysicalGuidance,
  type PhysicalTransitionRelevance,
} from "./types";

/**
 * Selection — risk first, inventory never (narrator-physical-guidance.plan.md
 * §Architecture 6).
 *
 * The scarce resource is the narrator's attention, so a budget exists; the order
 * decides what survives it. Two properties are load-bearing:
 *
 * - **Determinism.** Every tier ends in a fingerprint tie-break, so the same
 *   candidates always produce the same guidance — in any input order, in any
 *   process, on a retake. Nothing here reads a clock or a counter.
 * - **Action outcomes are never dropped.** They have no budget. A blocked or
 *   unresolved attempt that lost a slot is exactly how prose invents contact.
 *
 * Selection runs AFTER the disclosure gate (`disclosure.ts`), never before:
 * ranking a `resolver_only` candidate would let salience decide what is secret.
 */

/** At most two premise corrections reach one prompt. */
export const GUIDANCE_MAX_CORRECTIONS = 2;
/** At most three scoped consistency constraints reach one prompt. */
export const GUIDANCE_MAX_CONSTRAINTS = 3;
/**
 * At most four state transitions.
 *
 * This one is a LAWFUL MAXIMUM, not an attention estimate, and the difference is
 * why it is not 1. The tier's only producer today is the revocation stop
 * (`chat-permission-guidance.ts`), whose line the permission spec makes
 * MANDATORY — and one ensemble reply can lawfully end contact on several
 * participant pairs at once (the reply-scene decision cap is four). A budget of
 * one dropped every pair but the first, and the producer's emission window
 * closes as soon as the next reply persists: the dropped pairs were therefore
 * never rendered on ANY reply, which is a required instruction lost rather than
 * deferred. So the budget has to cover what one exchange can legitimately
 * produce, and the producer bounds its own emission to this same number so the
 * two can never disagree about what fits.
 *
 * A future producer of OPTIONAL descriptive transitions (the parked
 * `CHAT_PHYSICAL_TRANSITIONS` experiment) may NOT simply share this headroom.
 * The tier has no priority concept — `PhysicalStateTransition` carries
 * `relevance`, not `mandatory` — so optional detail would compete with a binding
 * stop on relevance and then on a fingerprint tie-break, and could win. Giving
 * transitions a priority rank is design work that experiment owes; it is
 * deliberately not assumed here.
 */
export const GUIDANCE_MAX_TRANSITIONS = 4;
// Generic descriptive opportunities have NO constant on purpose: the plan parks
// them ("zero generic opportunities", §Architecture 6). A budget of 0 would
// invite someone to raise it; an absent concept has to be designed first.

/** A budget dropped a candidate. `info`: the drop is the design working, not a fault. */
export const GUIDANCE_SELECTION_OVER_BUDGET = "guidance.selection.over_budget";

const CONSTRAINT_PRIORITY_RANK: Readonly<Record<GuidancePriority, number>> = { mandatory: 0, high: 1, normal: 2 };

/**
 * Transition order follows the plan's own wording — "the current action or
 * attention makes it relevant" — so an action-relevant change outranks a merely
 * attended one. `none` is ranked last rather than dropped: eligibility is the
 * producer's gate (slice 4), and a silent drop here would hide a producer bug.
 */
const TRANSITION_RELEVANCE_RANK: Readonly<Record<PhysicalTransitionRelevance, number>> = {
  action: 0,
  attention: 1,
  none: 2,
};

/** Rank within a tier, then break every tie by fingerprint. Never mutates the input. */
function ranked<T extends GuidanceFingerprinted>(items: readonly T[], rank: (item: T) => number): readonly T[] {
  return [...items].sort(
    (left, right) => rank(left) - rank(right) || compareGuidanceFingerprints(left.fingerprint, right.fingerprint),
  );
}

/** Corrections have no internal tier — the plan ranks them as one group. */
const UNRANKED = (): number => 0;

function capped<T extends GuidanceFingerprinted>(
  kind: string,
  ordered: readonly T[],
  max: number,
  record: (diagnostic: Diagnostic) => void,
): readonly T[] {
  if (ordered.length <= max) return ordered;
  const dropped = ordered.slice(max).map((item) => item.fingerprint);
  record(
    diag(
      "info",
      GUIDANCE_SELECTION_OVER_BUDGET,
      `Dropped ${dropped.length} of ${ordered.length} ${kind} candidates over the guidance budget`,
      { path: `guidance.selection.${kind}`, context: { kind, max, dropped } },
    ),
  );
  return ordered.slice(0, max);
}

/**
 * Order and budget the gated candidates.
 *
 * The returned `diagnostics` are also pushed to `sink` when one is supplied, so a
 * caller can either read them off the guidance or collect them with the rest of
 * the turn's diagnostics without merging two lists.
 */
export function selectNarratorGuidance(input: {
  readonly candidates: GuidanceCandidateInput;
  readonly sink?: DiagnosticSink;
}): NarratorPhysicalGuidance {
  const diagnostics: Diagnostic[] = [];
  const record = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic);
    input.sink?.push(diagnostic);
  };
  const candidates = normalizeGuidanceCandidates(input.candidates);

  return {
    version: NARRATOR_GUIDANCE_VERSION,
    // Tier 1 — mandatory outcomes first, then the optional ones. No budget.
    actionOutcomes: ranked(candidates.actionOutcomes, (outcome) => (outcome.narratorMustResolve ? 0 : 1)),
    // Tier 2 — this turn's premise corrections.
    corrections: capped("correction", ranked(candidates.corrections, UNRANKED), GUIDANCE_MAX_CORRECTIONS, record),
    // Tier 3 — scoped constraints, mandatory → high → normal.
    constraints: capped(
      "constraint",
      ranked(candidates.constraints, (constraint) => CONSTRAINT_PRIORITY_RANK[constraint.priority]),
      GUIDANCE_MAX_CONSTRAINTS,
      record,
    ),
    // Tier 4 — the changed-state details, up to what one exchange can lawfully
    // produce. Every one of them is a binding stop today, so this budget exists
    // to bound the block, not to choose between them.
    transitions: capped(
      "transition",
      ranked(candidates.transitions, (transition) => TRANSITION_RELEVANCE_RANK[transition.relevance]),
      GUIDANCE_MAX_TRANSITIONS,
      record,
    ),
    diagnostics,
  };
}
