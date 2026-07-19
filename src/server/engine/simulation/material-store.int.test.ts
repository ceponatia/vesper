import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  destroyItemCommandSchema,
  setItemOwnershipCommandSchema,
  transferItemCommandSchema,
  type DestroyItemCommand,
  type ItemLocusInput,
  type SetItemOwnershipCommand,
  type TransferItemCommand,
} from "@/contracts/simulation/materials";
import { newId } from "@/lib/ids";
import {
  db,
  simEvents,
  simItemHoldings,
  simItems,
  simItemTransferFeed,
  simObservations,
  simWorlds,
} from "@/server/db";
import {
  seedDurableMaterialBranch,
  submitDurableDestroyItem,
  submitDurableSetItemOwnership,
  submitDurableTransferItem,
} from "./material-store";
import { consumeNextItemTransferOutbox } from "./outbox-store";
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
