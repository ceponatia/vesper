import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  materialBranchSeedSchema,
  type MaterialBranchSeed,
  type MaterialBranchSeedInput,
} from "@/contracts/simulation/materials";
import { itemTransferFeedConsumerKind } from "@/contracts/simulation/outbox";
import { newId } from "@/lib/ids";
import {
  db,
  simBodyConditions,
  simBranches,
  simEvents,
  simItemHoldings,
  simOutbox,
  simTriggers,
  simWorlds,
} from "@/server/db";
import { seedDurableBodyRhythms, submitDurableInitializeActorBody } from "./body-store";
import { forkBranch } from "./branch-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { seedDurableMaterialBranch } from "./material-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { seedDurableSpaceTopology } from "./space-store";
import { requireLegacyUnanchoredEngineTestMode } from "@/server/test-support";

/**
 * E6.2 durable routine controller (engine.spec §19.1–19.2, §27–28): entering
 * event LOD arms the routine alarm, the scheduler drain puts the actor to
 * sleep at bedtime through the ordinary body law, the expiry wakes them with
 * a sleep credit, the cycle re-arms itself indefinitely, engagements hold,
 * a meal boundary eats through the §26.6 consumption train (slice 2), and a
 * fork mid-cycle carries the alarms. Zero model calls anywhere.
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_actor_lods limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") {
      throw error;
    }
    process.stderr.write(
      `[routine-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
if (ready) requireLegacyUnanchoredEngineTestMode("routine-store.int.test");
const seededWorldIds: string[] = [];

afterAll(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
});

/** Day 2, 07:33 — mid-morning, hours before the 23:00 bedtime. */
const SEED_SECOND = 200_000;
const DAY = 86_400;
const LUNCH_DAY2 = 2 * DAY + 720 * 60; // 216 000
const BEDTIME_DAY2 = 2 * DAY + 1_380 * 60; // 255 600
const WAKE_DAY3 = 3 * DAY + 420 * 60; // 284 400
const BEDTIME_DAY3 = 3 * DAY + 1_380 * 60; // 342 000

const sleepRhythmRow = (actorId: string) =>
  ({ actorId, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 }) as const;

const lunchRhythmRow = (actorId: string) =>
  ({ actorId, kind: "meal", startMinuteOfDay: 720, endMinuteOfDay: 780 }) as const;

interface RoutineCase {
  worldId: string;
  branchId: string;
  locationId: string;
  zoneId: string;
  ana: string;
  ben: string;
}

function branchSeed(ids: RoutineCase, items: MaterialBranchSeedInput["items"]): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e6-2-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e6-2-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.ana, name: "Ana" },
      { id: ids.ben, name: "Ben" },
    ],
    items,
  });
}

async function seedCase(
  itemsFor: (ids: RoutineCase) => MaterialBranchSeedInput["items"] = () => [],
): Promise<RoutineCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: RoutineCase = {
    worldId,
    branchId,
    locationId: `${worldId}-loc-home`,
    zoneId: `${branchId}-zone-home`,
    ana: newId(),
    ben: newId(),
  };
  seededWorldIds.push(worldId);
  await seedDurableMaterialBranch(branchSeed(ids, itemsFor(ids)));
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: ids.locationId, worldId, kind: "home", defaultAccessPolicy: "public" }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "home", privacyPolicy: "public" }],
    links: [],
    loci: [
      { kind: "at", actorId: ids.ana, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
      { kind: "at", actorId: ids.ben, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
    ],
  });
  return ids;
}

const admit = { admitAtLockedVersion: true };
const gmPrincipal = { kind: "storyteller" as const, principalId: "gm-1", controlledActorIds: [] };

function command(ids: RoutineCase, name: string, type: string, payload: Record<string, unknown>, principal: object = gmPrincipal) {
  return {
    id: `cmd-${name}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `${name}-key-${ids.branchId}`,
    principal,
    submittedAtWallClock: "2026-07-20T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type,
    schemaVersion: 1,
    payload,
  };
}

async function trackBody(
  ids: RoutineCase,
  actorId: string,
  name: string,
  rows: readonly { actorId: string; kind: "sleep" | "wash" | "meal"; startMinuteOfDay: number; endMinuteOfDay: number }[] = [
    sleepRhythmRow(actorId),
  ],
): Promise<void> {
  await seedDurableBodyRhythms({
    branchId: ids.branchId,
    rows: [...rows],
  });
  const initialized = await submitDurableInitializeActorBody(
    command(ids, `init-${name}`, "initialize_actor_body", {
      actorId,
      registryVersion: "body-v1",
      baselineOverrides: {},
    }),
    admit,
  );
  expect(initialized.status).toBe("accepted");
}

async function pendingTriggers(branchId: string) {
  return db()
    .select({
      kind: simTriggers.kind,
      dueStorySecond: simTriggers.dueStorySecond,
      uniquenessKey: simTriggers.uniquenessKey,
    })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.state, "pending")))
    .orderBy(asc(simTriggers.dueStorySecond));
}

async function routineDecisions(branchId: string, actorId: string) {
  const rows = await db()
    .select({ type: simEvents.type, payload: simEvents.payload, sequence: simEvents.sequence })
    .from(simEvents)
    .where(and(eq(simEvents.branchId, branchId), eq(simEvents.type, "routine_policy_resolved")))
    .orderBy(asc(simEvents.sequence));
  return rows
    .map(
      (row) =>
        row.payload as {
          actorId: string;
          chosenCandidateId: string;
          candidates: unknown[];
          meal?: { itemId: string };
        },
    )
    .filter((payload) => payload.actorId === actorId);
}

describe.runIf(ready)("E6.2 durable routine controller", () => {
  it("arms on event LOD, sleeps at bedtime, wakes by expiry, and sustains the cycle across a fork", async () => {
    const ids = await seedCase();
    await trackBody(ids, ids.ana, "ana");

    const assigned = await submitDurableAssignActorLod(
      command(ids, "ana-event", "assign_actor_lod", {
        actorId: ids.ana,
        simulationLod: "event",
        inferenceLod: "no_model",
      }),
      admit,
    );
    expect(assigned.status).toBe("accepted");
    const armed = await pendingTriggers(ids.branchId);
    expect(armed.some((row) => row.kind === "routine_policy_due" && row.dueStorySecond === BEDTIME_DAY2)).toBe(
      true,
    );

    // Bedtime: the drain fires the alarm, policy chooses sleep, the ordinary
    // asleep train commits, and both the wake expiry and the next bedtime arm.
    await advanceBranchStoryTime(ids.branchId, BEDTIME_DAY2 + 1, { workerId: "routine-test-1" });
    const [decision] = await routineDecisions(ids.branchId, ids.ana);
    expect(decision).toMatchObject({ chosenCandidateId: "begin_sleep" });
    const asleepRows = await db()
      .select()
      .from(simBodyConditions)
      .where(
        and(
          eq(simBodyConditions.branchId, ids.branchId),
          eq(simBodyConditions.actorId, ids.ana),
          eq(simBodyConditions.key, "asleep"),
        ),
      );
    expect(asleepRows).toHaveLength(1);
    expect(asleepRows[0]).toMatchObject({ status: "active", expiresAt: WAKE_DAY3 });
    const midSleep = await pendingTriggers(ids.branchId);
    expect(midSleep.some((row) => row.kind === "body_condition_expiry_due" && row.dueStorySecond === WAKE_DAY3)).toBe(true);
    expect(midSleep.some((row) => row.kind === "routine_policy_due" && row.dueStorySecond === BEDTIME_DAY3)).toBe(true);

    // Wake: the expiry ends the condition through existing law (sleep credit).
    await advanceBranchStoryTime(ids.branchId, WAKE_DAY3 + 1, { workerId: "routine-test-1" });
    const creditRows = await db()
      .select({ type: simEvents.type, payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "body_source_applied")));
    expect(
      creditRows.some(
        (row) => (row.payload as { sourceKind?: string }).sourceKind === "sleep_credit",
      ),
    ).toBe(true);

    // Second bedtime: the cycle sustains itself with no new assignment.
    await advanceBranchStoryTime(ids.branchId, BEDTIME_DAY3 + 1, { workerId: "routine-test-1" });
    const decisions = await routineDecisions(ids.branchId, ids.ana);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({ chosenCandidateId: "begin_sleep" });

    // Fork mid-sleep: the child carries the active condition and both alarms.
    const [parentBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!parentBranchRow) throw new Error("parent branch row missing");
    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentBranchRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E6.2 routine fork parity",
    });
    const childTriggers = await pendingTriggers(childBranchId);
    expect(childTriggers.some((row) => row.kind === "routine_policy_due")).toBe(true);
    expect(childTriggers.some((row) => row.kind === "body_condition_expiry_due")).toBe(true);
    const childAsleep = await db()
      .select()
      .from(simBodyConditions)
      .where(
        and(
          eq(simBodyConditions.branchId, childBranchId),
          eq(simBodyConditions.actorId, ids.ana),
          eq(simBodyConditions.key, "asleep"),
        ),
      );
    expect(childAsleep.filter((row) => row.status === "active")).toHaveLength(1);
  });

  it("holds when the actor is in a live scene, capturing the legality gate", async () => {
    const ids = await seedCase();
    await trackBody(ids, ids.ben, "ben");
    const assigned = await submitDurableAssignActorLod(
      command(ids, "ben-event", "assign_actor_lod", {
        actorId: ids.ben,
        simulationLod: "event",
        inferenceLod: "no_model",
      }),
      admit,
    );
    expect(assigned.status).toBe("accepted");

    const opened = await submitDurableOpenEngagement(
      command(
        ids,
        "chat",
        "open_engagement",
        { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
        { kind: "player", principalId: "player-1", controlledActorIds: [ids.ana] },
      ),
      admit,
    );
    expect(opened.status).toBe("accepted");

    await advanceBranchStoryTime(ids.branchId, BEDTIME_DAY2 + 1, { workerId: "routine-test-2" });
    const [decision] = await routineDecisions(ids.branchId, ids.ben);
    expect(decision).toMatchObject({ chosenCandidateId: "hold" });
    expect(decision?.candidates).toContainEqual(
      expect.objectContaining({ id: "begin_sleep", legal: false, illegalReason: "in_engagement" }),
    );
    const asleepRows = await db()
      .select()
      .from(simBodyConditions)
      .where(and(eq(simBodyConditions.branchId, ids.branchId), eq(simBodyConditions.actorId, ids.ben)));
    expect(asleepRows).toHaveLength(0);
    // The hold re-armed the next bedtime — the routine self-heals a day later.
    const rearmed = await pendingTriggers(ids.branchId);
    expect(rearmed.some((row) => row.kind === "routine_policy_due" && row.dueStorySecond === BEDTIME_DAY3)).toBe(true);
  });

  it("eats at the meal boundary through the §26.6 train, then sleeps at bedtime", async () => {
    const loafId = newId();
    const ids = await seedCase((seededIds) => [
      {
        id: loafId,
        name: "a loaf of bread",
        materialKindKey: "bread",
        ownerActorId: null,
        consumptionEffects: [
          { meterKey: "energy", sourceKind: "meal", operation: { kind: "add", deltaFixedPoint: 1_500 } },
        ],
        locus: { kind: "held", actorId: seededIds.ana },
      },
    ]);
    await trackBody(ids, ids.ana, "ana", [sleepRhythmRow(ids.ana), lunchRhythmRow(ids.ana)]);

    const assigned = await submitDurableAssignActorLod(
      command(ids, "ana-event", "assign_actor_lod", {
        actorId: ids.ana,
        simulationLod: "event",
        inferenceLod: "no_model",
      }),
      admit,
    );
    expect(assigned.status).toBe("accepted");
    // The meal start is the earliest boundary after the mid-morning seed.
    const armed = await pendingTriggers(ids.branchId);
    expect(armed.some((row) => row.kind === "routine_policy_due" && row.dueStorySecond === LUNCH_DAY2)).toBe(true);

    // Lunch: the drain fires the alarm, policy chooses the meal, and the
    // §26.6 train commits — item gone, feed obligation, body effect — with
    // the whole chain causation-linked back to the decision.
    await advanceBranchStoryTime(ids.branchId, LUNCH_DAY2 + 1, { workerId: "routine-test-3" });
    const [decision] = await routineDecisions(ids.branchId, ids.ana);
    expect(decision).toMatchObject({ chosenCandidateId: "eat_meal", meal: { itemId: loafId } });

    const chainRows = await db()
      .select({
        id: simEvents.id,
        type: simEvents.type,
        causationId: simEvents.causationId,
        payload: simEvents.payload,
      })
      .from(simEvents)
      .where(
        and(
          eq(simEvents.branchId, ids.branchId),
          inArray(simEvents.type, ["routine_policy_resolved", "item_consumed", "body_source_applied"]),
        ),
      )
      .orderBy(asc(simEvents.sequence));
    const decisionRow = chainRows.find((row) => row.type === "routine_policy_resolved");
    const consumedRow = chainRows.find((row) => row.type === "item_consumed");
    const sourceRow = chainRows.find((row) => row.type === "body_source_applied");
    if (!decisionRow || !consumedRow || !sourceRow) throw new Error("meal event train incomplete");
    expect(consumedRow.causationId).toBe(decisionRow.id);
    expect(consumedRow.payload).toMatchObject({ itemId: loafId, againstOwnership: false });
    expect(sourceRow.causationId).toBe(consumedRow.id);
    expect(sourceRow.payload).toMatchObject({ meterKey: "energy", sourceKind: "meal" });

    const [holdingRow] = await db()
      .select({ locusKind: simItemHoldings.locusKind, goneBasis: simItemHoldings.goneBasis })
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, ids.branchId), eq(simItemHoldings.itemId, loafId)));
    expect(holdingRow).toMatchObject({ locusKind: "gone", goneBasis: "consumed" });
    const feedRows = await db()
      .select({ sourceEventId: simOutbox.sourceEventId })
      .from(simOutbox)
      .where(
        and(
          eq(simOutbox.branchId, ids.branchId),
          eq(simOutbox.sourceEventId, consumedRow.id),
          eq(simOutbox.consumerKind, itemTransferFeedConsumerKind),
        ),
      );
    expect(feedRows).toHaveLength(1);

    // The meal re-armed tonight's bedtime; the same cycle then sleeps —
    // both candidates live in one sustained loop.
    const rearmed = await pendingTriggers(ids.branchId);
    expect(rearmed.some((row) => row.kind === "routine_policy_due" && row.dueStorySecond === BEDTIME_DAY2)).toBe(
      true,
    );
    await advanceBranchStoryTime(ids.branchId, BEDTIME_DAY2 + 1, { workerId: "routine-test-3" });
    const decisions = await routineDecisions(ids.branchId, ids.ana);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({ chosenCandidateId: "begin_sleep" });

    // Fork mid-sleep: the child carries the consumed loaf and the live alarms.
    const [parentBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!parentBranchRow) throw new Error("parent branch row missing");
    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentBranchRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E6.2 meal fork parity",
    });
    const [childHolding] = await db()
      .select({ locusKind: simItemHoldings.locusKind, goneBasis: simItemHoldings.goneBasis })
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, childBranchId), eq(simItemHoldings.itemId, loafId)));
    expect(childHolding).toMatchObject({ locusKind: "gone", goneBasis: "consumed" });
    const childTriggers = await pendingTriggers(childBranchId);
    expect(childTriggers.some((row) => row.kind === "routine_policy_due")).toBe(true);
  });

  it("holds at a bare-pantry mealtime, capturing no_eligible_item", async () => {
    const someoneElsesLoafId = newId();
    // Ben CARRIES the loaf but Ana OWNS it — reachable, yet the routine's
    // §26.5 selection never eats against ownership.
    const ids = await seedCase((seededIds) => [
      {
        id: someoneElsesLoafId,
        name: "someone else's loaf",
        materialKindKey: "bread",
        ownerActorId: seededIds.ana,
        consumptionEffects: [
          { meterKey: "energy", sourceKind: "meal", operation: { kind: "add", deltaFixedPoint: 1_500 } },
        ],
        locus: { kind: "held", actorId: seededIds.ben },
      },
    ]);
    await trackBody(ids, ids.ben, "ben", [sleepRhythmRow(ids.ben), lunchRhythmRow(ids.ben)]);
    const assigned = await submitDurableAssignActorLod(
      command(ids, "ben-event", "assign_actor_lod", {
        actorId: ids.ben,
        simulationLod: "event",
        inferenceLod: "no_model",
      }),
      admit,
    );
    expect(assigned.status).toBe("accepted");

    await advanceBranchStoryTime(ids.branchId, LUNCH_DAY2 + 1, { workerId: "routine-test-4" });
    const [decision] = await routineDecisions(ids.branchId, ids.ben);
    expect(decision).toMatchObject({ chosenCandidateId: "hold" });
    expect(decision?.candidates).toContainEqual(
      expect.objectContaining({ id: "eat_meal", legal: false, illegalReason: "no_eligible_item" }),
    );
    // Nothing was eaten and the untouchable loaf still rests where it was.
    const consumedEvents = await db()
      .select({ id: simEvents.id })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "item_consumed")));
    expect(consumedEvents).toHaveLength(0);
    const [holdingRow] = await db()
      .select({ locusKind: simItemHoldings.locusKind })
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, ids.branchId), eq(simItemHoldings.itemId, someoneElsesLoafId)));
    expect(holdingRow).toMatchObject({ locusKind: "held" });
    // The skipped meal self-heals at the next boundary: tonight's bedtime.
    const rearmed = await pendingTriggers(ids.branchId);
    expect(rearmed.some((row) => row.kind === "routine_policy_due" && row.dueStorySecond === BEDTIME_DAY2)).toBe(
      true,
    );
  });
});
