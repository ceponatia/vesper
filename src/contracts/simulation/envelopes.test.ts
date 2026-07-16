import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  acceptedSimulationCommandResultSchema,
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  principalKinds,
} from "./envelopes";
import {
  branchSequenceSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldIdSchema,
  type WorldBranchId,
  type WorldId,
} from "./identity";

const testCommandSchema = createCommandEnvelopeSchema(
  "test_command",
  1,
  z.object({ targetId: z.string().min(1) }).strict(),
);

const testEventSchema = createEventEnvelopeSchema(
  "test_event",
  1,
  z.object({ result: z.literal("ok") }).strict(),
);

function commandInput() {
  return {
    id: "command_a",
    branchId: "branch_a",
    expectedVersion: 0,
    idempotencyKey: "idempotency_a",
    principal: {
      kind: "system" as const,
      principalId: "principal_system",
      controlledActorIds: ["actor_a", "actor_b"],
    },
    submittedAtWallClock: "2026-07-16T16:00:00.000Z",
    type: "test_command" as const,
    schemaVersion: 1 as const,
    correlationId: "correlation_a",
    payload: { targetId: "target_a" },
  };
}

function eventInput() {
  return {
    id: "event_a",
    worldId: "world_a",
    branchId: "branch_a",
    sequence: 1,
    storySecond: 57_600,
    type: "test_event" as const,
    schemaVersion: 1 as const,
    rulesetVersion: "ruleset-v1",
    commandId: "command_a",
    correlationId: "correlation_a",
    actorIds: ["actor_a", "actor_b"],
    entityIds: ["actor_a", "item_a"],
    recordedAtWallClock: "2026-07-16T16:00:00.000Z",
    payload: { result: "ok" as const },
  };
}

describe("E2.1 simulation identity", () => {
  it("keeps identity families nominally distinct while preserving opaque values", () => {
    const worldId = worldIdSchema.parse("opaque_value:01");
    const branchId = worldBranchIdSchema.parse("opaque_value:01");

    expect(worldId).toBe("opaque_value:01");
    expect(branchId).toBe("opaque_value:01");
    expectTypeOf<WorldId>().not.toEqualTypeOf<WorldBranchId>();
  });

  it("rejects identity normalization and unsafe story-time values", () => {
    expect(worldIdSchema.safeParse(" world_a").success).toBe(false);
    expect(worldIdSchema.safeParse("world a").success).toBe(false);
    expect(storySecondSchema.safeParse(-1).success).toBe(false);
    expect(storySecondSchema.safeParse(1.5).success).toBe(false);
    expect(storySecondSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(branchSequenceSchema.safeParse(0).success).toBe(false);
  });
});

describe("E2.1 command and event envelopes", () => {
  it("admits every principal family through one strict command contract", () => {
    for (const kind of principalKinds) {
      const parsed = testCommandSchema.parse({
        ...commandInput(),
        principal: { ...commandInput().principal, kind },
      });
      expect(parsed.principal.kind).toBe(kind);
    }
  });

  it("fails closed on unstable capability sets, malformed clocks, and extra fields", () => {
    expect(
      testCommandSchema.safeParse({
        ...commandInput(),
        principal: { ...commandInput().principal, controlledActorIds: ["actor_b", "actor_a"] },
      }).success,
    ).toBe(false);
    expect(
      testCommandSchema.safeParse({ ...commandInput(), submittedAtWallClock: "Thursday afternoon" }).success,
    ).toBe(false);
    expect(testCommandSchema.safeParse({ ...commandInput(), hiddenBypass: true }).success).toBe(false);
  });

  it("validates one deterministic event envelope without relying on wall-clock order", () => {
    expect(testEventSchema.parse(eventInput())).toMatchObject({
      sequence: 1,
      storySecond: 57_600,
      type: "test_event",
    });
    expect(testEventSchema.safeParse({ ...eventInput(), actorIds: ["actor_b", "actor_a"] }).success).toBe(false);
    expect(testEventSchema.safeParse({ ...eventInput(), entityIds: ["item_a", "item_a"] }).success).toBe(false);
  });

  it("enforces exhaustive result invariants shared by command families", () => {
    const rejectionCodeSchema = z.enum(["denied", "missing"]);
    const resultSchema = createCommandResultSchema(rejectionCodeSchema);
    const accepted = {
      status: "accepted" as const,
      commandId: "command_a",
      branchVersion: 1,
      firstSequence: 1,
      lastSequence: 2,
      eventIds: ["event_a", "event_b"],
    };

    expect(acceptedSimulationCommandResultSchema.parse(accepted).status).toBe("accepted");
    expect(resultSchema.safeParse({ ...accepted, firstSequence: 3 }).success).toBe(false);
    expect(resultSchema.safeParse({ ...accepted, eventIds: ["event_a", "event_a"] }).success).toBe(false);
    expect(resultSchema.safeParse({ ...accepted, eventIds: ["event_a"] }).success).toBe(false);
    expect(
      resultSchema.safeParse({
        status: "rejected",
        commandId: "command_a",
        code: "denied",
        publicReason: "That action is unavailable.",
        legalAlternativeCommandTypes: ["wait", "ask"],
      }).success,
    ).toBe(false);
  });
});
