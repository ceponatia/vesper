import { z } from "zod";
import { stageById } from "./stages";

/**
 * Authored relationships (docs/authoring.md §Cast relationships): a world cast
 * entry may declare directed edges toward another cast member (by display
 * name) or the player (the literal "player"). Stored on
 * `world_cast.relationships` (jsonb, default `[]`); spawn seeds
 * `participant_relationships` rows at `stageMidpoint(stage)` — see
 * `server/engine/relationship-seeds.ts`.
 */
export const authoredRelationshipSchema = z.object({
  /** Cast display name or the literal "player"; resolved case-insensitively at spawn. */
  toward: z.string().trim().min(1),
  /** Stage id from the registry; unknown ids self-heal to "stranger" (= no seeded row). */
  stage: z
    .string()
    .refine((id) => stageById(id) !== undefined, { message: "unknown relationship stage" })
    .catch("stranger"),
});

export type AuthoredRelationship = z.infer<typeof authoredRelationshipSchema>;

/** The `world_cast.relationships` column shape; read it through `parseOr(…, [], sink, "world_cast.relationships")`. */
export const authoredRelationshipListSchema = z.array(authoredRelationshipSchema);
