import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  RESERVED_CURRENCY_MATERIAL_KIND,
  lotLocusSchema,
} from "@/contracts/simulation/households";
import type { MaterialBranchSeedInput } from "@/contracts/simulation/materials";
import { proposedArmedEffectSchema } from "@/contracts/simulation/narrative";
import type { SimulationTriggerKind } from "@/contracts/simulation/scheduler";
import { relationshipLedgerWeightRegistryV1 } from "@/contracts/simulation/social";
import { newId } from "@/lib/ids";
import {
  deriveCommitmentId,
  deriveEngagementId,
  deriveEnergyRead,
  deriveMaterialLotRowKey,
  deriveRelationshipRead,
  emptyHouseholdsSeed,
  replayHouseholdsHistory,
  replaySocialLedgerHistory,
  simulationHash,
} from "@/lib/simulation";
import {
  db,
  simBodyMeters,
  simBodyRhythms,
  simBranches,
  simEvents,
  simHouseholds,
  simItemConditionMeters,
  simItemConditionModifiers,
  simItemHoldings,
  simItems,
  simMaterialLots,
  simObservations,
  simTriggers,
} from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  branchFootprint,
  expectAccepted,
  footprintDelta,
  forkAtHead,
  gmPrincipal,
  npcPrincipal,
  playerPrincipal,
  readBranchEvents,
  seedReferenceRhythms,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
  systemPrincipal,
  type SimCommandEnvelope,
  type SimTestPrincipal,
} from "@/server/test-support";
import {
  prepareEngagementTurn,
  submitDurableConfirmNarratorResult,
} from "./arbiter-store";
import {
  bodyRhythmFromRow,
  computeEngagementBodilyReads,
  readDurableBodies,
  submitDurableApplyBodyCondition,
  submitDurableApplyBodySource,
  submitDurableInitializeActorBody,
} from "./body-store";
import { forkBranch } from "./branch-store";
import {
  readDurableCommitments,
  submitDurableCreateCommitment,
  submitDurableFulfillCommitment,
} from "./commitment-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import {
  submitDurableAdjustMaterialLot,
  submitDurableConfigureRestockRoutine,
  submitDurableCreateHousehold,
  submitDurablePromoteItemFromStock,
  submitDurableSetHouseholdMembership,
  submitDurableSetMeansBand,
} from "./household-store";
import {
  itemConditionMeterFromRow,
  itemConditionModifierFromRow,
  submitDurableApplyItemConditionSource,
  submitDurableConsumeItem,
  submitDurableTransferItem,
} from "./material-store";
import { drainMemoryIndexOutbox } from "./memory-index-store";
import { queryMemoryDocuments } from "./memory-query-store";
import { loadPersistedCut } from "./narrative-cut-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { loadRelationshipLedgerProjection } from "./social-recorder";
import { submitDurableAttemptConsentEscalation } from "./social-store";

/**
 * The Gate 5 exit corpus (engine.plan.md §"Gate 5 exit" / §"Gate 5 build
 * order" item 6, E5.6): deterministic scenarios, ZERO model calls, proving
 * "the engine can explain why a body, item, household, or relationship is in
 * its current state from causal records, while the narrator sees only what
 * the viewpoint can perceive or believe." Runs on the shared
 * `simulationSuiteHarness` (probe + teardown, `trackBranchMembers` because
 * these scenarios create households) with a per-scenario `CorpusCase` and the
 * shared `simCommand` envelope builder submitted with
 * `ADMIT_AT_LOCKED_VERSION` throughout — every command's `expectedVersion` is
 * a fixed `0`, admitted at whatever version the locked branch actually holds
 * (gate3/gate4-corpus's own convention, confirmed universally supported by
 * `runSimulationCommand`'s shared shell).
 */

// 50 000 mod 86 400 = 13:53:20 — mirrors body-store.int.test.ts's own SEED_SECOND
// exactly, so a fresh body's circadian pressure reads clean daytime by default.
const SEED_SECOND = 50_000;
const TURN_SPAN = 400;
const WORN_SLOT = "torso";

const harness = await simulationSuiteHarness({
  suite: "gate5-corpus.int.test",
  table: "sim_relationship_ledger",
  trackBranchMembers: true,
});

/**
 * player/mara/iris co-located in a private home zone; noor + ben (her scene
 * partner) sit in a SEPARATE location entirely — cross-zone sound within one
 * location still reaches an occupant (perception.ts's default
 * `crossZoneSound`), so a clean "never witnessed" negative control needs a
 * different LOCATION, not merely a different zone (material-store.int.test
 * .ts's own comment on the same idiom).
 */
interface CorpusCase {
  worldId: string;
  branchId: string;
  player: string;
  mara: string;
  iris: string;
  noor: string;
  ben: string;
  locHome: string;
  locElsewhere: string;
  zoneHome: string;
  zoneElsewhere: string;
}

async function seedCorpusCase(
  itemsFactory?: (
    ids: Omit<
      CorpusCase,
      "locHome" | "locElsewhere" | "zoneHome" | "zoneElsewhere"
    >,
  ) => MaterialBranchSeedInput["items"],
): Promise<CorpusCase> {
  const worldId = newId();
  const branchId = newId();
  const actorIds = {
    worldId,
    branchId,
    player: newId(),
    mara: newId(),
    iris: newId(),
    noor: newId(),
    ben: newId(),
  };
  const ids: CorpusCase = {
    ...actorIds,
    locHome: `${worldId}-loc-home`,
    locElsewhere: `${worldId}-loc-elsewhere`,
    zoneHome: `${branchId}-zone-home`,
    zoneElsewhere: `${branchId}-zone-elsewhere`,
  };
  harness.trackWorld(worldId);
  harness.trackBranch(branchId);
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "gate5-corpus",
    rulesetVersion: "gate5-corpus-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.player, name: "Pia" },
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
      { id: ids.noor, name: "Noor" },
      { id: ids.ben, name: "Ben" },
    ],
    items: itemsFactory?.(actorIds) ?? [],
    locations: [
      {
        id: ids.locHome,
        worldId,
        kind: "home",
        defaultAccessPolicy: "private",
      },
      {
        id: ids.locElsewhere,
        worldId,
        kind: "town",
        defaultAccessPolicy: "public",
      },
    ],
    zones: [
      {
        id: ids.zoneHome,
        locationId: ids.locHome,
        kind: "room",
        privacyPolicy: "private",
      },
      {
        id: ids.zoneElsewhere,
        locationId: ids.locElsewhere,
        kind: "town",
        privacyPolicy: "public",
      },
    ],
    links: [],
    placements: [
      {
        actorId: ids.player,
        locationId: ids.locHome,
        zoneId: ids.zoneHome,
      },
      {
        actorId: ids.mara,
        locationId: ids.locHome,
        zoneId: ids.zoneHome,
      },
      {
        actorId: ids.iris,
        locationId: ids.locHome,
        zoneId: ids.zoneHome,
      },
      {
        actorId: ids.noor,
        locationId: ids.locElsewhere,
        zoneId: ids.zoneElsewhere,
      },
      {
        actorId: ids.ben,
        locationId: ids.locElsewhere,
        zoneId: ids.zoneElsewhere,
      },
    ],
  });
  return ids;
}

/**
 * Positional wrapper over the shared `simCommand`, kept so the ~40 call sites
 * below read unchanged. `name` is the label the shared builder derives the
 * command id / idempotency key from, and the schema version comes from
 * `SCHEMA_VERSION_BY_TYPE` rather than a local `transfer_item`/
 * `confirm_narrator_result` set.
 */
function command(
  ids: { branchId: string },
  name: string,
  type: string,
  principal: SimTestPrincipal,
  payload: Record<string, unknown>,
): SimCommandEnvelope {
  return simCommand({ branchId: ids.branchId, name, type, principal, payload });
}

async function pendingTriggers(branchId: string, kind: SimulationTriggerKind) {
  return db()
    .select({
      state: simTriggers.state,
      uniquenessKey: simTriggers.uniquenessKey,
      dueStorySecond: simTriggers.dueStorySecond,
    })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.kind, kind)))
    .orderBy(asc(simTriggers.dueStorySecond));
}

async function branchHeadSequence(branchId: string): Promise<number> {
  const [row] = await db()
    .select({ headSequence: simBranches.headSequence })
    .from(simBranches)
    .where(eq(simBranches.id, branchId));
  if (!row) throw new Error("branch missing");
  return row.headSequence;
}

/** 11pm-7am sleep, 6:45am-7am wash — the shared reference daily life. */
async function seedRhythms(branchId: string, actorId: string) {
  await seedReferenceRhythms(branchId, actorId);
}

/** Sleep only, no wash — hygiene is left uncontested so its "grimy" alarm is
 * guaranteed to fire (body-store.int.test.ts's own precedent: WITH a wash
 * window the daily reset suppresses hygiene's alarm outright). */
async function seedSleepOnlyRhythm(branchId: string, actorId: string) {
  await seedReferenceRhythms(branchId, actorId, { wash: false });
}

/** Registry v1: hygiene 9 000 (initial) -> "grimy" 2 500 at 150/h — the same
 * deterministic crossing arithmetic body-store.int.test.ts's own
 * HYGIENE_CROSSING constant uses (156 000s). */
const HYGIENE_CROSSING_SECONDS = ((9_000 - 2_500) / 150) * 3_600;

function initializeBodyCommand(
  ids: { branchId: string },
  name: string,
  actorId: string,
) {
  return command(ids, name, "initialize_actor_body", gmPrincipal, {
    actorId,
    registryVersion: "body-v1",
    baselineOverrides: {},
  });
}

async function itemConditionRows(branchId: string, itemId: string) {
  const meterRows = await db()
    .select()
    .from(simItemConditionMeters)
    .where(
      and(
        eq(simItemConditionMeters.branchId, branchId),
        eq(simItemConditionMeters.itemId, itemId),
      ),
    )
    .orderBy(asc(simItemConditionMeters.meterKey));
  const modifierRows = await db()
    .select()
    .from(simItemConditionModifiers)
    .where(
      and(
        eq(simItemConditionModifiers.branchId, branchId),
        eq(simItemConditionModifiers.itemId, itemId),
      ),
    )
    .orderBy(asc(simItemConditionModifiers.modifierId));
  return {
    meters: meterRows.map(itemConditionMeterFromRow),
    modifiers: modifierRows.map(itemConditionModifierFromRow),
  };
}

async function bodyRhythmRows(branchId: string, actorId: string) {
  const rows = await db()
    .select()
    .from(simBodyRhythms)
    .where(
      and(
        eq(simBodyRhythms.branchId, branchId),
        eq(simBodyRhythms.actorId, actorId),
      ),
    )
    .orderBy(asc(simBodyRhythms.kind), asc(simBodyRhythms.startMinuteOfDay));
  return rows.map(bodyRhythmFromRow);
}

describe.runIf(harness.ready)(
  "Gate 5 exit corpus (deterministic, zero model calls)",
  () => {
    // -------------------------------------------------------------------------
    // 1 — Explain-why: a body. Why she is wrecked at 2am: an authored rhythm, a
    // real (but too-short) sleep, circadian escalation while awake past it, and
    // collapse arming — reconstructed purely from events + §6.4 derivation
    // blocks, and the narrative-facing read (the collapse beat's signed energy
    // read) matches the reconstructed chain.
    // -------------------------------------------------------------------------
    it("EXIT 1 — reconstructs why a body collapses from causationId + §6.4 derivation blocks alone, and the read matches the beat", async () => {
      const ids = await seedCorpusCase();
      await seedSleepOnlyRhythm(ids.branchId, ids.mara);
      const init = await submitDurableInitializeActorBody(
        initializeBodyCommand(ids, "init-mara", ids.mara),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(init, "body init");

      // A real, but short, nap: this is the ONLY way a collapse alarm ever
      // arms (an assumed-rhythm actor who never really sleeps never
      // escalates, body-store.int.test.ts's own precedent).
      const nap = await submitDurableApplyBodyCondition(
        command(ids, "nap", "apply_body_condition", playerPrincipal(ids.mara), {
          actorId: ids.mara,
          conditionKey: "asleep",
          durationSeconds: 5_400,
          modifiers: [],
          observerActorIds: [],
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(nap, "the nap");
      const wakeAt = SEED_SECOND + 5_400;
      const wakeDrain = await advanceBranchStoryTime(ids.branchId, wakeAt, {
        workerId: "w-gate5-wake",
      });
      expect(wakeDrain.status).toBe("advanced");

      const collapseAlarm = (
        await pendingTriggers(ids.branchId, "body_collapse_due")
      ).find((trigger) => trigger.state === "pending");
      if (!collapseAlarm) throw new Error("collapse alarm missing after wake");
      // The emergent ~40h escalation (chat-meter-economy.spec's OQ1) — never a
      // hardcoded hour, just bounded between one and two full days awake.
      expect(collapseAlarm.dueStorySecond).toBeGreaterThan(wakeAt + 24 * 3_600);
      expect(collapseAlarm.dueStorySecond).toBeLessThan(wakeAt + 48 * 3_600);

      // Drain far enough to cover BOTH the collapse alarm and hygiene's
      // deterministic "grimy" crossing (uncontested — no wash in this rhythm),
      // whichever lands later, so the causal chain always has at least one
      // real threshold crossing to walk alongside the collapse itself.
      const drainTarget = Math.max(
        collapseAlarm.dueStorySecond,
        SEED_SECOND + HYGIENE_CROSSING_SECONDS + 60,
      );
      const collapseDrain = await advanceBranchStoryTime(
        ids.branchId,
        drainTarget,
        {
          workerId: "w-gate5-collapse",
        },
      );
      expect(collapseDrain.status).toBe("advanced");

      // Walk the causal chain purely from the committed event log.
      const events = await readBranchEvents(ids.branchId);
      const napApplied = events.find(
        (event) => event.type === "body_condition_applied",
      );
      if (napApplied?.type !== "body_condition_applied")
        throw new Error("nap application event missing");
      const wakeEnded = events.find(
        (event) => event.type === "body_condition_ended",
      );
      if (wakeEnded?.type !== "body_condition_ended")
        throw new Error("wake event missing");
      expect(wakeEnded.payload.conditionId).toBe(
        napApplied.payload.conditionId,
      );

      const sleepCredit = events.find(
        (event) =>
          event.type === "body_source_applied" &&
          event.payload.sourceKind === "sleep_credit",
      );
      if (sleepCredit?.type !== "body_source_applied")
        throw new Error("sleep_credit event missing");
      expect(sleepCredit.causationId).toBe(wakeEnded.id);
      expect(sleepCredit.payload.derived).toMatchObject({
        fromStorySecond: expect.any(Number),
        registryVersion: expect.any(String),
      });

      const collapseArm = events.find(
        (event) =>
          event.type === "trigger_scheduled" &&
          event.payload.kind === "body_collapse_due",
      );
      if (collapseArm?.type !== "trigger_scheduled")
        throw new Error("collapse arming event missing");
      // The alarm that fires is causation-chained to the very wake that started
      // its countdown — the "missed sleep window" IS the absence of any
      // further apply_body_condition("asleep") between this wake and collapse.
      expect(collapseArm.causationId).toBe(wakeEnded.id);
      expect(collapseArm.payload.dueStorySecond).toBe(
        collapseAlarm.dueStorySecond,
      );

      // At least one threshold crossing (energy's "depleted", uncontested by
      // any wash reset) fires en route, each carrying a real §6.4 block.
      const thresholdCrossings = events.filter(
        (event) => event.type === "body_threshold_crossed",
      );
      expect(thresholdCrossings.length).toBeGreaterThanOrEqual(1);
      for (const crossing of thresholdCrossings) {
        if (crossing.type !== "body_threshold_crossed") continue;
        expect(crossing.payload.derived).toMatchObject({
          fromStorySecond: expect.any(Number),
          registryVersion: expect.any(String),
        });
      }

      const collapsed = events.find((event) => event.type === "body_collapsed");
      if (collapsed?.type !== "body_collapsed")
        throw new Error("body_collapsed event missing");
      expect(collapsed.payload.derived).toMatchObject({
        fromStorySecond: expect.any(Number),
        registryVersion: expect.any(String),
      });
      // Iris, co-located, is captured as a trusted witness.
      expect(collapsed.payload.observerActorIds).toContain(ids.iris);

      // The narrative-facing read matches the reconstructed chain: the
      // collapse beat's own signed read recomputes to the "collapsing" band —
      // the same pure function the narrator's cut would use.
      const recomputed = deriveEnergyRead({
        reserveFixedPoint: collapsed.payload.reserveFixedPoint,
        pressureFixedPoint: collapsed.payload.pressureFixedPoint,
      });
      expect(recomputed.signedFixedPoint).toBe(
        collapsed.payload.readSignedFixedPoint,
      );
      expect(recomputed.band).toBe("collapsing");
      expect(collapsed.payload.readSignedFixedPoint).toBeLessThanOrEqual(
        -10_000,
      );
    });

    // -------------------------------------------------------------------------
    // 2 — Explain-why: an item. Where the last meal went: household stock lot
    // -> §27.2 promotion (allowance debited, instantiation event) -> held ->
    // consumed -> body_source_applied, fully reconstructable and conserved.
    // -------------------------------------------------------------------------
    it("EXIT 2 — reconstructs where the last meal went: stock -> promotion -> held -> consumed -> body effect, conserved", async () => {
      const ids = await seedCorpusCase();
      await submitDurableInitializeActorBody(
        initializeBodyCommand(ids, "init-mara-meal", ids.mara),
        ADMIT_AT_LOCKED_VERSION,
      );

      const householdId = newId();
      const householdLocus = lotLocusSchema.parse({
        kind: "household",
        householdId,
      });
      await submitDurableCreateHousehold(
        command(ids, "create-household", "create_household", gmPrincipal, {
          householdId,
          name: "Mara's household",
          residenceZoneIds: [ids.zoneHome],
          stockAccessPolicy: { kind: "members_only" },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      await submitDurableSetHouseholdMembership(
        command(ids, "member-mara", "set_household_membership", gmPrincipal, {
          householdId,
          actorId: ids.mara,
          role: "resident",
          status: "active",
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      const stocked = await submitDurableAdjustMaterialLot(
        command(ids, "stock-bread", "adjust_material_lot", gmPrincipal, {
          locus: householdLocus,
          materialKindKey: "bread",
          deltaRaw: 10,
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(stocked, "stocking bread");

      const promote = await submitDurablePromoteItemFromStock(
        command(
          ids,
          "promote-loaf",
          "promote_item_from_stock",
          playerPrincipal(ids.mara),
          {
            actorId: ids.mara,
            funding: {
              kind: "stock",
              sourceLocus: householdLocus,
              quantityRaw: 1,
            },
            item: {
              name: "the last loaf",
              materialKindKey: "bread",
              consumptionEffects: [
                {
                  meterKey: "energy",
                  sourceKind: "meal",
                  operation: { kind: "set", valueFixedPoint: 9_999 },
                },
              ],
            },
          },
        ),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(promote, "item promotion");

      const events1 = await readBranchEvents(ids.branchId);
      const lotDebit = events1.find(
        (event) =>
          event.type === "material_lot_adjusted" &&
          event.payload.reason === "promotion_cost",
      );
      if (lotDebit?.type !== "material_lot_adjusted")
        throw new Error("promotion debit event missing");
      expect(lotDebit.payload.deltaRaw).toBe(-1);
      const instantiated = events1.find(
        (event) => event.type === "item_instantiated_from_promotion",
      );
      if (instantiated?.type !== "item_instantiated_from_promotion")
        throw new Error("instantiation event missing");
      expect(instantiated.causationId).toBe(lotDebit.id);
      expect(instantiated.payload.item.locus).toEqual({
        kind: "held",
        actorId: ids.mara,
      });
      const itemId = instantiated.payload.item.id;

      const [holdingRow] = await db()
        .select()
        .from(simItemHoldings)
        .where(
          and(
            eq(simItemHoldings.branchId, ids.branchId),
            eq(simItemHoldings.itemId, itemId),
          ),
        );
      expect(holdingRow).toMatchObject({
        locusKind: "held",
        actorId: ids.mara,
      });

      const lotKey = deriveMaterialLotRowKey(householdLocus, "bread");
      const lotAfterPromotion = await db()
        .select()
        .from(simMaterialLots)
        .where(
          and(
            eq(simMaterialLots.branchId, ids.branchId),
            eq(simMaterialLots.lotKey, lotKey),
          ),
        );
      expect(lotAfterPromotion[0]).toMatchObject({ quantityRaw: 9 });

      const consumed = await submitDurableConsumeItem(
        command(ids, "eat-loaf", "consume_item", playerPrincipal(ids.mara), {
          actorId: ids.mara,
          itemId,
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(consumed, "eating the loaf");

      const events2 = await readBranchEvents(ids.branchId);
      const consumedEvent = events2.find(
        (event) => event.type === "item_consumed",
      );
      if (consumedEvent?.type !== "item_consumed")
        throw new Error("item_consumed event missing");
      const sourceApplied = events2.find(
        (event) =>
          event.type === "body_source_applied" &&
          event.payload.sourceKind === "meal",
      );
      if (sourceApplied?.type !== "body_source_applied")
        throw new Error("meal body_source_applied event missing");
      expect(sourceApplied.causationId).toBe(consumedEvent.id);
      expect(sourceApplied.payload).toMatchObject({
        actorId: ids.mara,
        meterKey: "energy",
        valueAfterFixedPoint: 9_999,
      });

      const [holdingAfter] = await db()
        .select()
        .from(simItemHoldings)
        .where(
          and(
            eq(simItemHoldings.branchId, ids.branchId),
            eq(simItemHoldings.itemId, itemId),
          ),
        );
      expect(holdingAfter).toMatchObject({
        locusKind: "gone",
        goneBasis: "consumed",
      });

      const [meterRow] = await db()
        .select()
        .from(simBodyMeters)
        .where(
          and(
            eq(simBodyMeters.branchId, ids.branchId),
            eq(simBodyMeters.meterKey, "energy"),
          ),
        );
      expect(meterRow).toMatchObject({ valueFixedPoint: 9_999 });

      // Conservation: every "bread"-kind lot delta sums to the final balance.
      const breadDeltas = events2
        .filter(
          (event) =>
            event.type === "material_lot_adjusted" &&
            event.payload.materialKindKey === "bread",
        )
        .map((event) =>
          event.type === "material_lot_adjusted" ? event.payload.deltaRaw : 0,
        );
      const finalLot = await db()
        .select()
        .from(simMaterialLots)
        .where(
          and(
            eq(simMaterialLots.branchId, ids.branchId),
            eq(simMaterialLots.lotKey, lotKey),
          ),
        );
      expect(breadDeltas.reduce((sum, delta) => sum + delta, 0)).toBe(
        finalLot[0]?.quantityRaw,
      );
    });

    // -------------------------------------------------------------------------
    // 3 — Explain-why: a household. Stock depleted through promotion, restocked
    // through the scheduler drain, quantities balance transactionally at every
    // step: same-kind conservation, a cross-kind purchase pair causally
    // linked, and the means-band top-up as the one sanctioned unconserved
    // credit (§26.9).
    // -------------------------------------------------------------------------
    it("EXIT 3 — a household's stock balances at every step: same-kind conservation, a linked cross-kind purchase, and the one unconserved means-band credit", async () => {
      const ids = await seedCorpusCase();
      const householdId = newId();
      const householdLocus = lotLocusSchema.parse({
        kind: "household",
        householdId,
      });
      await submitDurableCreateHousehold(
        command(ids, "create-hh3", "create_household", gmPrincipal, {
          householdId,
          name: "Vance household",
          residenceZoneIds: [ids.zoneHome],
          stockAccessPolicy: { kind: "members_only" },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      await submitDurableSetHouseholdMembership(
        command(ids, "member-mara3", "set_household_membership", gmPrincipal, {
          householdId,
          actorId: ids.mara,
          role: "resident",
          status: "active",
        }),
        ADMIT_AT_LOCKED_VERSION,
      );

      // Means-band-funded "tea" routine, fired FIRST — while the household is
      // still genuinely band-tracked (no currency lot exists yet; §26.10's
      // structural precedence means a lot, once initialized, would otherwise
      // win over the band unconditionally).
      await submitDurableSetMeansBand(
        command(ids, "set-band", "set_means_band", gmPrincipal, {
          subject: { kind: "household", householdId },
          bandKey: "comfortable",
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      await submitDurableConfigureRestockRoutine(
        command(
          ids,
          "configure-tea",
          "configure_restock_routine",
          gmPrincipal,
          {
            householdId,
            materialKindKey: "tea",
            targetQuantityRaw: 10,
            lowWaterThresholdRaw: 2,
            cadenceSeconds: 100,
            funding: { kind: "means_band_envelope", minimumBandKey: "modest" },
            active: true,
          },
        ),
        ADMIT_AT_LOCKED_VERSION,
      );
      const teaAlarm = (
        await pendingTriggers(ids.branchId, "household_restock_due")
      ).find((t) => t.state === "pending");
      if (!teaAlarm) throw new Error("tea restock alarm missing");
      const teaDrain = await advanceBranchStoryTime(
        ids.branchId,
        teaAlarm.dueStorySecond,
        { workerId: "w-gate5-tea" },
      );
      expect(teaDrain.status).toBe("advanced");

      const teaLotKey = deriveMaterialLotRowKey(householdLocus, "tea");
      const teaLot = await db()
        .select()
        .from(simMaterialLots)
        .where(
          and(
            eq(simMaterialLots.branchId, ids.branchId),
            eq(simMaterialLots.lotKey, teaLotKey),
          ),
        );
      expect(teaLot[0]).toMatchObject({ quantityRaw: 10 });
      const teaCreditEvents = (await readBranchEvents(ids.branchId)).filter(
        (event) =>
          event.type === "material_lot_adjusted" &&
          event.payload.materialKindKey === "tea",
      );
      expect(teaCreditEvents).toHaveLength(1);
      if (teaCreditEvents[0]?.type !== "material_lot_adjusted")
        throw new Error("tea credit event missing");
      expect(teaCreditEvents[0].payload.reason).toBe(
        "restock_topup_unconserved",
      );
      expect(teaCreditEvents[0].causationId).toBeUndefined();
      // The one sanctioned unconserved credit: no currency lot exists at all.
      const currencyLotKey = deriveMaterialLotRowKey(
        householdLocus,
        RESERVED_CURRENCY_MATERIAL_KIND,
      );
      const noCurrencyLotYet = await db()
        .select()
        .from(simMaterialLots)
        .where(
          and(
            eq(simMaterialLots.branchId, ids.branchId),
            eq(simMaterialLots.lotKey, currencyLotKey),
          ),
        );
      expect(noCurrencyLotYet).toHaveLength(0);

      // Now the household becomes lot-tracked: fund currency + bread stock,
      // promote one loaf (consumption/promotion depleting stock), then a
      // lot-funded "bread" restock routine crosses its low-water threshold
      // TWICE across a promotion and a further depletion — every step
      // conserved within its own kind, the cross-kind purchase pair
      // causation-linked in one transaction.
      await submitDurableAdjustMaterialLot(
        command(ids, "fund-currency", "adjust_material_lot", gmPrincipal, {
          locus: householdLocus,
          materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
          deltaRaw: 100_000,
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      await submitDurableAdjustMaterialLot(
        command(ids, "stock-bread3", "adjust_material_lot", gmPrincipal, {
          locus: householdLocus,
          materialKindKey: "bread",
          deltaRaw: 10,
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      const promote = await submitDurablePromoteItemFromStock(
        command(
          ids,
          "promote-loaf3",
          "promote_item_from_stock",
          playerPrincipal(ids.mara),
          {
            actorId: ids.mara,
            funding: {
              kind: "stock",
              sourceLocus: householdLocus,
              quantityRaw: 1,
            },
            item: { name: "a loaf", materialKindKey: "bread" },
          },
        ),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(promote, "item promotion"); // bread: 10 - 1 = 9

      await submitDurableConfigureRestockRoutine(
        command(
          ids,
          "configure-bread",
          "configure_restock_routine",
          gmPrincipal,
          {
            householdId,
            materialKindKey: "bread",
            targetQuantityRaw: 20,
            lowWaterThresholdRaw: 5,
            cadenceSeconds: 3_600,
            funding: {
              kind: "lot",
              currencyLocus: householdLocus,
              unitPriceRaw: 10,
            },
            active: true,
          },
        ),
        ADMIT_AT_LOCKED_VERSION,
      );
      const [breadAlarm1] = (
        await pendingTriggers(ids.branchId, "household_restock_due")
      ).filter(
        (t) => t.state === "pending" && t.uniquenessKey.includes("bread"),
      );
      if (!breadAlarm1) throw new Error("first bread restock alarm missing");
      await advanceBranchStoryTime(ids.branchId, breadAlarm1.dueStorySecond, {
        workerId: "w-gate5-bread-1",
      });
      // bread: 9 -> 20 (delta 11, cost 110)

      await submitDurableAdjustMaterialLot(
        command(ids, "deplete-bread", "adjust_material_lot", gmPrincipal, {
          locus: householdLocus,
          materialKindKey: "bread",
          deltaRaw: -15,
        }),
        ADMIT_AT_LOCKED_VERSION,
      ); // bread: 20 -> 5, at the low-water line

      const [breadAlarm2] = (
        await pendingTriggers(ids.branchId, "household_restock_due")
      ).filter(
        (t) => t.state === "pending" && t.uniquenessKey.includes("bread"),
      );
      if (!breadAlarm2) throw new Error("second bread restock alarm missing");
      await advanceBranchStoryTime(ids.branchId, breadAlarm2.dueStorySecond, {
        workerId: "w-gate5-bread-2",
      });
      // bread: 5 -> 20 (delta 15, cost 150)

      const finalEvents = await readBranchEvents(ids.branchId);
      const restockPurchasePairs = finalEvents.filter(
        (event) =>
          event.type === "material_lot_adjusted" &&
          event.payload.reason === "restock_purchase",
      );
      expect(restockPurchasePairs).toHaveLength(4); // 2 cycles x (currency debit + bread credit)
      for (let i = 0; i < restockPurchasePairs.length; i += 2) {
        const debit = restockPurchasePairs[i];
        const credit = restockPurchasePairs[i + 1];
        if (
          debit?.type !== "material_lot_adjusted" ||
          credit?.type !== "material_lot_adjusted"
        )
          continue;
        expect(debit.payload.materialKindKey).toBe(
          RESERVED_CURRENCY_MATERIAL_KIND,
        );
        expect(debit.payload.deltaRaw).toBeLessThan(0);
        expect(credit.payload.materialKindKey).toBe("bread");
        expect(credit.payload.deltaRaw).toBeGreaterThan(0);
        // The §26.9 causally-linked cross-kind pair, in the SAME transaction.
        expect(credit.causationId).toBe(debit.id);
      }

      // Same-kind conservation: every "bread" delta sums to the live balance.
      const breadLotKey = deriveMaterialLotRowKey(householdLocus, "bread");
      const breadDeltas = finalEvents
        .filter(
          (event) =>
            event.type === "material_lot_adjusted" &&
            event.payload.materialKindKey === "bread",
        )
        .map((event) =>
          event.type === "material_lot_adjusted" ? event.payload.deltaRaw : 0,
        );
      const finalBreadLot = await db()
        .select()
        .from(simMaterialLots)
        .where(
          and(
            eq(simMaterialLots.branchId, ids.branchId),
            eq(simMaterialLots.lotKey, breadLotKey),
          ),
        );
      expect(breadDeltas.reduce((sum, delta) => sum + delta, 0)).toBe(
        finalBreadLot[0]?.quantityRaw,
      );
      expect(finalBreadLot[0]?.quantityRaw).toBe(20);

      const currencyDeltas = finalEvents
        .filter(
          (event) =>
            event.type === "material_lot_adjusted" &&
            event.payload.materialKindKey === RESERVED_CURRENCY_MATERIAL_KIND,
        )
        .map((event) =>
          event.type === "material_lot_adjusted" ? event.payload.deltaRaw : 0,
        );
      const finalCurrencyLot = await db()
        .select()
        .from(simMaterialLots)
        .where(
          and(
            eq(simMaterialLots.branchId, ids.branchId),
            eq(simMaterialLots.lotKey, currencyLotKey),
          ),
        );
      expect(currencyDeltas.reduce((sum, delta) => sum + delta, 0)).toBe(
        finalCurrencyLot[0]?.quantityRaw,
      );
    });

    // -------------------------------------------------------------------------
    // 4 — Explain-why: a relationship. Promise made (destinationless) -> missed
    // -> ledger entries with provenance -> the trust read moves per the weight
    // registry -> a repair commitment -> the read recovers; every entry's
    // sourceEventId chain resolves to a real event.
    // -------------------------------------------------------------------------
    it("EXIT 4 — a promise missed and repaired moves the trust read per the weight registry, every entry traceable to its causing event", async () => {
      const ids = await seedCorpusCase();
      const promiseCmd = (name: string, overrides: Record<string, unknown>) =>
        command(ids, name, "create_commitment", playerPrincipal(ids.mara), {
          actorId: ids.mara,
          kind: "promise",
          promisedToActorId: ids.iris,
          window: { latestArrival: SEED_SECOND + 100 },
          priority: 0,
          flexibility: "soft",
          preparationSeconds: 0,
          reliabilityBufferSeconds: 0,
          noticeLeadSeconds: 0,
          knowledgeSource: { kind: "authored" },
          ...overrides,
        });

      const createA = await submitDurableCreateCommitment(
        promiseCmd("promise-a", {}),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(createA, "commitment A");
      const commitmentAId = deriveCommitmentId(
        ids.branchId,
        `cmd-promise-a-${ids.branchId}`,
      );

      const missDrain = await advanceBranchStoryTime(
        ids.branchId,
        SEED_SECOND + 200,
        { workerId: "w-gate5-miss" },
      );
      expect(missDrain.status).toBe("advanced");

      const projectionAfterMiss = await loadRelationshipLedgerProjection(
        ids.branchId,
      );
      const missedEntry = projectionAfterMiss.find(
        (entry) => entry.kind === "promise_missed",
      );
      if (!missedEntry) throw new Error("promise_missed entry missing");
      expect(missedEntry).toMatchObject({
        fromActorId: ids.mara,
        toActorId: ids.iris,
        provenance: "derived",
      });

      // The entry's sourceEventId resolves to a real, causing event.
      const [missedSourceRow] = await db()
        .select({ type: simEvents.type })
        .from(simEvents)
        .where(
          and(
            eq(simEvents.branchId, ids.branchId),
            eq(simEvents.id, missedEntry.sourceEventId),
          ),
        );
      expect(missedSourceRow?.type).toBe("commitment_missed");

      const readAfterMiss = deriveRelationshipRead({
        entries: [missedEntry],
        subjectActorId: ids.iris,
        aboutActorId: ids.mara,
        atStorySecond: missedEntry.storySecond,
      });
      expect(readAfterMiss.trustFixedPoint).toBe(
        relationshipLedgerWeightRegistryV1.promise_missed.trustFixedPoint,
      );
      expect(readAfterMiss.trustFixedPoint).toBeLessThan(0);

      // A repair commitment: creation itself lands the promise_repaired entry.
      const createB = await submitDurableCreateCommitment(
        promiseCmd("promise-b", {
          repairsCommitmentId: commitmentAId,
          window: { latestArrival: SEED_SECOND + 5_000 },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(createB, "commitment B");

      const projectionAfterRepair = await loadRelationshipLedgerProjection(
        ids.branchId,
      );
      const repairedEntry = projectionAfterRepair.find(
        (entry) => entry.kind === "promise_repaired",
      );
      if (!repairedEntry) throw new Error("promise_repaired entry missing");
      expect(repairedEntry).toMatchObject({
        fromActorId: ids.mara,
        toActorId: ids.iris,
        provenance: "derived",
      });
      const [repairedSourceRow] = await db()
        .select({ type: simEvents.type, payload: simEvents.payload })
        .from(simEvents)
        .where(
          and(
            eq(simEvents.branchId, ids.branchId),
            eq(simEvents.id, repairedEntry.sourceEventId),
          ),
        );
      expect(repairedSourceRow?.type).toBe("commitment_created");
      expect(
        (repairedSourceRow?.payload as { repairsCommitmentId?: string })
          ?.repairsCommitmentId,
      ).toBe(commitmentAId);

      // The read recovers: strictly higher than right after the miss, even
      // though it never fully clears the miss's damage (200 - 2000 + 800).
      const readAfterRepair = deriveRelationshipRead({
        entries: [missedEntry, repairedEntry],
        subjectActorId: ids.iris,
        aboutActorId: ids.mara,
        atStorySecond: repairedEntry.storySecond,
      });
      expect(readAfterRepair.trustFixedPoint).toBeGreaterThan(
        readAfterMiss.trustFixedPoint,
      );
      expect(readAfterRepair.trustFixedPoint).toBe(
        relationshipLedgerWeightRegistryV1.promise_missed.trustFixedPoint +
          relationshipLedgerWeightRegistryV1.promise_repaired.trustFixedPoint,
      );
    });

    // -------------------------------------------------------------------------
    // 5a — Narrator-boundary sweep: hidden arousal / another actor's raw
    // meters never enter any cut surface (structural absence — the schema has
    // no such field, not merely an empty one); a close-range (co-located)
    // witness gets exactly the perceivable sign tier.
    // -------------------------------------------------------------------------
    it("EXIT 5a — hidden arousal never reaches any cut as a raw meter; a co-located witness gets only the perceivable sign tier", async () => {
      const ids = await seedCorpusCase();
      await seedRhythms(ids.branchId, ids.mara);
      await submitDurableInitializeActorBody(
        initializeBodyCommand(ids, "init-mara-signs", ids.mara),
        ADMIT_AT_LOCKED_VERSION,
      );
      const arouse = await submitDurableApplyBodySource(
        command(ids, "arouse", "apply_body_source", playerPrincipal(ids.mara), {
          actorId: ids.mara,
          meterKey: "arousal",
          sourceKind: "adjustment",
          operation: { kind: "add", deltaFixedPoint: 7_000 },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(arouse, "arousal source");

      const opened = await submitDurableOpenEngagement(
        command(ids, "scene", "open_engagement", playerPrincipal(ids.player), {
          participantIds: [ids.player, ids.mara, ids.iris].sort(),
          channel: "co_present",
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(opened, "scene open");
      const engagementId = deriveEngagementId(
        ids.branchId,
        `cmd-scene-${ids.branchId}`,
      );

      const playerTurn = await prepareEngagementTurn({
        branchId: ids.branchId,
        engagementId,
        viewpointActorId: ids.player,
        spanSeconds: TURN_SPAN,
        workerId: "w-gate5-signs-player",
      });
      // Structural absence: the ONLY numeric surface on a co-present observed
      // entry is `signs` (a closed sign vocabulary) — there is no
      // arousalFixedPoint field anywhere in the type for a raw value to leak
      // through, and the exact perceivable-tier signs match the precedent
      // (body-store.int.test.ts: +7 000 arousal -> flushed_skin + quickened_breath).
      const maraObserved = playerTurn.cut.bodilyReads.observed.find(
        (entry) => entry.actorId === ids.mara,
      );
      expect(maraObserved?.signs).toEqual([
        "flushed_skin",
        "quickened_breath",
      ]);
      // A SUBSET check, deliberately, not an exact key list: the redaction
      // proof is the serialized-cut `not.toContain` pair immediately below
      // (no raw meter name and no raw value anywhere in the prompt input), so
      // a future optional field on an observed entry must not fail this case.
      expect(maraObserved).toMatchObject({ actorId: ids.mara });
      expect(JSON.stringify(playerTurn.cut)).not.toContain("arousalFixedPoint");
      expect(JSON.stringify(playerTurn.cut)).not.toContain("7000");

      // Mara's own viewpoint and Iris's witness view, read at the SAME story
      // second the player's turn already used (a fresh `prepareEngagementTurn`
      // per viewpoint would each advance the engagement's own clock further,
      // decaying the arousal load meter cumulatively — the pure seam below is
      // exactly what each of those cuts compiles its `bodilyReads` FROM,
      // so reading it directly at one fixed second is the apples-to-apples
      // comparison, mirroring the noor negative control just below).
      const atSecond = playerTurn.cut.throughStorySecond;
      const maraSelfView = await computeEngagementBodilyReads(db(), {
        branchId: ids.branchId,
        storySecond: atSecond,
        viewpointActorId: ids.mara,
        coPresentActorIds: [ids.player, ids.iris],
      });
      // Mara's own viewpoint gets full self-transparency (energy band/intimacy
      // phase), never the observed-sign redaction of her own body: a fresh
      // daytime energy read (bright) alongside the same +7 000 arousal that
      // reads "wound_tight" (>= 6 500, < 8 500, no afterglow).
      // Subset again: the three fields below ARE the self-transparency claim;
      // a later addition to the self read must not break it.
      expect(maraSelfView.self).toMatchObject({
        energySignedFixedPoint: 7_687,
        energyBand: "bright",
        intimacyPhase: "wound_tight",
      });

      // Iris, co-located, is a close-range witness and gets exactly the same
      // perceivable tier as the player — never a richer or a numeric read.
      const irisView = await computeEngagementBodilyReads(db(), {
        branchId: ids.branchId,
        storySecond: atSecond,
        viewpointActorId: ids.iris,
        coPresentActorIds: [ids.player, ids.mara],
      });
      const irisObservedMara = irisView.observed.find(
        (entry) => entry.actorId === ids.mara,
      );
      expect(irisObservedMara?.signs).toEqual(maraObserved?.signs);

      // Noor, in a wholly separate location, never shared a scene with Mara at
      // all — a direct check of the SAME pure seam a cut compiles from proves
      // the absence is structural (no co-presence -> no `observed` entry),
      // not merely an empty result from an unrelated cut.
      const noorView = await computeEngagementBodilyReads(db(), {
        branchId: ids.branchId,
        storySecond: SEED_SECOND,
        viewpointActorId: ids.noor,
        coPresentActorIds: [],
      });
      expect(noorView.observed).toEqual([]);
      expect(noorView.self).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // 5b — Narrator-boundary sweep: consent/boundary knowledge respects the
    // ledger's dyad — a third party who never witnessed the boundary speech
    // act (a different LOCATION entirely, per material-store.int.test.ts's own
    // cross-zone-sound caveat) has no trace of it in cut, serialized prompt
    // input, or retrieval, even when explicitly queried for it.
    // -------------------------------------------------------------------------
    it("EXIT 5b — a stated boundary is a real causal ledger entry, but a third party who never witnessed it has no trace in cut, prompt input, or retrieval", async () => {
      const ids = await seedCorpusCase();
      const opened = await submitDurableOpenEngagement(
        command(ids, "chat5b", "open_engagement", playerPrincipal(ids.player), {
          participantIds: [ids.player, ids.mara].sort(),
          channel: "co_present",
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(opened, "scene open");
      const engagementId = deriveEngagementId(
        ids.branchId,
        `cmd-chat5b-${ids.branchId}`,
      );
      // A remote scene gives Noor her own cut/retrieval surface, mirroring
      // gate4-corpus.int.test.ts's EXIT 1 idiom exactly.
      const sideOpened = await submitDurableOpenEngagement(
        command(ids, "side5b", "open_engagement", playerPrincipal(ids.noor), {
          participantIds: [ids.noor, ids.ben].sort(),
          channel: "text",
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(sideOpened, "remote scene open");
      const sideEngagementId = deriveEngagementId(
        ids.branchId,
        `cmd-side5b-${ids.branchId}`,
      );

      const turn = await prepareEngagementTurn({
        branchId: ids.branchId,
        engagementId,
        viewpointActorId: ids.player,
        spanSeconds: TURN_SPAN,
        workerId: "w-gate5-boundary",
        proposedArmedEffects: [
          proposedArmedEffectSchema.parse({
            effectType: "boundary_expressed",
            actorId: ids.mara,
            targetActorIds: [ids.player],
            detail: "Mara says touch is fine but nothing further tonight.",
            consentScopeKey: "touch_intimate",
          }),
        ],
      });
      const effect = turn.cut.armedEffects.find(
        (candidate) => candidate.effectType === "boundary_expressed",
      );
      if (!effect)
        throw new Error("boundary_expressed effect missing from cut");
      const confirmed = await submitDurableConfirmNarratorResult(
        command(ids, "confirm5b", "confirm_narrator_result", systemPrincipal, {
          engagementId,
          cutId: turn.cut.id,
          enactedArmedEffectIds: [effect.id],
          softCanonProposals: [],
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(confirmed, "narrator confirmation");
      const throughStorySecond = turn.cut.throughStorySecond;
      await drainMemoryIndexOutbox({ workerId: "w-gate5-boundary-drain" });

      // The causal record is real and dyadic.
      const projection = await loadRelationshipLedgerProjection(ids.branchId);
      const boundary = projection.find(
        (entry) => entry.kind === "boundary_stated",
      );
      expect(boundary).toMatchObject({
        fromActorId: ids.mara,
        toActorId: ids.player,
        provenance: "derived",
        payload: { kind: "consent", scopeKey: "touch_intimate" },
      });

      // The player (a named target) sees it in the SAME turn's cut — the
      // literal narrator prompt input for the turn that spoke it — and holds a
      // real witnessed observation of the underlying speech act.
      expect(JSON.stringify(turn.cut)).toContain("touch_intimate");
      const speechActEvent = (await readBranchEvents(ids.branchId)).find(
        (event) =>
          event.type === "speech_act_delivered" &&
          event.payload.effectType === "boundary_expressed",
      );
      if (speechActEvent?.type !== "speech_act_delivered")
        throw new Error("boundary speech act event missing");
      const [playerObservation] = await db()
        .select()
        .from(simObservations)
        .where(
          and(
            eq(simObservations.branchId, ids.branchId),
            eq(simObservations.sourceEventId, speechActEvent.id),
            eq(simObservations.witnessActorId, ids.player),
          ),
        );
      expect(playerObservation).toBeDefined();

      // Noor — a different LOCATION entirely, never a scene participant, never
      // co-located — has no trace in her own cut, even asking about it.
      const noorTurn = await prepareEngagementTurn({
        branchId: ids.branchId,
        engagementId: sideEngagementId,
        viewpointActorId: ids.noor,
        spanSeconds: TURN_SPAN,
        workerId: "w-gate5-boundary-noor",
      });
      expect(JSON.stringify(noorTurn.cut)).not.toContain("touch_intimate");
      expect(JSON.stringify(noorTurn.cut)).not.toContain("nothing further");
      const [noorObservation] = await db()
        .select()
        .from(simObservations)
        .where(
          and(
            eq(simObservations.branchId, ids.branchId),
            eq(simObservations.sourceEventId, speechActEvent.id),
            eq(simObservations.witnessActorId, ids.noor),
          ),
        );
      expect(noorObservation).toBeUndefined();

      const sweepAt = throughStorySecond + 2 * TURN_SPAN;
      const noorRecall = await queryMemoryDocuments({
        branchId: ids.branchId,
        viewpointActorId: ids.noor,
        atStorySecond: sweepAt,
        limit: 32,
        maxCandidates: 256,
        queryText: "mara boundary touch intimate",
      });
      expect(
        noorRecall.results.map((result) => result.text).join(" | "),
      ).not.toContain("touch");
    });

    // -------------------------------------------------------------------------
    // 6 — Partition invariance for body drift: one big skip is bit-identical
    // to equivalent smaller skips ACROSS material thresholds (a wash window
    // suppressing hygiene's alarm, energy's threshold crossing, and a worn
    // item's cleanliness drift/crossing in the skip span) — because only
    // material transitions ever write (§25's design-by-construction claim).
    // -------------------------------------------------------------------------
    it("EXIT 6 — one big skip is bit-identical to several smaller skips to the same target second, across body and item-condition thresholds alike", async () => {
      const garmentId = newId();
      const ids = await seedCorpusCase((corpusIds) => [
        {
          id: garmentId,
          name: "a linen shirt",
          ownerActorId: null,
          conditionTracked: true,
          locus: { kind: "held", actorId: corpusIds.mara },
        },
      ]);
      await seedRhythms(ids.branchId, ids.mara);
      await submitDurableInitializeActorBody(
        initializeBodyCommand(ids, "init-mara-partition", ids.mara),
        ADMIT_AT_LOCKED_VERSION,
      );
      const don = await submitDurableTransferItem(
        command(ids, "don-garment", "transfer_item", npcPrincipal(ids.mara), {
          actorId: ids.mara,
          itemId: garmentId,
          fromLocus: { kind: "held", actorId: ids.mara },
          toLocus: { kind: "worn", actorId: ids.mara, slotKey: WORN_SLOT },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(don, "donning the garment");

      // Both children fork at the SAME parent head, so the two partitionings
      // start from bit-identical inherited history.
      const { childBranchId: childA } = await forkAtHead({
        parentBranchId: ids.branchId,
        reason: "partition invariance — one big skip",
      });
      harness.trackBranch(childA);
      const { childBranchId: childB } = await forkAtHead({
        parentBranchId: ids.branchId,
        reason: "partition invariance — several small skips",
      });
      harness.trackBranch(childB);

      const target = SEED_SECOND + 3 * 24 * 3_600;
      const bigSkip = await advanceBranchStoryTime(childA, target, {
        workerId: "w-gate5-partition-big",
      });
      expect(bigSkip.status).toBe("advanced");

      const stops = [
        SEED_SECOND + 41_000,
        SEED_SECOND + 97_000,
        SEED_SECOND + 151_000,
        SEED_SECOND + 205_000,
        target,
      ];
      for (const [index, stop] of stops.entries()) {
        const outcome = await advanceBranchStoryTime(childB, stop, {
          workerId: `w-gate5-partition-small-${index}`,
        });
        expect(outcome.status).toBe("advanced");
      }

      const bodiesA = await readDurableBodies(childA);
      const bodiesB = await readDurableBodies(childB);
      expect(bodiesB.storySecond).toBe(bodiesA.storySecond);
      expect(bodiesB.headSequence).toBe(bodiesA.headSequence);
      expect(bodiesB.meters).toEqual(bodiesA.meters);
      expect(bodiesB.conditions).toEqual(bodiesA.conditions);
      expect(bodiesB.modifiers).toEqual(bodiesA.modifiers);

      const itemA = await itemConditionRows(childA, garmentId);
      const itemB = await itemConditionRows(childB, garmentId);
      expect(itemB.meters).toEqual(itemA.meters);
      expect(itemB.modifiers).toEqual(itemA.modifiers);

      // Not a vacuous pass: real crossings actually happened in the skip span.
      const bodyCrossingsA = await db()
        .select({ type: simEvents.type })
        .from(simEvents)
        .where(
          and(
            eq(simEvents.branchId, childA),
            eq(simEvents.type, "body_threshold_crossed"),
          ),
        );
      expect(bodyCrossingsA.length).toBeGreaterThanOrEqual(1);
      const itemCrossingsA = await db()
        .select({ type: simEvents.type })
        .from(simEvents)
        .where(
          and(
            eq(simEvents.branchId, childA),
            eq(simEvents.type, "item_condition_threshold_crossed"),
          ),
        );
      expect(itemCrossingsA.length).toBeGreaterThanOrEqual(1);
      // The wash window mechanic is exercised too: with the reference rhythm,
      // hygiene's own alarm is suppressed outright (body-store.int.test.ts's
      // own "arms crossing-aware alarms" precedent) — no hygiene crossing ever
      // fires, on EITHER partitioning, which is itself part of the invariant.
      const bodyCrossingsB = await db()
        .select({ type: simEvents.type })
        .from(simEvents)
        .where(
          and(
            eq(simEvents.branchId, childB),
            eq(simEvents.type, "body_threshold_crossed"),
          ),
        );
      expect(bodyCrossingsB.length).toBe(bodyCrossingsA.length);
    });

    // -------------------------------------------------------------------------
    // 7 — Rerender-creates-nothing + retry-from-the-same-cut, extended over
    // every NEW persistence surface (households, lots, means, routines,
    // relationship ledger, escalation outcomes) as a row-count invariance
    // sweep alongside re-reading a persisted cut, plus bit-identical retry of
    // an already-accepted command from each domain.
    // -------------------------------------------------------------------------
    it("EXIT 7 — rerendering the same cut and replaying any already-accepted command creates nothing new, across every persistence surface old and new", async () => {
      const ids = await seedCorpusCase();
      await submitDurableInitializeActorBody(
        initializeBodyCommand(ids, "init-mara-7", ids.mara),
        ADMIT_AT_LOCKED_VERSION,
      );

      const householdId = newId();
      const householdLocus = lotLocusSchema.parse({
        kind: "household",
        householdId,
      });
      const createHouseholdCmd = command(
        ids,
        "create-hh7",
        "create_household",
        gmPrincipal,
        {
          householdId,
          name: "Footprint household",
          residenceZoneIds: [ids.zoneHome],
          stockAccessPolicy: { kind: "members_only" },
        },
      );
      expect(
        (await submitDurableCreateHousehold(createHouseholdCmd, ADMIT_AT_LOCKED_VERSION)).status,
      ).toBe("accepted");
      expect(
        (
          await submitDurableSetHouseholdMembership(
            command(
              ids,
              "member-mara7",
              "set_household_membership",
              gmPrincipal,
              {
                householdId,
                actorId: ids.mara,
                role: "resident",
                status: "active",
              },
            ),
            ADMIT_AT_LOCKED_VERSION,
          )
        ).status,
      ).toBe("accepted");
      expect(
        (
          await submitDurableAdjustMaterialLot(
            command(ids, "stock-bread7", "adjust_material_lot", gmPrincipal, {
              locus: householdLocus,
              materialKindKey: "bread",
              deltaRaw: 10,
            }),
            ADMIT_AT_LOCKED_VERSION,
          )
        ).status,
      ).toBe("accepted");
      const promoteCmd = command(
        ids,
        "promote7",
        "promote_item_from_stock",
        playerPrincipal(ids.mara),
        {
          actorId: ids.mara,
          funding: {
            kind: "stock",
            sourceLocus: householdLocus,
            quantityRaw: 1,
          },
          item: { name: "a loaf", materialKindKey: "bread" },
        },
      );
      expect(
        (await submitDurablePromoteItemFromStock(promoteCmd, ADMIT_AT_LOCKED_VERSION)).status,
      ).toBe("accepted");

      expect(
        (
          await submitDurableAdjustMaterialLot(
            command(ids, "fund7", "adjust_material_lot", gmPrincipal, {
              locus: householdLocus,
              materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
              deltaRaw: 100_000,
            }),
            ADMIT_AT_LOCKED_VERSION,
          )
        ).status,
      ).toBe("accepted");
      const configureCmd = command(
        ids,
        "configure7",
        "configure_restock_routine",
        gmPrincipal,
        {
          householdId,
          materialKindKey: "bread",
          targetQuantityRaw: 20,
          lowWaterThresholdRaw: 5,
          cadenceSeconds: 3_600,
          funding: {
            kind: "lot",
            currencyLocus: householdLocus,
            unitPriceRaw: 10,
          },
          active: true,
        },
      );
      expect(
        (await submitDurableConfigureRestockRoutine(configureCmd, ADMIT_AT_LOCKED_VERSION))
          .status,
      ).toBe("accepted");

      const promiseCmd = command(
        ids,
        "promise7",
        "create_commitment",
        playerPrincipal(ids.mara),
        {
          actorId: ids.mara,
          kind: "promise",
          promisedToActorId: ids.iris,
          window: { latestArrival: SEED_SECOND + 100 },
          priority: 0,
          flexibility: "soft",
          preparationSeconds: 0,
          reliabilityBufferSeconds: 0,
          noticeLeadSeconds: 0,
          knowledgeSource: { kind: "authored" },
        },
      );
      const created = await submitDurableCreateCommitment(promiseCmd, ADMIT_AT_LOCKED_VERSION);
      expectAccepted(created, "household creation");
      const commitmentId = deriveCommitmentId(
        ids.branchId,
        `cmd-promise7-${ids.branchId}`,
      );
      const fulfillCmd = command(
        ids,
        "fulfill7",
        "fulfill_commitment",
        playerPrincipal(ids.mara),
        { commitmentId },
      );
      expect(
        (await submitDurableFulfillCommitment(fulfillCmd, ADMIT_AT_LOCKED_VERSION)).status,
      ).toBe("accepted");

      const escalationCmd = command(
        ids,
        "escalate7",
        "attempt_consent_escalation",
        playerPrincipal(ids.mara),
        {
          actorId: ids.mara,
          targetActorId: ids.iris,
          scopeKey: "kiss",
        },
      );
      const escalationOptions = {
        playerControlledActorIds: [ids.player],
        modelBudgetRemaining: 0,
        deliberate: async () => ({ chosenCandidateId: "grant" }),
        admitAtLockedVersion: true,
      };
      expect(
        (
          await submitDurableAttemptConsentEscalation(
            escalationCmd,
            escalationOptions,
          )
        ).status,
      ).toBe("accepted");

      const opened = await submitDurableOpenEngagement(
        command(ids, "scene7", "open_engagement", playerPrincipal(ids.player), {
          participantIds: [ids.player, ids.mara].sort(),
          channel: "co_present",
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(opened, "scene open");
      const engagementId = deriveEngagementId(
        ids.branchId,
        `cmd-scene7-${ids.branchId}`,
      );
      const turn = await prepareEngagementTurn({
        branchId: ids.branchId,
        engagementId,
        viewpointActorId: ids.player,
        spanSeconds: TURN_SPAN,
        workerId: "w-gate5-footprint",
      });
      await drainMemoryIndexOutbox({ workerId: "w-gate5-footprint-drain" });

      // `branchFootprint` derives its table list from the drizzle schema —
      // every branch-scoped sim_ table, so a lane added after this file was
      // written is covered without editing the list by hand.
      const footprint = await branchFootprint(ids.branchId);
      expect(await loadPersistedCut(ids.branchId, turn.cut.id)).toEqual(
        turn.cut,
      );
      expect(
        footprintDelta(footprint, await branchFootprint(ids.branchId)),
      ).toEqual({});

      // Replay each already-accepted command across the new domains: an
      // identical cached result, and zero footprint change, every time.
      const replays: [string, () => Promise<{ status: string }>][] = [
        [
          "create_household",
          () => submitDurableCreateHousehold(createHouseholdCmd, ADMIT_AT_LOCKED_VERSION),
        ],
        [
          "promote_item_from_stock",
          () => submitDurablePromoteItemFromStock(promoteCmd, ADMIT_AT_LOCKED_VERSION),
        ],
        [
          "configure_restock_routine",
          () => submitDurableConfigureRestockRoutine(configureCmd, ADMIT_AT_LOCKED_VERSION),
        ],
        [
          "fulfill_commitment",
          () => submitDurableFulfillCommitment(fulfillCmd, ADMIT_AT_LOCKED_VERSION),
        ],
        [
          "attempt_consent_escalation",
          () =>
            submitDurableAttemptConsentEscalation(
              escalationCmd,
              escalationOptions,
            ),
        ],
      ];
      for (const [name, replay] of replays) {
        const before = await branchFootprint(ids.branchId);
        const result = await replay();
        expectAccepted(result, `${name} replay`);
        expect(
          footprintDelta(before, await branchFootprint(ids.branchId)),
          name,
        ).toEqual({});
      }
      expect(
        footprintDelta(footprint, await branchFootprint(ids.branchId)),
      ).toEqual({});
      expect(await loadPersistedCut(ids.branchId, turn.cut.id)).toEqual(
        turn.cut,
      );
    });

    // -------------------------------------------------------------------------
    // 8a — Fork/replay parity at adversarial multi-domain boundaries in ONE
    // fork: mid-armed-restock, mid-worn-window, pre/post promotion (one item
    // promoted before the fork, one only after, on the parent alone),
    // mid-escalation-pending-nothing (no covering ledger entry at fork time),
    // and post-acknowledgment (a pressure already looked-at before the fork).
    // The child rebuilds bit-identical to a from-events replay in every
    // touched domain, and each branch's post-fork divergence stays its own.
    // -------------------------------------------------------------------------
    it("EXIT 8a — fork at adversarial multi-domain boundaries rebuilds bit-identical, and each branch's post-fork divergence stays its own", async () => {
      const garmentId = newId();
      const ids = await seedCorpusCase((corpusIds) => [
        {
          id: garmentId,
          name: "a wool coat",
          ownerActorId: null,
          conditionTracked: true,
          locus: { kind: "held", actorId: corpusIds.mara },
        },
      ]);
      await seedRhythms(ids.branchId, ids.mara);
      await submitDurableInitializeActorBody(
        initializeBodyCommand(ids, "init-mara-8a", ids.mara),
        ADMIT_AT_LOCKED_VERSION,
      );
      await submitDurableTransferItem(
        command(ids, "don-8a", "transfer_item", npcPrincipal(ids.mara), {
          actorId: ids.mara,
          itemId: garmentId,
          fromLocus: { kind: "held", actorId: ids.mara },
          toLocus: { kind: "worn", actorId: ids.mara, slotKey: WORN_SLOT },
        }),
        ADMIT_AT_LOCKED_VERSION,
      ); // mid-worn-window: cleanliness alarm now pending

      const householdId = newId();
      const householdLocus = lotLocusSchema.parse({
        kind: "household",
        householdId,
      });
      await submitDurableCreateHousehold(
        command(ids, "create-hh8a", "create_household", gmPrincipal, {
          householdId,
          name: "Adversarial household",
          residenceZoneIds: [ids.zoneHome],
          stockAccessPolicy: { kind: "members_only" },
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      await submitDurableSetHouseholdMembership(
        command(ids, "member-mara8a", "set_household_membership", gmPrincipal, {
          householdId,
          actorId: ids.mara,
          role: "resident",
          status: "active",
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      await submitDurableAdjustMaterialLot(
        command(ids, "stock-bread8a", "adjust_material_lot", gmPrincipal, {
          locus: householdLocus,
          materialKindKey: "bread",
          deltaRaw: 10,
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      await submitDurableAdjustMaterialLot(
        command(ids, "fund8a", "adjust_material_lot", gmPrincipal, {
          locus: householdLocus,
          materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
          deltaRaw: 100_000,
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      // Post-promotion (item #1) — carried by BOTH branches.
      const promote1 = await submitDurablePromoteItemFromStock(
        command(
          ids,
          "promote1-8a",
          "promote_item_from_stock",
          playerPrincipal(ids.mara),
          {
            actorId: ids.mara,
            funding: {
              kind: "stock",
              sourceLocus: householdLocus,
              quantityRaw: 1,
            },
            item: { name: "loaf one", materialKindKey: "bread" },
          },
        ),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(promote1, "first promotion");
      // Mid-armed-restock: configured, cadence far out, never fired.
      await submitDurableConfigureRestockRoutine(
        command(ids, "configure8a", "configure_restock_routine", gmPrincipal, {
          householdId,
          materialKindKey: "bread",
          targetQuantityRaw: 20,
          lowWaterThresholdRaw: 5,
          cadenceSeconds: 3_600,
          funding: {
            kind: "lot",
            currencyLocus: householdLocus,
            unitPriceRaw: 10,
          },
          active: true,
        }),
        ADMIT_AT_LOCKED_VERSION,
      );
      const armedRestock = (
        await pendingTriggers(ids.branchId, "household_restock_due")
      ).find((t) => t.state === "pending");
      if (!armedRestock) throw new Error("restock alarm did not arm");

      // Post-acknowledgment: a destinationless promise's notice pressure,
      // already looked-at through a real turn before the fork.
      const promiseCmd = command(
        ids,
        "promise8a",
        "create_commitment",
        playerPrincipal(ids.mara),
        {
          actorId: ids.mara,
          kind: "promise",
          promisedToActorId: ids.iris,
          window: { latestArrival: SEED_SECOND + 10_000 },
          priority: 0,
          flexibility: "soft",
          preparationSeconds: 0,
          reliabilityBufferSeconds: 0,
          noticeLeadSeconds: 9_950,
          knowledgeSource: { kind: "authored" },
        },
      );
      expect(
        (await submitDurableCreateCommitment(promiseCmd, ADMIT_AT_LOCKED_VERSION)).status,
      ).toBe("accepted");
      await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 100, {
        workerId: "w-gate5-8a-notice",
      });
      const openedForAck = await submitDurableOpenEngagement(
        command(
          ids,
          "ack-scene-8a",
          "open_engagement",
          playerPrincipal(ids.player),
          {
            participantIds: [ids.player, ids.mara].sort(),
            channel: "co_present",
          },
        ),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(openedForAck, "acknowledgment scene");
      const ackEngagementId = deriveEngagementId(
        ids.branchId,
        `cmd-ack-scene-8a-${ids.branchId}`,
      );
      const ackTurn = await prepareEngagementTurn({
        branchId: ids.branchId,
        engagementId: ackEngagementId,
        viewpointActorId: ids.mara,
        spanSeconds: 60,
        horizonSeconds: 900,
        workerId: "w-gate5-8a-ack",
      });
      const acknowledged = ackTurn.acknowledgments.find(
        (ack) => ack.actorId === ids.mara && ack.result === "accepted",
      );
      if (!acknowledged)
        throw new Error(
          "expected the notice pressure to be acknowledged before the fork",
        );

      // Fork point: mid-armed-restock, mid-worn-window, post-promotion(#1),
      // post-acknowledgment, and mid-escalation-pending-nothing (no boundary
      // or permission entry exists for mara/iris "kiss" yet — structurally
      // absent on both sides of the fork).
      // Stays a direct `forkBranch`: the assertion below reads the fork
      // RESULT's `pendingTriggerIds`, which the shared `forkAtHead` does not
      // hand back.
      const forkPointSequence = await branchHeadSequence(ids.branchId);
      const childBranchId = newId();
      harness.trackBranch(childBranchId);
      const forkResult = await forkBranch({
        parentBranchId: ids.branchId,
        childBranchId,
        atSequence: forkPointSequence,
        principal: { kind: gmPrincipal.kind, principalId: gmPrincipal.principalId },
        reason: "E5.6 adversarial multi-domain fork",
      });
      expect(forkResult.pendingTriggerIds.length).toBeGreaterThanOrEqual(2); // restock + item-condition alarms

      // Diverge the PARENT only: promote a SECOND item (pre/post-promotion —
      // the child stays pre-promotion for this one).
      const promote2 = await submitDurablePromoteItemFromStock(
        command(
          ids,
          "promote2-parent-8a",
          "promote_item_from_stock",
          playerPrincipal(ids.mara),
          {
            actorId: ids.mara,
            funding: {
              kind: "stock",
              sourceLocus: householdLocus,
              quantityRaw: 1,
            },
            item: { name: "loaf two", materialKindKey: "bread" },
          },
        ),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(promote2, "second promotion");

      // Diverge the CHILD only: resolve the pending consent gap by escalation
      // (admission refused — deterministic decline, zero model calls).
      const childEscalation = await submitDurableAttemptConsentEscalation(
        command(
          { branchId: childBranchId },
          "escalate-child-8a",
          "attempt_consent_escalation",
          playerPrincipal(ids.mara),
          {
            actorId: ids.mara,
            targetActorId: ids.iris,
            scopeKey: "kiss",
          },
        ),
        {
          playerControlledActorIds: [ids.player],
          modelBudgetRemaining: 0,
          deliberate: async () => ({ chosenCandidateId: "grant" }),
          admitAtLockedVersion: true,
        },
      );
      expectAccepted(childEscalation, "child escalation");

      // Households: the child's own from-events replay matches its own live
      // projection exactly, AND the child carries only item #1 while the
      // parent carries both.
      // A forked child's OWN sim_events rows only carry its post-fork events —
      // the full logical stream (ancestry + child-only) is the ancestry reader
      // (mirrors gate3-corpus.int.test.ts's own `branchEvents` helper).
      const childEvents = await readBranchEvents(childBranchId, {
        includeAncestry: true,
      });
      const rebuiltHouseholds = replayHouseholdsHistory({
        seed: emptyHouseholdsSeed(childBranchId, SEED_SECOND),
        events: childEvents,
      });
      const [liveHouseholdRow] = await db()
        .select()
        .from(simHouseholds)
        .where(eq(simHouseholds.branchId, childBranchId));
      expect(liveHouseholdRow?.name).toBe(
        rebuiltHouseholds.households.find((h) => h.id === householdId)?.name,
      );
      const childItemNames = (
        await db()
          .select({ name: simItems.name })
          .from(simItems)
          .where(eq(simItems.branchId, childBranchId))
      ).map((row) => row.name);
      expect(childItemNames.sort()).toEqual(["a wool coat", "loaf one"].sort());
      const parentItemNames = (
        await db()
          .select({ name: simItems.name })
          .from(simItems)
          .where(eq(simItems.branchId, ids.branchId))
      ).map((row) => row.name);
      expect(parentItemNames.sort()).toEqual(
        ["a wool coat", "loaf one", "loaf two"].sort(),
      );

      // Social ledger: the child's own from-events replay matches its own live
      // ledger, INCLUDING the child-only consent_declined entry — and the
      // PARENT never sees it.
      const commitmentById = () => ({
        kind: "promise",
        promisedToActorId: ids.iris,
      });
      const rebuiltLedger = replaySocialLedgerHistory({
        events: childEvents,
        commitmentById,
      });
      const childLedger = await loadRelationshipLedgerProjection(childBranchId);
      const byId = (entries: typeof rebuiltLedger) =>
        [...entries].sort((a, b) => a.id.localeCompare(b.id));
      expect(simulationHash(byId(childLedger))).toBe(
        simulationHash(byId(rebuiltLedger)),
      );
      expect(
        childLedger.some((entry) => entry.kind === "consent_declined"),
      ).toBe(true);
      const parentLedger = await loadRelationshipLedgerProjection(ids.branchId);
      expect(
        parentLedger.some((entry) => entry.kind === "consent_declined"),
      ).toBe(false);

      // Item condition: unaffected by either branch's divergence, so the
      // child's worn-window meters/modifiers still equal the parent's.
      const parentItemCondition = await itemConditionRows(
        ids.branchId,
        garmentId,
      );
      const childItemCondition = await itemConditionRows(
        childBranchId,
        garmentId,
      );
      expect(childItemCondition.meters).toEqual(parentItemCondition.meters);
      expect(childItemCondition.modifiers).toEqual(
        parentItemCondition.modifiers,
      );

      // Body rhythms: authored pre-fork, copied to the child like action
      // definitions (branch-store.ts's fork copy) — unaffected by either
      // branch's divergence, so the child's rows still equal the parent's.
      const parentRhythms = await bodyRhythmRows(ids.branchId, ids.mara);
      const childRhythms = await bodyRhythmRows(childBranchId, ids.mara);
      expect(parentRhythms.length).toBeGreaterThan(0);
      expect(childRhythms).toEqual(parentRhythms);

      // Restock alarm: still pending, un-fired, identically on both branches.
      const parentRestockAlarm = (
        await pendingTriggers(ids.branchId, "household_restock_due")
      ).find((t) => t.state === "pending");
      const childRestockAlarm = (
        await pendingTriggers(childBranchId, "household_restock_due")
      ).find((t) => t.state === "pending");
      expect(childRestockAlarm?.dueStorySecond).toBe(
        parentRestockAlarm?.dueStorySecond,
      );
      expect(childRestockAlarm?.dueStorySecond).toBe(
        armedRestock.dueStorySecond,
      );

      // Pressures: the pre-fork acknowledgment carried over identically.
      const [parentPressure] = (await readDurableCommitments(ids.branchId))
        .pressures;
      const [childPressure] = (await readDurableCommitments(childBranchId))
        .pressures;
      expect(childPressure?.acknowledgedAt).toBe(
        parentPressure?.acknowledgedAt,
      );
      expect(childPressure?.acknowledgedSeverity).toBe(
        parentPressure?.acknowledgedSeverity,
      );
      expect(childPressure?.acknowledgedAt).toBeDefined();
    });

    // -------------------------------------------------------------------------
    // 8b — Fork/replay parity: an instant item-condition threshold crossing
    // driven synchronously through `apply_item_condition_source` (the E5.3
    // follow-up note: "an int test for an instant crossing driven through
    // apply_item_condition_source — the pure path is covered"). `wear` has
    // `driftLaw: "none"`, so no alarm can ever be solved for it — the ONLY way
    // it crosses is a direct source application, in the same transaction as
    // the crossing event, with no `trigger_scheduled` alarm involved at all.
    // -------------------------------------------------------------------------
    it("EXIT 8b — an instant item-condition crossing via apply_item_condition_source (no alarm possible) forks bit-identical", async () => {
      const garmentId = newId();
      const ids = await seedCorpusCase((corpusIds) => [
        {
          id: garmentId,
          name: "old boots",
          ownerActorId: null,
          conditionTracked: true,
          locus: { kind: "held", actorId: corpusIds.mara },
        },
      ]);

      const beforeEvents = await readBranchEvents(ids.branchId);
      expect(
        beforeEvents.some(
          (event) => event.type === "item_condition_initialized",
        ),
      ).toBe(false);

      // "wear" starts at 0, `worn_out` boundary is 8 000 rising, driftLaw
      // "none" — jumping straight to 8 500 crosses it INSTANTLY, synchronously,
      // with no alarm ever armed for this meter.
      const applied = await submitDurableApplyItemConditionSource(
        command(
          ids,
          "wear-jump",
          "apply_item_condition_source",
          npcPrincipal(ids.mara),
          {
            actorId: ids.mara,
            itemId: garmentId,
            sourceKind: "adjustment",
            meterKey: "wear",
            operation: { kind: "set", valueFixedPoint: 8_500 },
          },
        ),
        ADMIT_AT_LOCKED_VERSION,
      );
      expectAccepted(applied, "the wear jump");

      const events = await readBranchEvents(ids.branchId);
      expect(events.map((event) => event.type)).toEqual([
        "item_condition_initialized",
        "item_condition_source_applied",
        "item_condition_threshold_crossed",
      ]);
      const crossed = events.find(
        (event) => event.type === "item_condition_threshold_crossed",
      );
      if (crossed?.type !== "item_condition_threshold_crossed")
        throw new Error("instant crossing event missing");
      expect(crossed.payload).toMatchObject({
        meterKey: "wear",
        thresholdKey: "worn_out",
        valueFixedPoint: 8_500,
      });

      // No alarm exists for a driftless meter — the crossing was synchronous,
      // never trigger-dispatched.
      const wearAlarms = (
        await pendingTriggers(ids.branchId, "item_condition_threshold_due")
      ).filter((t) => t.uniquenessKey.includes("wear"));
      expect(wearAlarms).toHaveLength(0);

      // Direct `forkBranch` for the same reason as 8a: the fork RESULT's
      // `pendingTriggerIds` is the assertion.
      const forkPointSequence = await branchHeadSequence(ids.branchId);
      const childBranchId = newId();
      harness.trackBranch(childBranchId);
      const forkResult = await forkBranch({
        parentBranchId: ids.branchId,
        childBranchId,
        atSequence: forkPointSequence,
        principal: { kind: gmPrincipal.kind, principalId: gmPrincipal.principalId },
        reason: "E5.6 instant item-condition crossing fork parity",
      });
      // Only the cleanliness lane could ever arm anything, and this garment
      // was never worn — zero pending triggers to carry over.
      expect(forkResult.pendingTriggerIds).toHaveLength(0);

      const parentCondition = await itemConditionRows(ids.branchId, garmentId);
      const childCondition = await itemConditionRows(childBranchId, garmentId);
      expect(childCondition.meters).toEqual(parentCondition.meters);
      expect(childCondition.modifiers).toEqual(parentCondition.modifiers);
      expect(
        childCondition.meters.find((m) => m.meterKey === "wear")
          ?.valueFixedPoint,
      ).toBe(8_500);

      const childWearAlarms = (
        await pendingTriggers(childBranchId, "item_condition_threshold_due")
      ).filter((t) => t.uniquenessKey.includes("wear"));
      expect(childWearAlarms).toHaveLength(0);
    });
  },
);
