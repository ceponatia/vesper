import { describe, expect, it } from "vitest";
import { activityInstanceSchema, type ActivityInstance } from "@/contracts/simulation/activities";
import { commitmentSchema, type Commitment } from "@/contracts/simulation/commitments";
import {
  engagementAttentionClaim,
  engagementSchema,
  type Engagement,
} from "@/contracts/simulation/engagements";
import {
  moveTogetherCommandSchema,
  physicalLocusSchema,
  type MoveTogetherCommand,
  type PhysicalLocus,
} from "@/contracts/simulation/space";
import { resolveMoveTogether, type MoveTogetherResolutionView } from "./move-together";
import { deriveJourneyId, journeyArrivalUniquenessKey, resolveJourneyArrival, type SpaceTopology } from "./space";

/**
 * command-integrity A4 pure resolver tests. The composed walk-with-me is now ONE
 * indivisible action: decide (re-run inside the locked view) + scene-end grace +
 * ONE shared journey carrying BOTH actors + one arrival — no three-transaction
 * window to strand the pair. Every accept/decline/taxonomy cell is asserted from
 * fixtures; the multi-actor arrival re-uses `resolveJourneyArrival` (already
 * covered for one traveller) to prove both land together.
 */

const SEED_SECOND = 100;
const PLAYER = "actor-player";
const PRIMARY = "actor-primary";
const WALK_SECONDS = 600;

function topology(): SpaceTopology {
  return {
    locations: [
      { id: "loc-home", worldId: "world-1", kind: "home", defaultAccessPolicy: "private" },
      { id: "loc-cafe", worldId: "world-1", kind: "cafe", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: "zone-a", locationId: "loc-home", kind: "room", privacyPolicy: "private" },
      { id: "zone-b", locationId: "loc-cafe", kind: "hall", privacyPolicy: "public" },
    ],
    links: [
      {
        id: "link-ab",
        fromZoneId: "zone-a",
        toZoneId: "zone-b",
        modes: ["walk"],
        minimumDurationSeconds: WALK_SECONDS,
        accessPolicy: "public",
        state: "open",
      },
    ],
  } as unknown as SpaceTopology;
}

function atLocus(actorId: string, zoneId: string, locationId: string): PhysicalLocus {
  return physicalLocusSchema.parse({ kind: "at", actorId, locationId, zoneId, since: SEED_SECOND });
}

function transitLocus(actorId: string): PhysicalLocus {
  return physicalLocusSchema.parse({
    kind: "in_transit",
    actorId,
    journeyId: deriveJourneyId("branch-1", "cmd-earlier"),
    linkId: "link-ab",
    enteredAt: SEED_SECOND,
    earliestExitAt: SEED_SECOND + WALK_SECONDS,
  });
}

function standingScene(): Engagement {
  return engagementSchema.parse({
    id: "engagement-1",
    participantIds: [PLAYER, PRIMARY].sort(),
    channel: "co_present",
    locationId: "loc-home",
    zoneId: "zone-a",
    state: "active",
    openedAt: SEED_SECOND,
    attentionClaim: engagementAttentionClaim("co_present"),
    sourceCommandId: "cmd-open",
  });
}

function bodyActivity(actorId: string): ActivityInstance {
  return activityInstanceSchema.parse({
    id: `act-${actorId}`,
    actionDefinitionId: "stw-x-action-rest",
    actionVersion: 1,
    actorIds: [actorId],
    zoneId: "zone-a",
    phase: "active",
    progressFixedPoint: 0,
    claims: [{ kind: "body" }],
    reservedItemIds: [],
    sourceCommandId: "cmd-x",
  });
}

function firmCommitment(actorId: string, latestArrival: number): Commitment {
  return commitmentSchema.parse({
    id: "commit-1",
    actorId,
    kind: "shift",
    destinationZoneId: "zone-b",
    window: { latestArrival },
    priority: 5,
    flexibility: "firm",
    preparationSeconds: 0,
    reliabilityBufferSeconds: 0,
    noticeLeadSeconds: 0,
    status: "accepted",
    knowledgeSource: { kind: "authored" },
    sourceCommandId: "cmd-c",
  });
}

// The default view carries NO standing scene (a scene is added explicitly where a
// test asserts the engagement_ended prefix) — avoids assigning `undefined` to the
// optional `standingEngagement` under exactOptionalPropertyTypes.
function view(overrides: Partial<MoveTogetherResolutionView> = {}): MoveTogetherResolutionView {
  const shape = topology();
  return {
    worldId: "world-1",
    branchId: "branch-1",
    rulesetVersion: "gate3-test-v1",
    headSequence: 0,
    storySecond: SEED_SECOND,
    topology: shape,
    playerExists: true,
    coTravelerExists: true,
    playerLocus: atLocus(PLAYER, "zone-a", "loc-home"),
    coTravelerLocus: atLocus(PRIMARY, "zone-a", "loc-home"),
    coTravelerName: "Nora",
    activities: [],
    commitments: [],
    ...overrides,
  };
}

function command(payloadOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): MoveTogetherCommand {
  return moveTogetherCommandSchema.parse({
    id: "cmd-together-1",
    branchId: "branch-1",
    expectedVersion: 0,
    idempotencyKey: "together-key-1",
    principal: { kind: "player", principalId: "principal-1", controlledActorIds: [PLAYER] },
    submittedAtWallClock: "2026-07-24T12:00:00.000Z",
    correlationId: "corr-1",
    type: "move_together",
    schemaVersion: 1,
    payload: { actorId: PLAYER, coTravelerActorId: PRIMARY, destinationZoneId: "zone-b", travelMode: "walk", ...payloadOverrides },
    ...overrides,
  });
}

describe("resolveMoveTogether — accept", () => {
  it("ends the standing scene and departs BOTH actors on ONE shared journey", () => {
    const resolution = resolveMoveTogether(view({ standingEngagement: standingScene() }), command());
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);

    // engagement_ended (grace) FIRST, then the movement batch — sequences 1..4.
    expect(resolution.endedEngagementId).toBe("engagement-1");
    expect(resolution.endedEvent?.sequence).toBe(1);
    expect(resolution.endedEvent?.payload.reason).toBe("participant_choice");
    expect(resolution.plannedEvent.sequence).toBe(2);
    expect(resolution.departedEvent.sequence).toBe(3);
    expect(resolution.triggerEvent.sequence).toBe(4);
    expect(resolution.departedEvent.causationId).toBe(resolution.plannedEvent.id);
    expect(resolution.triggerEvent.causationId).toBe(resolution.departedEvent.id);

    // ONE journey, BOTH travellers, ONE arrival uniqueness key.
    const both = [PLAYER, PRIMARY].sort();
    expect(resolution.journey.actorIds).toEqual(both);
    expect(resolution.plannedEvent.actorIds).toEqual(both);
    expect(resolution.plannedEvent.payload.earliestArrivalAt).toBe(SEED_SECOND + WALK_SECONDS);
    expect(resolution.triggerEvent.payload.dueStorySecond).toBe(SEED_SECOND + WALK_SECONDS);
    expect(resolution.triggerEvent.payload.uniquenessKey).toBe(journeyArrivalUniquenessKey(resolution.journey.id));

    // Both travellers get an in_transit locus on the SAME journey (together by construction).
    expect(resolution.loci).toHaveLength(2);
    const journeyIds = new Set(
      resolution.loci.map((locus) => (locus.kind === "in_transit" ? locus.journeyId : "at")),
    );
    expect(journeyIds).toEqual(new Set([resolution.journey.id]));
    expect(resolution.loci.map((locus) => locus.actorId).sort()).toEqual(both);
  });

  it("without a standing scene, emits no engagement_ended and starts the batch at sequence 1", () => {
    const resolution = resolveMoveTogether(view(), command());
    if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}`);
    expect(resolution.endedEvent).toBeUndefined();
    expect(resolution.endedEngagementId).toBeUndefined();
    expect(resolution.plannedEvent.sequence).toBe(1);
    expect(resolution.departedEvent.sequence).toBe(2);
    expect(resolution.triggerEvent.sequence).toBe(3);
  });
});

describe("resolveMoveTogether — decline (§14.4 face)", () => {
  it("declines when a claim-holding activity occupies the co-traveller's body", () => {
    const resolution = resolveMoveTogether(view({ activities: [bodyActivity(PRIMARY)] }), command());
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("accompany_declined");
    expect(resolution.publicReason.length).toBeGreaterThan(0);
    expect(resolution.legalAlternatives ?? []).not.toHaveLength(0);
  });

  it("declines when a firm commitment falls due before arrival + the buffer", () => {
    // Arrival lower bound is SEED_SECOND + WALK_SECONDS = 700; a firm commitment
    // due at 800 is within the 300s buffer, so she can't leave now.
    const resolution = resolveMoveTogether(
      view({ commitments: [firmCommitment(PRIMARY, SEED_SECOND + WALK_SECONDS + 100)] }),
      command(),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("accompany_declined");
  });

  it("a body claim on the PLAYER (not the co-traveller) is the player's own move conflict, not a decline", () => {
    const resolution = resolveMoveTogether(view({ activities: [bodyActivity(PLAYER)] }), command());
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("activity_conflict");
  });
});

describe("resolveMoveTogether — the refusal taxonomy", () => {
  it("refuses when the two are not co-present (a claim conflict cannot strand them)", () => {
    const apart = view({ coTravelerLocus: atLocus(PRIMARY, "zone-b", "loc-cafe") });
    const resolution = resolveMoveTogether(apart, command());
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("not_copresent");
  });

  it("refuses a co-traveller who is already in transit", () => {
    const resolution = resolveMoveTogether(view({ coTravelerLocus: transitLocus(PRIMARY) }), command());
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("co_traveler_in_transit");
  });

  it("refuses when the player themselves is already in transit", () => {
    const resolution = resolveMoveTogether(view({ playerLocus: transitLocus(PLAYER) }), command());
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("actor_in_transit");
  });

  it("refuses a principal that does not control the player (§14.2)", () => {
    const uncontrolled = command(
      {},
      { principal: { kind: "player", principalId: "principal-1", controlledActorIds: ["actor-other"] } },
    );
    const resolution = resolveMoveTogether(view(), uncontrolled);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("unauthorized_actor");
  });

  it("refuses when the pair is already at the destination", () => {
    const there = view({
      playerLocus: atLocus(PLAYER, "zone-b", "loc-cafe"),
      coTravelerLocus: atLocus(PRIMARY, "zone-b", "loc-cafe"),
    });
    const resolution = resolveMoveTogether(there, command());
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("already_at_destination");
  });
});

describe("resolveMoveTogether — the shared journey lands both", () => {
  it("resolveJourneyArrival flips EVERY traveller on the shared journey to the destination", () => {
    const resolution = resolveMoveTogether(view(), command());
    if (!resolution.ok) throw new Error("fixture move_together must resolve");
    const arrival = resolveJourneyArrival(
      {
        worldId: "world-1",
        branchId: "branch-1",
        rulesetVersion: "gate3-test-v1",
        version: 1,
        headSequence: resolution.triggerEvent.sequence,
        storySecond: SEED_SECOND + WALK_SECONDS,
        topology: topology(),
        journey: resolution.journey,
      } as never,
      {
        id: "cmd-arrive-1",
        branchId: "branch-1",
        expectedVersion: 1,
        idempotencyKey: "arrive-key-1",
        principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
        submittedAtWallClock: "2026-07-24T12:15:00.000Z",
        correlationId: "corr-1",
        type: "arrive_journey",
        schemaVersion: 1,
        payload: { journeyId: resolution.journey.id },
      } as never,
    );
    if (!arrival.ok) throw new Error(`expected arrival, got ${arrival.code}`);
    expect(arrival.loci.map((locus) => locus.actorId).sort()).toEqual([PLAYER, PRIMARY].sort());
    for (const locus of arrival.loci) {
      expect(locus.kind).toBe("at");
      if (locus.kind === "at") expect(locus.zoneId).toBe("zone-b");
    }
  });
});
