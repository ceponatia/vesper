import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngDataUrl,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { db, images } from "../db";
import { imageMeta } from "./asset-storage";
import { readOwnedImageBytes } from "./owned-image-reads";
import { importAdminFilesImageReference, uploadImageGeneratorReference } from "./upload";

const ready = await probeIntegrationDb("image generator upload.int.test", "images");

let temp: TempDataRoot | undefined;
let ownerId = "";
let otherOwnerId = "";

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-image-generator-upload-int");
  ownerId = (await seedTestUser("image-generator-upload-int")).id;
  otherOwnerId = (await seedTestUser("image-generator-upload-int-b")).id;
});

afterAll(async () => {
  await temp?.cleanup();
  await purgeOwnerRows([ownerId, otherOwnerId]);
  await endTestPool();
});

describe.skipIf(!ready)("Image Generator direct uploads", () => {
  it("stores a ready Generator asset with upload provenance and no entity/chat association", async () => {
    const result = await uploadImageGeneratorReference({
      userId: ownerId,
      dataUrl: await testPngDataUrl(640, 480),
      fileName: "depth map.png",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db().select().from(images).where(eq(images.id, result.imageId)).limit(1);
    expect(row).toMatchObject({
      ownerId,
      kind: "generator_output",
      status: "ready",
      entityKind: null,
      entityId: null,
      chatId: null,
      prompt: "Uploaded Generator reference — depth map.png",
    });
    expect(imageMeta(row?.meta)).toMatchObject({
      source: "generator_upload",
      mime: "image/png",
      originalName: "depth map.png",
      width: 640,
      height: 480,
    });

    // The run path reads inputs through this owner-scoped seam. The uploader
    // therefore produces exactly the same consumable shape as a picker choice,
    // while a second owner cannot confirm/read the asset by id.
    await expect(readOwnedImageBytes(result.imageId, ownerId)).resolves.toBeInstanceOf(Buffer);
    await expect(readOwnedImageBytes(result.imageId, otherOwnerId)).resolves.toBeNull();
  });

  it("imports Files bytes into the same owner-scoped image-id contract", async () => {
    const dataUrl = await testPngDataUrl(320, 240);
    const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const result = await importAdminFilesImageReference({
      userId: ownerId,
      buffer: Buffer.from(payload, "base64"),
      fileName: "reference.png",
      adminFilePath: "references/reference.png",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db().select().from(images).where(eq(images.id, result.imageId)).limit(1);
    expect(row).toMatchObject({
      ownerId,
      kind: "generator_output",
      status: "ready",
      entityKind: null,
      entityId: null,
      chatId: null,
      prompt: "Imported Files reference — reference.png",
    });
    expect(imageMeta(row?.meta)).toMatchObject({
      source: "admin_files_import",
      mime: "image/png",
      originalName: "reference.png",
      adminFilePath: "references/reference.png",
      width: 320,
      height: 240,
    });
    await expect(readOwnedImageBytes(result.imageId, ownerId)).resolves.toBeInstanceOf(Buffer);
    await expect(readOwnedImageBytes(result.imageId, otherOwnerId)).resolves.toBeNull();
  });

  it("refuses unsupported raster MIME data before creating an image row", async () => {
    const before = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId));
    const result = await uploadImageGeneratorReference({
      userId: ownerId,
      dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      fileName: "unsafe.svg",
    });
    expect(result).toEqual({ ok: false, error: "uploaded file is not a valid supported image" });
    const after = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId));
    expect(after).toHaveLength(before.length);
  });

  it("refuses corrupt Files bytes before creating a reusable image", async () => {
    const before = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId));
    const result = await importAdminFilesImageReference({
      userId: ownerId,
      buffer: Buffer.from("not an image"),
      fileName: "broken.png",
      adminFilePath: "broken.png",
    });
    expect(result.ok).toBe(false);
    const after = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId));
    expect(after).toHaveLength(before.length);
  });
});
