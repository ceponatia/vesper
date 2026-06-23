import { and, eq, or, sql } from "drizzle-orm";
import { characters, db, items, locations } from "@/server/db";

/**
 * The authorization seam for shareable entities (auth.plan.md). One place owns
 * the asymmetry: **reads** on the browse/preview/copy path widen to
 * owner-or-public; **every write stays owner-strict** (PATCH/DELETE still match
 * on `ownerId`, so a non-owner write 404s — it never confirms the row exists).
 * Worlds and sessions are always private and never pass through here.
 */

export type ShareableKind = "character" | "location" | "item";

const PUBLIC_TABLE_NAMES: Record<ShareableKind, string> = {
  character: "characters",
  location: "locations",
  item: "items",
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
  }
}

/**
 * Whether an image belongs to a **public** shareable entity — the cross-owner
 * read gate for `images/[id]/file` on the preview path. World images and scene
 * images (entityKind null) are never shareable, so they stay owner-only.
 */
export async function isPublicEntityImage(
  entityKind: string | null,
  entityId: string | null,
): Promise<boolean> {
  if (!entityId) return false;
  const tableName = PUBLIC_TABLE_NAMES[entityKind as ShareableKind] as string | undefined;
  if (!tableName) return false;
  const result = await db().execute(
    sql`select 1 from ${sql.identifier(tableName)} where id = ${entityId} and visibility = 'public' limit 1`,
  );
  return result.rows.length > 0;
}
