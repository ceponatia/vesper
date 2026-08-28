import { sceneReferenceModeSchema } from "@vesper/image-core";
import { z } from "zod";

/**
 * This module is also the designated browser-safety fixture for
 * `@vesper/image-core`: it is client-importable, so the production build
 * compiles the package's public graph into a client bundle here. Keep the
 * runtime import above — `scene-gen.test.ts` pins it, and it is what makes a
 * Node-only dependency entering the package fail the build instead of shipping.
 */

/**
 * Scene-image generation settings/progress. There is no configurable subject:
 * the composer picks the focal character from the NPCs co-located with the
 * player, and the image is always the player's first-person POV
 * (docs/images/pipelines/scene-images.md §Trigger and cast;
 * docs/images/pipelines/scene-framing.md §Player POV). A legacy `subject` key
 * on old rows is stripped by parsing.
 */
export const sceneGenStateSchema = z.object({
  interval: z.number().int().min(0).default(0),
  lastGeneratedTurn: z.number().int().min(0).optional(),
  status: z.enum(["idle", "generating", "failed"]).default("idle"),
  /** Single identity anchor vs multi-reference edit. */
  referenceMode: sceneReferenceModeSchema.default("single"),
});

export type SceneGenState = z.infer<typeof sceneGenStateSchema>;

export function emptySceneGenState(): SceneGenState {
  return sceneGenStateSchema.parse({});
}
