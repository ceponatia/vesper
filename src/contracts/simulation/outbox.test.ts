import { describe, expect, it } from "vitest";
import {
  projectMaterialFeedRow,
  outboxRetryDelaySeconds,
  simulationOutboxStateSchema,
} from "./outbox";

const transferEvent = {
  id: "event_transfer_1",
  worldId: "world_1",
  branchId: "branch_1",
  sequence: 7,
  storySecond: 57_600,
  type: "item_transferred" as const,
  schemaVersion: 2 as const,
  rulesetVersion: "ruleset-v1",
  commandId: "command_1",
  correlationId: "correlation_1",
  actorIds: ["actor_1"],
  entityIds: ["actor_1", "container_a", "item_1", "zone_z"],
  recordedAtWallClock: "2026-07-16T16:00:00.000Z",
  payload: {
    actorId: "actor_1",
    itemId: "item_1",
    fromLocus: { kind: "container" as const, containerItemId: "container_a" },
    toLocus: { kind: "zone" as const, zoneId: "zone_z" },
    againstOwnership: false,
  },
};

const destroyEvent = {
  id: "event_destroy_1",
  worldId: "world_1",
  branchId: "branch_1",
  sequence: 8,
  storySecond: 57_601,
  type: "item_destroyed" as const,
  schemaVersion: 1 as const,
  rulesetVersion: "ruleset-v1",
  commandId: "command_2",
  correlationId: "correlation_1",
  actorIds: ["actor_1"],
  entityIds: ["actor_1", "item_1"],
  recordedAtWallClock: "2026-07-16T16:00:01.000Z",
  payload: {
    actorId: "actor_1",
    itemId: "item_1",
    basis: "destroyed" as const,
    fromLocus: { kind: "held" as const, actorId: "actor_1" },
    againstOwnership: false,
  },
};

describe("E5.3 outbox contracts", () => {
  it("projects a transfer into a stable non-authoritative feed row carrying loci", () => {
    expect(projectMaterialFeedRow(transferEvent)).toEqual({
      consumerKind: "item_transfer_feed",
      projectionSchemaVersion: 2,
      worldId: "world_1",
      branchId: "branch_1",
      sourceEventId: "event_transfer_1",
      sourceSequence: 7,
      storySecond: 57_600,
      eventKind: "item_transferred",
      actorId: "actor_1",
      itemId: "item_1",
      fromLocus: { kind: "container", containerItemId: "container_a" },
      toLocus: { kind: "zone", zoneId: "zone_z" },
    });
    expect(projectMaterialFeedRow(transferEvent)).toEqual(projectMaterialFeedRow(transferEvent));
  });

  it("projects a destruction with a terminal gone destination locus", () => {
    expect(projectMaterialFeedRow(destroyEvent)).toMatchObject({
      eventKind: "item_destroyed",
      actorId: "actor_1",
      itemId: "item_1",
      fromLocus: { kind: "held", actorId: "actor_1" },
      toLocus: { kind: "gone", basis: "destroyed" },
    });
  });

  it("rejects an unsupported event instead of guessing a projection", () => {
    expect(() => projectMaterialFeedRow({ ...transferEvent, type: "item_ownership_set" })).toThrow();
  });

  it("uses deterministic bounded retry delays", () => {
    expect([1, 2, 3, 9, 10].map(outboxRetryDelaySeconds)).toEqual([1, 2, 4, 256, 256]);
    expect(() => outboxRetryDelaySeconds(0)).toThrow(RangeError);
  });

  it("admits the terminal quarantine state used by the durable consumer", () => {
    expect(simulationOutboxStateSchema.parse("failed")).toBe("failed");
  });
});
