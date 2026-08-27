import fs from "node:fs/promises";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  type DetectedFaceCandidate,
  IDENTITY_PACK_DERIVATION_VERSION,
  IDENTITY_PACK_POLICY_VERSION,
  IDENTITY_PACK_SCHEMA_VERSION,
  type IdentityFaceDetector,
  type ImageIdentityPackWarningCode,
  INTRINSIC_POLICY_V1,
  setIdentityFaceDetectorForTesting,
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
import { characters, db, imageIdentityPacks, images, jobs, JOB_STALE_MS } from "../db";
import { absoluteImagePath, createImageAsset, saveImageBuffer, type ImageRow } from "./assets";
import {
  deriveIdentityPackWithoutProcessLockForTesting,
  ensureIdentityPack,
  RESERVATION_JOIN_MS,
} from "./identity-pack-ensure";
import { cleanupIdentityPackRevisions, IDENTITY_PACK_REVISION_RETENTION_MS } from "./identity-pack-maintenance";
import { resetIdentityPackToAutomatic } from "./identity-pack-manual";
import {
  MAX_IDENTITY_PACK_PREPARATION_PASSES,
  runIdentityPackPreparationForTesting,
} from "./identity-pack-preparation";
import { getIdentityPackForOwner } from "./identity-pack-read";
import {
  identityPackLockKey,
  packRowToContract,
  setIdentityIntrinsicPolicyForTesting,
  sourceContentHashOf,
  type IdentityPackRow,
} from "./identity-pack-store";

/**
 * `ensureIdentityPack` end to end against DATABASE_URL and a sandboxed
 * DATA_ROOT — the guarantees that only a real database and a real filesystem can
 * prove.
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
  // One suite's scripted detector or policy must never leak into the next case —
  // the shipped adapter finding nothing, and the v1 thresholds being unarmed, are
  // what the heuristic cases depend on.
  setIdentityFaceDetectorForTesting(null);
  setIdentityIntrinsicPolicyForTesting(null);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a promise has ALREADY settled, without waiting for it. A microtask
 * race, so it reports the state as of now — which is the point: "contender two is
 * still waiting" is only meaningful as an observation taken while the reservation
 * it is waiting on is demonstrably still open.
 */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  const stillWaiting = Symbol("pending");
  return (await Promise.race([promise, Promise.resolve(stillWaiting)])) !== stillWaiting;
}

interface DetectorGate {
  detector: IdentityFaceDetector;
  /** How many times `detect()` actually ran. Coalescing means this stays at 1. */
  calls: () => number;
  /** Let the parked `detect()` — and every later one — return. */
  release: () => void;
}

/**
 * A detector that parks inside `detect()` until released, counting every entry.
 *
 * The park is what makes the contention observable at all: a real derivation of a
 * 384×512 portrait is a few milliseconds, far too short to interleave two callers
 * by hand. The count is what the cases below are built around — one derivation per
 * set of source bytes, however many callers asked for one.
 */
function gatedDetector(candidates: DetectedFaceCandidate[] = []): DetectorGate {
  let calls = 0;
  let openGate!: () => void;
  const parked = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return {
    detector: {
      version: "gated_v1",
      detect: async () => {
        calls += 1;
        await parked;
        return candidates;
      },
    },
    calls: () => calls,
    release: () => {
      openGate();
    },
  };
}

/** Poll the table until the character's current revision is a `pending` reservation. */
async function waitForReservation(characterId: string): Promise<IdentityPackRow> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await db()
      .select()
      .from(imageIdentityPacks)
      .where(
        and(
          eq(imageIdentityPacks.characterId, characterId),
          eq(imageIdentityPacks.current, true),
          eq(imageIdentityPacks.status, "pending"),
        ),
      )
      .limit(1);
    if (row) return row;
    await sleep(25);
  }
  throw new Error("the reservation never appeared");
}

/** Every `identity_pack` job row this character has, oldest first. */
async function packJobs(characterId: string): Promise<{ id: string; status: string; payload: unknown }[]> {
  return db()
    .select({ id: jobs.id, status: jobs.status, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, "identity_pack"), sql`${jobs.payload} ->> 'characterId' = ${characterId}`))
    .orderBy(asc(jobs.createdAt));
}

/** The SHA-256 the pack rows carry: over the STORED bytes, not the buffer that was uploaded. */
async function storedHash(row: ImageRow): Promise<string> {
  return sourceContentHashOf(await fs.readFile(absoluteImagePath(row)));
}

/** Point the character's canonical portrait at `imageId`, as a promotion would. */
async function repoint(characterId: string, imageId: string): Promise<void> {
  await db().update(characters).set({ avatarImageId: imageId }).where(eq(characters.id, characterId));
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

/**
 * Cross-process coalescing — the half of the single flight the in-process keyed
 * lock cannot provide and cannot be tested through.
 *
 * Every case here drives contenders through
 * `deriveIdentityPackWithoutProcessLockForTesting`, the seam that skips that lock.
 * That is the whole point: a `Promise.all` over ordinary `ensureIdentityPack`
 * calls — which the "coalesces concurrent callers" case above already pins — never
 * reaches the database with two live callers, because the key serializes them
 * first. It proves the optimization and says nothing about two Fly machines. These
 * cases put two callers past that point and let the database arbitrate, which is
 * what actually happens in production.
 *
 * Everything under the seam is production code, including both compare-and-set
 * halves and the partial unique index on `current`.
 */
describe.skipIf(!ready)("cross-process reservation coalescing", () => {
  /**
   * Long enough to cover a contender's two pre-join round trips plus a poll
   * interval, so "still waiting" is an observation rather than a coin flip. Only
   * ever spent while a reservation is deliberately parked.
   */
  const JOIN_PROBE_MS = 600;

  /**
   * How long the reclaim-binding case below waits before stalling the character's
   * advisory lock, so "the reset is already inside its join" is a fact rather than
   * a hope on a loaded runner. Generous against a reset's start-up — two reads, a
   * file hash and a decode — and still far short of the five-second join budget it
   * has to land inside, because a stall that arrived FIRST would be joined as the
   * reservation rather than replacing one.
   */
  const JOIN_ENTERED_MS = 2_000;

  it("joins another process's live reservation instead of deriving the same crop twice", async () => {
    const subject = await seedSubject("Cross-Process Subject");
    const gate = gatedDetector();
    setIdentityFaceDetectorForTesting(gate.detector);

    // Contender one stands in for another machine: no in-process key is held, so
    // nothing but the database stands between the two callers.
    const holder = deriveIdentityPackWithoutProcessLockForTesting({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
    });
    const reservation = await waitForReservation(subject.characterId);

    // Contender two arrives with the reservation already committed and visible —
    // the interleaving that used to earn it a `pending_conflict` refusal, and,
    // when its own read landed a moment earlier, a duplicate revision that
    // retired the reservation mid-derivation.
    const sink = new DiagnosticCollector();
    const joiner = deriveIdentityPackWithoutProcessLockForTesting({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
      sink,
    });

    await sleep(JOIN_PROBE_MS);
    const joinerWaited = !(await hasSettled(joiner));
    gate.release();
    const [held, joined] = await Promise.all([holder, joiner]);
    const rows = await packRows(subject.characterId);
    const crops = await cropRows(subject.characterId);

    // It waited for the answer rather than being refused one.
    expect(joinerWaited).toBe(true);
    expect(sink.items.map((d) => d.code)).not.toContain("images.identity_pack.pending_conflict");

    // One derivation, one settled revision, one crop — for two callers.
    expect(gate.calls()).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(reservation.id);
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.current).toBe(true);
    expect(crops).toHaveLength(1);

    expect(held.status).toBe("ready");
    expect(joined.status).toBe("ready");
    if (held.status !== "ready" || joined.status !== "ready") return;
    expect(joined.pack.id).toBe(held.pack.id);
    expect(joined.pack.revision).toBe(held.pack.revision);
  }, 20_000);

  it("refuses a background contender promptly without starting a second derivation", async () => {
    const subject = await seedSubject("Background Contender");
    const gate = gatedDetector();
    setIdentityFaceDetectorForTesting(gate.detector);

    const holder = deriveIdentityPackWithoutProcessLockForTesting({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
    });
    await waitForReservation(subject.characterId);

    // A queued job has nobody waiting on it, so it declines rather than holding a
    // slot for the length of somebody else's derivation. What it must NOT do is
    // start its own.
    const sink = new DiagnosticCollector();
    const background = await deriveIdentityPackWithoutProcessLockForTesting({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "background",
      sink,
    });
    const callsWhileHeld = gate.calls();
    const rowsWhileHeld = await packRows(subject.characterId);

    gate.release();
    const held = await holder;

    expect(background.status).toBe("blocked");
    expect(callsWhileHeld).toBe(1);
    expect(rowsWhileHeld).toHaveLength(1);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.pending_conflict");
    expect(held.status).toBe("ready");
    expect(gate.calls()).toBe(1);
    if (background.status !== "blocked") return;
    expect(background.code).toBe("derivation_failed");
    // Nothing is wrong with the source: the answer is one commit away.
    expect(background.retryable).toBe(true);
  }, 20_000);

  it("leaves a live reservation standing when the reserve transaction meets one", async () => {
    const subject = await seedSubject("Reserve-Side Contender");
    const gate = gatedDetector();
    setIdentityFaceDetectorForTesting(gate.detector);

    const holder = deriveIdentityPackWithoutProcessLockForTesting({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
    });
    await waitForReservation(subject.characterId);

    // A reset forces a new revision, so it skips the current-row read entirely
    // and meets the reservation INSIDE the reserve transaction — the branch the
    // pre-reserve check can never reach, and the one that used to retire a live
    // reservation and take its crop with it.
    const reset = resetIdentityPackToAutomatic({
      ownerId: userId,
      characterId: subject.characterId,
      actorUserId: userId,
    });
    await sleep(JOIN_PROBE_MS);
    const resetWaited = !(await hasSettled(reset));
    gate.release();
    const [held, redone] = await Promise.all([holder, reset]);
    const rows = await packRows(subject.characterId);

    expect(resetWaited).toBe(true);
    // The reservation finished on its own terms. Under the old behavior its
    // finalize lost the compare-and-set and it came back `source_changed`.
    expect(held.status).toBe("ready");
    expect(redone.status).toBe("ready");
    expect(rows).toHaveLength(2);
    // Redone deliberately over the same bytes ⇒ `superseded`, not `stale`.
    expect(rows[0]?.status).toBe("superseded");
    expect(rows[0]?.current).toBe(false);
    expect(rows[1]?.status).toBe("ready");
    expect(rows[1]?.current).toBe(true);
    // Two derivations, because the caller asked for a second one — the waiting is
    // about not clobbering the first, not about skipping the work.
    expect(gate.calls()).toBe(2);
  }, 20_000);

  it("lets a forced re-derivation reclaim a reservation that would not settle", async () => {
    const subject = await seedSubject("Wedged Reservation Subject");
    // A holder that parks forever stands in for a derivation wedged on another
    // machine: alive by the staleness bound, never going to finalize. Only the
    // FIRST detect parks, so the reset's own derivation below runs unimpeded.
    let calls = 0;
    let openGate!: () => void;
    const parked = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    setIdentityFaceDetectorForTesting({
      version: "wedged_v1",
      detect: async () => {
        calls += 1;
        if (calls === 1) await parked;
        return [];
      },
    });

    const holder = deriveIdentityPackWithoutProcessLockForTesting({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
    });
    const reservation = await waitForReservation(subject.characterId);

    // The reset waits out the join window first, then reclaims: an explicit
    // human act is the one caller allowed to retire a live-looking reservation,
    // because without it this button dead-ends until the staleness bound.
    const sink = new DiagnosticCollector();
    const redone = await resetIdentityPackToAutomatic({
      ownerId: userId,
      characterId: subject.characterId,
      actorUserId: userId,
      sink,
    });

    expect(redone.status).toBe("ready");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.pending_conflict");

    // The wedged holder finally returns — and loses its finalize exactly as when
    // the source moves on: retired row, crop cleaned, honest refusal.
    openGate();
    const held = await holder;
    expect(held.status).toBe("blocked");
    if (held.status !== "blocked") return;
    expect(held.code).toBe("source_changed");

    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(reservation.id);
    expect(rows[0]?.status).toBe("stale");
    expect(rows[0]?.current).toBe(false);
    expect(rows[1]?.status).toBe("ready");
    expect(rows[1]?.current).toBe(true);
    expect(calls).toBe(2);
    expect(await cropRows(subject.characterId)).toHaveLength(1);
  }, 20_000);

  it("refuses to reclaim a reservation that replaced the one it joined", async () => {
    const subject = await seedSubject("Replaced Reservation Subject");
    const gate = gatedDetector();
    setIdentityFaceDetectorForTesting(gate.detector);

    // A wedged reservation again — live by the staleness bound, never going to
    // finalize — so the reset below must spend the whole join budget on it and
    // come back holding leave to reclaim it.
    const holder = deriveIdentityPackWithoutProcessLockForTesting({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
    });
    const wedged = await waitForReservation(subject.characterId);

    const sink = new DiagnosticCollector();
    const reset = resetIdentityPackToAutomatic({
      ownerId: userId,
      characterId: subject.characterId,
      actorUserId: userId,
      sink,
    });
    // Long enough to be sure the reset is inside its join poll: the replacement
    // below has to land while it is waiting on THIS reservation, not before it
    // ever met one — a reset that joined the replacement instead would be
    // licensed to reclaim it, and would prove nothing.
    await sleep(JOIN_ENTERED_MS);
    expect(await hasSettled(reset)).toBe(false);

    // A third process retires the wedged reservation and opens its own, and is
    // still deriving when the reset comes back — the interleaving the reclaim
    // leave must not cover. Both halves run under the SERVICE's advisory lock,
    // held past the join deadline, which is what makes the ordering a fact
    // rather than a 250ms coin flip: the reset's poll cannot see an uncommitted
    // replacement, so it times out on the wedged row exactly as it would have
    // anyway, and its re-entry then blocks here until the replacement is
    // committed, live and current.
    const replacementId = await db().transaction(async (tx): Promise<string> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityPackLockKey(subject.characterId)}, 0))`,
      );
      // Retire first: the partial unique index allows exactly one current row.
      await tx
        .update(imageIdentityPacks)
        .set({ current: false, status: "stale" })
        .where(eq(imageIdentityPacks.id, wedged.id));
      // Copied off the wedged row rather than rebuilt from the fixture, so the
      // replacement provably MATCHES this source — same image, hash and versions
      // — which is the only kind of live reservation the reclaim leave could
      // have been mistaken for.
      const [replacement] = await tx
        .insert(imageIdentityPacks)
        .values({
          characterId: wedged.characterId,
          revision: wedged.revision + 1,
          current: true,
          status: "pending",
          sourceImageId: wedged.sourceImageId,
          sourceContentHash: wedged.sourceContentHash,
          sourceWidth: wedged.sourceWidth,
          sourceHeight: wedged.sourceHeight,
          schemaVersion: wedged.schemaVersion,
          derivationVersion: wedged.derivationVersion,
          policyVersion: wedged.policyVersion,
        })
        .returning({ id: imageIdentityPacks.id });
      if (!replacement) throw new Error("failed to insert the replacement reservation");
      // Held past the reset's join deadline — which started before this stall did
      // — so its re-entry queues here and reads the replacement as current.
      await sleep(RESERVATION_JOIN_MS + 1_500);
      return replacement.id;
    });

    // Released BEFORE the reset is awaited, deliberately: a reset that wrongly
    // reclaimed the replacement would derive through this same gate, so leaving
    // it shut would turn a wrong answer into a deadlock instead of the failed
    // assertions below. The wedged holder resumes here too and loses its
    // finalize, as it must — its reservation stopped being current the moment
    // the third process retired it.
    gate.release();
    const [held, redone] = await Promise.all([holder, reset]);

    // Leave for the row it joined is not leave for whatever is current when it
    // returns: the replacement is somebody else's live work, so the reset is
    // told busy instead of taking it.
    expect(redone.status).toBe("blocked");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.pending_conflict");
    // And it started no derivation on the way to that refusal — the wedged
    // holder's is still the only `detect()` this character has seen.
    expect(gate.calls()).toBe(1);
    if (redone.status !== "blocked") return;
    expect(redone.code).toBe("derivation_failed");
    expect(redone.retryable).toBe(true);

    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(wedged.id);
    expect(rows[0]?.status).toBe("stale");
    expect(rows[0]?.current).toBe(false);
    // Untouched: still current, still pending, still the replacement's to finish.
    expect(rows[1]?.id).toBe(replacementId);
    expect(rows[1]?.status).toBe("pending");
    expect(rows[1]?.current).toBe(true);
    // The displaced holder's crop is cleaned rather than left pointing nowhere.
    expect(await cropRows(subject.characterId)).toHaveLength(0);
    expect(held.status).toBe("blocked");
    if (held.status !== "blocked") return;
    expect(held.code).toBe("source_changed");
  }, 20_000);

  it("retires a reservation past the staleness bound and derives again", async () => {
    const subject = await seedSubject("Abandoned Reservation");
    // A reservation whose process died mid-derivation (a deploy replaced the
    // machine): nothing will ever finalize it, and honouring it forever would
    // wedge this character's pack permanently.
    const bytes = await fs.readFile(absoluteImagePath(subject.portrait));
    const [abandoned] = await db()
      .insert(imageIdentityPacks)
      .values({
        characterId: subject.characterId,
        revision: 1,
        current: true,
        status: "pending",
        sourceImageId: subject.portrait.id,
        sourceContentHash: sourceContentHashOf(bytes),
        sourceWidth: PORTRAIT_WIDTH,
        sourceHeight: PORTRAIT_HEIGHT,
        schemaVersion: IDENTITY_PACK_SCHEMA_VERSION,
        derivationVersion: IDENTITY_PACK_DERIVATION_VERSION,
        policyVersion: IDENTITY_PACK_POLICY_VERSION,
        createdAt: new Date(Date.now() - JOB_STALE_MS - 60_000),
      })
      .returning({ id: imageIdentityPacks.id });

    const result = await ensureIdentityPack({
      ownerId: userId,
      characterId: subject.characterId,
      purpose: "identity_render",
    });

    expect(result.status).toBe("ready");
    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(abandoned?.id);
    expect(rows[0]?.status).toBe("stale");
    expect(rows[0]?.current).toBe(false);
    expect(rows[1]?.status).toBe("ready");
    expect(rows[1]?.current).toBe(true);
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

/**
 * The read-time half of "`quality.accepted` is not persisted as eternal truth":
 * a policy change re-evaluates existing packs.
 *
 * Only `policy_v1` exists today, so the branch is dormant in production and these
 * cases fabricate the condition it exists for: a stored revision stamped with an
 * older policy version, re-read while different thresholds are in force. Both
 * directions of the ruling are pinned — the reader is told the CURRENT verdict,
 * and the row keeps the historical one.
 */
describe.skipIf(!ready)("read-time policy projection", () => {
  /** Derive a ready pack, then restamp its row as the work of an older policy. */
  async function packUnderOldPolicy(name: string): Promise<{ characterId: string; packId: string }> {
    const subject = await seedSubject(name);
    const derived = await ensureIdentityPack({ ownerId: userId, characterId: subject.characterId, purpose: "background" });
    if (derived.status !== "ready") throw new Error("expected a ready pack to re-judge");
    await db()
      .update(imageIdentityPacks)
      .set({ policyVersion: "policy_v0" })
      .where(eq(imageIdentityPacks.id, derived.pack.id));
    return { characterId: subject.characterId, packId: derived.pack.id };
  }

  it("refuses a stored ready revision the current policy would block, without rewriting the row", async () => {
    const { characterId, packId } = await packUnderOldPolicy("Re-judged Subject");
    // A tightened minimum size — the most ordinary reason to bump a policy — and
    // one that needs no measurement to be non-null to bite.
    setIdentityIntrinsicPolicyForTesting({
      ...INTRINSIC_POLICY_V1,
      version: "policy_v2",
      minimumCropWidthPx: 100_000,
      minimumCropHeightPx: 100_000,
    });

    const sink = new DiagnosticCollector();
    const reused = await ensureIdentityPack({ ownerId: userId, characterId, purpose: "identity_render", sink });

    expect(reused.status).toBe("blocked");
    if (reused.status !== "blocked") return;
    expect(reused.code).toBe("crop_too_small");
    // Nothing about this source or this rectangle will change the answer: only a
    // policy or a source change can.
    expect(reused.retryable).toBe(false);
    expect(reused.pack?.status).toBe("unusable");
    // The verdict names the policy that produced it, not the one the row was
    // stamped with — render provenance copies this field verbatim.
    expect(reused.pack?.derivation.policyVersion).toBe("policy_v2");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.crop_too_small");

    // The owner's status view agrees, because it is the same projection.
    const summary = await getIdentityPackForOwner(characterId, userId);
    expect(summary?.pack?.status).toBe("unusable");
    expect(summary?.failureCode).toBe("crop_too_small");
    expect(summary?.retryable).toBe(false);

    // The row is a historical claim about what policy_v0 decided, and it stays one.
    const [row] = await packRows(characterId);
    expect(row?.id).toBe(packId);
    expect(row?.status).toBe("ready");
    expect(row?.current).toBe(true);
    expect(row?.policyVersion).toBe("policy_v0");
    expect(row?.failureCode).toBeNull();
  });

  it("re-derives warnings under the current policy while keeping how the crop was authored", async () => {
    const { characterId } = await packUnderOldPolicy("Re-warned Subject");
    setIdentityIntrinsicPolicyForTesting({ ...INTRINSIC_POLICY_V1, version: "policy_v2" });

    const reused = await ensureIdentityPack({ ownerId: userId, characterId, purpose: "identity_render" });

    expect(reused.status).toBe("ready");
    if (reused.status !== "ready") return;
    // `heuristic_crop` records HOW the rectangle was chosen, so it survives a
    // re-judgment; a measured warning would be recomputed from the stored numbers.
    expect(reused.warnings).toEqual<ImageIdentityPackWarningCode[]>(["heuristic_crop"]);
    expect(reused.pack.derivation.policyVersion).toBe("policy_v2");
    expect(await packRows(characterId)).toHaveLength(1);
  });
});

/**
 * Background preparation converging on the LATEST canonical portrait.
 *
 * The dedupe and the derivation are individually correct and used to combine into
 * a hole: portrait B's trigger correctly invalidates A's pack and is then
 * correctly deduped away by A's still-live job, whose derivation is about to lose
 * its finalize compare-and-set precisely because the character now names B.
 * Nothing prepared B. These cases drive the real job — the invalidation, the
 * dedupe, the job row, the loop — through `runIdentityPackPreparationForTesting`,
 * the awaitable form of the `void`-and-swallow production entry, and assert that
 * B ends up prepared with no `ensureIdentityPack` call of the test's own.
 */
describe.skipIf(!ready)("background preparation convergence", () => {
  it("prepares the portrait that was promoted while the earlier derivation was in flight", async () => {
    const subject = await seedSubject("Convergence Subject");
    const gate = gatedDetector();
    setIdentityFaceDetectorForTesting(gate.detector);

    const job = runIdentityPackPreparationForTesting(subject.characterId, userId);
    await waitForReservation(subject.characterId);

    // Portrait B lands and becomes canonical while A's derivation is parked, in
    // the order a promotion produces it: pointer committed, then preparation
    // requested.
    const second = await storePortrait(subject.characterId, await tintedPng(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 200));
    await repoint(subject.characterId, second.id);
    await runIdentityPackPreparationForTesting(subject.characterId, userId);

    // Suppressed by the live job, which is the behavior that made this a bug and
    // the behavior the loop below now makes safe. One job for the character, not
    // one per portrait change.
    expect(await packJobs(subject.characterId)).toHaveLength(1);

    gate.release();
    await job;

    const rows = await packRows(subject.characterId);
    const firstHash = await storedHash(subject.portrait);
    const secondHash = await storedHash(second);

    // A never became authoritative — its derivation lost the finalize
    // compare-and-set, which is correct, and nothing resurrected it.
    expect(rows.filter((row) => row.current)).toHaveLength(1);
    expect(rows.some((row) => row.current && row.sourceImageId === subject.portrait.id)).toBe(false);
    expect(rows.some((row) => row.current && row.sourceContentHash === firstHash)).toBe(false);

    // B is prepared, without the test ever calling `ensureIdentityPack`.
    const current = rows.find((row) => row.current);
    expect(current?.status).toBe("ready");
    expect(current?.sourceImageId).toBe(second.id);
    expect(current?.sourceContentHash).toBe(secondHash);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("stale");
    expect(rows[0]?.current).toBe(false);
    // Two detector runs for two portraits — the wasted one is A's lost race, not a
    // second job racing the first.
    expect(gate.calls()).toBe(2);

    // The job row is where an operator sees what background preparation did: which
    // source each pass targeted, and why it stopped.
    const [jobRow] = await packJobs(subject.characterId);
    expect(jobRow?.status).toBe("done");
    expect(jobRow?.payload).toMatchObject({
      characterId: subject.characterId,
      outcome: "ready",
      convergence: "converged",
      passes: [
        { sourceImageId: subject.portrait.id, outcome: "blocked", code: "source_changed" },
        { sourceImageId: second.id, outcome: "ready" },
      ],
    });

    // No hidden crop outlives its revision: A's died with the abandoned revision,
    // so once the diagnostic window elapses exactly the current pack's remains.
    await cleanupIdentityPackRevisions({
      now: new Date(Date.now() + IDENTITY_PACK_REVISION_RETENTION_MS + 60_000),
    });
    const crops = await cropRows(subject.characterId);
    expect(crops).toHaveLength(1);
    expect(crops[0]?.id).toBe(current?.faceCropImageId);
  }, 20_000);

  it("stops at the pass bound when the portrait keeps moving, and records that it did", async () => {
    const subject = await seedSubject("Runaway Repoint Subject");
    // A pointer that moves DURING every derivation, so each recheck sees a source
    // the pass that just ran never targeted. Arranging that by hand is otherwise a
    // race nobody can win reliably: a real derivation of a 384×512 portrait is a
    // few milliseconds.
    const secondPortrait = await storePortrait(subject.characterId, await tintedPng(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 40));
    const thirdPortrait = await storePortrait(subject.characterId, await tintedPng(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 80));
    const fourthPortrait = await storePortrait(subject.characterId, await tintedPng(PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 120));
    const replacements = [secondPortrait, thirdPortrait, fourthPortrait];
    let derivations = 0;
    setIdentityFaceDetectorForTesting(
      fakeDetector([], {
        onDetect: async () => {
          const next = replacements[derivations];
          derivations += 1;
          if (next) await repoint(subject.characterId, next.id);
        },
      }),
    );

    await runIdentityPackPreparationForTesting(subject.characterId, userId);

    // Bounded, and bounded by passes rather than by clicks: each pass targeted the
    // pointer as it stood when that pass began.
    expect(derivations).toBe(MAX_IDENTITY_PACK_PREPARATION_PASSES);
    const [jobRow] = await packJobs(subject.characterId);
    expect(jobRow?.status).toBe("done");
    expect(jobRow?.payload).toMatchObject({
      convergence: "unconverged",
      diagnostic: "images.identity_pack.source_changed",
      passes: [
        { sourceImageId: subject.portrait.id, outcome: "blocked", code: "source_changed" },
        { sourceImageId: secondPortrait.id, outcome: "blocked", code: "source_changed" },
        { sourceImageId: thirdPortrait.id, outcome: "blocked", code: "source_changed" },
      ],
    });

    // It gave up rather than looping: no current revision, and no crop bytes left
    // behind by the three that lost. The next trigger or the first identity render
    // picks this character up.
    const rows = await packRows(subject.characterId);
    expect(rows).toHaveLength(MAX_IDENTITY_PACK_PREPARATION_PASSES);
    expect(rows.every((row) => !row.current && row.status === "stale")).toBe(true);
    expect(await cropRows(subject.characterId)).toHaveLength(0);
    expect(await packJobs(subject.characterId)).toHaveLength(1);
  }, 20_000);
});
