import { describe, expect, it } from "vitest";
import {
  consumeItemCommandSchema,
  destroyItemCommandSchema,
  itemTransferredEventSchema,
  materialsProjectionSchema,
  setItemOwnershipCommandSchema,
  simulationMaterialItemSchema,
  transferItemCommandSchema,
  type ConsumeItemCommandInput,
  type DestroyItemCommandInput,
  type ItemLocus,
  type MaterialsProjection,
  type SetItemOwnershipCommandInput,
  type SimulationMaterialItem,
  type SimulationMaterialItemInput,
  type TransferItemCommandInput,
} from "../contracts/materials";
import { bodyInitializedEventSchema, type BodyMeterDefinition } from "../contracts/bodies";
import { itemInstantiatedFromPromotionEventSchema } from "../contracts/households";
import {
  itemConditionMeterStateSchema,
  itemConditionRegistryV1,
  itemConditionRegistryVersion,
} from "../contracts/material-condition";
import { bindSimEnvelopes, testPrincipal, type CommandEnvelopeSpec } from "../test-support/sim-envelopes";
import {
  atZone,
  heldBy,
  inContainer,
  meterDefinition,
  meterState,
  singleMeterBodyView,
  wornBy,
} from "../test-support/sim-material-fixtures";
import { simulationHash } from "./hash";
import { applyBodyEvent, emptyBodiesSeed } from "./bodies";
import type { ItemConditionView } from "./material-condition";
import {
  MATERIAL_CHAIN_DEPTH_CAP,
  applyMaterialEvent,
  assertMaterialsProjectionInvariants,
  materialsSeedProjection,
  replayMaterialsHistory,
  resolveConsumeItemFromView,
  resolveDestroyItemFromView,
  resolveRootLocus,
  resolveSetItemOwnershipFromView,
  resolveTransferItemFromView,
  sortMaterialsProjection,
  type MaterialResolutionView,
} from "./materials";

const WORLD = "world-e5-3";
const WORLD_TYPE = "world-type-e5-3";
const BRANCH = "branch-e5-3";
const RULESET = "e5-3-test-v1";
const ZONE_A = "zone-a";
const ZONE_B = "zone-b";
const LOC_A = "loc-a";
const LOC_B = "loc-b";

/**
 * This suite carries its own world/branch/ruleset trio, so the shared envelope
 * builders are bound to it once: a view's `branchId` must match the command's or
 * every resolver short-circuits to `branch_mismatch`.
 */
const sim = bindSimEnvelopes({ worldId: WORLD, branchId: BRANCH, rulesetVersion: RULESET });

interface TestActor {
  id: string;
  name: string;
  zoneId: string | null;
  locationId: string | null;
}

const baseActors: TestActor[] = [
  { id: "mara", name: "Mara", zoneId: ZONE_A, locationId: LOC_A },
  { id: "iris", name: "Iris", zoneId: ZONE_A, locationId: LOC_A },
  { id: "remo", name: "Remo", zoneId: ZONE_B, locationId: LOC_B },
];

function makeView(input: {
  actors?: TestActor[];
  items: SimulationMaterialItemInput[];
  headSequence?: number;
  storySecond?: number;
  /** itemId -> reserving activity id (§26.5); absent items are unreserved. */
  reservedBy?: Record<string, string>;
}): MaterialResolutionView {
  const actors = input.actors ?? baseActors;
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
  const items = input.items.map((item) => simulationMaterialItemSchema.parse(item));
  const itemsById = new Map<string, SimulationMaterialItem>(items.map((item) => [item.id, item]));
  const reservedBy = input.reservedBy ?? {};
  return {
    ...sim.meta({ headSequence: input.headSequence ?? 0, storySecond: input.storySecond ?? 10_000 }),
    version: 0,
    actorById: (id) => {
      const actor = actorsById.get(id);
      return actor ? { id: actor.id, name: actor.name } : undefined;
    },
    actorZoneId: (id) => actorsById.get(id)?.zoneId ?? null,
    actorLocationId: (id) => actorsById.get(id)?.locationId ?? null,
    itemById: (id) => itemsById.get(id),
    containerOccupantCount: (containerId) =>
      items.filter((item) => item.locus.kind === "container" && item.locus.containerItemId === containerId)
        .length,
    reservingActivityId: (id) => reservedBy[id] ?? null,
  };
}

/** Envelope-shaped tweaks a call site may layer on top of a command builder. */
type CmdSpec = Omit<CommandEnvelopeSpec, "type" | "payload">;

/** The acting player for every actor-driven command here; `mara` is the controlled actor. */
const maraPlayer = testPrincipal("player", ["mara"]);

function transferCmd(payload: TransferItemCommandInput["payload"], spec: CmdSpec = {}) {
  return sim.command(transferItemCommandSchema, {
    type: "transfer_item",
    schemaVersion: 2,
    principal: maraPlayer,
    payload,
    ...spec,
  });
}

function destroyCmd(payload: DestroyItemCommandInput["payload"], spec: CmdSpec = {}) {
  return sim.command(destroyItemCommandSchema, {
    type: "destroy_item",
    principal: maraPlayer,
    payload,
    ...spec,
  });
}

function consumeCmd(payload: ConsumeItemCommandInput["payload"], spec: CmdSpec = {}) {
  return sim.command(consumeItemCommandSchema, {
    type: "consume_item",
    principal: maraPlayer,
    payload,
    ...spec,
  });
}

function ownershipCmd(payload: SetItemOwnershipCommandInput["payload"], spec: CmdSpec = {}) {
  return sim.command(setItemOwnershipCommandSchema, {
    type: "set_item_ownership",
    payload,
    ...spec,
  });
}

/** A single held item and a transfer of it, for the common rejection scaffolding. */
function heldItemView(overrides: Partial<SimulationMaterialItemInput> = {}) {
  return makeView({
    items: [{ id: "item-x", name: "a thing", locus: heldBy("mara"), ...overrides }],
  });
}

// ---------------------------------------------------------------------------

describe("E5.3 root locus resolution", () => {
  const items = new Map<string, SimulationMaterialItem>(
    [
      { id: "box-1", name: "box one", container: { capacityCount: 4, access: { kind: "open" } }, locus: heldBy("mara") },
      { id: "box-2", name: "box two", container: { capacityCount: 4, access: { kind: "open" } }, locus: inContainer("box-1") },
      { id: "coin", name: "coin", locus: inContainer("box-2") },
    ].map((item) => {
      const parsed = simulationMaterialItemSchema.parse(item);
      return [parsed.id, parsed];
    }),
  );
  const lookup = (id: string) => items.get(id);

  it("walks a container chain to its rooting actor", () => {
    expect(resolveRootLocus(inContainer("box-2"), lookup)).toEqual({ kind: "actor", actorId: "mara" });
    expect(resolveRootLocus(heldBy("mara"), lookup)).toEqual({ kind: "actor", actorId: "mara" });
    expect(resolveRootLocus(atZone(ZONE_A), lookup)).toEqual({ kind: "zone", zoneId: ZONE_A });
    expect(resolveRootLocus({ kind: "gone", basis: "lost" }, lookup)).toEqual({ kind: "gone" });
  });

  it("reports a cycle instead of looping forever", () => {
    const cyclic = new Map<string, SimulationMaterialItem>(
      [
        { id: "a", name: "a", container: { capacityCount: 1, access: { kind: "open" } }, locus: inContainer("b") },
        { id: "b", name: "b", container: { capacityCount: 1, access: { kind: "open" } }, locus: inContainer("a") },
      ].map((item) => {
        const parsed = simulationMaterialItemSchema.parse(item);
        return [parsed.id, parsed];
      }),
    );
    expect(resolveRootLocus(inContainer("a"), (id) => cyclic.get(id))).toEqual({ kind: "cycle" });
  });

  it("caps the walk depth and treats a dangling container as unresolvable", () => {
    const deep = new Map<string, SimulationMaterialItem>();
    for (let index = 0; index <= MATERIAL_CHAIN_DEPTH_CAP + 1; index += 1) {
      const next = index === MATERIAL_CHAIN_DEPTH_CAP + 1 ? heldBy("mara") : inContainer(`c-${index + 1}`);
      const parsed = simulationMaterialItemSchema.parse({
        id: `c-${index}`,
        name: `container ${index}`,
        container: { capacityCount: 1, access: { kind: "open" } },
        locus: next,
      });
      deep.set(parsed.id, parsed);
    }
    expect(resolveRootLocus(inContainer("c-0"), (id) => deep.get(id))).toEqual({ kind: "cycle" });
    expect(resolveRootLocus(inContainer("ghost"), (id) => deep.get(id))).toEqual({ kind: "cycle" });
  });
});

describe("E5.3 transfer law — the fail-closed rejection order", () => {
  it("rejects a branch mismatch", () => {
    const result = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: atZone(ZONE_A) }, {
        branchId: "branch-other",
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "branch_mismatch" });
  });

  it("rejects an unknown actor and an uncontrolled actor", () => {
    const missing = resolveTransferItemFromView(
      makeView({ actors: [], items: [{ id: "item-x", name: "x", locus: atZone(ZONE_A) }] }),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: atZone(ZONE_A), toLocus: heldBy("mara") }),
    );
    expect(missing).toMatchObject({ ok: false, code: "actor_not_found" });

    const uncontrolled = resolveTransferItemFromView(
      heldItemView(),
      transferCmd(
        { actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: atZone(ZONE_A) },
        { principal: testPrincipal("player", ["iris"]) },
      ),
    );
    expect(uncontrolled).toMatchObject({ ok: false, code: "unauthorized_actor" });
  });

  it("rejects an unembodied actor", () => {
    const view = makeView({
      actors: [{ id: "mara", name: "Mara", zoneId: null, locationId: null }],
      items: [{ id: "item-x", name: "x", locus: heldBy("mara") }],
    });
    const result = resolveTransferItemFromView(
      view,
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: atZone(ZONE_A) }),
    );
    expect(result).toMatchObject({ ok: false, code: "actor_not_embodied" });
  });

  it("rejects a missing item, a gone item, and a stale source", () => {
    const missing = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "ghost", fromLocus: heldBy("mara"), toLocus: atZone(ZONE_A) }),
    );
    expect(missing).toMatchObject({ ok: false, code: "item_not_found" });

    const gone = resolveTransferItemFromView(
      heldItemView({ locus: { kind: "gone", basis: "lost" } }),
      transferCmd(
        { actorId: "mara", itemId: "item-x", fromLocus: { kind: "gone", basis: "lost" }, toLocus: heldBy("mara") },
      ),
    );
    expect(gone).toMatchObject({ ok: false, code: "item_gone" });

    const stale = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("iris"), toLocus: atZone(ZONE_A) }),
    );
    expect(stale).toMatchObject({ ok: false, code: "stale_source" });
  });

  it("rejects a malformed destination", () => {
    const ghostActor = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: heldBy("ghost") }),
    );
    expect(ghostActor).toMatchObject({ ok: false, code: "destination_not_found" });

    const ghostContainer = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: inContainer("ghost") }),
    );
    expect(ghostContainer).toMatchObject({ ok: false, code: "destination_not_found" });
  });

  it("rejects a source or destination whose root is not the actor's zone", () => {
    const remoteSource = resolveTransferItemFromView(
      makeView({ items: [{ id: "item-x", name: "x", locus: atZone(ZONE_B) }] }),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: atZone(ZONE_B), toLocus: heldBy("mara") }),
    );
    expect(remoteSource).toMatchObject({ ok: false, code: "root_not_colocated" });

    const remoteDest = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: atZone(ZONE_B) }),
    );
    expect(remoteDest).toMatchObject({ ok: false, code: "root_not_colocated" });
  });

  it("rejects a no-op that leaves the item exactly where it is", () => {
    const result = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: heldBy("mara") }),
    );
    expect(result).toMatchObject({ ok: false, code: "same_locus" });
  });
});

describe("E5.3 transfer law — sovereignty, dressing, and giving", () => {
  it("allows giving to a co-located other actor", () => {
    const result = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: heldBy("iris") }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects taking from another's hands or worn slots", () => {
    const held = resolveTransferItemFromView(
      heldItemView({ locus: heldBy("iris") }),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("iris"), toLocus: heldBy("mara") }),
    );
    expect(held).toMatchObject({ ok: false, code: "held_by_other" });

    const worn = resolveTransferItemFromView(
      heldItemView({ locus: wornBy("iris", "neck") }),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: wornBy("iris", "neck"), toLocus: heldBy("mara") }),
    );
    expect(worn).toMatchObject({ ok: false, code: "worn_by_other" });
  });

  it("permits self-dressing but forbids dressing someone else", () => {
    const onSelf = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: wornBy("mara", "head") }),
    );
    expect(onSelf).toMatchObject({ ok: true });

    const onOther = resolveTransferItemFromView(
      heldItemView(),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: wornBy("iris", "head") }),
    );
    expect(onOther).toMatchObject({ ok: false, code: "not_self_dressing" });
  });
});

describe("E5.3 transfer law — containers", () => {
  it("honors each access policy at the destination", () => {
    const openBag = makeView({
      items: [
        { id: "bag", name: "open bag", container: { capacityCount: 2, access: { kind: "open" } }, locus: heldBy("iris") },
        { id: "item-x", name: "x", locus: heldBy("mara") },
      ],
    });
    expect(
      resolveTransferItemFromView(
        openBag,
        transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: inContainer("bag") }),
      ),
    ).toMatchObject({ ok: true });

    const holderBag = makeView({
      items: [
        { id: "bag", name: "held bag", container: { capacityCount: 2, access: { kind: "holder_only" } }, locus: heldBy("iris") },
        { id: "item-x", name: "x", locus: heldBy("mara") },
      ],
    });
    expect(
      resolveTransferItemFromView(
        holderBag,
        transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: inContainer("bag") }),
      ),
    ).toMatchObject({ ok: false, code: "container_access_denied" });

    // The holder themselves may use it.
    const holderSelf = makeView({
      items: [
        { id: "bag", name: "held bag", container: { capacityCount: 2, access: { kind: "holder_only" } }, locus: heldBy("mara") },
        { id: "item-x", name: "x", locus: heldBy("mara") },
      ],
    });
    expect(
      resolveTransferItemFromView(
        holderSelf,
        transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: inContainer("bag") }),
      ),
    ).toMatchObject({ ok: true });

    const allowBag = (allowed: string) =>
      makeView({
        items: [
          {
            id: "bag",
            name: "allow bag",
            container: { capacityCount: 2, access: { kind: "allow_list", actorIds: [allowed] } },
            locus: heldBy("iris"),
          },
          { id: "item-x", name: "x", locus: heldBy("mara") },
        ],
      });
    expect(
      resolveTransferItemFromView(
        allowBag("iris"),
        transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: inContainer("bag") }),
      ),
    ).toMatchObject({ ok: false, code: "container_access_denied" });
    expect(
      resolveTransferItemFromView(
        allowBag("mara"),
        transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: inContainer("bag") }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("rejects a full destination", () => {
    const view = makeView({
      items: [
        { id: "bag", name: "tiny bag", container: { capacityCount: 1, access: { kind: "open" } }, locus: heldBy("mara") },
        { id: "resident", name: "resident", locus: inContainer("bag") },
        { id: "item-x", name: "x", locus: heldBy("mara") },
      ],
    });
    expect(
      resolveTransferItemFromView(
        view,
        transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: inContainer("bag") }),
      ),
    ).toMatchObject({ ok: false, code: "destination_full" });
  });

  it("rejects putting a container inside its own descendant", () => {
    const view = makeView({
      items: [
        { id: "outer", name: "outer", container: { capacityCount: 2, access: { kind: "open" } }, locus: heldBy("mara") },
        { id: "inner", name: "inner", container: { capacityCount: 2, access: { kind: "open" } }, locus: inContainer("outer") },
      ],
    });
    expect(
      resolveTransferItemFromView(
        view,
        transferCmd({ actorId: "mara", itemId: "outer", fromLocus: heldBy("mara"), toLocus: inContainer("inner") }),
      ),
    ).toMatchObject({ ok: false, code: "container_cycle" });
  });
});

describe("E5.3 transfer law — ownership flag", () => {
  const view = (ownerActorId: string | null) =>
    makeView({ items: [{ id: "item-x", name: "x", ownerActorId, locus: heldBy("mara") }] });

  const resolveGive = (ownerActorId: string | null) =>
    resolveTransferItemFromView(
      view(ownerActorId),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: heldBy("iris") }),
    );

  it("marks againstOwnership only when a set owner is not the acting actor", () => {
    const unowned = resolveGive(null);
    const ownSelf = resolveGive("mara");
    const ownOther = resolveGive("iris");
    expect(unowned).toMatchObject({ ok: true });
    expect(ownSelf).toMatchObject({ ok: true });
    expect(ownOther).toMatchObject({ ok: true });
    if (!unowned.ok || !ownSelf.ok || !ownOther.ok) throw new Error("expected acceptances");
    expect(unowned.events[0].payload.againstOwnership).toBe(false);
    expect(ownSelf.events[0].payload.againstOwnership).toBe(false);
    expect(ownOther.events[0].payload.againstOwnership).toBe(true);
  });
});

describe("E5.3 slice 3 — worn-window transition on transfer (§26.7)", () => {
  function trackedConditionView(overrides: Partial<ItemConditionView> = {}): ItemConditionView {
    return {
      itemId: "item-x",
      registryVersion: itemConditionRegistryVersion,
      meters: itemConditionRegistryV1.map((definition) =>
        itemConditionMeterStateSchema.parse({
          itemId: "item-x",
          meterKey: definition.key,
          valueFixedPoint: definition.initialFixedPoint,
          baselineFixedPoint: definition.baselineFixedPoint,
          lastIntegratedAtStorySecond: 10_000,
          registryVersion: itemConditionRegistryVersion,
        }),
      ),
      modifiers: [],
      ...overrides,
    };
  }

  it("dons: the item_transferred → item_condition_modifier_applied → re-arm train, in order and causation-chained", () => {
    const result = resolveTransferItemFromView(
      heldItemView({ conditionTracked: true }),
      transferCmd({
        actorId: "mara",
        itemId: "item-x",
        fromLocus: heldBy("mara"),
        toLocus: wornBy("mara", "torso"),
      }),
      trackedConditionView(),
    );
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.events).toHaveLength(3);
    const [transferred, applied, rearm] = result.events;
    expect(transferred.type).toBe("item_transferred");
    expect(applied?.type).toBe("item_condition_modifier_applied");
    expect(applied?.causationId).toBe(transferred.id);
    expect(rearm?.type).toBe("trigger_scheduled");
    expect(rearm?.causationId).toBe(applied?.id);
    const sequences = result.events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("doffs: ends the live worn-window modifier, causation-chained to the transfer", () => {
    const donned = resolveTransferItemFromView(
      heldItemView({ conditionTracked: true }),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: wornBy("mara", "torso") }),
      trackedConditionView(),
    );
    if (!donned.ok) throw new Error("expected acceptance");
    const [, applied] = donned.events;
    if (applied?.type !== "item_condition_modifier_applied") throw new Error("expected modifier applied");

    const doffed = resolveTransferItemFromView(
      makeView({
        items: [{ id: "item-x", name: "a thing", conditionTracked: true, locus: wornBy("mara", "torso") }],
      }),
      transferCmd({
        actorId: "mara",
        itemId: "item-x",
        fromLocus: wornBy("mara", "torso"),
        toLocus: heldBy("mara"),
      }),
      trackedConditionView({ modifiers: [applied.payload.modifier] }),
    );
    if (!doffed.ok) throw new Error("expected acceptance");
    const [transferred, ended] = doffed.events;
    expect(ended?.type).toBe("item_condition_modifier_ended");
    expect(ended?.causationId).toBe(transferred.id);
    if (ended?.type !== "item_condition_modifier_ended") throw new Error("expected modifier ended");
    expect(ended.payload).toMatchObject({
      itemId: "item-x",
      modifierId: applied.payload.modifier.id,
      basis: "doffed",
    });
  });

  it("an untracked item's worn-ness change emits only the transfer — nothing else", () => {
    const result = resolveTransferItemFromView(
      heldItemView({ conditionTracked: false }),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: wornBy("mara", "torso") }),
    );
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("item_transferred");
  });

  it("a worn-ness-preserving move on a tracked item emits only the transfer", () => {
    const result = resolveTransferItemFromView(
      heldItemView({ conditionTracked: true }),
      transferCmd({ actorId: "mara", itemId: "item-x", fromLocus: heldBy("mara"), toLocus: heldBy("iris") }),
      trackedConditionView(),
    );
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.events).toHaveLength(1);
  });
});

describe("E5.3 destroy law", () => {
  it("emits a destruction capturing the pre-gone locus and terminal basis", () => {
    const result = resolveDestroyItemFromView(
      makeView({ items: [{ id: "item-x", name: "x", ownerActorId: "iris", locus: heldBy("mara") }] }),
      destroyCmd({ actorId: "mara", itemId: "item-x", basis: "destroyed" }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.event.type).toBe("item_destroyed");
    expect(result.event.payload).toMatchObject({
      itemId: "item-x",
      basis: "destroyed",
      fromLocus: { kind: "held", actorId: "mara" },
      againstOwnership: true,
    });
  });

  it("refuses to destroy a gone item or another's worn item", () => {
    const gone = resolveDestroyItemFromView(
      makeView({ items: [{ id: "item-x", name: "x", locus: { kind: "gone", basis: "lost" } }] }),
      destroyCmd({ actorId: "mara", itemId: "item-x", basis: "destroyed" }),
    );
    expect(gone).toMatchObject({ ok: false, code: "item_gone" });

    const worn = resolveDestroyItemFromView(
      makeView({ items: [{ id: "item-x", name: "x", locus: wornBy("iris", "neck") }] }),
      destroyCmd({ actorId: "mara", itemId: "item-x", basis: "destroyed" }),
    );
    expect(worn).toMatchObject({ ok: false, code: "worn_by_other" });
  });

  it("treats a gone item as immutable — a later transfer of it is item_gone", () => {
    const result = resolveTransferItemFromView(
      makeView({ items: [{ id: "item-x", name: "x", locus: { kind: "gone", basis: "destroyed" } }] }),
      transferCmd(
        { actorId: "mara", itemId: "item-x", fromLocus: { kind: "gone", basis: "destroyed" }, toLocus: heldBy("mara") },
      ),
    );
    expect(result).toMatchObject({ ok: false, code: "item_gone" });
  });
});

describe("E5.3 set ownership", () => {
  it("lets the storyteller reassign ownership", () => {
    const result = resolveSetItemOwnershipFromView(
      makeView({ items: [{ id: "item-x", name: "x", ownerActorId: "iris", locus: heldBy("mara") }] }),
      ownershipCmd({ itemId: "item-x", newOwnerActorId: "mara" }),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.event.payload).toEqual({
      itemId: "item-x",
      previousOwnerActorId: "iris",
      newOwnerActorId: "mara",
    });
  });

  it("lets the current owner's controller reassign, but no one else", () => {
    const byOwner = resolveSetItemOwnershipFromView(
      makeView({ items: [{ id: "item-x", name: "x", ownerActorId: "mara", locus: heldBy("mara") }] }),
      ownershipCmd({ itemId: "item-x", newOwnerActorId: "iris" }, { principal: maraPlayer }),
    );
    expect(byOwner).toMatchObject({ ok: true });

    const byStranger = resolveSetItemOwnershipFromView(
      makeView({ items: [{ id: "item-x", name: "x", ownerActorId: "iris", locus: heldBy("mara") }] }),
      ownershipCmd({ itemId: "item-x", newOwnerActorId: "mara" }, { principal: maraPlayer }),
    );
    expect(byStranger).toMatchObject({ ok: false, code: "unauthorized_principal" });
  });

  it("rejects a gone item and an unknown new owner", () => {
    const gone = resolveSetItemOwnershipFromView(
      makeView({ items: [{ id: "item-x", name: "x", locus: { kind: "gone", basis: "lost" } }] }),
      ownershipCmd({ itemId: "item-x", newOwnerActorId: "mara" }),
    );
    expect(gone).toMatchObject({ ok: false, code: "item_gone" });

    const ghost = resolveSetItemOwnershipFromView(
      makeView({ items: [{ id: "item-x", name: "x", locus: heldBy("mara") }] }),
      ownershipCmd({ itemId: "item-x", newOwnerActorId: "ghost" }),
    );
    expect(ghost).toMatchObject({ ok: false, code: "actor_not_found" });
  });
});

describe("E5.3 projector, replay, seed, and invariants", () => {
  function seedInput() {
    return {
      worldId: WORLD,
      worldTypeId: WORLD_TYPE,
      worldSeed: "seed-token",
      branchId: BRANCH,
      rulesetVersion: RULESET,
      originStorySecond: 10_000,
      actors: [
        { id: "mara", name: "Mara" },
        { id: "iris", name: "Iris" },
      ],
      items: [
        { id: "bag", name: "bag", container: { capacityCount: 4, access: { kind: "open" } }, locus: heldBy("mara") },
        { id: "coin", name: "coin", ownerActorId: "iris", locus: inContainer("bag") },
      ],
    };
  }

  function viewFor(projection: MaterialsProjection): MaterialResolutionView {
    return makeView({
      items: projection.items.map((item) => item as SimulationMaterialItemInput),
      headSequence: projection.headSequence,
      storySecond: projection.storySecond,
    });
  }

  it("applies each material event and replays to the same projection (store parity)", () => {
    const seed = materialsSeedProjection(seedInput());

    const give = resolveTransferItemFromView(
      viewFor(seed),
      transferCmd({ actorId: "mara", itemId: "coin", fromLocus: inContainer("bag"), toLocus: heldBy("iris") }),
    );
    if (!give.ok) throw new Error("expected transfer acceptance");
    const afterGive = applyMaterialEvent(seed, give.events[0]);

    const reassign = resolveSetItemOwnershipFromView(
      viewFor(afterGive),
      ownershipCmd({ itemId: "coin", newOwnerActorId: "iris" }, { idSlug: "ownership-2" }),
    );
    if (!reassign.ok) throw new Error("expected ownership acceptance");
    const afterReassign = applyMaterialEvent(afterGive, reassign.event);

    expect(afterReassign.items.find((item) => item.id === "coin")?.locus).toEqual(heldBy("iris"));
    expect(afterReassign.items.find((item) => item.id === "coin")?.ownerActorId).toBe("iris");

    const replayed = replayMaterialsHistory({ seed, events: [give.events[0], reassign.event] });
    // The live store bumps version per command; normalize before comparing.
    const live = materialsProjectionSchema.parse({ ...afterReassign, version: seed.version + 2 });
    expect(simulationHash(replayed)).toBe(simulationHash(live));
    expect(replayed.version).toBe(2);
    expect(replayed.headSequence).toBe(2);
  });

  it("rejects a non-contiguous event and a foreign-branch event", () => {
    const seed = materialsSeedProjection(seedInput());
    const give = resolveTransferItemFromView(
      viewFor(seed),
      transferCmd({ actorId: "mara", itemId: "coin", fromLocus: inContainer("bag"), toLocus: heldBy("iris") }),
    );
    if (!give.ok) throw new Error("expected acceptance");
    const gapEvent = { ...give.events[0], sequence: seed.headSequence + 2 };
    expect(() => applyMaterialEvent(seed, gapEvent)).toThrow(/not contiguous/u);
    const foreign = itemTransferredEventSchema.parse({ ...give.events[0], branchId: "branch-other" });
    expect(() => applyMaterialEvent(seed, foreign)).toThrow(/another world branch/u);
  });

  it("passes a non-material event through as a bare boundary advance", () => {
    const seed = materialsSeedProjection(seedInput());
    const bodyEvent = sim.event(bodyInitializedEventSchema, {
      type: "body_initialized",
      idSlug: "body",
      sequence: seed.headSequence + 1,
      storySecond: 10_500,
      actorIds: ["mara"],
      entityIds: ["mara"],
      payload: {
        actorId: "mara",
        registryVersion: "body-v1",
        meters: [{ meterKey: "energy", valueFixedPoint: 5_000, baselineFixedPoint: 5_000 }],
      },
    });
    const next = applyMaterialEvent(seed, bodyEvent);
    expect(next.headSequence).toBe(seed.headSequence + 1);
    expect(next.storySecond).toBe(10_500);
    expect(next.items).toEqual(seed.items);
  });

  it("assembles a seed projection and enforces its structural invariants", () => {
    const seed = materialsSeedProjection(seedInput());
    expect(seed.version).toBe(0);
    expect(seed.headSequence).toBe(0);
    expect(() => assertMaterialsProjectionInvariants(seed)).not.toThrow();
  });

  it("throws on corrupt projections", () => {
    const base = materialsSeedProjection(seedInput());

    const duplicate = sortMaterialsProjection({
      ...base,
      items: [...base.items, { ...base.items[0]!, name: "clone" }],
    });
    expect(() => assertMaterialsProjectionInvariants(duplicate)).toThrow(/duplicate item/u);

    const missingContainer: MaterialsProjection = {
      ...base,
      items: [simulationMaterialItemSchema.parse({ id: "orphan", name: "orphan", locus: inContainer("ghost") })],
    };
    expect(() => assertMaterialsProjectionInvariants(missingContainer)).toThrow(/missing container/u);

    const overCapacity: MaterialsProjection = {
      ...base,
      items: [
        simulationMaterialItemSchema.parse({
          id: "bag",
          name: "bag",
          container: { capacityCount: 1, access: { kind: "open" } },
          locus: heldBy("mara"),
        }),
        simulationMaterialItemSchema.parse({ id: "a", name: "a", locus: inContainer("bag") }),
        simulationMaterialItemSchema.parse({ id: "b", name: "b", locus: inContainer("bag") }),
      ],
    };
    expect(() => assertMaterialsProjectionInvariants(overCapacity)).toThrow(/exceeds its capacity/u);

    const cyclic: MaterialsProjection = {
      ...base,
      items: [
        simulationMaterialItemSchema.parse({
          id: "a",
          name: "a",
          container: { capacityCount: 1, access: { kind: "open" } },
          locus: inContainer("b"),
        }),
        simulationMaterialItemSchema.parse({
          id: "b",
          name: "b",
          container: { capacityCount: 1, access: { kind: "open" } },
          locus: inContainer("a"),
        }),
      ],
    };
    expect(() => assertMaterialsProjectionInvariants(cyclic)).toThrow(/container cycle/u);
  });
});

// ---------------------------------------------------------------------------
// E5.3 slice 2 — resource reservations and consumption (§26.5–26.6)
// ---------------------------------------------------------------------------

/**
 * The shared hunger meter plus the falling `starving` threshold this suite's
 * re-arm math turns on (the shared fixture carries no thresholds).
 */
function hungerDefinition(): BodyMeterDefinition {
  return meterDefinition({
    thresholds: [
      {
        key: "starving",
        boundaryFixedPoint: 2_500,
        direction: "falling",
        outcome: { kind: "event_only" },
        noticeable: false,
      },
    ],
  });
}

function foodItem(overrides: Partial<SimulationMaterialItemInput> = {}): SimulationMaterialItemInput {
  return {
    id: "bread",
    name: "a loaf of bread",
    materialKindKey: "food",
    locus: heldBy("mara"),
    consumptionEffects: [
      { meterKey: "hunger", sourceKind: "meal", operation: { kind: "set", valueFixedPoint: 9_500 } },
    ],
    ...overrides,
  };
}

describe("E5.3 slice 2 — consume_item (§26.6)", () => {
  it("rejects an item with no authored consumption effects", () => {
    const noEffects = resolveConsumeItemFromView(
      makeView({ items: [{ id: "rock", name: "a rock", locus: heldBy("mara") }] }),
      consumeCmd({ actorId: "mara", itemId: "rock" }),
    );
    expect(noEffects).toMatchObject({ ok: false, code: "not_consumable" });

    const emptyEffects = resolveConsumeItemFromView(
      makeView({ items: [{ ...foodItem(), consumptionEffects: [] }] }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
    );
    expect(emptyEffects).toMatchObject({ ok: false, code: "not_consumable" });
  });

  it("rejects a gone item, an unreachable item, and someone else's held item", () => {
    const gone = resolveConsumeItemFromView(
      makeView({ items: [{ ...foodItem(), locus: { kind: "gone", basis: "lost" } }] }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
    );
    expect(gone).toMatchObject({ ok: false, code: "item_gone" });

    const remote = resolveConsumeItemFromView(
      makeView({ items: [{ ...foodItem(), locus: atZone(ZONE_B) }] }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
    );
    expect(remote).toMatchObject({ ok: false, code: "root_not_colocated" });

    const heldByOther = resolveConsumeItemFromView(
      makeView({ items: [{ ...foodItem(), locus: heldBy("iris") }] }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
    );
    expect(heldByOther).toMatchObject({ ok: false, code: "held_by_other" });
  });

  it("rejects a reserved item", () => {
    const result = resolveConsumeItemFromView(
      makeView({ items: [foodItem()], reservedBy: { bread: "activity-cooking" } }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
    );
    expect(result).toMatchObject({ ok: false, code: "item_reserved" });
  });

  it("consumes: locus goes gone/consumed, one trailing body effect and its re-armed threshold, one causation chain", () => {
    const view = makeView({ items: [foodItem()] });
    const bodyView = singleMeterBodyView(hungerDefinition());
    const result = resolveConsumeItemFromView(view, consumeCmd({ actorId: "mara", itemId: "bread" }), bodyView);
    if (!result.ok) throw new Error(`expected acceptance, got ${result.code}`);

    expect(result.event.type).toBe("item_consumed");
    expect(result.event.payload).toMatchObject({
      actorId: "mara",
      itemId: "bread",
      fromLocus: heldBy("mara"),
      againstOwnership: false,
    });
    expect(result.event.causationId).toBeUndefined();

    // One body_source_applied (the meal) + its own threshold re-arm, both
    // causation-chained back to the item_consumed event (never to each other
    // transitively) — the resolveBodyCollapse precedent.
    expect(result.bodyEvents.map((event) => event.type)).toEqual(["body_source_applied", "trigger_scheduled"]);
    const [sourceEvent, rearmEvent] = result.bodyEvents;
    expect(sourceEvent?.sequence).toBe(result.event.sequence + 1);
    expect(sourceEvent?.causationId).toBe(result.event.id);
    if (sourceEvent?.type !== "body_source_applied") throw new Error("expected body_source_applied");
    expect(sourceEvent.payload).toMatchObject({
      actorId: "mara",
      meterKey: "hunger",
      sourceKind: "meal",
      operation: { kind: "set", valueFixedPoint: 9_500 },
      valueAfterFixedPoint: 9_500,
    });
    expect(rearmEvent?.causationId).toBe(sourceEvent.id);
    if (rearmEvent?.type !== "trigger_scheduled") throw new Error("expected trigger_scheduled");
    // 9 500 → 2 500 at 150/h = 168 000s after the write (same law the E5.1 suite proves).
    expect(rearmEvent.payload.dueStorySecond).toBe(10_000 + 168_000);

    expect(result.meterUpdates).toHaveLength(1);
    expect(result.meterUpdates[0]?.valueFixedPoint).toBe(9_500);
  });

  it("emits zero body events when the actor has no initialized body — worlds without bodies still eat", () => {
    const withoutBodyView = resolveConsumeItemFromView(
      makeView({ items: [foodItem()] }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
    );
    if (!withoutBodyView.ok) throw new Error("expected acceptance");
    expect(withoutBodyView.bodyEvents).toEqual([]);
    expect(withoutBodyView.meterUpdates).toEqual([]);

    const uninitialized = resolveConsumeItemFromView(
      makeView({ items: [foodItem()] }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
      { bodyInitialized: false, meterView: () => undefined },
    );
    if (!uninitialized.ok) throw new Error("expected acceptance");
    expect(uninitialized.bodyEvents).toEqual([]);
    expect(uninitialized.meterUpdates).toEqual([]);
  });

  it("folds item_consumed into gone/consumed and enforces the source precondition on replay", () => {
    const result = resolveConsumeItemFromView(
      makeView({ items: [foodItem()] }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
      singleMeterBodyView(hungerDefinition()),
    );
    if (!result.ok) throw new Error("expected acceptance");

    const seed = materialsSeedProjection({
      worldId: WORLD,
      worldTypeId: WORLD_TYPE,
      worldSeed: "seed-consume",
      branchId: BRANCH,
      rulesetVersion: RULESET,
      originStorySecond: 10_000,
      actors: [{ id: "mara", name: "Mara" }],
      items: [foodItem()],
    });
    const next = applyMaterialEvent(seed, result.event);
    expect(next.items.find((item) => item.id === "bread")?.locus).toEqual({ kind: "gone", basis: "consumed" });
    assertMaterialsProjectionInvariants(next);

    // Re-applying the (now stale) event against its own new state is rejected —
    // the fromLocus precondition no longer matches what the projection holds.
    const staleReapply = { ...result.event, sequence: next.headSequence + 1 };
    expect(() => applyMaterialEvent(next, staleReapply)).toThrow(/source precondition failed/u);
  });

  it("replays a consumption's material + body events to the same state the resolvers produced", () => {
    const definition = hungerDefinition();
    const result = resolveConsumeItemFromView(
      makeView({ items: [foodItem()] }),
      consumeCmd({ actorId: "mara", itemId: "bread" }),
      singleMeterBodyView(definition),
    );
    if (!result.ok) throw new Error("expected acceptance");

    const materialSeed = materialsSeedProjection({
      worldId: WORLD,
      worldTypeId: WORLD_TYPE,
      worldSeed: "seed-consume-replay",
      branchId: BRANCH,
      rulesetVersion: RULESET,
      originStorySecond: 10_000,
      actors: [{ id: "mara", name: "Mara" }],
      items: [foodItem()],
    });
    const materialAfter = applyMaterialEvent(materialSeed, result.event);
    const materialReplayed = replayMaterialsHistory({ seed: materialSeed, events: [result.event] });
    expect(simulationHash(materialReplayed)).toBe(
      simulationHash(materialsProjectionSchema.parse({ ...materialAfter, version: materialSeed.version + 1 })),
    );

    // Fold the trailing body events onto a seed that already carries the
    // hunger meter (mirroring an already-initialized body) — a partitioned,
    // event-by-event fold lands on the exact math the resolver produced.
    const initialMeterState = meterState(definition, { lastIntegratedAtStorySecond: 10_000 });
    let bodyAfter = { ...emptyBodiesSeed(BRANCH, 10_000), meters: [initialMeterState] };
    for (const event of result.bodyEvents) bodyAfter = applyBodyEvent(bodyAfter, event);
    expect(bodyAfter.meters.find((meter) => meter.meterKey === "hunger")?.valueFixedPoint).toBe(9_500);
    expect(bodyAfter.headSequence).toBe(result.bodyEvents.at(-1)?.sequence);
  });
});

// ---------------------------------------------------------------------------
// E5.3 slice 2 — reservation blocks command-driven material paths (§26.5)
// ---------------------------------------------------------------------------

describe("E5.3 slice 2 — reservation blocks transfer, destroy, and consume", () => {
  it("rejects all three commands on a reserved item; an unreserved item is unaffected", () => {
    const reservedView = makeView({ items: [foodItem()], reservedBy: { bread: "activity-cooking" } });
    expect(
      resolveTransferItemFromView(
        reservedView,
        transferCmd({ actorId: "mara", itemId: "bread", fromLocus: heldBy("mara"), toLocus: heldBy("iris") }),
      ),
    ).toMatchObject({ ok: false, code: "item_reserved" });
    expect(
      resolveDestroyItemFromView(reservedView, destroyCmd({ actorId: "mara", itemId: "bread", basis: "destroyed" })),
    ).toMatchObject({ ok: false, code: "item_reserved" });
    expect(
      resolveConsumeItemFromView(reservedView, consumeCmd({ actorId: "mara", itemId: "bread" })),
    ).toMatchObject({ ok: false, code: "item_reserved" });

    const freeView = makeView({ items: [foodItem()] });
    expect(
      resolveTransferItemFromView(
        freeView,
        transferCmd({ actorId: "mara", itemId: "bread", fromLocus: heldBy("mara"), toLocus: heldBy("iris") }),
      ),
    ).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// E5.4 slice 2 — item_instantiated_from_promotion (materials-side fold, §7.2)
// ---------------------------------------------------------------------------

describe("E5.4 slice 2 applyMaterialEvent on item_instantiated_from_promotion", () => {
  function promotionSeedInput() {
    return {
      worldId: WORLD,
      worldTypeId: WORLD_TYPE,
      worldSeed: "seed-token",
      branchId: BRANCH,
      rulesetVersion: RULESET,
      originStorySecond: 10_000,
      actors: [
        { id: "mara", name: "Mara" },
        { id: "iris", name: "Iris" },
      ],
      items: [],
    };
  }

  function promotionEvent(
    overrides: Partial<{ itemId: string; sequence: number; locus: ItemLocus }> = {},
  ) {
    const itemId = overrides.itemId ?? "promoted-item";
    return sim.event(itemInstantiatedFromPromotionEventSchema, {
      type: "item_instantiated_from_promotion",
      idSlug: "promoted",
      sequence: overrides.sequence ?? 1,
      storySecond: 10_500,
      commandId: "cmd-promote",
      actorIds: ["mara"],
      entityIds: ["mara", itemId],
      overrides: { causationId: "event-lot-debit" },
      payload: {
        item: {
          id: itemId,
          name: "Camp Knife",
          materialKindKey: "food",
          ownerActorId: null,
          conditionTracked: false,
          locus: overrides.locus ?? heldBy("mara"),
        },
        sourceLocus: { kind: "household", householdId: "household-vance" },
        sourceMaterialKindKey: "food",
      },
    });
  }

  it("adds a new item without requiring it to pre-exist, unlike the other real cases", () => {
    const seed = materialsSeedProjection(promotionSeedInput());
    expect(seed.items.some((item) => item.id === "promoted-item")).toBe(false);
    const next = applyMaterialEvent(seed, promotionEvent());
    const added = next.items.find((item) => item.id === "promoted-item");
    expect(added).toMatchObject({ name: "Camp Knife", materialKindKey: "food", locus: heldBy("mara") });
  });

  it("throws on a duplicate-id replay", () => {
    const seed = materialsSeedProjection(promotionSeedInput());
    const first = applyMaterialEvent(seed, promotionEvent());
    const duplicate = promotionEvent({ sequence: 2 });
    expect(() => applyMaterialEvent(first, duplicate)).toThrow(/double-instantiates/u);
  });
});
