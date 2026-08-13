import { describe, expect, it } from "vitest";
import { actorLodReadSchema } from "@/contracts/simulation/lod";
import {
  bodyDerivationVersion,
  bodyMeterRegistryByVersion,
  bodyMeterStateSchema,
  bodyRhythmRowSchema,
  type BodyRhythmRow,
} from "@/contracts/simulation/bodies";
import {
  createCommitmentCommandSchema,
  type CreateCommitmentCommand,
} from "@/contracts/simulation/commitments";
import {
  materialBranchSeedSchema,
  simulationMaterialItemSchema,
  type SimulationMaterialItem,
} from "@/contracts/simulation/materials";
import { authoredLoreSeedSchema } from "@/contracts/simulation/memory";
import { runRoutinePolicyCommandSchema } from "@/contracts/simulation/routine";
import { simulationActionDefinitionSchema } from "@/contracts/simulation/activities";
import { linkSchema, locationSchema, zoneSchema } from "@/contracts/simulation/space";
import { resolveCreateCommitment } from "@/lib/simulation/commitments";
import { materialsSeedProjection } from "@/lib/simulation/materials";
import { projectAuthoredLoreDocument } from "@/lib/simulation/memory";
import type { MaterialResolutionView } from "@/lib/simulation/material-locus";
import type { MeterIntegrationView } from "@/lib/simulation/bodies";
import {
  mealWindowCovering,
  resolveRunRoutinePolicyFromView,
  selectRoutineMealItem,
  type RunRoutinePolicyResolutionView,
} from "@/lib/simulation/routine";
import { planRoute, type SpaceTopology } from "@/lib/simulation/space";
import { bindSimEnvelopes } from "@/test/sim-envelopes";
import {
  STARTER_ORIGIN_STORY_SECOND,
  STARTER_RULESET_VERSION,
  starterWorldSeedPlan,
} from "./starter-world";

/**
 * starter-world-seeds.plan.md (B8) — the starter world's authored seed is pure
 * data, so its shape is assertable without a database. Every payload here is
 * parsed through the SAME contract the durable seeder parses it with, and the
 * two behavioral claims from the plan's success criteria are proved against
 * the real kernels: `eat_meal` is legal inside the seeded meal window
 * (`resolveRunRoutinePolicyFromView` / `selectRoutineMealItem`), and both
 * seeded commitments resolve into real departures away from home
 * (`resolveCreateCommitment`).
 *
 * The durable side (rows actually landing, stage skips on resume) stays with
 * `successor-provisioning.int.test.ts`; this file is the seed's contract.
 */

const STAMP = "starterseedtest0000000aa";
const plan = starterWorldSeedPlan({ stamp: STAMP, playerName: "Pia", primaryName: "Nora" });

const env = bindSimEnvelopes({
  worldId: plan.worldId,
  branchId: plan.branchId,
  rulesetVersion: STARTER_RULESET_VERSION,
});

/** The seeded topology, parsed — which also proves the zones/links satisfy §13.1. */
function topology(): SpaceTopology {
  return {
    locations: plan.topology.locations.map((location) => locationSchema.parse(location)),
    zones: plan.topology.zones.map((zone) => zoneSchema.parse(zone)),
    links: plan.topology.links.map((link) => linkSchema.parse(link)),
  };
}

function seededMealItem(): SimulationMaterialItem {
  const seed = plan.material.items.find((item) => item.id === plan.mealItemId);
  if (!seed) throw new Error("the starter world seeds no meal item");
  return simulationMaterialItemSchema.parse(seed);
}

function seededRhythmRows(): BodyRhythmRow[] {
  return plan.rhythms.rows
    .filter((row) => row.actorId === plan.actors.primary)
    .map((row) => bodyRhythmRowSchema.parse(row));
}

/** The minute-of-day the primary's authored meal window opens. */
function mealWindowStartSecond(): number {
  const meal = plan.rhythms.rows.find(
    (row) => row.actorId === plan.actors.primary && row.kind === "meal",
  );
  if (!meal) throw new Error("the starter world seeds no meal window");
  return meal.startMinuteOfDay * 60;
}

function energyView(): MeterIntegrationView {
  const definition = bodyMeterRegistryByVersion[bodyDerivationVersion].find(
    (candidate) => candidate.key === "energy",
  );
  if (!definition) throw new Error("energy definition missing");
  return {
    definition,
    state: bodyMeterStateSchema.parse({
      actorId: plan.actors.primary,
      meterKey: "energy",
      valueFixedPoint: 7_000,
      baselineFixedPoint: 0,
      lastIntegratedAtStorySecond: STARTER_ORIGIN_STORY_SECOND,
      registryVersion: bodyDerivationVersion,
    }),
    modifiers: [],
    scheduledAdjustments: [],
  };
}

/** The §26 authority view a fresh world presents at the meal boundary. */
function materialView(items: readonly SimulationMaterialItem[]): MaterialResolutionView {
  // Keyed as plain string: the view's `itemById` receives an unbranded id, and
  // widening the key beats casting the lookup argument into the brand.
  const byId = new Map<string, SimulationMaterialItem>(items.map((item) => [item.id, item]));
  return {
    ...env.meta({ headSequence: 0, storySecond: mealWindowStartSecond() }),
    version: 0,
    actorById: (actorId) =>
      actorId === plan.actors.primary ? { id: actorId, name: plan.primaryName } : undefined,
    actorZoneId: (actorId) => (actorId === plan.actors.primary ? plan.zones.home : null),
    actorLocationId: (actorId) => (actorId === plan.actors.primary ? plan.locationId : null),
    itemById: (itemId) => byId.get(itemId),
    containerOccupantCount: () => 0,
    reservingActivityId: () => null,
  };
}

function routineView(): RunRoutinePolicyResolutionView {
  const meal = seededMealItem();
  return {
    ...env.meta({ headSequence: 0, storySecond: mealWindowStartSecond() }),
    actorExists: true,
    lod: actorLodReadSchema.parse({
      simulationLod: "event",
      inferenceLod: "no_model",
      source: "assigned",
      registryVersion: "actor-lod-v1",
    }),
    rhythmRows: seededRhythmRows(),
    energyView: energyView(),
    activeAsleep: false,
    claimHoldingActivityCount: 0,
    openEngagementCount: 0,
    openPressureActBySeconds: [],
    coLocatedActorIds: [],
    materialView: materialView([meal]),
    materialItemIds: [meal.id],
    consumptionBodyView: {
      bodyInitialized: true,
      meterView: (meterKey) => (meterKey === "energy" ? energyView() : undefined),
      collapseContext: { rhythmRows: seededRhythmRows() },
    },
  };
}

function commitmentCommand(seed: (typeof plan.commitments)[number]): CreateCommitmentCommand {
  return env.command(createCommitmentCommandSchema, {
    type: "create_commitment",
    idSlug: seed.name,
    principal: { kind: "system", principalId: "starter-world-seeder", controlledActorIds: [] },
    payload: seed.payload,
  });
}

describe("starter world seed: identity and shape", () => {
  it("derives every id from the stamp so a resumed provision names the same world", () => {
    expect(plan.worldId).toBe(`stw-${STAMP}`);
    expect(plan.branchId).toBe(`stw-${STAMP}-branch`);
    for (const id of [
      ...Object.values(plan.actors),
      ...Object.values(plan.zones),
      plan.locationId,
      plan.keepsakeItemId,
      plan.mealItemId,
    ]) {
      expect(id.startsWith(`stw-${STAMP}-`)).toBe(true);
    }
    // Purity: same input, same world, forever.
    expect(starterWorldSeedPlan({ stamp: STAMP, playerName: "Pia", primaryName: "Nora" })).toEqual(plan);
  });

  it("keeps the player and primary names distinct so prose can tell them apart", () => {
    const collided = starterWorldSeedPlan({ stamp: STAMP, playerName: "nora", primaryName: "Nora" });
    expect(collided.playerName).toBe("Traveler");
    expect(starterWorldSeedPlan({ stamp: STAMP, playerName: "  ", primaryName: "  " })).toMatchObject({
      playerName: "Traveler",
      primaryName: "Companion",
    });
  });

  it("parses and projects as a legal material branch seed", () => {
    // The same two calls `seedDurableMaterialBranch` makes before it writes a
    // row: the contract parse, then the §26 invariant assertion (unique ids,
    // resolvable container refs, capacity, no holding cycles).
    expect(() => materialsSeedProjection(plan.material)).not.toThrow();
    expect(materialBranchSeedSchema.parse(plan.material).items).toHaveLength(2);
  });
});

describe("starter world seed: the meal (B8 group 1)", () => {
  it("seeds one consumable carrying a meal-source consumption effect", () => {
    const meal = seededMealItem();
    expect(meal.locus).toEqual({ kind: "held", actorId: plan.actors.primary });
    // §26.5 requires an unowned-or-own item: an owner other than the eater is
    // exactly what makes a seeded meal invisible to the routine.
    expect(meal.ownerActorId).toBeNull();
    expect(meal.consumptionEffects?.some((effect) => effect.sourceKind === "meal")).toBe(true);
  });

  it("is the item §26.5 selection picks for the primary", () => {
    const meal = seededMealItem();
    expect(selectRoutineMealItem(materialView([meal]), [meal.id], plan.actors.primary)?.id).toBe(
      plan.mealItemId,
    );
  });

  it("makes eat_meal LEGAL and chosen inside the seeded meal window", () => {
    const view = routineView();
    // The window the routine scores against is the seeded rhythm row itself.
    expect(mealWindowCovering(view.rhythmRows, view.storySecond)).toBeDefined();

    const command = env.command(runRoutinePolicyCommandSchema, {
      type: "run_routine_policy",
      principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
      payload: { actorId: plan.actors.primary, armedAtSequence: 0 },
    });
    const result = resolveRunRoutinePolicyFromView(view, command);
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);

    const decision = result.events[0];
    if (decision?.type !== "routine_policy_resolved") throw new Error("expected the decision first");
    // Before B8 this candidate was always `legal: false, no_eligible_item` on a
    // fresh world — nothing in it was edible.
    expect(decision.payload.candidates.find((candidate) => candidate.id === "eat_meal")).toMatchObject({
      legal: true,
    });
    expect(result.chosenCandidateId).toBe("eat_meal");
    expect(result.consumedItemId).toBe(plan.mealItemId);
  });
});

describe("starter world seed: the primary's obligations (B8 group 2)", () => {
  it("seeds a firm midday obligation and a soft evening plan, both away from home", () => {
    expect(plan.commitments).toHaveLength(2);
    for (const seed of plan.commitments) {
      expect(seed.payload.actorId).toBe(plan.actors.primary);
      expect(seed.payload.destinationZoneId).not.toBe(plan.zones.home);
      expect(seed.payload.destinationZoneId).toBeDefined();
      expect(seed.payload.knowledgeSource).toEqual({ kind: "authored" });
      // Nothing may already be over at birth, or `create_commitment` answers
      // `window_in_past` and the world opens with no MUSTs after all.
      expect(seed.payload.window.latestArrival).toBeGreaterThan(STARTER_ORIGIN_STORY_SECOND);
    }
    const flexibilities = plan.commitments.map((seed) => seed.payload.flexibility);
    expect(flexibilities).toEqual(["firm", "soft"]);
    const [midday, evening] = plan.commitments;
    expect(midday?.payload.destinationZoneId).toBe(plan.zones.market);
    expect(evening?.payload.destinationZoneId).toBe(plan.zones.square);
    expect(evening?.payload.promisedToActorId).toBe(plan.actors.neighbor);
  });

  it("resolves into real departures: each one derives a latest departure before its arrival", () => {
    for (const seed of plan.commitments) {
      const resolution = resolveCreateCommitment(
        {
          ...env.meta({ headSequence: 0, storySecond: STARTER_ORIGIN_STORY_SECOND }),
          actorExists: true,
          originZoneId: plan.zones.home,
          destinationZoneExists: true,
          topology: topology(),
          promisedToActorExists: true,
        },
        commitmentCommand(seed),
      );
      if (!resolution.ok) throw new Error(`${seed.name} was rejected: ${resolution.code}`);

      const derived = resolution.events[0].payload.derived;
      // A destination the primary must WALK to: a zero route would mean the
      // obligation never moves her off the sofa.
      expect(derived.minimumRouteDurationSeconds).toBeGreaterThan(0);
      expect(derived.latestDeparture).toBeGreaterThan(STARTER_ORIGIN_STORY_SECOND);
      expect(derived.latestDeparture).toBeLessThan(seed.payload.window.latestArrival);
      expect(derived.noticeAt).toBeLessThanOrEqual(derived.actBy);
    }
  });

  it("keeps the midday obligation's notice clear of the meal window", () => {
    const [midday] = plan.commitments;
    if (!midday) throw new Error("expected a midday obligation");
    const resolution = resolveCreateCommitment(
      {
        ...env.meta({ headSequence: 0, storySecond: STARTER_ORIGIN_STORY_SECOND }),
        actorExists: true,
        originZoneId: plan.zones.home,
        destinationZoneExists: true,
        topology: topology(),
      },
      commitmentCommand(midday),
    );
    if (!resolution.ok) throw new Error(`the midday obligation was rejected: ${resolution.code}`);
    const meal = plan.rhythms.rows.find(
      (row) => row.actorId === plan.actors.primary && row.kind === "meal",
    );
    if (!meal) throw new Error("the starter world seeds no meal window");
    // Lunch and the walk to the market must not contend for the same boundary.
    expect(resolution.events[0].payload.derived.noticeAt).toBeGreaterThanOrEqual(meal.endMinuteOfDay * 60);
  });
});

describe("starter world seed: places and things to do (B8 group 3)", () => {
  it("seeds three zones joined by two links, with the market a two-hop walk from home", () => {
    expect(plan.topology.zones).toHaveLength(3);
    expect(plan.topology.links).toHaveLength(2);
    const route = planRoute(topology(), {
      originZoneId: plan.zones.home,
      destinationZoneId: plan.zones.market,
      travelMode: "walk",
    });
    if (!route.ok) throw new Error(`the market is unreachable: ${route.reason}`);
    expect(route.route.linkIds).toHaveLength(2);
    expect(route.route.minimumDurationSeconds).toBeGreaterThan(300);
  });

  it("seeds two action definitions gated on different zone kinds", () => {
    expect(plan.actions.definitions).toHaveLength(2);
    const parsed = plan.actions.definitions.map((definition) =>
      simulationActionDefinitionSchema.parse(definition),
    );
    const zoneKinds = parsed.flatMap((definition) =>
      definition.preconditions.flatMap((precondition) =>
        precondition.kind === "at_zone_kind" ? [precondition.zoneKind] : [],
      ),
    );
    expect(new Set(zoneKinds)).toEqual(new Set(["home", "market"]));
    // Each gate names a zone kind the world actually contains, or the chip
    // could never appear anywhere.
    const seededKinds = new Set(plan.topology.zones.map((zone) => zone.kind));
    for (const zoneKind of zoneKinds) expect(seededKinds.has(zoneKind)).toBe(true);
    // A display label, never a raw id in prose.
    for (const definition of parsed) expect(definition.label ?? "").not.toBe("");
  });
});

describe("starter world seed: authored lore (B8 group 4)", () => {
  it("seeds lore documents that project as recallable authored_lore", () => {
    expect(plan.lore.length).toBeGreaterThanOrEqual(3);
    const documents = plan.lore.map((seed) =>
      projectAuthoredLoreDocument(plan.branchId, authoredLoreSeedSchema.parse(seed)),
    );
    for (const document of documents) {
      expect(document.sourceKind).toBe("authored_lore");
      expect(document.epistemicLabel).toBe("authored_lore");
      // Seeded lore predates every event, so it is valid on turn 1.
      expect(document.validFromSecond).toBeLessThanOrEqual(STARTER_ORIGIN_STORY_SECOND);
      expect(document.text.length).toBeGreaterThan(0);
    }
    // Distinct, stamp-scoped ids: two worlds' lore must never collide.
    expect(new Set(documents.map((document) => document.id)).size).toBe(documents.length);
    for (const seed of plan.lore) expect(seed.loreId.startsWith(`stw-${STAMP}-`)).toBe(true);
  });

  it("gives the primary something to recall on turn 1, publicly and privately", () => {
    const forPrimary = plan.lore.filter(
      (seed) => seed.visibility === "public" || seed.eligibleActorIds.includes(plan.actors.primary),
    );
    expect(forPrimary.length).toBeGreaterThanOrEqual(3);
    expect(plan.lore.some((seed) => seed.visibility === "public")).toBe(true);
    expect(
      plan.lore.some(
        (seed) => seed.visibility === "actors" && seed.eligibleActorIds.includes(plan.actors.primary),
      ),
    ).toBe(true);
    // The keepsake already existed in world truth but meant nothing; lore is
    // what turns it into something recall can return.
    expect(
      plan.lore.some((seed) => seed.aboutEntityIds.includes(plan.keepsakeItemId)),
    ).toBe(true);
  });
});
