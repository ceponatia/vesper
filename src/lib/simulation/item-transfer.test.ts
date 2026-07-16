import { describe, expect, it } from "vitest";
import type {
  ItemTransferProjection,
  TransferItemCommand,
} from "@/contracts/simulation/item-transfer";
import {
  appendItemTransferNarrativeCut,
  createItemTransferBranchRuntime,
  simulationHash,
} from "./item-transfer";

function seedProjection(): ItemTransferProjection {
  return {
    worldId: "world_gate1",
    branchId: "branch_gate1",
    rulesetVersion: "gate1-v1",
    version: 0,
    headSequence: 0,
    storySecond: 57_600,
    actors: [
      { id: "actor_mara", name: "Mara", observedContainerIds: ["bag_mara", "table_cafe"] },
      { id: "actor_theo", name: "Theo", observedContainerIds: ["bag_mara", "table_cafe"] },
      { id: "actor_june", name: "June", observedContainerIds: ["counter_back"] },
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
      {
        id: "counter_back",
        kind: "location",
        name: "the back counter",
        capacity: 2,
        accessibleToActorIds: ["actor_june"],
      },
    ],
    items: [{ id: "item_ring", name: "gold ring", holdingContainerId: "bag_mara" }],
    observations: [],
  };
}

function transferCommand(overrides: Partial<TransferItemCommand> = {}): TransferItemCommand {
  return {
    id: "command_transfer_ring",
    branchId: "branch_gate1",
    expectedVersion: 0,
    idempotencyKey: "idem_transfer_ring",
    principal: {
      kind: "npc_policy",
      principalId: "policy_mara",
      controlledActorIds: ["actor_mara"],
    },
    submittedAtWallClock: "2026-07-16T16:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 1,
    correlationId: "correlation_gate1",
    payload: {
      actorId: "actor_mara",
      itemId: "item_ring",
      fromContainerId: "bag_mara",
      toContainerId: "table_cafe",
    },
    ...overrides,
  };
}

describe("Gate 1 item-transfer authority seam", () => {
  it("commits one authorized command as one event and one holding change", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());

    expect(runtime.submit(transferCommand())).toMatchObject({
      status: "accepted",
      branchVersion: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
    expect(runtime.getEvents()).toHaveLength(1);
    expect(runtime.getProjection().items).toEqual([
      { id: "item_ring", name: "gold ring", holdingContainerId: "table_cafe" },
    ]);
    expect(runtime.getProjection().version).toBe(1);
  });

  it("rejects missing controller authority without changing any causal state", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());
    const before = {
      projection: runtime.projectionHash(),
      events: runtime.eventHash(),
      memory: runtime.memoryHash(),
    };
    const command = transferCommand({
      principal: { kind: "player", principalId: "player_theo", controlledActorIds: ["actor_theo"] },
    });

    expect(runtime.submit(command)).toMatchObject({ status: "rejected", code: "unauthorized_actor" });
    expect(runtime.getEvents()).toHaveLength(0);
    expect({
      projection: runtime.projectionHash(),
      events: runtime.eventHash(),
      memory: runtime.memoryHash(),
    }).toEqual(before);
  });

  it("returns a conflict for a stale optimistic version without mutation", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());

    expect(runtime.submit(transferCommand({ expectedVersion: 4 }))).toEqual({
      status: "conflict",
      commandId: "command_transfer_ring",
      currentVersion: 0,
      retryable: true,
    });
    expect(runtime.getEvents()).toHaveLength(0);
    expect(runtime.getProjection().version).toBe(0);
  });

  it("returns the original result for an idempotent retry and emits one outcome", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());
    const first = runtime.submit(transferCommand());
    const retry = runtime.submit(transferCommand());

    expect(retry).toEqual(first);
    expect(runtime.getEvents()).toHaveLength(1);
    expect(runtime.getProjection().observations).toHaveLength(2);
  });

  it("rebuilds the identical projection from immutable history", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());
    runtime.submit(transferCommand());

    const rebuilt = runtime.rebuildProjection();
    expect(simulationHash(rebuilt)).toBe(runtime.projectionHash());
    expect(rebuilt.items).toHaveLength(1);
    expect(rebuilt.items[0]?.holdingContainerId).toBe("table_cafe");
  });

  it("compiles different cuts for an observer and a non-observer without leaking denial detail", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());
    runtime.submit(transferCommand());

    const observerCut = runtime.compileNarrativeCut("actor_theo");
    const hiddenCut = runtime.compileNarrativeCut("actor_june");
    expect(observerCut.mustEnact).toHaveLength(1);
    expect(observerCut.provenance).toHaveLength(1);
    expect(hiddenCut.mustEnact).toEqual([]);
    expect(hiddenCut.perceptibleNow).toEqual([]);
    expect(hiddenCut.provenance).toEqual([]);
    const hiddenSerialized = JSON.stringify(hiddenCut);
    expect(hiddenSerialized).not.toContain("gold ring");
    expect(hiddenSerialized).not.toContain("Mara's bag");
    expect(hiddenSerialized).not.toContain("cafe table");
    expect(hiddenSerialized).not.toContain("actor_mara");
  });

  it("keeps cut identity stable and constrains the narrator to one hard outcome", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());
    runtime.submit(transferCommand());
    const first = runtime.compileNarrativeCut("actor_theo");
    const second = runtime.compileNarrativeCut("actor_theo");
    const prompt = appendItemTransferNarrativeCut("You are the current narrator.", first);

    expect(second).toEqual(first);
    expect(prompt.match(/gold ring/g)).toHaveLength(1);
    expect(prompt).toContain("Allowed additional hard transitions: none.");
    expect(prompt).toContain("cannot create, undo, repeat, or hide a hard outcome");
  });

  it("rerenders the same cut without changing events, projection, or memory", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());
    runtime.submit(transferCommand());
    const cut = runtime.compileNarrativeCut("actor_theo");
    const before = [runtime.eventHash(), runtime.projectionHash(), runtime.memoryHash()];

    const concise = appendItemTransferNarrativeCut("Narrator", cut, "concise");
    const sensory = appendItemTransferNarrativeCut("Narrator", cut, "sensory");

    expect(concise).not.toEqual(sensory);
    expect(concise).toContain(cut.id);
    expect(sensory).toContain(cut.id);
    expect([runtime.eventHash(), runtime.projectionHash(), runtime.memoryHash()]).toEqual(before);
  });

  it("fails malformed input closed", () => {
    const runtime = createItemTransferBranchRuntime(seedProjection());
    const before = runtime.projectionHash();

    expect(runtime.submit({ type: "transfer_item", payload: { itemId: "item_ring" } })).toMatchObject({
      status: "rejected",
      code: "invalid_command",
    });
    expect(runtime.projectionHash()).toBe(before);
  });
});
