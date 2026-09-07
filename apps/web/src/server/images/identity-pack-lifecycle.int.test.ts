import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  type DetectedFaceCandidate,
  type ImageIdentityPackV1,
  INTRINSIC_POLICY_V1,
  PROFILE_POLICY_DEFAULTS_V1,
  setIdentityFaceDetectorForTesting,
} from "@vesper/image-core";
import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { characters, db, imageIdentityPacks, images, jobs } from "../db";
import { absoluteImagePath } from "./paths";
import { createImageAsset, saveImageBuffer, type ImageKind, type ImageRow } from "./asset-storage";
import { evaluateIdentityPackForProfile, identityReferenceProvenanceFor } from "./identity-pack-references";
import { ensureIdentityPack, resolveSource } from "./identity-pack-ensure";
import {
  cleanupIdentityPackRevisions,
  deleteCharacterIdentityAssets,
  IDENTITY_PACK_REVISION_RETENTION_MS,
} from "./identity-pack-maintenance";
import { resetIdentityPackToAutomatic, saveManualIdentityCrop } from "./identity-pack-manual";
import { prepareIdentityPacksBatch } from "./identity-pack-preparation";
import { getIdentityPackForOwner } from "./identity-pack-read";
import { acceptPortrait, clearPortraitAcceptance } from "./portrait-acceptance";
import { setIdentityIntrinsicPolicyForTesting, type IdentityPackRow } from "./identity-pack-store";

/**
 * The deletion cases below drive the REAL route handlers, so the mocked identity
 * every `withUser` route reads has to exist in this file too. Nothing else here
 * touches auth: the service functions take an owner id directly.
 */
const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Identity Lifecycle Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { cloneToLibrary } from "@/server/api";

import { DELETE as portraitStudioDelete } from "@/app/api/characters/[id]/portraits/[imageId]/route";
import { DELETE as galleryDeleteOne } from "@/app/api/gallery/[id]/route";
import { POST as galleryDeleteBulk } from "@/app/api/gallery/delete/route";

/**
 * The identity-pack LIFECYCLE against a real database and a sandboxed DATA_ROOT:
 * manual correction, reset, retention cleanup, bounded batches, canonical-source
 * and character deletion, and profile-aware reference evaluation.
 *
 * Derivation itself (coalescing, the finalization race, `parseOr` degradation)
 * is covered by `identity-packs.int.test.ts`; this suite starts from a derived
 * pack and exercises what happens to it afterwards.
 *
 * The source-deletion cases are the one place this file calls ROUTE handlers
 * rather than the services beneath them, because the delete ordering they prove
 * is a property of the routes and their helpers together.
 *
 * Two seams make otherwise untestable rules reachable: an injected clock for the
 * retention window (nobody waits a week) and an injected intrinsic policy for the
 * blur/occlusion thresholds policy_v1 deliberately leaves unarmed (without it the
 * admin-override path could not run at all before the trial calibrates numbers).
 *
 * Self-skips when the database is unreachable, except under strict integration
 * mode (`pnpm test:int:strict`), where it fails.
 */

const ready = await probeIntegrationDb("identity pack lifecycle.int.test", "image_identity_packs");

/** 3:4, and large enough that a heuristic crop clears the 256px floor. */
const SOURCE_WIDTH = 384;
const SOURCE_HEIGHT = 512;

/** Expands to a 294px square wholly inside the portrait — the clean detector case. */
const FACE_BOX = { left: 132, top: 100, width: 120, height: 140 };

let temp: TempDataRoot | undefined;
let userId = "";

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-identity-lifecycle-int");
  const user = await seedTestUser("identity-lifecycle-int");
  bindAuthUser(authState, user);
  userId = user.id;
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
  portraitId: string;
}

async function storeImage(characterId: string, kind: ImageKind, buffer: Buffer): Promise<ImageRow> {
  const asset = await createImageAsset({
    ownerId: userId,
    kind,
    entityKind: "character",
    entityId: characterId,
    prompt: kind,
  });
  const saved = await saveImageBuffer(asset.id, buffer);
  if (saved?.status !== "ready") throw new Error(`failed to store a ${kind} test image`);
  return saved;
}

/**
 * A character whose portrait pointers are written directly — candidate AND
 * accepted, the state a portrait the owner accepted leaves behind — so no
 * trigger fires.
 *
 * `kind` exists for the Gallery cases: those routes are guarded to
 * `GALLERY_IMAGE_KINDS`, which excludes `avatar`, so the canonical portrait a
 * Gallery delete can actually reach is the promoted `portrait_variant` it would
 * be in life (`promoteVariant` moves the pointer without changing the kind).
 */
async function seedSubject(
  name: string,
  width = SOURCE_WIDTH,
  height = SOURCE_HEIGHT,
  kind: ImageKind = "avatar",
): Promise<Subject> {
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: userId, name, profile: { bio: "lifecycle subject" } })
    .returning({ id: characters.id });
  if (!character) throw new Error("failed to create the test character");
  const portrait = await storeImage(character.id, kind, await testPngBuffer(width, height));
  await db()
    .update(characters)
    .set({ avatarImageId: portrait.id, acceptedAvatarImageId: portrait.id, acceptedAt: new Date() })
    .where(eq(characters.id, character.id));
  return { characterId: character.id, portraitId: portrait.id };
}

function scriptedDetector(candidates: DetectedFaceCandidate[]): void {
  setIdentityFaceDetectorForTesting({ version: "scripted_v1", detect: async () => candidates });
}

async function packRows(characterId: string): Promise<IdentityPackRow[]> {
  return db()
    .select()
    .from(imageIdentityPacks)
    .where(eq(imageIdentityPacks.characterId, characterId))
    .orderBy(asc(imageIdentityPacks.revision));
}

async function cropRows(characterId: string): Promise<ImageRow[]> {
  return db()
    .select()
    .from(images)
    .where(
      and(eq(images.entityKind, "character"), eq(images.entityId, characterId), eq(images.kind, "identity_face_crop")),
    );
}

/** What a crop editor would hold: the pack it opened on and the bytes it framed. */
async function editorState(characterId: string): Promise<{ packId: string; revision: number; hash: string }> {
  const summary = await getIdentityPackForOwner(characterId, userId);
  const pack = summary?.pack;
  if (!pack) throw new Error("expected a current pack");
  return { packId: pack.id, revision: pack.revision, hash: pack.source.contentHash };
}

/** A derived, ready pack to start from. */
async function preparedSubject(name: string, kind: ImageKind = "avatar"): Promise<Subject> {
  const subject = await seedSubject(name, SOURCE_WIDTH, SOURCE_HEIGHT, kind);
  const result = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });
  if (result.status !== "ready") throw new Error(`expected a ready pack, got ${result.status}`);
  return subject;
}

describe.skipIf(!ready)("saveManualIdentityCrop", () => {
  it("promotes a manual revision and supersedes the automatic one", async () => {
    const subject = await preparedSubject("Manual Crop Subject");
    const editor = await editorState(subject.characterId);

    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      // 0.8 × 384 and 0.6 × 512 both round to 307: a square the client framed.
      crop: { space: "normalized", crop: { left: 0.1, top: 0.05, width: 0.8, height: 0.6 } },
      actorUserId: userId,
      reason: "the automatic crop cut the hairline",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.pack.revision).toBe(2);
    expect(result.pack.derivation.method).toBe("manual");
    // A human crop names no detector and claims no confidence.
    expect(result.pack.derivation.detectorVersion).toBeNull();
    expect(result.pack.derivation.confidence).toBeNull();
    expect(result.pack.faceDetail.crop).toEqual({ left: 38, top: 26, width: 307, height: 307 });
    expect(result.pack.review.actorUserId).toBe(userId);
    expect(result.pack.review.reason).toBe("the automatic crop cut the hairline");
    expect(result.pack.review.reviewedAt).not.toBeNull();
    // No detector examined this rectangle, so face metrics are unknown, not zero.
    expect(result.pack.quality?.faceBox).toBeNull();
    expect(result.pack.quality?.detectedFaces).toBeNull();
    expect(typeof result.pack.quality?.blurScore).toBe("number");

    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(2);
    // Same bytes, a deliberate redo: `superseded`, not `stale`.
    expect(rows[0]?.status).toBe("superseded");
    expect(rows[0]?.current).toBe(false);
    expect(rows[1]?.current).toBe(true);
    // The old crop survives the promotion — cleanup owns its removal, not this path.
    expect(await cropRows(subject.characterId)).toHaveLength(2);
  });

  it("snaps a rectangle that is only off by rounding, and stores source pixels", async () => {
    const subject = await preparedSubject("Snap Subject");
    const editor = await editorState(subject.characterId);

    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "source_pixels", crop: { left: 40, top: 30, width: 300, height: 301 } },
      actorUserId: userId,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.pack.faceDetail.crop).toEqual({ left: 40, top: 31, width: 300, height: 300 });
    expect(result.pack.review.reason).toBeNull();
  });

  it("refuses a stale editor by pack revision without touching the current pack", async () => {
    const subject = await preparedSubject("Stale Revision Subject");
    const editor = await editorState(subject.characterId);

    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision + 7,
      expectedSourceHash: editor.hash,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.05, width: 0.8, height: 0.6 } },
      actorUserId: userId,
    });

    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.reason).toBe("pack_changed");
    // The client is told what to reload to, never left guessing.
    expect(result.currentPackId).toBe(editor.packId);
    expect(result.currentRevision).toBe(editor.revision);
    expect(result.sourceContentHash).toBe(editor.hash);
    expect(await packRows(subject.characterId)).toHaveLength(1);
  });

  it("refuses to apply old coordinates to new bytes", async () => {
    const subject = await preparedSubject("Stale Bytes Subject");
    const editor = await editorState(subject.characterId);
    const sink = new DiagnosticCollector();

    // The portrait is replaced in place — same row, same id, different pixels.
    const repainted = await sharp({
      create: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3, background: { r: 12, g: 200, b: 90 } },
    })
      .png()
      .toBuffer();
    await saveImageBuffer(subject.portraitId, repainted);

    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.05, width: 0.8, height: 0.6 } },
      actorUserId: userId,
      sink,
    });

    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.reason).toBe("source_changed");
    expect(result.sourceContentHash).not.toBe(editor.hash);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.source_changed");
    expect(await packRows(subject.characterId)).toHaveLength(1);
  });

  it("rejects an owner crop that fails the hard geometry checks, with the measured reason", async () => {
    const subject = await preparedSubject("Tiny Crop Subject");
    const editor = await editorState(subject.characterId);
    const request = {
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      actorUserId: userId,
    };

    // 0.5 × 384 = 192, below the 256px floor.
    const tooSmall = await saveManualIdentityCrop({
      ...request,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.1, width: 0.5, height: 0.375 } },
    });
    expect(tooSmall.status).toBe("rejected");
    if (tooSmall.status !== "rejected") return;
    expect(tooSmall.reason).toBe("invalid_geometry");
    expect(tooSmall.code).toBe("crop_too_small");
    expect(tooSmall.message).toContain("below_minimum");

    const outOfBounds = await saveManualIdentityCrop({
      ...request,
      crop: { space: "source_pixels", crop: { left: 300, top: 400, width: 300, height: 300 } },
    });
    expect(outOfBounds.status).toBe("rejected");
    if (outOfBounds.status !== "rejected") return;
    expect(outOfBounds.code).toBe("invalid_crop");
    expect(outOfBounds.message).toContain("out_of_bounds");

    // A refused crop is not a broken character: the previous pack is untouched.
    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.current).toBe(true);
  });

  it("records actor, reason, warning and waived blockers for an admin override", async () => {
    const subject = await preparedSubject("Override Subject");
    const editor = await editorState(subject.characterId);
    // Arm a threshold no real crop can clear, so there is something to waive.
    setIdentityIntrinsicPolicyForTesting({ ...INTRINSIC_POLICY_V1, blurBlockThreshold: Number.MAX_SAFE_INTEGER });
    const request = {
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "normalized" as const, crop: { left: 0.1, top: 0.05, width: 0.8, height: 0.6 } },
      actorUserId: userId,
    };

    const blocked = await saveManualIdentityCrop(request);
    expect(blocked.status).toBe("rejected");
    if (blocked.status !== "rejected") return;
    expect(blocked.reason).toBe("policy_blocked");
    expect(blocked.blockers).toContain("no_usable_face");

    const noReason = await saveManualIdentityCrop({ ...request, adminOverride: true, reason: "   " });
    expect(noReason.status).toBe("rejected");
    if (noReason.status !== "rejected") return;
    expect(noReason.reason).toBe("override_reason_required");

    const sink = new DiagnosticCollector();
    const overridden = await saveManualIdentityCrop({
      ...request,
      adminOverride: true,
      reason: "trial cell 4: reviewed by hand",
      sink,
    });

    expect(overridden.status).toBe("ready");
    if (overridden.status !== "ready") return;
    expect(overridden.pack.warningCodes).toContain("manual_admin_override");
    expect(overridden.pack.review.actorUserId).toBe(userId);
    expect(overridden.pack.review.reason).toBe("trial cell 4: reviewed by hand");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.manual_override");

    const rows = await packRows(subject.characterId);
    // The override does not change the measurements; what it WAIVED is on the row.
    expect(rows[1]?.failureMessage).toContain("no_usable_face");
    expect(rows[1]?.status).toBe("ready");
  });

  it("does not stamp an override warning on a crop that needed none", async () => {
    const subject = await preparedSubject("Unneeded Override Subject");
    const editor = await editorState(subject.characterId);

    const result = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.05, width: 0.8, height: 0.6 } },
      actorUserId: userId,
      adminOverride: true,
      reason: "belt and braces",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // `manual_admin_override` disqualifies a pack for profiles that forbid
    // overrides — stamping it on an ordinary crop would be a silent penalty.
    expect(result.pack.warningCodes).not.toContain("manual_admin_override");
  });
});

describe.skipIf(!ready)("resetIdentityPackToAutomatic", () => {
  it("re-derives against the current source and supersedes the manual revision", async () => {
    const subject = await preparedSubject("Reset Subject");
    const editor = await editorState(subject.characterId);
    const manual = await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.05, width: 0.8, height: 0.6 } },
      actorUserId: userId,
    });
    expect(manual.status).toBe("ready");

    const reset = await resetIdentityPackToAutomatic({
      ownerId: userId,
      characterId: subject.characterId,
      actorUserId: userId,
    });

    expect(reset.status).toBe("ready");
    if (reset.status !== "ready") return;
    expect(reset.pack.revision).toBe(3);
    // A NEW automatic revision under today's derivation version — never the old
    // detector row resurrected.
    expect(reset.pack.derivation.method).toBe("heuristic");
    expect(reset.pack.review.actorUserId).toBeNull();

    const rows = await packRows(subject.characterId);
    expect(rows.map((row) => row.status)).toEqual(["superseded", "superseded", "ready"]);
    expect(rows[2]?.current).toBe(true);
  });
});

describe.skipIf(!ready)("cleanupIdentityPackRevisions", () => {
  it("removes retired crops past the window and keeps the current and the recent ones", async () => {
    const subject = await preparedSubject("Cleanup Subject");
    const editor = await editorState(subject.characterId);
    await saveManualIdentityCrop({
      ownerId: userId,
      characterId: subject.characterId,
      expectedPackId: editor.packId,
      expectedRevision: editor.revision,
      expectedSourceHash: editor.hash,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.05, width: 0.8, height: 0.6 } },
      actorUserId: userId,
    });

    const before = await packRows(subject.characterId);
    const retired = before[0];
    const current = before[1];
    if (!retired || !current) throw new Error("expected two revisions");
    const currentCropId = current.faceCropImageId;
    const retiredCrop = (await cropRows(subject.characterId)).find((row) => row.id === retired.faceCropImageId);
    if (!retiredCrop) throw new Error("expected the superseded revision to still hold its crop");

    // Inside the window: nothing goes yet.
    const early = await cleanupIdentityPackRevisions({ now: new Date() });
    expect(early.cropsDeleted).toBe(0);
    expect(await cropRows(subject.characterId)).toHaveLength(2);

    // Age the superseded revision past the diagnostic window.
    await db()
      .update(imageIdentityPacks)
      .set({ updatedAt: new Date(Date.now() - 9 * 24 * 60 * 60_000) })
      .where(eq(imageIdentityPacks.id, retired.id));

    const result = await cleanupIdentityPackRevisions({ now: new Date() });
    expect(result.cropsDeleted).toBe(1);
    expect(result.cropsAlreadyGone).toBe(0);

    const remaining = await cropRows(subject.characterId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(currentCropId);
    // Row AND file: a retained file with no row is exactly what the sweep would
    // have to puzzle over later.
    await expect(fs.access(absoluteImagePath(retiredCrop))).rejects.toThrow();

    // The pack row itself is retained for audit; only the bytes went.
    const after = await packRows(subject.characterId);
    expect(after).toHaveLength(2);
    expect(after[0]?.faceCropImageId).toBeNull();
    expect(after[1]?.faceCropImageId).toBe(currentCropId);

    // Idempotent: a second pass finds nothing left to do.
    const again = await cleanupIdentityPackRevisions({ now: new Date() });
    expect(again.cropsDeleted).toBe(0);
  });

  it("retires a reservation abandoned by a dead process", async () => {
    const subject = await preparedSubject("Abandoned Reservation Subject");
    // Simulate the deploy-mid-derivation case: a `pending` row older than the job
    // staleness bound, still marked current.
    await db()
      .update(imageIdentityPacks)
      .set({ status: "pending", createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(imageIdentityPacks.characterId, subject.characterId));

    const result = await cleanupIdentityPackRevisions({ now: new Date() });
    expect(result.pendingRetired).toBeGreaterThanOrEqual(1);

    const rows = await packRows(subject.characterId);
    expect(rows[0]?.status).toBe("stale");
    // Cleared as well as retired: a current terminal row cannot be retired by the
    // next reservation, which would wedge this character permanently.
    expect(rows[0]?.current).toBe(false);
  });
});

describe.skipIf(!ready)("canonical source deletion", () => {
  /**
   * What must hold after ANY of the three user-facing deletes takes a character's
   * canonical portrait.
   *
   * The routes are driven rather than the helpers underneath them because the
   * ordering rule is split across both layers — `purgeImagesWhere` owns it for the
   * Gallery paths, the portrait studio repeats it around its own delete — and a
   * test of the helpers alone would keep passing while a route reintroduced the
   * bug this covers: invalidating AFTER the delete, when the set-null foreign key
   * has already erased the only column the pack could be matched on, leaving a
   * `current`, `ready` revision over bytes that are gone.
   */
  async function expectSourceRetired(subject: Subject): Promise<void> {
    const [character] = await db()
      .select({
        avatarImageId: characters.avatarImageId,
        acceptedAvatarImageId: characters.acceptedAvatarImageId,
        acceptedAt: characters.acceptedAt,
      })
      .from(characters)
      .where(eq(characters.id, subject.characterId));
    expect(character?.avatarImageId).toBeNull();
    // Deleting the ACCEPTED portrait leaves the character with no identity
    // source, and no acceptance time standing over nothing.
    expect(character?.acceptedAvatarImageId).toBeNull();
    expect(character?.acceptedAt).toBeNull();

    const [portrait] = await db().select({ id: images.id }).from(images).where(eq(images.id, subject.portraitId));
    expect(portrait).toBeUndefined();

    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.current).toBe(false);
    expect(rows[0]?.status).toBe("stale");
    // Null through the foreign key, AFTER the invalidation had already matched on it.
    expect(rows[0]?.sourceImageId).toBeNull();

    // No current revision at all, so the panel has nothing to offer and nothing
    // to claim: not a ready pack over a source the owner no longer has.
    const summary = await getIdentityPackForOwner(subject.characterId, userId);
    expect(summary).not.toBeNull();
    expect(summary?.pack).toBeNull();
    expect(summary?.sourceImageId).toBeNull();

    const sink = new DiagnosticCollector();
    const evaluated = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "canonical_then_face_detail",
      sink,
    });
    expect(evaluated.eligible).toBe(false);
    if (evaluated.eligible) return;
    // Actionable: "this character has no portrait", not "the profile said no".
    expect(evaluated.code).toBe("source_missing");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.source_missing");
  }

  const galleryDeletePath = (imageId: string) => `/api/gallery/${imageId}`;

  /** Row AND file: a retained file with no row is what the image sweep has to puzzle over. */
  async function expectCropReclaimed(subject: Subject, crop: ImageRow): Promise<void> {
    const reclaimed = await cleanupIdentityPackRevisions({
      now: new Date(Date.now() + IDENTITY_PACK_REVISION_RETENTION_MS + 60_000),
    });
    expect(reclaimed.cropsDeleted).toBeGreaterThanOrEqual(1);
    expect(await cropRows(subject.characterId)).toHaveLength(0);
    await expect(fs.access(absoluteImagePath(crop))).rejects.toThrow();
  }

  it("retires the pack when the Gallery deletes the canonical portrait", async () => {
    const subject = await preparedSubject("Gallery Delete Subject", "portrait_variant");

    const res = await galleryDeleteOne(
      apiRequest(galleryDeletePath(subject.portraitId), { method: "DELETE" }),
      routeCtx({ id: subject.portraitId }),
    );

    expect(res.status).toBe(200);
    await expectSourceRetired(subject);
  });

  it("retires the pack when the Gallery's bulk delete takes the canonical portrait", async () => {
    const subject = await preparedSubject("Gallery Bulk Delete Subject", "portrait_variant");

    const res = await galleryDeleteBulk(
      apiRequest("/api/gallery/delete", { body: { ids: [subject.portraitId] } }),
      routeCtx(),
    );

    expect((await expectJson<{ deleted: number }>(res, 200)).deleted).toBe(1);
    await expectSourceRetired(subject);
  });

  it("retires the pack when the portrait studio deletes the canonical portrait", async () => {
    const subject = await preparedSubject("Portrait Studio Delete Subject");

    const res = await portraitStudioDelete(
      apiRequest(`/api/characters/${subject.characterId}/portraits/${subject.portraitId}`, { method: "DELETE" }),
      routeCtx({ id: subject.characterId, imageId: subject.portraitId }),
    );

    expect(res.status).toBe(200);
    await expectSourceRetired(subject);
  });

  it("reclaims the orphaned hidden crop once the retention window has elapsed", async () => {
    const subject = await preparedSubject("Reclaimed Crop Subject", "portrait_variant");
    const [crop] = await cropRows(subject.characterId);
    if (!crop) throw new Error("expected the prepared pack to hold a hidden crop");

    const res = await galleryDeleteOne(
      apiRequest(galleryDeletePath(subject.portraitId), { method: "DELETE" }),
      routeCtx({ id: subject.portraitId }),
    );
    expect(res.status).toBe(200);
    // Inside the window the crop is still evidence — "why did my character's face
    // change last Tuesday?" is answerable for a week.
    expect(await cropRows(subject.characterId)).toHaveLength(1);

    await expectCropReclaimed(subject, crop);
  });

  it("degrades, retires and reclaims a revision whose source vanished behind the routes' back", async () => {
    const subject = await preparedSubject("Bypassed Delete Subject");
    const [crop] = await cropRows(subject.characterId);
    if (!crop) throw new Error("expected the prepared pack to hold a hidden crop");

    // Straight at the tables, the way a restored dump or a hand-run statement
    // arrives: the portrait row goes and the soft avatar pointer is cleared, the
    // foreign key nulls the pack's source — and nothing retires the revision, so
    // it is left exactly as the old delete ordering used to leave it.
    await db()
      .update(characters)
      .set({ avatarImageId: null, acceptedAvatarImageId: null, acceptedAt: null })
      .where(eq(characters.id, subject.characterId));
    await db().delete(images).where(eq(images.id, subject.portraitId));
    const bypassed = await packRows(subject.characterId);
    expect(bypassed[0]?.current).toBe(true);
    expect(bypassed[0]?.status).toBe("ready");
    expect(bypassed[0]?.sourceImageId).toBeNull();

    // The read seam refuses it anyway: the row still says ready, no reader does.
    const summarySink = new DiagnosticCollector();
    const summary = await getIdentityPackForOwner(subject.characterId, userId, summarySink);
    expect(summary?.pack?.status).toBe("unusable");
    expect(summary?.pack?.failureCode).toBe("source_missing");
    expect(summary?.stale).toBe(true);
    expect(summary?.pending).toBe(false);
    expect(summarySink.items.map((d) => d.code)).toContain("images.identity_pack.source_missing");
    // A projection, not a repair: the stored row is untouched by the read.
    const afterRead = await packRows(subject.characterId);
    expect(afterRead[0]?.status).toBe("ready");
    expect(afterRead[0]?.current).toBe(true);

    const evaluated = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "face_detail_only",
    });
    expect(evaluated.eligible).toBe(false);
    if (evaluated.eligible) return;
    expect(evaluated.code).toBe("source_missing");

    // Cleanup is what actually retires it — the only pass that can, since the
    // retention pass takes retired rows and the orphan pass takes unclaimed crops.
    const cleanupSink = new DiagnosticCollector();
    const retired = await cleanupIdentityPackRevisions({ now: new Date(), sink: cleanupSink });
    expect(retired.sourcelessRetired).toBeGreaterThanOrEqual(1);
    expect(cleanupSink.items.map((d) => d.code)).toContain("images.identity_pack.source_missing");
    const settled = await packRows(subject.characterId);
    expect(settled[0]?.current).toBe(false);
    expect(settled[0]?.status).toBe("stale");

    // Retired, the crop ages out through the ordinary window like any other.
    await expectCropReclaimed(subject, crop);
  });
});

/**
 * Portrait ACCEPTANCE — the decision that turns a portrait into the character's
 * identity source (docs/images/identity-packs.md §The source is the ACCEPTED
 * portrait).
 *
 * These cases kill the implementation this feature replaced, where the identity
 * pack followed `avatar_image_id`: there, a newly generated or promoted portrait
 * silently invalidated a working reference, a stale Accept would have moved the
 * source to whatever was current, and a clone arrived with somebody else's face
 * already adopted.
 */
describe.skipIf(!ready)("portrait acceptance", () => {
  /** The preparation jobs one character's acceptances left behind. */
  async function packJobs(characterId: string): Promise<{ id: string; status: string }[]> {
    return db()
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.type, "identity_pack"), sql`${jobs.payload} ->> 'characterId' = ${characterId}`));
  }

  /**
   * Preparation is fire-and-forget, so the row it inserts and settles is what a
   * caller can observe. Polls rather than sleeps: the derivation is local work on
   * a small PNG and normally lands in a few milliseconds.
   */
  async function settledPackJob(characterId: string): Promise<{ id: string; status: string }> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [row] = await packJobs(characterId);
      if (row && row.status !== "running") return row;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the acceptance never settled an identity_pack job");
  }

  /** A character showing a portrait it has NOT accepted — the state every writer leaves. */
  async function candidateSubject(name: string): Promise<Subject> {
    const subject = await seedSubject(name);
    await clearPortraitAcceptance(subject.characterId, userId);
    return subject;
  }

  async function pointers(characterId: string): Promise<{ avatarImageId: string | null; acceptedAvatarImageId: string | null }> {
    const [row] = await db()
      .select({ avatarImageId: characters.avatarImageId, acceptedAvatarImageId: characters.acceptedAvatarImageId })
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    if (!row) throw new Error("the subject character vanished");
    return row;
  }

  it("accepting the candidate derives its pack, and accepting it again does nothing", async () => {
    const subject = await candidateSubject("Accept Subject");

    const accepted = await acceptPortrait({
      ownerId: userId,
      characterId: subject.characterId,
      imageId: subject.portraitId,
    });
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;
    expect(accepted.acceptance).toMatchObject({ acceptedImageId: subject.portraitId, isCurrent: true });
    expect(accepted.acceptance.acceptedAt).not.toBeNull();

    expect((await settledPackJob(subject.characterId)).status).toBe("done");
    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.current).toBe(true);
    expect(rows[0]?.status).toBe("ready");
    // Derived from the ACCEPTED bytes, which is the whole claim.
    expect(rows[0]?.sourceImageId).toBe(subject.portraitId);

    // The same portrait again: no write, no second job, no second revision.
    const again = await acceptPortrait({
      ownerId: userId,
      characterId: subject.characterId,
      imageId: subject.portraitId,
    });
    expect(again.status).toBe("unchanged");
    expect(await packJobs(subject.characterId)).toHaveLength(1);
    expect(await packRows(subject.characterId)).toHaveLength(1);
  });

  it("a stale accept cannot move the identity source to the portrait that replaced it", async () => {
    const subject = await seedSubject("Stale Accept Subject");
    const replacement = await storeImage(subject.characterId, "avatar", await testPngBuffer(SOURCE_WIDTH, SOURCE_HEIGHT));
    // A promotion, as the studio performs it: the candidate moves, acceptance does not.
    await db()
      .update(characters)
      .set({ avatarImageId: replacement.id })
      .where(eq(characters.id, subject.characterId));

    // The request still names the portrait the owner was looking at.
    const conflict = await acceptPortrait({
      ownerId: userId,
      characterId: subject.characterId,
      imageId: subject.portraitId,
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") return;
    // What the studio re-renders from: still the old portrait, and no longer current.
    expect(conflict.acceptance).toMatchObject({ acceptedImageId: subject.portraitId, isCurrent: false });
    expect(await pointers(subject.characterId)).toEqual({
      avatarImageId: replacement.id,
      acceptedAvatarImageId: subject.portraitId,
    });
    expect(await packJobs(subject.characterId)).toHaveLength(0);
  });

  it("an unaccepted candidate leaves the accepted pack current, usable and resolvable", async () => {
    const subject = await preparedSubject("Unaccepted Candidate Subject");
    const candidate = await storeImage(subject.characterId, "avatar", await testPngBuffer(SOURCE_WIDTH, SOURCE_HEIGHT));
    await db().update(characters).set({ avatarImageId: candidate.id }).where(eq(characters.id, subject.characterId));

    const summary = await getIdentityPackForOwner(subject.characterId, userId);
    expect(summary?.current).toBe(true);
    // Not stale: a candidate nobody accepted describes nothing about this pack.
    expect(summary?.stale).toBe(false);
    expect(summary?.sourceImageId).toBe(subject.portraitId);

    const resolved = await resolveSource(userId, subject.characterId, undefined);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source.imageRow.id).toBe(subject.portraitId);
  });

  it("deleting an unaccepted candidate leaves the acceptance and its pack alone", async () => {
    const subject = await preparedSubject("Candidate Delete Subject");
    const candidate = await storeImage(subject.characterId, "avatar", await testPngBuffer(SOURCE_WIDTH, SOURCE_HEIGHT));
    await db().update(characters).set({ avatarImageId: candidate.id }).where(eq(characters.id, subject.characterId));

    const res = await portraitStudioDelete(
      apiRequest(`/api/characters/${subject.characterId}/portraits/${candidate.id}`, { method: "DELETE" }),
      routeCtx({ id: subject.characterId, imageId: candidate.id }),
    );
    expect(res.status).toBe(200);

    // The candidate pointer went with the row it named; the identity source did not.
    expect(await pointers(subject.characterId)).toEqual({
      avatarImageId: null,
      acceptedAvatarImageId: subject.portraitId,
    });
    const rows = await packRows(subject.characterId);
    expect(rows[0]?.current).toBe(true);
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.sourceImageId).toBe(subject.portraitId);
  });

  it("a clone copies the portrait as an unaccepted candidate and prepares nothing", async () => {
    const subject = await preparedSubject("Clone Source Subject");

    const clone = await cloneToLibrary("character", subject.characterId, userId);
    expect(clone.ok).toBe(true);
    if (!clone.ok) return;

    const copy = await pointers(clone.id);
    // The picture came across; the decision that it IS this character did not.
    expect(copy.avatarImageId).not.toBeNull();
    expect(copy.avatarImageId).not.toBe(subject.portraitId);
    expect(copy.acceptedAvatarImageId).toBeNull();
    expect(await packJobs(clone.id)).toHaveLength(0);
    expect(await packRows(clone.id)).toHaveLength(0);
  });
});

describe.skipIf(!ready)("prepareIdentityPacksBatch", () => {
  it("reports what a dry run would do without deriving anything", async () => {
    const prepared = await preparedSubject("Batch Prepared");
    const unprepared = await seedSubject("Batch Unprepared");

    const result = await prepareIdentityPacksBatch({
      ownerId: userId,
      characterIds: [prepared.characterId, unprepared.characterId, "no-such-character"],
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(true);
    expect(result.requested).toBe(3);
    expect(result.counts).toEqual({ ready: 0, blocked: 0, notFound: 1, wouldPrepare: 1, upToDate: 1 });
    expect(await packRows(unprepared.characterId)).toHaveLength(0);
  });

  it("prepares the real thing and reports per-character outcomes", async () => {
    const usable = await seedSubject("Batch Usable");
    // Landscape: the heuristic is not eligible, so this one fails closed.
    const unusable = await seedSubject("Batch Landscape", 512, 384);
    const result = await prepareIdentityPacksBatch({
      ownerId: userId,
      characterIds: [usable.characterId, unusable.characterId],
      dryRun: false,
      concurrency: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts.ready).toBe(1);
    expect(result.counts.blocked).toBe(1);
    const blocked = result.results.find((row) => row.characterId === unusable.characterId);
    expect(blocked?.outcome).toBe("blocked");
    if (blocked?.outcome !== "blocked") return;
    expect(blocked.code).toBe("no_usable_face");
    expect(await packRows(usable.characterId)).toHaveLength(1);
  });

  it("refuses an unknown corpus, an empty selection, and an oversized batch", async () => {
    const unknown = await prepareIdentityPacksBatch({ ownerId: userId, corpusId: "trial_v1", dryRun: true });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe("unknown_corpus");

    const empty = await prepareIdentityPacksBatch({ ownerId: userId, characterIds: [], dryRun: true });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.code).toBe("empty_selection");

    // The cap refuses rather than truncating: a report of 200 for a request of
    // 201 would read as complete.
    const tooMany = await prepareIdentityPacksBatch({
      ownerId: userId,
      characterIds: Array.from({ length: 201 }, (_, index) => `batch-character-${index}`),
      dryRun: true,
    });
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.code).toBe("too_many");

    const overRequestedCap = await prepareIdentityPacksBatch({
      ownerId: userId,
      characterIds: ["a", "b"],
      maxCount: 1,
      dryRun: true,
    });
    expect(overRequestedCap.ok).toBe(false);
    if (overRequestedCap.ok) return;
    expect(overRequestedCap.code).toBe("too_many");
  });
});

describe.skipIf(!ready)("character deletion", () => {
  it("takes the pack rows and hidden crops while a Gallery portrait survives", async () => {
    const subject = await preparedSubject("Deleted Subject");
    const variant = await storeImage(subject.characterId, "portrait_variant", await testPngBuffer(256, 256));
    expect(await cropRows(subject.characterId)).toHaveLength(1);

    // The route's order: the character row goes (packs cascade with it), then the
    // hidden assets are named explicitly — the shape that keeps working once the
    // data-lifecycle plan stops deleting a character's Gallery images.
    await db().delete(characters).where(eq(characters.id, subject.characterId));
    const removed = await deleteCharacterIdentityAssets(subject.characterId, userId);

    expect(removed).toBe(1);
    expect(await packRows(subject.characterId)).toHaveLength(0);
    expect(await cropRows(subject.characterId)).toHaveLength(0);

    const [survivor] = await db().select().from(images).where(eq(images.id, variant.id));
    expect(survivor?.id).toBe(variant.id);
  });
});

describe.skipIf(!ready)("evaluateIdentityPackForProfile", () => {
  /** A pack with a real face box, so effective-size arithmetic has something to scale. */
  async function detectorSubject(name: string): Promise<Subject> {
    const subject = await seedSubject(name);
    scriptedDetector([{ box: FACE_BOX, confidence: 0.95 }]);
    const result = await ensureIdentityPack({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "background",
    });
    if (result.status !== "ready") throw new Error("expected a detector pack");
    return subject;
  }

  it("emits the roles each strategy declares, in send order", async () => {
    const subject = await detectorSubject("Strategy Subject");
    const base = {
      ownerId: userId,
      characterId: subject.characterId,
      effectiveReferenceSize: { widthPx: 512, heightPx: 512 },
    };

    const canonicalOnly = await evaluateIdentityPackForProfile({ ...base, strategy: "canonical_only" });
    expect(canonicalOnly.eligible).toBe(true);
    if (!canonicalOnly.eligible) return;
    expect(canonicalOnly.candidates.map((c) => c.role)).toEqual(["canonical_identity"]);
    expect(canonicalOnly.candidates[0]?.required).toBe(true);
    // Never bytes — ids and measurements only.
    expect(canonicalOnly.candidates[0]?.imageId).toBe(subject.portraitId);

    const faceOnly = await evaluateIdentityPackForProfile({ ...base, strategy: "face_detail_only" });
    expect(faceOnly.eligible).toBe(true);
    if (!faceOnly.eligible) return;
    expect(faceOnly.candidates.map((c) => c.role)).toEqual(["face_detail"]);
    expect(faceOnly.candidates[0]?.required).toBe(true);
    expect(faceOnly.candidates[0]?.imageId).not.toBe(subject.portraitId);

    const both = await evaluateIdentityPackForProfile({ ...base, strategy: "canonical_then_face_detail" });
    expect(both.eligible).toBe(true);
    if (!both.eligible) return;
    expect(both.candidates.map((c) => c.role)).toEqual(["canonical_identity", "face_detail"]);
    expect(both.candidates.map((c) => c.required)).toEqual([true, false]);

    const reversed = await evaluateIdentityPackForProfile({ ...base, strategy: "face_detail_then_canonical" });
    expect(reversed.eligible).toBe(true);
    if (!reversed.eligible) return;
    expect(reversed.candidates.map((c) => c.role)).toEqual(["face_detail", "canonical_identity"]);
    // The canonical identity stays required wherever it appears: a profile never
    // ejects the identity to fit the enhancement.
    expect(reversed.candidates.map((c) => c.required)).toEqual([false, true]);
  });

  it("scales the stored face box into the pixels the provider will actually see", async () => {
    const subject = await detectorSubject("Effective Size Subject");

    const result = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "face_detail_only",
      effectiveReferenceSize: { widthPx: 512, heightPx: 512 },
    });

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    const evaluation = result.candidates[0]?.evaluation;
    expect(evaluation?.effectiveReferenceWidthPx).toBe(512);
    // 120px face inside a 294px crop, resized to 512 ⇒ 209px of real face.
    expect(evaluation?.effectiveFaceWidthPx).toBe(209);
    expect(evaluation?.effectiveFaceHeightPx).toBe(244);
    expect(evaluation?.policyVersion).toBe("policy_v1");
  });

  it("omits an optional face detail that would arrive too small, and keeps the canonical role", async () => {
    const subject = await detectorSubject("Small Face Subject");
    const sink = new DiagnosticCollector();

    const result = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "canonical_then_face_detail",
      effectiveReferenceSize: { widthPx: 128, heightPx: 128 },
      sink,
    });

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.candidates.map((c) => c.role)).toEqual(["canonical_identity"]);
    expect(result.warnings).toContain("small_effective_face");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.profile_ineligible");
  });

  it("refuses the whole profile when the REQUIRED role is the one that is too small", async () => {
    const subject = await detectorSubject("Required Small Face Subject");

    const result = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "face_detail_only",
      effectiveReferenceSize: { widthPx: 128, heightPx: 128 },
    });

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.code).toBe("profile_ineligible");
    expect(result.messageKey).toBe("images.identity_pack.profile_ineligible.small_effective_face");
  });

  it("stays conservative when the provider's resize behavior is unknown", async () => {
    const subject = await detectorSubject("Unknown Resize Subject");

    const result = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "canonical_then_face_detail",
    });

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    // Warned, not refused: refusing every unreviewed profile would disable face
    // detail everywhere before the trial has a single measurement.
    expect(result.candidates.map((c) => c.role)).toEqual(["canonical_identity", "face_detail"]);
    expect(result.warnings).toContain("small_effective_face");
    const faceDetail = result.candidates.find((c) => c.role === "face_detail");
    expect(faceDetail?.evaluation.effectiveFaceWidthPx).toBeNull();
    expect(faceDetail?.evaluation.effectiveReferenceWidthPx).toBeNull();
  });

  it("applies the profile's heuristic gate to the face crop only", async () => {
    const subject = await preparedSubject("Heuristic Gate Subject");
    const policy = { ...PROFILE_POLICY_DEFAULTS_V1, allowHeuristic: false };

    const withCanonical = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "canonical_then_face_detail",
      profilePolicy: policy,
      effectiveReferenceSize: { widthPx: 1024, heightPx: 1024 },
    });
    expect(withCanonical.eligible).toBe(true);
    if (!withCanonical.eligible) return;
    // "No guessed crops" is a statement about the CROP, not about the character's
    // own portrait — the canonical role survives it.
    expect(withCanonical.candidates.map((c) => c.role)).toEqual(["canonical_identity"]);

    const faceOnly = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "face_detail_only",
      profilePolicy: policy,
      effectiveReferenceSize: { widthPx: 1024, heightPx: 1024 },
    });
    expect(faceOnly.eligible).toBe(false);
    if (faceOnly.eligible) return;
    expect(faceOnly.messageKey).toBe("images.identity_pack.profile_ineligible.policy_disallowed");
  });

  it("refuses an unusable pack with its own code, before anything could be reserved", async () => {
    const subject = await seedSubject("Ineligible Subject", 512, 384);

    const result = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "canonical_then_face_detail",
    });

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    // The pack's own failure code, not `profile_ineligible`: the UI can suggest a
    // clearer portrait rather than a different model.
    expect(result.code).toBe("no_usable_face");
    expect(result.messageKey).toBe("images.identity_pack.no_usable_face");
    expect(await cropRows(subject.characterId)).toHaveLength(0);
  });

  it("refuses a character that is not the caller's without revealing a pack exists", async () => {
    const subject = await preparedSubject("Foreign Subject");

    const result = await evaluateIdentityPackForProfile({
      ownerId: `${userId}-not-me`,
      characterId: subject.characterId,
      strategy: "canonical_only",
    });

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.code).toBe("source_missing");
  });

  it("builds complete provenance for a selected reference", async () => {
    const subject = await detectorSubject("Provenance Subject");
    const summary = await getIdentityPackForOwner(subject.characterId, userId);
    const pack: ImageIdentityPackV1 | null = summary?.pack ?? null;
    if (!pack) throw new Error("expected a current pack");

    const result = await evaluateIdentityPackForProfile({
      ownerId: userId,
      characterId: subject.characterId,
      strategy: "canonical_then_face_detail",
      effectiveReferenceSize: { widthPx: 512, heightPx: 512 },
    });
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;

    const faceDetail = result.candidates.find((c) => c.role === "face_detail");
    const canonical = result.candidates.find((c) => c.role === "canonical_identity");
    if (!faceDetail || !canonical) throw new Error("expected both candidates");

    const provenance = identityReferenceProvenanceFor(faceDetail, pack);
    expect(provenance).toEqual({
      characterId: subject.characterId,
      packId: pack.id,
      packRevision: pack.revision,
      packSchemaVersion: 1,
      derivationVersion: "derive_v1",
      policyVersion: "policy_v1",
      role: "face_detail",
      imageId: pack.faceDetail.imageId,
      sourceImageId: subject.portraitId,
      sourceContentHash: pack.source.contentHash,
      cropMethod: "detector",
      crop: pack.faceDetail.crop,
      warningCodes: faceDetail.warningCodes,
      adminOverride: false,
      effectiveReferenceWidthPx: 512,
      effectiveReferenceHeightPx: 512,
      effectiveFaceWidthPx: 209,
      effectiveFaceHeightPx: 244,
    });

    // The canonical role sends the whole portrait, so it claims no rectangle.
    const canonicalProvenance = identityReferenceProvenanceFor(canonical, pack);
    expect(canonicalProvenance.crop).toBeNull();
    expect(canonicalProvenance.cropMethod).toBeNull();
    expect(canonicalProvenance.imageId).toBe(subject.portraitId);
  });
});