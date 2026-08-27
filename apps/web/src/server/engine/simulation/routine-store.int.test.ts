import { and, asc, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { MaterialBranchSeedInput } from "@vesper/simulation-core/contracts/materials";
import { itemTransferFeedConsumerKind } from "@vesper/simulation-core/contracts/outbox";
import { newId } from "@/lib/ids";
import {
  db,
  simBodyConditions,
  simEvents,
  simItemHoldings,
  simOutbox,
  simTriggers,
} from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  forkAtHead,
  playerPrincipal,
  seedReferenceRhythms,
  seedSimpleBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";
import { submitDurableInitializeActorBody } from "./body-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { advanceBranchStoryTime } from "./scheduler-store";

/**
 * E6.2 durable routine controller: entering
 * event LOD arms the routine alarm, the scheduler drain puts the actor to
 * sleep at bedtime through the ordinary body law, the expiry wakes them with
 * a sleep credit, the cycle re-arms itself indefinitely, engagements hold,
 * a meal boundary eats through the §26.6 consumption train (slice 2), and a
 * fork mid-cycle carries the alarms. Zero model calls anywhere. Probe,
 * legacy-player opt-in, seeded-world teardown and pool close come from the
 * shared `simulationSuiteHarness`; the 23:00–07:00 sleep and 12:00–13:00 meal
 * windows come from `seedReferenceRhythms`, which is where the minute
 * boundaries the constants below are derived from now live.
 */

const harness = await simulationSuiteHarness({
  suite: "routine-store.int.test",
  table: "sim_actor_lods",
});
const ready = harness.ready;

/** Day 2, 07:33 — mid-morning, hours before the 23:00 bedtime. */
const SEED_SECOND = 200_000;
const DAY = 86_400;
const LUNCH_DAY2 = 2 * DAY + 720 * 60; // 216 000
const BEDTIME_DAY2 = 2 * DAY + 1_380 * 60; // 255 600
const WAKE_DAY3 = 3 * DAY + 420 * 60; // 284 400
const BEDTIME_DAY3 = 3 * DAY + 1_380 * 60; // 342 000

interface RoutineCase {
  worldId: string;
  branchId: string;
  locationId: string;
  zoneId: string;
  ana: string;
  ben: string;
}

async function seedCase(
  itemsFor: (ids: { ana: string; ben: string }) => MaterialBranchSeedInput["items"] = () => [],
): Promise<RoutineCase> {
  const actors = { ana: newId(), ben: newId() };
  const seeded = await seedSimpleBranch({
    prefix: "e6-2-test",
    actors: [
      { id: actors.ana, name: "Ana" },
      { id: actors.ben, name: "Ben" },
    ],
    originStorySecond: SEED_SECOND,
    items: itemsFor(actors),
    zoneKind: "home",
  });
  harness.trackWorld(seeded.worldId);
  return { ...seeded, ...actors };
}

const admit = ADMIT_AT_LOCKED_VERSION;

function command(ids: RoutineCase, name: string, type: string, payload: Record<string, unknown>, principal?: Parameters<typeof simCommand>[0]["principal"]) {
  return simCommand({
    branchId: ids.branchId,
    name,
    type,
    payload,
    ...(principal === undefined ? {} : { principal }),
  });
}

/**
 * Seed one actor's reference rhythms (sleep, plus lunch when asked) and give
 * them a body. Rhythms land FIRST: alarms armed before a rhythm seed re-validate
 * at fire time and may retire stale.
 */
async function trackBody(
  ids: RoutineCase,
  actorId: string,
  name: string,
  options: { meal?: boolean } = {},
): Promise<void> {
  await seedReferenceRhythms(ids.branchId, actorId, {
    wash: false,
    ...(options.meal === undefined ? {} : { meal: options.meal }),
  });
  const initialized = await submitDurableInitializeActorBody(
    command(ids, `init-${name}`, "initialize_actor_body", {
      actorId,
      registryVersion: "body-v1",
      baselineOverrides: {},
    }),
    admit,
  );
  expectAccepted(initialized, `initializing ${name}'s body`);
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
    expectAccepted(assigned, "putting Ana at event LOD");
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
    const { childBranchId } = await forkAtHead({
      parentBranchId: ids.branchId,
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
    expectAccepted(assigned, "putting Ben at event LOD");

    const opened = await submitDurableOpenEngagement(
      command(
        ids,
        "chat",
        "open_engagement",
        { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
        playerPrincipal(ids.ana),
      ),
      admit,
    );
    expectAccepted(opened, "opening the scene that must hold Ben past bedtime");

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
    await trackBody(ids, ids.ana, "ana", { meal: true });

    const assigned = await submitDurableAssignActorLod(
      command(ids, "ana-event", "assign_actor_lod", {
        actorId: ids.ana,
        simulationLod: "event",
        inferenceLod: "no_model",
      }),
      admit,
    );
    expectAccepted(assigned, "putting Ana at event LOD for the meal cycle");
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
    const { childBranchId } = await forkAtHead({
      parentBranchId: ids.branchId,
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
    await trackBody(ids, ids.ben, "ben", { meal: true });
    const assigned = await submitDurableAssignActorLod(
      command(ids, "ben-event", "assign_actor_lod", {
        actorId: ids.ben,
        simulationLod: "event",
        inferenceLod: "no_model",
      }),
      admit,
    );
    expectAccepted(assigned, "putting Ben at event LOD for the bare-pantry mealtime");

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
