import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characterChats, db, images, users } from "@/server/db";
import { createImageAsset } from "./assets";
import { internalDeleteChatAssets, internalSaveImageBuffer } from "./internal";
import { deleteOwnedChatAssets, deleteOwnedChatUploads, saveOwnedImageBuffer } from "./route-safe";
import { monogramSvg } from "./monogram";

let available = false;
let tmp = "";
let ownerA = "";
let ownerB = "";
let chatB = "";

beforeAll(async () => {
  try {
    await db().execute(sql`select 1 from images limit 0`);
  } catch (error) {
    process.stderr.write(
      `[images route-safe.int.test] skipping: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return;
  }

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vesper-image-route-safe-"));
  process.env.DATA_ROOT = tmp;
  const stamp = Date.now();
  const made = await db()
    .insert(users)
    .values([
      { email: `image-route-owner-a-${stamp}@test.local`, name: "Image Route Owner A" },
      { email: `image-route-owner-b-${stamp}@test.local`, name: "Image Route Owner B" },
    ])
    .returning({ id: users.id });
  const first = made[0];
  const second = made[1];
  if (!first || !second) throw new Error("failed to seed image route-safe users");
  ownerA = first.id;
  ownerB = second.id;
  const [chat] = await db().insert(characterChats).values({ ownerId: ownerB }).returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to seed foreign chat");
  chatB = chat.id;
  available = true;
});

afterAll(async () => {
  delete process.env.DATA_ROOT;
  if (!available) return;
  await db().delete(images).where(inArray(images.ownerId, [ownerA, ownerB]));
  await db().delete(characterChats).where(eq(characterChats.id, chatB));
  await db().delete(users).where(inArray(users.id, [ownerA, ownerB]));
  await fs.rm(tmp, { recursive: true, force: true });
  await globalThis.__vesperPool?.end();
});

describe.runIf(available)("owner-scoped image mutation helpers", () => {
  it("does not save a foreign owner's image row", async () => {
    const asset = await createImageAsset({ ownerId: ownerB, kind: "entity", entityKind: "world" });
    const denied = await saveOwnedImageBuffer(asset.id, ownerA, monogramSvg("Denied"));
    expect(denied).toBeNull();

    const [stillPending] = await db()
      .select({ status: images.status })
      .from(images)
      .where(eq(images.id, asset.id));
    expect(stillPending?.status).toBe("pending");
    await expect(fs.access(path.join(tmp, asset.path))).rejects.toThrow();

    const saved = await saveOwnedImageBuffer(asset.id, ownerB, monogramSvg("Allowed"));
    expect(saved?.status).toBe("ready");
    await expect(fs.access(path.join(tmp, asset.path))).resolves.toBeUndefined();
  });

  it("requires the owner id when deleting message attachments", async () => {
    const anchorMessageId = `message-${Date.now()}`;
    const asset = await createImageAsset({
      ownerId: ownerB,
      kind: "chat_upload",
      chatId: chatB,
      anchorMessageId,
    });
    await internalSaveImageBuffer(asset.id, monogramSvg("Upload"));

    expect(await deleteOwnedChatUploads(chatB, ownerA, [anchorMessageId])).toBe(0);
    expect((await db().select({ id: images.id }).from(images).where(eq(images.id, asset.id))).length).toBe(1);

    expect(await deleteOwnedChatUploads(chatB, ownerB, [anchorMessageId])).toBe(1);
    expect((await db().select({ id: images.id }).from(images).where(eq(images.id, asset.id))).length).toBe(0);
    await expect(fs.access(path.join(tmp, asset.path))).rejects.toThrow();
  });

  it("owner-scopes bulk chat-private cleanup", async () => {
    const look = await createImageAsset({ ownerId: ownerB, kind: "chat_look", chatId: chatB });
    const place = await createImageAsset({ ownerId: ownerB, kind: "chat_place", chatId: chatB });
    await internalSaveImageBuffer(look.id, monogramSvg("Look"));
    await internalSaveImageBuffer(place.id, monogramSvg("Place"));

    expect(await deleteOwnedChatAssets(chatB, ownerA, ["chat_look", "chat_place"])).toBe(0);
    expect(
      (await db().select({ id: images.id }).from(images).where(inArray(images.id, [look.id, place.id]))).length,
    ).toBe(2);

    expect(await deleteOwnedChatAssets(chatB, ownerB, ["chat_look", "chat_place"])).toBe(2);
    expect(
      (await db().select({ id: images.id }).from(images).where(inArray(images.id, [look.id, place.id]))).length,
    ).toBe(0);
  });

  it("keeps the unscoped helper available to a trusted cascade module", async () => {
    const asset = await createImageAsset({ ownerId: ownerB, kind: "chat_upload", chatId: chatB });
    await internalSaveImageBuffer(asset.id, monogramSvg("Cascade"));

    expect(await internalDeleteChatAssets(chatB, ["chat_upload"])).toBe(1);
    expect((await db().select({ id: images.id }).from(images).where(eq(images.id, asset.id))).length).toBe(0);
  });
});
