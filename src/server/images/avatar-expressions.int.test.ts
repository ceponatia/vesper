import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { characters, db, images, users } from "../db";
import { createImageAsset, saveImageBuffer } from "./assets";
import { clearAvatarExpressionFrames, coveredExpressionEmotions, seedAvatarExpressions } from "./avatar-expressions";
import { loadAvatarManifest } from "./avatar-manifest";
import { monogramSvg } from "./monogram";

// Exercises the avatar expression-frame pipeline (avatar-3d slice 3) in demo mode
// (monogram frames). Self-skips when the database is unreachable.

let available = false;
let tmp = "";
let userId = "";

beforeAll(async () => {
  try {
    await db().execute(sql`select 1 from images limit 0`);
    available = true;
  } catch (err) {
    console.warn(`[avatar-expressions.int] skipping: database unreachable (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vesper-avatar-exp-int-"));
  process.env.DATA_ROOT = tmp;
  const [user] = await db().insert(users).values({ email: `avatar-exp-int-${Date.now()}@test.local`, name: "Avatar Exp Int" }).returning();
  if (!user) throw new Error("failed to create test user");
  userId = user.id;
});

afterAll(async () => {
  delete process.env.DATA_ROOT;
  if (!available) return;
  await fs.rm(tmp, { recursive: true, force: true });
  await db().delete(images).where(eq(images.ownerId, userId));
  await db().delete(characters).where(eq(characters.ownerId, userId));
  await db().delete(users).where(eq(users.id, userId));
  await globalThis.__vesperPool?.end();
});

/** A character with a ready (demo monogram) canonical avatar. */
async function makeCharacter(name: string, withAvatar = true): Promise<string> {
  const [c] = await db().insert(characters).values({ ownerId: userId, name }).returning({ id: characters.id });
  if (!c) throw new Error("character insert failed");
  if (withAvatar) {
    const avatar = await createImageAsset({ ownerId: userId, kind: "avatar", entityKind: "character", entityId: c.id, prompt: "p" });
    await saveImageBuffer(avatar.id, monogramSvg(name));
    await db().update(characters).set({ avatarImageId: avatar.id }).where(eq(characters.id, c.id));
  }
  return c.id;
}

describe("seedAvatarExpressions", () => {
  it("seeds all 11 frames, is idempotent, and feeds the manifest", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await makeCharacter("Seeded");

    const first = await seedAvatarExpressions(id, userId);
    expect(first.seeded).toBe(11);
    expect(first.failed).toBe(0);

    const covered = await coveredExpressionEmotions(id, userId);
    expect(covered.size).toBe(11);

    // Idempotent: a re-run generates nothing new.
    const second = await seedAvatarExpressions(id, userId);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBe(11);

    const manifest = await loadAvatarManifest(id, userId);
    expect(Object.keys(manifest.expressions).length).toBe(11);
    expect(manifest.expressions["happy"]).toBeTruthy();
  });

  it("no-ops (skips, no fail rows) when the character has no ready avatar", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await makeCharacter("NoAvatar", false);
    const result = await seedAvatarExpressions(id, userId);
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe(11);
    expect(result.failed).toBe(0);
    // No image rows were written at all (gated before generateVariant).
    const rows = await db().select({ id: images.id }).from(images).where(and(eq(images.entityId, id), eq(images.kind, "portrait_variant")));
    expect(rows).toHaveLength(0);
  });

  it("seeds only the requested emotions for lazy-gen", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await makeCharacter("Lazy");
    const result = await seedAvatarExpressions(id, userId, ["aroused"]);
    expect(result.seeded).toBe(1);
    expect((await coveredExpressionEmotions(id, userId)).has("aroused")).toBe(true);
    expect((await coveredExpressionEmotions(id, userId)).has("happy")).toBe(false);
  });
});

describe("coveredExpressionEmotions — negative cache", () => {
  async function failedFrame(id: string, emotion: string, meta: Record<string, unknown>): Promise<void> {
    const f = await createImageAsset({
      ownerId: userId,
      kind: "portrait_variant",
      entityKind: "character",
      entityId: id,
      prompt: "p",
      meta: { avatarExpression: emotion, ...meta },
    });
    await db().update(images).set({ status: "failed" }).where(eq(images.id, f.id));
  }

  it("tombstones content rejections and caps 'other' failures, but keeps transient ones retriable", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await makeCharacter("Failing");

    await failedFrame(id, "aroused", { avatarExpressionGaveUp: true }); // explicit content-rejection tombstone
    await failedFrame(id, "afraid", { error: "request blocked by content policy" }); // classified content_rejection
    await failedFrame(id, "angry", { error: "render broke" }); // "other" ×2 ⇒ capped
    await failedFrame(id, "angry", { error: "render broke" });
    await failedFrame(id, "sad", { error: "venice 503: service unavailable" }); // transient ×2 ⇒ still retriable
    await failedFrame(id, "sad", { error: "venice 503: service unavailable" });

    const covered = await coveredExpressionEmotions(id, userId);
    expect(covered.has("aroused")).toBe(true); // tombstone
    expect(covered.has("afraid")).toBe(true); // re-classified content rejection
    expect(covered.has("angry")).toBe(true); // ≥2 non-transient failures
    expect(covered.has("sad")).toBe(false); // transient ⇒ retried, not muted
    expect(covered.has("happy")).toBe(false); // no rows
  });
});

describe("clearAvatarExpressionFrames", () => {
  it("deletes the expression set but never the frame that is the canonical avatar", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await makeCharacter("Promoter");
    await seedAvatarExpressions(id, userId);

    // Promote one expression frame to be the canonical avatar.
    const manifest = await loadAvatarManifest(id, userId);
    const promoted = manifest.expressions["happy"]!;
    await db().update(characters).set({ avatarImageId: promoted }).where(eq(characters.id, id));

    const removed = await clearAvatarExpressionFrames(id, userId);
    expect(removed).toBe(10); // 11 seeded − the one that is now the avatar

    const survivor = await db().select({ id: images.id }).from(images).where(eq(images.id, promoted)).limit(1);
    expect(survivor).toHaveLength(1); // the promoted frame survives the clear
    const rest = await db().select({ id: images.id }).from(images).where(and(eq(images.entityId, id), eq(images.kind, "portrait_variant")));
    expect(rest).toHaveLength(1);
  });
});
