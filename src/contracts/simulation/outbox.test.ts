import { describe, expect, it } from "vitest";
import {
  projectItemTransferredFeedRow,
  outboxRetryDelaySeconds,
  simulationOutboxStateSchema,
} from "./outbox";

const event = {
  id: "event_transfer_1",
  worldId: "world_1",
  branchId: "branch_1",
  sequence: 7,
  storySecond: 57_600,
  type: "item_transferred" as const,
  schemaVersion: 1 as const,
  rulesetVersion: "ruleset-v1",
  derivationVersion: "gate1-perception-v1",
  commandId: "command_1",
  correlationId: "correlation_1",
  actorIds: ["actor_1"],
  entityIds: ["actor_1", "container_a", "container_b", "item_1"],
  recordedAtWallClock: "2026-07-16T16:00:00.000Z",
  payload: {
    actorId: "actor_1",
    itemId: "item_1",
    fromContainerId: "container_a",
    toContainerId: "container_b",
    observerActorIds: ["actor_1"],
  },
};

describe("E2.3 outbox contracts", () => {
  it("projects the same immutable event into a stable non-authoritative feed row", () => {
    expect(projectItemTransferredFeedRow(event)).toEqual({
      consumerKind: "item_transfer_feed",
      projectionSchemaVersion: 1,
      worldId: "world_1",
      branchId: "branch_1",
      sourceEventId: "event_transfer_1",
      sourceSequence: 7,
      storySecond: 57_600,
      actorId: "actor_1",
      itemId: "item_1",
      fromContainerId: "container_a",
      toContainerId: "container_b",
    });
    expect(projectItemTransferredFeedRow(event)).toEqual(projectItemTransferredFeedRow(event));
  });

  it("rejects unsupported events instead of guessing a projection", () => {
    expect(() => projectItemTransferredFeedRow({ ...event, type: "item_destroyed" })).toThrow();
  });

  it("uses deterministic bounded retry delays", () => {
    expect([1, 2, 3, 9, 10].map(outboxRetryDelaySeconds)).toEqual([1, 2, 4, 256, 256]);
    expect(() => outboxRetryDelaySeconds(0)).toThrow(RangeError);
  });

  it("admits the terminal quarantine state used by the durable consumer", () => {
    expect(simulationOutboxStateSchema.parse("failed")).toBe("failed");
  });
});
