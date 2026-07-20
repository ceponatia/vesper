import { describe, expect, it } from "vitest";
import { activityInstanceSchema } from "@/contracts/simulation/activities";
import { simulationBranchEventSchema, type SimulationBranchEvent } from "@/contracts/simulation/branching";
import { engagementSchema, type Engagement } from "@/contracts/simulation/engagements";
import { assertionSchema, beliefSchema } from "@/contracts/simulation/knowledge";
import { CUT_COMPILER_VERSION } from "@/contracts/simulation/narrative";
import { softCanonEntrySchema } from "@/contracts/simulation/soft-canon";
import { spaceProjectionSchema, type SpaceProjection } from "@/contracts/simulation/space";
import { temporalPressureSchema } from "@/contracts/simulation/commitments";
import { compileNarrativeCut, decideDepartures, departureCandidates } from "./narrative";
import { deriveCommandObservations } from "./perception";

const NOW = 100_000;

function pressure(actorId: string, actBy: number, commitmentId = `commit-${actorId}`) {
  return {
    ...temporalPressureSchema.parse({
      id: `pressure-${commitmentId}`,
      actorId,
      sourceCommitmentId: commitmentId,
      noticeAt: NOW,
      decideBy: actBy,
      actBy,
      severity: "urgent",
    }),
    destinationZoneId: "zone-shop",
  };
}

describe("E3.4 decideDepartures", () => {
  it("departs inside the horizon, defers on a stay request, and spares player actors", () => {
    const base = {
      turnEndSecond: NOW + 400,
      horizonSeconds: 1_000,
      stayRequestedActorIds: [] as string[],
      policyControlledActorIds: ["mara"],
    };
    expect(decideDepartures({ ...base, pressures: [pressure("mara", NOW + 1_200)] })).toHaveLength(1);
    // Asked to stay: only a boundary inside the turn itself forces departure.
    expect(
      decideDepartures({ ...base, stayRequestedActorIds: ["mara"], pressures: [pressure("mara", NOW + 1_200)] }),
    ).toHaveLength(0);
    expect(
      decideDepartures({ ...base, stayRequestedActorIds: ["mara"], pressures: [pressure("mara", NOW + 300)] }),
    ).toHaveLength(1);
    // The player's own actor is never policy-moved.
    expect(
      decideDepartures({ ...base, policyControlledActorIds: [], pressures: [pressure("mara", NOW + 100)] }),
    ).toHaveLength(0);
  });

  it("takes the earliest boundary per actor; candidates expose the full legal list (§19.1)", () => {
    const input = {
      pressures: [pressure("mara", NOW + 900, "commit-b"), pressure("mara", NOW + 500, "commit-a")],
      turnEndSecond: NOW + 400,
      horizonSeconds: 1_000,
      stayRequestedActorIds: [],
      policyControlledActorIds: ["mara"],
    };
    const departures = decideDepartures(input);
    expect(departures).toHaveLength(1);
    expect(departures[0]?.commitmentId).toBe("commit-a");
    // The §19.3 deliberator may pick among exactly these — never outside them.
    expect(departureCandidates(input).map((candidate) => candidate.sourceCommitmentId)).toEqual([
      "commit-a",
      "commit-b",
    ]);
  });
});

function fixtureSpace(): SpaceProjection {
  return spaceProjectionSchema.parse({
    worldId: "world-1",
    branchId: "branch-1",
    rulesetVersion: "gate3-test-v1",
    version: 4,
    headSequence: 6,
    storySecond: NOW + 400,
    locations: [{ id: "loc-cafe", worldId: "world-1", kind: "cafe", defaultAccessPolicy: "public" }],
    zones: [
      { id: "zone-cafe", locationId: "loc-cafe", kind: "hall", privacyPolicy: "public" },
      { id: "zone-shop", locationId: "loc-cafe", kind: "shop", privacyPolicy: "public" },
    ],
    links: [
      {
        id: "link-cs",
        fromZoneId: "zone-cafe",
        toZoneId: "zone-shop",
        modes: ["walk"],
        minimumDurationSeconds: 300,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [
      { kind: "at", actorId: "player", locationId: "loc-cafe", zoneId: "zone-cafe", since: NOW },
      {
        kind: "in_transit",
        actorId: "mara",
        journeyId: "journey-1",
        linkId: "link-cs",
        enteredAt: NOW + 300,
        earliestExitAt: NOW + 600,
      },
    ],
    journeys: [],
  });
}

function fixtureEngagement(): Engagement {
  return engagementSchema.parse({
    id: "engagement-1",
    participantIds: ["mara", "player"],
    channel: "co_present",
    locationId: "loc-cafe",
    zoneId: "zone-cafe",
    state: "interrupted",
    openedAt: NOW,
    attentionClaim: { kind: "attention", weight: "full" },
    sourceCommandId: "cmd-open",
  });
}

function departureEvent(sequence: number): SimulationBranchEvent {
  return simulationBranchEventSchema.parse({
    id: `event-departed-${sequence}`,
    worldId: "world-1",
    branchId: "branch-1",
    sequence,
    storySecond: NOW + 300,
    type: "actor_departed",
    schemaVersion: 1,
    rulesetVersion: "gate3-test-v1",
    commandId: "cmd-move",
    correlationId: "corr-1",
    actorIds: ["mara"],
    entityIds: ["journey-1"],
    locationId: "loc-cafe",
    recordedAtWallClock: "2026-07-17T12:00:00.000Z",
    payload: { journeyId: "journey-1", fromZoneId: "zone-cafe", linkId: "link-cs", departedAt: NOW + 300 },
  });
}

function commitmentEvent(sequence: number): SimulationBranchEvent {
  return simulationBranchEventSchema.parse({
    id: `event-missed-${sequence}`,
    worldId: "world-1",
    branchId: "branch-1",
    sequence,
    storySecond: NOW + 350,
    type: "commitment_missed",
    schemaVersion: 1,
    rulesetVersion: "gate3-test-v1",
    commandId: "cmd-deadline",
    correlationId: "corr-1",
    actorIds: ["mara"],
    entityIds: ["commit-mara"],
    recordedAtWallClock: "2026-07-17T12:00:00.000Z",
    payload: {
      commitmentId: "commit-mara",
      actorId: "mara",
      resolvedAt: NOW + 350,
      evaluation: { basis: "absent" },
    },
  });
}

function windingDownEvent(sequence: number): SimulationBranchEvent {
  return simulationBranchEventSchema.parse({
    id: `event-winding-${sequence}`,
    worldId: "world-1",
    branchId: "branch-1",
    sequence,
    storySecond: NOW + 360,
    type: "engagement_winding_down",
    schemaVersion: 1,
    rulesetVersion: "gate3-test-v1",
    commandId: "cmd-wind",
    correlationId: "corr-1",
    actorIds: ["mara", "player"],
    entityIds: ["engagement-1"],
    locationId: "loc-cafe",
    recordedAtWallClock: "2026-07-17T12:00:00.000Z",
    payload: { engagementId: "engagement-1", at: NOW + 360 },
  });
}

function fixtureBelief() {
  const assertion = assertionSchema.parse({
    id: "assert-1",
    branchId: "branch-1",
    propositionKey: "works_at",
    subjectIds: ["iris"],
    claimedValue: { employer: "florist" },
    sourceActorId: "mara",
    assertedAt: NOW - 500,
    status: "active",
    derivationVersion: "knowledge-v1",
  });
  const belief = beliefSchema.parse({
    id: "belief-1",
    branchId: "branch-1",
    holderActorId: "player",
    assertionId: "assert-1",
    confidenceFixedPoint: 8_200,
    basisObservationIds: [],
    learnedFromActorIds: ["mara"],
    believedFrom: NOW - 500,
    status: "active",
    sourceEventId: "event-gossip",
    sourceEventSequence: 2,
    derivationVersion: "knowledge-v1",
  });
  return { belief, assertion };
}

function fixtureSoftCanonEntry() {
  return softCanonEntrySchema.parse({
    id: "canon-nickname",
    branchId: "branch-1",
    key: "nickname_for_player",
    scope: "relationship",
    subjectIds: ["mara", "player"],
    value: "stray",
    confidenceFixedPoint: 9_000,
    firstRecordedAt: NOW - 1_000,
    lastRecordedAt: NOW - 200,
    validUntil: NOW + 10_000,
    sourceCutIds: ["cut-earlier"],
    status: "active",
    rulesVersion: "soft-canon-rules-v1",
    derivationVersion: "soft-canon-v1",
  });
}

function compile(overrides: Record<string, unknown> = {}) {
  const events = [departureEvent(5), commitmentEvent(6)];
  return compileNarrativeCut({
    branchVersion: 4,
    engagement: fixtureEngagement(),
    viewpointActorId: "player",
    events,
    fromSequence: 4,
    throughSequence: 6,
    fromStorySecond: NOW,
    throughStorySecond: NOW + 400,
    space: fixtureSpace(),
    activities: [],
    // What the viewpoint perceived comes from the E4.1 rule table, exactly
    // as the live turn seam feeds the compiler from the observation log.
    viewpointObservations: deriveCommandObservations(events, fixtureSpace()),
    viewpointBeliefs: [],
    viewpointPressures: [],
    failurePresentations: [],
    softCanonEntries: [],
    proposedArmedEffects: [],
    ...overrides,
  });
}

describe("E4.3 compileNarrativeCut", () => {
  it("shows the observable departure and hides the private commitment outcome", () => {
    const cut = compile();
    expect(cut.compilerVersion).toBe(CUT_COMPILER_VERSION);
    expect(cut.mustEnact.map((beat) => beat.kind)).toEqual(["actor_departed"]);
    // Privacy by omission: another actor's obligations never appear as facts.
    expect(JSON.stringify(cut)).not.toContain("commit-mara");
    expect(cut.relevantPressures).toEqual([]);
    // Perspective-safe loci: the viewpoint plus co-located actors only.
    expect(cut.currentLoci.map((locus) => locus.actorId)).toEqual(["player"]);
  });

  it("rerenders identically: same inputs, same id, same semantic hash (ruling 8)", () => {
    const first = compile();
    const second = compile();
    expect(second.id).toBe(first.id);
    expect(second.semanticHash).toBe(first.semanticHash);
    expect(second).toEqual(first);
  });

  it("embeds bodily reads actor-sorted and defaults them empty (E5.2)", () => {
    expect(compile().bodilyReads).toEqual({ observed: [] });
    const cut = compile({
      bodilyReads: {
        self: { energySignedFixedPoint: 3_450, energyBand: "steady", intimacyPhase: "quiescent" },
        observed: [
          { actorId: "zoe", signs: ["flushed_skin"] },
          { actorId: "mara", signs: ["visible_fatigue"] },
        ],
      },
    });
    expect(cut.bodilyReads.self?.energyBand).toBe("steady");
    expect(cut.bodilyReads.observed.map((entry) => entry.actorId)).toEqual(["mara", "zoe"]);
    // Reads change the semantic hash — a rerender with different body state
    // is a different cut, never a silent drift.
    expect(cut.semanticHash).not.toBe(compile().semanticHash);
  });

  it("routes observed soft transitions into allowedTransitions, never mustEnact", () => {
    const events = [departureEvent(5), windingDownEvent(6)];
    const cut = compile({ events, viewpointObservations: deriveCommandObservations(events, fixtureSpace()) });
    expect(cut.mustEnact.map((beat) => beat.kind)).toEqual(["actor_departed"]);
    expect(cut.allowedTransitions.map((beat) => beat.kind)).toEqual(["engagement_winding_down"]);
  });

  it("maps the viewpoint's observations into evidence views with event kinds", () => {
    const cut = compile();
    expect(cut.perceptibleNow).toHaveLength(1);
    expect(cut.perceptibleNow[0]?.eventKind).toBe("actor_departed");
    expect(cut.perceptibleNow[0]?.channel).toBe("sight");
    expect(cut.provenance.find((ref) => ref.field === "perceptibleNow")?.ids).toEqual([
      cut.perceptibleNow[0]?.observationId,
    ]);
  });

  it("voices only the viewpoint's live beliefs, joined to their assertions (§21)", () => {
    const { belief, assertion } = fixtureBelief();
    const rejected = beliefSchema.parse({ ...belief, id: "belief-2", status: "rejected" });
    const cut = compile({
      viewpointBeliefs: [
        { belief, assertion },
        { belief: rejected, assertion },
      ],
    });
    expect(cut.speakerBeliefs).toHaveLength(1);
    expect(cut.speakerBeliefs[0]).toMatchObject({
      beliefId: "belief-1",
      propositionKey: "works_at",
      claimedValue: { employer: "florist" },
      learnedFromActorIds: ["mara"],
    });
  });

  it("keeps only co-located claim-holding activities in view", () => {
    const here = activityInstanceSchema.parse({
      id: "activity-here",
      actionDefinitionId: "action-knit",
      actionVersion: 1,
      actorIds: ["player"],
      zoneId: "zone-cafe",
      phase: "active",
      progressFixedPoint: 0,
      claims: [{ kind: "attention", weight: "partial" }],
      sourceCommandId: "cmd-knit",
    });
    const elsewhere = activityInstanceSchema.parse({ ...here, id: "activity-away", zoneId: "zone-shop" });
    const done = activityInstanceSchema.parse({ ...here, id: "activity-done", phase: "completed" });
    const cut = compile({ activities: [elsewhere, done, here] });
    expect(cut.currentActivities.map((activity) => activity.activityId)).toEqual(["activity-here"]);
  });

  it("bans absent co-present participants by name (§22.2 impossible_presence)", () => {
    const cut = compile();
    const contextual = cut.forbiddenClaims.find((claim) => claim.subjectActorIds.length > 0);
    expect(contextual?.code).toBe("impossible_presence");
    expect(contextual?.subjectActorIds).toEqual(["mara"]);
  });

  it("licenses in-scope soft canon as established detail with provenance", () => {
    const entry = fixtureSoftCanonEntry();
    const cut = compile({ softCanonEntries: [entry] });
    const licensed = cut.creativeLicenses.filter((license) => license.kind === "established_detail");
    expect(licensed).toHaveLength(1);
    expect(licensed[0]?.softCanon).toMatchObject({ entryId: "canon-nickname", value: "stray" });
    expect(cut.provenance.find((ref) => ref.field === "creativeLicenses")?.ids).toEqual(["canon-nickname"]);
  });

  it("passes public failure presentations through untouched, private causes untyped", () => {
    const cut = compile({
      failurePresentations: [
        {
          code: "entry_denied",
          publicReason: "The door doesn't open.",
          publicEvidence: ["The latch holds."],
          legalAlternatives: ["attempt_entry"],
        },
      ],
    });
    expect(cut.failurePresentations).toHaveLength(1);
    expect(cut.failurePresentations[0]?.publicReason).toBe("The door doesn't open.");
  });

  it("arms only effects whose actors and targets are participants, with the E4.2 bridge content", () => {
    const cut = compile({
      proposedArmedEffects: [
        {
          effectType: "disclosure_made",
          actorId: "mara",
          targetActorIds: ["player"],
          detail: "admits where she works",
          disclosureContent: {
            kind: "claim",
            propositionKey: "works_at",
            subjectIds: ["mara"],
            claimedValue: { employer: "florist" },
          },
        },
        { effectType: "promise_offered", actorId: "stranger", targetActorIds: ["player"], detail: "never armed" },
        { effectType: "question_asked", actorId: "player", targetActorIds: ["stranger"], detail: "never armed" },
      ],
    });
    expect(cut.armedEffects).toHaveLength(1);
    expect(cut.armedEffects[0]).toMatchObject({
      effectType: "disclosure_made",
      cutId: cut.id,
      preconditionVersion: 4,
    });
    expect(cut.armedEffects[0]?.disclosureContent?.kind).toBe("claim");
  });

  it("threads a proposed consent-scoped effect's consentScopeKey through to the armed effect (E5.5 §21.3–21.4 — a Stage A/B regression: this field was dropped entirely, so no boundary/permission speech act could ever be armed)", () => {
    const cut = compile({
      proposedArmedEffects: [
        {
          effectType: "boundary_expressed",
          actorId: "mara",
          targetActorIds: ["player"],
          detail: "Mara says she's fine with closeness but nothing more tonight.",
          consentScopeKey: "closeness",
        },
      ],
    });
    expect(cut.armedEffects).toHaveLength(1);
    expect(cut.armedEffects[0]).toMatchObject({ effectType: "boundary_expressed", consentScopeKey: "closeness" });
  });

  it("keeps the viewpoint's own pressures and drops resolved ones", () => {
    const cut = compile({
      viewpointPressures: [
        temporalPressureSchema.parse({
          id: "pressure-own",
          actorId: "player",
          sourceCommitmentId: "commit-player",
          noticeAt: NOW,
          decideBy: NOW + 900,
          actBy: NOW + 900,
          severity: "salient",
        }),
        temporalPressureSchema.parse({
          id: "pressure-done",
          actorId: "player",
          sourceCommitmentId: "commit-done",
          noticeAt: NOW,
          decideBy: NOW + 100,
          actBy: NOW + 100,
          severity: "hard",
          resolvedAt: NOW + 100,
        }),
      ],
    });
    expect(cut.relevantPressures).toEqual([
      { commitmentId: "commit-player", severity: "salient", actBy: NOW + 900 },
    ]);
  });
});
