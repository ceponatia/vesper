import { z } from "zod";

/**
 * The scene's reference mode (scene-images.plan.md §"multi-reference toggle").
 * `single` anchors the render on ONE identity avatar (a single-reference edit) — the
 * default. `multi` feeds up to three references (the present characters' avatars
 * + the location image) to a multi-reference edit so a two-character scene
 * can identity-lock both people at once. Multi falls back to single-edit when
 * fewer than two reference images are available, so the toggle never blocks a
 * render. Extensible (forward-compatible schema preference) — a future provider
 * with >3 refs (self-hosted ComfyUI, spec §7) slots in as a new mode.
 */
export const sceneReferenceModes = ["single", "multi"] as const;
export const sceneReferenceModeSchema = z.enum(sceneReferenceModes);
export type SceneReferenceMode = z.infer<typeof sceneReferenceModeSchema>;

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
  /** Single identity anchor vs multi-reference edit. */
  referenceMode: sceneReferenceModeSchema.default("single"),
});

export type SceneGenState = z.infer<typeof sceneGenStateSchema>;

export function emptySceneGenState(): SceneGenState {
  return sceneGenStateSchema.parse({});
}
