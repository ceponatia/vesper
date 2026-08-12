import { z } from "zod";

/**
 * Gallery DTO — the projection of one `image_references` row that the
 * `/api/gallery` payload and the Gallery UI consume: a character or location a
 * scene featured. `id` is the library entity id; `name` is the display fallback
 * captured at render. References are persisted in the `image_references` join
 * table (the authoritative, queryable source of truth — docs/database.md), not
 * on `images.meta`; this shape is just what the Gallery reads back.
 */
export const sceneReferenceKinds = ["character", "location"] as const;
export const sceneReferenceKindSchema = z.enum(sceneReferenceKinds);
export type SceneReferenceKind = z.infer<typeof sceneReferenceKindSchema>;

export const sceneReferenceSchema = z.object({
  kind: sceneReferenceKindSchema,
  id: z.string().min(1),
  name: z.string().default(""),
});
export type SceneReference = z.infer<typeof sceneReferenceSchema>;

/** Degraded-safe list: a malformed value parses to `[]`. */
export const sceneReferenceListSchema = z.array(sceneReferenceSchema).catch([]);

/**
 * The render-input superset (spec §4): one reference the provider router may
 * feed a backend. Broader than the Gallery DTO — it carries the actual asset
 * (`imageId`) and its provenance (`source`) plus a `role` and the intimate-route
 * gate. Only `character`/`location` kinds are produced today; `style`/`pose`/
 * `layout` are reserved for multi-reference providers (reference sheets, layout
 * control) so adding one is data, not a schema change.
 *
 * `allowForIntimate` is the per-reference switch for the uncensored edit path.
 * It defaults to permissive today (preserving current behavior); the deferred
 * uploaded-avatar guard (spec §3) will flip it to `false` for uploaded
 * provenance. The vocabulary arrays are shared with the `image_references`
 * table definition (`src/server/db/schema.ts`) so the column enums can't drift.
 */
export const sceneVisualReferenceKinds = ["character", "location", "style", "pose", "layout"] as const;
export const sceneVisualReferenceKindSchema = z.enum(sceneVisualReferenceKinds);
export type SceneVisualReferenceKind = z.infer<typeof sceneVisualReferenceKindSchema>;

export const sceneReferenceSources = ["generated", "uploaded", "composite", "entity"] as const;
export const sceneReferenceSourceSchema = z.enum(sceneReferenceSources);
export type SceneReferenceSource = z.infer<typeof sceneReferenceSourceSchema>;

/**
 * The scene's reference mode (scene-images.plan.md §"multi-reference toggle").
 * `single` anchors the render on ONE identity avatar (a single-reference edit) — the
 * default. `multi` feeds up to three references (the present characters' avatars
 * + the location image) to a multi-reference edit so a two-character scene
 * can identity-lock both people at once. Multi falls back to single-edit when
 * fewer than two reference images are available, so the toggle never blocks a
 * render. Extensible (forward-compatible schema preference) — a future provider
 * with >3 refs (self-hosted ComfyUI, spec §7) slots in as a new mode.
 *
 * Lives beside the reference shapes rather than with the chat's scene-generation
 * state: the mode describes how many references a render may carry, which is an
 * image-engine fact. The per-chat state that stores a chosen mode is the app's
 * (`src/contracts/state/scene-gen.ts`).
 */
export const sceneReferenceModes = ["single", "multi"] as const;
export const sceneReferenceModeSchema = z.enum(sceneReferenceModes);
export type SceneReferenceMode = z.infer<typeof sceneReferenceModeSchema>;

export const sceneVisualReferenceSchema = z.object({
  kind: sceneVisualReferenceKindSchema,
  /** Library entity id (character/location); absent for non-entity roles. */
  entityId: z.string().optional(),
  /** The actual reference asset fed to a provider; absent when the ref is textual-only. */
  imageId: z.string().optional(),
  /** Composition role, e.g. "focal" | "other" | "anchor" | "location". */
  role: z.string().optional(),
  /** Display name captured at render (character or location). */
  name: z.string().optional(),
  source: sceneReferenceSourceSchema.optional(),
  /** May this reference be used on the uncensored/intimate edit path? */
  allowForIntimate: z.boolean(),
});
export type SceneVisualReference = z.infer<typeof sceneVisualReferenceSchema>;
