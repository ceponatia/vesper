import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { emptyActorLodsSeed, replayActorLodHistory } from "@/lib/simulation";
import {
  db,
  simActorLods,
  simBodyConditions,
  simBodyMeters,
  simEvents,
  simTriggers,
} from "@/server/db";
import { submitDurableInitializeActorBody } from "./body-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { readEffectiveActorLod, submitDurableAssignActorLod } from "./lod-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  expectRejected,
  forkAtHead,
  gmPrincipal,
  readBranchEvents,
  seedReferenceRhythms,
  seedSimpleBranch,
  simCommand,
  simulationSuiteHarness,
  type SimTestPrincipal,
} from "@/server/test-support";

/**
 * E6.1 durable actor-LOD ledger (engine.spec §27–§28): `assign_actor_lod` end
 * to end — defaults, assignment, idempotency, authorization, the §27.3
 * demotion guards against a live engagement, and fork-mid-ledger parity.
 * Runs on the shared `simulationSuiteHarness` scaffold (probe + legacy-player
 * guard + world teardown + pool close).
 */

const harness = await simulationSuiteHarness({ suite: "lod-store.int.test", table: "sim_actor_lods" });

const SEED_SECOND = 200_000;

interface LodCase {
  worldId: string;
  branchId: string;
  locationId: string;
  zoneId: string;
  ana: string;
  ben: string;
  cy: string;
}

async function seedCase(): Promise<LodCase> {
  const ana = newId();
  const ben = newId();
  const cy = newId();
  const seeded = await seedSimpleBranch({
    prefix: "e6-1-test",
    actors: [
      { id: ana, name: "Ana" },
      { id: ben, name: "Ben" },
      { id: cy, name: "Cy" },
    ],
    originStorySecond: SEED_SECOND,
    locationSlug: "cafe",
    locationKind: "cafe",
    zoneSlug: "cafe",
    zoneKind: "cafe",
  });
  harness.trackWorld(seeded.worldId);
  return {
    worldId: seeded.worldId,
    branchId: seeded.branchId,
    locationId: seeded.locationId,
    zoneId: seeded.zoneId,
    ana,
    ben,
    cy,
  };
}

function assignCmd(
  ids: LodCase,
  name: string,
  payload: { actorId: string; simulationLod: string; inferenceLod: string },
  principal: SimTestPrincipal = gmPrincipal,
) {
  return simCommand({ branchId: ids.branchId, name, type: "assign_actor_lod", payload, principal });
}

describe.runIf(harness.ready)("E6.1 durable actor-LOD ledger", () => {
  it("assigns, reads, defends idempotency and authorization, and forks with parity", async () => {
    const ids = await seedCase();

    // Unassigned actors read the registry defaults.
    const before = await readEffectiveActorLod(db(), ids.branchId, ids.ana);
    expect(before).toMatchObject({ simulationLod: "exact", inferenceLod: "deliberator", source: "default" });

    // Assigning the defaults verbatim is a structured no_op, not a row.
    const noop = await submitDurableAssignActorLod(
      assignCmd(ids, "noop", { actorId: ids.ana, simulationLod: "exact", inferenceLod: "deliberator" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(noop, "no_op", "assigning the registry defaults verbatim");

    // A non-privileged principal cannot touch the dial.
    const unauthorized = await submitDurableAssignActorLod(
      assignCmd(
        ids,
        "player",
        { actorId: ids.ana, simulationLod: "event", inferenceLod: "no_model" },
        { kind: "player", principalId: "player-1", controlledActorIds: [ids.ana] },
      ),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(unauthorized, "unauthorized_principal", "a player turning the LOD dial");

    const unknown = await submitDurableAssignActorLod(
      assignCmd(ids, "ghost", { actorId: newId(), simulationLod: "event", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(unknown, "actor_not_found", "assigning an actor that does not exist");

    // A real assignment lands the event, the row, and the read.
    const assigned = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-event", { actorId: ids.ana, simulationLod: "event", inferenceLod: "small_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(assigned, "assign Ana to event/small_model");
    const after = await readEffectiveActorLod(db(), ids.branchId, ids.ana);
    expect(after).toMatchObject({ simulationLod: "event", inferenceLod: "small_model", source: "assigned" });

    const [assignedEvent] = await readBranchEvents(ids.branchId, { types: ["actor_lod_assigned"] });
    expect(assignedEvent).toBeDefined();
    expect(assignedEvent?.payload).toMatchObject({
      actorId: ids.ana,
      simulationLod: "event",
      inferenceLod: "small_model",
      previousSimulationLod: "exact",
      previousInferenceLod: "deliberator",
      previousWasDefault: true,
    });

    // Idempotency: the same command replays its cached result, appends nothing.
    const replayed = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-event", { actorId: ids.ana, simulationLod: "event", inferenceLod: "small_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expect(replayed).toEqual(assigned);
    const lodEventCount = (await readBranchEvents(ids.branchId)).length;

    // A later promotion supersedes the row (one row per actor).
    const promoted = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-back", { actorId: ids.ana, simulationLod: "exact", inferenceLod: "deliberator" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(promoted, "promote Ana back to exact/deliberator");
    const rows = await db()
      .select()
      .from(simActorLods)
      .where(eq(simActorLods.branchId, ids.branchId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: ids.ana, simulationLod: "exact", inferenceLod: "deliberator" });
    expect(lodEventCount).toBeGreaterThan(0);

    // Fork at head: the child's ledger rows replay bit-identical from events.
    const { childBranchId, parentEvents } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "E6.1 fork parity",
    });
    const replayedProjection = replayActorLodHistory({
      seed: emptyActorLodsSeed(childBranchId, SEED_SECOND),
      events: parentEvents,
    });
    const childRows = await db()
      .select()
      .from(simActorLods)
      .where(eq(simActorLods.branchId, childBranchId))
      .orderBy(asc(simActorLods.actorId));
    expect(childRows).toHaveLength(replayedProjection.lods.length);
    for (const [index, state] of replayedProjection.lods.entries()) {
      expect(childRows[index]).toMatchObject({
        actorId: state.actorId,
        simulationLod: state.simulationLod,
        inferenceLod: state.inferenceLod,
        registryVersion: state.registryVersion,
        assignedAtStorySecond: state.assignedAtStorySecond,
      });
    }
    // The child's read matches the parent's for assigned and unassigned alike.
    expect(await readEffectiveActorLod(db(), childBranchId, ids.ana)).toEqual(
      await readEffectiveActorLod(db(), ids.branchId, ids.ana),
    );
    expect(await readEffectiveActorLod(db(), childBranchId, ids.cy)).toMatchObject({ source: "default" });
  });

  it("blocks a demotion behind a live engagement but never an inference-only change (§27.3)", async () => {
    const ids = await seedCase();

    const opened = await submitDurableOpenEngagement(
      simCommand({
        branchId: ids.branchId,
        name: "chat",
        type: "open_engagement",
        principal: { kind: "player", principalId: "player-1", controlledActorIds: [ids.ana] },
        payload: { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
      }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(opened, "open the Ana/Ben scene");

    // A participant cannot be demoted out from under a live scene.
    const blocked = await submitDurableAssignActorLod(
      assignCmd(ids, "ben-demote", { actorId: ids.ben, simulationLod: "dormant", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(blocked, "demotion_blocked_open_engagement", "demoting a live scene participant");

    // The inference axis stays a free dial for the same engaged actor.
    const inferenceOnly = await submitDurableAssignActorLod(
      assignCmd(ids, "ben-quiet", { actorId: ids.ben, simulationLod: "exact", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(inferenceOnly, "an inference-only change for an engaged actor");

    // A bystander outside the scene demotes freely.
    const bystander = await submitDurableAssignActorLod(
      assignCmd(ids, "cy-demote", { actorId: ids.cy, simulationLod: "dormant", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(bystander, "demote a bystander outside the scene");
  });

  it("dormant actors provably do no scheduled work, and waking re-arms life (E6.3)", async () => {
    const DAY = 86_400;
    const ids = await seedCase();

    async function trackBody(actorId: string, name: string): Promise<void> {
      // Sleep only — no wash window; the hygiene reset is not what this proves.
      await seedReferenceRhythms(ids.branchId, actorId, { wash: false });
      const initialized = await submitDurableInitializeActorBody(
        simCommand({
          branchId: ids.branchId,
          name: `init-${name}`,
          type: "initialize_actor_body",
          payload: { actorId, registryVersion: "body-v1", baselineOverrides: {} },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(initialized, `initialize ${name}'s body`);
    }
    async function pendingTriggersFor(branchId: string, actorId: string) {
      const rows = await db()
        .select({ kind: simTriggers.kind, uniquenessKey: simTriggers.uniquenessKey })
        .from(simTriggers)
        .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.state, "pending")));
      return rows.filter((row) => row.uniquenessKey.includes(actorId));
    }
    async function eventsNaming(actorId: string): Promise<number> {
      const rows = await db()
        .select({ count: sql<number>`count(*)::int` })
        .from(simEvents)
        .where(
          and(
            eq(simEvents.branchId, ids.branchId),
            sql`${simEvents.actorIds} @> ${JSON.stringify([actorId])}::jsonb`,
          ),
        );
      return rows[0]?.count ?? 0;
    }

    await trackBody(ids.ana, "ana");

    // Event LOD arms the routine boundary plus the re-solved body alarms.
    const toEvent = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-live", { actorId: ids.ana, simulationLod: "event", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(toEvent, "move Ana to event LOD");
    const live = await pendingTriggersFor(ids.branchId, ids.ana);
    expect(live.some((row) => row.kind === "routine_policy_due")).toBe(true);
    expect(live.some((row) => row.kind === "body_threshold_due")).toBe(true);

    // Demotion to dormant retires every alarm the actor owns.
    const toDormant = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-dormant", { actorId: ids.ana, simulationLod: "dormant", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(toDormant, "demote Ana to dormant");
    expect(await pendingTriggersFor(ids.branchId, ids.ana)).toHaveLength(0);

    // Three story-days pass — across two would-be bedtimes and both meters'
    // would-be threshold crossings — and the dormant actor writes NOTHING:
    // no events name them, no conditions appear, no meter row moves.
    const eventCountBefore = await eventsNaming(ids.ana);
    const metersBefore = await db()
      .select({ meterKey: simBodyMeters.meterKey, updatedSequence: simBodyMeters.updatedSequence })
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, ids.branchId), eq(simBodyMeters.actorId, ids.ana)))
      .orderBy(asc(simBodyMeters.meterKey));
    await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 3 * DAY, { workerId: "lod-dormant-1" });
    expect(await eventsNaming(ids.ana)).toBe(eventCountBefore);
    expect(await pendingTriggersFor(ids.branchId, ids.ana)).toHaveLength(0);
    const conditions = await db()
      .select()
      .from(simBodyConditions)
      .where(and(eq(simBodyConditions.branchId, ids.branchId), eq(simBodyConditions.actorId, ids.ana)));
    expect(conditions).toHaveLength(0);
    const metersAfter = await db()
      .select({ meterKey: simBodyMeters.meterKey, updatedSequence: simBodyMeters.updatedSequence })
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, ids.branchId), eq(simBodyMeters.actorId, ids.ana)))
      .orderBy(asc(simBodyMeters.meterKey));
    expect(metersAfter).toEqual(metersBefore);

    // A fork of the sleeping-nothing branch carries no phantom alarms.
    const { childBranchId } = await forkAtHead({
      parentBranchId: ids.branchId,
      reason: "E6.3 dormant fork parity",
    });
    expect(await pendingTriggersFor(childBranchId, ids.ana)).toHaveLength(0);

    // Waking by promotion re-arms the routine boundary, and life resumes:
    // the next bedtime puts the actor to sleep through ordinary law.
    const wake = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-wake", { actorId: ids.ana, simulationLod: "event", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(wake, "wake Ana back to event LOD");
    const rearmed = await pendingTriggersFor(ids.branchId, ids.ana);
    expect(rearmed.some((row) => row.kind === "routine_policy_due")).toBe(true);
    const nextBedtime = 5 * DAY + 1_380 * 60;
    await advanceBranchStoryTime(ids.branchId, nextBedtime + 1, { workerId: "lod-dormant-1" });
    const asleep = await db()
      .select()
      .from(simBodyConditions)
      .where(
        and(
          eq(simBodyConditions.branchId, ids.branchId),
          eq(simBodyConditions.actorId, ids.ana),
          eq(simBodyConditions.key, "asleep"),
        ),
      );
    expect(asleep.filter((row) => row.status === "active")).toHaveLength(1);

    // A sleeping actor cannot be tucked below event — the active condition
    // is a §27.3 near-boundary hazard, named in the rejection.
    const tuckedAway = await submitDurableAssignActorLod(
      assignCmd(ids, "ana-tuck", { actorId: ids.ana, simulationLod: "dormant", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(tuckedAway, "demotion_blocked_active_condition", "tucking a sleeping actor below event");

    // A body initialized for an already-dormant actor arms nothing at all.
    const cyDormant = await submitDurableAssignActorLod(
      assignCmd(ids, "cy-dormant", { actorId: ids.cy, simulationLod: "dormant", inferenceLod: "no_model" }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectAccepted(cyDormant, "demote Cy to dormant");
    await trackBody(ids.cy, "cy");
    expect(await pendingTriggersFor(ids.branchId, ids.cy)).toHaveLength(0);
  });
});
