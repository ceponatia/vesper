import { and, eq, or, sql } from "drizzle-orm";
import { characters, db, type images, items, locations, socialCards } from "@/server/db";

/**
 * The authorization seam for shareable entities (auth.plan.md). One place owns
 * the asymmetry: **reads** on the browse/preview/copy path widen to
 * owner-or-public; **every write stays owner-strict** (PATCH/DELETE still match
 * on `ownerId`, so a non-owner write 404s — it never confirms the row exists).
 */

export type ShareableKind = "character" | "location" | "item" | "social_card";

const PUBLIC_TABLE_NAMES: Record<ShareableKind, string> = {
  character: "characters",
  location: "locations",
  item: "items",
  social_card: "social_cards",
};

/**
 * Read a shareable entity the user may **view**: their own (any visibility) OR a
 * public one. Returns the row with its real `ownerId` (so callers can scope
 * sub-resources — portraits, links — to the entity owner, not the viewer), or
 * undefined when neither owned nor public. Reads only — never a write gate.
 */
export function findViewable(kind: "character", id: string, userId: string): Promise<typeof characters.$inferSelect | undefined>;
export function findViewable(kind: "location", id: string, userId: string): Promise<typeof locations.$inferSelect | undefined>;
export function findViewable(kind: "item", id: string, userId: string): Promise<typeof items.$inferSelect | undefined>;
export function findViewable(kind: "social_card", id: string, userId: string): Promise<typeof socialCards.$inferSelect | undefined>;
export async function findViewable(kind: ShareableKind, id: string, userId: string) {
  switch (kind) {
    case "character": {
      const [row] = await db()
        .select()
        .from(characters)
        .where(and(eq(characters.id, id), or(eq(characters.ownerId, userId), eq(characters.visibility, "public"))))
        .limit(1);
      return row;
    }
    case "location": {
      const [row] = await db()
        .select()
        .from(locations)
        .where(and(eq(locations.id, id), or(eq(locations.ownerId, userId), eq(locations.visibility, "public"))))
        .limit(1);
      return row;
    }
    case "item": {
      const [row] = await db()
        .select()
        .from(items)
        .where(and(eq(items.id, id), or(eq(items.ownerId, userId), eq(items.visibility, "public"))))
        .limit(1);
      return row;
    }
    case "social_card": {
      const [row] = await db()
        .select()
        .from(socialCards)
        .where(and(eq(socialCards.id, id), or(eq(socialCards.ownerId, userId), eq(socialCards.visibility, "public"))))
        .limit(1);
      return row;
    }
  }
}

/**
 * Whether an image belongs to a **public** shareable entity **owned by the same
 * account as the image** — the cross-owner read gate for `images/[id]/file` on
 * the preview path. World images and scene images (entityKind null) are never
 * shareable, so they stay owner-only.
 *
 * The ownership predicate is load-bearing (security-authz.plan.md slice 3):
 * `entityKind`/`entityId` are polymorphic metadata with no FK, so without it the
 * gate reads "some public row carries this id" and any path that ever lets a
 * user write those two columns turns their own private asset into a
 * world-readable one by naming someone else's public character. Matching the
 * image's owner to the entity's owner keeps the widening to what it was always
 * meant to be: *the author's own art on the author's own published entity.*
 */
export async function isPublicEntityImage(
  entityKind: string | null,
  entityId: string | null,
  imageOwnerId: string,
): Promise<boolean> {
  if (!entityId) return false;
  const tableName = PUBLIC_TABLE_NAMES[entityKind as ShareableKind] as string | undefined;
  if (!tableName) return false;
  const result = await db().execute(
    sql`select 1 from ${sql.identifier(tableName)}
        where id = ${entityId} and visibility = 'public' and owner_id = ${imageOwnerId}
        limit 1`,
  );
  return result.rows.length > 0;
}

/**
 * The **public representations** of the shareable kinds (security-authz.plan.md
 * slice 4). "Public" means *the approved public representation*, never the
 * persisted row: each projection is an explicit allow-list, so a column added
 * later is private by default and only joins the public surface when someone
 * puts it here deliberately.
 *
 * Excluded everywhere by rule: `ownerId` (routes send the computed `mine` flag
 * instead — the viewer never needs another account's id), `searchEmbedding` /
 * `embedder` (retrieval internals, megabytes of dead payload), `clonedFromId`
 * (remix provenance, nothing renders it), and `updatedAt` (an authoring
 * timestamp; `createdAt` is the only one a public card would ever show).
 *
 * Owner reads keep the full row — the edit surfaces need every column — so the
 * routes split on `row.ownerId === user.id`, never on the shape alone.
 */
export function toPublicCharacter(row: typeof characters.$inferSelect) {
  // `profile` ships whole pending the owner ruling on what a public character
  // reveals (security-authz.plan.md OQ2); the duplicate CTA already copies it
  // whole, so narrowing here without narrowing the clone would be theatre.
  return {
    id: row.id,
    name: row.name,
    profile: row.profile,
    avatarImageId: row.avatarImageId,
    tags: row.tags,
    visibility: row.visibility,
    createdAt: row.createdAt,
  };
}

export function toPublicLocation(row: typeof locations.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ambient: row.ambient,
    scale: row.scale,
    area: row.area,
    affordances: row.affordances,
    tags: row.tags,
    imageId: row.imageId,
    visibility: row.visibility,
    createdAt: row.createdAt,
  };
}

export function toPublicItem(row: typeof items.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    definition: row.definition,
    tags: row.tags,
    imageId: row.imageId,
    visibility: row.visibility,
    createdAt: row.createdAt,
  };
}

export function toPublicSocialCard(row: typeof socialCards.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: row.definition,
    tags: row.tags,
    visibility: row.visibility,
    createdAt: row.createdAt,
  };
}

/**
 * The public shape of an entity image — everything the preview strip needs to
 * render it through `/api/images/[id]/file`, and nothing else. No `path`
 * (storage layout), no `prompt` (prompts embed authored/chat text, which is why
 * `deleteChat` scrubs them), no `status`/`meta`/`sourceImageId` provider
 * internals (security-authz.plan.md slice 4).
 */
export function toPublicEntityImage(row: typeof images.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    entityKind: row.entityKind,
    entityId: row.entityId,
    createdAt: row.createdAt,
  };
}
