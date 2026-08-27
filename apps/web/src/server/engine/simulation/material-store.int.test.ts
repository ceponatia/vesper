import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { itemConditionRegistryV1 } from "@vesper/simulation-core/contracts/material-condition";
import type { ItemLocusInput } from "@vesper/simulation-core/contracts/materials";
import { newId } from "@/lib/ids";
import {
  db,
  simBodyMeters,
  simEvents,
  simItemConditionMeters,
  simItemConditionModifiers,
  simItemHoldings,
  simItems,
  simItemTransferFeed,
  simObservations,
  simTriggers,
} from "@/server/db";
import {
  expectAccepted,
  expectRejected,
  gmPrincipal,
  npcPrincipal,
  seedSimBranch,
  seedSimpleBranch,
  simCommand,
  simulationSuiteHarness,
  type SimCommandEnvelope,
  type SimTestPrincipal,
} from "@/server/test-support";
import { seedDurableActionDefinitions, submitDurableStartActivity } from "./activity-store";
import { submitDurableInitializeActorBody } from "./body-store";
import {
  submitDurableApplyItemConditionSource,
  submitDurableConsumeItem,
  submitDurableDestroyItem,
  submitDurableSetItemOwnership,
  submitDurableTransferItem,
} from "./material-store";
import { consumeNextItemTransferOutbox } from "./outbox-store";
import { advanceBranchStoryTime } from "./scheduler-store";

/**
 * E5.3 durable material lane: transfers, destruction, ownership, consumption
 * and item condition. Every principal here is `npc_policy` or
 * `storyteller`, neither of which needs the branch-owner match, so the suite
 * runs without the legacy-player opt-in (`legacyPlayerMode: false`).
 *
 * Cases are numerous and each seeds its own world, so teardown runs after EVERY
 * test (`cleanup: "afterEach"`) instead of piling hundreds of rows up to the end.
 */
const harness = await simulationSuiteHarness({
  suite: "material-store.int.test",
  table: "sim_item_holdings",
  legacyPlayerMode: false,
  cleanup: "afterEach",
});

const SEED_SECOND = 40_000;
const WORN_SLOT = "torso";

interface MaterialCase {
  worldId: string;
  branchId: string;
  locationId: string;
  /** A second, separate location — cross-zone sound within one location still
   * reaches an occupant (perception.ts's default `crossZoneSound`), so the
   * "a different-zone actor does not witness" case needs a different
   * LOCATION, not merely a different zone, to get zero observations. */
  remoteLocationId: string;
  zoneA: string;
  zoneB: string;
  /** Co-located with otherId at zoneA — the acting actor in most cases. */
  actorId: string;
  /** Co-located with actorId at zoneA. */
  otherId: string;
  /** At zoneB, in remoteLocationId — never co-located, same-location, or same-zone with actorId/otherId. */
  remoteId: string;
  /** held by actorId. */
  ringId: string;
  /** a container (capacity 1, open access) held by actorId, pre-filled by bagOccupantId. */
  bagId: string;
  bagOccupantId: string;
  /** a container (allow_list: [otherId]) resting at zoneA. */
  lockedBoxId: string;
  /** held by actorId — for worn tests. */
  cloakId: string;
  /** held by actorId, owned by otherId — for againstOwnership + set_item_ownership. */
  ownedRingId: string;
  /** held by actorId — a plain spare for drop/pickup/witness/destroy cases. */
  looseId: string;
  /** held by otherId — for the held_by_other rejection. */
  otherHeldId: string;
}

function makeIds(): MaterialCase {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    locationId: `${worldId}-loc-home`,
    remoteLocationId: `${worldId}-loc-away`,
    zoneA: `${branchId}-zone-a`,
    zoneB: `${branchId}-zone-b`,
    actorId: newId(),
    otherId: newId(),
    remoteId: newId(),
    ringId: newId(),
    bagId: newId(),
    bagOccupantId: newId(),
    lockedBoxId: newId(),
    cloakId: newId(),
    ownedRingId: newId(),
    looseId: newId(),
    otherHeldId: newId(),
  };
}

async function seedCase(ids: MaterialCase): Promise<void> {
  harness.trackWorld(ids.worldId);
  await seedSimBranch({
    worldId: ids.worldId,
    branchId: ids.branchId,
    worldTypeId: "e5-3-test-world",
    rulesetVersion: "e5-3-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara" },
      { id: ids.otherId, name: "Iris" },
      { id: ids.remoteId, name: "Rhea" },
    ],
    items: [
      { id: ids.ringId, name: "gold ring", ownerActorId: null, locus: { kind: "held", actorId: ids.actorId } },
      {
        id: ids.bagId,
        name: "canvas bag",
        ownerActorId: null,
        container: { capacityCount: 1, access: { kind: "open" } },
        locus: { kind: "held", actorId: ids.actorId },
      },
      { id: ids.bagOccupantId, name: "spare coin", ownerActorId: null, locus: { kind: "container", containerItemId: ids.bagId } },
      {
        id: ids.lockedBoxId,
        name: "locked box",
        ownerActorId: null,
        container: { capacityCount: 5, access: { kind: "allow_list", actorIds: [ids.otherId] } },
        // Held by otherId (not a static zone locus): its root resolves to
        // otherId's zone dynamically, so it needs no sim_zones row to exist
        // yet — space topology seeds AFTER this, satisfying the physical-locus
        // FK for characters this function itself just created.
        locus: { kind: "held", actorId: ids.otherId },
      },
      { id: ids.cloakId, name: "traveling cloak", ownerActorId: null, locus: { kind: "held", actorId: ids.actorId } },
      { id: ids.ownedRingId, name: "signet ring", ownerActorId: ids.otherId, locus: { kind: "held", actorId: ids.actorId } },
      { id: ids.looseId, name: "coin purse", ownerActorId: null, locus: { kind: "held", actorId: ids.actorId } },
      { id: ids.otherHeldId, name: "iris's fan", ownerActorId: null, locus: { kind: "held", actorId: ids.otherId } },
    ],
    locations: [
      { id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" },
      { id: ids.remoteLocationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" },
    ],
    zones: [
      { id: ids.zoneA, locationId: ids.locationId, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneB, locationId: ids.remoteLocationId, kind: "room", privacyPolicy: "private" },
    ],
    links: [],
    placements: [
      { actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneA },
      { actorId: ids.otherId, locationId: ids.locationId, zoneId: ids.zoneA },
      { actorId: ids.remoteId, locationId: ids.remoteLocationId, zoneId: ids.zoneB },
    ],
  });
}

interface TransferOverrides {
  expectedVersion: number;
  actorId: string;
  itemId: string;
  fromLocus: ItemLocusInput;
  toLocus: ItemLocusInput;
}

function transferCommand(
  ids: MaterialCase,
  name: string,
  overrides: Partial<TransferOverrides> = {},
): SimCommandEnvelope {
  const actorId = overrides.actorId ?? ids.actorId;
  return simCommand({
    branchId: ids.branchId,
    name,
    type: "transfer_item",
    expectedVersion: overrides.expectedVersion ?? 0,
    principal: npcPrincipal(actorId),
    payload: {
      actorId,
      itemId: overrides.itemId ?? ids.ringId,
      fromLocus: overrides.fromLocus ?? { kind: "held", actorId: ids.actorId },
      toLocus: overrides.toLocus ?? { kind: "held", actorId: ids.otherId },
    },
  });
}

function destroyCommand(
  ids: MaterialCase,
  name: string,
  overrides: Partial<{ expectedVersion: number; actorId: string; itemId: string; basis: "destroyed" | "lost" }> = {},
): SimCommandEnvelope {
  const actorId = overrides.actorId ?? ids.actorId;
  return simCommand({
    branchId: ids.branchId,
    name,
    type: "destroy_item",
    expectedVersion: overrides.expectedVersion ?? 0,
    principal: npcPrincipal(actorId),
    payload: {
      actorId,
      itemId: overrides.itemId ?? ids.ringId,
      basis: overrides.basis ?? "destroyed",
    },
  });
}

function ownershipCommand(
  ids: MaterialCase,
  name: string,
  overrides: Partial<{
    expectedVersion: number;
    itemId: string;
    newOwnerActorId: string;
    principal: SimTestPrincipal;
  }> = {},
): SimCommandEnvelope {
  return simCommand({
    branchId: ids.branchId,
    name,
    type: "set_item_ownership",
    expectedVersion: overrides.expectedVersion ?? 0,
    principal: overrides.principal ?? gmPrincipal,
    payload: {
      itemId: overrides.itemId ?? ids.ownedRingId,
      newOwnerActorId: overrides.newOwnerActorId ?? ids.actorId,
    },
  });
}

async function readHolding(branchId: string, itemId: string) {
  const [row] = await db()
    .select()
    .from(simItemHoldings)
    .where(and(eq(simItemHoldings.branchId, branchId), eq(simItemHoldings.itemId, itemId)));
  return row;
}

describe.runIf(harness.ready)("E5.3 durable material branch transaction", () => {
  it("accepts a held-to-held give between co-located actors and projects the feed row", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, "give", {
      itemId: ids.ringId,
      toLocus: { kind: "held", actorId: ids.otherId },
    });

    const result = await submitDurableTransferItem(command);
    expectAccepted(result, "held-to-held give");
    expect(result).toMatchObject({ branchVersion: 1, firstSequence: 1, lastSequence: 1 });

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "item_transferred", schemaVersion: 2 });

    const holding = await readHolding(ids.branchId, ids.ringId);
    expect(holding).toMatchObject({
      locusKind: "held",
      actorId: ids.otherId,
      slotKey: null,
      containerItemId: null,
      zoneId: null,
      goneBasis: null,
    });

    const consumed = await consumeNextItemTransferOutbox({ workerId: "test-worker" });
    expect(consumed).toMatchObject({ status: "completed", branchId: ids.branchId, throughSequence: 1 });

    const [feedRow] = await db()
      .select()
      .from(simItemTransferFeed)
      .where(and(eq(simItemTransferFeed.branchId, ids.branchId), eq(simItemTransferFeed.sourceEventId, result.eventIds[0]!)));
    expect(feedRow).toMatchObject({
      eventKind: "item_transferred",
      actorId: ids.actorId,
      itemId: ids.ringId,
      fromLocus: { kind: "held", actorId: ids.actorId },
      toLocus: { kind: "held", actorId: ids.otherId },
    });
  });

  it("rejects taking an item held by another actor", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, "take", {
      itemId: ids.otherHeldId,
      fromLocus: { kind: "held", actorId: ids.otherId },
      toLocus: { kind: "held", actorId: ids.actorId },
    });

    const result = await submitDurableTransferItem(command);
    expectRejected(result, "held_by_other", "taking another actor's item");
    const holding = await readHolding(ids.branchId, ids.otherHeldId);
    expect(holding).toMatchObject({ locusKind: "held", actorId: ids.otherId });
  });

  it("rejects a transfer into an already-full container", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, "into-bag", {
      itemId: ids.ringId,
      toLocus: { kind: "container", containerItemId: ids.bagId },
    });

    const result = await submitDurableTransferItem(command);
    expectRejected(result, "destination_full", "transfer into a full container");
  });

  it("rejects a transfer into a container the actor is not on the allow list for", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, "into-box", {
      itemId: ids.ringId,
      toLocus: { kind: "container", containerItemId: ids.lockedBoxId },
    });

    const result = await submitDurableTransferItem(command);
    expectRejected(result, "container_access_denied", "transfer into a locked container");

    // The allow-listed actor succeeds against the same container.
    const allowed = transferCommand(ids, "into-box-allowed", {
      actorId: ids.otherId,
      itemId: ids.otherHeldId,
      fromLocus: { kind: "held", actorId: ids.otherId },
      toLocus: { kind: "container", containerItemId: ids.lockedBoxId },
    });
    expectAccepted(await submitDurableTransferItem(allowed), "allow-listed transfer");
  });

  it("carries an item through a zone drop and pickup arc", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const drop = await submitDurableTransferItem(
      transferCommand(ids, "drop", { itemId: ids.looseId, toLocus: { kind: "zone", zoneId: ids.zoneA } }),
    );
    expectAccepted(drop, "zone drop");
    expect(drop).toMatchObject({ branchVersion: 1 });
    expect(await readHolding(ids.branchId, ids.looseId)).toMatchObject({ locusKind: "zone", zoneId: ids.zoneA });

    const pickup = await submitDurableTransferItem(
      transferCommand(ids, "pickup", {
        actorId: ids.otherId,
        itemId: ids.looseId,
        expectedVersion: 1,
        fromLocus: { kind: "zone", zoneId: ids.zoneA },
        toLocus: { kind: "held", actorId: ids.otherId },
      }),
    );
    expectAccepted(pickup, "zone pickup");
    expect(pickup).toMatchObject({ branchVersion: 2 });
    expect(await readHolding(ids.branchId, ids.looseId)).toMatchObject({ locusKind: "held", actorId: ids.otherId });
  });

  it("accepts self-dressing but rejects dressing another actor", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const wearSelf = await submitDurableTransferItem(
      transferCommand(ids, "wear-self", {
        itemId: ids.cloakId,
        toLocus: { kind: "worn", actorId: ids.actorId, slotKey: WORN_SLOT },
      }),
    );
    expectAccepted(wearSelf, "self-dressing");
    expect(await readHolding(ids.branchId, ids.cloakId)).toMatchObject({
      locusKind: "worn",
      actorId: ids.actorId,
      slotKey: WORN_SLOT,
    });

    const dressOther = await submitDurableTransferItem(
      transferCommand(ids, "dress-other", {
        itemId: ids.looseId,
        expectedVersion: 1,
        toLocus: { kind: "worn", actorId: ids.otherId, slotKey: WORN_SLOT },
      }),
    );
    expectRejected(dressOther, "not_self_dressing", "dressing another actor");
  });

  it("destroys an item to a terminal gone locus and rejects a later transfer of it", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const result = await submitDurableDestroyItem(
      destroyCommand(ids, "destroy", { itemId: ids.ringId, basis: "destroyed" }),
    );
    expectAccepted(result, "item destruction");
    expect(result).toMatchObject({ branchVersion: 1 });
    expect(await readHolding(ids.branchId, ids.ringId)).toMatchObject({ locusKind: "gone", goneBasis: "destroyed" });

    const [event] = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(event).toMatchObject({ type: "item_destroyed" });

    const consumed = await consumeNextItemTransferOutbox({ workerId: "test-worker" });
    expect(consumed).toMatchObject({ status: "completed" });
    const [feedRow] = await db()
      .select()
      .from(simItemTransferFeed)
      .where(and(eq(simItemTransferFeed.branchId, ids.branchId), eq(simItemTransferFeed.itemId, ids.ringId)));
    expect(feedRow).toMatchObject({ eventKind: "item_destroyed", toLocus: { kind: "gone", basis: "destroyed" } });

    const afterGone = await submitDurableTransferItem(
      transferCommand(ids, "after-gone", {
        itemId: ids.ringId,
        expectedVersion: 1,
        fromLocus: { kind: "held", actorId: ids.actorId },
      }),
    );
    expectRejected(afterGone, "item_gone", "transferring a destroyed item");
  });

  it("stamps againstOwnership on a non-owner transfer and lets the storyteller reassign ownership", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const result = await submitDurableTransferItem(
      transferCommand(ids, "give-owned", {
        itemId: ids.ownedRingId,
        toLocus: { kind: "held", actorId: ids.otherId },
      }),
    );
    expectAccepted(result, "non-owner give");
    const [event] = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.id, result.eventIds[0]!)));
    expect(event?.payload).toMatchObject({ againstOwnership: true });

    const ownershipResult = await submitDurableSetItemOwnership(
      ownershipCommand(ids, "reassign", { expectedVersion: 1, newOwnerActorId: ids.actorId }),
    );
    expectAccepted(ownershipResult, "storyteller reassignment");
    const [itemRow] = await db().select().from(simItems).where(and(eq(simItems.branchId, ids.branchId), eq(simItems.itemId, ids.ownedRingId)));
    expect(itemRow).toMatchObject({ ownerActorId: ids.actorId });

    const deniedReassign = await submitDurableSetItemOwnership(
      ownershipCommand(ids, "reassign-denied", {
        expectedVersion: 2,
        newOwnerActorId: ids.otherId,
        principal: npcPrincipal(ids.otherId),
      }),
    );
    expectRejected(deniedReassign, "unauthorized_principal", "npc reassignment");
  });

  it("replays an idempotent resubmission as the cached result without a second event", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, "replay", { itemId: ids.ringId });

    const first = await submitDurableTransferItem(command);
    expectAccepted(first, "first transfer");
    const replay = await submitDurableTransferItem(command);
    expect(replay).toEqual(first);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
  });

  it("serializes concurrent same-version submissions to one acceptance and one conflict", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const [outcomeA, outcomeB] = await Promise.all([
      submitDurableTransferItem(transferCommand(ids, "concurrent-a", { itemId: ids.ringId })),
      submitDurableTransferItem(
        transferCommand(ids, "concurrent-b", {
          itemId: ids.cloakId,
          toLocus: { kind: "held", actorId: ids.otherId },
        }),
      ),
    ]);
    expect([outcomeA.status, outcomeB.status].sort()).toEqual(["accepted", "conflict"]);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
  });

  it("derives a same-zone witness observation and excludes a different-zone actor", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const result = await submitDurableTransferItem(
      transferCommand(ids, "drop-witness", { itemId: ids.looseId, toLocus: { kind: "zone", zoneId: ids.zoneA } }),
    );
    expectAccepted(result, "witnessed drop");

    const witnesses = await db()
      .select({ witnessActorId: simObservations.witnessActorId })
      .from(simObservations)
      .where(and(eq(simObservations.branchId, ids.branchId), eq(simObservations.sourceEventId, result.eventIds[0]!)));
    const witnessIds = witnesses.map((row) => row.witnessActorId).sort();
    expect(witnessIds).toContain(ids.actorId);
    expect(witnessIds).toContain(ids.otherId);
    expect(witnessIds).not.toContain(ids.remoteId);
  });
});

// ---------------------------------------------------------------------------
// E5.3 slice 2 — consume_item
// ---------------------------------------------------------------------------

interface ConsumeCase {
  worldId: string;
  branchId: string;
  locationId: string;
  zoneId: string;
  actorId: string;
  /** held by actorId; carries a real energy-restoring consumption effect. */
  mealId: string;
  /** held by actorId; a second, independent consumable (for the conflict case). */
  waterId: string;
  /** held by actorId; carries no consumptionEffects at all. */
  rockId: string;
}

async function seedConsumeCase(): Promise<ConsumeCase> {
  const worldId = newId();
  const actorId = newId();
  const mealId = newId();
  const waterId = newId();
  const rockId = newId();
  harness.trackWorld(worldId);
  const seeded = await seedSimpleBranch({
    prefix: "e5-3-test",
    worldId,
    originStorySecond: SEED_SECOND,
    actors: [{ id: actorId, name: "Mara" }],
    locationSlug: "kitchen",
    zoneSlug: "kitchen",
    defaultAccessPolicy: "private",
    privacyPolicy: "private",
    items: [
      {
        id: mealId,
        name: "a bowl of stew",
        materialKindKey: "food",
        ownerActorId: null,
        consumptionEffects: [
          { meterKey: "energy", sourceKind: "meal", operation: { kind: "set", valueFixedPoint: 9_999 } },
        ],
        locus: { kind: "held", actorId },
      },
      {
        id: waterId,
        name: "a canteen of water",
        materialKindKey: "drink",
        ownerActorId: null,
        consumptionEffects: [
          { meterKey: "hygiene", sourceKind: "drink", operation: { kind: "set", valueFixedPoint: 9_500 } },
        ],
        locus: { kind: "held", actorId },
      },
      { id: rockId, name: "a plain rock", ownerActorId: null, locus: { kind: "held", actorId } },
    ],
  });
  return {
    worldId: seeded.worldId,
    branchId: seeded.branchId,
    locationId: seeded.locationId,
    zoneId: seeded.zoneId,
    actorId,
    mealId,
    waterId,
    rockId,
  };
}

function consumeCommand(
  ids: ConsumeCase,
  name: string,
  overrides: Partial<{ expectedVersion: number; actorId: string; itemId: string }> = {},
): SimCommandEnvelope {
  const actorId = overrides.actorId ?? ids.actorId;
  return simCommand({
    branchId: ids.branchId,
    name,
    type: "consume_item",
    expectedVersion: overrides.expectedVersion ?? 0,
    principal: npcPrincipal(actorId),
    payload: { actorId, itemId: overrides.itemId ?? ids.mealId },
  });
}

function initializeBodyCommand(ids: ConsumeCase): SimCommandEnvelope {
  return simCommand({
    branchId: ids.branchId,
    name: "init",
    type: "initialize_actor_body",
    principal: gmPrincipal,
    payload: { actorId: ids.actorId, registryVersion: "body-v1", baselineOverrides: {} },
  });
}

async function pendingDepletedTriggers(branchId: string) {
  return db()
    .select({ uniquenessKey: simTriggers.uniquenessKey, state: simTriggers.state })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.kind, "body_threshold_due")))
    .then((rows) => rows.filter((row) => row.uniquenessKey.includes("depleted")));
}

describe.runIf(harness.ready)("E5.3 slice 2 — consume_item", () => {
  it("consumes a held meal: holdings go gone/consumed, the body meter moves, the stale alarm retires and a fresh one arms, and the feed carries item_consumed", async () => {
    const ids = await seedConsumeCase();
    const initialized = await submitDurableInitializeActorBody(initializeBodyCommand(ids));
    expectAccepted(initialized, "body initialization");

    const beforeConsume = await pendingDepletedTriggers(ids.branchId);
    expect(beforeConsume.map((row) => row.state)).toEqual(["pending"]);

    const command = consumeCommand(ids, "consume", { itemId: ids.mealId, expectedVersion: 1 });
    const result = await submitDurableConsumeItem(command);
    expectAccepted(result, "meal consumption");
    expect(result).toMatchObject({ branchVersion: 2 });
    // item_consumed + body_source_applied + its threshold re-arm.
    expect(result.eventIds).toHaveLength(3);

    expect(await readHolding(ids.branchId, ids.mealId)).toMatchObject({
      locusKind: "gone",
      goneBasis: "consumed",
    });

    const [consumedEvent] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "item_consumed")));
    expect(consumedEvent).toMatchObject({ type: "item_consumed" });

    const [sourceEvent] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "body_source_applied")));
    expect(sourceEvent).toMatchObject({ causationId: consumedEvent?.id });
    expect(sourceEvent?.payload).toMatchObject({
      actorId: ids.actorId,
      meterKey: "energy",
      sourceKind: "meal",
      operation: { kind: "set", valueFixedPoint: 9_999 },
      valueAfterFixedPoint: 9_999,
    });

    const [meterRow] = await db()
      .select()
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, ids.branchId), eq(simBodyMeters.meterKey, "energy")));
    expect(meterRow).toMatchObject({ valueFixedPoint: 9_999 });

    const afterConsume = await pendingDepletedTriggers(ids.branchId);
    expect(afterConsume.map((row) => row.state).sort()).toEqual(["completed", "pending"]);

    const consumedOutbox = await consumeNextItemTransferOutbox({ workerId: "test-worker" });
    expect(consumedOutbox).toMatchObject({ status: "completed" });
    const [feedRow] = await db()
      .select()
      .from(simItemTransferFeed)
      .where(and(eq(simItemTransferFeed.branchId, ids.branchId), eq(simItemTransferFeed.itemId, ids.mealId)));
    expect(feedRow).toMatchObject({
      eventKind: "item_consumed",
      actorId: ids.actorId,
      itemId: ids.mealId,
      toLocus: { kind: "gone", basis: "consumed" },
    });
  });

  it("consumes without an initialized body: succeeds with zero body events", async () => {
    const ids = await seedConsumeCase();

    const result = await submitDurableConsumeItem(consumeCommand(ids, "consume", { itemId: ids.mealId }));
    expectAccepted(result, "consumption without a body");
    expect(result).toMatchObject({ branchVersion: 1 });
    expect(result.eventIds).toHaveLength(1);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "item_consumed" });
    expect(await readHolding(ids.branchId, ids.mealId)).toMatchObject({
      locusKind: "gone",
      goneBasis: "consumed",
    });
  });

  it("rejects an item without authored consumption effects", async () => {
    const ids = await seedConsumeCase();

    const result = await submitDurableConsumeItem(consumeCommand(ids, "consume-rock", { itemId: ids.rockId }));
    expectRejected(result, "not_consumable", "consuming a rock");
    expect(await readHolding(ids.branchId, ids.rockId)).toMatchObject({
      locusKind: "held",
      actorId: ids.actorId,
    });
  });

  it("replays an idempotent resubmission as the cached result without a second event", async () => {
    const ids = await seedConsumeCase();
    const command = consumeCommand(ids, "consume", { itemId: ids.mealId });

    const first = await submitDurableConsumeItem(command);
    expectAccepted(first, "first consumption");
    const replay = await submitDurableConsumeItem(command);
    expect(replay).toEqual(first);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
  });

  it("serializes concurrent same-version submissions to one acceptance and one conflict", async () => {
    const ids = await seedConsumeCase();

    const [outcomeA, outcomeB] = await Promise.all([
      submitDurableConsumeItem(consumeCommand(ids, "consume-a", { itemId: ids.mealId })),
      submitDurableConsumeItem(consumeCommand(ids, "consume-b", { itemId: ids.waterId })),
    ]);
    expect([outcomeA.status, outcomeB.status].sort()).toEqual(["accepted", "conflict"]);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
  });

  // The end-to-end reservation leg: a start-time reservation held by a live
  // activity must block a bystander's consume_item with item_reserved.
  it("rejects consuming an item a live activity has reserved", async () => {
    const ids = await seedConsumeCase();
    await seedDurableActionDefinitions({
      branchId: ids.branchId,
      definitions: [
        {
          id: "cook-with-food",
          version: 1,
          controllerKinds: ["npc_policy"],
          duration: { kind: "fixed", seconds: 600 },
          preconditions: [],
          requiredClaims: [],
          interruptibility: "free",
          noticeability: "private",
          resourceCosts: [{ materialKindKey: "food", quantity: 1, disposition: "use" }],
        },
      ],
    });
    const started = await submitDurableStartActivity(
      simCommand({
        branchId: ids.branchId,
        name: "start-cooking",
        type: "start_activity",
        principal: npcPrincipal(ids.actorId),
        payload: { actionDefinitionId: "cook-with-food", actorId: ids.actorId },
      }),
    );
    expectAccepted(started, "activity start");

    const result = await submitDurableConsumeItem(
      consumeCommand(ids, "consume", { itemId: ids.mealId, expectedVersion: 1 }),
    );
    expectRejected(result, "item_reserved", "consuming a reserved item");
  });
});

// ---------------------------------------------------------------------------
// E5.3 slice 3 — item condition
// ---------------------------------------------------------------------------

// Registry v1: cleanliness 10 000 → grimy at 3 000, +250/h while worn ⇒
// (10 000 − 3 000) / 250 = 28 worn-hours (material-condition.test.ts's own
// rearm assertion: `meta.storySecond + 28 * 3_600`).
const GRIMY_CROSSING_SECONDS = 28 * 3_600;

interface ConditionCase {
  worldId: string;
  branchId: string;
  locationId: string;
  zoneId: string;
  actorId: string;
  /** Co-located with actorId — the noticeable-crossing witness. */
  witnessId: string;
  /** conditionTracked: true, held by actorId. */
  garmentId: string;
  /** conditionTracked: false (the default), held by actorId — the negative control. */
  plainItemId: string;
}

async function seedConditionCase(): Promise<ConditionCase> {
  const worldId = newId();
  const actorId = newId();
  const witnessId = newId();
  const garmentId = newId();
  const plainItemId = newId();
  harness.trackWorld(worldId);
  const seeded = await seedSimpleBranch({
    prefix: "e5-3-test",
    worldId,
    originStorySecond: SEED_SECOND,
    actors: [
      { id: actorId, name: "Mara" },
      { id: witnessId, name: "Iris" },
    ],
    locationSlug: "condition",
    zoneSlug: "condition",
    defaultAccessPolicy: "private",
    privacyPolicy: "private",
    items: [
      {
        id: garmentId,
        name: "a linen shirt",
        ownerActorId: null,
        conditionTracked: true,
        locus: { kind: "held", actorId },
      },
      {
        id: plainItemId,
        name: "a plain stone",
        ownerActorId: null,
        locus: { kind: "held", actorId },
      },
    ],
  });
  return {
    worldId: seeded.worldId,
    branchId: seeded.branchId,
    locationId: seeded.locationId,
    zoneId: seeded.zoneId,
    actorId,
    witnessId,
    garmentId,
    plainItemId,
  };
}

function donCommand(
  ids: ConditionCase,
  name = "don",
  overrides: Partial<{ expectedVersion: number; itemId: string }> = {},
): SimCommandEnvelope {
  return simCommand({
    branchId: ids.branchId,
    name,
    type: "transfer_item",
    expectedVersion: overrides.expectedVersion ?? 0,
    principal: npcPrincipal(ids.actorId),
    payload: {
      actorId: ids.actorId,
      itemId: overrides.itemId ?? ids.garmentId,
      fromLocus: { kind: "held", actorId: ids.actorId },
      toLocus: { kind: "worn", actorId: ids.actorId, slotKey: WORN_SLOT },
    },
  });
}

function doffCommand(
  ids: ConditionCase,
  name = "doff",
  overrides: Partial<{ expectedVersion: number; itemId: string }> = {},
): SimCommandEnvelope {
  return simCommand({
    branchId: ids.branchId,
    name,
    type: "transfer_item",
    expectedVersion: overrides.expectedVersion ?? 1,
    principal: npcPrincipal(ids.actorId),
    payload: {
      actorId: ids.actorId,
      itemId: overrides.itemId ?? ids.garmentId,
      fromLocus: { kind: "worn", actorId: ids.actorId, slotKey: WORN_SLOT },
      toLocus: { kind: "held", actorId: ids.actorId },
    },
  });
}

async function itemConditionMeterRows(branchId: string, itemId: string) {
  return db()
    .select()
    .from(simItemConditionMeters)
    .where(and(eq(simItemConditionMeters.branchId, branchId), eq(simItemConditionMeters.itemId, itemId)));
}

async function itemConditionModifierRows(branchId: string, itemId: string) {
  return db()
    .select()
    .from(simItemConditionModifiers)
    .where(and(eq(simItemConditionModifiers.branchId, branchId), eq(simItemConditionModifiers.itemId, itemId)));
}

async function pendingItemConditionTriggers(branchId: string) {
  return db()
    .select({
      state: simTriggers.state,
      uniquenessKey: simTriggers.uniquenessKey,
      dueStorySecond: simTriggers.dueStorySecond,
    })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.kind, "item_condition_threshold_due")));
}

describe.runIf(harness.ready)("E5.3 slice 3 — item condition", () => {
  it("dons a tracked garment: meters lazily initialize, the worn-window modifier applies, and the grimy alarm arms at the exact solved second", async () => {
    const ids = await seedConditionCase();

    const result = await submitDurableTransferItem(donCommand(ids));
    expectAccepted(result, "donning a tracked garment");
    expect(result).toMatchObject({ branchVersion: 1, firstSequence: 1, lastSequence: 4 });
    expect(result.eventIds).toHaveLength(4);

    const events = await db()
      .select({ type: simEvents.type, sequence: simEvents.sequence })
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(simEvents.sequence);
    expect(events.map((event) => event.type)).toEqual([
      "item_condition_initialized",
      "item_transferred",
      "item_condition_modifier_applied",
      "trigger_scheduled",
    ]);

    const meters = await itemConditionMeterRows(ids.branchId, ids.garmentId);
    // Every meter the registry defines is initialized — derived, not restated,
    // so a new registry meter fails here instead of passing silently.
    expect(meters.map((meter) => meter.meterKey).sort()).toEqual(
      itemConditionRegistryV1.map((definition) => definition.key).sort(),
    );
    expect(meters.every((meter) => meter.lastIntegratedAt === SEED_SECOND)).toBe(true);
    expect(meters.find((meter) => meter.meterKey === "cleanliness")).toMatchObject({ valueFixedPoint: 10_000 });
    expect(meters.find((meter) => meter.meterKey === "wear")).toMatchObject({ valueFixedPoint: 0 });

    const modifiers = await itemConditionModifierRows(ids.branchId, ids.garmentId);
    expect(modifiers).toHaveLength(1);
    expect(modifiers[0]).toMatchObject({
      meterKey: "cleanliness",
      stackingGroup: "worn-window",
      validFrom: SEED_SECOND,
      validUntil: null,
    });

    const triggers = await pendingItemConditionTriggers(ids.branchId);
    expect(triggers.filter((trigger) => trigger.state === "pending")).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      state: "pending",
      dueStorySecond: SEED_SECOND + GRIMY_CROSSING_SECONDS,
    });
  });

  it("doffing ends the worn-window modifier and retires the alarm without a stale re-arm", async () => {
    const ids = await seedConditionCase();
    const donResult = await submitDurableTransferItem(donCommand(ids));
    expectAccepted(donResult, "donning before the doff");

    // Three real worn-hours pass before doffing — advancing to a second still
    // well short of the grimy alarm's due second, so nothing drains here.
    const doffSecond = SEED_SECOND + 3 * 3_600;
    const advanced = await advanceBranchStoryTime(ids.branchId, doffSecond, { workerId: "w-condition-doff" });
    expect(advanced).toMatchObject({ status: "advanced", drained: 0 });

    const doffResult = await submitDurableTransferItem(doffCommand(ids));
    expectAccepted(doffResult, "doffing the garment");

    const modifiers = await itemConditionModifierRows(ids.branchId, ids.garmentId);
    expect(modifiers).toHaveLength(1);
    expect(modifiers[0]).toMatchObject({ validFrom: SEED_SECOND, validUntil: doffSecond });

    // No live modifier remains and cleanliness's own base rate is zero, so
    // there is nothing left to solve a future crossing against — the doff
    // retires the seed-time alarm and re-arms nothing (an at-rest garment
    // never fouls on its own, per the registry doc comment).
    const triggers = await pendingItemConditionTriggers(ids.branchId);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ state: "completed" });
  });

  it("drains a due grimy alarm through the scheduler and witnesses the co-located actor, excluding the wearer", async () => {
    const ids = await seedConditionCase();
    expectAccepted(await submitDurableTransferItem(donCommand(ids)), "donning before the drain");

    const crossingSecond = SEED_SECOND + GRIMY_CROSSING_SECONDS;
    const outcome = await advanceBranchStoryTime(ids.branchId, crossingSecond, { workerId: "w-condition-grimy" });
    expect(outcome).toMatchObject({ status: "advanced", drained: 1 });

    const meters = await itemConditionMeterRows(ids.branchId, ids.garmentId);
    expect(meters.find((meter) => meter.meterKey === "cleanliness")).toMatchObject({
      valueFixedPoint: 3_000,
      lastIntegratedAt: crossingSecond,
    });

    const [crossedEvent] = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "item_condition_threshold_crossed")));
    expect(crossedEvent?.payload).toMatchObject({
      itemId: ids.garmentId,
      meterKey: "cleanliness",
      thresholdKey: "grimy",
      direction: "falling",
      boundaryFixedPoint: 3_000,
      valueFixedPoint: 3_000,
      // The wearer is excluded (they are the item's own holder, not an
      // external witness); the co-located bystander lands in the set.
      observerActorIds: [ids.witnessId],
    });

    const triggers = await pendingItemConditionTriggers(ids.branchId);
    expect(triggers.every((trigger) => trigger.state === "completed")).toBe(true);
  });

  it("apply_item_condition_source cleans a worn garment, restoring cleanliness and re-arming from the new second", async () => {
    const ids = await seedConditionCase();
    expectAccepted(await submitDurableTransferItem(donCommand(ids)), "donning before the clean");

    const cleanSecond = SEED_SECOND + 14 * 3_600;
    const advanced = await advanceBranchStoryTime(ids.branchId, cleanSecond, { workerId: "w-condition-clean" });
    expect(advanced).toMatchObject({ status: "advanced", drained: 0 });

    const cleanCommand = simCommand({
      branchId: ids.branchId,
      name: "clean",
      type: "apply_item_condition_source",
      expectedVersion: 1,
      principal: npcPrincipal(ids.actorId),
      payload: {
        actorId: ids.actorId,
        itemId: ids.garmentId,
        sourceKind: "clean",
        meterKey: "cleanliness",
        operation: { kind: "set", valueFixedPoint: 10_000 },
      },
    });
    const result = await submitDurableApplyItemConditionSource(cleanCommand);
    expectAccepted(result, "cleaning the garment");

    const meters = await itemConditionMeterRows(ids.branchId, ids.garmentId);
    expect(meters.find((meter) => meter.meterKey === "cleanliness")).toMatchObject({
      valueFixedPoint: 10_000,
      lastIntegratedAt: cleanSecond,
    });

    const triggers = await pendingItemConditionTriggers(ids.branchId);
    expect(triggers.map((trigger) => trigger.state).sort()).toEqual(["completed", "pending"]);
    const rearmed = triggers.find((trigger) => trigger.state === "pending");
    // Re-armed from the CLEANING second, not the original don second.
    expect(rearmed?.dueStorySecond).toBe(cleanSecond + GRIMY_CROSSING_SECONDS);

    // Idempotency: resubmitting the identical command replays the cached
    // result rather than persisting a second round of events.
    const replay = await submitDurableApplyItemConditionSource(cleanCommand);
    expect(replay).toEqual(result);
    const sourceAppliedEvents = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "item_condition_source_applied")));
    expect(sourceAppliedEvents).toHaveLength(1);
  });

  it("rejects apply_item_condition_source against an untracked item", async () => {
    const ids = await seedConditionCase();

    const result = await submitDurableApplyItemConditionSource(
      simCommand({
        branchId: ids.branchId,
        name: "clean-untracked",
        type: "apply_item_condition_source",
        principal: npcPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          itemId: ids.plainItemId,
          sourceKind: "adjustment",
          meterKey: "cleanliness",
          operation: { kind: "set", valueFixedPoint: 10_000 },
        },
      }),
    );
    expectRejected(result, "condition_not_tracked", "cleaning an untracked item");
  });

  it("an untracked item's transfers never produce condition rows or events", async () => {
    const ids = await seedConditionCase();

    const result = await submitDurableTransferItem(
      simCommand({
        branchId: ids.branchId,
        name: "wear-plain",
        type: "transfer_item",
        principal: npcPrincipal(ids.actorId),
        payload: {
          actorId: ids.actorId,
          itemId: ids.plainItemId,
          fromLocus: { kind: "held", actorId: ids.actorId },
          toLocus: { kind: "worn", actorId: ids.actorId, slotKey: WORN_SLOT },
        },
      }),
    );
    expectAccepted(result, "wearing an untracked item");
    expect(result).toMatchObject({ branchVersion: 1, firstSequence: 1, lastSequence: 1 });
    expect(result.eventIds).toHaveLength(1);

    expect(await itemConditionMeterRows(ids.branchId, ids.plainItemId)).toHaveLength(0);
    expect(await itemConditionModifierRows(ids.branchId, ids.plainItemId)).toHaveLength(0);

    const events = await db().select({ type: simEvents.type }).from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events.map((event) => event.type)).toEqual(["item_transferred"]);
  });
});
