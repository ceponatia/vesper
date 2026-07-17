import { describe, expect, it } from "vitest";
import {
  deriveTriggerId,
  deterministicDrawUnit,
  schedulerRetryCapSeconds,
  schedulerRetryDelaySeconds,
  simulationTriggerSchema,
} from "./scheduler";

const command = {
  id: "command_template",
  branchId: "branch_1",
  expectedVersion: 0,
  type: "transfer_item" as const,
  schemaVersion: 1 as const,
  principal: {
    kind: "system" as const,
    principalId: "principal_scheduler",
    controlledActorIds: ["actor_1"],
  },
  idempotencyKey: "template_key",
  correlationId: "correlation_1",
  submittedAtWallClock: "2026-07-17T12:00:00.000Z",
  payload: {
    actorId: "actor_1",
    itemId: "item_1",
    fromContainerId: "container_a",
    toContainerId: "container_b",
  },
};

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    id: deriveTriggerId("branch_1", "transfer-1"),
    worldId: "world_1",
    branchId: "branch_1",
    kind: "scheduled_transfer_item",
    schemaVersion: 1,
    dueStorySecond: 60,
    stableOrder: 1,
    uniquenessKey: "transfer-1",
    payload: { command },
    ...overrides,
  };
}

describe("E2.4 scheduler contracts", () => {
  it("derives delimiter-safe trigger identity", () => {
    expect(deriveTriggerId("a:b", "c")).not.toBe(deriveTriggerId("a", "b:c"));
    expect(deriveTriggerId("branch_1", "daily-transfer")).toBe(
      deriveTriggerId("branch_1", "daily-transfer"),
    );
  });

  it("keeps named random streams deterministic and isolated", () => {
    const base = { worldSeed: "seed", branchId: "branch_1", drawIndex: 0 };
    const first = deterministicDrawUnit({ ...base, stream: "lateness" });
    expect(first).toBe(deterministicDrawUnit({ ...base, stream: "lateness" }));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(first).not.toBe(deterministicDrawUnit({ ...base, stream: "weather" }));
    expect(first).not.toBe(deterministicDrawUnit({ ...base, stream: "lateness", drawIndex: 1 }));
  });

  it("uses deterministic capped scheduler backoff", () => {
    expect([1, 2, 3, 4, 11].map(schedulerRetryDelaySeconds)).toEqual([1, 2, 4, 8, 900]);
    expect(() => schedulerRetryDelaySeconds(0)).toThrow(RangeError);
  });

  it("caps backoff rather than clamping the exponent below the cap", () => {
    // Regression: a 2**min(attempt-1, 9) exponent clamp topped out at 512, so the
    // declared 900s cap could never bind.
    expect(schedulerRetryDelaySeconds(10)).toBe(512);
    expect(schedulerRetryDelaySeconds(11)).toBe(schedulerRetryCapSeconds);
    expect(schedulerRetryDelaySeconds(500)).toBe(schedulerRetryCapSeconds);
    const delays = [1, 5, 9, 10, 11, 40].map(schedulerRetryDelaySeconds);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });

  it("validates a scheduled transfer trigger", () => {
    expect(simulationTriggerSchema.parse(trigger()).kind).toBe("scheduled_transfer_item");
  });

  it("rejects a trigger whose command targets another branch", () => {
    expect(() =>
      simulationTriggerSchema.parse(
        trigger({ payload: { command: { ...command, branchId: "branch_2" } } }),
      ),
    ).toThrow(/own branch/u);
  });
});
