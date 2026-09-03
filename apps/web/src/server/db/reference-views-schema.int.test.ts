import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characterReferenceViews, characters, db, images } from "@/server/db";
import { isUniqueViolation } from "@/server/api";
import { canonicalImageRow, endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";

/**
 * The `character_reference_views` constraints against a migrated database —
 * the three guarantees the store is allowed to ASSUME rather than re-check, so
 * nothing short of a real Postgres can prove them.
 *
 * 1. **One current row per (character, angle, wardrobe).** The partial unique
 *    index is what makes a lost reservation race fail loudly instead of leaving
 *    a slot with two "current" views for the studio to pick between — and the
 *    reason `reserveReferenceView` retires and inserts in one transaction rather
 *    than trusting itself to be the only writer. Falsified against a schema
 *    whose index omits the `WHERE current` predicate (which would forbid a
 *    slot's HISTORY, the opposite bug) or omits the index entirely.
 * 2. **Deleting the character deletes its views.** Operational data, which does
 *    not inherit the Gallery-retention exception that keeps user-visible images.
 * 3. **Deleting an image NULLs the pointers.** The safety net that turns a
 *    vanished asset into a view the projection refuses, rather than a delete
 *    that blocks or a row that cascades away with its file.
 */

const ready = await probeIntegrationDb("reference views schema.int.test", "character_reference_views");

let ownerId = "";

function viewRow(
  characterId: string,
  over: Partial<typeof characterReferenceViews.$inferInsert> = {},
): typeof characterReferenceViews.$inferInsert {
  return {
    characterId,
    angleId: "front_full",
    wardrobe: "clothed",
    sourceContentHash: "a".repeat(64),
    generationVersion: 1,
    ...over,
  };
}

/** A real async function rather than the bare builder, so `expect(...).rejects` gets a Promise. */
async function insertView(
  characterId: string,
  over: Partial<typeof characterReferenceViews.$inferInsert> = {},
): Promise<string> {
  const [row] = await db()
    .insert(characterReferenceViews)
    .values(viewRow(characterId, over))
    .returning({ id: characterReferenceViews.id });
  if (!row) throw new Error("[reference-views-schema] inserting a view returned no row");
  return row.id;
}

async function seedCharacter(name: string): Promise<string> {
  const [row] = await db().insert(characters).values({ ownerId, name }).returning({ id: characters.id });
  if (!row) throw new Error(`[reference-views-schema] seeding character "${name}" inserted no row`);
  return row.id;
}

/** Only the id the FKs point at matters here — no file is written. */
async function seedImage(): Promise<string> {
  const [row] = await db()
    .insert(images)
    .values(canonicalImageRow({ ownerId, kind: "reference_view" as const, status: "ready" as const }))
    .returning({ id: images.id });
  if (!row) throw new Error("[reference-views-schema] seeding image inserted no row");
  return row.id;
}

async function viewIds(characterId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: characterReferenceViews.id })
    .from(characterReferenceViews)
    .where(eq(characterReferenceViews.characterId, characterId));
  return rows.map((row) => row.id);
}

afterAll(async () => {
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

beforeAll(async () => {
  if (!ready) return;
  ownerId = await seedTestUser("reference-views-schema");
});

describe.skipIf(!ready)("character_reference_views constraints", () => {
  it("permits at most one current row per slot, while keeping the slot's history", async () => {
    const characterId = await seedCharacter("one current per slot");
    await insertView(characterId, { current: true });
    await expect(insertView(characterId, { current: true })).rejects.toSatisfy(isUniqueViolation);

    // The predicate is `WHERE current`: retired attempts are the point of the
    // table, so any number of them may share a slot.
    await insertView(characterId, { current: false, status: "superseded" });
    await insertView(characterId, { current: false, status: "rejected" });
    expect(await viewIds(characterId)).toHaveLength(3);

    // A different slot is a different subject, whatever the first one holds.
    await insertView(characterId, { current: true, angleId: "back_full" });
    await insertView(characterId, { current: true, wardrobe: "bare" });
    expect(await viewIds(characterId)).toHaveLength(5);
  });

  it("deletes a character's views with the character", async () => {
    const characterId = await seedCharacter("views die with the character");
    await insertView(characterId, { current: true });
    await db().delete(characters).where(eq(characters.id, characterId));
    expect(await viewIds(characterId)).toEqual([]);
  });

  it("nulls the image pointers when the assets go, rather than blocking or cascading", async () => {
    const characterId = await seedCharacter("image pointers null out");
    const sourceImageId = await seedImage();
    const imageId = await seedImage();
    const viewId = await insertView(characterId, { current: true, sourceImageId, imageId, status: "ready" });

    await db().delete(images).where(eq(images.id, imageId));
    await db().delete(images).where(eq(images.id, sourceImageId));

    const [row] = await db()
      .select({ imageId: characterReferenceViews.imageId, sourceImageId: characterReferenceViews.sourceImageId })
      .from(characterReferenceViews)
      .where(eq(characterReferenceViews.id, viewId));
    expect(row).toEqual({ imageId: null, sourceImageId: null });
  });
});
