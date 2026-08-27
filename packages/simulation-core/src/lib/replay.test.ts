import { describe, expect, it } from "vitest";
import {
  itemDestroyedEventSchema,
  itemLocusSchema,
  itemTransferredEventSchema,
  materialsProjectionSchema,
  transferItemCommandSchema,
  type ItemLocus,
  type ItemTransferredEvent,
  type MaterialsProjection,
  type TransferItemCommand,
  type TransferItemCommandInput,
} from "../contracts/materials";
import {
  buildTriggerScheduledEvent,
  deriveTriggerCommandId,
  deriveTriggerId,
  scheduleTransferTriggerCommandSchema,
  type TriggerScheduledEvent,
} from "../contracts/scheduler";
import { simulationHash, sortedUnique } from "./hash";
import { replayMaterialsHistory } from "./materials";
import {
  composeAncestryEventBounds,
  itemHoldingsAtSequence,
  replayBranchHistory,
} from "./replay";

const WORLD = "world_e5_3";
const BRANCH = "branch_e5_3";
const PARENT_BRANCH = "branch_e5_3_parent";
const RULESET = "e5-3-test-v1";

const BAG_LOCUS: ItemLocus = itemLocusSchema.parse({ kind: "container", containerItemId: "bag_mara" });
const CAFE_LOCUS: ItemLocus = itemLocusSchema.parse({ kind: "zone", zoneId: "zone_cafe" });

function seedProjection(): MaterialsProjection {
  return materialsProjectionSchema.parse({
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    version: 0,
    headSequence: 0,
    storySecond: 57_600,
    actors: [{ id: "actor_mara", name: "Mara" }],
    items: [
      {
        id: "bag_mara",
        name: "Mara's bag",
        container: { capacityCount: 4, access: { kind: "open" } },
        locus: { kind: "held", actorId: "actor_mara" },
      },
      { id: "item_coin", name: "silver coin", locus: BAG_LOCUS },
      { id: "item_ring", name: "gold ring", locus: BAG_LOCUS },
    ],
  });
}

function locusEntityIds(locus: ItemLocus): string[] {
  switch (locus.kind) {
    case "held":
    case "worn":
      return [locus.actorId];
    case "container":
      return [locus.containerItemId];
    case "zone":
      return [locus.zoneId];
    case "gone":
      return [];
  }
}

function transferCommand(overrides: Partial<TransferItemCommandInput> = {}): TransferItemCommand {
  return transferItemCommandSchema.parse({
    id: "command_transfer_ring",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem_transfer_ring",
    principal: {
      kind: "npc_policy",
      principalId: "policy_mara",
      controlledActorIds: ["actor_mara"],
    },
    submittedAtWallClock: "2026-07-17T16:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 2,
    correlationId: "correlation_e5_3",
    payload: {
      actorId: "actor_mara",
      itemId: "item_ring",
      fromLocus: BAG_LOCUS,
      toLocus: CAFE_LOCUS,
    },
    ...overrides,
  });
}

function transferredEvent(input: {
  sequence: number;
  commandId: string;
  branchId?: string;
  itemId: string;
  fromLocus: ItemLocus;
  toLocus: ItemLocus;
}): ItemTransferredEvent {
  const branchId = input.branchId ?? BRANCH;
  return itemTransferredEventSchema.parse({
    id: `event_${input.commandId}`,
    worldId: WORLD,
    branchId,
    sequence: input.sequence,
    storySecond: 61_200,
    type: "item_transferred",
    schemaVersion: 2,
    rulesetVersion: RULESET,
    commandId: input.commandId,
    correlationId: "correlation_e5_3",
    actorIds: ["actor_mara"],
    entityIds: sortedUnique([
      "actor_mara",
      input.itemId,
      ...locusEntityIds(input.fromLocus),
      ...locusEntityIds(input.toLocus),
    ]),
    recordedAtWallClock: "2026-07-17T17:00:00.000Z",
    payload: {
      actorId: "actor_mara",
      itemId: input.itemId,
      fromLocus: input.fromLocus,
      toLocus: input.toLocus,
      againstOwnership: false,
    },
  });
}

function scheduleEvent(input: {
  sequence: number;
  uniquenessKey: string;
  dueStorySecond: number;
}): TriggerScheduledEvent {
  const command = scheduleTransferTriggerCommandSchema.parse({
    id: `command_schedule_${input.uniquenessKey}`,
    branchId: BRANCH,
    expectedVersion: input.sequence - 1,
    idempotencyKey: `idem_schedule_${input.uniquenessKey}`,
    principal: { kind: "system", principalId: "scheduler", controlledActorIds: ["actor_mara"] },
    submittedAtWallClock: "2026-07-17T16:00:00.000Z",
    type: "schedule_transfer_item",
    schemaVersion: 1,
    correlationId: "correlation_e5_3",
    payload: {
      kind: "scheduled_transfer_item",
      triggerSchemaVersion: 1,
      dueStorySecond: input.dueStorySecond,
      priority: 0,
      uniquenessKey: input.uniquenessKey,
      command: transferCommand({ id: `command_template_${input.uniquenessKey}` }),
    },
  });
  return buildTriggerScheduledEvent(
    {
      worldId: WORLD,
      branchId: BRANCH,
      headSequence: input.sequence - 1,
      storySecond: 57_600,
      rulesetVersion: RULESET,
    },
    command,
  );
}

function firedTransferEvent(input: {
  sequence: number;
  firingBranchId: string;
  uniquenessKey: string;
}): ItemTransferredEvent {
  const commandId = deriveTriggerCommandId(deriveTriggerId(input.firingBranchId, input.uniquenessKey));
  return transferredEvent({
    sequence: input.sequence,
    commandId,
    branchId: input.firingBranchId,
    itemId: "item_ring",
    fromLocus: BAG_LOCUS,
    toLocus: CAFE_LOCUS,
  });
}

describe("E5.3 fork ancestry math", () => {
  it("bounds each ancestor by the tightest fork crossed so far", () => {
    const ranges = composeAncestryEventBounds([
      { branchId: "child", forkSequence: 5 },
      { branchId: "parent", forkSequence: 10 },
      { branchId: "root", forkSequence: null },
    ]);
    expect(ranges).toEqual([
      { branchId: "child", maxSequence: Number.MAX_SAFE_INTEGER },
      { branchId: "parent", maxSequence: 5 },
      { branchId: "root", maxSequence: 5 },
    ]);
  });

  it("keeps a deeper fork's bound while ancestors forked later", () => {
    const ranges = composeAncestryEventBounds([
      { branchId: "child", forkSequence: 12 },
      { branchId: "parent", forkSequence: 4 },
      { branchId: "root", forkSequence: null },
    ]);
    expect(ranges).toEqual([
      { branchId: "child", maxSequence: Number.MAX_SAFE_INTEGER },
      { branchId: "parent", maxSequence: 12 },
      { branchId: "root", maxSequence: 4 },
    ]);
  });

  it("accepts a root-only chain and rejects malformed chains", () => {
    expect(composeAncestryEventBounds([{ branchId: "root", forkSequence: null }])).toEqual([
      { branchId: "root", maxSequence: Number.MAX_SAFE_INTEGER },
    ]);
    expect(() => composeAncestryEventBounds([])).toThrow(/empty/u);
    expect(() =>
      composeAncestryEventBounds([
        { branchId: "root", forkSequence: null },
        { branchId: "child", forkSequence: 3 },
      ]),
    ).toThrow(/root before its end/u);
    expect(() =>
      composeAncestryEventBounds([
        { branchId: "child", forkSequence: 3 },
        { branchId: "parent", forkSequence: 4 },
      ]),
    ).toThrow(/does not end at a root/u);
  });
});

describe("E5.3 locus reverse-derivation", () => {
  it("returns each touched item to the locus its earliest later move captured", () => {
    const events = [
      firedTransferEvent({ sequence: 3, firingBranchId: BRANCH, uniquenessKey: "alarm" }),
    ];
    const current = new Map<string, ItemLocus>([
      ["item_ring", CAFE_LOCUS],
      ["item_coin", BAG_LOCUS],
    ]);
    const atSeed = itemHoldingsAtSequence(current, events, 0);
    expect(atSeed.get("item_ring")).toEqual(BAG_LOCUS);
    // Untouched placements pass through as seed data (R3).
    expect(atSeed.get("item_coin")).toEqual(BAG_LOCUS);

    const atBoundary = itemHoldingsAtSequence(current, events, 3);
    expect(atBoundary.get("item_ring")).toEqual(CAFE_LOCUS);
  });

  it("undoes a destruction via its captured pre-gone locus", () => {
    const events = [
      itemDestroyedEventSchema.parse({
        id: "event_destroy_ring",
        worldId: WORLD,
        branchId: BRANCH,
        sequence: 2,
        storySecond: 61_200,
        type: "item_destroyed",
        schemaVersion: 1,
        rulesetVersion: RULESET,
        commandId: "command_destroy_ring",
        correlationId: "correlation_e5_3",
        actorIds: ["actor_mara"],
        entityIds: ["actor_mara", "bag_mara", "item_ring"],
        recordedAtWallClock: "2026-07-17T17:00:00.000Z",
        payload: {
          actorId: "actor_mara",
          itemId: "item_ring",
          basis: "destroyed",
          fromLocus: BAG_LOCUS,
          againstOwnership: false,
        },
      }),
    ];
    const current = new Map<string, ItemLocus>([["item_ring", { kind: "gone", basis: "destroyed" }]]);
    expect(itemHoldingsAtSequence(current, events, 0).get("item_ring")).toEqual(BAG_LOCUS);
  });
});

describe("E5.3 deterministic branch replay", () => {
  it("reproduces the materials projection from the same event range", () => {
    const events = [
      transferredEvent({
        sequence: 1,
        commandId: "command_transfer_ring",
        itemId: "item_ring",
        fromLocus: BAG_LOCUS,
        toLocus: CAFE_LOCUS,
      }),
      transferredEvent({
        sequence: 2,
        commandId: "command_transfer_coin",
        itemId: "item_coin",
        fromLocus: BAG_LOCUS,
        toLocus: CAFE_LOCUS,
      }),
    ];

    const replay = replayBranchHistory({
      seed: seedProjection(),
      events,
      chainBranchIds: [BRANCH],
    });
    // Two independent fold entry points must agree byte-for-byte (R1).
    expect(simulationHash(replay.projection)).toBe(
      simulationHash(replayMaterialsHistory({ seed: seedProjection(), events })),
    );
    expect(replay.projection.version).toBe(2);
    expect(replay.projection.headSequence).toBe(2);
    expect(replay.replayedEventCount).toBe(2);
    expect(replay.projection.items.find((item) => item.id === "item_ring")?.locus).toEqual(CAFE_LOCUS);
    expect(replay.projection.items.find((item) => item.id === "item_coin")?.locus).toEqual(CAFE_LOCUS);
  });

  it("re-arms unfired triggers and recognizes ancestor-fired ones instead of re-arming", () => {
    const events = [
      scheduleEvent({ sequence: 1, uniquenessKey: "alarm_fired", dueStorySecond: 61_200 }),
      firedTransferEvent({ sequence: 2, firingBranchId: PARENT_BRANCH, uniquenessKey: "alarm_fired" }),
      scheduleEvent({ sequence: 3, uniquenessKey: "alarm_pending", dueStorySecond: 72_000 }),
    ];
    const replay = replayBranchHistory({
      seed: seedProjection(),
      events,
      chainBranchIds: [BRANCH, PARENT_BRANCH],
    });

    expect(replay.triggers).toHaveLength(2);
    const [fired, pending] = replay.triggers;
    expect(fired).toMatchObject({
      uniquenessKey: "alarm_fired",
      stableOrder: 1,
      firedByCommandId: deriveTriggerCommandId(deriveTriggerId(PARENT_BRANCH, "alarm_fired")),
    });
    expect(pending).toMatchObject({
      uniquenessKey: "alarm_pending",
      stableOrder: 2,
      firedByCommandId: null,
    });
    // The fired alarm's transfer is part of replayed truth.
    expect(replay.projection.items.find((item) => item.id === "item_ring")?.locus).toEqual(CAFE_LOCUS);
    // Version counts commands: two schedules plus one fired dispatch.
    expect(replay.projection.version).toBe(3);
  });

  it("refuses a sequence gap and an event from outside the ancestry chain", () => {
    const gap = [scheduleEvent({ sequence: 2, uniquenessKey: "gap", dueStorySecond: 61_200 })];
    expect(() =>
      replayBranchHistory({ seed: seedProjection(), events: gap, chainBranchIds: [BRANCH] }),
    ).toThrow(/sequence gap/u);

    const foreign = [
      firedTransferEvent({ sequence: 1, firingBranchId: "branch_sibling", uniquenessKey: "leak" }),
    ];
    expect(() =>
      replayBranchHistory({ seed: seedProjection(), events: foreign, chainBranchIds: [BRANCH] }),
    ).toThrow(/outside the ancestry chain/u);
  });
});
