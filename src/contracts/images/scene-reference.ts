import { z } from "zod";

/**
 * What a generated scene image features / could be anchored on — a character in
 * frame or the location. Stored as a list on `images.meta.references` (JSONB, no
 * migration) so a scene can record **multiple** characters and locations, even
 * though today's single-reference image model only consumes one character avatar.
 * The Gallery (docs/images.md) filters scenes on this list; future multi-reference
 * generation can consume more of it. `id` is the library entity id (character or
 * location); `name` is captured at creation as a display fallback.
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

/** Degraded-safe list: a malformed value parses to `[]` (old images carry none). */
export const sceneReferenceListSchema = z.array(sceneReferenceSchema).catch([]);
