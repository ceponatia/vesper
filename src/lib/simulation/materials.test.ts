import { describe, expect, it } from "vitest";
import {
  destroyItemCommandSchema,
  itemLocusSchema,
  itemTransferredEventSchema,
  materialsProjectionSchema,
  setItemOwnershipCommandSchema,
  simulationMaterialItemSchema,
  transferItemCommandSchema,
  type DestroyItemCommandInput,
  type ItemLocus,
  type MaterialsProjection,
  type SetItemOwnershipCommandInput,
  type SimulationMaterialItem,
  type SimulationMaterialItemInput,
  type TransferItemCommandInput,
} from "@/contracts/simulation/materials";
import { bodyInitializedEventSchema } from "@/contracts/simulation/bodies";
import { simulationHash, sortedUnique } from "./hash";
import {
  MATERIAL_CHAIN_DEPTH_CAP,
  applyMaterialEvent,
  assertMaterialsProjectionInvariants,
  materialsSeedProjection,
  replayMaterialsHistory,
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

const heldBy = (actorId: string): ItemLocus => itemLocusSchema.parse({ kind: "held", actorId });
const wornBy = (actorId: string, slotKey: string): ItemLocus =>
  itemLocusSchema.parse({ kind: "worn", actorId, slotKey });
const inContainer = (containerItemId: string): ItemLocus =>
  itemLocusSchema.parse({ kind: "container", containerItemId });
const atZone = (zoneId: string): ItemLocus => itemLocusSchema.parse({ kind: "zone", zoneId });

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
}): MaterialResolutionView {
  const actors = input.actors ?? baseActors;
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
  const items = input.items.map((item) => simulationMaterialItemSchema.parse(item));
  const itemsById = new Map<string, SimulationMaterialItem>(items.map((item) => [item.id, item]));
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    version: 0,
    headSequence: input.headSequence ?? 0,
    storySecond: input.storySecond ?? 10_000,
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
  };
}

function principal(kind: TransferItemCommandInput["principal"]["kind"], controlled: string[] = []) {
  return { kind, principalId: "principal-1", controlledActorIds: sortedUnique(controlled) };
}

function transferCmd(
  payload: TransferItemCommandInput["payload"],
  overrides: Partial<Omit<TransferItemCommandInput, "payload">> = {},
) {
  return transferItemCommandSchema.parse({
    id: "cmd-transfer",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-transfer",
    principal: principal("player", ["mara"]),
    submittedAtWallClock: "2026-07-19T10:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 2,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

function destroyCmd(
  payload: DestroyItemCommandInput["payload"],
  overrides: Partial<Omit<DestroyItemCommandInput, "payload">> = {},
) {
  return destroyItemCommandSchema.parse({
    id: "cmd-destroy",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-destroy",
    principal: principal("player", ["mara"]),
    submittedAtWallClock: "2026-07-19T10:00:00.000Z",
    type: "destroy_item",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

function ownershipCmd(
  payload: SetItemOwnershipCommandInput["payload"],
  overrides: Partial<Omit<SetItemOwnershipCommandInput, "payload">> = {},
) {
  return setItemOwnershipCommandSchema.parse({
    id: "cmd-ownership",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-ownership",
    principal: principal("storyteller"),
    submittedAtWallClock: "2026-07-19T10:00:00.000Z",
    type: "set_item_ownership",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
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
        { principal: principal("player", ["iris"]) },
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
    expect(unowned.event.payload.againstOwnership).toBe(false);
    expect(ownSelf.event.payload.againstOwnership).toBe(false);
    expect(ownOther.event.payload.againstOwnership).toBe(true);
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
      ownershipCmd({ itemId: "item-x", newOwnerActorId: "iris" }, { principal: principal("player", ["mara"]) }),
    );
    expect(byOwner).toMatchObject({ ok: true });

    const byStranger = resolveSetItemOwnershipFromView(
      makeView({ items: [{ id: "item-x", name: "x", ownerActorId: "iris", locus: heldBy("mara") }] }),
      ownershipCmd({ itemId: "item-x", newOwnerActorId: "mara" }, { principal: principal("player", ["mara"]) }),
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
    const afterGive = applyMaterialEvent(seed, give.event);

    const reassign = resolveSetItemOwnershipFromView(
      viewFor(afterGive),
      ownershipCmd({ itemId: "coin", newOwnerActorId: "iris" }, { id: "cmd-ownership-2", idempotencyKey: "idem-2" }),
    );
    if (!reassign.ok) throw new Error("expected ownership acceptance");
    const afterReassign = applyMaterialEvent(afterGive, reassign.event);

    expect(afterReassign.items.find((item) => item.id === "coin")?.locus).toEqual(heldBy("iris"));
    expect(afterReassign.items.find((item) => item.id === "coin")?.ownerActorId).toBe("iris");

    const replayed = replayMaterialsHistory({ seed, events: [give.event, reassign.event] });
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
    const gapEvent = { ...give.event, sequence: seed.headSequence + 2 };
    expect(() => applyMaterialEvent(seed, gapEvent)).toThrow(/not contiguous/u);
    const foreign = itemTransferredEventSchema.parse({ ...give.event, branchId: "branch-other" });
    expect(() => applyMaterialEvent(seed, foreign)).toThrow(/another world branch/u);
  });

  it("passes a non-material event through as a bare boundary advance", () => {
    const seed = materialsSeedProjection(seedInput());
    const bodyEvent = bodyInitializedEventSchema.parse({
      id: "event-body",
      worldId: WORLD,
      branchId: BRANCH,
      sequence: seed.headSequence + 1,
      storySecond: 10_500,
      type: "body_initialized",
      schemaVersion: 1,
      rulesetVersion: RULESET,
      correlationId: "corr-1",
      actorIds: ["mara"],
      entityIds: ["mara"],
      recordedAtWallClock: "2026-07-19T10:00:00.000Z",
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
