import { z } from "zod";

/** SSE chunk payload (docs/streaming-api.md). content is a delta to append. */
export const turnChunkEventSchema = z.object({
  segmentIndex: z.number().int().min(0),
  /** Matches a session_participants.display_name, or null for narrator prose. */
  speaker: z.string().nullable(),
  content: z.string(),
});

export type TurnChunkEvent = z.infer<typeof turnChunkEventSchema>;

export const turnAuthorSchema = z.enum(["player", "director", "companion"]);
export type TurnAuthor = z.infer<typeof turnAuthorSchema>;

export const submitTurnBodySchema = z.object({
  input: z.string().min(1).max(8000),
  author: turnAuthorSchema.default("player"),
  speakerParticipantId: z.string().optional(),
});

export type SubmitTurnBody = z.infer<typeof submitTurnBodySchema>;
