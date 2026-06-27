import { and, desc, eq } from "drizzle-orm";
import { type AvatarManifest, EMPTY_AVATAR_MANIFEST, emotionLabelEnum, poseLabelEnum } from "@/contracts";
import { characters, db, images } from "../db";

/**
 * Build a character's **avatar asset manifest** (docs/developer-notes/avatar-3d.spec.md
 * §4) from its image rows. `baseImageId` is the canonical avatar (the always-present
 * fallback frame); expression/pose frames are `portrait_variant` rows tagged
 * `meta.avatarExpression` / `meta.avatarPose`. Slice 2 hand-seeds those tags
 * (`scripts/seed-avatar-expressions.ts`); slice 3 auto-generates them. Newest ready row
 * wins per key. Owner-scoped — a missing/unowned character degrades to the empty
 * manifest (never throws, leaks nothing).
 */

const EXPRESSION_KEYS = new Set<string>(emotionLabelEnum.options);
const POSE_KEYS = new Set<string>(poseLabelEnum.options);

/** Read a string-valued meta tag defensively (jsonb is `unknown` at this boundary). */
function metaTag(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export async function loadAvatarManifest(characterId: string, ownerId: string): Promise<AvatarManifest> {
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!character) return EMPTY_AVATAR_MANIFEST;

  // Newest-first so the first row seen for a key is the freshest (re-seeding a frame
  // supersedes the old one without a delete).
  const rows = await db()
    .select({ id: images.id, meta: images.meta })
    .from(images)
    .where(
      and(
        eq(images.ownerId, ownerId),
        eq(images.entityKind, "character"),
        eq(images.entityId, characterId),
        eq(images.status, "ready"),
        eq(images.kind, "portrait_variant"),
      ),
    )
    .orderBy(desc(images.createdAt));

  const expressions: Record<string, string> = {};
  const poses: Record<string, string> = {};
  for (const row of rows) {
    const expression = metaTag(row.meta, "avatarExpression");
    if (expression && EXPRESSION_KEYS.has(expression) && !(expression in expressions)) {
      expressions[expression] = row.id;
    }
    const pose = metaTag(row.meta, "avatarPose");
    if (pose && POSE_KEYS.has(pose) && !(pose in poses)) {
      poses[pose] = row.id;
    }
  }

  return { baseImageId: character.avatarImageId ?? null, expressions, poses, outfits: {} };
}
