import { eq } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { db, simBranches, simEvents, simTriggers, simWorlds, type Db } from "@/server/db";
import { seedDurableBodyRhythms, submitDurableInitializeActorBody } from "./body-store";
import { submitDurableCreateCohort } from "./cohort-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { seedDurableMaterialBranch } from "./material-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { seedDurableSpaceTopology } from "./space-store";

/**
 * R1 (engine.rollout.plan.md) — the standing internal test world: one fixed,
 * re-runnable provisioning of a small successor world (topology, rhythms,
 * embodied cast at mixed LODs, a cohort) plus a bounded drain loop, shared by
 * the `pnpm sim:seed` / `pnpm sim:advance` scripts (local and over Fly SSH)
 * and the int suite. Ids are FIXED, not generated — the point is a stable
 * world an operator can find again — so seeding is idempotent: an existing
 * world is reported, never re-seeded or duplicated.
 *
 * The cast covers every rollout-relevant LOD shape: two event-LOD actors
 * living the E6.2 routine (Ana with meals, Ben sleep-only), one dormant
 * (Riven — the E6.4 dependency-wake target), and one default-exact (Mara —
 * the future player-side seat for R2/R3). The action catalog is deliberately
 * absent until R3 needs typed player actions — routine life requires none.
 */

export const ROLLOUT_WORLD_ID = "rollout-test-world";
export const ROLLOUT_BRANCH_ID = "rollout-test-branch";
export const ROLLOUT_WORLD_TYPE_ID = "rollout-test-world-type";
export const ROLLOUT_RULESET_VERSION = "rollout-test-v1";

/** Day 2, 10:00 — mid market window, hours before the 23:00 bedtime (the corpus convention). */
export const ROLLOUT_ORIGIN_STORY_SECOND = 2 * 86_400 + 600 * 60;

export const ROLLOUT_ACTORS = {
  ana: "rollout-actor-ana",
  ben: "rollout-actor-ben",
  riven: "rollout-actor-riven",
  mara: "rollout-actor-mara",
} as const;

export const ROLLOUT_ZONES = {
  square: "rollout-zone-square",
  home: "rollout-zone-home",
} as const;

const LOCATION_ID = "rollout-loc-town";
const COHORT_ID = "rollout-cohort-market";
const LOAF_ID = "rollout-item-loaf";

export interface RolloutWorldSummary {
  worldId: string;
  branchId: string;
  alreadySeeded: boolean;
  storySecond: number;
  pendingTriggers: number;
}

async function summarize(database: Db, alreadySeeded: boolean): Promise<RolloutWorldSummary> {
  const [branch] = await database
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, ROLLOUT_BRANCH_ID))
    .limit(1);
  const pending = await database
    .select({ state: simTriggers.state })
    .from(simTriggers)
    .where(eq(simTriggers.branchId, ROLLOUT_BRANCH_ID));
  return {
    worldId: ROLLOUT_WORLD_ID,
    branchId: ROLLOUT_BRANCH_ID,
    alreadySeeded,
    storySecond: branch?.storySecond ?? 0,
    pendingTriggers: pending.filter((row) => row.state === "pending").length,
  };
}

/** A stable per-step command envelope — fixed ids keep re-runs idempotent. */
function command(name: string, payload: Record<string, unknown>) {
  return {
    id: `rollout-cmd-${name}`,
    branchId: ROLLOUT_BRANCH_ID,
    expectedVersion: 0,
    idempotencyKey: `rollout-${name}`,
    principal: { kind: "system" as const, principalId: "rollout-seeder", controlledActorIds: [] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `rollout-seed-${newId()}`,
    schemaVersion: 1,
    ...payload,
  };
}

async function expectAccepted(step: string, result: { status: string }): Promise<void> {
  if (result.status !== "accepted") {
    throw new Error(`Rollout world seed step "${step}" was not accepted: ${JSON.stringify(result)}`);
  }
}

export async function seedRolloutTestWorld(database: Db = db()): Promise<RolloutWorldSummary> {
  const [existing] = await database
    .select({ id: simWorlds.id })
    .from(simWorlds)
    .where(eq(simWorlds.id, ROLLOUT_WORLD_ID))
    .limit(1);
  if (existing) return summarize(database, true);

  await seedDurableMaterialBranch(
    {
      worldId: ROLLOUT_WORLD_ID,
      worldTypeId: ROLLOUT_WORLD_TYPE_ID,
      worldSeed: "rollout-test-seed",
      branchId: ROLLOUT_BRANCH_ID,
      rulesetVersion: ROLLOUT_RULESET_VERSION,
      originStorySecond: ROLLOUT_ORIGIN_STORY_SECOND,
      actors: [
        { id: ROLLOUT_ACTORS.ana, name: "Ana" },
        { id: ROLLOUT_ACTORS.ben, name: "Ben" },
        { id: ROLLOUT_ACTORS.riven, name: "Riven" },
        { id: ROLLOUT_ACTORS.mara, name: "Mara" },
      ],
      items: [
        {
          id: LOAF_ID,
          name: "a loaf of bread",
          materialKindKey: "bread",
          ownerActorId: null,
          consumptionEffects: [
            { meterKey: "energy", sourceKind: "meal", operation: { kind: "add", deltaFixedPoint: 1_500 } },
          ],
          locus: { kind: "held", actorId: ROLLOUT_ACTORS.ana },
        },
      ],
    },
    { database },
  );
  await seedDurableSpaceTopology(
    {
      branchId: ROLLOUT_BRANCH_ID,
      locations: [
        { id: LOCATION_ID, worldId: ROLLOUT_WORLD_ID, kind: "town", defaultAccessPolicy: "public" },
      ],
      zones: [
        { id: ROLLOUT_ZONES.square, locationId: LOCATION_ID, kind: "plaza", privacyPolicy: "public" },
        { id: ROLLOUT_ZONES.home, locationId: LOCATION_ID, kind: "home", privacyPolicy: "public" },
      ],
      links: [
        {
          id: "rollout-link-home-square",
          fromZoneId: ROLLOUT_ZONES.home,
          toZoneId: ROLLOUT_ZONES.square,
          modes: ["walk"],
          minimumDurationSeconds: 300,
          accessPolicy: "public",
          state: "open",
        },
      ],
      loci: [
        { kind: "at", actorId: ROLLOUT_ACTORS.ana, locationId: LOCATION_ID, zoneId: ROLLOUT_ZONES.home, since: ROLLOUT_ORIGIN_STORY_SECOND },
        { kind: "at", actorId: ROLLOUT_ACTORS.ben, locationId: LOCATION_ID, zoneId: ROLLOUT_ZONES.home, since: ROLLOUT_ORIGIN_STORY_SECOND },
        { kind: "at", actorId: ROLLOUT_ACTORS.riven, locationId: LOCATION_ID, zoneId: ROLLOUT_ZONES.square, since: ROLLOUT_ORIGIN_STORY_SECOND },
        { kind: "at", actorId: ROLLOUT_ACTORS.mara, locationId: LOCATION_ID, zoneId: ROLLOUT_ZONES.home, since: ROLLOUT_ORIGIN_STORY_SECOND },
      ],
    },
    { database },
  );
  await seedDurableBodyRhythms(
    {
      branchId: ROLLOUT_BRANCH_ID,
      rows: [
        { actorId: ROLLOUT_ACTORS.ana, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 },
        { actorId: ROLLOUT_ACTORS.ana, kind: "meal", startMinuteOfDay: 720, endMinuteOfDay: 780 },
        { actorId: ROLLOUT_ACTORS.ben, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 },
        { actorId: ROLLOUT_ACTORS.riven, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 },
      ],
    },
    { database },
  );

  const admit = { database, admitAtLockedVersion: true };
  for (const [name, actorId] of [
    ["init-ana", ROLLOUT_ACTORS.ana],
    ["init-ben", ROLLOUT_ACTORS.ben],
    ["init-riven", ROLLOUT_ACTORS.riven],
    ["init-mara", ROLLOUT_ACTORS.mara],
  ] as const) {
    await expectAccepted(
      name,
      await submitDurableInitializeActorBody(
        command(name, {
          type: "initialize_actor_body",
          payload: { actorId, registryVersion: "body-v1", baselineOverrides: {} },
        }),
        admit,
      ),
    );
  }
  for (const [name, actorId, simulationLod] of [
    ["lod-ana", ROLLOUT_ACTORS.ana, "event"],
    ["lod-ben", ROLLOUT_ACTORS.ben, "event"],
    ["lod-riven", ROLLOUT_ACTORS.riven, "dormant"],
  ] as const) {
    await expectAccepted(
      name,
      await submitDurableAssignActorLod(
        command(name, {
          type: "assign_actor_lod",
          payload: { actorId, simulationLod, inferenceLod: "no_model" },
        }),
        admit,
      ),
    );
  }
  await expectAccepted(
    "cohort",
    await submitDurableCreateCohort(
      command("cohort", {
        type: "create_cohort",
        payload: {
          cohort: {
            id: COHORT_ID,
            name: "market regulars",
            population: 200,
            presenceWindows: [
              { zoneId: ROLLOUT_ZONES.square, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
            ],
            registryVersion: "cohort-v1",
          },
        },
      }),
      admit,
    ),
  );

  return summarize(database, false);
}

export interface AdvanceRolloutWorldResult {
  fromStorySecond: number;
  toStorySecond: number;
  drained: number;
  calls: number;
  routineDecisions: number;
}

/**
 * Advance the rollout world's story clock, looping the bounded drain until it
 * reports `advanced` (the seam's catch_up_required contract). Days compose on
 * the CURRENT clock; an absolute target may also be given.
 */
export async function advanceRolloutWorld(
  input: { days?: number; toStorySecond?: number },
  database: Db = db(),
): Promise<AdvanceRolloutWorldResult> {
  const [branch] = await database
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, ROLLOUT_BRANCH_ID))
    .limit(1);
  if (!branch) throw new Error("Rollout world is not seeded — run seedRolloutTestWorld first");
  const from = branch.storySecond;
  const target =
    input.toStorySecond ?? (input.days !== undefined ? from + Math.round(input.days * 86_400) : from);
  if (target < from) throw new Error("Story time cannot move backwards");

  let drained = 0;
  let calls = 0;
  for (;;) {
    calls += 1;
    if (calls > 1_000) throw new Error("Rollout drain did not converge within 1000 calls");
    const outcome = await advanceBranchStoryTime(ROLLOUT_BRANCH_ID, target, {
      workerId: `rollout-advance-${newId()}`,
      database,
    });
    drained += outcome.drained;
    if (outcome.status === "advanced") break;
  }

  const decisions = await database
    .select({ type: simEvents.type })
    .from(simEvents)
    .where(eq(simEvents.branchId, ROLLOUT_BRANCH_ID));
  return {
    fromStorySecond: from,
    toStorySecond: target,
    drained,
    calls,
    routineDecisions: decisions.filter((row) => row.type === "routine_policy_resolved").length,
  };
}
