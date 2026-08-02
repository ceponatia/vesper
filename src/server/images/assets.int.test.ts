import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngDataUrl,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { characters, db, images, items, locations } from "../db";
import {
  absoluteImagePath,
  createImageAsset,
  dataRoot,
  deleteOwnedImage,
  deleteOwnedImages,
  failImage,
  GALLERY_IMAGE_KINDS,
  saveImageBuffer,
  sweepOrphans,
} from "./assets";
import { monogramSvg } from "./monogram";
import { generateAvatar, generateAvatarsBatch } from "./avatar";
import { generateEntityImage, generateEntityImagesBatch, missingEntityImageIds } from "./entity";
import { uploadAvatar } from "./upload";
import { generateVariant, promoteVariant } from "./variants";

// Exercises the full row-before-file protocol and the demo-mode pipelines
// against DATABASE_URL. Self-skips when the database is unreachable, except
// under strict integration mode (`pnpm test:int:strict`), where it fails.

const ready = await probeIntegrationDb("images assets.int.test", "images");

let temp: TempDataRoot | undefined;
let userId = "";

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-images-int");
  userId = (await seedTestUser("images-int")).id;
});

afterAll(async () => {
  // Files first, then rows: nothing below reads the sandbox, and restoring
  // DATA_ROOT before the database work keeps the env untouched even if a delete
  // throws. `cleanup` restores the PREVIOUS DATA_ROOT rather than deleting it.
  await temp?.cleanup();
  await purgeOwnerRows([userId]);
  await endTestPool();
});

describe.skipIf(!ready)("asset registry protocol", () => {
  it("creates a pending row, then writes the file and flips to ready", async () => {
    const asset = await createImageAsset({ ownerId: userId, kind: "entity", entityKind: "world", prompt: "p" });
    expect(asset.status).toBe("pending");
    expect(asset.path).toBe(`images/${userId}/${asset.id}.webp`);
    await expect(fs.access(absoluteImagePath(asset))).rejects.toThrow(); // row before file

    const saved = await saveImageBuffer(asset.id, monogramSvg("Proto"));
    expect(saved?.status).toBe("ready");
    expect(saved?.meta).toMatchObject({ width: 768, height: 1024 });
    await expect(fs.access(absoluteImagePath(asset))).resolves.toBeUndefined();
  });

  it("marks the row failed on unconvertible input instead of throwing", async () => {
    const asset = await createImageAsset({ ownerId: userId, kind: "entity", entityKind: "world" });
    const saved = await saveImageBuffer(asset.id, Buffer.from("not an image"));
    expect(saved?.status).toBe("failed");
    expect((saved?.meta as Record<string, unknown>).error).toBeTruthy();
  });

  it("failImage records the error on the row", async () => {
    const asset = await createImageAsset({ ownerId: userId, kind: "entity", entityKind: "world" });
    const failed = await failImage(asset.id, "provider exploded");
    expect(failed?.status).toBe("failed");
    expect((failed?.meta as Record<string, unknown>).error).toBe("provider exploded");
  });

  // The purge helpers all run one caller-built predicate for both the select and
  // the delete, so what a call site guards on is exactly what it removes. These
  // assert the guard from the outside: a wrong-kind row in the same request must
  // survive with its file, and the count/boolean each form returns must describe
  // what actually went.
  it("the kind guard scopes a delete to the allowed class, files and all", async () => {
    const scene = await createImageAsset({ ownerId: userId, kind: "scene" });
    const look = await createImageAsset({ ownerId: userId, kind: "chat_look" });
    await saveImageBuffer(scene.id, monogramSvg("Scene"));
    await saveImageBuffer(look.id, monogramSvg("Look"));

    // The Gallery's allowed-kinds restriction: the chat_look id rides along in
    // the same request and is silently skipped, never deleted.
    expect(await deleteOwnedImages([scene.id, look.id], userId, { kinds: GALLERY_IMAGE_KINDS })).toBe(1);
    await expect(fs.access(absoluteImagePath(scene))).rejects.toThrow();
    await expect(fs.access(absoluteImagePath(look))).resolves.toBeUndefined();
    const survivors = await db()
      .select({ id: images.id })
      .from(images)
      .where(inArray(images.id, [scene.id, look.id]));
    expect(survivors.map((r) => r.id)).toEqual([look.id]);

    // Single form: false for a guarded-out row, true for the one delete that
    // lands, false again once it is gone.
    expect(await deleteOwnedImage(look.id, userId, { kinds: GALLERY_IMAGE_KINDS })).toBe(false);
    expect(await deleteOwnedImage(look.id, userId, { kind: "chat_look" })).toBe(true);
    expect(await deleteOwnedImage(look.id, userId, { kind: "chat_look" })).toBe(false);
    await expect(fs.access(absoluteImagePath(look))).rejects.toThrow();
  });

  it("sweepOrphans reconciles both directions and never throws", async () => {
    const old = new Date(Date.now() - 20 * 60_000);

    // orphan file (no row) + stale pending temp, both past the grace period
    const dir = path.join(dataRoot(), "images", userId);
    await fs.mkdir(dir, { recursive: true });
    const orphan = path.join(dir, "orphan.webp");
    const stalePending = path.join(dir, "ghost.pending.webp");
    await fs.writeFile(orphan, "x");
    await fs.writeFile(stalePending, "x");
    await fs.utimes(orphan, old, old);
    await fs.utimes(stalePending, old, old);

    // ready row whose file vanished
    const lost = await createImageAsset({ ownerId: userId, kind: "entity", entityKind: "world" });
    await db().update(images).set({ status: "ready" }).where(eq(images.id, lost.id));

    // stale pending row that never got a file
    const stale = await createImageAsset({ ownerId: userId, kind: "entity", entityKind: "world" });
    await db().update(images).set({ createdAt: old }).where(eq(images.id, stale.id));

    const result = await sweepOrphans({ ownerId: userId });
    expect(result.errors).toEqual([]);
    expect(result.orphanFilesRemoved).toBeGreaterThanOrEqual(1);
    expect(result.stalePendingFilesRemoved).toBeGreaterThanOrEqual(1);
    expect(result.rowsMarkedFailed).toBeGreaterThanOrEqual(2);
    await expect(fs.access(orphan)).rejects.toThrow();
    await expect(fs.access(stalePending)).rejects.toThrow();

    const [lostRow] = await db().select().from(images).where(eq(images.id, lost.id)).limit(1);
    const [staleRow] = await db().select().from(images).where(eq(images.id, stale.id)).limit(1);
    expect(lostRow?.status).toBe("failed");
    expect(staleRow?.status).toBe("failed");

    // idempotent: a second run finds nothing new
    const again = await sweepOrphans({ ownerId: userId });
    expect(again.orphanFilesRemoved).toBe(0);
    expect(again.rowsMarkedFailed).toBe(0);
  });
});

describe.skipIf(!ready)("demo-mode pipelines (AI_FAKE=1)", () => {
  it("generateAvatar produces a ready monogram and promotes it to the character", async () => {
    const [character] = await db()
      .insert(characters)
      .values({ ownerId: userId, name: "Mira Vale", profile: { bio: "Cartographer." } })
      .returning();
    if (!character) throw new Error("failed to create character");

    const imageId = await generateAvatar({ characterId: character.id, userId });
    const [row] = await db().select().from(images).where(eq(images.id, imageId)).limit(1);
    expect(row?.status).toBe("ready");
    expect(row?.kind).toBe("avatar");
    expect((row?.meta as Record<string, unknown>).demo).toBe(true);
    const [updated] = await db().select().from(characters).where(eq(characters.id, character.id)).limit(1);
    expect(updated?.avatarImageId).toBe(imageId);

    // variant against the demo avatar, then promotion
    const variantId = await generateVariant({
      characterId: character.id,
      userId,
      kind: "pose",
      instruction: "leaning on a railing",
    });
    const [variant] = await db().select().from(images).where(eq(images.id, variantId)).limit(1);
    expect(variant?.status).toBe("ready");
    expect(variant?.kind).toBe("portrait_variant");

    const promoted = await promoteVariant(character.id, variantId, userId);
    expect(promoted.ok).toBe(true);
    const [after] = await db().select().from(characters).where(eq(characters.id, character.id)).limit(1);
    expect(after?.avatarImageId).toBe(variantId);

    // Cross-owner rejection has its own suite (variants.int.test.ts); this is
    // just the unknown-character miss.
    const denied = await promoteVariant("someone-else", variantId, userId);
    expect(denied.ok).toBe(false);
  });

  it("generateAvatar for a missing character returns a failed image id, never throws", async () => {
    const imageId = await generateAvatar({ characterId: "missing-character", userId });
    const [row] = await db().select().from(images).where(eq(images.id, imageId)).limit(1);
    expect(row?.status).toBe("failed");
  });

  it("uploadAvatar crops a user image to 768×1024, saves it, and promotes it to the avatar", async () => {
    const [character] = await db()
      .insert(characters)
      .values({ ownerId: userId, name: "Upload Sub", profile: { bio: "Has a real photo." } })
      .returning();
    if (!character) throw new Error("failed to create character");

    // A 1200×800 landscape source — cover-resize must crop it to the 3:4 portrait.
    const dataUrl = await testPngDataUrl(1200, 800);

    const result = await uploadAvatar({ characterId: character.id, userId, dataUrl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db().select().from(images).where(eq(images.id, result.avatarImageId)).limit(1);
    expect(row?.status).toBe("ready");
    expect(row?.kind).toBe("avatar");
    expect(row?.meta).toMatchObject({ source: "upload", width: 768, height: 1024 });
    await expect(fs.access(absoluteImagePath(row ?? { path: "missing" }))).resolves.toBeUndefined();

    const [updated] = await db().select().from(characters).where(eq(characters.id, character.id)).limit(1);
    expect(updated?.avatarImageId).toBe(result.avatarImageId);
  });

  it("uploadAvatar rejects a non-image payload without writing a row", async () => {
    const before = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, userId));
    const result = await uploadAvatar({ characterId: "anything", userId, dataUrl: "not a data url" });
    expect(result.ok).toBe(false);
    const after = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, userId));
    expect(after.length).toBe(before.length); // bailed before creating an asset
  });

  it("generateEntityImage paints an item product image, sets imageId, and reclaims the old one on regenerate", async () => {
    const [item] = await db()
      .insert(items)
      .values({ ownerId: userId, kind: "object", name: "Brass Compass", description: "a worn navigator's compass" })
      .returning();
    if (!item) throw new Error("failed to create item");

    const firstId = await generateEntityImage({ entityKind: "item", entityId: item.id, userId });
    const [first] = await db().select().from(images).where(eq(images.id, firstId)).limit(1);
    expect(first?.status).toBe("ready");
    expect(first?.kind).toBe("entity");
    expect(first?.entityKind).toBe("item");
    const [afterFirst] = await db().select().from(items).where(eq(items.id, item.id)).limit(1);
    expect(afterFirst?.imageId).toBe(firstId);

    // Regenerate: the new image becomes canonical; the old row+file are reclaimed.
    const secondId = await generateEntityImage({ entityKind: "item", entityId: item.id, userId });
    expect(secondId).not.toBe(firstId);
    const [afterSecond] = await db().select().from(items).where(eq(items.id, item.id)).limit(1);
    expect(afterSecond?.imageId).toBe(secondId);
    const remaining = await db()
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.entityKind, "item"), eq(images.entityId, item.id)));
    expect(remaining.map((r) => r.id)).toEqual([secondId]); // single image per entity
  });

  it("generateEntityImage paints a location establishing image and sets imageId", async () => {
    const [loc] = await db()
      .insert(locations)
      .values({ ownerId: userId, name: "Tidal Flats", description: "a windswept salt marsh", scale: "expanse" })
      .returning();
    if (!loc) throw new Error("failed to create location");
    const imageId = await generateEntityImage({ entityKind: "location", entityId: loc.id, userId });
    const [img] = await db().select().from(images).where(eq(images.id, imageId)).limit(1);
    expect(img?.status).toBe("ready");
    expect(img?.entityKind).toBe("location");
    const [row] = await db().select().from(locations).where(eq(locations.id, loc.id)).limit(1);
    expect(row?.imageId).toBe(imageId);
  });

  it("generateAvatarsBatch fills avatars for the given characters (new-world backfill)", async () => {
    const made = await db()
      .insert(characters)
      .values([
        { ownerId: userId, name: "Batch One", profile: { bio: "first" } },
        { ownerId: userId, name: "Batch Two", profile: { bio: "second" } },
      ])
      .returning();
    const ids = made.map((m) => m.id);
    const count = await generateAvatarsBatch(ids, userId);
    expect(count).toBe(ids.length);
    const rows = await db()
      .select({ id: characters.id, avatarImageId: characters.avatarImageId })
      .from(characters)
      .where(inArray(characters.id, ids));
    expect(rows.every((r) => r.avatarImageId)).toBe(true);
  });

  it("generateEntityImagesBatch fills only the entities missing an image", async () => {
    const made = await db()
      .insert(items)
      .values([
        { ownerId: userId, kind: "object", name: "Already Pictured", imageId: "img-placeholder" },
        { ownerId: userId, kind: "object", name: "Needs One" },
        { ownerId: userId, kind: "clothing", name: "Needs Two" },
      ])
      .returning();
    const pictured = made.find((m) => m.name === "Already Pictured");

    const missing = await missingEntityImageIds("item", userId);
    expect(missing).not.toContain(pictured?.id); // entities with an image are skipped
    const needy = made.filter((m) => m.name !== "Already Pictured").map((m) => m.id);
    for (const id of needy) expect(missing).toContain(id);

    const count = await generateEntityImagesBatch("item", needy, userId);
    expect(count).toBe(needy.length);
    const stillMissing = await missingEntityImageIds("item", userId);
    for (const id of needy) expect(stillMissing).not.toContain(id); // all filled now
    // the pre-pictured item keeps its original image, untouched
    const [after] = await db().select().from(items).where(eq(items.id, pictured?.id ?? "")).limit(1);
    expect(after?.imageId).toBe("img-placeholder");
  });
});
