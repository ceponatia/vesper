import type { Diagnostic } from "../../diagnostics";
import type { AffordanceEvidence, AffordanceSubjectId } from "../core";

/**
 * Narrator physical guidance — the shared candidate surface
 * (narrator-physical-guidance.plan.md §Architecture 2; the as-built contracts
 * are recorded in narrator-physical-guidance.spec.md).
 *
 * This layer is a PROJECTION and an action-result carrier, never a second
 * physics engine. Domains and resolvers own physical truth and emit stable ids,
 * codes, loci, and evidence; this layer only carries, gates, orders, and budgets
 * them. Four laws are encoded here rather than left to discipline:
 *
 * 1. **Claim codes are opaque.** Every `*ClaimCodes` / `*Codes` field is
 *    domain-owned vocabulary (slice 2 supplies the first lexicon). Nothing in
 *    this folder parses, matches, negates, or interprets one — a shared layer
 *    that understood one domain's lexicon would grow a branch for the next.
 * 2. **Disclosure is data, not an inference.** The producer that knows whether a
 *    fact is perceptible states it per candidate; the gate (`disclosure.ts`)
 *    only enforces it. High salience therefore cannot unlock hidden state,
 *    because salience is never consulted by the gate.
 * 3. **Every candidate carries a fingerprint.** Selection ties, over-budget
 *    reporting, and retake reproduction are all defined in terms of it, so no
 *    tier may fall back on input order — an adapter may legitimately reorder two
 *    reads of the same committed cut.
 * 4. **Missing data never becomes guidance.** An absent input yields no
 *    candidate. It may license a prohibition (an unsupported claim fence), never
 *    a substituted positive fact.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Who may see a candidate.
 *
 * - `resolver_only` — may affect action resolution; never enters a narrator
 *   prompt. Hidden state constraining silently is correct behaviour, so a drop
 *   here is `info`, never an error.
 * - `consistency_only` — may render as a prohibition or a resolved limitation.
 *   The prompt must not state the hidden positive alternative, which is why a
 *   constraint over a non-visible locus carries an EMPTY `allowedClaimCodes`.
 * - `positive_detail_allowed` — has passed viewpoint, channel, exposure, and
 *   policy gates upstream and may be rendered positively if selected.
 */
export const guidanceDisclosures = ["resolver_only", "consistency_only", "positive_detail_allowed"] as const;
export type GuidanceDisclosure = (typeof guidanceDisclosures)[number];

/** Ranking tier inside the constraint budget. Not a disclosure override. */
export const guidancePriorities = ["mandatory", "high", "normal"] as const;
export type GuidancePriority = (typeof guidancePriorities)[number];

/**
 * What an attempted physical action actually did. `unresolved` is a first-class
 * state, not an error: the resolver could not decide, so the narrator's correct
 * output is silence rather than a guessed result.
 */
export const physicalActionStatuses = [
  "committed",
  "partially_committed",
  "explicit_transition_required",
  "rejected",
  "unresolved",
] as const;
export type PhysicalActionStatus = (typeof physicalActionStatuses)[number];

/** Why a transition is worth a beat at all. `none` is never eligible for positive detail. */
export const physicalTransitionRelevances = ["action", "attention", "none"] as const;
export type PhysicalTransitionRelevance = (typeof physicalTransitionRelevances)[number];

// ---------------------------------------------------------------------------
// Structural minimums
// ---------------------------------------------------------------------------

/** The deterministic identity every candidate carries. Ordering depends on nothing else. */
export interface GuidanceFingerprinted {
  readonly fingerprint: string;
}

/**
 * The two fields the shared gate and ranker need. Every candidate kind
 * structurally satisfies this, which is what lets one gate cover all four lists
 * without a discriminated union the producers would have to maintain.
 */
export interface GuidanceCandidateShape extends GuidanceFingerprinted {
  readonly disclosure: GuidanceDisclosure;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** A scoped claim the narrator must not make. */
export interface PhysicalNarrationConstraint extends GuidanceCandidateShape {
  /** Stable within a cut: `<resolutionId>:<code>[:<locus>…]`. Not prose, not a key. */
  readonly id: string;
  readonly subjectIds: readonly AffordanceSubjectId[];
  readonly domainId: string;
  /** Body-location ids this constraint is scoped to. Empty means domain-wide. */
  readonly locusIds: readonly string[];
  /** Domain-owned codes for claims the narrator may not make. */
  readonly prohibitedClaimCodes: readonly string[];
  /**
   * Domain-owned codes for the committed truth the prompt MAY state. Empty
   * whenever the truth is not fully perceptible — the prohibition still ships,
   * the cause does not.
   */
  readonly allowedClaimCodes: readonly string[];
  readonly priority: GuidancePriority;
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * A high-confidence contradiction in the player's framing that the narrator
 * must not adopt. `resolver_only` is excluded by type: a correction exists only
 * to shape narration, so a hidden one would be a contradiction in terms.
 */
export interface PhysicalPremiseCorrection extends GuidanceFingerprinted {
  readonly id: string;
  /** Which input authority produced the claim (plan §Architecture 3). */
  readonly source: "player_dialogue" | "ordinary_player_narration";
  readonly claimCode: string;
  readonly verdict: "contradicted" | "unsupported";
  /** Committed truth codes, for a correction the prompt is allowed to voice. */
  readonly truthCodes: readonly string[];
  readonly disclosure: Exclude<GuidanceDisclosure, "resolver_only">;
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * What the resolver decided about an attempted physical action. Action outcomes
 * are never dropped by a budget: a rejected or unresolved attempt that fell out
 * of the prompt is exactly how prose invents contact that never happened.
 */
export interface PhysicalActionOutcome extends GuidanceCandidateShape {
  readonly actionId: string;
  readonly status: PhysicalActionStatus;
  /** Domain-owned result vocabulary, in the resolver's own order. */
  readonly resultCodes: readonly string[];
  /** The narrator cannot render the attempt as committed — it must account for the result. */
  readonly narratorMustResolve: boolean;
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * A committed before/after change that may earn one optional positive detail.
 * Always `positive_detail_allowed`: a transition that has not cleared the
 * positive gates is not a transition candidate at all, it is a constraint.
 */
export interface PhysicalStateTransition extends GuidanceFingerprinted {
  readonly id: string;
  readonly subjectIds: readonly AffordanceSubjectId[];
  readonly domainId: string;
  readonly locusIds: readonly string[];
  readonly beforeCodes: readonly string[];
  readonly afterCodes: readonly string[];
  readonly causeCodes: readonly string[];
  readonly relevance: PhysicalTransitionRelevance;
  readonly disclosure: "positive_detail_allowed";
  /** Cooldown identity WITHOUT the cause — an unchanged fingerprint stays silent. */
  readonly repeatKey: string;
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/** The four candidate lists as a producer hands them over; any list may be absent. */
export interface GuidanceCandidateInput {
  readonly constraints?: readonly PhysicalNarrationConstraint[];
  readonly corrections?: readonly PhysicalPremiseCorrection[];
  readonly actionOutcomes?: readonly PhysicalActionOutcome[];
  readonly transitions?: readonly PhysicalStateTransition[];
}

/** The same four lists normalized — every list present, possibly empty. */
export interface GuidanceCandidates {
  readonly constraints: readonly PhysicalNarrationConstraint[];
  readonly corrections: readonly PhysicalPremiseCorrection[];
  readonly actionOutcomes: readonly PhysicalActionOutcome[];
  readonly transitions: readonly PhysicalStateTransition[];
}

/**
 * The compiled result. Array order encodes the plan's selection order
 * (§Architecture 6): mandatory action outcomes, then corrections, then
 * constraints, then at most one transition. `diagnostics` explains what was
 * withheld or dropped and is debug output — it never reaches a prompt.
 */
export interface NarratorPhysicalGuidance {
  readonly version: 1;
  readonly constraints: readonly PhysicalNarrationConstraint[];
  readonly corrections: readonly PhysicalPremiseCorrection[];
  readonly actionOutcomes: readonly PhysicalActionOutcome[];
  readonly transitions: readonly PhysicalStateTransition[];
  readonly diagnostics: readonly Diagnostic[];
}

/** The only version this release compiles or reads. */
export const NARRATOR_GUIDANCE_VERSION = 1;

/** Fill in the absent lists. The one place `undefined` becomes `[]`. */
export function normalizeGuidanceCandidates(input: GuidanceCandidateInput): GuidanceCandidates {
  return {
    constraints: input.constraints ?? [],
    corrections: input.corrections ?? [],
    actionOutcomes: input.actionOutcomes ?? [],
    transitions: input.transitions ?? [],
  };
}

/**
 * No guidance at all — the disabled-flag value and the degraded default.
 * Conservative silence is the default output of this layer, so it has a name.
 */
export function emptyNarratorPhysicalGuidance(): NarratorPhysicalGuidance {
  return {
    version: NARRATOR_GUIDANCE_VERSION,
    constraints: [],
    corrections: [],
    actionOutcomes: [],
    transitions: [],
    diagnostics: [],
  };
}
