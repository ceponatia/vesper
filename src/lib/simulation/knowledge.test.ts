import { describe, expect, it } from "vitest";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import {
  deriveAssertionId,
  deriveBeliefId,
  type Assertion,
  type Belief,
  type DisclosureMadeEvent,
} from "@/contracts/simulation/knowledge";
import type { Observation } from "@/contracts/simulation/perception";
import { bindSimEnvelopes, testPrincipal, type TestPrincipal } from "@/test/sim-envelopes";
import {
  applyDisclosureEvent,
  emptyKnowledgeState,
  replayKnowledgeHistory,
  resolveMakeDisclosure,
  RELAY_CONFIDENCE_PENALTY,
  type KnowledgeState,
} from "./knowledge";
import { deriveEventObservations, type PerceptionSpaceView } from "./perception";

const NOW = 200_000;
const WORLD = "world-1";
const BRANCH = "branch-1";
const RULESET = "e4-2-test-v1";

/**
 * This suite carries its own ruleset, so bind the trio once. The raw command
 * below feeds its `branchId` from the same constant the view's meta does — a
 * mismatch would flip every resolution to `branch_mismatch`.
 */
const env = bindSimEnvelopes({ worldId: WORLD, branchId: BRANCH, rulesetVersion: RULESET });

/** Ana and Ben share the cafe hall, Dex is in its kitchen, Cam is at the shop. */
function fixtureSpace(): PerceptionSpaceView {
  return {
    zones: [
      { id: "zone-hall", locationId: "loc-cafe" },
      { id: "zone-kitchen", locationId: "loc-cafe" },
      { id: "zone-shop", locationId: "loc-shop" },
    ],
    loci: [
      { kind: "at", actorId: "ana", locationId: "loc-cafe", zoneId: "zone-hall", since: NOW },
      { kind: "at", actorId: "ben", locationId: "loc-cafe", zoneId: "zone-hall", since: NOW },
      { kind: "at", actorId: "dex", locationId: "loc-cafe", zoneId: "zone-kitchen", since: NOW },
      { kind: "at", actorId: "cam", locationId: "loc-shop", zoneId: "zone-shop", since: NOW },
    ],
  } as unknown as PerceptionSpaceView;
}

interface DiscloseInput {
  commandId: string;
  speakerActorId: string;
  targetActorIds: string[];
  content: Record<string, unknown>;
  headSequence: number;
  storySecond?: number;
  speakerLocationId?: string;
  targetsCoPresent?: boolean;
  referencedAssertion?: Assertion;
  speakerBelief?: Belief;
  principal?: TestPrincipal;
  speakerExists?: boolean;
  missingTargetIds?: string[];
}

function resolveDisclosure(input: DiscloseInput) {
  return resolveMakeDisclosure(
    {
      ...env.meta({ headSequence: input.headSequence, storySecond: input.storySecond ?? NOW }),
      speakerExists: input.speakerExists ?? true,
      missingTargetIds: input.missingTargetIds ?? [],
      ...(input.speakerLocationId === undefined ? {} : { speakerLocationId: input.speakerLocationId }),
      targetsCoPresent: input.targetsCoPresent ?? false,
      ...(input.referencedAssertion ? { referencedAssertion: input.referencedAssertion } : {}),
      ...(input.speakerBelief ? { speakerBelief: input.speakerBelief } : {}),
    } as never,
    {
      id: input.commandId,
      branchId: BRANCH,
      expectedVersion: 0,
      idempotencyKey: `key-${input.commandId}`,
      principal: input.principal ?? testPrincipal("player", [input.speakerActorId]),
      submittedAtWallClock: "2026-07-19T12:00:00.000Z",
      correlationId: "corr-1",
      type: "make_disclosure",
      schemaVersion: 1,
      payload: {
        speakerActorId: input.speakerActorId,
        targetActorIds: input.targetActorIds,
        content: input.content,
      },
    } as never,
  );
}

function acceptedEvent(input: DiscloseInput): DisclosureMadeEvent {
  const resolution = resolveDisclosure(input);
  if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
  return resolution.event;
}

/** Fold one disclosure with observations derived by the §20 rule table. */
function fold(state: KnowledgeState, event: DisclosureMadeEvent, space = fixtureSpace()) {
  return applyDisclosureEvent(state, event, deriveEventObservations(event as SimulationBranchEvent, space));
}

const quitClaim = {
  kind: "claim",
  propositionKey: "quitting_job",
  subjectIds: ["ana"],
  claimedValue: { quitting: true },
} satisfies Record<string, unknown>;

describe("E4.2 resolveMakeDisclosure", () => {
  it("mints a co-present claim with captured derivation and location", () => {
    const event = acceptedEvent({
      commandId: "cmd-claim-1",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    expect(event.sequence).toBe(11);
    expect(event.locationId).toBe("loc-cafe");
    expect(event.payload.derived.assertionId).toBe(deriveAssertionId(event.id));
    expect(event.payload.derived.sourceConfidenceFixedPoint).toBe(10_000);
    expect(event.payload.derived.learnedFromActorIds).toEqual(["ana"]);
    expect(event.actorIds).toEqual(["ana", "ben"]);
    expect(event.entityIds).toContain("ana");
    expect(event.entityIds).toContain(event.payload.derived.assertionId);
  });

  it("delivers by device when any listener is elsewhere — no location, no overhearing", () => {
    const event = acceptedEvent({
      commandId: "cmd-claim-2",
      speakerActorId: "ana",
      targetActorIds: ["cam"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: false,
    });
    expect(event.locationId).toBeUndefined();
  });

  it("rejects the unauthorized, the unknown, and the missing", () => {
    const unauthorized = resolveDisclosure({
      commandId: "cmd-bad-1",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      principal: testPrincipal("player", ["ben"]),
    });
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.code).toBe("unauthorized_actor");

    const missingSpeaker = resolveDisclosure({
      commandId: "cmd-bad-2",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerExists: false,
    });
    expect(missingSpeaker.ok).toBe(false);
    if (!missingSpeaker.ok) expect(missingSpeaker.code).toBe("speaker_not_found");

    const missingTarget = resolveDisclosure({
      commandId: "cmd-bad-3",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      missingTargetIds: ["ben"],
    });
    expect(missingTarget.ok).toBe(false);
    if (!missingTarget.ok) expect(missingTarget.code).toBe("target_not_found");
  });

  it("gates a relay on a live belief and captures the teller's chain and confidence", () => {
    const claim = acceptedEvent({
      commandId: "cmd-claim-3",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    const { state } = fold(emptyKnowledgeState(), claim);
    const assertion = state.assertions.get(claim.payload.derived.assertionId);
    if (!assertion) throw new Error("expected the claim's assertion");
    const benBelief = state.beliefs.get(deriveBeliefId(claim.id, "ben"));
    if (!benBelief) throw new Error("expected Ben's belief");

    const unbelieved = resolveDisclosure({
      commandId: "cmd-relay-x",
      speakerActorId: "dex",
      targetActorIds: ["cam"],
      content: { kind: "relay", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: assertion,
    });
    expect(unbelieved.ok).toBe(false);
    if (!unbelieved.ok) expect(unbelieved.code).toBe("relay_unbelieved");

    const relay = acceptedEvent({
      commandId: "cmd-relay-1",
      speakerActorId: "ben",
      targetActorIds: ["cam"],
      content: { kind: "relay", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: assertion,
      speakerBelief: benBelief,
    });
    expect(relay.payload.derived.sourceConfidenceFixedPoint).toBe(benBelief.confidenceFixedPoint);
    expect(relay.payload.derived.learnedFromActorIds).toEqual(["ana", "ben"]);

    // The original claimant retelling their own claim needs no belief row.
    const retold = acceptedEvent({
      commandId: "cmd-relay-2",
      speakerActorId: "ana",
      targetActorIds: ["cam"],
      content: { kind: "relay", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: assertion,
    });
    expect(retold.payload.derived.sourceConfidenceFixedPoint).toBe(10_000);
    expect(retold.payload.derived.learnedFromActorIds).toEqual(["ana"]);
  });

  it("lets only the source retract, once", () => {
    const claim = acceptedEvent({
      commandId: "cmd-claim-4",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    const { state } = fold(emptyKnowledgeState(), claim);
    const assertion = state.assertions.get(claim.payload.derived.assertionId);
    if (!assertion) throw new Error("expected the claim's assertion");

    const notSource = resolveDisclosure({
      commandId: "cmd-retract-x",
      speakerActorId: "ben",
      targetActorIds: ["ana"],
      content: { kind: "retraction", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: assertion,
    });
    expect(notSource.ok).toBe(false);
    if (!notSource.ok) expect(notSource.code).toBe("retraction_unauthorized");

    const alreadyRetracted = resolveDisclosure({
      commandId: "cmd-retract-y",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: { kind: "retraction", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: { ...assertion, status: "retracted" },
    });
    expect(alreadyRetracted.ok).toBe(false);
    if (!alreadyRetracted.ok) expect(alreadyRetracted.code).toBe("assertion_already_retracted");
  });
});

describe("E4.2 applyDisclosureEvent", () => {
  it("forms beliefs for reported listeners only — never the speaker or a muffled bystander", () => {
    const claim = acceptedEvent({
      commandId: "cmd-claim-5",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    const update = fold(emptyKnowledgeState(), claim);
    const assertion = update.state.assertions.get(claim.payload.derived.assertionId);
    expect(assertion).toMatchObject({ status: "active", sourceActorId: "ana", propositionKey: "quitting_job" });

    // Ben (co-present target): reported at min(9_000, 10_000) = 9_000.
    const benBelief = update.state.beliefs.get(deriveBeliefId(claim.id, "ben"));
    expect(benBelief).toMatchObject({
      status: "active",
      confidenceFixedPoint: 9_000,
      learnedFromActorIds: ["ana"],
      holderActorId: "ben",
    });
    expect(benBelief?.basisObservationIds).toHaveLength(1);
    // Ana spoke it; Dex only heard talking through the wall.
    expect(update.state.beliefs.get(deriveBeliefId(claim.id, "ana"))).toBeUndefined();
    expect(update.state.beliefs.get(deriveBeliefId(claim.id, "dex"))).toBeUndefined();
    expect(update.upsertedBeliefs).toHaveLength(1);
  });

  it("decays a gossip hop and extends provenance", () => {
    const claim = acceptedEvent({
      commandId: "cmd-claim-6",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    let state = fold(emptyKnowledgeState(), claim).state;
    const assertion = state.assertions.get(claim.payload.derived.assertionId);
    const benBelief = state.beliefs.get(deriveBeliefId(claim.id, "ben"));
    if (!assertion || !benBelief) throw new Error("expected claim state");

    // Ben relays to Cam remotely: device-reported observation at 8_500,
    // teller confidence 9_000 − 1_000 penalty → 8_000 wins the minimum.
    const relay = acceptedEvent({
      commandId: "cmd-relay-3",
      speakerActorId: "ben",
      targetActorIds: ["cam"],
      content: { kind: "relay", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: assertion,
      speakerBelief: benBelief,
    });
    state = fold(state, relay).state;
    const camBelief = state.beliefs.get(deriveBeliefId(relay.id, "cam"));
    expect(camBelief).toMatchObject({
      status: "active",
      confidenceFixedPoint: Math.min(8_500, benBelief.confidenceFixedPoint - RELAY_CONFIDENCE_PENALTY),
      learnedFromActorIds: ["ana", "ben"],
    });
  });

  it("supersedes on re-hearing and keeps the higher confidence", () => {
    const claim = acceptedEvent({
      commandId: "cmd-claim-7",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    let state = fold(emptyKnowledgeState(), claim).state;
    const assertion = state.assertions.get(claim.payload.derived.assertionId);
    if (!assertion) throw new Error("expected assertion");

    // Ana retells her own claim to Ben remotely (weaker delivery, 8_500).
    const retold = acceptedEvent({
      commandId: "cmd-relay-4",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: { kind: "relay", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: assertion,
    });
    state = fold(state, retold).state;
    const oldBelief = state.beliefs.get(deriveBeliefId(claim.id, "ben"));
    const newBelief = state.beliefs.get(deriveBeliefId(retold.id, "ben"));
    expect(oldBelief).toMatchObject({ status: "superseded", believedUntil: NOW });
    // Refresh keeps the earlier, stronger 9_000 — repetition never erodes.
    expect(newBelief).toMatchObject({ status: "active", confidenceFixedPoint: 9_000 });
  });

  it("contradicts across sources: both assertions marked, holder flips only on strictly higher confidence", () => {
    // Ana texts Ben the claim (remote → Ben believes at 8_500).
    const claim = acceptedEvent({
      commandId: "cmd-claim-8",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: false,
    });
    let state = fold(emptyKnowledgeState(), claim).state;
    expect(state.beliefs.get(deriveBeliefId(claim.id, "ben"))).toMatchObject({
      confidenceFixedPoint: 8_500,
    });

    // Dex claims the opposite to Ben's face (co-present → 9_000 > 8_500).
    const counter = acceptedEvent({
      commandId: "cmd-claim-9",
      speakerActorId: "dex",
      targetActorIds: ["ben"],
      content: { ...quitClaim, claimedValue: { quitting: false } },
      headSequence: 11,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    state = fold(state, counter).state;

    // Neither claim may present as current truth (§3.3).
    expect(state.assertions.get(claim.payload.derived.assertionId)?.status).toBe("contradicted");
    expect(state.assertions.get(counter.payload.derived.assertionId)?.status).toBe("contradicted");
    // Ben flips: the stronger telling wins his stance.
    expect(state.beliefs.get(deriveBeliefId(claim.id, "ben"))).toMatchObject({ status: "superseded" });
    expect(state.beliefs.get(deriveBeliefId(counter.id, "ben"))).toMatchObject({
      status: "active",
      confidenceFixedPoint: 9_000,
    });

    // Cam hears the ORIGINAL claim relayed by Ana remotely (8_500), then the
    // counter-claim relayed by Dex at equal confidence — not strictly higher,
    // so the newcomer enters doubted and Cam's held stance stands.
    const anaRetell = acceptedEvent({
      commandId: "cmd-relay-5",
      speakerActorId: "ana",
      targetActorIds: ["cam"],
      content: { kind: "relay", assertionId: claim.payload.derived.assertionId },
      headSequence: 12,
      referencedAssertion: state.assertions.get(claim.payload.derived.assertionId),
    });
    state = fold(state, anaRetell).state;
    const camFirst = state.beliefs.get(deriveBeliefId(anaRetell.id, "cam"));
    expect(camFirst).toMatchObject({ status: "active", confidenceFixedPoint: 8_500 });

    const dexRetell = acceptedEvent({
      commandId: "cmd-relay-6",
      speakerActorId: "dex",
      targetActorIds: ["cam"],
      content: { kind: "relay", assertionId: counter.payload.derived.assertionId },
      headSequence: 13,
      referencedAssertion: state.assertions.get(counter.payload.derived.assertionId),
    });
    state = fold(state, dexRetell).state;
    expect(state.beliefs.get(deriveBeliefId(anaRetell.id, "cam"))).toMatchObject({ status: "active" });
    expect(state.beliefs.get(deriveBeliefId(dexRetell.id, "cam"))).toMatchObject({ status: "doubted" });
  });

  it("supersedes a changed story from the same source", () => {
    const claim = acceptedEvent({
      commandId: "cmd-claim-10",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    let state = fold(emptyKnowledgeState(), claim).state;
    const changed = acceptedEvent({
      commandId: "cmd-claim-11",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: { ...quitClaim, claimedValue: { quitting: false } },
      headSequence: 11,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    state = fold(state, changed).state;
    expect(state.assertions.get(claim.payload.derived.assertionId)?.status).toBe("superseded");
    expect(state.assertions.get(changed.payload.derived.assertionId)?.status).toBe("active");
  });

  it("rejects only the beliefs of listeners who heard the retraction", () => {
    const claim = acceptedEvent({
      commandId: "cmd-claim-12",
      speakerActorId: "ana",
      targetActorIds: ["ben", "cam"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: false,
    });
    let state = fold(emptyKnowledgeState(), claim).state;
    const assertion = state.assertions.get(claim.payload.derived.assertionId);
    if (!assertion) throw new Error("expected assertion");

    // Ana retracts to Ben only; Cam is out of earshot.
    const retraction = acceptedEvent({
      commandId: "cmd-retract-1",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: { kind: "retraction", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: assertion,
    });
    state = fold(state, retraction).state;
    expect(state.assertions.get(assertion.id)?.status).toBe("retracted");
    expect(state.beliefs.get(deriveBeliefId(claim.id, "ben"))).toMatchObject({
      status: "rejected",
      believedUntil: NOW,
    });
    // Cam keeps believing the withdrawn claim — that is the point.
    expect(state.beliefs.get(deriveBeliefId(claim.id, "cam"))).toMatchObject({ status: "active" });
  });

  it("replays to the exact incremental state, deterministically", () => {
    const claim = acceptedEvent({
      commandId: "cmd-claim-13",
      speakerActorId: "ana",
      targetActorIds: ["ben"],
      content: quitClaim,
      headSequence: 10,
      speakerLocationId: "loc-cafe",
      targetsCoPresent: true,
    });
    let state = fold(emptyKnowledgeState(), claim).state;
    const assertion = state.assertions.get(claim.payload.derived.assertionId);
    const benBelief = state.beliefs.get(deriveBeliefId(claim.id, "ben"));
    if (!assertion || !benBelief) throw new Error("expected claim state");
    const relay = acceptedEvent({
      commandId: "cmd-relay-7",
      speakerActorId: "ben",
      targetActorIds: ["cam"],
      content: { kind: "relay", assertionId: assertion.id },
      headSequence: 11,
      referencedAssertion: assertion,
      speakerBelief: benBelief,
    });
    state = fold(state, relay).state;

    const events = [claim, relay] as SimulationBranchEvent[];
    const observations: Observation[] = events.flatMap((event) =>
      deriveEventObservations(event, fixtureSpace()),
    );
    const replayed = replayKnowledgeHistory({ events, observations });
    const replayedAgain = replayKnowledgeHistory({ events, observations });
    expect(replayedAgain).toEqual(replayed);
    expect(replayed.assertions).toEqual(
      [...state.assertions.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
    expect(replayed.beliefs).toEqual(
      [...state.beliefs.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
  });
});
