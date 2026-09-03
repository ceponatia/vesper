import { and, asc, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bodyMeterRegistryV1 } from "@vesper/simulation-core/contracts/bodies";
import { newId } from "@/lib/ids";
import {
  db,
  simActivities,
  simBodyConditions,
  simBodyMeters,
  simBodyModifiers,
  simBodyRhythms,
  simEvents,
  simTriggers,
} from "@/server/db";
import { computeEngagementBodilyReads, readDurableBodyReads } from "./body-reads";
import {
  readDurableBodies,
  submitDurableApplyBodyCondition,
  submitDurableApplyBodySource,
  submitDurableInitializeActorBody,
} from "./body-store";
import {
  seedDurableActionDefinitions,
  submitDurableCompleteActivity,
  submitDurableResumeActivity,
  submitDurableStartActivity,
} from "./activity-store";
import { forkBranch } from "./branch-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  expectRejected,
  gmPrincipal,
  playerPrincipal,
  seedReferenceRhythms,
  seedSimpleBranch,
  simCommand,
  simulationSuiteHarness,
  systemPrincipal,
} from "@/server/test-support";

/**
 * E5.1 durable body substrate: registry meters, crossing-aware alarms, the
 * sleep/collapse arc, the engagement surface read, and fork parity. Runs on the
 * shared `simulationSuiteHarness` scaffold (probe + legacy-player guard + world
 * teardown + pool close).
 */

const harness = await simulationSuiteHarness({ suite: "body-store.int.test", table: "sim_body_meters" });

/** The cut's body surface, read the way the arbiter reads it: inside one snapshot. */
function bodilyReadsAt(input: Parameters<typeof computeEngagementBodilyReads>[1]) {
  return db().transaction((tx) => computeEngagementBodilyReads(tx, input), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

const SEED_SECOND = 50_000;
// Registry v1: hygiene 9 000 → 2 500 at 150/h = 156 000s after seeding.
const HYGIENE_CROSSING = SEED_SECOND + 156_000;

interface BodyCase {
  worldId: string;
  branchId: string;
  actorId: string;
  witnessId: string;
  zoneId: string;
}

async function seedBodyCase(): Promise<BodyCase> {
  const actorId = newId();
  const witnessId = newId();
  const seeded = await seedSimpleBranch({
    prefix: "e5-1-test",
    actors: [
      { id: actorId, name: "Mara" },
      { id: witnessId, name: "Iris" },
    ],
    originStorySecond: SEED_SECOND,
    zoneSlug: "room",
    privacyPolicy: "private",
  });
  harness.trackWorld(seeded.worldId);
  return {
    worldId: seeded.worldId,
    branchId: seeded.branchId,
    actorId,
    witnessId,
    zoneId: seeded.zoneId,
  };
}

/** 7am wake / 11pm bed plus a wash ending 7am — the reference daily life. */
async function seedRhythms(ids: BodyCase): Promise<void> {
  await seedReferenceRhythms(ids.branchId, ids.actorId);
}

function initializeCommand(ids: BodyCase) {
  return simCommand({
    branchId: ids.branchId,
    name: "init",
    type: "initialize_actor_body",
    principal: gmPrincipal,
    payload: { actorId: ids.actorId, registryVersion: "body-v1", baselineOverrides: {} },
  });
}

async function pendingBodyTriggers(branchId: string) {
  return db()
    .select({
      kind: simTriggers.kind,
      state: simTriggers.state,
      uniquenessKey: simTriggers.uniquenessKey,
      dueStorySecond: simTriggers.dueStorySecond,
    })
    .from(simTriggers)
    .where(
      and(
        eq(simTriggers.branchId, branchId),
        inArray(simTriggers.kind, ["body_threshold_due", "body_condition_expiry_due", "body_collapse_due"]),
      ),
    )
    .orderBy(asc(simTriggers.dueStorySecond));
}

describe.runIf(harness.ready)("E5.1 durable body substrate", () => {
  it("seeds the registry meters and arms the initial threshold alarms", async () => {
    const ids = await seedBodyCase();
    const result = await submitDurableInitializeActorBody(initializeCommand(ids));
    expectAccepted(result, "initialize the actor's body");

    const bodies = await readDurableBodies(ids.branchId);
    expect(bodies.meters.map((meter) => meter.meterKey)).toEqual(
      bodyMeterRegistryV1.map((definition) => definition.key).sort(),
    );
    expect(bodies.meters.every((meter) => meter.lastIntegratedAtStorySecond === SEED_SECOND)).toBe(true);

    const triggers = await pendingBodyTriggers(ids.branchId);
    // energy "depleted" and hygiene "grimy" arm; arousal has no thresholds.
    expect(triggers.filter((trigger) => trigger.state === "pending")).toHaveLength(2);
    expect(triggers.find((trigger) => trigger.dueStorySecond === HYGIENE_CROSSING)).toBeDefined();
  });

  it("retires and re-arms a meter's alarm when a source moves the trajectory", async () => {
    const ids = await seedBodyCase();
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const wash = await submitDurableApplyBodySource(
      simCommand({
        branchId: ids.branchId,
        name: "wash",
        type: "apply_body_source",
        expectedVersion: 1,
        principal: playerPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          meterKey: "hygiene",
          sourceKind: "wash",
          operation: { kind: "set", valueFixedPoint: 9_500 },
        },
      }),
    );
    expectAccepted(wash, "wash the actor back to 9 500 hygiene");

    const bodies = await readDurableBodies(ids.branchId);
    expect(bodies.meters.find((meter) => meter.meterKey === "hygiene")?.valueFixedPoint).toBe(9_500);

    const triggers = await pendingBodyTriggers(ids.branchId);
    const hygieneAlarms = triggers.filter((trigger) => trigger.uniquenessKey.includes("grimy"));
    // The seed-time alarm completed under the wash command; one fresh alarm
    // pends at the recomputed crossing (9 500 → 2 500 at 150/h = 168 000s).
    expect(hygieneAlarms.map((trigger) => trigger.state).sort()).toEqual(["completed", "pending"]);
    expect(hygieneAlarms.find((trigger) => trigger.state === "pending")?.dueStorySecond).toBe(
      SEED_SECOND + 168_000,
    );
  });

  it("fires a due threshold through the drain and captures co-located witnesses", async () => {
    const ids = await seedBodyCase();
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const outcome = await advanceBranchStoryTime(ids.branchId, HYGIENE_CROSSING, { workerId: "w-grimy" });
    expect(outcome.status).toBe("advanced");

    const bodies = await readDurableBodies(ids.branchId);
    const hygiene = bodies.meters.find((meter) => meter.meterKey === "hygiene");
    expect(hygiene?.valueFixedPoint).toBe(2_500);
    expect(hygiene?.lastIntegratedAtStorySecond).toBe(HYGIENE_CROSSING);

    const [crossed] = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "body_threshold_crossed")));
    // hygiene "grimy" is a quiet crossing: subject-only, no witness capture.
    expect(crossed?.payload).toMatchObject({
      meterKey: "hygiene",
      thresholdKey: "grimy",
      valueAtCrossingFixedPoint: 2_500,
      observerActorIds: [],
    });

    // Drain on to the energy "depleted" crossing — noticeable, so the
    // co-located witness lands in the capture set.
    const [energyAlarm] = (await pendingBodyTriggers(ids.branchId)).filter(
      (trigger) => trigger.state === "pending" && trigger.uniquenessKey.includes("depleted"),
    );
    expect(energyAlarm).toBeDefined();
    if (!energyAlarm) throw new Error("energy alarm missing");
    const outcome2 = await advanceBranchStoryTime(ids.branchId, energyAlarm.dueStorySecond, {
      workerId: "w-depleted",
    });
    expect(outcome2.status).toBe("advanced");
    const crossings = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "body_threshold_crossed")));
    const depleted = crossings.find(
      (row) => (row.payload as { thresholdKey?: string }).thresholdKey === "depleted",
    );
    expect(depleted?.payload).toMatchObject({
      meterKey: "energy",
      observerActorIds: [ids.witnessId],
    });
  });

  it("expires a condition through the drain, closing its modifiers and re-arming", async () => {
    const ids = await seedBodyCase();
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const nap = await submitDurableApplyBodyCondition(
      simCommand({
        branchId: ids.branchId,
        name: "nap",
        type: "apply_body_condition",
        expectedVersion: 1,
        principal: playerPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          conditionKey: "asleep",
          durationSeconds: 5_400,
          modifiers: [{ meterKey: "energy", operation: { kind: "suspend" }, stackingGroup: "sleep" }],
          observerActorIds: [],
        },
      }),
    );
    expectAccepted(nap, "apply the asleep condition with an explicit suspend");

    const before = await readDurableBodies(ids.branchId);
    expect(before.conditions[0]).toMatchObject({ key: "asleep", status: "active" });
    expect(before.modifiers[0]?.validUntilStorySecond).toBe(SEED_SECOND + 5_400);

    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 5_400, { workerId: "w-wake" });
    expect(outcome.status).toBe("advanced");

    const after = await readDurableBodies(ids.branchId);
    expect(after.conditions[0]).toMatchObject({ key: "asleep", status: "ended", endBasis: "expired" });
    // Suspension shifted the energy crossing out by exactly the nap.
    const alarms = await pendingBodyTriggers(ids.branchId);
    const energyAlarm = alarms.find(
      (trigger) => trigger.state === "pending" && trigger.uniquenessKey.includes("depleted"),
    );
    expect(energyAlarm).toBeDefined();
    const expiry = alarms.find((trigger) => trigger.kind === "body_condition_expiry_due");
    expect(expiry?.state).toBe("completed");
  });

  it("arms crossing-aware alarms: a daily wash suppresses the grimy alarm outright", async () => {
    const ids = await seedBodyCase();
    await seedRhythms(ids);
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const triggers = await pendingBodyTriggers(ids.branchId);
    const pending = triggers.filter((trigger) => trigger.state === "pending");
    // Only energy's depleted alarm arms — hygiene never reaches 2 500 while
    // the 7am wash resets it every story day (the rhythm folds into the solver).
    expect(pending).toHaveLength(1);
    expect(pending[0]?.uniquenessKey).toContain("depleted");
  });

  it("auto-suspends energy while asleep and credits the wake through the drain", async () => {
    const ids = await seedBodyCase();
    await seedRhythms(ids);
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const nap = await submitDurableApplyBodyCondition(
      simCommand({
        branchId: ids.branchId,
        name: "nap",
        type: "apply_body_condition",
        expectedVersion: 1,
        principal: playerPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          conditionKey: "asleep",
          durationSeconds: 5_400,
          // No modifiers supplied: the sleep coupling attaches the suspend.
          modifiers: [],
          observerActorIds: [],
        },
      }),
    );
    expectAccepted(nap, "apply the asleep condition without explicit modifiers");
    const before = await readDurableBodies(ids.branchId);
    expect(before.modifiers[0]).toMatchObject({
      meterKey: "energy",
      operation: { kind: "suspend" },
      stackingGroup: "sleep",
    });

    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 5_400, { workerId: "w-wake2" });
    expect(outcome.status).toBe("advanced");

    const after = await readDurableBodies(ids.branchId);
    // Suspended at 9 000 through the nap, then credited min(1 350, cap headroom
    // 500) at the wake — the causal record is a real sleep_credit source event.
    expect(after.meters.find((meter) => meter.meterKey === "energy")?.valueFixedPoint).toBe(9_500);
    expect(after.conditions[0]).toMatchObject({
      status: "ended",
      endBasis: "expired",
      endedAtStorySecond: SEED_SECOND + 5_400,
    });
    const [credit] = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "body_source_applied")));
    expect(credit?.payload).toMatchObject({
      meterKey: "energy",
      sourceKind: "sleep_credit",
      operation: { kind: "add", deltaFixedPoint: 500 },
      valueAfterFixedPoint: 9_500,
    });

    // The layer-3 read: freshly woken mid-afternoon reads bright, and the
    // raw meters never appear in the surface.
    const reads = await readDurableBodyReads(ids.branchId);
    const energy = reads.energy.find((row) => row.actorId === ids.actorId);
    expect(energy?.read.band).toBe("bright");
    expect(energy?.read.signedFixedPoint).toBeGreaterThan(7_500);
    expect(energy?.pressureFixedPoint).toBeGreaterThan(0);
  });

  it("couples climax to afterglow and surfaces perceivable signs in the engagement read", async () => {
    const ids = await seedBodyCase();
    await seedRhythms(ids);
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const arouse = await submitDurableApplyBodySource(
      simCommand({
        branchId: ids.branchId,
        name: "arouse",
        type: "apply_body_source",
        expectedVersion: 1,
        principal: playerPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          meterKey: "arousal",
          sourceKind: "adjustment",
          operation: { kind: "add", deltaFixedPoint: 7_000 },
        },
      }),
    );
    expectAccepted(arouse, "raise arousal by 7 000");

    // The witness sees graded surface signs at engaged attention — never a meter.
    const before = await bodilyReadsAt({
      branchId: ids.branchId,
      storySecond: SEED_SECOND,
      viewpointActorId: ids.witnessId,
      coPresentActorIds: [ids.actorId],
    });
    expect(before.self).toBeUndefined();
    expect(before.observed).toEqual([
      { actorId: ids.actorId, signs: ["flushed_skin", "quickened_breath"] },
    ]);

    const climax = await submitDurableApplyBodySource(
      simCommand({
        branchId: ids.branchId,
        name: "climax",
        type: "apply_body_source",
        expectedVersion: 2,
        principal: playerPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          meterKey: "arousal",
          sourceKind: "climax",
          operation: { kind: "reset_to_baseline" },
        },
      }),
    );
    expectAccepted(climax, "reset arousal to baseline through climax");

    const bodies = await readDurableBodies(ids.branchId);
    expect(bodies.meters.find((meter) => meter.meterKey === "arousal")?.valueFixedPoint).toBe(0);
    expect(bodies.conditions[0]).toMatchObject({
      key: "afterglow",
      status: "active",
      expiresAtStorySecond: SEED_SECOND + 1_800,
    });
    const expiry = (await pendingBodyTriggers(ids.branchId)).find(
      (trigger) => trigger.kind === "body_condition_expiry_due" && trigger.state === "pending",
    );
    expect(expiry?.dueStorySecond).toBe(SEED_SECOND + 1_800);

    const after = await bodilyReadsAt({
      branchId: ids.branchId,
      storySecond: SEED_SECOND,
      viewpointActorId: ids.witnessId,
      coPresentActorIds: [ids.actorId],
    });
    expect(after.observed).toEqual([{ actorId: ids.actorId, signs: ["afterglow_softness"] }]);

    // The subject's own surface: settled pulse, bright afternoon energy.
    const selfView = await bodilyReadsAt({
      branchId: ids.branchId,
      storySecond: SEED_SECOND,
      viewpointActorId: ids.actorId,
      coPresentActorIds: [ids.witnessId],
    });
    expect(selfView.self?.intimacyPhase).toBe("afterglow");
    expect(selfView.self?.energyBand).toBe("bright");
  });

  it("runs the collapse arc: wake arms it, the drain fires it, interruption, and resume", async () => {
    const ids = await seedBodyCase();
    await seedRhythms(ids);
    await seedDurableActionDefinitions({
      branchId: ids.branchId,
      definitions: [
        {
          id: `${ids.branchId}-action-vigil`,
          version: 1,
          controllerKinds: ["player"],
          duration: { kind: "fixed", seconds: 200_000 },
          preconditions: [{ kind: "at_zone_kind", zoneKind: "room" }],
          requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
          interruptibility: "pausable",
          noticeability: "obvious",
        },
      ],
    });
    await submitDurableInitializeActorBody(initializeCommand(ids));

    // A short nap creates REAL sleep history — the wake is what arms the
    // collapse alarm (assumed-rhythm actors never escalate, never collapse).
    await submitDurableApplyBodyCondition(
      simCommand({
        branchId: ids.branchId,
        name: "nap",
        type: "apply_body_condition",
        expectedVersion: 1,
        principal: playerPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          conditionKey: "asleep",
          durationSeconds: 5_400,
          modifiers: [],
          observerActorIds: [],
        },
      }),
    );
    const wakeAt = SEED_SECOND + 5_400;
    await advanceBranchStoryTime(ids.branchId, wakeAt, { workerId: "w-arc-wake" });
    const collapseAlarm = (await pendingBodyTriggers(ids.branchId)).find(
      (trigger) => trigger.kind === "body_collapse_due" && trigger.state === "pending",
    );
    expect(collapseAlarm).toBeDefined();
    if (!collapseAlarm) throw new Error("collapse alarm missing");
    expect(collapseAlarm.dueStorySecond).toBeGreaterThan(wakeAt + 24 * 3_600);
    expect(collapseAlarm.dueStorySecond).toBeLessThan(wakeAt + 48 * 3_600);

    // She starts an open-ended vigil and never goes to bed.
    const start = await submitDurableStartActivity(
      simCommand({
        branchId: ids.branchId,
        name: "vigil",
        type: "start_activity",
        expectedVersion: 3,
        principal: playerPrincipal(ids.actorId),
        payload: { actionDefinitionId: `${ids.branchId}-action-vigil`, actorId: ids.actorId },
      }),
    );
    expectAccepted(start, "start the open-ended vigil");

    // The drain reaches the alarm: the body gives out mid-vigil.
    const outcome = await advanceBranchStoryTime(ids.branchId, collapseAlarm.dueStorySecond, {
      workerId: "w-arc-collapse",
    });
    expect(outcome.status).toBe("advanced");
    const [collapsedRow] = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "body_collapsed")));
    expect(collapsedRow?.payload).toMatchObject({ observerActorIds: [ids.witnessId] });

    const afterCollapse = await readDurableBodies(ids.branchId);
    const forcedSleep = afterCollapse.conditions.find(
      (condition) => condition.status === "active" && condition.key === "asleep",
    );
    expect(forcedSleep?.expiresAtStorySecond).toBe(collapseAlarm.dueStorySecond + 28_800);

    const [activityRow] = await db()
      .select()
      .from(simActivities)
      .where(eq(simActivities.branchId, ids.branchId));
    expect(activityRow?.phase).toBe("interrupted");
    expect(activityRow?.progressFixedPoint).toBeGreaterThan(0);
    expect(activityRow?.progressFixedPoint).toBeLessThan(1_000_000);
    const completionAlarms = await db()
      .select({ state: simTriggers.state })
      .from(simTriggers)
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.kind, "activity_completion_due")));
    expect(completionAlarms.every((alarm) => alarm.state === "completed")).toBe(true);

    // Sleep runs its course; the wake re-arms the next collapse far out.
    const wake2 = collapseAlarm.dueStorySecond + 28_800;
    await advanceBranchStoryTime(ids.branchId, wake2, { workerId: "w-arc-wake2" });
    const rearmed = (await pendingBodyTriggers(ids.branchId)).find(
      (trigger) => trigger.kind === "body_collapse_due" && trigger.state === "pending",
    );
    expect(rearmed?.dueStorySecond).toBeGreaterThan(wake2 + 24 * 3_600);

    // The E3.4 note lands: resume re-arms completion under a versioned key
    // and the activity finishes through the ordinary drain.
    const resume = await submitDurableResumeActivity(
      simCommand({
        branchId: ids.branchId,
        name: "resume",
        type: "resume_activity",
        expectedVersion: 6,
        principal: playerPrincipal(ids.actorId),
        payload: { activityInstanceId: activityRow?.activityInstanceId ?? "" },
      }),
    );
    expectAccepted(resume, "resume the interrupted vigil");
    const [resumedRow] = await db()
      .select()
      .from(simActivities)
      .where(eq(simActivities.branchId, ids.branchId));
    expect(resumedRow?.phase).toBe("active");
    expect(resumedRow?.expectedCompleteAt).toBeGreaterThan(wake2);
    if (!resumedRow?.expectedCompleteAt) throw new Error("resumed activity missing due");
    const final = await advanceBranchStoryTime(ids.branchId, resumedRow.expectedCompleteAt, {
      workerId: "w-arc-complete",
    });
    expect(final.status).toBe("advanced");
    const [completedRow] = await db()
      .select({ phase: simActivities.phase })
      .from(simActivities)
      .where(eq(simActivities.branchId, ids.branchId));
    expect(completedRow?.phase).toBe("completed");
  });

  it("retires a vigil's completion alarm a scheduler worker has already CLAIMED (processing, not pending) when the collapse interrupt lands in the claim/dispatch gap, so the stale dispatch fails closed instead of re-completing under the pre-interruption schedule", async () => {
    // Reproduces the E5.4 restock race one level up the trigger taxonomy:
    // `claimDueTrigger` (scheduler-store.ts) commits a SEPARATE, earlier
    // transaction that flips a due trigger to `processing` before `dispatch()`
    // opens the transaction that actually resolves it. A `resolve_body_collapse`
    // landing in that gap for an activity's completion alarm must still retire
    // the claimed row — this test manually reproduces the claim (a direct row
    // update, mirroring household-store.int.test.ts's idiom) and asserts the
    // collapse interrupt retires it too, that a subsequent resume leaves
    // exactly one live completion alarm, and that dispatching the stale claim
    // afterward rejects `completion_not_due` rather than completing the
    // activity under the superseded (pre-interruption) schedule.
    const ids = await seedBodyCase();
    await seedRhythms(ids);
    await seedDurableActionDefinitions({
      branchId: ids.branchId,
      definitions: [
        {
          id: `${ids.branchId}-action-vigil-race`,
          version: 1,
          controllerKinds: ["player"],
          duration: { kind: "fixed", seconds: 200_000 },
          preconditions: [{ kind: "at_zone_kind", zoneKind: "room" }],
          requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
          interruptibility: "pausable",
          noticeability: "obvious",
        },
      ],
    });
    await submitDurableInitializeActorBody(initializeCommand(ids));

    // A short nap creates REAL sleep history — the wake is what arms the
    // collapse alarm.
    await submitDurableApplyBodyCondition(
      simCommand({
        branchId: ids.branchId,
        name: "race-nap",
        type: "apply_body_condition",
        expectedVersion: 1,
        principal: playerPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          conditionKey: "asleep",
          durationSeconds: 5_400,
          modifiers: [],
          observerActorIds: [],
        },
      }),
    );
    const wakeAt = SEED_SECOND + 5_400;
    await advanceBranchStoryTime(ids.branchId, wakeAt, { workerId: "w-race-wake" });
    const collapseAlarm = (await pendingBodyTriggers(ids.branchId)).find(
      (trigger) => trigger.kind === "body_collapse_due" && trigger.state === "pending",
    );
    if (!collapseAlarm) throw new Error("collapse alarm missing");

    // She starts an open-ended vigil and never goes to bed.
    const start = await submitDurableStartActivity(
      simCommand({
        branchId: ids.branchId,
        name: "vigil-race",
        type: "start_activity",
        expectedVersion: 3,
        principal: playerPrincipal(ids.actorId),
        payload: { actionDefinitionId: `${ids.branchId}-action-vigil-race`, actorId: ids.actorId },
      }),
    );
    expectAccepted(start, "start the vigil the race interrupts");

    const [vigilRow] = await db().select().from(simActivities).where(eq(simActivities.branchId, ids.branchId));
    if (!vigilRow) throw new Error("vigil activity missing");

    // Simulate a scheduler worker's `claimDueTrigger` having already claimed
    // the vigil's own completion alarm into `processing` — committed in its
    // own transaction, strictly before the collapse interrupt (and its later
    // dispatch) below.
    await db()
      .update(simTriggers)
      .set({ state: "processing", leaseOwner: "w-claimed", leaseExpiresAt: new Date(Date.now() + 30_000) })
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.kind, "activity_completion_due")));

    // The collapse interrupt lands in the claim/dispatch gap.
    const outcome = await advanceBranchStoryTime(ids.branchId, collapseAlarm.dueStorySecond, {
      workerId: "w-race-collapse",
    });
    expect(outcome.status).toBe("advanced");

    const [interruptedRow] = await db()
      .select()
      .from(simActivities)
      .where(eq(simActivities.branchId, ids.branchId));
    expect(interruptedRow?.phase).toBe("interrupted");

    // The claimed (processing) completion alarm is retired too, not just
    // pending rows.
    const completionAlarmsAfterCollapse = await db()
      .select({ state: simTriggers.state })
      .from(simTriggers)
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.kind, "activity_completion_due")));
    expect(completionAlarmsAfterCollapse.every((alarm) => alarm.state === "completed")).toBe(true);

    // Sleep runs its course; resume re-arms completion under a fresh,
    // attempt-versioned key with a LATER due second.
    const wake2 = collapseAlarm.dueStorySecond + 28_800;
    await advanceBranchStoryTime(ids.branchId, wake2, { workerId: "w-race-wake2" });
    const resume = await submitDurableResumeActivity(
      simCommand({
        branchId: ids.branchId,
        name: "resume-race",
        type: "resume_activity",
        expectedVersion: 6,
        principal: playerPrincipal(ids.actorId),
        payload: { activityInstanceId: vigilRow.activityInstanceId },
      }),
    );
    expectAccepted(resume, "resume the vigil after the raced collapse");

    // Exactly one live completion alarm remains — the fresh resumed arm —
    // never two.
    const completionAlarmsAfterResume = await db()
      .select({ state: simTriggers.state })
      .from(simTriggers)
      .where(and(eq(simTriggers.branchId, ids.branchId), eq(simTriggers.kind, "activity_completion_due")));
    expect(completionAlarmsAfterResume.filter((alarm) => alarm.state === "pending")).toHaveLength(1);

    // `dispatch()` now opens its transaction for the stale claim: it fails
    // closed to `completion_not_due` instead of completing the activity under
    // the superseded (pre-interruption) schedule.
    const staleDispatch = await submitDurableCompleteActivity(
      simCommand({
        branchId: ids.branchId,
        name: "stale-complete",
        type: "complete_activity",
        principal: systemPrincipal,
        payload: { activityInstanceId: vigilRow.activityInstanceId },
      }),
      ADMIT_AT_LOCKED_VERSION,
    );
    expectRejected(staleDispatch, "completion_not_due", "the stale claim's dispatch after the interrupt");

    // No double completion: the activity finishes exactly once, through the
    // ordinary drain to its NEW resumed due second.
    const [resumedRow] = await db()
      .select()
      .from(simActivities)
      .where(eq(simActivities.branchId, ids.branchId));
    if (!resumedRow?.expectedCompleteAt) throw new Error("resumed activity missing due");
    const final = await advanceBranchStoryTime(ids.branchId, resumedRow.expectedCompleteAt, {
      workerId: "w-race-complete",
    });
    expect(final.status).toBe("advanced");
    const [completedRow] = await db()
      .select({ phase: simActivities.phase })
      .from(simActivities)
      .where(eq(simActivities.branchId, ids.branchId));
    expect(completedRow?.phase).toBe("completed");

    const completedEvents = await db()
      .select({ type: simEvents.type })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "activity_completed")));
    expect(completedEvents).toHaveLength(1);
  });

  it("forks with bit-identical body rows and re-armed alarms on the child", async () => {
    const ids = await seedBodyCase();
    await seedRhythms(ids);
    await submitDurableInitializeActorBody(initializeCommand(ids));
    const parent = await readDurableBodies(ids.branchId);

    const childBranchId = newId();
    const fork = await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parent.headSequence,
      principal: { kind: "storyteller", principalId: gmPrincipal.principalId },
      reason: "E5.1 body fork parity",
    });
    expect(fork.pendingTriggerIds.length).toBeGreaterThanOrEqual(1);

    const child = await readDurableBodies(childBranchId);
    expect(child.meters).toEqual(parent.meters);
    expect(child.conditions).toEqual(parent.conditions);
    expect(child.modifiers).toEqual(parent.modifiers);

    // E5.2: rhythm rows copy over as authored statics.
    const childRhythms = await db()
      .select()
      .from(simBodyRhythms)
      .where(eq(simBodyRhythms.branchId, childBranchId));
    expect(childRhythms).toHaveLength(2);

    const [childMeterRow] = await db()
      .select({ updatedSequence: simBodyMeters.updatedSequence })
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, childBranchId), eq(simBodyMeters.meterKey, "energy")))
      .limit(1);
    expect(childMeterRow).toBeDefined();
    const childConditions = await db()
      .select()
      .from(simBodyConditions)
      .where(eq(simBodyConditions.branchId, childBranchId));
    const childModifiers = await db()
      .select()
      .from(simBodyModifiers)
      .where(eq(simBodyModifiers.branchId, childBranchId));
    expect(childConditions).toHaveLength(parent.conditions.length);
    expect(childModifiers).toHaveLength(parent.modifiers.length);
  });
});
