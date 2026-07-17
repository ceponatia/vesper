import { createHash } from "node:crypto";
import { z } from "zod";
import {
  branchSequenceSchema,
  composeSimulationId,
  storySecondSchema,
  triggerIdSchema,
  worldBranchIdSchema,
  worldIdSchema,
} from "./identity";
import { transferItemCommandSchema } from "./item-transfer";

export const simulationTriggerStateSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const scheduledTransferTriggerKind = "scheduled_transfer_item" as const;
export const scheduledTransferTriggerSchemaVersion = 1 as const;
export const schedulerDerivationVersion = "scheduler-v1" as const;

export const scheduledTransferTriggerPayloadSchema = z
  .object({ command: transferItemCommandSchema })
  .strict();

// Database coordination columns are intentionally stripped when a durable row is
// projected back into the immutable domain trigger contract.
export const simulationTriggerSchema = z
  .object({
    id: triggerIdSchema,
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    kind: z.literal(scheduledTransferTriggerKind),
    schemaVersion: z.literal(scheduledTransferTriggerSchemaVersion),
    dueStorySecond: storySecondSchema,
    /** Spec §12.1: lower is more urgent. Ties fall through to stableOrder. */
    priority: z.number().int().min(0).max(9_999).default(0),
    stableOrder: branchSequenceSchema,
    uniquenessKey: z.string().min(1).max(512),
    payload: scheduledTransferTriggerPayloadSchema,
  })
  // A trigger on one branch must never carry a command aimed at another. The
  // command envelope has no worldId, so branch equality is the whole check;
  // world equality follows from the trigger's branch/world foreign key.
  .refine((trigger) => trigger.payload.command.branchId === trigger.branchId, {
    message: "Trigger payload command must target the trigger's own branch",
    path: ["payload", "command", "branchId"],
  });

export type SimulationTrigger = z.infer<typeof simulationTriggerSchema>;

export function deriveTriggerId(branchId: string, uniquenessKey: string): string {
  return triggerIdSchema.parse(composeSimulationId("trigger", [branchId, uniquenessKey]));
}

/**
 * A named stream produces stable draws without sharing mutable RNG state.
 * Adding a draw in one stream therefore cannot perturb any other stream.
 */
export function deterministicDrawUnit(input: {
  worldSeed: string;
  branchId: string;
  stream: string;
  drawIndex: number;
}): number {
  if (!Number.isSafeInteger(input.drawIndex) || input.drawIndex < 0) {
    throw new RangeError("drawIndex must be a nonnegative safe integer");
  }
  const material = composeSimulationId("draw", [
    input.worldSeed,
    input.branchId,
    input.stream,
    String(input.drawIndex),
  ]);
  const bytes = createHash("sha256").update(material).digest();
  const high = bytes.readUInt32BE(0);
  const low = bytes.readUInt32BE(4);
  const integer53 = high * 2 ** 21 + (low >>> 11);
  return integer53 / 2 ** 53;
}

export const schedulerRetryCapSeconds = 900 as const;

/**
 * Exponential backoff capped at {@link schedulerRetryCapSeconds}. The exponent is
 * clamped only to stay inside safe-integer range — it must stay above the cap so
 * the cap is what actually binds.
 */
export function schedulerRetryDelaySeconds(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Scheduler attempt must be a positive safe integer");
  }
  return Math.min(schedulerRetryCapSeconds, 2 ** Math.min(attempt - 1, 20));
}
