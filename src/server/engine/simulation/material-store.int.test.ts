import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  consumeItemCommandSchema,
  destroyItemCommandSchema,
  setItemOwnershipCommandSchema,
  transferItemCommandSchema,
  type ConsumeItemCommand,
  type DestroyItemCommand,
  type ItemLocusInput,
  type SetItemOwnershipCommand,
  type TransferItemCommand,
} from "@/contracts/simulation/materials";
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
  simWorlds,
} from "@/server/db";
import { seedDurableActionDefinitions, submitDurableStartActivity } from "./activity-store";
import { submitDurableInitializeActorBody } from "./body-store";
import {
  seedDurableMaterialBranch,
  submitDurableApplyItemConditionSource,
  submitDurableConsumeItem,
  submitDurableDestroyItem,
  submitDurableSetItemOwnership,
  submitDurableTransferItem,
} from "./material-store";
import { consumeNextItemTransferOutbox } from "./outbox-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { seedDurableSpaceTopology } from "./space-store";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_item_holdings limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") {
      throw error;
    }
    process.stderr.write(
      `[material-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const seededWorldIds: string[] = [];

afterEach(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  for (const worldId of seededWorldIds.splice(0)) {
    await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
  }
});

afterAll(async () => {
  await globalThis.__vesperPool?.end();
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
  seededWorldIds.push(ids.worldId);
  await seedDurableMaterialBranch({
    worldId: ids.worldId,
    worldTypeId: "e5-3-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
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
  });
  await seedDurableSpaceTopology({
    branchId: ids.branchId,
    locations: [
      { id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" },
      { id: ids.remoteLocationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" },
    ],
    zones: [
      { id: ids.zoneA, locationId: ids.locationId, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneB, locationId: ids.remoteLocationId, kind: "room", privacyPolicy: "private" },
    ],
    links: [],
    loci: [
      { kind: "at", actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneA, since: SEED_SECOND },
      { kind: "at", actorId: ids.otherId, locationId: ids.locationId, zoneId: ids.zoneA, since: SEED_SECOND },
      { kind: "at", actorId: ids.remoteId, locationId: ids.remoteLocationId, zoneId: ids.zoneB, since: SEED_SECOND },
    ],
  });
}

function transferCommand(
  ids: MaterialCase,
  overrides: Partial<{
    id: string;
    idempotencyKey: string;
    expectedVersion: number;
    actorId: string;
    itemId: string;
    fromLocus: ItemLocusInput;
    toLocus: ItemLocusInput;
    controlledActorIds: string[];
    principalKind: string;
  }> = {},
): TransferItemCommand {
  return transferItemCommandSchema.parse({
    id: overrides.id ?? newId(),
    branchId: ids.branchId,
    expectedVersion: overrides.expectedVersion ?? 0,
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    principal: {
      kind: overrides.principalKind ?? "npc_policy",
      principalId: newId(),
      controlledActorIds: overrides.controlledActorIds ?? [overrides.actorId ?? ids.actorId],
    },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 2,
    correlationId: newId(),
    payload: {
      actorId: overrides.actorId ?? ids.actorId,
      itemId: overrides.itemId ?? ids.ringId,
      fromLocus: overrides.fromLocus ?? { kind: "held", actorId: ids.actorId },
      toLocus: overrides.toLocus ?? { kind: "held", actorId: ids.otherId },
    },
  });
}

function destroyCommand(
  ids: MaterialCase,
  overrides: Partial<{
    id: string;
    idempotencyKey: string;
    expectedVersion: number;
    actorId: string;
    itemId: string;
    basis: "destroyed" | "lost";
  }> = {},
): DestroyItemCommand {
  return destroyItemCommandSchema.parse({
    id: overrides.id ?? newId(),
    branchId: ids.branchId,
    expectedVersion: overrides.expectedVersion ?? 0,
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    principal: {
      kind: "npc_policy",
      principalId: newId(),
      controlledActorIds: [overrides.actorId ?? ids.actorId],
    },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    type: "destroy_item",
    schemaVersion: 1,
    correlationId: newId(),
    payload: {
      actorId: overrides.actorId ?? ids.actorId,
      itemId: overrides.itemId ?? ids.ringId,
      basis: overrides.basis ?? "destroyed",
    },
  });
}

function ownershipCommand(
  ids: MaterialCase,
  overrides: Partial<{
    id: string;
    idempotencyKey: string;
    expectedVersion: number;
    itemId: string;
    newOwnerActorId: string | null;
    principalKind: string;
    controlledActorIds: string[];
  }> = {},
): SetItemOwnershipCommand {
  return setItemOwnershipCommandSchema.parse({
    id: overrides.id ?? newId(),
    branchId: ids.branchId,
    expectedVersion: overrides.expectedVersion ?? 0,
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    principal: {
      kind: overrides.principalKind ?? "storyteller",
      principalId: newId(),
      controlledActorIds: overrides.controlledActorIds ?? [],
    },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    type: "set_item_ownership",
    schemaVersion: 1,
    correlationId: newId(),
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

describe("E5.3 durable material branch transaction", () => {
  it("accepts a held-to-held give between co-located actors and projects the feed row", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, { itemId: ids.ringId, toLocus: { kind: "held", actorId: ids.otherId } });

    const result = await submitDurableTransferItem(command);
    expect(result).toMatchObject({ status: "accepted", branchVersion: 1, firstSequence: 1, lastSequence: 1 });
    if (result.status !== "accepted") throw new Error("expected acceptance");

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

  it("rejects taking an item held by another actor", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, {
      itemId: ids.otherHeldId,
      fromLocus: { kind: "held", actorId: ids.otherId },
      toLocus: { kind: "held", actorId: ids.actorId },
    });

    const result = await submitDurableTransferItem(command);
    expect(result).toMatchObject({ status: "rejected", code: "held_by_other" });
    const holding = await readHolding(ids.branchId, ids.otherHeldId);
    expect(holding).toMatchObject({ locusKind: "held", actorId: ids.otherId });
  });

  it("rejects a transfer into an already-full container", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, { itemId: ids.ringId, toLocus: { kind: "container", containerItemId: ids.bagId } });

    const result = await submitDurableTransferItem(command);
    expect(result).toMatchObject({ status: "rejected", code: "destination_full" });
  });

  it("rejects a transfer into a container the actor is not on the allow list for", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, { itemId: ids.ringId, toLocus: { kind: "container", containerItemId: ids.lockedBoxId } });

    const result = await submitDurableTransferItem(command);
    expect(result).toMatchObject({ status: "rejected", code: "container_access_denied" });

    // The allow-listed actor succeeds against the same container.
    const allowed = transferCommand(ids, {
      actorId: ids.otherId,
      itemId: ids.otherHeldId,
      fromLocus: { kind: "held", actorId: ids.otherId },
      toLocus: { kind: "container", containerItemId: ids.lockedBoxId },
    });
    expect(await submitDurableTransferItem(allowed)).toMatchObject({ status: "accepted" });
  });

  it("carries an item through a zone drop and pickup arc", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);

    const drop = transferCommand(ids, { itemId: ids.looseId, toLocus: { kind: "zone", zoneId: ids.zoneA } });
    expect(await submitDurableTransferItem(drop)).toMatchObject({ status: "accepted", branchVersion: 1 });
    expect(await readHolding(ids.branchId, ids.looseId)).toMatchObject({ locusKind: "zone", zoneId: ids.zoneA });

    const pickup = transferCommand(ids, {
      actorId: ids.otherId,
      itemId: ids.looseId,
      expectedVersion: 1,
      fromLocus: { kind: "zone", zoneId: ids.zoneA },
      toLocus: { kind: "held", actorId: ids.otherId },
    });
    expect(await submitDurableTransferItem(pickup)).toMatchObject({ status: "accepted", branchVersion: 2 });
    expect(await readHolding(ids.branchId, ids.looseId)).toMatchObject({ locusKind: "held", actorId: ids.otherId });
  });

  it("accepts self-dressing but rejects dressing another actor", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);

    const wearSelf = transferCommand(ids, {
      itemId: ids.cloakId,
      toLocus: { kind: "worn", actorId: ids.actorId, slotKey: WORN_SLOT },
    });
    expect(await submitDurableTransferItem(wearSelf)).toMatchObject({ status: "accepted" });
    expect(await readHolding(ids.branchId, ids.cloakId)).toMatchObject({
      locusKind: "worn",
      actorId: ids.actorId,
      slotKey: WORN_SLOT,
    });

    const dressOther = transferCommand(ids, {
      itemId: ids.looseId,
      expectedVersion: 1,
      toLocus: { kind: "worn", actorId: ids.otherId, slotKey: WORN_SLOT },
    });
    expect(await submitDurableTransferItem(dressOther)).toMatchObject({ status: "rejected", code: "not_self_dressing" });
  });

  it("destroys an item to a terminal gone locus and rejects a later transfer of it", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);

    const destroy = destroyCommand(ids, { itemId: ids.ringId, basis: "destroyed" });
    const result = await submitDurableDestroyItem(destroy);
    expect(result).toMatchObject({ status: "accepted", branchVersion: 1 });
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

    const afterGone = transferCommand(ids, {
      itemId: ids.ringId,
      expectedVersion: 1,
      fromLocus: { kind: "held", actorId: ids.actorId },
    });
    expect(await submitDurableTransferItem(afterGone)).toMatchObject({ status: "rejected", code: "item_gone" });
  });

  it("stamps againstOwnership on a non-owner transfer and lets the storyteller reassign ownership", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);

    const give = transferCommand(ids, { itemId: ids.ownedRingId, toLocus: { kind: "held", actorId: ids.otherId } });
    const result = await submitDurableTransferItem(give);
    expect(result).toMatchObject({ status: "accepted" });
    if (result.status !== "accepted") throw new Error("expected acceptance");
    const [event] = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.id, result.eventIds[0]!)));
    expect(event?.payload).toMatchObject({ againstOwnership: true });

    const reassign = ownershipCommand(ids, { expectedVersion: 1, newOwnerActorId: ids.actorId });
    const ownershipResult = await submitDurableSetItemOwnership(reassign);
    expect(ownershipResult).toMatchObject({ status: "accepted" });
    const [itemRow] = await db().select().from(simItems).where(and(eq(simItems.branchId, ids.branchId), eq(simItems.itemId, ids.ownedRingId)));
    expect(itemRow).toMatchObject({ ownerActorId: ids.actorId });

    const deniedReassign = ownershipCommand(ids, {
      expectedVersion: 2,
      newOwnerActorId: ids.otherId,
      principalKind: "npc_policy",
      controlledActorIds: [ids.otherId],
    });
    expect(await submitDurableSetItemOwnership(deniedReassign)).toMatchObject({
      status: "rejected",
      code: "unauthorized_principal",
    });
  });

  it("replays an idempotent resubmission as the cached result without a second event", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, { itemId: ids.ringId });

    const first = await submitDurableTransferItem(command);
    expect(first).toMatchObject({ status: "accepted" });
    const replay = await submitDurableTransferItem(command);
    expect(replay).toEqual(first);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
  });

  it("serializes concurrent same-version submissions to one acceptance and one conflict", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);

    const [outcomeA, outcomeB] = await Promise.all([
      submitDurableTransferItem(transferCommand(ids, { itemId: ids.ringId })),
      submitDurableTransferItem(transferCommand(ids, { itemId: ids.cloakId, toLocus: { kind: "held", actorId: ids.otherId } })),
    ]);
    expect([outcomeA.status, outcomeB.status].sort()).toEqual(["accepted", "conflict"]);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
  });

  it("derives a same-zone witness observation and excludes a different-zone actor", async (test) => {
    if (!ready) return test.skip();
    const ids = makeIds();
    await seedCase(ids);
    const command = transferCommand(ids, { itemId: ids.looseId, toLocus: { kind: "zone", zoneId: ids.zoneA } });

    const result = await submitDurableTransferItem(command);
    expect(result).toMatchObject({ status: "accepted" });
    if (result.status !== "accepted") throw new Error("expected acceptance");

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
// E5.3 slice 2 — consume_item (§26.6)
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

function makeConsumeIds(): ConsumeCase {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    locationId: `${worldId}-loc-kitchen`,
    zoneId: `${branchId}-zone-kitchen`,
    actorId: newId(),
    mealId: newId(),
    waterId: newId(),
    rockId: newId(),
  };
}

async function seedConsumeCase(ids: ConsumeCase): Promise<void> {
  seededWorldIds.push(ids.worldId);
  await seedDurableMaterialBranch({
    worldId: ids.worldId,
    worldTypeId: "e5-3-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e5-3-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [{ id: ids.actorId, name: "Mara" }],
    items: [
      {
        id: ids.mealId,
        name: "a bowl of stew",
        materialKindKey: "food",
        ownerActorId: null,
        consumptionEffects: [
          { meterKey: "energy", sourceKind: "meal", operation: { kind: "set", valueFixedPoint: 9_999 } },
        ],
        locus: { kind: "held", actorId: ids.actorId },
      },
      {
        id: ids.waterId,
        name: "a canteen of water",
        materialKindKey: "drink",
        ownerActorId: null,
        consumptionEffects: [
          { meterKey: "hygiene", sourceKind: "drink", operation: { kind: "set", valueFixedPoint: 9_500 } },
        ],
        locus: { kind: "held", actorId: ids.actorId },
      },
      { id: ids.rockId, name: "a plain rock", ownerActorId: null, locus: { kind: "held", actorId: ids.actorId } },
    ],
  });
  await seedDurableSpaceTopology({
    branchId: ids.branchId,
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "room", privacyPolicy: "private" }],
    links: [],
    loci: [{ kind: "at", actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND }],
  });
}

function consumeCommand(
  ids: ConsumeCase,
  overrides: Partial<{
    id: string;
    idempotencyKey: string;
    expectedVersion: number;
    actorId: string;
    itemId: string;
  }> = {},
): ConsumeItemCommand {
  return consumeItemCommandSchema.parse({
    id: overrides.id ?? newId(),
    branchId: ids.branchId,
    expectedVersion: overrides.expectedVersion ?? 0,
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    principal: {
      kind: "npc_policy",
      principalId: newId(),
      controlledActorIds: [overrides.actorId ?? ids.actorId],
    },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    type: "consume_item",
    schemaVersion: 1,
    correlationId: newId(),
    payload: {
      actorId: overrides.actorId ?? ids.actorId,
      itemId: overrides.itemId ?? ids.mealId,
    },
  });
}

function initializeBodyCommand(ids: ConsumeCase) {
  return {
    id: `cmd-init-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `init-key-${ids.branchId}`,
    principal: { kind: "storyteller", principalId: "principal-1", controlledActorIds: [] },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "initialize_actor_body",
    schemaVersion: 1,
    payload: { actorId: ids.actorId, registryVersion: "body-v1", baselineOverrides: {} },
  };
}

async function pendingDepletedTriggers(branchId: string) {
  return db()
    .select({ uniquenessKey: simTriggers.uniquenessKey, state: simTriggers.state })
    .from(simTriggers)
    .where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.kind, "body_threshold_due")))
    .then((rows) => rows.filter((row) => row.uniquenessKey.includes("depleted")));
}

describe("E5.3 slice 2 — consume_item (§26.6)", () => {
  it("consumes a held meal: holdings go gone/consumed, the body meter moves, the stale alarm retires and a fresh one arms, and the feed carries item_consumed", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConsumeIds();
    await seedConsumeCase(ids);
    const initialized = await submitDurableInitializeActorBody(initializeBodyCommand(ids));
    expect(initialized.status).toBe("accepted");

    const beforeConsume = await pendingDepletedTriggers(ids.branchId);
    expect(beforeConsume.map((row) => row.state)).toEqual(["pending"]);

    const command = consumeCommand(ids, { itemId: ids.mealId, expectedVersion: 1 });
    const result = await submitDurableConsumeItem(command);
    expect(result).toMatchObject({ status: "accepted", branchVersion: 2 });
    if (result.status !== "accepted") throw new Error("expected acceptance");
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

  it("consumes without an initialized body: succeeds with zero body events", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConsumeIds();
    await seedConsumeCase(ids);

    const result = await submitDurableConsumeItem(consumeCommand(ids, { itemId: ids.mealId }));
    expect(result).toMatchObject({ status: "accepted", branchVersion: 1 });
    if (result.status !== "accepted") throw new Error("expected acceptance");
    expect(result.eventIds).toHaveLength(1);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "item_consumed" });
    expect(await readHolding(ids.branchId, ids.mealId)).toMatchObject({
      locusKind: "gone",
      goneBasis: "consumed",
    });
  });

  it("rejects an item without authored consumption effects", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConsumeIds();
    await seedConsumeCase(ids);

    const result = await submitDurableConsumeItem(consumeCommand(ids, { itemId: ids.rockId }));
    expect(result).toMatchObject({ status: "rejected", code: "not_consumable" });
    expect(await readHolding(ids.branchId, ids.rockId)).toMatchObject({
      locusKind: "held",
      actorId: ids.actorId,
    });
  });

  it("replays an idempotent resubmission as the cached result without a second event", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConsumeIds();
    await seedConsumeCase(ids);
    const command = consumeCommand(ids, { itemId: ids.mealId });

    const first = await submitDurableConsumeItem(command);
    expect(first).toMatchObject({ status: "accepted" });
    const replay = await submitDurableConsumeItem(command);
    expect(replay).toEqual(first);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
  });

  it("serializes concurrent same-version submissions to one acceptance and one conflict", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConsumeIds();
    await seedConsumeCase(ids);

    const [outcomeA, outcomeB] = await Promise.all([
      submitDurableConsumeItem(consumeCommand(ids, { itemId: ids.mealId })),
      submitDurableConsumeItem(consumeCommand(ids, { itemId: ids.waterId })),
    ]);
    expect([outcomeA.status, outcomeB.status].sort()).toEqual(["accepted", "conflict"]);

    const events = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events).toHaveLength(1);
  });

  // The end-to-end §26.5 leg: a start-time reservation held by a live
  // activity must block a bystander's consume_item with item_reserved.
  it("rejects consuming an item a live activity has reserved", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConsumeIds();
    await seedConsumeCase(ids);
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
    const started = await submitDurableStartActivity({
      id: newId(),
      branchId: ids.branchId,
      expectedVersion: 0,
      idempotencyKey: newId(),
      principal: { kind: "npc_policy", principalId: newId(), controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-19T12:00:00.000Z",
      correlationId: newId(),
      type: "start_activity",
      schemaVersion: 1,
      payload: { actionDefinitionId: "cook-with-food", actorId: ids.actorId },
    });
    expect(started).toMatchObject({ status: "accepted" });

    const result = await submitDurableConsumeItem(consumeCommand(ids, { itemId: ids.mealId, expectedVersion: 1 }));
    expect(result).toMatchObject({ status: "rejected", code: "item_reserved" });
  });
});

// ---------------------------------------------------------------------------
// E5.3 slice 3 — item condition (§26.7)
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

function makeConditionIds(): ConditionCase {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    locationId: `${worldId}-loc-condition`,
    zoneId: `${branchId}-zone-condition`,
    actorId: newId(),
    witnessId: newId(),
    garmentId: newId(),
    plainItemId: newId(),
  };
}

async function seedConditionCase(ids: ConditionCase): Promise<void> {
  seededWorldIds.push(ids.worldId);
  await seedDurableMaterialBranch({
    worldId: ids.worldId,
    worldTypeId: "e5-3-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e5-3-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.actorId, name: "Mara" },
      { id: ids.witnessId, name: "Iris" },
    ],
    items: [
      {
        id: ids.garmentId,
        name: "a linen shirt",
        ownerActorId: null,
        conditionTracked: true,
        locus: { kind: "held", actorId: ids.actorId },
      },
      {
        id: ids.plainItemId,
        name: "a plain stone",
        ownerActorId: null,
        locus: { kind: "held", actorId: ids.actorId },
      },
    ],
  });
  await seedDurableSpaceTopology({
    branchId: ids.branchId,
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "room", privacyPolicy: "private" }],
    links: [],
    loci: [
      { kind: "at", actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
      { kind: "at", actorId: ids.witnessId, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
    ],
  });
}

function donCommand(
  ids: ConditionCase,
  overrides: Partial<{ id: string; idempotencyKey: string; expectedVersion: number; itemId: string }> = {},
): TransferItemCommand {
  return transferItemCommandSchema.parse({
    id: overrides.id ?? newId(),
    branchId: ids.branchId,
    expectedVersion: overrides.expectedVersion ?? 0,
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    principal: { kind: "npc_policy", principalId: newId(), controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 2,
    correlationId: newId(),
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
  overrides: Partial<{ id: string; idempotencyKey: string; expectedVersion: number; itemId: string }> = {},
): TransferItemCommand {
  return transferItemCommandSchema.parse({
    id: overrides.id ?? newId(),
    branchId: ids.branchId,
    expectedVersion: overrides.expectedVersion ?? 1,
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    principal: { kind: "npc_policy", principalId: newId(), controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 2,
    correlationId: newId(),
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

describe("E5.3 slice 3 — item condition (§26.7)", () => {
  it("dons a tracked garment: meters lazily initialize, the worn-window modifier applies, and the grimy alarm arms at the exact solved second", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConditionIds();
    await seedConditionCase(ids);

    const result = await submitDurableTransferItem(donCommand(ids));
    expect(result).toMatchObject({ status: "accepted", branchVersion: 1, firstSequence: 1, lastSequence: 4 });
    if (result.status !== "accepted") throw new Error("expected acceptance");
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
    expect(meters.map((meter) => meter.meterKey).sort()).toEqual(["cleanliness", "wear"]);
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

  it("doffing ends the worn-window modifier and retires the alarm without a stale re-arm", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConditionIds();
    await seedConditionCase(ids);
    const donResult = await submitDurableTransferItem(donCommand(ids));
    expect(donResult).toMatchObject({ status: "accepted" });

    // Three real worn-hours pass before doffing — advancing to a second still
    // well short of the grimy alarm's due second, so nothing drains here.
    const doffSecond = SEED_SECOND + 3 * 3_600;
    const advanced = await advanceBranchStoryTime(ids.branchId, doffSecond, { workerId: "w-condition-doff" });
    expect(advanced).toMatchObject({ status: "advanced", drained: 0 });

    const doffResult = await submitDurableTransferItem(doffCommand(ids));
    expect(doffResult).toMatchObject({ status: "accepted" });
    if (doffResult.status !== "accepted") throw new Error("expected acceptance");

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

  it("drains a due grimy alarm through the scheduler and witnesses the co-located actor, excluding the wearer", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConditionIds();
    await seedConditionCase(ids);
    await submitDurableTransferItem(donCommand(ids));

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

  it("apply_item_condition_source cleans a worn garment, restoring cleanliness and re-arming from the new second", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConditionIds();
    await seedConditionCase(ids);
    await submitDurableTransferItem(donCommand(ids));

    const cleanSecond = SEED_SECOND + 14 * 3_600;
    const advanced = await advanceBranchStoryTime(ids.branchId, cleanSecond, { workerId: "w-condition-clean" });
    expect(advanced).toMatchObject({ status: "advanced", drained: 0 });

    const cleanCommand = {
      id: newId(),
      branchId: ids.branchId,
      expectedVersion: 1,
      idempotencyKey: newId(),
      principal: { kind: "npc_policy", principalId: newId(), controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-19T12:00:00.000Z",
      correlationId: newId(),
      type: "apply_item_condition_source",
      schemaVersion: 1,
      payload: {
        actorId: ids.actorId,
        itemId: ids.garmentId,
        sourceKind: "clean",
        meterKey: "cleanliness",
        operation: { kind: "set", valueFixedPoint: 10_000 },
      },
    };
    const result = await submitDurableApplyItemConditionSource(cleanCommand);
    expect(result).toMatchObject({ status: "accepted" });

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

  it("rejects apply_item_condition_source against an untracked item", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConditionIds();
    await seedConditionCase(ids);

    const result = await submitDurableApplyItemConditionSource({
      id: newId(),
      branchId: ids.branchId,
      expectedVersion: 0,
      idempotencyKey: newId(),
      principal: { kind: "npc_policy", principalId: newId(), controlledActorIds: [ids.actorId] },
      submittedAtWallClock: "2026-07-19T12:00:00.000Z",
      correlationId: newId(),
      type: "apply_item_condition_source",
      schemaVersion: 1,
      payload: {
        actorId: ids.actorId,
        itemId: ids.plainItemId,
        sourceKind: "adjustment",
        meterKey: "cleanliness",
        operation: { kind: "set", valueFixedPoint: 10_000 },
      },
    });
    expect(result).toMatchObject({ status: "rejected", code: "condition_not_tracked" });
  });

  it("an untracked item's transfers never produce condition rows or events", async (test) => {
    if (!ready) return test.skip();
    const ids = makeConditionIds();
    await seedConditionCase(ids);

    const result = await submitDurableTransferItem(
      transferItemCommandSchema.parse({
        id: newId(),
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: newId(),
        principal: { kind: "npc_policy", principalId: newId(), controlledActorIds: [ids.actorId] },
        submittedAtWallClock: "2026-07-19T12:00:00.000Z",
        type: "transfer_item",
        schemaVersion: 2,
        correlationId: newId(),
        payload: {
          actorId: ids.actorId,
          itemId: ids.plainItemId,
          fromLocus: { kind: "held", actorId: ids.actorId },
          toLocus: { kind: "worn", actorId: ids.actorId, slotKey: WORN_SLOT },
        },
      }),
    );
    expect(result).toMatchObject({ status: "accepted", branchVersion: 1, firstSequence: 1, lastSequence: 1 });
    if (result.status !== "accepted") throw new Error("expected acceptance");
    expect(result.eventIds).toHaveLength(1);

    expect(await itemConditionMeterRows(ids.branchId, ids.plainItemId)).toHaveLength(0);
    expect(await itemConditionModifierRows(ids.branchId, ids.plainItemId)).toHaveLength(0);

    const events = await db().select({ type: simEvents.type }).from(simEvents).where(eq(simEvents.branchId, ids.branchId));
    expect(events.map((event) => event.type)).toEqual(["item_transferred"]);
  });
});
