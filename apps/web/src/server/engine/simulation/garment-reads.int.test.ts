import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  garmentEffectiveCoverage,
  garmentReadout,
  successorGarmentBlueprint,
  successorWornSlotKey,
  GARMENT_UNIT_ONE,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { db, simItemConditionMeters, simItemGarmentState, simItems } from "@/server/db";
import {
  expectAccepted,
  npcPrincipal,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";
import {
  readDurableActorGarments,
  SIM_GARMENT_BLUEPRINT_MISSING,
  SIM_GARMENT_BLUEPRINT_UNREADABLE,
  SIM_GARMENT_SLOT_UNMAPPED,
} from "./garment-reads";
import { upsertItemGarmentStateRow } from "./garment-rows";
import { submitDurableTransferItem } from "./material-store";
import { advanceBranchStoryTime } from "./scheduler-store";

/**
 * #295 — an actor's worn sim items resolve to the SAME garment structure
 * character chat reads: blueprint, parts, effective-coverage inputs, and the
 * agreed condition owner. The suite's centre of gravity is the degraded law:
 * a garment whose construction cannot be read is still listed, marked
 * unreliable, and never reported as covering nothing.
 */
const harness = await simulationSuiteHarness({
  suite: "garment-reads.int.test",
  table: "sim_item_garment_state",
  legacyPlayerMode: false,
  cleanup: "afterEach",
});

const SEED_SECOND = 40_000;
const SHIRT_COVERAGE = ["chest", "shoulders"] as const;

interface Case {
  worldId: string;
  branchId: string;
  actorId: string;
  locationId: string;
  zoneId: string;
  shirtId: string;
}

function makeCase(): Case {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    actorId: newId(),
    locationId: `${worldId}-loc-home`,
    zoneId: `${branchId}-zone-room`,
    shirtId: newId(),
  };
}

function shirtBlueprint(): Record<string, unknown> {
  return successorGarmentBlueprint({
    id: "def-shirt",
    name: "linen shirt",
    category: "top",
    coverage: [...SHIRT_COVERAGE],
  });
}

/** Seed one actor wearing `items`, plus the topology every command path needs. */
async function seedWearing(
  ids: Case,
  items: Parameters<typeof seedSimBranch>[0]["items"],
): Promise<void> {
  harness.trackWorld(ids.worldId);
  await seedSimBranch({
    worldId: ids.worldId,
    branchId: ids.branchId,
    worldTypeId: "e295-garment-read-tests",
    rulesetVersion: "e295-garment-read-v1",
    originStorySecond: SEED_SECOND,
    actors: [{ id: ids.actorId, name: "Mara" }],
    items,
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "room", privacyPolicy: "private" }],
    links: [],
    placements: [{ actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneId }],
  });
}

describe.runIf(harness.ready)("readActorGarmentInstances — the resolved read", () => {
  it("resolves a seeded worn item to a typed blueprint, its parts, and its effective coverage", async () => {
    const ids = makeCase();
    await seedWearing(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
      },
    ]);

    const read = await readDurableActorGarments(ids.branchId, ids.actorId);
    expect(read.reliable).toBe(true);
    expect(read.diagnostics).toEqual([]);
    expect(read.garments).toHaveLength(1);

    const garment = read.garments[0]!;
    expect(garment.slot).toEqual({ kind: "category", categoryId: "top", index: 0 });
    expect(garment.instance.name).toBe("linen shirt");
    // Parts, not a name: the graph carries addressable construction.
    expect(garment.blueprint.nodes.length).toBeGreaterThan(1);

    // Effective coverage is DERIVED here from the pair the read returns — the
    // same call the chat lane makes — and equals the definition's own coverage.
    const coverage = garmentEffectiveCoverage(garment.instance, garment.blueprint);
    expect([...coverage.covers].sort()).toEqual([...SHIRT_COVERAGE].sort());
    // Coverage is held PER PART, which is the whole point of a blueprint over a
    // name: the front panel is what an open placket would later take away.
    expect(coverage.parts.some((part) => part.partId === "front_panel" && part.covers.includes("chest"))).toBe(true);
    expect(coverage.parts.some((part) => part.behavior === "linear_front_closure")).toBe(true);

    // The store-shaped pair lets the chat readout run unchanged.
    const readout = garmentReadout(garment.instance, read.blueprints[garment.instance.blueprintHash]!);
    expect(readout.name).toBe("linen shirt");
    expect([...readout.covers].sort()).toEqual([...SHIRT_COVERAGE].sort());
  });

  it("orders the read by slot key and dedupes identical construction onto one blueprint entry", async () => {
    const ids = makeCase();
    const secondId = newId();
    await seedWearing(ids, [
      {
        id: secondId,
        name: "second shirt",
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 1) },
      },
      {
        id: ids.shirtId,
        name: "first shirt",
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
      },
    ]);

    const read = await readDurableActorGarments(ids.branchId, ids.actorId);
    expect(read.instances.map((instance) => instance.name)).toEqual(["first shirt", "second shirt"]);
    expect(Object.keys(read.blueprints)).toHaveLength(1);
    expect(read.instances[0]!.blueprintHash).toBe(read.instances[1]!.blueprintHash);
  });

  it("returns nothing for an actor wearing nothing, without inventing a garment", async () => {
    const ids = makeCase();
    await seedWearing(ids, [{ id: ids.shirtId, name: "linen shirt", locus: { kind: "held", actorId: ids.actorId } }]);
    expect(await readDurableActorGarments(ids.branchId, ids.actorId)).toMatchObject({
      instances: [],
      garments: [],
      reliable: true,
    });
  });
});

describe.runIf(harness.ready)("readActorGarmentInstances — the degraded law", () => {
  it("lists a legacy location-slot garment with no blueprint as covered-and-unreliable, never bare", async () => {
    const ids = makeCase();
    await seedWearing(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        // No `garmentBlueprint`: exactly how every world seeded before this
        // column existed reads, with the earlier `<body-location>-<n>` slot.
        locus: { kind: "worn", actorId: ids.actorId, slotKey: "chest-0" },
      },
    ]);

    const read = await readDurableActorGarments(ids.branchId, ids.actorId);
    expect(read.reliable).toBe(false);
    expect(read.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([SIM_GARMENT_BLUEPRINT_MISSING]);

    // Still LISTED, with its name — a lost blueprint costs structure, not the garment.
    expect(read.garments).toHaveLength(1);
    const garment = read.garments[0]!;
    expect(garment.instance.name).toBe("linen shirt");
    expect(garment.reliable).toBe(false);
    expect(garment.slot).toEqual({ kind: "location", locationId: "chest", index: 0 });

    // The degraded blueprint covers nothing, which is why the conservative
    // slot read is what a consumer must use — it says chest, not nothing.
    expect(garmentEffectiveCoverage(garment.instance, garment.blueprint).covers).toEqual([]);
    expect(garment.conservativeCoverage).toContain("chest");
  });

  it("treats a blueprint that parses but has lost its root as unreadable, not as covering nothing", async () => {
    const ids = makeCase();
    await seedWearing(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
      },
    ]);
    // `{}` is the dangerous case: it parses CLEANLY into a graph with no parts,
    // which would otherwise read as a garment authored to cover nothing.
    await db()
      .update(simItems)
      .set({ garmentBlueprint: {} })
      .where(and(eq(simItems.branchId, ids.branchId), eq(simItems.itemId, ids.shirtId)));

    const read = await readDurableActorGarments(ids.branchId, ids.actorId);
    expect(read.reliable).toBe(false);
    expect(read.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([SIM_GARMENT_BLUEPRINT_UNREADABLE]);
    expect(read.garments).toHaveLength(1);
    expect(read.garments[0]!.conservativeCoverage).toContain("chest");
  });

  it("degrades a column that is not an object at all, and still returns the item", async () => {
    const ids = makeCase();
    await seedWearing(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
      },
    ]);
    await db()
      .update(simItems)
      .set({ garmentBlueprint: ["not", "a", "blueprint"] })
      .where(and(eq(simItems.branchId, ids.branchId), eq(simItems.itemId, ids.shirtId)));

    const read = await readDurableActorGarments(ids.branchId, ids.actorId);
    expect(read.diagnostics.map((diagnostic) => diagnostic.code)).toContain(SIM_GARMENT_BLUEPRINT_UNREADABLE);
    expect(read.garments).toHaveLength(1);
    expect(read.garments[0]!.reliable).toBe(false);
  });

  it("reports an unmapped slot as information and keeps the garment's real construction", async () => {
    const ids = makeCase();
    await seedWearing(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: shirtBlueprint(),
        // What a seed writes for a definition with no registered category.
        locus: { kind: "worn", actorId: ids.actorId, slotKey: "garment-0" },
      },
    ]);

    const read = await readDurableActorGarments(ids.branchId, ids.actorId);
    expect(read.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([SIM_GARMENT_SLOT_UNMAPPED]);
    // An unmapped SLOT is not an unreadable garment: construction still reads.
    expect(read.reliable).toBe(true);
    expect(read.garments[0]!.slot).toEqual({ kind: "unknown", raw: "garment-0" });
    expect(garmentEffectiveCoverage(read.garments[0]!.instance, read.garments[0]!.blueprint).covers.sort()).toEqual(
      [...SHIRT_COVERAGE].sort(),
    );
  });
});

describe.runIf(harness.ready)("readActorGarmentInstances — the channel owners", () => {
  it("reads presentation and the condition gradient from the garment-state projection", async () => {
    const ids = makeCase();
    await seedWearing(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
      },
    ]);

    const before = await readDurableActorGarments(ids.branchId, ids.actorId);
    // An ABSENT row is neutral presentation + pristine condition, not a failure.
    expect(before.reliable).toBe(true);
    expect(before.garments[0]!.instance.presentation).toEqual({ closure: {}, roll: {}, tuck: {}, displacement: [] });
    expect(before.garments[0]!.instance.condition.base.wetness).toBe(0);

    await db().transaction(async (tx) => {
      await upsertItemGarmentStateRow(
        tx,
        ids.branchId,
        ids.shirtId,
        { closure: {}, roll: { root: 4_000 }, tuck: {}, displacement: [] },
        {
          base: { wetness: 6_000, cleanliness: GARMENT_UNIT_ONE, crease_load: 1_000, wear: 0 },
          regionOverrides: {},
          deposits: [],
          damageMarks: [],
          integratedAtMinutes: 0,
        },
        7,
      );
    });

    const after = await readDurableActorGarments(ids.branchId, ids.actorId);
    expect(after.garments[0]!.instance.presentation.roll).toEqual({ root: 4_000 });
    expect(after.garments[0]!.instance.condition.base.wetness).toBe(6_000);
    expect(after.garments[0]!.instance.condition.base.crease_load).toBe(1_000);
  });

  it("degrades an unreadable garment-state row to neutral and pristine, still listing the garment", async () => {
    const ids = makeCase();
    await seedWearing(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
      },
    ]);
    await db()
      .insert(simItemGarmentState)
      .values({ branchId: ids.branchId, itemId: ids.shirtId, presentation: "nonsense", condition: 7 });

    const read = await readDurableActorGarments(ids.branchId, ids.actorId);
    expect(read.diagnostics.map((diagnostic) => diagnostic.code)).toContain("sim_garment.state_unreadable");
    expect(read.garments).toHaveLength(1);
    expect(read.garments[0]!.instance.presentation).toEqual({ closure: {}, roll: {}, tuck: {}, displacement: [] });
    expect(read.garments[0]!.instance.condition.base.cleanliness).toBe(GARMENT_UNIT_ONE);
  });

  it("takes cleanliness and wear from the item-condition meters, integrated to the branch clock", async () => {
    const ids = makeCase();
    const untrackedId = newId();
    await seedWearing(ids, [
      {
        id: ids.shirtId,
        name: "tracked shirt",
        conditionTracked: true,
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "held", actorId: ids.actorId },
      },
      {
        id: untrackedId,
        name: "untracked scarf",
        garmentBlueprint: shirtBlueprint(),
        locus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 1) },
      },
    ]);

    // Donning is what lazily initializes the meters and arms the worn-window
    // cleanliness drift — the agreed owner, reached through its own command.
    expectAccepted(
      await submitDurableTransferItem(
        simCommand({
          branchId: ids.branchId,
          name: "don the tracked shirt",
          type: "transfer_item",
          expectedVersion: 0,
          principal: npcPrincipal(ids.actorId),
          payload: {
            actorId: ids.actorId,
            itemId: ids.shirtId,
            fromLocus: { kind: "held", actorId: ids.actorId },
            toLocus: { kind: "worn", actorId: ids.actorId, slotKey: successorWornSlotKey("top", 0) },
          },
        }),
      ),
      "don the tracked shirt",
    );

    // Four hours of wear — well short of the `grimy` threshold, so nothing fires.
    const advanced = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 4 * 3_600, {
      workerId: "w-295-garment-read",
    });
    expect(advanced.status).toBe("advanced");

    // Wear never drifts; setting the meter row directly is what proves the read
    // reports the METER rather than the garment-state projection's own base.
    await db()
      .update(simItemConditionMeters)
      .set({ valueFixedPoint: 4_200 })
      .where(
        and(
          eq(simItemConditionMeters.branchId, ids.branchId),
          eq(simItemConditionMeters.itemId, ids.shirtId),
          eq(simItemConditionMeters.meterKey, "wear"),
        ),
      );

    const read = await readDurableActorGarments(ids.branchId, ids.actorId);
    const tracked = read.garments.find((garment) => garment.instance.id === ids.shirtId);
    const untracked = read.garments.find((garment) => garment.instance.id === untrackedId);
    if (!tracked || !untracked) throw new Error("expected both garments in the read");

    expect(tracked.instance.condition.base.wear).toBe(4_200);
    // Integrated, not the stored pristine default — and still far from soiled.
    expect(tracked.instance.condition.base.cleanliness).toBeLessThan(GARMENT_UNIT_ONE);
    expect(tracked.instance.condition.base.cleanliness).toBeGreaterThan(3_000);

    // An untracked item has no meters, so it keeps the chat defaults, which are
    // the same values item-condition initializes to.
    expect(untracked.instance.condition.base.cleanliness).toBe(GARMENT_UNIT_ONE);
    expect(untracked.instance.condition.base.wear).toBe(0);
  });
});
