import type { SimulationBranchEvent } from "../contracts/branching";
import {
  assertionSchema,
  assertionStatusTransitions,
  beliefSchema,
  beliefStatusTransitions,
  deriveAssertionId,
  deriveBeliefId,
  disclosureMadeEventSchema,
  KNOWLEDGE_DERIVATION_VERSION,
  MAX_LEARNED_FROM_CHAIN,
  type Assertion,
  type AssertionStatus,
  type Belief,
  type BeliefStatus,
  type DisclosureContent,
  type DisclosureMadeEvent,
  type MakeDisclosureCommand,
  type MakeDisclosureRejectionCode,
} from "../contracts/knowledge";
import { composeSimulationId } from "../contracts/identity";
import type { Observation } from "../contracts/perception";

/**
 * E4.2 — the pure knowledge kernel (engine.spec §21). Assertions and beliefs
 * are DERIVED, exactly like §20 observations: `applyDisclosureEvent` is a
 * deterministic fold over (disclosure event, that event's observations), so
 * live incremental updates and a fork's full replay mint identical rows.
 *
 * The §6.4 rule does the heavy lifting: everything the fold would otherwise
 * have to look up in mutable state (the assertion id, the teller's confidence
 * at the moment of telling, the provenance chain) was captured in the event
 * payload at command time. The fold consumes captures; it never re-derives
 * them.
 *
 * Deliberate v1 rulings, coarse on purpose (tunable under a bumped
 * derivation version):
 * - A speaker holds no belief in their own claim — a liar asserts what they
 *   do not believe; canon false is not a belief model (§21.1).
 * - Only `reported`-class observations form beliefs. A muffled bystander
 *   heard talking, not content.
 * - A relay hop costs a flat confidence penalty; belief confidence is
 *   min(how well you heard it, how sure the teller was) − hop cost.
 * - Re-hearing the same assertion refreshes: the old belief row is
 *   superseded, the new row keeps the higher confidence.
 * - A contradicting claim wins the holder's stance only with STRICTLY higher
 *   confidence; otherwise it enters doubted and the held belief stands.
 * - Two sources claiming different values for one proposition contradict
 *   BOTH assertions — neither may present as current truth (§3.3); a same
 *   source changing their story supersedes their earlier claim.
 */

export const RELAY_CONFIDENCE_PENALTY = 1_000;

const FULL_CONFIDENCE = 10_000;

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStableText);
}

/**
 * Structural equality key for claimed values: recursively key-sorted JSON.
 * Claimed values are z.json() at the trust boundary, so no undefined/cycles.
 */
export function canonicalValueKey(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareStableText)) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

function subjectsKey(subjectIds: readonly string[]): string {
  return subjectIds.join(" ");
}

/** Keep the most recent tellers when a gossip chain outgrows the cap. */
export function truncateProvenanceChain(chain: readonly string[]): string[] {
  return chain.slice(Math.max(0, chain.length - MAX_LEARNED_FROM_CHAIN));
}

function assertAssertionTransition(from: AssertionStatus, to: AssertionStatus, id: string): void {
  if (!assertionStatusTransitions[from].includes(to)) {
    throw new Error(`Illegal assertion transition ${from} → ${to} for ${id}`);
  }
}

function assertBeliefTransition(from: BeliefStatus, to: BeliefStatus, id: string): void {
  if (!beliefStatusTransitions[from].includes(to)) {
    throw new Error(`Illegal belief transition ${from} → ${to} for ${id}`);
  }
}

// ---------------------------------------------------------------------------
// MakeDisclosure resolution (engine.spec §21, §7)
// ---------------------------------------------------------------------------

interface KnowledgeBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

export interface MakeDisclosureResolutionView extends KnowledgeBranchMeta {
  speakerExists: boolean;
  /** Targets with no locus row on the branch — any one rejects (fail closed). */
  missingTargetIds: readonly string[];
  /** The speaker's location when their locus is `at`; unset in transit. */
  speakerLocationId?: string;
  /** True when every target is `at` a zone inside the speaker's location. */
  targetsCoPresent: boolean;
  /** The referenced assertion, for relay/retraction content. */
  referencedAssertion?: Assertion;
  /** The speaker's live (active | doubted) belief in the referenced assertion. */
  speakerBelief?: Belief;
}

interface DisclosureRejection {
  ok: false;
  code: MakeDisclosureRejectionCode;
  publicReason: string;
}

export interface MakeDisclosureResolution {
  ok: true;
  event: DisclosureMadeEvent;
}

function disclosureRejection(
  code: MakeDisclosureRejectionCode,
  publicReason: string,
): DisclosureRejection {
  return { ok: false, code, publicReason };
}

/** The slice of the authority view the §6.4 capture computation reads. */
export interface DisclosureCaptureView {
  referencedAssertion?: Assertion;
  speakerBelief?: Belief;
}

export type DisclosureCaptureResult =
  | {
      ok: true;
      derived: {
        assertionId: string;
        sourceConfidenceFixedPoint: number;
        learnedFromActorIds: string[];
      };
    }
  | DisclosureRejection;

/**
 * The §6.4 capture: freeze everything the belief fold will need — assertion
 * identity, the teller's confidence at this moment, and the provenance chain
 * listeners record (always ending with this speaker). Shared between the
 * `make_disclosure` command and E4.3's armed-disclosure bridge, so a
 * narrator-spoken disclosure and a command-spoken one derive identically.
 */
export function deriveDisclosureCapture(
  view: DisclosureCaptureView,
  speakerActorId: string,
  content: DisclosureContent,
  eventId: string,
): DisclosureCaptureResult {
  switch (content.kind) {
    case "claim":
      return {
        ok: true,
        derived: {
          assertionId: deriveAssertionId(eventId),
          sourceConfidenceFixedPoint: FULL_CONFIDENCE,
          learnedFromActorIds: [speakerActorId],
        },
      };
    case "relay": {
      const assertion = view.referencedAssertion;
      if (!assertion || assertion.id !== content.assertionId) {
        return disclosureRejection("assertion_not_found", "Nobody has claimed that here.");
      }
      if (assertion.sourceActorId === speakerActorId) {
        // The original claimant retelling their own claim — firsthand again.
        return {
          ok: true,
          derived: {
            assertionId: assertion.id,
            sourceConfidenceFixedPoint: FULL_CONFIDENCE,
            learnedFromActorIds: [speakerActorId],
          },
        };
      }
      const belief = view.speakerBelief;
      const beliefIsLive = belief?.status === "active" || belief?.status === "doubted";
      if (!belief || belief.assertionId !== assertion.id || !beliefIsLive) {
        return disclosureRejection("relay_unbelieved", "They have nothing to pass on about that.");
      }
      return {
        ok: true,
        derived: {
          assertionId: assertion.id,
          sourceConfidenceFixedPoint: belief.confidenceFixedPoint,
          learnedFromActorIds: truncateProvenanceChain([...belief.learnedFromActorIds, speakerActorId]),
        },
      };
    }
    case "retraction": {
      const assertion = view.referencedAssertion;
      if (!assertion || assertion.id !== content.assertionId) {
        return disclosureRejection("assertion_not_found", "Nobody has claimed that here.");
      }
      if (assertion.sourceActorId !== speakerActorId) {
        return disclosureRejection("retraction_unauthorized", "Only the one who said it can take it back.");
      }
      if (assertion.status === "retracted") {
        return disclosureRejection("assertion_already_retracted", "That claim is already withdrawn.");
      }
      return {
        ok: true,
        derived: {
          assertionId: assertion.id,
          sourceConfidenceFixedPoint: FULL_CONFIDENCE,
          learnedFromActorIds: [speakerActorId],
        },
      };
    }
  }
}

/**
 * Pure MakeDisclosure resolver over a lock-consistent authority view. The
 * derived payload block freezes everything the belief fold will need (§6.4):
 * assertion identity, the teller's confidence at this moment, and the
 * provenance chain listeners record — always ending with this speaker.
 */
export function resolveMakeDisclosure(
  view: MakeDisclosureResolutionView,
  command: MakeDisclosureCommand,
): DisclosureRejection | MakeDisclosureResolution {
  if (command.branchId !== view.branchId) {
    return disclosureRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.speakerExists) {
    return disclosureRejection("speaker_not_found", "That speaker is unavailable.");
  }
  const principal = command.principal;
  if (
    (principal.kind === "player" || principal.kind === "npc_policy" || principal.kind === "npc_deliberator") &&
    !principal.controlledActorIds.includes(command.payload.speakerActorId)
  ) {
    return disclosureRejection("unauthorized_actor", "You cannot speak for that actor.");
  }
  if (view.missingTargetIds.length > 0) {
    return disclosureRejection("target_not_found", "Someone named there is unavailable.");
  }

  const eventId = composeSimulationId("event", [view.branchId, command.id, "disclosure-made"]);
  const content = command.payload.content;
  const speakerActorId = command.payload.speakerActorId;

  const capture = deriveDisclosureCapture(view, speakerActorId, content, eventId);
  if (!capture.ok) return capture;
  const { assertionId, sourceConfidenceFixedPoint, learnedFromActorIds } = capture.derived;

  // Channel ruling: co-present only when the speaker stands somewhere and
  // every named listener is in that location — anything else delivers by
  // device, which cannot be overheard (§20, mirrors the speech-act rule).
  const coPresentLocationId =
    view.speakerLocationId !== undefined && view.targetsCoPresent ? view.speakerLocationId : undefined;

  const subjectEntityIds = content.kind === "claim" ? content.subjectIds : [];
  const event = disclosureMadeEventSchema.parse({
    id: eventId,
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "disclosure_made",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: KNOWLEDGE_DERIVATION_VERSION,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: sortedUnique([speakerActorId, ...command.payload.targetActorIds]),
    entityIds: sortedUnique([assertionId, ...subjectEntityIds]),
    ...(coPresentLocationId === undefined ? {} : { locationId: coPresentLocationId }),
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      speakerActorId,
      targetActorIds: command.payload.targetActorIds,
      content,
      derived: { assertionId, sourceConfidenceFixedPoint, learnedFromActorIds },
    },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// The knowledge fold (engine.spec §21.1–21.2)
// ---------------------------------------------------------------------------

/**
 * Fold state. For a full replay it starts empty; for the live incremental
 * path the caller seeds it with every same-proposition assertion on the
 * branch plus every belief held by this event's listeners — the fold only
 * reasons over what could interact, and the seed contract is what makes the
 * narrow live load equivalent to the full replay.
 */
export interface KnowledgeState {
  assertions: Map<string, Assertion>;
  beliefs: Map<string, Belief>;
}

export function emptyKnowledgeState(): KnowledgeState {
  return { assertions: new Map(), beliefs: new Map() };
}

export interface KnowledgeUpdate {
  state: KnowledgeState;
  /** New and status-changed rows, ready to upsert. */
  upsertedAssertions: Assertion[];
  upsertedBeliefs: Belief[];
}

function liveBeliefsOf(state: KnowledgeState, holderActorId: string): Belief[] {
  return [...state.beliefs.values()].filter(
    (belief) =>
      belief.holderActorId === holderActorId &&
      (belief.status === "active" || belief.status === "doubted"),
  );
}

/** Deterministic strongest-first: confidence, then recency, then id. */
function compareBeliefStrength(left: Belief, right: Belief): number {
  if (left.confidenceFixedPoint !== right.confidenceFixedPoint) {
    return right.confidenceFixedPoint - left.confidenceFixedPoint;
  }
  if (left.believedFrom !== right.believedFrom) return right.believedFrom - left.believedFrom;
  return compareStableText(left.id, right.id);
}

/**
 * Apply one committed disclosure event and its derived observations. Pure and
 * copy-on-write: the input state is never mutated. `eventObservations` must
 * be exactly the §20 rows derived for THIS event.
 */
export function applyDisclosureEvent(
  state: KnowledgeState,
  event: DisclosureMadeEvent,
  eventObservations: readonly Observation[],
): KnowledgeUpdate {
  const assertions = new Map(state.assertions);
  const beliefs = new Map(state.beliefs);
  const touchedAssertionIds = new Set<string>();
  const touchedBeliefIds = new Set<string>();

  const setAssertion = (assertion: Assertion): void => {
    assertions.set(assertion.id, assertion);
    touchedAssertionIds.add(assertion.id);
  };
  const setBelief = (belief: Belief): void => {
    beliefs.set(belief.id, belief);
    touchedBeliefIds.add(belief.id);
  };

  const content = event.payload.content;
  const derived = event.payload.derived;

  if (content.kind === "claim") {
    const claim = assertionSchema.parse({
      id: derived.assertionId,
      branchId: event.branchId,
      propositionKey: content.propositionKey,
      subjectIds: content.subjectIds,
      claimedValue: content.claimedValue,
      sourceActorId: event.payload.speakerActorId,
      sourceEventId: event.id,
      sourceEventSequence: event.sequence,
      assertedAt: event.storySecond,
      ...(content.validFrom === undefined ? {} : { validFrom: content.validFrom }),
      ...(content.validUntil === undefined ? {} : { validUntil: content.validUntil }),
      status: "active",
      derivationVersion: KNOWLEDGE_DERIVATION_VERSION,
    });
    setAssertion(claim);

    // Contradiction / supersedence sweep over presentable same-proposition
    // claims (§21.1). Retracted and superseded rows are already settled.
    const claimKey = subjectsKey(claim.subjectIds);
    const claimValueKey = canonicalValueKey(claim.claimedValue);
    let claimContradicted = false;
    for (const existing of assertions.values()) {
      if (existing.id === claim.id) continue;
      if (existing.propositionKey !== claim.propositionKey) continue;
      if (subjectsKey(existing.subjectIds) !== claimKey) continue;
      if (existing.status !== "active" && existing.status !== "contradicted") continue;
      const sameSource = existing.sourceActorId === claim.sourceActorId;
      const sameValue = canonicalValueKey(existing.claimedValue) === claimValueKey;
      if (sameSource) {
        // The same voice re-asserting (refresh) or changing their story —
        // either way the newer claim replaces the older one.
        assertAssertionTransition(existing.status, "superseded", existing.id);
        setAssertion({
          ...existing,
          status: "superseded",
          statusChangedAt: event.storySecond,
          statusCauseEventId: event.id,
        });
      } else if (!sameValue) {
        // Two voices, two values: neither claim may present as current
        // truth (§3.3). A corroborating same-value claim changes nothing.
        if (existing.status === "active") {
          assertAssertionTransition(existing.status, "contradicted", existing.id);
          setAssertion({
            ...existing,
            status: "contradicted",
            statusChangedAt: event.storySecond,
            statusCauseEventId: event.id,
          });
        }
        claimContradicted = true;
      }
    }
    if (claimContradicted) {
      assertAssertionTransition("active", "contradicted", claim.id);
      setAssertion({
        ...claim,
        status: "contradicted",
        statusChangedAt: event.storySecond,
        statusCauseEventId: event.id,
      });
    }
  } else if (content.kind === "retraction") {
    const assertion = assertions.get(derived.assertionId);
    // A missing or already-retracted assertion degrades to a no-op — the
    // command layer validated; the fold never throws on stream oddities.
    if (assertion && assertion.status !== "retracted") {
      assertAssertionTransition(assertion.status, "retracted", assertion.id);
      setAssertion({
        ...assertion,
        status: "retracted",
        statusChangedAt: event.storySecond,
        statusCauseEventId: event.id,
      });
    }
  }

  // Belief updates: only listeners who received the CONTENT — the §20
  // `reported` evidence class. The speaker (direct) and muffled overhearers
  // (sensory) form no belief.
  const assertion = assertions.get(derived.assertionId);
  if (assertion) {
    const listenerObservations = eventObservations
      .filter((observation) => observation.sourceEventId === event.id)
      .filter((observation) => observation.evidenceClass === "reported")
      .sort((left, right) => compareStableText(left.witnessActorId, right.witnessActorId));

    for (const observation of listenerObservations) {
      const holderActorId = observation.witnessActorId;
      if (holderActorId === assertion.sourceActorId) continue;

      if (content.kind === "retraction") {
        // Hearing the source withdraw it rejects the listener's live belief.
        // Anyone out of earshot keeps believing — that is the point.
        for (const held of liveBeliefsOf({ assertions, beliefs }, holderActorId)) {
          if (held.assertionId !== assertion.id) continue;
          assertBeliefTransition(held.status, "rejected", held.id);
          setBelief({
            ...held,
            status: "rejected",
            believedUntil: event.storySecond,
            statusCauseEventId: event.id,
          });
        }
        continue;
      }

      const hopPenalty = content.kind === "relay" ? RELAY_CONFIDENCE_PENALTY : 0;
      const computedConfidence = Math.max(
        0,
        Math.min(observation.confidenceFixedPoint, derived.sourceConfidenceFixedPoint - hopPenalty),
      );

      const holderLive = liveBeliefsOf({ assertions, beliefs }, holderActorId);
      // Re-hearing the same assertion supersedes the old row and keeps the
      // higher confidence — repetition never erodes a stance.
      let refreshedConfidence = computedConfidence;
      for (const held of holderLive) {
        if (held.assertionId !== assertion.id) continue;
        refreshedConfidence = Math.max(refreshedConfidence, held.confidenceFixedPoint);
        assertBeliefTransition(held.status, "superseded", held.id);
        setBelief({
          ...held,
          status: "superseded",
          believedUntil: event.storySecond,
          statusCauseEventId: event.id,
        });
      }

      // Contradicting live beliefs: same proposition and subjects, different
      // value. Strictly higher confidence flips the holder; otherwise the
      // newcomer enters doubted and the held stance stands.
      const contradicting = holderLive
        .filter((held) => held.assertionId !== assertion.id)
        .filter((held) => {
          const heldAssertion = assertions.get(held.assertionId);
          return (
            heldAssertion !== undefined &&
            heldAssertion.propositionKey === assertion.propositionKey &&
            subjectsKey(heldAssertion.subjectIds) === subjectsKey(assertion.subjectIds) &&
            canonicalValueKey(heldAssertion.claimedValue) !== canonicalValueKey(assertion.claimedValue)
          );
        })
        .sort(compareBeliefStrength);
      const strongest = contradicting[0];
      let status: BeliefStatus = "active";
      if (strongest !== undefined) {
        if (refreshedConfidence > strongest.confidenceFixedPoint) {
          for (const held of contradicting) {
            assertBeliefTransition(held.status, "superseded", held.id);
            setBelief({
              ...held,
              status: "superseded",
              believedUntil: event.storySecond,
              statusCauseEventId: event.id,
            });
          }
        } else {
          status = "doubted";
        }
      }

      setBelief(
        beliefSchema.parse({
          id: deriveBeliefId(event.id, holderActorId),
          branchId: event.branchId,
          holderActorId,
          assertionId: assertion.id,
          confidenceFixedPoint: refreshedConfidence,
          basisObservationIds: [observation.id],
          learnedFromActorIds: derived.learnedFromActorIds,
          believedFrom: event.storySecond,
          status,
          sourceEventId: event.id,
          sourceEventSequence: event.sequence,
          derivationVersion: KNOWLEDGE_DERIVATION_VERSION,
        }),
      );
    }
  }

  const nextState: KnowledgeState = { assertions, beliefs };
  return {
    state: nextState,
    upsertedAssertions: [...touchedAssertionIds].sort(compareStableText).flatMap((id) => {
      const row = assertions.get(id);
      return row ? [row] : [];
    }),
    upsertedBeliefs: [...touchedBeliefIds].sort(compareStableText).flatMap((id) => {
      const row = beliefs.get(id);
      return row ? [row] : [];
    }),
  };
}

// ---------------------------------------------------------------------------
// Replay (fork rebuild, parity audit)
// ---------------------------------------------------------------------------

export interface KnowledgeReplayInput {
  /** The contiguous event stream, any families; non-knowledge events are skipped. */
  events: readonly SimulationBranchEvent[];
  /** The full replayed §20 observation log for the same stream. */
  observations: readonly Observation[];
}

export interface KnowledgeReplayResult {
  assertions: Assertion[];
  beliefs: Belief[];
}

/**
 * Deterministic rebuild of both knowledge ledgers: fold every disclosure in
 * sequence order against its own observations. Output ordering is stable
 * (by id) so bulk inserts and parity checks compare bit-for-bit.
 */
export function replayKnowledgeHistory(input: KnowledgeReplayInput): KnowledgeReplayResult {
  const observationsByEvent = new Map<string, Observation[]>();
  for (const observation of input.observations) {
    const bucket = observationsByEvent.get(observation.sourceEventId) ?? [];
    bucket.push(observation);
    observationsByEvent.set(observation.sourceEventId, bucket);
  }
  let state = emptyKnowledgeState();
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  for (const event of events) {
    if (event.type !== "disclosure_made") continue;
    state = applyDisclosureEvent(state, event, observationsByEvent.get(event.id) ?? []).state;
  }
  return {
    assertions: [...state.assertions.values()].sort((left, right) => compareStableText(left.id, right.id)),
    beliefs: [...state.beliefs.values()].sort((left, right) => compareStableText(left.id, right.id)),
  };
}
