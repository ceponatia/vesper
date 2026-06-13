import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { eq, sql } from "drizzle-orm";
import { characters, db, images, sessions, users, worlds } from "../db";
import {
  absoluteImagePath,
  createImageAsset,
  dataRoot,
  failImage,
  saveImageBuffer,
  sweepOrphans,
} from "./assets";
import { monogramSvg } from "./monogram";
import { generateAvatar } from "./avatar";
import { uploadAvatar } from "./upload";
import { generateVariant, promoteVariant } from "./variants";
import { renderSceneImage } from "./scene";
import { emptySceneRenderPlan } from "./prompts";

// Exercises the full row-before-file protocol and the demo-mode pipelines
// against DATABASE_URL. Self-skips when the database is unreachable.

let available = false;
let tmp = "";
let userId = "";

beforeAll(async () => {
  try {
    await db().execute(sql`select 1 from images limit 0`);
    available = true;
  } catch (err) {
    console.warn(
      `[images assets.int] skipping: database unreachable or unmigrated (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vesper-images-int-"));
  process.env.DATA_ROOT = tmp;
  const [user] = await db()
    .insert(users)
    .values({ email: `images-int-${Date.now()}@test.local`, name: "Images Int" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  userId = user.id;
});

afterAll(async () => {
  delete process.env.DATA_ROOT;
  if (!available) return;
  await fs.rm(tmp, { recursive: true, force: true });
  await db().delete(images).where(eq(images.ownerId, userId));
  await db().delete(sessions).where(eq(sessions.ownerId, userId));
  await db().delete(worlds).where(eq(worlds.ownerId, userId));
  await db().delete(characters).where(eq(characters.ownerId, userId));
  await db().delete(users).where(eq(users.id, userId));
  await globalThis.__vesperPool?.end();
});

describe("asset registry protocol", () => {
  it("creates a pending row, then writes the file and flips to ready", async (ctx) => {
    if (!available) return ctx.skip();
    const asset = await createImageAsset({ ownerId: userId, kind: "entity", entityKind: "world", prompt: "p" });
    expect(asset.status).toBe("pending");
    expect(asset.path).toBe(`images/${userId}/${asset.id}.webp`);
    await expect(fs.access(absoluteImagePath(asset))).rejects.toThrow(); // row before file

    const saved = await saveImageBuffer(asset.id, monogramSvg("Proto"));
    expect(saved?.status).toBe("ready");
    expect(saved?.meta).toMatchObject({ width: 768, height: 1024 });
    await expect(fs.access(absoluteImagePath(asset))).resolves.toBeUndefined();
  });

  it("marks the row failed on unconvertible input instead of throwing", async (ctx) => {
    if (!available) return ctx.skip();
    const asset = await createImageAsset({ ownerId: userId, kind: "entity", entityKind: "world" });
    const saved = await saveImageBuffer(asset.id, Buffer.from("not an image"));
    expect(saved?.status).toBe("failed");
    expect((saved?.meta as Record<string, unknown>).error).toBeTruthy();
  });

  it("failImage records the error on the row", async (ctx) => {
    if (!available) return ctx.skip();
    const asset = await createImageAsset({ ownerId: userId, kind: "entity", entityKind: "world" });
    const failed = await failImage(asset.id, "provider exploded");
    expect(failed?.status).toBe("failed");
    expect((failed?.meta as Record<string, unknown>).error).toBe("provider exploded");
  });

  it("sweepOrphans reconciles both directions and never throws", async (ctx) => {
    if (!available) return ctx.skip();
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

describe("demo-mode pipelines (AI_FAKE=1)", () => {
  it("generateAvatar produces a ready monogram and promotes it to the character", async (ctx) => {
    if (!available) return ctx.skip();
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

    const promoted = await promoteVariant(character.id, variantId);
    expect(promoted.ok).toBe(true);
    const [after] = await db().select().from(characters).where(eq(characters.id, character.id)).limit(1);
    expect(after?.avatarImageId).toBe(variantId);

    const denied = await promoteVariant("someone-else", variantId);
    expect(denied.ok).toBe(false);
  });

  it("generateAvatar for a missing character returns a failed image id, never throws", async (ctx) => {
    if (!available) return ctx.skip();
    const imageId = await generateAvatar({ characterId: "missing-character", userId });
    const [row] = await db().select().from(images).where(eq(images.id, imageId)).limit(1);
    expect(row?.status).toBe("failed");
  });

  it("uploadAvatar crops a user image to 768×1024, saves it, and promotes it to the avatar", async (ctx) => {
    if (!available) return ctx.skip();
    const [character] = await db()
      .insert(characters)
      .values({ ownerId: userId, name: "Upload Sub", profile: { bio: "Has a real photo." } })
      .returning();
    if (!character) throw new Error("failed to create character");

    // A 1200×800 landscape source — cover-resize must crop it to the 3:4 portrait.
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 12, g: 120, b: 200 } } })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

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

  it("uploadAvatar rejects a non-image payload without writing a row", async (ctx) => {
    if (!available) return ctx.skip();
    const before = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, userId));
    const result = await uploadAvatar({ characterId: "anything", userId, dataUrl: "not a data url" });
    expect(result.ok).toBe(false);
    const after = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, userId));
    expect(after.length).toBe(before.length); // bailed before creating an asset
  });

  it("renderSceneImage attaches a ready demo scene to the session gallery", async (ctx) => {
    if (!available) return ctx.skip();
    const [world] = await db().insert(worlds).values({ ownerId: userId, name: "W" }).returning();
    if (!world) throw new Error("failed to create world");
    const [session] = await db().insert(sessions).values({ ownerId: userId, worldId: world.id, title: "S" }).returning();
    if (!session) throw new Error("failed to create session");

    const plan = {
      ...emptySceneRenderPlan(),
      focal: { name: "Mira Vale", action: "", outfitSummary: "", appearance: "" },
    };
    const imageId = await renderSceneImage({ session: { id: session.id, ownerId: userId }, plan, userId });
    const [row] = await db().select().from(images).where(eq(images.id, imageId)).limit(1);
    expect(row?.status).toBe("ready");
    expect(row?.kind).toBe("scene");
    expect(row?.sessionId).toBe(session.id);
    await expect(fs.access(absoluteImagePath(row ?? { path: "missing" }))).resolves.toBeUndefined();
  });
});
