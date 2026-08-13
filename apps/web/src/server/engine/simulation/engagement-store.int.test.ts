import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import {
  deriveEngagementId,
  emptyEngagementsSeed,
  replayEngagementsHistory,
} from "@vesper/simulation-core/engagements";
import { simulationHash } from "@vesper/simulation-core/hash";
import { seedDurableActionDefinitions, submitDurableStartActivity } from "./activity-store";
import { forkBranch } from "./branch-store";
import {
  readDurableEngagements,
  submitDurableEndEngagement,
  submitDurableOpenEngagement,
} from "./engagement-store";
import { readDurableSpaceBranch, submitDurableMoveActor } from "./space-store";
import {
  expectAccepted,
  expectRejected,
  LEGACY_ENGINE_TEST_PLAYER_ID,
  playerPrincipal,
  readBranchEvents,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";

/**
 * E3.4 durable engagements: one co-present scene per body, claim conflicts
 * against activities, departure interrupts, and fork/rebuild parity. Runs on
 * the shared `simulationSuiteHarness` scaffold (probe + legacy-player guard +
 * world teardown + pool close).
 */

const harness = await simulationSuiteHarness({ suite: "engagement-store.int.test", table: "sim_engagements" });

const SEED_SECOND = 60_000;
const WALK = 600;

interface SceneCase {
  worldId: string;
  branchId: string;
  mara: string;
  iris: string;
  zoneA: string;
  zoneB: string;
  napActionId: string;
}

async function seedSceneCase(): Promise<SceneCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: SceneCase = {
    worldId,
    branchId,
    mara: newId(),
    iris: newId(),
    zoneA: `${branchId}-zone-a`,
    zoneB: `${branchId}-zone-b`,
    napActionId: `${branchId}-action-nap`,
  };
  const locHome = `${worldId}-loc-home`;
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "e3-4-tests",
    rulesetVersion: "e3-4-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
    ],
    locations: [{ id: locHome, worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [
      { id: ids.zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneB, locationId: locHome, kind: "kitchen", privacyPolicy: "semi_private" },
    ],
    links: [
      {
        id: `${branchId}-link-ab`,
        fromZoneId: ids.zoneA,
        toZoneId: ids.zoneB,
        modes: ["walk"],
        minimumDurationSeconds: WALK,
        accessPolicy: "public",
        state: "open",
      },
    ],
    placements: [
      { actorId: ids.mara, locationId: locHome, zoneId: ids.zoneA },
      { actorId: ids.iris, locationId: locHome, zoneId: ids.zoneA },
    ],
  });
  await seedDurableActionDefinitions({
    branchId,
    definitions: [
      {
        id: ids.napActionId,
        version: 1,
        controllerKinds: ["player"],
        duration: { kind: "fixed", seconds: 1_800 },
        preconditions: [],
        requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
        interruptibility: "pausable",
        noticeability: "obvious",
      },
    ],
  });
  harness.trackWorld(worldId);
  return ids;
}

function openCommand(
  ids: SceneCase,
  options: { name?: string; expectedVersion?: number; payload?: Record<string, unknown> } = {},
) {
  return simCommand({
    branchId: ids.branchId,
    name: options.name ?? "open",
    type: "open_engagement",
    expectedVersion: options.expectedVersion ?? 0,
    principal: playerPrincipal(ids.mara),
    payload: { participantIds: [ids.mara, ids.iris].sort(), channel: "co_present", ...options.payload },
  });
}

function napCommand(ids: SceneCase, actorId: string, expectedVersion: number, suffix: string) {
  return simCommand({
    branchId: ids.branchId,
    name: `nap-${suffix}`,
    type: "start_activity",
    expectedVersion,
    principal: playerPrincipal(actorId),
    payload: { actionDefinitionId: ids.napActionId, actorId },
  });
}

describe.runIf(harness.ready)("E3.4 durable engagements", () => {
  it("opens one co-present scene and refuses a second for an occupied body", async () => {
    const ids = await seedSceneCase();
    const open = await submitDurableOpenEngagement(openCommand(ids));
    expectAccepted(open, "open the first co-present scene");
    const projection = await readDurableEngagements(ids.branchId);
    expect(projection.engagements[0]).toMatchObject({ state: "active", channel: "co_present", zoneId: ids.zoneA });

    const second = await submitDurableOpenEngagement(
      openCommand(ids, { name: "open2", expectedVersion: 1 }),
    );
    expectRejected(second, "participant_already_engaged", "a second scene for an already-engaged body");
  });

  it("naps block conversations and conversations block naps", async () => {
    const ids = await seedSceneCase();
    // Iris naps (body + full attention).
    const nap = await submitDurableStartActivity(napCommand(ids, ids.iris, 0, "iris"));
    expectAccepted(nap, "Iris starts a nap");

    // Even a text thread cannot reach a napping mind (ruling 11 adjacent).
    const text = await submitDurableOpenEngagement(
      openCommand(ids, { expectedVersion: 1, payload: { channel: "text" } }),
    );
    expectRejected(text, "participant_unavailable", "a text thread reaching a napping mind");

    // In a second world: an open conversation blocks starting a nap.
    const other = await seedSceneCase();
    await submitDurableOpenEngagement(openCommand(other));
    const napDuring = await submitDurableStartActivity(napCommand(other, other.mara, 1, "mara"));
    expectRejected(napDuring, "claim_conflict", "a nap started under a live conversation");
  });

  it("a departure interrupts the scene atomically with the journey events", async () => {
    const ids = await seedSceneCase();
    await submitDurableOpenEngagement(openCommand(ids));
    const move = await submitDurableMoveActor(
      simCommand({
        branchId: ids.branchId,
        name: "move",
        type: "move_actor",
        expectedVersion: 1,
        principal: playerPrincipal(ids.mara),
        payload: { actorId: ids.mara, destinationZoneId: ids.zoneB, travelMode: "walk" },
      }),
    );
    expectAccepted(move, "Mara departs mid-scene");
    // journey_planned + actor_departed + arrival trigger + engagement interrupt.
    expect(move.eventIds).toHaveLength(3);
    expect(move.lastSequence - move.firstSequence).toBe(3);

    const projection = await readDurableEngagements(ids.branchId);
    expect(projection.engagements[0]?.state).toBe("interrupted");
    const space = await readDurableSpaceBranch(ids.branchId);
    expect(space.loci.find((locus) => locus.actorId === ids.mara)?.kind).toBe("in_transit");
  });

  it("ending releases attention; forks and rebuilds stay faithful", async () => {
    const ids = await seedSceneCase();
    await submitDurableOpenEngagement(openCommand(ids));

    const childBranchId = newId();
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: 1,
      principal: { kind: "player", principalId: LEGACY_ENGINE_TEST_PLAYER_ID },
      reason: "mid-conversation retake",
    });
    expect(fork.inheritedEventCount).toBe(1);
    const child = await readDurableEngagements(childBranchId);
    expect(child.engagements[0]?.state).toBe("active");

    const end = await submitDurableEndEngagement(
      simCommand({
        branchId: ids.branchId,
        name: "end",
        type: "end_engagement",
        expectedVersion: 1,
        principal: playerPrincipal(ids.mara),
        payload: {
          engagementId: deriveEngagementId(ids.branchId, `cmd-open-${ids.branchId}`),
          reason: "participant_choice",
        },
      }),
    );
    expectAccepted(end, "end the conversation");
    // Released: the nap that a live conversation would block now starts.
    const nap = await submitDurableStartActivity(napCommand(ids, ids.mara, 2, "after-end"));
    expectAccepted(nap, "a nap after the scene released attention");

    const live = await readDurableEngagements(ids.branchId);
    const events = await readBranchEvents(ids.branchId);
    const rebuilt = replayEngagementsHistory({
      seed: emptyEngagementsSeed(ids.branchId, SEED_SECOND),
      events,
    });
    expect(simulationHash(rebuilt)).toBe(simulationHash(live));
  });
});
