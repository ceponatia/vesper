import { z } from "zod";
import { attributeValueSchema } from "../attributes/value";
import { activeConditionSchema } from "../conditions/condition";
import { initialMeters } from "../meters/registry";

export const participantStateSchema = z.object({
  attributeOverlays: z.array(attributeValueSchema).default([]),
  meters: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  conditions: z.array(activeConditionSchema).default([]),
  activity: z.string().default("idle"),
  posture: z.string().optional(),
  notes: z.array(z.string()).default([]),
});

export type ParticipantState = z.infer<typeof participantStateSchema>;

export function emptyParticipantState(): ParticipantState {
  return participantStateSchema.parse({ meters: initialMeters() });
}
