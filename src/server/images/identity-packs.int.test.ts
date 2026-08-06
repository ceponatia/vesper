import fs from "node:fs/promises";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { DetectedFaceCandidate, ImageIdentityPackWarningCode } from "@/contracts";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { characters, db, imageIdentityPacks, images } from "../db";
import { absoluteImagePath, createImageAsset, saveImageBuffer, type ImageRow } from "./assets";
import { setIdentityFaceDetectorForTesting, type IdentityFaceDetector } from "./identity-pack-detector";
import { ensureIdentityPack, getIdentityPackForOwner, packRowToContract, type IdentityPackRow } from "./identity-packs";

/**
 * `ensureIdentityPack` end to end against DATABASE_URL and a sandboxed
 * DATA_ROOT — the guarantees that only a real database and a real filesystem can
 * prove (image-identity-packs.spec.derivation.md §"Derivation tests", server
 * integration list).
 *
 * What is under test here rather than in the pure suites: row-before-file crop
 * creation, compare-and-set promotion, single-flight coalescing, the
 * finalization race, and `parseOr` degradation of a wrecked row. The geometry
 * itself is pinned by golden fixtures in `identity-pack-crop.test.ts`; the boxes
 * below are chosen so the resulting rectangles clear the 256px floor, not to
 * re-pin the policy.
 *
 * Self-skips when the database is unreachable, except under strict integration
 * mode (`pnpm test:int:strict`), where it fails.
 */

const ready = await probeIntegrationDb("identity packs.int.test", "image_identity_packs");

/** 3:4 like every canonical portrait, and big enough that the crop clears 256px. */
const PORTRAIT_WIDTH = 384;
const PORTRAIT_HEIGHT = 512;

/**
 * A face box whose policy expansion lands a 294px square wholly inside the
 * portrait, with every requested padding satisfied — the "clean detector result"
 * case. (Expansion: ±0.55 of width, +0.65/-0.45 of height, squared.)
 */
const CLEAN_FACE_BOX = { left: 132, top: 100, width: 120, height: 140 };
const EXPECTED_DETECTOR_CROP = { left: 45, top: 9, width: 294, height: 294 };

let temp: TempDataRoot | undefined;
let userId = "";

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-identity-packs-int");
  userId = (await seedTestUser("identity-packs-int")).id;
});

afterEach(() => {
  // One suite's scripted detector must never leak into the next case — the
  // shipped adapter finding nothing is what the heuristic cases depend on.
  setIdentityFaceDetectorForTesting(null);
});

afterAll(async () => {
  await temp?.cleanup();
  await purgeOwnerRows([userId]);
  await endTestPool();
});

/** A scripted detector: fixed candidates, or a thrown error, per case. */
function fakeDetector(
  candidates: DetectedFaceCandidate[],
  opts: { version?: string; onDetect?: () => Promise<void> } = {},
): IdentityFaceDetector {
  return {
    version: opts.version ?? "fake_v1",
    detect: async () => {
      await opts.onDetect?.();
      return candidates;
    },
  };
}

function candidate(box: DetectedFaceCandidate["box"], confidence: number): DetectedFaceCandidate {
  return { box, confidence };
}

/** A decodable PNG whose bytes differ per `tint` — how a source-byte change is simulated. */
async function tintedPng(width: number, height: number, tint: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: tint, g: 90, b: 140 } } })
    .png()
    .toBuffer();
}

/** Store one ready image row for the character, through the normal asset path. */
async function storePortrait(characterId: string, buffer: Buffer): Promise<ImageRow> {
  const asset = await createImageAsset({
    ownerId: userId,
    kind: "avatar",
    entityKind: "character",
    entityId: characterId,
    prompt: "portrait",
  });
  const saved = await saveImageBuffer(asset.id, buffer);
  if (saved?.status !== "ready") throw new Error("failed to store the test portrait");
  return saved;
}

interface Subject {
  characterId: string;
  portrait: ImageRow;
}

/**
 * A character with a canonical portrait. The pointer is written directly rather
 * than through `promoteVariant`, so the background preparation trigger does not
 * fire and each case drives `ensureIdentityPack` itself.
 */
async function seedSubject(name: string, width = PORTRAIT_WIDTH, height = PORTRAIT_HEIGHT): Promise<Subject> {
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: userId, name, profile: { bio: "identity pack subject" } })
    .returning({ id: characters.id });
  if (!character) throw new Error("failed to create the test character");
  const portrait = await storePortrait(character.id, await testPngBuffer(width, height));
  await db().update(characters).set({ avatarImageId: portrait.id }).where(eq(characters.id, character.id));
  return { characterId: character.id, portrait };
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
      and(
        eq(images.entityKind, "character"),
        eq(images.entityId, characterId),
        eq(images.kind, "identity_face_crop"),
      ),
    );
}

async function avatarImageId(characterId: string): Promise<string | null> {
  const [row] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  return row?.avatarImageId ?? null;
}

describe.skipIf(!ready)("ensureIdentityPack — automatic derivation", () => {
  it("derives a heuristic pack, stores the hidden crop row before its file, and records measurements", async () => {
    const subject = await seedSubject("Heuristic Subject");
    const sink = new DiagnosticCollector();

    const result = await ensureIdentityPack({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
      sink,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // A guessed crop is usable but never silently so: the warning travels with
    // the pack into render provenance.
    expect(result.warnings).toEqual<ImageIdentityPackWarningCode[]>(["heuristic_crop"]);
    expect(result.pack.derivation.method).toBe("heuristic");
    // The heuristic names no detector and claims no confidence — recording the
    // null adapter's version here would suggest a detector agreed with the guess.
    expect(result.pack.derivation.detectorVersion).toBeNull();
    expect(result.pack.derivation.confidence).toBeNull();
    expect(result.pack.source.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pack.source.width).toBe(PORTRAIT_WIDTH);
    expect(result.pack.source.height).toBe(PORTRAIT_HEIGHT);
    // heuristic_v1: full source width, centred, 8% down from the top.
    expect(result.pack.faceDetail.crop).toEqual({ left: 0, top: 41, width: 384, height: 384 });
    expect(result.pack.faceDetail.outputWidth).toBe(384);

    // Measurements exist even though the policy accepted the crop — that is what
    // lets a later threshold change re-judge this revision.
    const quality = result.pack.quality;
    expect(quality?.algorithmVersion).toBe("laplacian_v1");
    expect(typeof quality?.blurScore).toBe("number");
    expect(quality?.detectedFaces).toBe(0);
    // No face box was observed, so every face-derived metric is null, NOT zero.
    expect(quality?.faceBox).toBeNull();
    expect(quality?.faceWidthPx).toBeNull();
    expect(quality?.faceAreaRatio).toBeNull();
    expect(quality?.padding).toEqual({ topPx: null, rightPx: null, bottomPx: null, leftPx: null });

    const crops = await cropRows(subject.characterId);
    expect(crops).toHaveLength(1);
    const crop = crops[0];
    expect(crop?.id).toBe(result.pack.faceDetail.imageId);
    expect(crop?.status).toBe("ready");
    expect(crop?.sourceImageId).toBe(subject.portrait.id);
    expect(crop?.meta).toMatchObject({
      hidden: true,
      identityPackId: result.pack.id,
      identityRole: "face_detail",
      sourceContentHash: result.pack.source.contentHash,
      derivationVersion: "derive_v1",
      width: 384,
      height: 384,
    });
    await expect(fs.access(absoluteImagePath(crop ?? { path: "missing" }))).resolves.toBeUndefined();

    expect(await packRows(subject.characterId)).toHaveLength(1);
  });

  it("uses the detector's face box when exactly one candidate is confident", async () => {
    const subject = await seedSubject("Detector Subject");
    setIdentityFaceDetectorForTesting(fakeDetector([candidate(CLEAN_FACE_BOX, 0.95)], { version: "scripted_v1" }));

    const result = await ensureIdentityPack({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.warnings).toEqual([]);
    expect(result.pack.derivation.method).toBe("detector");
    expect(result.pack.derivation.detectorVersion).toBe("scripted_v1");
    expect(result.pack.derivation.confidence).toBeCloseTo(0.95);
    expect(result.pack.faceDetail.crop).toEqual(EXPECTED_DETECTOR_CROP);
    expect(result.pack.quality?.faceBox).toEqual(CLEAN_FACE_BOX);
    expect(result.pack.quality?.detectedFaces).toBe(1);
    // Padding is measured from the face box to the crop edges, so a detector
    // revision carries the evidence a heuristic one cannot.
    expect(result.pack.quality?.padding.topPx).toBe(91);
  });

  it("refuses rather than choosing between two plausible faces", async () => {
    const subject = await seedSubject("Ambiguous Subject");
    setIdentityFaceDetectorForTesting(
      fakeDetector([
        candidate(CLEAN_FACE_BOX, 0.95),
        // Far below the primary floor but above the possible-additional floor:
        // not the subject, yet easily enough to make "which person?" a question.
        candidate({ left: 20, top: 300, width: 60, height: 70 }, 0.4),
      ]),
    );
    const sink = new DiagnosticCollector();

    const result = await ensureIdentityPack({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
      sink,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.code).toBe("ambiguous_faces");
    // Terminal until the source or a human crop changes — a retry would produce
    // the same answer at provider-render frequency.
    expect(result.retryable).toBe(false);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.ambiguous_faces");

    const [row] = await packRows(subject.characterId);
    expect(row?.status).toBe("unusable");
    expect(row?.current).toBe(true);
    expect(row?.failureCode).toBe("ambiguous_faces");
    // Nothing was written: the hidden row is reserved only after a crop is justified.
    expect(await cropRows(subject.characterId)).toHaveLength(0);
  });

  it("fails closed on a landscape source instead of cropping somebody's shoulder", async () => {
    const subject = await seedSubject("Landscape Subject", 512, 384);
    const sink = new DiagnosticCollector();

    const result = await ensureIdentityPack({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
      sink,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.code).toBe("no_usable_face");
    expect(result.retryable).toBe(false);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.no_usable_face");
    expect(await cropRows(subject.characterId)).toHaveLength(0);
  });

  it("is idempotent for unchanged bytes and versions", async () => {
    const subject = await seedSubject("Idempotent Subject");

    const first = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });
    const second = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(second.pack.id).toBe(first.pack.id);
    expect(second.pack.revision).toBe(first.pack.revision);
    expect(await packRows(subject.characterId)).toHaveLength(1);
    expect(await cropRows(subject.characterId)).toHaveLength(1);
  });

  it("supersedes the old revision when the source bytes change under the same image id", async () => {
    const subject = await seedSubject("Rehash Subject");
    const first = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;

    // Same row, same path, different pixels: the pack must not survive that.
    const replaced = await saveImageBuffer(subject.portrait.id, await tintedPng(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 60));
    expect(replaced?.status).toBe("ready");

    const second = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });
    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.pack.id).not.toBe(first.pack.id);
    expect(second.pack.revision).toBe(2);
    expect(second.pack.source.contentHash).not.toBe(first.pack.source.contentHash);

    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(2);
    // Different bytes ⇒ the world moved on: `stale`, not `superseded`.
    expect(rows[0]?.status).toBe("stale");
    expect(rows[0]?.current).toBe(false);
    expect(rows[1]?.current).toBe(true);
  });

  it("coalesces concurrent callers into one derivation", async () => {
    const subject = await seedSubject("Concurrent Subject");

    const results = await Promise.all([
      ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "identity_render" }),
      ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "identity_render" }),
      ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["ready", "ready", "ready"]);
    const ids = new Set(results.map((r) => (r.status === "ready" ? r.pack.id : "blocked")));
    expect(ids.size).toBe(1);
    expect(await packRows(subject.characterId)).toHaveLength(1);
    expect(await cropRows(subject.characterId)).toHaveLength(1);
  });

  it("returns a terminal refusal again without opening a second revision", async () => {
    const subject = await seedSubject("Terminal Subject", 512, 384);

    const first = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });
    const second = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });

    expect(first.status).toBe("blocked");
    expect(second.status).toBe("blocked");
    if (second.status !== "blocked") return;
    expect(second.code).toBe("no_usable_face");
    expect(await packRows(subject.characterId)).toHaveLength(1);
  });
});

describe.skipIf(!ready)("ensureIdentityPack — failure containment", () => {
  it("records a failed revision when the detector throws, leaving the portrait untouched", async () => {
    const subject = await seedSubject("Detector Explosion");
    setIdentityFaceDetectorForTesting({
      version: "exploding_v1",
      detect: () => Promise.reject(new Error("detector segfaulted")),
    });

    const result = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.code).toBe("derivation_failed");
    // Machinery, not the portrait — worth another attempt after backoff.
    expect(result.retryable).toBe(true);

    const [row] = await packRows(subject.characterId);
    expect(row?.status).toBe("failed");
    expect(row?.failureCode).toBe("derivation_failed");
    expect(row?.failureMessage).toContain("segfaulted");
    // The whole point of best-effort preparation: a valid portrait survives it.
    expect(await avatarImageId(subject.characterId)).toBe(subject.portrait.id);
    expect(await cropRows(subject.characterId)).toHaveLength(0);
  });

  it("holds a retryable failure inside its backoff window instead of re-deriving", async () => {
    const subject = await seedSubject("Backoff Subject");
    setIdentityFaceDetectorForTesting({
      version: "exploding_v1",
      detect: () => Promise.reject(new Error("detector segfaulted")),
    });
    await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });

    // The scripted detector is irrelevant now: the backoff decision is made
    // before derivation is attempted at all.
    setIdentityFaceDetectorForTesting(fakeDetector([candidate(CLEAN_FACE_BOX, 0.95)]));
    const again = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });

    expect(again.status).toBe("blocked");
    if (again.status !== "blocked") return;
    expect(again.code).toBe("derivation_failed");
    expect(again.retryable).toBe(true);
    expect(await packRows(subject.characterId)).toHaveLength(1);
  });

  it("abandons a revision that loses the finalization race and removes its crop immediately", async () => {
    const subject = await seedSubject("Race Subject");
    const replacement = await storePortrait(subject.characterId, await tintedPng(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 30));
    const sink = new DiagnosticCollector();

    // The pointer moves between the reserve and the finalize — exactly the
    // window a slow derivation occupies.
    setIdentityFaceDetectorForTesting(
      fakeDetector([candidate(CLEAN_FACE_BOX, 0.95)], {
        onDetect: async () => {
          await db()
            .update(characters)
            .set({ avatarImageId: replacement.id })
            .where(eq(characters.id, subject.characterId));
        },
      }),
    );

    const result = await ensureIdentityPack({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
      sink,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.code).toBe("source_changed");
    expect(result.retryable).toBe(true);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.finalize_race");

    const [row] = await packRows(subject.characterId);
    expect(row?.status).toBe("stale");
    // Never left `current`: a row that is both current and terminal would wedge
    // the next reservation, which cannot retire a terminal revision.
    expect(row?.current).toBe(false);
    // A crop no pack row will ever name is litter, not evidence — hard-deleted
    // rather than left for the retention window.
    expect(await cropRows(subject.characterId)).toHaveLength(0);
  });

  it("blocks with source_missing for a character with no canonical portrait", async () => {
    const [character] = await db()
      .insert(characters)
      .values({ ownerId: userId, name: "Portrait-less" })
      .returning({ id: characters.id });
    const sink = new DiagnosticCollector();

    const result = await ensureIdentityPack({
      ownerId: userId,
      characterId: character?.id ?? "missing",
      purpose: "background",
      sink,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.code).toBe("source_missing");
    expect(result.retryable).toBe(false);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.source_missing");
  });

  it("refuses a character owned by somebody else without revealing anything", async () => {
    const subject = await seedSubject("Someone Else's");

    const result = await ensureIdentityPack({
      ownerId: `${userId}-not-me`,
      characterId: subject.characterId,
      purpose: "background",
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.code).toBe("source_missing");
    expect(result.pack).toBeNull();
    expect(await packRows(subject.characterId)).toHaveLength(0);
  });
});

describe.skipIf(!ready)("pack reads", () => {
  it("degrades a malformed measurement row to unusable with a diagnostic", async () => {
    const subject = await seedSubject("Wrecked Row");
    const derived = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });
    expect(derived.status).toBe("ready");
    if (derived.status !== "ready") return;

    await db()
      .update(imageIdentityPacks)
      .set({ crop: { left: "nope", top: null } })
      .where(eq(imageIdentityPacks.id, derived.pack.id));

    const sink = new DiagnosticCollector();
    const summary = await getIdentityPackForOwner(subject.characterId, userId, sink);

    expect(summary?.pack?.status).toBe("unusable");
    expect(summary?.failureCode).toBe("invalid_crop");
    expect(summary?.pack?.faceDetail.crop).toBeNull();
    // The crop image id is withheld too: nothing may point a render at bytes the
    // row can no longer justify.
    expect(summary?.pack?.faceDetail.imageId).toBeNull();
    const codes = sink.items.map((d) => d.code);
    expect(codes).toContain("parse.boundary_failed");
    expect(codes).toContain("images.identity_pack.invalid_crop");

    // And the same row read directly maps the same way — the degradation lives
    // in the mapper, not in the summary.
    const [row] = await packRows(subject.characterId);
    if (!row) throw new Error("expected the pack row");
    expect(packRowToContract(row).status).toBe("unusable");
  });

  it("reports the current pack, its warnings, and staleness against the live portrait", async () => {
    const subject = await seedSubject("Summary Subject");
    await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });

    const fresh = await getIdentityPackForOwner(subject.characterId, userId);
    expect(fresh?.current).toBe(true);
    expect(fresh?.stale).toBe(false);
    expect(fresh?.pending).toBe(false);
    expect(fresh?.failureCode).toBeNull();
    expect(fresh?.warnings).toEqual<ImageIdentityPackWarningCode[]>(["heuristic_crop"]);
    expect(fresh?.sourceImageId).toBe(subject.portrait.id);

    // Repointing the character at a different portrait makes the pack stale
    // without touching the row.
    const replacement = await storePortrait(subject.characterId, await tintedPng(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 10));
    await db().update(characters).set({ avatarImageId: replacement.id }).where(eq(characters.id, subject.characterId));

    const stale = await getIdentityPackForOwner(subject.characterId, userId);
    expect(stale?.stale).toBe(true);
    expect(stale?.sourceImageId).toBe(replacement.id);
  });

  it("returns an empty summary before any revision exists, and null for a foreign character", async () => {
    const subject = await seedSubject("Unprepared Subject");

    const summary = await getIdentityPackForOwner(subject.characterId, userId);
    expect(summary?.pack).toBeNull();
    expect(summary?.pending).toBe(false);
    expect(summary?.sourceImageId).toBe(subject.portrait.id);

    expect(await getIdentityPackForOwner(subject.characterId, `${userId}-not-me`)).toBeNull();
  });
});
