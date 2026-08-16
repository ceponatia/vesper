import { and, asc, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { cohortPresenceAt, emptyCohortsSeed, replayCohortHistory } from "@vesper/simulation-core/cohorts";
import { db, simActorLods, simCohorts, simEvents, simPhysicalLoci, simTriggers } from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  branchFootprint,
  expectAccepted,
  footprintDelta,
  forkAtHead,
  gmPrincipal,
  playerPrincipal,
  readBranchEvents,
  seedReferenceRhythms,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
  type SimTestPrincipal,
} from "@/server/test-support";
import { readDurableBodies, submitDurableInitializeActorBody } from "./body-store";
import { submitDurableAdjustCohort, submitDurableCreateCohort } from "./cohort-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { submitDurablePromoteActorFromCohort } from "./promotion-store";
import { advanceBranchStoryTime } from "./scheduler-store";

/**
 * The Gate 6 exit corpus + scaling proof (engine-foundation.gate6.dual-lod.md §"Gate 6
 * exit", E6.5): deterministic scenarios, ZERO model calls — no model client
 * exists anywhere in this suite, and the routine controller is structurally
 * deterministic (§19.2.1: the §19.3 deliberator is never consulted) — proving
 * the two gate-exit claims:
 *
 *  1. promoted actors remain causally consistent with their aggregate
 *     history, reconstructible hop-by-hop from events alone (EXIT 1);
 *  2. an order of magnitude more off-screen population creates NO growth in
 *     model calls, triggers fired, events appended, or rows written during
 *     routine world progress — the instrumented scaling run (EXIT 2) — and
 *     the routine/dormant lanes stay partition-invariant with catch-up at a
 *     dependency wake (EXIT 3).
 */

const harness = await simulationSuiteHarness({
  suite: "gate6-corpus.int.test",
  table: "sim_cohorts",
});

const DAY = 86_400;
/** Day 2, 10:00 — mid market window (08:00–18:00), hours before bedtime. */
const SEED_SECOND = 2 * DAY + 600 * 60;
const BEDTIME_D2 = 2 * DAY + 1_380 * 60;

/**
 * Sleep only, no wash window — the shared reference rhythms with the hygiene
 * half switched off, which is what this corpus has always seeded.
 */
const seedSleepRhythm = (branchId: string, actorId: string): Promise<unknown> =>
  seedReferenceRhythms(branchId, actorId, { wash: false });

interface CorpusCase {
  worldId: string;
  branchId: string;
  locationId: string;
  squareZoneId: string;
  outskirtsZoneId: string;
  ana: string;
  extras: string[];
}

/**
 * `extrasApart` places the background actors at their own zone. Perception is
 * deliberately NOT LOD-gated (§27.4: LOD is a performance choice, never
 * permission to violate invariants — a dormant actor who was co-present must
 * still capture truth, or a later promotion would contradict what they
 * plainly saw), so a dormant crowd parked INSIDE an active scene records one
 * observation row per witness by design. Off-screen background belongs
 * off-scene; unnamed crowds inside a scene are what cohorts are for.
 */
async function seedCase(extraActorCount = 0, extrasApart = false): Promise<CorpusCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: CorpusCase = {
    worldId,
    branchId,
    locationId: `${worldId}-loc-town`,
    squareZoneId: `${branchId}-zone-square`,
    outskirtsZoneId: `${branchId}-zone-outskirts`,
    ana: newId(),
    extras: Array.from({ length: extraActorCount }, () => newId()),
  };
  harness.trackWorld(worldId);
  const actors: readonly { id: string; name: string }[] = [
    { id: ids.ana, name: "Ana" },
    ...ids.extras.map((id, index) => ({ id, name: `Background ${index}` })),
  ];
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "gate6-corpus-world",
    rulesetVersion: "gate6-corpus-v1",
    originStorySecond: SEED_SECOND,
    actors,
    locations: [{ id: ids.locationId, worldId, kind: "town", defaultAccessPolicy: "public" }],
    zones: [
      { id: ids.squareZoneId, locationId: ids.locationId, kind: "plaza", privacyPolicy: "public" },
      { id: ids.outskirtsZoneId, locationId: ids.locationId, kind: "district", privacyPolicy: "public" },
    ],
    links: [],
    placements: actors.map((actor) => ({
      actorId: actor.id,
      locationId: ids.locationId,
      zoneId: extrasApart && actor.id !== ids.ana ? ids.outskirtsZoneId : ids.squareZoneId,
    })),
  });
  return ids;
}

function command(
  ids: CorpusCase,
  name: string,
  type: string,
  payload: Record<string, unknown>,
  principal: SimTestPrincipal = gmPrincipal,
) {
  return simCommand({ branchId: ids.branchId, name, type, payload, principal });
}

async function trackBody(ids: CorpusCase, actorId: string, name: string): Promise<void> {
  await seedSleepRhythm(ids.branchId, actorId);
  const initialized = await submitDurableInitializeActorBody(
    command(ids, `init-${name}`, "initialize_actor_body", {
      actorId,
      registryVersion: "body-v1",
      baselineOverrides: {},
    }),
    ADMIT_AT_LOCKED_VERSION,
  );
  expectAccepted(initialized, `body init ${name}`);
}

async function assignLod(
  ids: CorpusCase,
  actorId: string,
  name: string,
  simulationLod: string,
): Promise<void> {
  const assigned = await submitDurableAssignActorLod(
    command(ids, `lod-${name}`, "assign_actor_lod", {
      actorId,
      simulationLod,
      inferenceLod: "no_model",
    }),
    ADMIT_AT_LOCKED_VERSION,
  );
  expectAccepted(assigned, `LOD ${name}`);
}

async function firedTriggerCount(branchId: string): Promise<number> {
  const [row] = await db()
    .select({ value: count() })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.state, "completed")));
  return row?.value ?? 0;
}

describe.runIf(harness.ready)(
  "Gate 6 exit corpus — dual LOD and autonomous background life (E6.5)",
  () => {
    // -----------------------------------------------------------------------
    // 1 — A promoted actor's whole existence reconstructs hop-by-hop from
    // aggregate history: cohort authoring → conserved adjustments → the
    // reservation debit → materialization → landing LOD → embodiment → the
    // routine alarm → a chosen sleep. Conservation and presence hold at every
    // hop, summed from events alone — never from live rows.
    // -----------------------------------------------------------------------
    it("EXIT 1 — a promoted actor is causally consistent with aggregate history, hop-by-hop from events alone", async () => {
      const ids = await seedCase();
      const cohortId = newId();

      const created = await submitDurableCreateCohort(
        command(ids, "create-market", "create_cohort", {
          cohort: {
            id: cohortId,
            name: "market regulars",
            population: 50,
            presenceWindows: [
              { zoneId: ids.squareZoneId, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 10_000 },
            ],
            registryVersion: "cohort-v1",
          },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(created, "cohort creation");
      const influx = await submitDurableAdjustCohort(
        command(ids, "influx", "adjust_cohort", { cohortId, deltaCount: 5, reason: "influx" }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(influx, "cohort influx");
      const attrition = await submitDurableAdjustCohort(
        command(ids, "attrition", "adjust_cohort", { cohortId, deltaCount: -3, reason: "attrition" }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(attrition, "cohort attrition");

      const promoted = await submitDurablePromoteActorFromCohort(
        command(ids, "promote-maren", "promote_actor_from_cohort", {
          cohortId,
          zoneId: ids.squareZoneId,
          name: "Maren",
          landing: { simulationLod: "event", inferenceLod: "no_model" },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(promoted, "promotion");

      const preEmbodyEvents = await readBranchEvents(ids.branchId);
      const materialized = preEmbodyEvents.find(
        (event) => event.type === "actor_materialized_from_aggregate",
      );
      if (materialized?.type !== "actor_materialized_from_aggregate") {
        throw new Error("materialization event missing");
      }
      const maren = materialized.payload.actorId;

      await seedSleepRhythm(ids.branchId, maren);
      const embodied = await submitDurableInitializeActorBody(
        command(ids, "embody-maren", "initialize_actor_body", {
          actorId: maren,
          registryVersion: "body-v1",
          baselineOverrides: {},
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(embodied, "Maren's embodiment");

      const drained = await advanceBranchStoryTime(ids.branchId, BEDTIME_D2 + 1, {
        workerId: "w-gate6-exit1",
      });
      expect(drained.status).toBe("advanced");

      // ---- The hop-by-hop walk, from events alone. --------------------------
      const events = await readBranchEvents(ids.branchId);
      const byId = new Map(events.map((event) => [event.id, event]));

      // Hop 1: Maren is asleep — and the asleep condition belongs to the SAME
      // command as a routine decision that chose sleep at event LOD.
      const asleep = events.find(
        (event) =>
          event.type === "body_condition_applied" &&
          event.payload.conditionKey === "asleep" &&
          event.payload.actorId === maren,
      );
      if (asleep?.type !== "body_condition_applied") throw new Error("no asleep condition event");
      const decision = events.find(
        (event) => event.type === "routine_policy_resolved" && event.commandId === asleep.commandId,
      );
      if (decision?.type !== "routine_policy_resolved") throw new Error("no routine decision event");
      expect(decision.payload).toMatchObject({ actorId: maren, chosenCandidateId: "begin_sleep" });

      // Hop 2: the routine alarm that dispatched that decision was armed by
      // Maren's embodiment — the init-time arm (§27.7 catch-up law).
      const routineArm = events.find(
        (event) =>
          event.type === "trigger_scheduled" &&
          event.payload.kind === "routine_policy_due" &&
          event.commandId === embodied.commandId,
      );
      expect(routineArm).toBeDefined();
      const bodyInitialized = events.find(
        (event) => event.type === "body_initialized" && event.commandId === embodied.commandId,
      );
      if (bodyInitialized?.type !== "body_initialized") throw new Error("no body_initialized event");
      expect(bodyInitialized.payload.actorId).toBe(maren);

      // Hop 3: the embodied actor exists ONLY through the materialization,
      // which is causation-chained to the conserved reservation debit.
      const materializations = events.filter(
        (event) => event.type === "actor_materialized_from_aggregate",
      );
      expect(materializations).toHaveLength(1);
      const debit = materialized.causationId ? byId.get(materialized.causationId) : undefined;
      if (debit?.type !== "cohort_adjusted") throw new Error("materialization not chained to a debit");
      expect(debit.payload).toMatchObject({ cohortId, deltaCount: -1, reason: "promotion_reservation" });

      // Hop 4: the cohort's whole count history verifies hop-by-hop — every
      // adjustment's populationBefore is the prior populationAfter, from the
      // authored creation forward (audit-without-reads, actually audited).
      const cohortChain = events.filter(
        (event) =>
          (event.type === "cohort_created" && event.payload.cohort.id === cohortId) ||
          (event.type === "cohort_adjusted" && event.payload.cohortId === cohortId),
      );
      let runningPopulation: number | undefined;
      for (const event of cohortChain) {
        if (event.type === "cohort_created") {
          runningPopulation = event.payload.cohort.population;
          continue;
        }
        if (event.type !== "cohort_adjusted") continue;
        expect(event.payload.populationBefore).toBe(runningPopulation);
        expect(event.payload.populationAfter).toBe(
          event.payload.populationBefore + event.payload.deltaCount,
        );
        runningPopulation = event.payload.populationAfter;
      }
      expect(runningPopulation).toBe(51); // 50 + 5 − 3 − 1

      // Conservation identity, from events alone: everyone the aggregate ever
      // held is either still aggregate or a named materialized actor.
      const reservationDebits = events.filter(
        (event) => event.type === "cohort_adjusted" && event.payload.reason === "promotion_reservation",
      );
      const totalPeople = 50 + 5 - 3;
      expect((runningPopulation ?? 0) + reservationDebits.length).toBe(totalPeople);

      // The replayed projection agrees with the fold and with the live row.
      const replayed = replayCohortHistory({
        seed: emptyCohortsSeed(ids.branchId, SEED_SECOND),
        events,
      });
      const replayedCohort = replayed.cohorts.find((cohort) => cohort.id === cohortId);
      expect(replayedCohort?.population).toBe(51);
      const [liveRow] = await db()
        .select({ population: simCohorts.population })
        .from(simCohorts)
        .where(and(eq(simCohorts.branchId, ids.branchId), eq(simCohorts.cohortId, cohortId)));
      expect(liveRow?.population).toBe(51);

      // Presence continuity at share 10 000: the analytic read plus the one
      // named actor still accounts for every person, mid-window.
      if (!replayedCohort) throw new Error("replayed cohort missing");
      const probeSecond = 2 * DAY + 660 * 60; // day 2, 11:00 — mid-window
      expect(cohortPresenceAt(replayedCohort, probeSecond)).toEqual({
        zoneId: ids.squareZoneId,
        presentCount: 51,
      });
      const [marenLocus] = await db()
        .select({ zoneId: simPhysicalLoci.zoneId })
        .from(simPhysicalLoci)
        .where(and(eq(simPhysicalLoci.branchId, ids.branchId), eq(simPhysicalLoci.actorId, maren)));
      expect(marenLocus?.zoneId).toBe(ids.squareZoneId);
      // 51 analytically present + Maren bodily at the square = the 52 who ever existed.
      expect(51 + 1).toBe(totalPeople);

      // Zero model calls: the decision captured a deterministic scorer run at
      // event LOD — no deliberation event kind exists anywhere in the stream.
      expect(events.some((event) => event.type === "consent_escalation_resolved")).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 2 — The instrumented scaling run (soak-harness style). Two worlds with
    // an IDENTICAL one-actor active cast running three story-days of routine
    // life; the background differs by an order of magnitude in BOTH cohort
    // rows (3 → 30) and cohort population (1 000 → 10 000 each; 3 003 →
    // 300 030 background people including dormant actors). Authoring cost is
    // allowed to scale; LIFE cost must not: model calls, triggers fired,
    // events appended, and rows written during the drain must be EQUAL, not
    // merely sublinear.
    //
    // TIMEOUT: this case seeds TWO worlds, the larger one authoring 30 cohorts
    // and 30 embodied dormant actors — ~4s of pure authoring, which the exit
    // criterion explicitly ALLOWS to scale. That alone sat at ~98% of vitest's
    // 5s default, and the derived `branchFootprint` (every branch-scoped sim_
    // table, not a hand-listed twelve) tipped it over. The wall-time claim this
    // test actually makes is the `big.lifeMillis` bound below — the harness
    // timeout is not a proof, so it is raised rather than the measurement
    // weakened.
    // -----------------------------------------------------------------------
    it("EXIT 2 — 100× the background population is the same routine-life work: equal triggers, events, and rows; zero model calls", async () => {
      interface ScaleRun {
        ids: CorpusCase;
        seedMillis: number;
        lifeMillis: number;
        lifeDelta: Record<string, number>;
        lifeTriggersFired: number;
        decisions: number;
      }

      async function runScale(
        label: string,
        cohortCount: number,
        cohortPopulation: number,
        dormantCount: number,
      ): Promise<ScaleRun> {
        const seedStarted = performance.now();
        // The background lives OFF-SCENE (its own zone): co-present witnesses
        // record observations by perception law regardless of LOD — see
        // seedCase's note — and "off-screen population" means exactly that.
        const ids = await seedCase(dormantCount, true);
        // The active cast: Ana, embodied, at event LOD, living the routine.
        await trackBody(ids, ids.ana, "ana");
        await assignLod(ids, ids.ana, "ana", "event");
        // The background: cohorts (one row each, any population) and dormant
        // embodied actors (rows, no scheduled work).
        for (let index = 0; index < cohortCount; index += 1) {
          const created = await submitDurableCreateCohort(
            command(ids, `cohort-${index}`, "create_cohort", {
              cohort: {
                id: `${ids.branchId}-cohort-${index}`,
                name: `crowd ${index}`,
                population: cohortPopulation,
                presenceWindows: [
                  {
                    zoneId: ids.squareZoneId,
                    startMinuteOfDay: 480,
                    endMinuteOfDay: 1_080,
                    shareFixedPoint: 10_000,
                  },
                ],
                registryVersion: "cohort-v1",
              },
            }),
            ADMIT_AT_LOCKED_VERSION,
          );
          expectAccepted(created, `cohort ${index}`);
        }
        for (const [index, extra] of ids.extras.entries()) {
          await seedSleepRhythm(ids.branchId, extra);
          const initialized = await submitDurableInitializeActorBody(
            command(ids, `init-extra-${index}`, "initialize_actor_body", {
              actorId: extra,
              registryVersion: "body-v1",
              baselineOverrides: {},
            }),
            ADMIT_AT_LOCKED_VERSION,
          );
          expectAccepted(initialized, `extra ${index} body init`);
          await assignLod(ids, extra, `extra-${index}`, "dormant");
        }
        const seedMillis = performance.now() - seedStarted;

        // `branchFootprint` derives its table list from the drizzle schema, so
        // a lane added later is measured here without editing this file.
        const beforeFootprint = await branchFootprint(ids.branchId);
        const beforeFired = await firedTriggerCount(ids.branchId);
        const lifeStarted = performance.now();
        const drained = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 3 * DAY, {
          workerId: `w-gate6-scale-${label}`,
        });
        const lifeMillis = performance.now() - lifeStarted;
        expect(drained.status).toBe("advanced");
        const afterFootprint = await branchFootprint(ids.branchId);
        const decisionsRows = await db()
          .select({ value: count() })
          .from(simEvents)
          .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "routine_policy_resolved")));

        return {
          ids,
          seedMillis,
          lifeMillis,
          lifeDelta: footprintDelta(beforeFootprint, afterFootprint),
          lifeTriggersFired: (await firedTriggerCount(ids.branchId)) - beforeFired,
          decisions: decisionsRows[0]?.value ?? 0,
        };
      }

      const small = await runScale("small", 3, 1_000, 3);
      const big = await runScale("big", 30, 10_000, 30);

      // The active cast actually lived: three bedtimes chose sleep.
      expect(small.decisions).toBe(3);
      expect(big.decisions).toBe(3);
      expect(small.lifeTriggersFired).toBeGreaterThanOrEqual(6); // 3 routine + 3 expiry, minimum

      // The exit criterion, strict: routine world progress is IDENTICAL work
      // regardless of background scale — same fired triggers, same appended
      // events, same row growth on every table, zero model calls anywhere
      // (no model client exists in this suite; nothing to count).
      expect(big.lifeTriggersFired).toBe(small.lifeTriggersFired);
      expect(big.lifeDelta).toEqual(small.lifeDelta);
      // `footprintDelta` drops the zeros, so an ABSENT key is "nothing was
      // written to that table" — the same claim the old exact-zero read made.
      expect(big.lifeDelta.sim_cohorts ?? 0).toBe(0);
      expect(big.lifeDelta.sim_characters ?? 0).toBe(0);
      expect(big.lifeDelta.sim_actor_lods ?? 0).toBe(0);

      // The dormant background did no work at all during three story-days.
      const dormantTriggers = await db()
        .select({ uniquenessKey: simTriggers.uniquenessKey })
        .from(simTriggers)
        .where(and(eq(simTriggers.branchId, big.ids.branchId), eq(simTriggers.state, "pending")));
      for (const extra of big.ids.extras) {
        expect(dormantTriggers.some((row) => row.uniquenessKey?.includes(extra))).toBe(false);
      }

      // Wall time: life-phase work is provably identical, so time may not
      // grow with the background either (generous bound for CI noise).
      expect(big.lifeMillis).toBeLessThan(Math.max(small.lifeMillis * 5, 2_000));
      process.stderr.write(
        `[gate6 scaling] background 3,003 → 300,030 people | seed ${small.seedMillis.toFixed(0)}ms → ${big.seedMillis.toFixed(0)}ms (authoring, may scale) | life ${small.lifeMillis.toFixed(0)}ms → ${big.lifeMillis.toFixed(0)}ms | triggers fired ${small.lifeTriggersFired} → ${big.lifeTriggersFired} | life row deltas equal: ${JSON.stringify(small.lifeDelta)}\n`,
      );
    }, 30_000);

    // -----------------------------------------------------------------------
    // 3 — Partition invariance across the routine and dormant lanes: one big
    // three-day jump equals four smaller jumps, including a dormant actor
    // woken by an engagement at the far end — the catch-up solve lands the
    // same state and the same re-armed alarms either way.
    // -----------------------------------------------------------------------
    it("EXIT 3 — one big jump equals smaller jumps across routine cycles, and a dependency wake catches up identically", async () => {
      const ids = await seedCase(1);
      const riven = ids.extras[0];
      if (!riven) throw new Error("expected the dormant extra");
      await trackBody(ids, ids.ana, "ana");
      await assignLod(ids, ids.ana, "ana", "event");
      await seedSleepRhythm(ids.branchId, riven);
      const initialized = await submitDurableInitializeActorBody(
        command(ids, "init-riven", "initialize_actor_body", {
          actorId: riven,
          registryVersion: "body-v1",
          baselineOverrides: {},
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(initialized, "Riven's body init");
      await assignLod(ids, riven, "riven", "dormant");

      // Both children fork at the SAME parent head, so the two partitionings
      // start from bit-identical inherited history.
      const { childBranchId: childA } = await forkAtHead({
        parentBranchId: ids.branchId,
        reason: "gate6 partition — one big jump",
      });
      const { childBranchId: childB } = await forkAtHead({
        parentBranchId: ids.branchId,
        reason: "gate6 partition — smaller jumps",
      });

      // Day 5, 08:00 — past three bedtimes and three wakes for Ana; Riven
      // dormant throughout.
      const target = 5 * DAY + 480 * 60;
      const big = await advanceBranchStoryTime(childA, target, { workerId: "w-gate6-part-big" });
      expect(big.status).toBe("advanced");
      const stops = [SEED_SECOND + 40_000, SEED_SECOND + 130_000, SEED_SECOND + 200_000, target];
      for (const [index, stop] of stops.entries()) {
        const outcome = await advanceBranchStoryTime(childB, stop, {
          workerId: `w-gate6-part-small-${index}`,
        });
        expect(outcome.status).toBe("advanced");
      }

      // The wake at the far end, identical command shape in both children.
      for (const childId of [childA, childB]) {
        const opened = await submitDurableOpenEngagement(
          simCommand({
            branchId: childId,
            name: "wake",
            type: "open_engagement",
            principal: playerPrincipal(ids.ana),
            payload: { participantIds: [ids.ana, riven].sort(), channel: "co_present" },
          }),
          ADMIT_AT_LOCKED_VERSION,
        );
        expectAccepted(opened, `wake on ${childId}`);
      }

      // Bit-identical bodies across the partitionings — meters, conditions,
      // modifiers — for the routine-living actor AND the woken sleeper. The
      // children are distinct branches, so branch-derived identities (`id`,
      // `sourceEventId`) are scrubbed; every semantic field must match.
      const scrub = <T extends { id?: string; sourceEventId?: string; conditionId?: string }>(
        rows: readonly T[],
      ) =>
        rows
          .map(({ id: _id, sourceEventId: _sourceEventId, conditionId: _conditionId, ...rest }) => rest)
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const bodiesA = await readDurableBodies(childA);
      const bodiesB = await readDurableBodies(childB);
      expect(bodiesB.storySecond).toBe(bodiesA.storySecond);
      expect(bodiesB.meters).toEqual(bodiesA.meters);
      expect(scrub(bodiesB.conditions)).toEqual(scrub(bodiesA.conditions));
      expect(scrub(bodiesB.modifiers)).toEqual(scrub(bodiesA.modifiers));

      // The same LOD landing and the same re-armed alarm schedule.
      for (const childId of [childA, childB]) {
        const [lodRow] = await db()
          .select({ simulationLod: simActorLods.simulationLod, inferenceLod: simActorLods.inferenceLod })
          .from(simActorLods)
          .where(and(eq(simActorLods.branchId, childId), eq(simActorLods.actorId, riven)));
        expect(lodRow).toEqual({ simulationLod: "event", inferenceLod: "no_model" });
      }
      const alarmsOf = async (childId: string) =>
        db()
          .select({ kind: simTriggers.kind, dueStorySecond: simTriggers.dueStorySecond })
          .from(simTriggers)
          .where(and(eq(simTriggers.branchId, childId), eq(simTriggers.state, "pending")))
          .orderBy(asc(simTriggers.dueStorySecond), asc(simTriggers.kind));
      expect(await alarmsOf(childB)).toEqual(await alarmsOf(childA));

      // Not vacuous: real routine cycles ran in the span, identically.
      const decisionsOf = async (childId: string) =>
        db()
          .select({ value: count() })
          .from(simEvents)
          .where(and(eq(simEvents.branchId, childId), eq(simEvents.type, "routine_policy_resolved")))
          .then((rows) => rows[0]?.value ?? 0);
      const decisionsA = await decisionsOf(childA);
      expect(decisionsA).toBeGreaterThanOrEqual(3);
      expect(await decisionsOf(childB)).toBe(decisionsA);
    });
  },
);
