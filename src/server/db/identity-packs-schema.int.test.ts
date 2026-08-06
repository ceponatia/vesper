import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characters, db, imageIdentityPacks, images } from "@/server/db";
import { isUniqueViolation } from "@/server/api";
import {
  canonicalImageRow,
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
} from "@/server/test-support";

/**
 * The `image_identity_packs` constraints against a migrated database
 * (image-identity-packs.spec.data.md §Persistence model). These are the four
 * guarantees the service layer is allowed to ASSUME rather than re-check, so
 * nothing short of a real Postgres can prove them:
 *
 * 1. one current revision per character (the partial unique index) — the storage
 *    half of invariant 1, so a lost promotion race fails loudly instead of
 *    leaving two "current" packs for the sweep to find;
 * 2. a revision number is used once per character;
 * 3. deleting the character deletes its packs (operational data, which does not
 *    inherit the Gallery-retention exception — spec.lifecycle.md §Character
 *    deletion);
 * 4. deleting an image NULLs the pointers instead of blocking or cascading — the
 *    safety net that turns a vanished source into an unusable pack rather than a
 *    pack that keeps serving a crop it can no longer justify.
 */

const ready = await probeIntegrationDb("identity packs schema.int.test", "image_identity_packs");

let ownerId = "";

/** The columns every revision must carry, so each test states only what it varies. */
function packRow(
  characterId: string,
  over: Partial<typeof imageIdentityPacks.$inferInsert> = {},
): typeof imageIdentityPacks.$inferInsert {
  return {
    characterId,
    revision: 1,
    sourceContentHash: "a".repeat(64),
    sourceWidth: 768,
    sourceHeight: 1024,
    schemaVersion: 1,
    derivationVersion: "derive_v1",
    policyVersion: "policy_v1",
    ...over,
  };
}

/**
 * Insert one revision. A real async function rather than the bare drizzle
 * builder, so `expect(...).rejects` receives a Promise and not a thenable.
 */
async function insertPack(characterId: string, over: Partial<typeof imageIdentityPacks.$inferInsert> = {}): Promise<string> {
  const [row] = await db().insert(imageIdentityPacks).values(packRow(characterId, over)).returning({
    id: imageIdentityPacks.id,
  });
  if (!row) throw new Error("[identity-packs-schema] inserting a pack returned no row");
  return row.id;
}

async function seedCharacter(name: string): Promise<string> {
  const [row] = await db().insert(characters).values({ ownerId, name }).returning({ id: characters.id });
  if (!row) throw new Error(`[identity-packs-schema] seeding character "${name}" inserted no row`);
  return row.id;
}

/** Only the id the pack's FKs point at matters here — no file is written. */
async function seedImage(): Promise<string> {
  const [row] = await db()
    .insert(images)
    .values(canonicalImageRow({ ownerId, kind: "avatar" as const, status: "ready" as const }))
    .returning({ id: images.id });
  if (!row) throw new Error("[identity-packs-schema] seeding image inserted no row");
  return row.id;
}

async function packIds(characterId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: imageIdentityPacks.id })
    .from(imageIdentityPacks)
    .where(eq(imageIdentityPacks.characterId, characterId));
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  if (!ready) return;
  ownerId = (await seedTestUser("identity-packs-schema")).id;
});

afterAll(async () => {
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

describe.skipIf(!ready)("image_identity_packs constraints", () => {
  it("permits only one current revision per character", async () => {
    const characterId = await seedCharacter("one-current");
    await insertPack(characterId, { revision: 1, current: true });

    await expect(insertPack(characterId, { revision: 2, current: true })).rejects.toSatisfy(
      isUniqueViolation,
      "a second current revision must fail with a unique violation",
    );

    // The index is PARTIAL: any number of non-current revisions coexist, which is
    // what makes history, superseded rows and retained failure evidence possible.
    await insertPack(characterId, { revision: 2, status: "superseded" });
    await insertPack(characterId, { revision: 3, status: "failed" });
    expect(await packIds(characterId)).toHaveLength(3);

    // And it is scoped per character, not global.
    const otherId = await seedCharacter("one-current-other");
    await insertPack(otherId, { current: true });
    const currents = await db()
      .select({ id: imageIdentityPacks.id })
      .from(imageIdentityPacks)
      .where(and(eq(imageIdentityPacks.characterId, otherId), eq(imageIdentityPacks.current, true)));
    expect(currents).toHaveLength(1);
  });

  it("uses a revision number once per character", async () => {
    const characterId = await seedCharacter("revision-unique");
    await insertPack(characterId, { revision: 4 });

    await expect(insertPack(characterId, { revision: 4, status: "failed" })).rejects.toSatisfy(
      isUniqueViolation,
      "a repeated revision number must fail with a unique violation",
    );

    // The same revision number under a different character is not a collision.
    const otherId = await seedCharacter("revision-unique-other");
    await insertPack(otherId, { revision: 4 });
    expect(await packIds(otherId)).toHaveLength(1);
  });

  it("deletes a character's packs with the character", async () => {
    const characterId = await seedCharacter("cascade");
    await insertPack(characterId, { current: true });
    await insertPack(characterId, { revision: 2, status: "superseded" });

    await db().delete(characters).where(eq(characters.id, characterId));

    expect(await packIds(characterId)).toEqual([]);
  });

  it("nulls the image pointers when their images are deleted", async () => {
    const characterId = await seedCharacter("source-set-null");
    const sourceImageId = await seedImage();
    const faceCropImageId = await seedImage();
    const packId = await insertPack(characterId, {
      current: true,
      status: "ready",
      sourceImageId,
      faceCropImageId,
    });

    await db().delete(images).where(eq(images.id, sourceImageId));

    // The pack SURVIVES its source: it stays as the record of a derivation, now
    // unusable (`source_missing`), rather than vanishing with the bytes. The crop
    // pointer is untouched — one deleted image invalidates one pointer.
    const [afterSource] = await db()
      .select({ sourceImageId: imageIdentityPacks.sourceImageId, faceCropImageId: imageIdentityPacks.faceCropImageId })
      .from(imageIdentityPacks)
      .where(eq(imageIdentityPacks.id, packId));
    expect(afterSource?.sourceImageId).toBeNull();
    expect(afterSource?.faceCropImageId).toBe(faceCropImageId);

    await db().delete(images).where(eq(images.id, faceCropImageId));
    const [afterCrop] = await db()
      .select({ faceCropImageId: imageIdentityPacks.faceCropImageId })
      .from(imageIdentityPacks)
      .where(eq(imageIdentityPacks.id, packId));
    expect(afterCrop?.faceCropImageId).toBeNull();
  });
});
