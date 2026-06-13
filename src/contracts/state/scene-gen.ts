import { z } from "zod";

/**
 * Scene-image generation settings/progress. There is no configurable subject:
 * the composer picks the focal character from the NPCs co-located with the
 * player, and the image is always the player's first-person POV
 * (docs/images.md §Scene images). A legacy `subject` key on old rows is
 * stripped by parsing.
 */
export const sceneGenStateSchema = z.object({
  interval: z.number().int().min(0).default(0),
  lastGeneratedTurn: z.number().int().min(0).optional(),
  status: z.enum(["idle", "generating", "failed"]).default("idle"),
});

export type SceneGenState = z.infer<typeof sceneGenStateSchema>;

export function emptySceneGenState(): SceneGenState {
  return sceneGenStateSchema.parse({});
}
