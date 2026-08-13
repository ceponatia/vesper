import fs from "node:fs/promises";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characterChats, db, images } from "@/server/db";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { createImageAsset } from "./assets";
import { internalDeleteChatAssets, internalSaveImageBuffer } from "./internal";
import { deleteOwnedChatAssets, deleteOwnedChatUploads, saveOwnedImageBuffer } from "./route-safe";
import { monogramSvg } from "./monogram";

// The gate is resolved at COLLECTION time, before the describe registers: the
// old `describe.runIf(available)` read a flag that `beforeAll` had not set yet,
// so this owner-scoping suite silently skipped every run.
const ready = await probeIntegrationDb("images route-safe.int.test", "images");

let temp: TempDataRoot | undefined;
let tmp = "";
let ownerA = "";
let ownerB = "";
let chatB = "";

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-image-route-safe");
  tmp = temp.root;
  ownerA = (await seedTestUser("image-route-owner-a")).id;
  ownerB = (await seedTestUser("image-route-owner-b")).id;
  const [chat] = await db().insert(characterChats).values({ ownerId: ownerB }).returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to seed foreign chat");
  chatB = chat.id;
});

afterAll(async () => {
  // Files first, then rows (the old order deleted rows first); no assertion
  // reads either after teardown starts, so only the DATA_ROOT restore is
  // load-bearing — and `cleanup` restores the previous value instead of
  // blind-deleting it. `purgeOwnerRows` covers the chat via its owner.
  await temp?.cleanup();
  await purgeOwnerRows([ownerA, ownerB]);
  await endTestPool();
});

describe.skipIf(!ready)("owner-scoped image mutation helpers", () => {
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
