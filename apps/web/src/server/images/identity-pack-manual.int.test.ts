import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  IDENTITY_CROP_POLICY_V1,
  setIdentityFaceDetectorForTesting,
  type DetectedFaceCandidate,
} from "@vesper/image-core";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { characters, db, images } from "../db";
import { createImageAsset, saveImageBuffer, type ImageRow } from "./asset-storage";
import { ensureIdentityPack } from "./identity-pack-ensure";
import { saveManualIdentityCrop } from "./identity-pack-manual";
import { getIdentityPackForOwner } from "./identity-pack-read";
import { absoluteImagePath } from "./paths";
import { setIdentityIntrinsicPolicyForTesting } from "./identity-pack-store";

/**
 * The manual-crop floor and encode-time enlargement #667 adds:
 * `saveManualIdentityCrop` may now accept a square as small as
 * `IDENTITY_CROP_POLICY_V1.minimumManualOutputSidePx` (128 at v1), well under
 * the automatic policy's 256px floor, and stores it enlarged to that floor —
 * "a little softer, but framed on the face" (owner ruling 2026-10-01).
 *
 * What is under test here rather than in `identity-pack-lifecycle.int.test.ts`
 * (which owns the rest of `saveManualIdentityCrop`'s behavior): the NEW manual
 * floor specifically, the real encoded bytes an enlarged crop produces, and
 * that a crop under the manual floor is still refused — with a message naming
 * it, since the automatic floor's generic "that crop is too small" copy does
 * not.
 *
 * Self-skips when the database is unreachable, except under strict integration
 * mode (`pnpm test:int:strict`), where it fails.
 */

const ready = await probeIntegrationDb("identity pack manual.int.test", "image_identity_packs");

/** 3:4, big enough that a 128–255px manual square is comfortably inside it. */
const SOURCE_WIDTH = 768;
const SOURCE_HEIGHT = 1024;

let temp: TempDataRoot | undefined;
let userId = "";

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-identity-manual-int");
  userId = (await seedTestUser("identity-manual-int")).id;
});

afterEach(() => {
  setIdentityFaceDetectorForTesting(null);
  setIdentityIntrinsicPolicyForTesting(null);
});

afterAll(async () => {
  await temp?.cleanup();
  await purgeOwnerRows([userId]);
  await endTestPool();
});

interface Subject {
  characterId: string;
}

async function seedSubject(name: string): Promise<Subject> {
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: userId, name, profile: { bio: "manual-crop int subject" } })
    .returning({ id: characters.id });
  if (!character) throw new Error("failed to create the test character");
  const asset = await createImageAsset({
    ownerId: userId,
    kind: "avatar",
    entityKind: "character",
    entityId: character.id,
    prompt: "avatar",
  });
  const saved = await saveImageBuffer(asset.id, await testPngBuffer(SOURCE_WIDTH, SOURCE_HEIGHT));
  if (saved?.status !== "ready") throw new Error("failed to store the test portrait");
  await db()
    .update(characters)
    .set({ avatarImageId: saved.id, acceptedAvatarImageId: saved.id, acceptedAt: new Date() })
    .where(eq(characters.id, character.id));
  return { characterId: character.id };
}

/** No confident face: forces the heuristic path, which always clears 256px on
 * this 3:4 source, so the automatically-derived pack a manual save corrects
 * never itself hits the new floor. */
function noFaceDetector(): void {
  setIdentityFaceDetectorForTesting({ version: "scripted_v1", detect: async () => [] as DetectedFaceCandidate[] });
}

async function preparedSubject(name: string): Promise<Subject> {
  noFaceDetector();
  const subject = await seedSubject(name);
  const result = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });
  if (result.status !== "ready") throw new Error(`expected a ready automatic pack, got ${result.status}`);
  return subject;
}

async function editorState(characterId: string): Promise<{ packId: string; revision: number; hash: string }> {
  const summary = await getIdentityPackForOwner(characterId, userId);
  const pack = summary?.pack;
  if (!pack) throw new Error("expected a current pack");
  return { packId: pack.id, revision: pack.revision, hash: pack.source.contentHash };
}

async function imageRow(imageId: string): Promise<ImageRow> {
  const [row] = await db().select().from(images).where(eq(images.id, imageId));
  if (!row) throw new Error(`expected an images row for ${imageId}`);
  return row;
}

describe.skipIf(!ready)("saveManualIdentityCrop — the manual floor (#667)", () => {
  it("accepts a manual square between the manual and automatic floors, enlarged on encode", async () => {
    const subject = await preparedSubject("Manual Floor Subject");
    const editor = await editorState(subject.characterId);

    // 0.2 of 768 and 0.2 of 1024 both round to a 154px square — inside
    // [128, 256), comfortably below the old 256px floor.
    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.1, width: 0.2, height: 0.15 } },
      actorUserId: userId,
      reason: "zoomed in on the face",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.pack.derivation.method).toBe("manual");
    // The STORED crop is the owner's real rectangle, not the enlarged output —
    // it is still what every downstream reference-region calculation uses.
    expect(result.pack.faceDetail.crop).toEqual({ left: 77, top: 102, width: 154, height: 154 });
    expect(result.pack.faceDetail.crop?.width).toBeLessThan(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx);
    expect(result.pack.faceDetail.imageId).not.toBeNull();
    // `packRowToContract` must report the ENLARGED side here (256), not the raw
    // 154px crop — reporting the crop's own side would describe a file this
    // revision's bytes no longer match (identity-pack-store.ts, #667 follow-up).
    expect(result.pack.faceDetail.outputWidth).toBe(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx);
    expect(result.pack.faceDetail.outputHeight).toBe(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx);

    // The ENCODED bytes are enlarged to the automatic floor (256), not left at
    // the framed 154px — "a little softer, but framed on the face".
    if (!result.pack.faceDetail.imageId) throw new Error("expected a face-detail image id");
    const row = await imageRow(result.pack.faceDetail.imageId);
    const bytes = await fs.readFile(absoluteImagePath(row));
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx);
    expect(metadata.height).toBe(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx);
  });

  it("refuses a manual square under the manual floor, naming the minimum", async () => {
    const subject = await preparedSubject("Below Manual Floor Subject");
    const editor = await editorState(subject.characterId);

    // 0.1 of 768 and 0.1 of 1024 both round to a 77px/102px pair — squared down
    // to 77px, under the 128px manual floor.
    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.1, width: 0.1, height: 0.1 } },
      actorUserId: userId,
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("invalid_geometry");
    expect(result.code).toBe("crop_too_small");
    expect(result.message).toContain("below_minimum");
    expect(result.message).toContain(String(IDENTITY_CROP_POLICY_V1.minimumManualOutputSidePx));

    // A refused crop is not a broken character: the automatic pack is untouched.
    const summary = await getIdentityPackForOwner(subject.characterId, userId);
    expect(summary?.pack?.revision).toBe(editor.revision);
  });

  it("accepts a manual square exactly at the manual floor, still enlarged (128 < the automatic floor)", async () => {
    const subject = await preparedSubject("At Manual Floor Subject");
    const editor = await editorState(subject.characterId);

    // left/top/width/height chosen so the squared side lands exactly on 128.
    const side = IDENTITY_CROP_POLICY_V1.minimumManualOutputSidePx;
    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "source_pixels", crop: { left: 100, top: 100, width: side, height: side } },
      actorUserId: userId,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.pack.faceDetail.crop).toEqual({ left: 100, top: 100, width: side, height: side });
    // 128 is still below the automatic floor (256), so it is still enlarged —
    // only a crop AT OR ABOVE 256 would report its own side here.
    expect(result.pack.faceDetail.outputWidth).toBe(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx);
    expect(result.pack.faceDetail.outputHeight).toBe(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx);
  });

  it("reports a manual crop's OWN side when it is already at or above the automatic floor", async () => {
    const subject = await preparedSubject("Large Manual Crop Subject");
    const editor = await editorState(subject.characterId);

    // 300px, comfortably above the 256px automatic floor: `packRowToContract`
    // must take the same `identityCropOutputSide` branch a `manual` row always
    // took before #667 — no enlargement, no cap (below the 1024 ceiling).
    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "source_pixels", crop: { left: 50, top: 50, width: 300, height: 300 } },
      actorUserId: userId,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.pack.faceDetail.crop).toEqual({ left: 50, top: 50, width: 300, height: 300 });
    expect(result.pack.faceDetail.outputWidth).toBe(300);
    expect(result.pack.faceDetail.outputHeight).toBe(300);
  });
});
