import { describe, expect, it } from "vitest";
import {
  itemTransferProjectionSchema,
  itemTransferredEventSchema,
  transferItemCommandSchema,
  type ItemTransferProjection,
  type ItemTransferredEvent,
  type TransferItemCommand,
  type TransferItemCommandInput,
} from "@/contracts/simulation/item-transfer";
import {
  buildTriggerScheduledEvent,
  deriveTriggerCommandId,
  deriveTriggerId,
  scheduleTransferTriggerCommandSchema,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";
import { createItemTransferBranchRuntime, simulationHash } from "./item-transfer";
import {
  composeAncestryEventBounds,
  itemHoldingsAtSequence,
  replayBranchHistory,
} from "./replay";

const WORLD = "world_e2_5";
const BRANCH = "branch_e2_5";
const PARENT_BRANCH = "branch_e2_5_parent";
const RULESET = "e2-5-test-v1";

function seedProjection(): ItemTransferProjection {
  return itemTransferProjectionSchema.parse({
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    version: 0,
    headSequence: 0,
    storySecond: 57_600,
    actors: [
      { id: "actor_mara", name: "Mara", observedContainerIds: ["bag_mara", "table_cafe"] },
    ],
    containers: [
      {
        id: "bag_mara",
        kind: "container",
        name: "Mara's bag",
        capacity: 4,
        accessibleToActorIds: ["actor_mara"],
      },
      {
        id: "table_cafe",
        kind: "location",
        name: "the cafe table",
        capacity: 6,
        accessibleToActorIds: ["actor_mara"],
      },
    ],
    items: [
      { id: "item_coin", name: "silver coin", holdingContainerId: "bag_mara" },
      { id: "item_ring", name: "gold ring", holdingContainerId: "bag_mara" },
    ],
    observations: [],
  });
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
    schemaVersion: 1,
    correlationId: "correlation_e2_5",
    payload: {
      actorId: "actor_mara",
      itemId: "item_ring",
      fromContainerId: "bag_mara",
      toContainerId: "table_cafe",
    },
    ...overrides,
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
    correlationId: "correlation_e2_5",
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
  return itemTransferredEventSchema.parse({
    id: `event_fired_${input.uniquenessKey}`,
    worldId: WORLD,
    branchId: input.firingBranchId,
    sequence: input.sequence,
    storySecond: 61_200,
    type: "item_transferred",
    schemaVersion: 1,
    rulesetVersion: RULESET,
    derivationVersion: "gate1-perception-v1",
    commandId,
    correlationId: "correlation_e2_5",
    actorIds: ["actor_mara"],
    entityIds: ["actor_mara", "bag_mara", "item_ring", "table_cafe"],
    recordedAtWallClock: "2026-07-17T17:00:00.000Z",
    payload: {
      actorId: "actor_mara",
      itemId: "item_ring",
      fromContainerId: "bag_mara",
      toContainerId: "table_cafe",
      observerActorIds: ["actor_mara"],
    },
  });
}

describe("E2.5 fork ancestry math", () => {
  it("bounds each ancestor by the tightest fork crossed so far", () => {
    const ranges = composeAncestryEventBounds([
      { branchId: "child", forkSequence: 5 },
      { branchId: "parent", forkSequence: 10 },
      { branchId: "root", forkSequence: null },
    ]);
    expect(ranges).toEqual([
      { branchId: "child", maxSequence: Number.MAX_SAFE_INTEGER },
      // The child forked below the parent's own first event, so the parent's
      // range collapses and it contributes nothing.
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

describe("E2.5 holdings reverse-derivation", () => {
  it("returns each touched item to where its earliest later transfer found it", () => {
    const events = [
      firedTransferEvent({ sequence: 3, firingBranchId: BRANCH, uniquenessKey: "alarm" }),
    ];
    const current = new Map([
      ["item_ring", "table_cafe"],
      ["item_coin", "bag_mara"],
    ]);
    const atSeed = itemHoldingsAtSequence(current, events, 0);
    expect(atSeed.get("item_ring")).toBe("bag_mara");
    // Untouched placements pass through as seed data (plan R3).
    expect(atSeed.get("item_coin")).toBe("bag_mara");

    const atBoundary = itemHoldingsAtSequence(current, events, 3);
    expect(atBoundary.get("item_ring")).toBe("table_cafe");
  });
});

describe("E2.5 deterministic branch replay", () => {
  it("reproduces the live projection hash from the same event range", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());
    expect(runtime.submit(transferCommand())).toMatchObject({ status: "accepted" });
    expect(
      runtime.submit(
        transferCommand({
          id: "command_transfer_coin",
          idempotencyKey: "idem_transfer_coin",
          expectedVersion: 1,
          payload: {
            actorId: "actor_mara",
            itemId: "item_coin",
            fromContainerId: "bag_mara",
            toContainerId: "table_cafe",
          },
        }),
      ),
    ).toMatchObject({ status: "accepted" });

    const replay = replayBranchHistory({
      seed: seedProjection(),
      events: runtime.getEvents(),
      chainBranchIds: [BRANCH],
    });
    expect(simulationHash(replay.projection)).toBe(runtime.projectionHash());
    expect(replay.projection.version).toBe(2);
    expect(replay.projection.headSequence).toBe(2);
    expect(replay.replayedEventCount).toBe(2);
  });

  it("re-arms unfired triggers and recognizes ancestor-fired ones instead of re-arming", () => {
    // Setting events at sequences 1 and 3; the alarm set first already fired
    // (sequence 2) under a trigger identity derived on the parent branch.
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
    expect(replay.projection.items.find((item) => item.id === "item_ring")?.holdingContainerId).toBe(
      "table_cafe",
    );
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
