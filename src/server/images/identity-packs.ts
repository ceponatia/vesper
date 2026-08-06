import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, count, eq, inArray, isNotNull, isNull, lt, max, or, sql } from "drizzle-orm";
import { z, type ZodType } from "zod";
import {
  imageIdentityPackQualitySchema,
  imageIdentityPackWarningCodeSchema,
  isAllowedIdentityPackTransition,
  sourcePixelCropSchema,
  type DetectedFaceCandidate,
  type EnsureIdentityPackInput,
  type EnsureIdentityPackResult,
  type IdentityPackIntrinsicPolicy,
  type ImageIdentityCropMethod,
  type ImageIdentityPackFailureCode,
  type ImageIdentityPackQuality,
  type ImageIdentityPackStatus,
  type ImageIdentityPackV1,
  type ImageIdentityPackWarningCode,
  type SourcePixelCrop,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { runInBatches } from "@/lib/batches";
import { parseOr, parseOrNull } from "@/lib/parse";
import {
  deriveDetectorCrop,
  heuristicCropV1,
  identityCropOutputSide,
  isHeuristicEligibleSource,
  normalizedCropToSourcePixels,
  squareSourcePixelCrop,
  validateIdentityCrop,
  type NormalizedCrop,
  type SourceDimensions,
} from "@/lib/images/identity-pack-crop";
import {
  buildIdentityPackQuality,
  evaluateIdentityPackIntrinsic,
  identityBlurScore,
  selectIdentityFaceCandidate,
} from "@/lib/images/identity-pack-quality";
import {
  HEURISTIC_V1,
  IDENTITY_CROP_POLICY_V1,
  IDENTITY_PACK_DERIVATION_VERSION,
  IDENTITY_PACK_POLICY_VERSION,
  IDENTITY_PACK_SCHEMA_VERSION,
  INTRINSIC_POLICY_V1,
  PROFILE_POLICY_DEFAULTS_V1,
} from "@/lib/images/identity-pack-policy";
import { characters, db, hasLiveCharacterJob, imageIdentityPacks, images, JOB_STALE_MS, jobs } from "../db";
import { log } from "@/server/log";
// Direct module path, NOT the `@/server/engine` barrel: that barrel re-exports
// `chat-pipeline.ts`, which imports `@/server/images` — so importing it here
// would close a real import cycle and fail `pnpm lint:cycles`. `keyed-lock.ts`
// itself imports nothing at all, so naming it directly adds no edge to the graph.
// (Worth relocating the lock to a neutral server home if a second image lane
// ever needs it.)
import { acquireKeyedLockWithin } from "../engine/keyed-lock";
import {
  createImageAsset,
  deleteOwnedImage,
  failImage,
  HIDDEN_IMAGE_KINDS,
  purgeImagesWhere,
  readImageBytes,
  registerIdentityPackMaintenance,
  saveImageBuffer,
  SHARP_DECODE_LIMITS,
  type ImageKind,
  type ImageRow,
} from "./assets";
import { identityFaceDetector } from "./identity-pack-detector";

/**
 * The identity-pack service: the one place a character's face reference is
 * derived, promoted, and read
 * (docs/developer-notes/image-identity-packs.spec.derivation.md and
 * `.spec.data.md`).
 *
 * Three invariants shape every function below.
 *
 * 1. **The pack row is authoritative; the crop's `images.meta` is provenance.**
 *    A reader discovers the current crop through this table, never by scanning
 *    image metadata — which is why current-selection, promotion and revision
 *    history live in relational columns rather than a blob.
 * 2. **Promotion is compare-and-set, never last-write-wins.** Both the reserve
 *    and the finalize take a per-character advisory lock and re-verify that the
 *    character still names the same source image and the bytes still hash the
 *    same. A derivation that loses that race cannot become current, and its
 *    hidden crop is removed immediately rather than left for a sweep to puzzle
 *    over.
 * 3. **Expected failure is a value, not an exception.** `blocked` is a normal
 *    outcome carrying an actionable code: an unusable pack has to reach the UI
 *    as product feedback ("use a clearer portrait") and has to stop a render
 *    BEFORE any provider budget is spent. Only genuinely unexpected throws are
 *    contained here, and they become a `failed` revision plus a log line.
 *
 * Derivation is bounded local work — read, hash, detect, crop, encode, measure —
 * so it runs synchronously for every caller. `EnsureIdentityPackResult` therefore
 * has no `pending` arm; the state exists in the table (a reserved revision from
 * another process) and is surfaced by {@link getIdentityPackForOwner}, which is
 * what a status view reads.
 */

export type IdentityPackRow = typeof imageIdentityPacks.$inferSelect;

/**
 * Whether render lanes may actually SEND identity references
 * (image-identity-packs.spec.integration.md §"Rollout flag"). Fail-closed, the
 * house convention for feature predicates: anything but the literal `on` is off.
 *
 * Deriving and storing packs is not gated — measurements are what the trial
 * needs, and a pack nobody sends costs a provider nothing.
 */
export function imageIdentityPackReferencesEnabled(): boolean {
  return process.env.IMAGE_IDENTITY_PACK_REFERENCES === "on";
}

/* ------------------------------------------------------------------------ *
 * Source identity                                                           *
 * ------------------------------------------------------------------------ */

/**
 * SHA-256 over the STORED normalized bytes — not the upload, not a re-encode.
 *
 * Vesper's write path already rasterizes everything to WebP, so this names the
 * exact durable input every later crop reads. A byte-level change invalidates
 * the pack even when the new portrait looks identical: the system must never
 * claim a crop was derived from bytes it did not read.
 */
export function sourceContentHashOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * The one spelling of the per-character derivation key.
 *
 * It lives here, alone, for the reason `chatExchangeLockKey` gives: the failure
 * mode of a second copy is silent. A lane that spells the prefix even slightly
 * differently takes a DIFFERENT lock, serializes against nobody, and looks
 * completely normal — no type error, no failing test, just two derivations
 * racing for one character's current row. The same string is also the advisory
 * lock key inside the promotion transactions, so the in-process and
 * cross-process guards cover exactly the same subject.
 */
export function identityPackLockKey(characterId: string): string {
  return `identity_pack:${characterId}`;
}

/** Test-only override; `null` restores `INTRINSIC_POLICY_V1`. Process-local. */
let injectedIntrinsicPolicy: IdentityPackIntrinsicPolicy | null = null;

/**
 * Swap the intrinsic thresholds for a scripted set, the same seam shape the
 * detector uses. Integration tests arm the blur/occlusion checks that policy_v1
 * deliberately leaves `null` — without it, the block-and-override paths cannot
 * be exercised at all until the trial calibrates real numbers, and an override
 * that has never once run is not a feature anyone should ship. Production never
 * calls it; pass `null` in teardown so one suite's policy cannot leak into the
 * next.
 */
export function setIdentityIntrinsicPolicyForTesting(policy: IdentityPackIntrinsicPolicy | null): void {
  injectedIntrinsicPolicy = policy;
}

/** The thresholds every evaluation in this module reads. */
function intrinsicPolicy(): IdentityPackIntrinsicPolicy {
  return injectedIntrinsicPolicy ?? INTRINSIC_POLICY_V1;
}

/* ------------------------------------------------------------------------ *
 * Row → contract                                                            *
 * ------------------------------------------------------------------------ */

const warningCodeListSchema = z.array(imageIdentityPackWarningCodeSchema);

interface JsonColumn<T> {
  value: T | null;
  /** The column held something, and it did not parse. Distinct from a stored null. */
  malformed: boolean;
}

/**
 * Read one jsonb column at the trust boundary, keeping "stored null" and
 * "stored garbage" apart. `parseOr` alone cannot: both would fall back to the
 * same value, and a pack whose crop rectangle is unreadable is a very different
 * thing from a pack that legitimately never had one.
 */
function readJsonColumn<T>(schema: ZodType<T>, raw: unknown, sink: DiagnosticSink | undefined, path: string): JsonColumn<T> {
  if (raw === null || raw === undefined) return { value: null, malformed: false };
  const parsed = parseOrNull(schema, raw, sink, path);
  return parsed === null ? { value: null, malformed: true } : { value: parsed, malformed: false };
}

/**
 * The stored row as the application contract.
 *
 * A row whose crop or quality JSON does not parse DEGRADES rather than throws
 * (docs/resilience.md §1): the contract comes back `unusable` with
 * `invalid_crop`, its face-detail pointer cleared, and a diagnostic recorded —
 * so a render route gets an honest refusal instead of an exception, and the next
 * `ensureIdentityPack` derives a fresh revision rather than trusting the wreck.
 *
 * `faceDetail.outputWidth/Height` are computed, not stored: the encoded side is
 * exactly the crop side capped by the derivation policy's storage ceiling, so
 * persisting it would be persisting a second copy of a derived number that could
 * drift from the file. They resolve only for rows stamped with the CURRENT
 * derivation version, since a future version's ceiling is not this one's.
 */
export function packRowToContract(row: IdentityPackRow, sink?: DiagnosticSink): ImageIdentityPackV1 {
  const crop = readJsonColumn(sourcePixelCropSchema, row.crop, sink, "image_identity_packs.crop_json");
  const quality = readJsonColumn(imageIdentityPackQualitySchema, row.quality, sink, "image_identity_packs.quality_json");
  const warningCodes = parseOr(
    warningCodeListSchema,
    row.warningCodes,
    [],
    sink,
    "image_identity_packs.warning_codes_json",
  );

  const degraded = crop.malformed || quality.malformed;
  if (degraded) {
    sink?.push(
      diag("warn", "images.identity_pack.invalid_crop", "stored pack measurements did not parse; treating as unusable", {
        path: "image_identity_packs",
        context: { packId: row.id, characterId: row.characterId, revision: row.revision },
      }),
    );
  }

  const outputSide =
    !degraded && crop.value && row.faceCropImageId && row.derivationVersion === IDENTITY_PACK_DERIVATION_VERSION
      ? identityCropOutputSide(crop.value.width, IDENTITY_CROP_POLICY_V1)
      : null;

  return {
    version: 1,
    id: row.id,
    characterId: row.characterId,
    revision: row.revision,
    current: row.current,
    status: degraded ? "unusable" : row.status,
    source: {
      imageId: row.sourceImageId,
      contentHash: row.sourceContentHash,
      width: row.sourceWidth,
      height: row.sourceHeight,
    },
    derivation: {
      schemaVersion: 1,
      derivationVersion: row.derivationVersion,
      policyVersion: row.policyVersion,
      method: row.method,
      detectorVersion: row.detectorVersion,
      confidence: row.confidence,
      createdAt: row.createdAt.toISOString(),
    },
    faceDetail: {
      imageId: degraded ? null : row.faceCropImageId,
      crop: crop.value,
      outputWidth: outputSide,
      outputHeight: outputSide,
    },
    quality: quality.value,
    warningCodes,
    failureCode: degraded ? "invalid_crop" : readFailureCode(row.failureCode),
    review: {
      actorUserId: row.reviewedByUserId,
      reason: row.reviewReason,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    },
  };
}

/**
 * The failure-code column is plain `text`, not a database enum, so an unknown
 * value is possible (an older or newer writer). It reads as "no code" rather
 * than being surfaced verbatim: the UI generates its copy from a stable code it
 * recognizes, and a string it does not is indistinguishable from none.
 */
function readFailureCode(raw: string | null): ImageIdentityPackFailureCode | null {
  return raw !== null && isFailureCode(raw) ? raw : null;
}

function isFailureCode(value: string): value is ImageIdentityPackFailureCode {
  switch (value) {
    case "source_missing":
    case "source_not_ready":
    case "source_unreadable":
    case "source_changed":
    case "no_usable_face":
    case "ambiguous_faces":
    case "invalid_crop":
    case "crop_too_small":
    case "crop_write_failed":
    case "derivation_failed":
      return true;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------------ *
 * Retry policy                                                              *
 * ------------------------------------------------------------------------ */

/**
 * Which failures a later attempt could plausibly fix
 * (`.spec.derivation.md` §"Retry policy").
 *
 * The split is between "the machinery stumbled" and "this source cannot yield a
 * usable face". A file read, a decode, a detector runtime error and a local
 * image write are all worth another go; ambiguous faces, a source with no
 * portrait to find, and invalid geometry are not, and retrying them just burns
 * work on every render request while producing the same answer.
 *
 * `source_changed` is retryable because the input ALREADY changed — the next
 * call derives against the new bytes and succeeds.
 */
export function isRetryableIdentityPackFailure(code: ImageIdentityPackFailureCode): boolean {
  switch (code) {
    case "source_not_ready":
    case "source_unreadable":
    case "source_changed":
    case "crop_write_failed":
    case "derivation_failed":
      return true;
    case "source_missing":
    case "no_usable_face":
    case "ambiguous_faces":
    case "invalid_crop":
    case "crop_too_small":
      return false;
  }
}

/** First retry waits this long; each further attempt doubles it. */
const RETRY_BASE_MS = 60_000;

/** Backoff ceiling — an hour is long enough that a wedged source costs nothing. */
const RETRY_MAX_MS = 60 * 60_000;

/**
 * Attempts against ONE set of source bytes before the service gives up and
 * reports the failure as terminal. A poison cap, not a quality bar: five
 * failures on identical input is evidence about this machine, not this portrait.
 */
const MAX_RETRY_ATTEMPTS = 5;

function retryBackoffMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * How many revisions this character already has for these exact bytes under
 * these exact versions.
 *
 * This IS the backoff state — deliberately derived from the revision rows rather
 * than stored in a column or a JSON blob. The spec allows either, but forbids
 * two independent schedulers, and the rows already carry everything needed: the
 * count is the attempt number and the newest row's `updated_at` is the last
 * attempt's clock. `image_identity_packs_derivation_idx` covers exactly this
 * predicate, so it is one index scan. `failure_message` stays human-oriented,
 * which is the whole reason not to hide machine state inside it.
 */
async function previousAttemptCount(characterId: string, sourceContentHash: string): Promise<number> {
  const [row] = await db()
    .select({ attempts: count() })
    .from(imageIdentityPacks)
    .where(
      and(
        eq(imageIdentityPacks.characterId, characterId),
        eq(imageIdentityPacks.sourceContentHash, sourceContentHash),
        eq(imageIdentityPacks.schemaVersion, IDENTITY_PACK_SCHEMA_VERSION),
        eq(imageIdentityPacks.derivationVersion, IDENTITY_PACK_DERIVATION_VERSION),
      ),
    );
  return row?.attempts ?? 0;
}

/* ------------------------------------------------------------------------ *
 * ensureIdentityPack                                                        *
 * ------------------------------------------------------------------------ */

/** How long a matching caller waits for the in-flight derivation to finish. */
const LOCK_TIMEOUT_MS = 30_000;

/** Poll interval while queueing behind the holder; derivation is seconds, not minutes. */
const LOCK_POLL_MS = 50;

interface ResolvedSource {
  imageRow: ImageRow;
  buffer: Buffer;
  contentHash: string;
  dimensions: SourceDimensions;
}

type ResolveSourceResult = { ok: true; source: ResolvedSource } | { ok: false; code: ImageIdentityPackFailureCode };

/**
 * Idempotent, authorization-aware pack preparation
 * (`.spec.derivation.md` §"`ensureIdentityPack`").
 *
 * The flow, and why each step exists:
 *
 * 1–2. Resolve the character from the OWNER (never from a pack or image id — a
 *      client-supplied pack id is a concurrency guard, not authorization), then
 *      read and hash the canonical portrait's stored bytes.
 * 3–5. Serialize on the character key, then answer from the current revision
 *      when it already covers these bytes and versions: a ready pack is
 *      returned as-is, a terminal refusal is returned WITHOUT a new attempt, and
 *      a retryable one waits out its backoff. This is what stops an unusable
 *      portrait from re-deriving on every render.
 * 6–7. Otherwise reserve a new current `pending` revision in a compare-and-set
 *      transaction that retires the previous one, then derive OUTSIDE that
 *      transaction — a detector and two sharp passes have no business holding a
 *      row lock.
 * 8–9. Finalize only if the character still names the same source AND the bytes
 *      still hash the same AND this revision is still the current pending one.
 *      Losing that race marks the revision stale and hard-deletes its hidden
 *      crop, because a crop nothing can point at is not evidence, it is litter.
 */
export async function ensureIdentityPack(input: EnsureIdentityPackInput): Promise<EnsureIdentityPackResult> {
  return runDerivation(input, { forceNewRevision: false });
}

interface DerivationOptions {
  /**
   * Skip the "is there already an answer?" step and always open a new revision.
   *
   * Only two callers want this, and both are explicit human acts: reset-to-automatic
   * (the owner discarded their manual crop) and an admin batch's `regenerate`. Every
   * other caller must NOT set it — re-deriving an unchanged source on every request is
   * exactly what the current-revision check exists to prevent.
   */
  forceNewRevision: boolean;
}

async function runDerivation(input: EnsureIdentityPackInput, opts: DerivationOptions): Promise<EnsureIdentityPackResult> {
  const { ownerId, characterId, sink } = input;
  try {
    const resolved = await resolveSource(ownerId, characterId, sink);
    if (!resolved.ok) {
      return { status: "blocked", pack: null, code: resolved.code, retryable: isRetryableIdentityPackFailure(resolved.code) };
    }

    const acquired = await acquireKeyedLockWithin(
      identityPackLockKey(characterId),
      () => derivePackUnderLock(input, resolved.source, opts),
      { timeoutMs: LOCK_TIMEOUT_MS, pollMs: LOCK_POLL_MS, label: input.purpose },
    );
    if (!acquired) {
      sink?.push(
        diag("warn", "images.identity_pack.pending_conflict", "another derivation held this character past the wait window", {
          context: { characterId, purpose: input.purpose },
        }),
      );
      return { status: "blocked", pack: null, code: "derivation_failed", retryable: true };
    }
    return await acquired.held;
  } catch (err) {
    // Containment boundary: nothing about a face crop may throw into a render
    // route or a portrait save (docs/resilience.md §"diagnostics over exceptions").
    log.warn("images", "identity pack preparation threw", {
      characterId,
      ownerId,
      error: errorMessage(err).slice(0, 300),
    });
    return { status: "blocked", pack: null, code: "derivation_failed", retryable: true };
  }
}

/**
 * The canonical source, verified end to end: the character is the caller's, the
 * image row is theirs AND belongs to this character, it is `ready`, its bytes
 * are readable, and it decodes to real dimensions.
 *
 * The entity check matters more than it looks. `entity_kind`/`entity_id` are the
 * only link between an image row and the character it depicts, and every writer
 * of `characters.avatar_image_id` maintains it — so a pointer that disagrees is
 * corruption, and deriving a face from it would attach one character's face to
 * another's pack. It fails closed as `source_missing`.
 */
async function resolveSource(
  ownerId: string,
  characterId: string,
  sink: DiagnosticSink | undefined,
): Promise<ResolveSourceResult> {
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  const avatarImageId = character?.avatarImageId ?? null;
  if (avatarImageId === null) {
    sink?.push(
      diag("warn", "images.identity_pack.source_missing", "no canonical portrait for this character", {
        context: { characterId },
      }),
    );
    return { ok: false, code: "source_missing" };
  }

  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, avatarImageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!row || row.entityKind !== "character" || row.entityId !== characterId) {
    sink?.push(
      diag("warn", "images.identity_pack.source_missing", "canonical portrait row is missing or not this character's", {
        context: { characterId, sourceImageId: avatarImageId },
      }),
    );
    return { ok: false, code: "source_missing" };
  }
  if (row.status !== "ready") return { ok: false, code: "source_not_ready" };

  const buffer = await readImageBytes(row);
  if (!buffer) return { ok: false, code: "source_unreadable" };
  const dimensions = await decodeDimensions(buffer);
  if (!dimensions) return { ok: false, code: "source_unreadable" };

  return { ok: true, source: { imageRow: row, buffer, contentHash: sourceContentHashOf(buffer), dimensions } };
}

async function decodeDimensions(buffer: Buffer): Promise<SourceDimensions | null> {
  try {
    const { width, height } = await sharp(buffer, SHARP_DECODE_LIMITS).metadata();
    if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Everything from "is there already an answer?" to "finalize", with the
 * character key held.
 *
 * In-process this is the single flight: matching callers queue on the key and
 * the second one finds the first's committed `ready` revision instead of
 * deriving the same crop again. Across processes the database is the authority —
 * the partial unique index on `current` and the compare-and-set inside both
 * transactions — because an in-process lock on one Fly machine proves nothing
 * about another.
 */
async function derivePackUnderLock(
  input: EnsureIdentityPackInput,
  source: ResolvedSource,
  opts: DerivationOptions,
): Promise<EnsureIdentityPackResult> {
  const { ownerId, characterId, sink } = input;
  const current = opts.forceNewRevision ? undefined : await currentPackRow(characterId);

  if (current && coversSource(current, source)) {
    const pack = packRowToContract(current, sink);
    // A row whose stored JSON did not parse reads as `unusable` regardless of its
    // column status. When those disagree the row is wreckage, not an answer:
    // fall through and derive a clean revision.
    if (pack.status === current.status) {
      const settled = await answerFromCurrent(current, pack, sink);
      if (settled) return settled;
    }
  }

  const reserved = await reservePendingRevision({ ownerId, characterId, source, sink });
  if (!reserved.ok) {
    return {
      status: "blocked",
      pack: null,
      code: reserved.code,
      retryable: isRetryableIdentityPackFailure(reserved.code),
    };
  }

  const patch = await deriveRevision({ ownerId, characterId, packId: reserved.row.id, source, sink });
  if (!isAllowedIdentityPackTransition("pending", patch.status)) {
    // Unreachable by construction (every patch status is a legal successor of
    // `pending`); if it ever fires, the state machine changed under this code and
    // the write must not happen.
    sink?.push(
      diag("error", "images.identity_pack.pending_conflict", `illegal transition pending -> ${patch.status}`, {
        context: { characterId, packId: reserved.row.id },
      }),
    );
    return { status: "blocked", pack: null, code: "derivation_failed", retryable: false };
  }

  const finalized = await finalizeRevision({ packId: reserved.row.id, characterId, ownerId, source, patch });
  if (!finalized) {
    await abandonRevision(reserved.row.id, ownerId, patch.faceCropImageId);
    sink?.push(
      diag("warn", "images.identity_pack.finalize_race", "the canonical source moved while this revision was deriving", {
        context: { characterId, packId: reserved.row.id, sourceImageId: source.imageRow.id },
      }),
    );
    return { status: "blocked", pack: null, code: "source_changed", retryable: true };
  }

  const pack = packRowToContract(finalized, sink);
  if (patch.status === "ready") return { status: "ready", pack, warnings: patch.warningCodes };
  const code = patch.failureCode ?? "derivation_failed";
  return { status: "blocked", pack, code, retryable: isRetryableIdentityPackFailure(code) };
}

/** Whether a revision was derived from exactly these bytes under these versions. */
function coversSource(row: IdentityPackRow, source: ResolvedSource): boolean {
  return (
    row.sourceImageId === source.imageRow.id &&
    row.sourceContentHash === source.contentHash &&
    row.schemaVersion === IDENTITY_PACK_SCHEMA_VERSION &&
    row.derivationVersion === IDENTITY_PACK_DERIVATION_VERSION
  );
}

/**
 * The answer already on record, or `null` when a fresh attempt is warranted.
 *
 * The `unusable`/`failed` arm is the no-retry-condition rule: nothing about the
 * input changed, so a terminal code is returned unchanged and a retryable one
 * only earns a new revision once its backoff has elapsed and the attempt cap is
 * not spent.
 */
async function answerFromCurrent(
  row: IdentityPackRow,
  pack: ImageIdentityPackV1,
  sink: DiagnosticSink | undefined,
): Promise<EnsureIdentityPackResult | null> {
  switch (row.status) {
    case "ready":
      return { status: "ready", pack, warnings: pack.warningCodes };
    case "pending": {
      // We hold the in-process key, so this reservation belongs to another
      // process. Only the database can arbitrate; do not race it — UNLESS it is
      // older than the job staleness bound, in which case its process is gone
      // (a deploy replaces the machine mid-derivation) and honouring it forever
      // would wedge this character's pack permanently. Same constant and same
      // reasoning as the job dedupe: one duplicate derivation after 15 minutes
      // costs far less than a feature that never works again.
      if (Date.now() - row.createdAt.getTime() < JOB_STALE_MS) {
        sink?.push(
          diag("warn", "images.identity_pack.pending_conflict", "another process holds a pending revision for this source", {
            context: { characterId: row.characterId, packId: row.id, revision: row.revision },
          }),
        );
        return { status: "blocked", pack, code: "derivation_failed", retryable: true };
      }
      return null;
    }
    case "unusable":
    case "failed": {
      const code = pack.failureCode ?? "derivation_failed";
      if (!isRetryableIdentityPackFailure(code)) return { status: "blocked", pack, code, retryable: false };
      const attempts = await previousAttemptCount(row.characterId, row.sourceContentHash);
      if (attempts >= MAX_RETRY_ATTEMPTS) return { status: "blocked", pack, code, retryable: false };
      const waited = Date.now() - row.updatedAt.getTime();
      if (waited < retryBackoffMs(attempts)) return { status: "blocked", pack, code, retryable: true };
      return null;
    }
    case "stale":
    case "superseded":
      // Terminal statuses cannot legally be current; fall through so the reserve
      // step reports the inconsistency rather than papering over it.
      return null;
  }
}

async function currentPackRow(characterId: string): Promise<IdentityPackRow | undefined> {
  const [row] = await db()
    .select()
    .from(imageIdentityPacks)
    .where(and(eq(imageIdentityPacks.characterId, characterId), eq(imageIdentityPacks.current, true)))
    .limit(1);
  return row;
}

/* ------------------------------------------------------------------------ *
 * Promotion                                                                 *
 * ------------------------------------------------------------------------ */

type ReserveResult =
  | { ok: true; row: IdentityPackRow }
  | { ok: false; code: Extract<ImageIdentityPackFailureCode, "source_changed" | "derivation_failed"> };

interface ReserveInput {
  ownerId: string;
  characterId: string;
  source: ResolvedSource;
  sink: DiagnosticSink | undefined;
}

/**
 * Retire the current revision and reserve the next one, atomically
 * (`.spec.data.md` §"Current-revision promotion").
 *
 * The advisory lock is the cross-process half of the single flight, taken on the
 * same key the in-process lock uses. Without it the conditional write does not
 * hold at READ COMMITTED — the same reasoning as `claimJobSlot`: two
 * transactions each read "one current row", each mark it stale, and both insert,
 * and only the partial unique index catches it, as a 500 rather than a decision.
 *
 * The retiring status is a real distinction, not bookkeeping: a revision for
 * DIFFERENT bytes becomes `stale` (the world moved on), one for the same bytes
 * becomes `superseded` (we chose to redo it). An illegal transition means the
 * current row is already terminal, which is corruption — it is reported and the
 * write is refused rather than repaired, so the sweep can still see it.
 */
async function reservePendingRevision(input: ReserveInput): Promise<ReserveResult> {
  const { ownerId, characterId, source, sink } = input;
  return db().transaction(async (tx): Promise<ReserveResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityPackLockKey(characterId)}, 0))`);

    const [character] = await tx
      .select({ avatarImageId: characters.avatarImageId })
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
      .limit(1);
    if (!character || character.avatarImageId !== source.imageRow.id) {
      sink?.push(
        diag("warn", "images.identity_pack.source_changed", "the canonical portrait moved before this revision was reserved", {
          context: { characterId, sourceImageId: source.imageRow.id },
        }),
      );
      return { ok: false, code: "source_changed" };
    }

    const [current] = await tx
      .select()
      .from(imageIdentityPacks)
      .where(and(eq(imageIdentityPacks.characterId, characterId), eq(imageIdentityPacks.current, true)))
      .limit(1);
    if (current) {
      // `superseded` means "we chose to redo a finished claim"; a revision that
      // never finished has no claim to supersede, and `pending -> superseded` is
      // not a legal transition — an abandoned reservation goes `stale` like any
      // other overtaken row.
      const retired: ImageIdentityPackStatus =
        current.status === "pending" || current.sourceContentHash !== source.contentHash ? "stale" : "superseded";
      if (!isAllowedIdentityPackTransition(current.status, retired)) {
        sink?.push(
          diag("error", "images.identity_pack.pending_conflict", `current revision cannot retire: ${current.status} -> ${retired}`, {
            context: { characterId, packId: current.id, revision: current.revision },
          }),
        );
        return { ok: false, code: "derivation_failed" };
      }
      await tx
        .update(imageIdentityPacks)
        .set({ current: false, status: retired })
        .where(and(eq(imageIdentityPacks.id, current.id), eq(imageIdentityPacks.current, true)));
    }

    const [highest] = await tx
      .select({ revision: max(imageIdentityPacks.revision) })
      .from(imageIdentityPacks)
      .where(eq(imageIdentityPacks.characterId, characterId));

    const [inserted] = await tx
      .insert(imageIdentityPacks)
      .values({
        characterId,
        revision: (highest?.revision ?? 0) + 1,
        current: true,
        status: "pending",
        sourceImageId: source.imageRow.id,
        sourceContentHash: source.contentHash,
        sourceWidth: source.dimensions.width,
        sourceHeight: source.dimensions.height,
        schemaVersion: IDENTITY_PACK_SCHEMA_VERSION,
        derivationVersion: IDENTITY_PACK_DERIVATION_VERSION,
        policyVersion: IDENTITY_PACK_POLICY_VERSION,
      })
      .returning();
    if (!inserted) return { ok: false, code: "derivation_failed" };
    return { ok: true, row: inserted };
  });
}

interface FinalizeInput {
  packId: string;
  characterId: string;
  ownerId: string;
  source: ResolvedSource;
  patch: RevisionPatch;
}

/**
 * Write the derived result onto the reserved revision, or refuse.
 *
 * Three things must still hold: the character names the same source image, the
 * file still hashes to the same bytes, and this revision is still the current
 * `pending` one. The re-hash is not paranoia — a portrait can be replaced in
 * place while a derivation runs, and a crop promoted from bytes nobody read is
 * precisely the lie `source_content_hash` exists to prevent. Returns the
 * finalized row, or `null` when the compare-and-set lost.
 */
async function finalizeRevision(input: FinalizeInput): Promise<IdentityPackRow | null> {
  const { packId, characterId, ownerId, source, patch } = input;
  const fresh = await readImageBytes(source.imageRow);
  if (!fresh || sourceContentHashOf(fresh) !== source.contentHash) return null;

  return db().transaction(async (tx): Promise<IdentityPackRow | null> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityPackLockKey(characterId)}, 0))`);
    const [character] = await tx
      .select({ avatarImageId: characters.avatarImageId })
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
      .limit(1);
    if (!character || character.avatarImageId !== source.imageRow.id) return null;

    const [updated] = await tx
      .update(imageIdentityPacks)
      .set({
        status: patch.status,
        method: patch.method,
        detectorVersion: patch.detectorVersion,
        confidence: patch.confidence,
        faceCropImageId: patch.faceCropImageId,
        crop: patch.crop,
        quality: patch.quality,
        warningCodes: patch.warningCodes,
        failureCode: patch.failureCode,
        failureMessage: patch.failureMessage,
        // Written on every finalize, null for an automatic revision: the review
        // columns say "a human authored or waived this", and a stale value
        // inherited from a previous write would say it about a machine crop.
        reviewedByUserId: patch.review?.actorUserId ?? null,
        reviewReason: patch.review?.reason ?? null,
        reviewedAt: patch.review ? new Date() : null,
      })
      .where(
        and(
          eq(imageIdentityPacks.id, packId),
          eq(imageIdentityPacks.current, true),
          eq(imageIdentityPacks.status, "pending"),
        ),
      )
      .returning();
    return updated ?? null;
  });
}

/**
 * Retire a revision that lost finalization and remove its crop immediately.
 *
 * `current` is cleared as well as the status set: a row that is both `current`
 * and `stale` is a contradiction the next reserve would refuse to retire,
 * wedging the character permanently. The crop is hard-deleted rather than left
 * to the retention window because it has no valid consumer at all — no pack row
 * will ever point at it (spec.lifecycle.md §"Superseded and failed revision
 * cleanup").
 */
async function abandonRevision(packId: string, ownerId: string, cropImageId: string | null): Promise<void> {
  await db()
    .update(imageIdentityPacks)
    .set({ current: false, status: "stale" })
    .where(and(eq(imageIdentityPacks.id, packId), eq(imageIdentityPacks.status, "pending")));
  if (cropImageId) await deleteOwnedImage(cropImageId, ownerId, { kind: "identity_face_crop" });
}

/* ------------------------------------------------------------------------ *
 * Derivation                                                                *
 * ------------------------------------------------------------------------ */

/** The columns a finished derivation writes onto its reserved revision. */
interface RevisionPatch {
  status: Extract<ImageIdentityPackStatus, "ready" | "unusable" | "failed">;
  method: ImageIdentityCropMethod | null;
  detectorVersion: string | null;
  confidence: number | null;
  faceCropImageId: string | null;
  crop: SourcePixelCrop | null;
  quality: ImageIdentityPackQuality | null;
  warningCodes: ImageIdentityPackWarningCode[];
  failureCode: ImageIdentityPackFailureCode | null;
  failureMessage: string | null;
  /** Non-null only on a human-authored revision (a manual crop or a recorded override). */
  review: { actorUserId: string; reason: string | null } | null;
}

/** The refusals derivation itself can reach — each has a matching diagnostic code. */
type CropRefusalCode = Extract<
  ImageIdentityPackFailureCode,
  "no_usable_face" | "ambiguous_faces" | "invalid_crop" | "crop_too_small"
>;

/**
 * A revision that produced no usable reference. `crop_write_failed` and
 * `derivation_failed` are `failed` (the machinery broke); everything else is
 * `unusable` (this source cannot yield a face reference). Measurements taken
 * before the refusal are carried through in `over` — a blocked pack that
 * recorded WHY is what lets a later policy version re-judge it.
 */
function refusedRevision(
  code: ImageIdentityPackFailureCode,
  message: string,
  over: Partial<RevisionPatch> = {},
): RevisionPatch {
  return {
    status: code === "crop_write_failed" || code === "derivation_failed" ? "failed" : "unusable",
    method: null,
    detectorVersion: null,
    confidence: null,
    faceCropImageId: null,
    crop: null,
    quality: null,
    warningCodes: [],
    failureCode: code,
    failureMessage: message.slice(0, 500),
    review: null,
    ...over,
  };
}

interface DeriveInput {
  ownerId: string;
  characterId: string;
  packId: string;
  source: ResolvedSource;
  sink: DiagnosticSink | undefined;
}

/**
 * Detector → candidate ruling → crop geometry → encode → measure → evaluate →
 * hidden asset. Runs outside every transaction.
 *
 * Ordering is load-bearing. The crop image row is reserved only once the
 * rectangle is valid AND the measurements clear the intrinsic policy, so a
 * refused revision never leaves a hidden file nobody will use; and the buffer is
 * measured before it is stored, because the blur score describes the bytes a
 * provider will see, not the source they came from.
 */
async function deriveRevision(input: DeriveInput): Promise<RevisionPatch> {
  const { source, sink, characterId } = input;
  const detector = identityFaceDetector();

  let candidates: DetectedFaceCandidate[];
  try {
    candidates = await detector.detect(source.buffer);
  } catch (err) {
    const message = errorMessage(err);
    log.warn("images", "identity face detector threw; revision failed", {
      characterId,
      detector: detector.version,
      error: message.slice(0, 300),
    });
    return refusedRevision("derivation_failed", message);
  }

  const plan = planIdentityCrop(candidates, source.dimensions, detector.version);
  if (!plan.ok) {
    pushRefusal(sink, plan.code, plan.message, characterId);
    return refusedRevision(plan.code, plan.message);
  }

  let encoded: EncodedCrop;
  try {
    encoded = await encodeAndMeasureCrop(source.buffer, plan.crop);
  } catch (err) {
    const message = errorMessage(err);
    log.warn("images", "identity crop encode/measure threw; revision failed", {
      characterId,
      error: message.slice(0, 300),
    });
    return refusedRevision("derivation_failed", message, { method: plan.method, crop: plan.crop });
  }

  const quality = buildIdentityPackQuality({
    crop: plan.crop,
    detectedFaces: plan.detectedFaces,
    faceBox: plan.faceBox,
    blurScore: encoded.blurScore,
    occlusionScore: plan.occlusionScore,
  });
  const evaluation = evaluateIdentityPackIntrinsic({ method: plan.method, crop: plan.crop, quality }, intrinsicPolicy());
  // Measurements are kept whatever the verdict — that is the point of storing
  // them rather than a boolean (`.spec.derivation.md` §"Intrinsic quality
  // measurement"): a threshold change must be able to re-judge this revision.
  const measured: Partial<RevisionPatch> = {
    method: plan.method,
    detectorVersion: plan.detectorVersion,
    confidence: plan.confidence,
    crop: plan.crop,
    quality,
    warningCodes: evaluation.warnings,
  };

  const blocker = evaluation.blockers[0];
  if (blocker !== undefined) {
    const code = narrowCropCode(blocker);
    const message = `intrinsic policy ${evaluation.policyVersion} blocked the crop: ${evaluation.blockers.join(", ")}`;
    pushRefusal(sink, code, message, characterId);
    return refusedRevision(code, message, measured);
  }

  const stored = await storeHiddenCropAsset({
    ownerId: input.ownerId,
    characterId,
    packId: input.packId,
    source,
    crop: plan.crop,
    buffer: encoded.buffer,
    sink,
  });
  if (!stored.ok) return refusedRevision("crop_write_failed", stored.message, measured);

  return {
    status: "ready",
    method: plan.method,
    detectorVersion: plan.detectorVersion,
    confidence: plan.confidence,
    faceCropImageId: stored.imageId,
    crop: plan.crop,
    quality,
    warningCodes: evaluation.warnings,
    failureCode: null,
    failureMessage: null,
    review: null,
  };
}

interface HiddenCropAssetInput {
  ownerId: string;
  characterId: string;
  packId: string;
  source: ResolvedSource;
  crop: SourcePixelCrop;
  buffer: Buffer;
  sink: DiagnosticSink | undefined;
}

/**
 * Reserve the hidden crop row, write its file, or report the failure — the one
 * copy of that sequence, shared by automatic derivation and the manual editor so
 * the two can never drift on what a face-crop asset records.
 *
 * The meta block is the crop's provenance (spec.data.md §"Hidden image asset"),
 * deliberately duplicating what the pack row already says: the pack row is the
 * authority, and this is what lets an operator reading `images` alone tell a
 * derived internal input from a user's portrait. A write failure fails the row
 * rather than leaving a `pending` one behind — the pack must never end up ready
 * with a missing file.
 */
async function storeHiddenCropAsset(
  input: HiddenCropAssetInput,
): Promise<{ ok: true; imageId: string } | { ok: false; message: string }> {
  const { ownerId, characterId, packId, source, crop, sink } = input;
  const asset = await createImageAsset({
    ownerId,
    kind: "identity_face_crop",
    entityKind: "character",
    entityId: characterId,
    sourceImageId: source.imageRow.id,
    meta: {
      hidden: true,
      identityPackId: packId,
      identityRole: "face_detail",
      sourceContentHash: source.contentHash,
      crop,
      derivationVersion: IDENTITY_PACK_DERIVATION_VERSION,
    },
  });
  const saved = await saveImageBuffer(asset.id, input.buffer, sink);
  if (saved?.status !== "ready") {
    const message = "identity face crop could not be written";
    await failImage(asset.id, message);
    sink?.push(
      diag("warn", "images.identity_pack.crop_write_failed", message, {
        context: { characterId, packId, imageId: asset.id },
      }),
    );
    return { ok: false, message };
  }
  return { ok: true, imageId: asset.id };
}

interface EncodedCrop {
  buffer: Buffer;
  blurScore: number | null;
}

/**
 * Cut, encode and measure one rectangle. Both proposers (detector/heuristic and
 * the manual editor) go through this, in this order, because the blur score must
 * describe the bytes a provider will actually receive rather than the source they
 * were cut from. Throws only on a genuine sharp failure; the callers convert that
 * into a failed revision.
 */
async function encodeAndMeasureCrop(sourceBuffer: Buffer, crop: SourcePixelCrop): Promise<EncodedCrop> {
  const outputSide = identityCropOutputSide(crop.width, IDENTITY_CROP_POLICY_V1);
  const buffer = await extractIdentityCrop(sourceBuffer, crop, outputSide);
  return { buffer, blurScore: await measureBlur(buffer) };
}

type CropPlan =
  | {
      ok: true;
      crop: SourcePixelCrop;
      method: ImageIdentityCropMethod;
      detectorVersion: string | null;
      confidence: number | null;
      faceBox: SourcePixelCrop | null;
      occlusionScore: number | null;
      detectedFaces: number;
    }
  | { ok: false; code: CropRefusalCode; message: string };

/**
 * Which rectangle this revision gets, or why it gets none.
 *
 * Three outcomes, in the order the spec rules them:
 *
 * - **one confident face and nothing else plausible** → the versioned detector
 *   expansion, which refuses rather than clipping when the source cannot give
 *   back the hairline and jaw padding it asked for;
 * - **more than one plausible face** → `ambiguous_faces`. The service never
 *   picks the largest, most central or most confident face out of a crowd,
 *   because doing so would put a stranger's face in every future render of that
 *   character, silently, and nobody would know to look;
 * - **nothing seen at all** → the deterministic heuristic, and ONLY then. A
 *   detector that saw a face it could not confirm is evidence against guessing:
 *   a centred square would be a guess made against the one observation available.
 */
function planIdentityCrop(
  candidates: readonly DetectedFaceCandidate[],
  source: SourceDimensions,
  detectorVersion: string,
): CropPlan {
  const detectedFaces = candidates.length;
  const selection = selectIdentityFaceCandidate(candidates, intrinsicPolicy());

  if (selection.ok) {
    const derived = deriveDetectorCrop(selection.primary.box, source, IDENTITY_CROP_POLICY_V1);
    if (!derived.ok) {
      return {
        ok: false,
        code: narrowCropCode(derived.code),
        message: `detector crop refused for a ${source.width}x${source.height} source`,
      };
    }
    return {
      ok: true,
      crop: derived.geometry.crop,
      method: "detector",
      detectorVersion,
      confidence: selection.primary.confidence,
      faceBox: selection.primary.box,
      occlusionScore: selection.primary.occlusionScore ?? null,
      detectedFaces,
    };
  }

  if (selection.code === "ambiguous_faces") {
    return {
      ok: false,
      code: "ambiguous_faces",
      message: `${selection.accepted} confident and ${selection.plausibleAdditional} additional plausible faces — a human must choose`,
    };
  }
  if (selection.plausibleAdditional > 0) {
    return {
      ok: false,
      code: "no_usable_face",
      message: `${selection.plausibleAdditional} unconfirmed face(s) seen; the heuristic would guess against the evidence`,
    };
  }
  if (!isHeuristicEligibleSource(source, HEURISTIC_V1)) {
    return {
      ok: false,
      code: "no_usable_face",
      message: `a ${source.width}x${source.height} source is not portrait-shaped enough for the ${HEURISTIC_V1.id} fallback`,
    };
  }
  const crop = heuristicCropV1(source, HEURISTIC_V1);
  if (!crop) return { ok: false, code: "no_usable_face", message: `${HEURISTIC_V1.id} produced no rectangle` };
  const validation = validateIdentityCrop(crop, source, IDENTITY_CROP_POLICY_V1);
  if (!validation.ok) {
    return { ok: false, code: narrowCropCode(validation.code), message: `${HEURISTIC_V1.id} crop rejected: ${validation.reason}` };
  }
  return {
    ok: true,
    crop,
    method: "heuristic",
    detectorVersion: null,
    confidence: null,
    faceBox: null,
    occlusionScore: null,
    detectedFaces,
  };
}

/**
 * The pure geometry and policy layers type their refusals as the whole failure
 * vocabulary; only these four can actually come out of them. Anything else would
 * be a contract change, and reading it as `invalid_crop` keeps the diagnostic
 * honest instead of inventing a code.
 */
function narrowCropCode(code: ImageIdentityPackFailureCode): CropRefusalCode {
  switch (code) {
    case "no_usable_face":
    case "ambiguous_faces":
    case "invalid_crop":
    case "crop_too_small":
      return code;
    case "source_missing":
    case "source_not_ready":
    case "source_unreadable":
    case "source_changed":
    case "crop_write_failed":
    case "derivation_failed":
      return "invalid_crop";
  }
}

/** One diagnostic per refusal, on the stable `images.identity_pack.*` codes. */
function pushRefusal(sink: DiagnosticSink | undefined, code: CropRefusalCode, message: string, characterId: string): void {
  sink?.push(diag("warn", `images.identity_pack.${code}`, message, { context: { characterId } }));
}

/**
 * Cut the crop and encode it at the stored ceiling.
 *
 * `withoutEnlargement` is the load-bearing option: a small crop stays small.
 * Upscaling it to a rounder number would make the reference LOOK higher
 * resolution than the bytes behind it, which is exactly the lie the
 * effective-size evaluation exists to catch downstream.
 */
async function extractIdentityCrop(sourceBuffer: Buffer, crop: SourcePixelCrop, outputSide: number): Promise<Buffer> {
  return sharp(sourceBuffer, SHARP_DECODE_LIMITS)
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(outputSide, outputSide, { fit: "cover", withoutEnlargement: true })
    .toBuffer();
}

/** Blur is scored on the ENCODED crop — the bytes a provider actually receives. */
async function measureBlur(cropBuffer: Buffer): Promise<number | null> {
  const { data, info } = await sharp(cropBuffer, SHARP_DECODE_LIMITS).raw().toBuffer({ resolveWithObject: true });
  return identityBlurScore({ data, width: info.width, height: info.height, channels: info.channels });
}

/* ------------------------------------------------------------------------ *
 * Owner-safe read                                                           *
 * ------------------------------------------------------------------------ */

export interface IdentityPackSummary {
  /** Null until this character has any revision at all. */
  pack: ImageIdentityPackV1 | null;
  /** The character's canonical portrait right now, whatever the pack says. */
  sourceImageId: string | null;
  current: boolean;
  /**
   * The revision no longer describes the character's canonical source. Computed
   * from ids and versions only — byte-level staleness costs a file read and a
   * hash, so it is confirmed by `ensureIdentityPack`, not by a status poll.
   */
  stale: boolean;
  /** Derivation is reserved and running — the state the ensure contract has no arm for. */
  pending: boolean;
  /** What to tell the owner, and whether asking again could change the answer. */
  failureCode: ImageIdentityPackFailureCode | null;
  retryable: boolean;
  warnings: ImageIdentityPackWarningCode[];
}

/**
 * The owner's view of their character's pack. `null` when the character is not
 * theirs — the caller turns that into the same not-found a nonexistent character
 * gets, so a pack's existence never leaks (spec.lifecycle.md §"Authorization
 * root": every operation starts from an authorized CHARACTER, never from a bare
 * pack or image id).
 */
export async function getIdentityPackForOwner(
  characterId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<IdentityPackSummary | null> {
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!character) return null;

  const row = await currentPackRow(characterId);
  if (!row) {
    return {
      pack: null,
      sourceImageId: character.avatarImageId,
      current: false,
      stale: false,
      pending: false,
      failureCode: null,
      retryable: false,
      warnings: [],
    };
  }

  const pack = packRowToContract(row, sink);
  const failureCode = pack.failureCode;
  return {
    pack,
    sourceImageId: character.avatarImageId,
    current: row.current,
    stale:
      row.status === "stale" ||
      row.status === "superseded" ||
      row.sourceImageId !== character.avatarImageId ||
      row.schemaVersion !== IDENTITY_PACK_SCHEMA_VERSION ||
      row.derivationVersion !== IDENTITY_PACK_DERIVATION_VERSION,
    pending: pack.status === "pending",
    failureCode,
    retryable: failureCode === null ? false : isRetryableIdentityPackFailure(failureCode),
    warnings: pack.warningCodes,
  };
}

/* ------------------------------------------------------------------------ *
 * Manual correction                                                         *
 * ------------------------------------------------------------------------ */

/**
 * How the client expressed its rectangle.
 *
 * Tagged rather than inferred: `{ left: 0.25, … }` and `{ left: 25, … }` are both
 * legal rectangles in their own space, and guessing which one a client meant from
 * the magnitude of its numbers would be a coin flip that silently crops the wrong
 * part of somebody's face. The editor sends normalized coordinates (they survive a
 * re-encode at another size); the server resolves and persists source pixels.
 */
export type ManualIdentityCropInput =
  | { space: "normalized"; crop: NormalizedCrop }
  | { space: "source_pixels"; crop: SourcePixelCrop };

export interface SaveManualIdentityCropInput {
  ownerId: string;
  characterId: string;
  /** The pack the editor was opened on — a concurrency guard, never authorization. */
  expectedPackId: string;
  expectedRevision: number;
  /** The source hash the editor framed against. A mismatch is a reload, not a save. */
  expectedSourceHash: string;
  crop: ManualIdentityCropInput;
  /** The signed-in user behind this revision; recorded on the row for audit. */
  actorUserId: string;
  reason?: string;
  /** Ask to waive reviewed quality thresholds. Requires a reason and a permitting policy. */
  adminOverride?: boolean;
  sink?: DiagnosticSink;
}

/** Why the save was refused before touching anything. All three mean "reload and retry". */
export type ManualIdentityCropConflict = "pack_changed" | "source_changed" | "busy";

/**
 * Why a crop the client CAN retry differently was refused. `invalid_geometry` and
 * `policy_blocked` are about the rectangle; the two override reasons are about the
 * request that tried to waive a blocker.
 */
export type ManualIdentityCropRejection =
  | "invalid_geometry"
  | "policy_blocked"
  | "override_not_permitted"
  | "override_reason_required";

export type SaveManualIdentityCropResult =
  | { status: "ready"; pack: ImageIdentityPackV1; warnings: ImageIdentityPackWarningCode[] }
  | {
      status: "conflict";
      reason: ManualIdentityCropConflict;
      /** What the client should reload to: the pack and bytes that are current NOW. */
      currentPackId: string | null;
      currentRevision: number | null;
      sourceContentHash: string | null;
    }
  | {
      status: "rejected";
      reason: ManualIdentityCropRejection;
      code: ImageIdentityPackFailureCode;
      /** Every measured blocker, not just the first — the editor explains all of them. */
      blockers: ImageIdentityPackFailureCode[];
      message: string;
    }
  | { status: "blocked"; code: ImageIdentityPackFailureCode; retryable: boolean };

/**
 * Save a human-authored crop as a new `manual` revision
 * (`.spec.derivation.md` §"Manual crop revisions").
 *
 * The order is the spec's, and each step exists to stop a specific way this could
 * go wrong:
 *
 * 1. **Re-authorize from the character** and re-read the canonical bytes. The
 *    client's pack id proves nothing about who may write here.
 * 2. **Refuse a stale editor.** If the current pack, its revision, or the source
 *    hash moved since the editor opened, the answer is a conflict carrying the
 *    CURRENT ids — applying old coordinates to new bytes would frame a rectangle
 *    the user never saw onto a portrait they never cropped.
 * 3. **Validate the rectangle**, then measure the crop it actually produces.
 *    Bounds, minimum size and squareness are hard gates: a correction may fix
 *    framing, never bypass geometry, and an owner crop that is still intrinsically
 *    unusable comes back with the measured reason rather than being stored.
 * 4. **Reserve, store, promote** through the same compare-and-set path automatic
 *    derivation uses, so the previous revision is superseded atomically and a lost
 *    race deletes the orphaned crop instead of leaving it.
 *
 * A rejection touches no rows at all: the previous pack stays current and usable,
 * which is the difference between "your crop was refused" and "your crop broke
 * your character".
 */
export async function saveManualIdentityCrop(input: SaveManualIdentityCropInput): Promise<SaveManualIdentityCropResult> {
  const { ownerId, characterId, sink } = input;
  try {
    const resolved = await resolveSource(ownerId, characterId, sink);
    if (!resolved.ok) {
      return { status: "blocked", code: resolved.code, retryable: isRetryableIdentityPackFailure(resolved.code) };
    }
    const source = resolved.source;

    const acquired = await acquireKeyedLockWithin(
      identityPackLockKey(characterId),
      () => saveManualCropUnderLock(input, source),
      { timeoutMs: LOCK_TIMEOUT_MS, pollMs: LOCK_POLL_MS, label: "manual_crop" },
    );
    if (!acquired) return manualConflict("busy", undefined, source);
    return await acquired.held;
  } catch (err) {
    // Same containment boundary as `ensureIdentityPack`: a crop editor save must
    // fail as a value, never as a 500 (docs/resilience.md §1).
    log.warn("images", "manual identity crop threw", {
      characterId,
      ownerId,
      error: errorMessage(err).slice(0, 300),
    });
    return { status: "blocked", code: "derivation_failed", retryable: true };
  }
}

async function saveManualCropUnderLock(
  input: SaveManualIdentityCropInput,
  source: ResolvedSource,
): Promise<SaveManualIdentityCropResult> {
  const { ownerId, characterId, sink } = input;
  const current = await currentPackRow(characterId);

  if (!current || current.id !== input.expectedPackId || current.revision !== input.expectedRevision) {
    return manualConflict("pack_changed", current, source);
  }
  if (
    source.contentHash !== input.expectedSourceHash ||
    current.sourceContentHash !== source.contentHash ||
    current.sourceImageId !== source.imageRow.id
  ) {
    sink?.push(
      diag("warn", "images.identity_pack.source_changed", "the editor's coordinates describe bytes that are no longer stored", {
        context: { characterId, packId: current.id, revision: current.revision },
      }),
    );
    return manualConflict("source_changed", current, source);
  }

  const geometry = resolveManualCrop(input.crop, source.dimensions);
  if (!geometry.ok) {
    return {
      status: "rejected",
      reason: "invalid_geometry",
      code: geometry.code,
      blockers: [geometry.code],
      message: `manual crop rejected: ${geometry.reason}`,
    };
  }
  const crop = geometry.crop;

  let encoded: EncodedCrop;
  try {
    encoded = await encodeAndMeasureCrop(source.buffer, crop);
  } catch (err) {
    log.warn("images", "manual identity crop encode/measure threw", {
      characterId,
      error: errorMessage(err).slice(0, 300),
    });
    return { status: "blocked", code: "derivation_failed", retryable: true };
  }

  // No detector ran on a hand-drawn rectangle, so every face-derived metric is
  // genuinely unknown — null, never 0, or a later policy version would read a
  // measured zero-pixel face and block a crop nobody ever examined.
  const quality = buildIdentityPackQuality({
    crop,
    detectedFaces: null,
    faceBox: null,
    blurScore: encoded.blurScore,
    occlusionScore: null,
  });
  const policy = intrinsicPolicy();
  const evaluation = evaluateIdentityPackIntrinsic({ method: "manual", crop, quality }, policy);
  const ruling = ruleManualBlockers(evaluation.blockers, input);
  if (!ruling.ok) return ruling.rejected;

  const override = ruling.override;
  const warningCodes =
    override && !evaluation.warnings.includes("manual_admin_override")
      ? [...evaluation.warnings, "manual_admin_override" as const]
      : evaluation.warnings;
  const trimmedReason = input.reason?.trim() ?? "";
  const review = { actorUserId: input.actorUserId, reason: trimmedReason.length > 0 ? trimmedReason : null };

  const reserved = await reservePendingRevision({ ownerId, characterId, source, sink });
  if (!reserved.ok) {
    return reserved.code === "source_changed"
      ? manualConflict("source_changed", current, source)
      : { status: "blocked", code: reserved.code, retryable: isRetryableIdentityPackFailure(reserved.code) };
  }

  const stored = await storeHiddenCropAsset({
    ownerId,
    characterId,
    packId: reserved.row.id,
    source,
    crop,
    buffer: encoded.buffer,
    sink,
  });
  const patch: RevisionPatch = stored.ok
    ? {
        status: "ready",
        method: "manual",
        detectorVersion: null,
        confidence: null,
        faceCropImageId: stored.imageId,
        crop,
        quality,
        warningCodes,
        failureCode: null,
        // The override does not change the measurements, so what it WAIVED is
        // recorded here rather than being lost: a ready revision's failure
        // message is the audit trail for a blocker somebody accepted.
        failureMessage: override ? `${policy.version} blockers waived: ${override.blockers.join(", ")}` : null,
        review,
      }
    : refusedRevision("crop_write_failed", stored.message, { method: "manual", crop, quality, review });

  const finalized = await finalizeRevision({ packId: reserved.row.id, characterId, ownerId, source, patch });
  if (!finalized) {
    await abandonRevision(reserved.row.id, ownerId, patch.faceCropImageId);
    sink?.push(
      diag("warn", "images.identity_pack.finalize_race", "the canonical source moved while the manual crop was being stored", {
        context: { characterId, packId: reserved.row.id },
      }),
    );
    return manualConflict("source_changed", undefined, source);
  }
  if (patch.status !== "ready") {
    const code = patch.failureCode ?? "derivation_failed";
    return { status: "blocked", code, retryable: isRetryableIdentityPackFailure(code) };
  }

  if (override) {
    sink?.push(
      diag("warn", "images.identity_pack.manual_override", `admin override waived ${override.blockers.join(", ")}`, {
        context: {
          characterId,
          packId: finalized.id,
          revision: finalized.revision,
          actorUserId: input.actorUserId,
          policyVersion: policy.version,
        },
      }),
    );
  }
  const pack = packRowToContract(finalized, sink);
  return { status: "ready", pack, warnings: pack.warningCodes };
}

function manualConflict(
  reason: ManualIdentityCropConflict,
  current: IdentityPackRow | undefined,
  source: ResolvedSource,
): SaveManualIdentityCropResult {
  return {
    status: "conflict",
    reason,
    currentPackId: current?.id ?? null,
    currentRevision: current?.revision ?? null,
    sourceContentHash: source.contentHash,
  };
}

type ResolvedManualCrop =
  | { ok: true; crop: SourcePixelCrop }
  | { ok: false; code: ImageIdentityPackFailureCode; reason: string };

/**
 * Client coordinates → the integer source-pixel square that will be stored.
 *
 * Squaring is attempted ONLY when squareness is the sole complaint. A normalized
 * square is not a pixel square on a non-square source (0.5 of 769 and 0.5 of 1025
 * round to sides a pixel apart), and rejecting the user's frame over that would be
 * absurd — but silently re-centring a rectangle that was out of bounds or below
 * the minimum would store a crop the user never framed, so those keep their own
 * refusal and their own reason.
 */
function resolveManualCrop(input: ManualIdentityCropInput, source: SourceDimensions): ResolvedManualCrop {
  const pixels = input.space === "normalized" ? normalizedCropToSourcePixels(input.crop, source) : input.crop;
  const first = validateIdentityCrop(pixels, source, IDENTITY_CROP_POLICY_V1);
  if (first.ok) return { ok: true, crop: pixels };
  if (first.reason !== "not_square") return { ok: false, code: first.code, reason: first.reason };

  const squared = squareSourcePixelCrop(pixels, source);
  const second = validateIdentityCrop(squared, source, IDENTITY_CROP_POLICY_V1);
  return second.ok ? { ok: true, crop: squared } : { ok: false, code: second.code, reason: second.reason };
}

/** What an accepted override waived, for the audit record. */
interface ManualOverride {
  blockers: ImageIdentityPackFailureCode[];
}

type ManualBlockerRuling =
  | { ok: true; override: ManualOverride | null }
  | { ok: false; rejected: Extract<SaveManualIdentityCropResult, { status: "rejected" }> };

/**
 * Whether this save may proceed despite what the policy measured.
 *
 * The line the spec draws: an override may waive *reviewed quality thresholds*,
 * and nothing else. Ownership, missing bytes, geometry and a stale hash are hard
 * checks — they are refused above this function or refused here, whoever asks and
 * whatever reason they give, because an admin who can crop past a bounds check can
 * store a rectangle that is not inside the image.
 *
 * An override with no blockers to waive is NOT recorded as one: `manual_admin_override`
 * travels into profile evaluation, where a profile that forbids overrides refuses
 * the pack, so stamping it on a crop that never needed it would quietly disqualify
 * a perfectly ordinary reference.
 */
function ruleManualBlockers(
  blockers: readonly ImageIdentityPackFailureCode[],
  input: SaveManualIdentityCropInput,
): ManualBlockerRuling {
  const first = blockers[0];
  if (first === undefined) return { ok: true, override: null };

  const rejected = (
    reason: ManualIdentityCropRejection,
    code: ImageIdentityPackFailureCode,
    message: string,
  ): ManualBlockerRuling => ({
    ok: false,
    rejected: { status: "rejected", reason, code, blockers: [...blockers], message },
  });

  const hard = blockers.find((code) => !isOverridableIdentityBlocker(code));
  if (hard !== undefined) {
    return rejected("policy_blocked", hard, `manual crop is unusable: ${blockers.join(", ")}`);
  }
  if (input.adminOverride !== true) {
    return rejected("policy_blocked", first, `manual crop is unusable: ${blockers.join(", ")}`);
  }
  if (!PROFILE_POLICY_DEFAULTS_V1.allowAdminOverride) {
    return rejected("override_not_permitted", first, "the reviewed policy does not permit an admin override");
  }
  if ((input.reason?.trim() ?? "").length === 0) {
    return rejected("override_reason_required", first, "an override requires a non-empty reason");
  }
  return { ok: true, override: { blockers: [...blockers] } };
}

/**
 * Which blockers an admin may waive: the ones that came from a reviewed THRESHOLD
 * rather than from the rectangle itself. Blur and occlusion verdicts report as
 * `no_usable_face` (the vocabulary has no "too blurry" code), and they are the
 * whole overridable set — everything else is geometry or machinery.
 */
function isOverridableIdentityBlocker(code: ImageIdentityPackFailureCode): boolean {
  switch (code) {
    case "no_usable_face":
      return true;
    case "source_missing":
    case "source_not_ready":
    case "source_unreadable":
    case "source_changed":
    case "ambiguous_faces":
    case "invalid_crop":
    case "crop_too_small":
    case "crop_write_failed":
    case "derivation_failed":
      return false;
  }
}

export interface ResetIdentityPackInput {
  ownerId: string;
  characterId: string;
  /** Recorded in the diagnostic; a reset AUTHORS nothing, so it stamps no review columns. */
  actorUserId: string;
  sink?: DiagnosticSink;
}

/**
 * Discard a manual crop and re-derive automatically
 * (`.spec.derivation.md` §"Reset to automatic").
 *
 * It does not resurrect the detector revision that came before the manual one:
 * that revision was produced by whatever derivation version was current THEN, and
 * un-superseding it would hand today's renders a crop today's algorithm would not
 * have made. Instead the CURRENT derivation runs against the CURRENT source as a
 * new automatic revision, and the manual one becomes superseded — retained in
 * history until normal cleanup, so "what did my crop look like?" stays answerable
 * for the diagnostic window.
 *
 * The forced path is why this is not just `ensureIdentityPack`: for unchanged bytes
 * that call would correctly return the manual revision it is being asked to replace.
 *
 * A reset that lands on an unusable automatic result is an honest outcome, not a
 * bug — the owner asked to stop using their crop, and the answer is that this
 * source cannot yield one automatically.
 */
export async function resetIdentityPackToAutomatic(input: ResetIdentityPackInput): Promise<EnsureIdentityPackResult> {
  const { ownerId, characterId, sink, actorUserId } = input;
  sink?.push(
    diag("info", "images.identity_pack.manual_override", "manual crop reset to automatic derivation", {
      context: { characterId, actorUserId },
    }),
  );
  // `identity_render`: the caller is a person waiting for the answer, so this
  // waits out the bounded local derivation rather than returning a reservation.
  return runDerivation({ ownerId, characterId, purpose: "identity_render", sink }, { forceNewRevision: true });
}

/* ------------------------------------------------------------------------ *
 * Background preparation                                                    *
 * ------------------------------------------------------------------------ */

/**
 * Fire-and-forget pack preparation after a canonical portrait lands
 * (spec.lifecycle.md §"Creation after a canonical portrait").
 *
 * Returns void immediately and swallows everything: preparation does NOT
 * participate in the transaction that made the portrait canonical, so no
 * detector, crop, measurement or file-write failure can roll back a perfectly
 * good portrait. The ordering it completes is `source row ready → canonical
 * pointer committed → preparation requested`.
 *
 * The job row is inserted here rather than through `startJob` for an
 * architectural reason, not a preference: `@/server/api` re-exports `clone.ts`,
 * which imports `@/server/images`, so calling into that barrel from this module
 * would close an import cycle. The shape is the same as the image sweep's own
 * job row (`assets.ts`), which is likewise local, provider-free work — hence
 * `providerLaneFor("identity_pack") === null`, since a failure here says
 * something about this app, not about an upstream.
 */
export function queueIdentityPackPreparation(characterId: string, ownerId: string): void {
  void prepareIdentityPackJob(characterId, ownerId).catch((err: unknown) => {
    log.warn("images", "identity_pack enqueue failed", {
      characterId,
      ownerId,
      error: errorMessage(err).slice(0, 300),
    });
  });
}

async function prepareIdentityPackJob(characterId: string, ownerId: string): Promise<void> {
  // One live derivation per character: clicking through three portraits in a row
  // must not start three. The staleness bound inside the helper keeps a job
  // orphaned by a deploy from wedging this character forever.
  if (await hasLiveCharacterJob("identity_pack", characterId)) return;

  const [job] = await db()
    .insert(jobs)
    .values({
      type: "identity_pack",
      ownerId,
      status: "running",
      payload: { characterId },
      attempts: 1,
      startedAt: new Date(),
    })
    .returning({ id: jobs.id });
  if (!job) return;

  try {
    const result = await ensureIdentityPack({ ownerId, characterId, purpose: "background" });
    await db()
      .update(jobs)
      .set({
        status: "done",
        payload: {
          characterId,
          outcome: result.status,
          ...(result.status === "blocked" ? { code: result.code, retryable: result.retryable } : {}),
        },
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
  } catch (err) {
    const message = errorMessage(err).slice(0, 500);
    log.warn("images", "identity_pack job failed", { characterId, error: message });
    await db().update(jobs).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(jobs.id, job.id));
  }
}

/* ------------------------------------------------------------------------ *
 * Invalidation                                                              *
 * ------------------------------------------------------------------------ */

/**
 * Statuses a current revision can legally leave for `stale`
 * (`isAllowedIdentityPackTransition`). `stale`/`superseded` are terminal and can
 * never be current, so they are not here.
 */
const INVALIDATABLE_STATUSES = ["pending", "ready", "unusable", "failed"] as const satisfies readonly ImageIdentityPackStatus[];

export interface InvalidateIdentityPackInput {
  /** Invalidate these characters' current packs outright. */
  characterIds?: readonly string[];
  /** Invalidate current packs DERIVED FROM these source images, whoever owns them. */
  sourceImageIds?: readonly string[];
  sink?: DiagnosticSink;
}

/**
 * Mark current packs stale when a canonical pointer is cleared or replaced
 * outside the assignment triggers (spec.lifecycle.md §"Source deletion").
 *
 * Belt to read-time verification's braces. Every read already re-hashes the source
 * before trusting a crop — that is mandatory and stays mandatory, because rows and
 * files change in ways no hook observes. This exists so the common cases (a gallery
 * delete of the canonical portrait, a portrait-studio delete) are reflected
 * IMMEDIATELY in what a status view shows, instead of a pack that looks ready right
 * up until the next render reads bytes that are gone.
 *
 * `current` is cleared along with the status, not just the status: a row that is
 * both `current` and terminal cannot be retired by the next reservation (no legal
 * transition out of `stale`), which would wedge that character's pack permanently.
 * Same reasoning as `abandonRevision`.
 *
 * `sourceImageIds` is the precise form and the one the delete paths use — a
 * character whose OTHER portrait was deleted keeps its pack, exactly as the spec
 * requires ("If a user deletes a non-current source image, only pack revisions
 * derived from that image are affected").
 */
export async function invalidateIdentityPackForSource(input: InvalidateIdentityPackInput): Promise<number> {
  const characterIds = [...new Set(input.characterIds ?? [])];
  const sourceImageIds = [...new Set(input.sourceImageIds ?? [])];
  const targets = [
    ...(characterIds.length > 0 ? [inArray(imageIdentityPacks.characterId, characterIds)] : []),
    ...(sourceImageIds.length > 0 ? [inArray(imageIdentityPacks.sourceImageId, sourceImageIds)] : []),
  ];
  const target = targets.length === 1 ? targets[0] : or(...targets);
  // No predicate ⇒ every current pack matches. Refuse, exactly as
  // `purgeImagesWhere` refuses an unguarded delete.
  if (target === undefined) return 0;

  const invalidated = await db()
    .update(imageIdentityPacks)
    .set({ current: false, status: "stale" })
    .where(
      and(
        eq(imageIdentityPacks.current, true),
        inArray(imageIdentityPacks.status, [...INVALIDATABLE_STATUSES]),
        target,
      ),
    )
    .returning({ id: imageIdentityPacks.id, characterId: imageIdentityPacks.characterId });

  for (const row of invalidated) {
    input.sink?.push(
      diag("warn", "images.identity_pack.source_changed", "the pack's canonical source was cleared or replaced", {
        context: { characterId: row.characterId, packId: row.id },
      }),
    );
  }
  if (invalidated.length > 0) {
    log.warn("images", "identity packs invalidated by a source change", {
      packs: invalidated.length,
      characters: new Set(invalidated.map((row) => row.characterId)).size,
    });
  }
  return invalidated.length;
}

/* ------------------------------------------------------------------------ *
 * Cleanup                                                                   *
 * ------------------------------------------------------------------------ */

/**
 * How long a retired revision keeps its hidden crop bytes
 * (spec.lifecycle.md §"Superseded and failed revision cleanup").
 *
 * A week is a diagnostic window, not a retention policy: long enough that "why did
 * my character's face change last Tuesday?" can still be answered from the actual
 * crop, short enough that nobody is storing months of superseded faces. The spec
 * puts the number with the image-lifecycle owner rather than in the schema, which
 * is why it is a constant here and not a column — changing it is a code review, not
 * a migration.
 */
export const IDENTITY_PACK_REVISION_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Rows touched per cleanup pass. Maintenance rides a render; it never becomes one. */
const IDENTITY_PACK_CLEANUP_LIMIT = 200;

/** Statuses whose crop bytes have no future consumer once the window has elapsed. */
const RETIRED_STATUSES = ["superseded", "stale", "unusable", "failed"] as const satisfies readonly ImageIdentityPackStatus[];

export interface CleanupIdentityPackOptions {
  /** Injected clock — the retention window is otherwise untestable without waiting a week. */
  now?: Date;
  retentionMs?: number;
  limit?: number;
  sink?: DiagnosticSink;
}

export interface IdentityPackCleanupResult {
  /** Reservations abandoned by a dead process, retired so they stop blocking. */
  pendingRetired: number;
  cropsDeleted: number;
  /** Crops no pack row named at all — a derivation that died between write and finalize. */
  orphanCropsDeleted: number;
  /** Already gone when cleanup got there. Idempotence, not an error. */
  cropsAlreadyGone: number;
}

/**
 * Bounded, idempotent removal of hidden crop bytes nothing can use.
 *
 * Three passes, each a different way a crop outlives its purpose:
 *
 * 1. **Stale reservations.** A `pending` revision older than the job staleness
 *    bound belonged to a process that is gone (a deploy replaced the machine
 *    mid-derivation). It is retired so the character's next reservation is not
 *    refused by a row nothing will ever finalize — the same 15-minute reasoning
 *    `answerFromCurrent` applies when it declines to honour one.
 * 2. **Retired revisions past the window.** Superseded, stale, unusable and failed
 *    revisions give up their crop row and file; the PACK row stays, because the
 *    metadata is the audit trail and contains no image content or URL. The current
 *    revision and its crop are never touched, whatever their age.
 * 3. **Orphan crops.** A hidden row no pack row names, older than the window. The
 *    image sweep cannot see these — the file matches its row, so nothing looks
 *    wrong from either side; only the pack table knows nobody claims it.
 *
 * Everything here is safe to run twice: a missing file or an already-deleted row
 * is success (`purgeImagesWhere` counts what it actually removed), and a failure
 * degrades to a diagnostic rather than failing the sweep that called it.
 */
export async function cleanupIdentityPackRevisions(
  opts: CleanupIdentityPackOptions = {},
): Promise<IdentityPackCleanupResult> {
  const now = opts.now ?? new Date();
  const retentionMs = opts.retentionMs ?? IDENTITY_PACK_REVISION_RETENTION_MS;
  const limit = Math.max(1, opts.limit ?? IDENTITY_PACK_CLEANUP_LIMIT);
  const cutoff = new Date(now.getTime() - retentionMs);
  const result: IdentityPackCleanupResult = {
    pendingRetired: 0,
    cropsDeleted: 0,
    orphanCropsDeleted: 0,
    cropsAlreadyGone: 0,
  };

  try {
    result.pendingRetired = await retireAbandonedReservations(now);

    const retired = await db()
      .select({ id: imageIdentityPacks.id, cropImageId: imageIdentityPacks.faceCropImageId })
      .from(imageIdentityPacks)
      .where(
        and(
          eq(imageIdentityPacks.current, false),
          inArray(imageIdentityPacks.status, [...RETIRED_STATUSES]),
          isNotNull(imageIdentityPacks.faceCropImageId),
          lt(imageIdentityPacks.updatedAt, cutoff),
        ),
      )
      .limit(limit);
    const cropIds = retired.map((row) => row.cropImageId).filter((id): id is string => id !== null);
    if (cropIds.length > 0) {
      // The kind guard is what keeps a corrupted pointer from deleting a user's
      // portrait: this may only ever remove hidden crops. The pack rows' own
      // `face_crop_image_id` goes null through the FK, so the audit row survives
      // without claiming bytes that are gone.
      result.cropsDeleted = await purgeImagesWhere(
        and(inArray(images.id, cropIds), eq(images.kind, "identity_face_crop")),
      );
      result.cropsAlreadyGone = cropIds.length - result.cropsDeleted;
    }

    result.orphanCropsDeleted = await deleteOrphanIdentityCrops(cutoff, limit, opts.sink);
  } catch (err) {
    const message = errorMessage(err);
    opts.sink?.push(diag("warn", "images.identity_pack.cleanup_failed", message.slice(0, 300)));
    log.warn("images", "identity pack cleanup degraded", { error: message.slice(0, 300) });
  }
  return result;
}

/**
 * Retire `pending` revisions whose deriving process is gone. Unbounded by design
 * and self-limiting in practice: derivation takes seconds, so a reservation older
 * than {@link JOB_STALE_MS} is pathological, and leaving even one in place wedges
 * that character's pack until a human notices.
 */
async function retireAbandonedReservations(now: Date): Promise<number> {
  const retired = await db()
    .update(imageIdentityPacks)
    .set({ current: false, status: "stale" })
    .where(
      and(
        eq(imageIdentityPacks.status, "pending"),
        lt(imageIdentityPacks.createdAt, new Date(now.getTime() - JOB_STALE_MS)),
      ),
    )
    .returning({ id: imageIdentityPacks.id });
  return retired.length;
}

/**
 * Hidden crops no pack row names. Found by LEFT JOIN rather than `NOT IN (subquery)`
 * on purpose — a single null in that subquery would make the whole predicate match
 * nothing, and silently sweeping nothing forever is exactly the kind of bug that
 * takes a year to notice.
 */
async function deleteOrphanIdentityCrops(cutoff: Date, limit: number, sink: DiagnosticSink | undefined): Promise<number> {
  const orphans = await db()
    .select({ id: images.id })
    .from(images)
    .leftJoin(imageIdentityPacks, eq(imageIdentityPacks.faceCropImageId, images.id))
    .where(
      and(eq(images.kind, "identity_face_crop"), lt(images.createdAt, cutoff), isNull(imageIdentityPacks.id)),
    )
    .limit(limit);
  if (orphans.length === 0) return 0;

  sink?.push(
    diag("warn", "images.identity_pack.orphan_crop", `${orphans.length} hidden crop(s) belong to no pack revision`, {
      context: { imageIds: orphans.slice(0, 10).map((row) => row.id) },
    }),
  );
  return purgeImagesWhere(and(inArray(images.id, orphans.map((row) => row.id)), eq(images.kind, "identity_face_crop")));
}

/* ------------------------------------------------------------------------ *
 * Bounded batch preparation                                                 *
 * ------------------------------------------------------------------------ */

/**
 * The named trial corpora an admin batch may address by id
 * (spec.lifecycle.md §"Lazy backfill", spec.trial.md §"Corpus").
 *
 * Empty at v1, and that is the deliverable: the seam exists, resolution is typed,
 * and an unknown id fails loudly instead of running an empty batch that reports
 * success. The corpus itself is a set of CHARACTER ids, and character ids are
 * per-environment cuid2s — so the entries arrive with the trial slice's fixture
 * characters (spec.trial.md lists what they must cover: contrast, framing, a
 * stylized subject, glasses, occlusion, a multi-person source, a low-resolution
 * source), not as literals invented here.
 */
export const IDENTITY_PACK_TRIAL_CORPORA: ReadonlyMap<string, readonly string[]> = new Map();

/** Hard ceiling for one batch, whatever `maxCount` asks for. There is no "rebuild everything". */
const IDENTITY_PACK_BATCH_MAX = 200;

/** Bounded parallelism: local sharp work, on the machine serving renders. */
const IDENTITY_PACK_BATCH_MAX_CONCURRENCY = 4;
const IDENTITY_PACK_BATCH_DEFAULT_CONCURRENCY = 2;

export interface PrepareIdentityPacksBatchInput {
  ownerId: string;
  characterIds?: readonly string[];
  corpusId?: string;
  dryRun: boolean;
  maxCount?: number;
  concurrency?: number;
  /** Re-derive even a current ready pack (a derivation change under the same version). */
  regenerate?: boolean;
  sink?: DiagnosticSink;
}

export type IdentityPackBatchOutcome =
  | { characterId: string; outcome: "ready"; revision: number; warnings: ImageIdentityPackWarningCode[] }
  | { characterId: string; outcome: "blocked"; code: ImageIdentityPackFailureCode; retryable: boolean }
  /** Not this owner's, or gone. The two are deliberately indistinguishable. */
  | { characterId: string; outcome: "not_found" }
  | { characterId: string; outcome: "would_prepare" }
  | { characterId: string; outcome: "up_to_date" };

export interface IdentityPackBatchCounts {
  ready: number;
  blocked: number;
  notFound: number;
  wouldPrepare: number;
  upToDate: number;
}

export type PrepareIdentityPacksBatchResult =
  | {
      ok: true;
      dryRun: boolean;
      requested: number;
      counts: IdentityPackBatchCounts;
      results: IdentityPackBatchOutcome[];
    }
  | { ok: false; code: "unknown_corpus" | "empty_selection" | "too_many"; message: string };

/**
 * Prepare a bounded set of characters' packs ahead of demand
 * (spec.lifecycle.md §"Lazy backfill" and §"Admin routes").
 *
 * Existing characters are NOT migrated by eagerly processing every portrait —
 * the first identity-critical request derives what it needs. This exists for the
 * one case that cannot wait for demand: preparing a fixed trial corpus so the
 * comparison cells run against packs that already exist.
 *
 * The refusals are the feature. An oversized request fails rather than being
 * silently truncated (an admin who asked for 500 and got 200 would read the
 * report as complete), an unknown corpus id fails rather than running empty, and
 * concurrency is clamped whatever the caller sends. `dryRun` answers "what would
 * this do?" from ids and versions alone — it never hashes bytes, so it is cheap
 * enough to run before every real batch.
 *
 * Per-character outcomes are stable codes, never image bytes: this response can
 * be logged, pasted into a trial note, and diffed against the next run.
 */
export async function prepareIdentityPacksBatch(
  input: PrepareIdentityPacksBatchInput,
): Promise<PrepareIdentityPacksBatchResult> {
  const selection = resolveBatchSelection(input);
  if (!selection.ok) return selection;

  const characterIds = selection.characterIds;
  const concurrency = Math.min(
    Math.max(1, Math.floor(input.concurrency ?? IDENTITY_PACK_BATCH_DEFAULT_CONCURRENCY)),
    IDENTITY_PACK_BATCH_MAX_CONCURRENCY,
  );
  const outcomes = new Map<string, IdentityPackBatchOutcome>();
  await runInBatches(characterIds, concurrency, async (characterId) => {
    outcomes.set(characterId, await prepareOneForBatch(input, characterId));
  });

  // `runInBatches` swallows a rejection, so an id missing from the map means its
  // work threw. Nothing below it should — every helper contains its own failures —
  // but the report must still account for every requested character.
  const results = characterIds.map(
    (characterId): IdentityPackBatchOutcome =>
      outcomes.get(characterId) ?? { characterId, outcome: "blocked", code: "derivation_failed", retryable: true },
  );
  return {
    ok: true,
    dryRun: input.dryRun,
    requested: characterIds.length,
    counts: countBatchOutcomes(results),
    results,
  };
}

function resolveBatchSelection(
  input: PrepareIdentityPacksBatchInput,
): { ok: true; characterIds: string[] } | Extract<PrepareIdentityPacksBatchResult, { ok: false }> {
  const corpus = input.corpusId === undefined ? undefined : IDENTITY_PACK_TRIAL_CORPORA.get(input.corpusId);
  if (input.corpusId !== undefined && corpus === undefined) {
    return { ok: false, code: "unknown_corpus", message: `no checked-in trial corpus named "${input.corpusId}"` };
  }
  const characterIds = [...new Set([...(input.characterIds ?? []), ...(corpus ?? [])])];
  if (characterIds.length === 0) {
    return { ok: false, code: "empty_selection", message: "the batch named no characters" };
  }
  const cap = Math.min(Math.max(1, Math.floor(input.maxCount ?? IDENTITY_PACK_BATCH_MAX)), IDENTITY_PACK_BATCH_MAX);
  if (characterIds.length > cap) {
    return {
      ok: false,
      code: "too_many",
      message: `${characterIds.length} characters exceeds the ${cap} allowed in one batch`,
    };
  }
  return { ok: true, characterIds };
}

async function prepareOneForBatch(
  input: PrepareIdentityPacksBatchInput,
  characterId: string,
): Promise<IdentityPackBatchOutcome> {
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, input.ownerId)))
    .limit(1);
  if (!character) return { characterId, outcome: "not_found" };

  if (input.dryRun) {
    const current = await currentPackRow(characterId);
    const upToDate =
      input.regenerate !== true &&
      current !== undefined &&
      current.status === "ready" &&
      current.sourceImageId === character.avatarImageId &&
      current.schemaVersion === IDENTITY_PACK_SCHEMA_VERSION &&
      current.derivationVersion === IDENTITY_PACK_DERIVATION_VERSION;
    return { characterId, outcome: upToDate ? "up_to_date" : "would_prepare" };
  }

  const result = await runDerivation(
    { ownerId: input.ownerId, characterId, purpose: "admin_trial", sink: input.sink },
    { forceNewRevision: input.regenerate === true },
  );
  return result.status === "ready"
    ? { characterId, outcome: "ready", revision: result.pack.revision, warnings: result.warnings }
    : { characterId, outcome: "blocked", code: result.code, retryable: result.retryable };
}

function countBatchOutcomes(results: readonly IdentityPackBatchOutcome[]): IdentityPackBatchCounts {
  const counts: IdentityPackBatchCounts = { ready: 0, blocked: 0, notFound: 0, wouldPrepare: 0, upToDate: 0 };
  for (const result of results) {
    switch (result.outcome) {
      case "ready":
        counts.ready += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "not_found":
        counts.notFound += 1;
        break;
      case "would_prepare":
        counts.wouldPrepare += 1;
        break;
      case "up_to_date":
        counts.upToDate += 1;
        break;
    }
  }
  return counts;
}

/* ------------------------------------------------------------------------ *
 * Deletion                                                                  *
 * ------------------------------------------------------------------------ */

/**
 * Hard-delete a character's hidden identity assets — rows and files
 * (spec.lifecycle.md §"Character deletion").
 *
 * The pack ROWS cascade with the character; these image rows do not (they hang off
 * `entity_kind`/`entity_id`, which carry no foreign key), so the delete path calls
 * this explicitly. Today `deleteEntityImages` would take them anyway; when the
 * data-lifecycle plan makes Gallery-visible images survive their character, this is
 * what keeps hidden crops dying with it. The broader retention rule deliberately
 * does not extend to internal render inputs: nobody browses a face crop.
 *
 * Guarded by kind AND entity, the same shape `deleteChatAssets` uses, so a wrong
 * character id can only ever delete nothing.
 */
export async function deleteCharacterIdentityAssets(characterId: string, ownerId: string): Promise<number> {
  return purgeImagesWhere(
    and(
      eq(images.ownerId, ownerId),
      eq(images.entityKind, "character"),
      eq(images.entityId, characterId),
      inArray(images.kind, [...HIDDEN_IMAGE_KINDS]),
    ),
  );
}

/* ------------------------------------------------------------------------ *
 * Sweep integration                                                         *
 * ------------------------------------------------------------------------ */

export interface IdentityPackSweepFindings {
  /** A current ready pack whose crop row is gone, or no longer readable. */
  missingCurrentCrop: number;
  /** A crop that disagrees with its pack about which portrait it came from. */
  sourceMismatch: number;
  /** A crop filed under another user or another character than its pack. */
  ownerMismatch: number;
  /** Two current rows for one character — the partial unique index should forbid it. */
  currentConflict: number;
  /** A pack pointing at an image whose kind is publicly listable. */
  hiddenAssetExposed: number;
}

/** Rows examined per findings pass. */
const IDENTITY_PACK_FINDINGS_LIMIT = 500;

/**
 * Flag identity-pack inconsistencies; repair none of them
 * (spec.lifecycle.md §"Image sweep integration").
 *
 * That split is deliberate. Every condition below means two sources of truth
 * already disagree — a crop claiming one portrait while its pack claims another, a
 * hidden asset filed under the wrong character, two current revisions where the
 * index says there can be one. Guessing which side is right would destroy the
 * evidence of how it happened, and the safe repair (re-derive) is something
 * `ensureIdentityPack` does anyway the next time anyone asks. So: a warning per
 * finding, with ids, and a human decides.
 */
export async function findIdentityPackInconsistencies(
  limit = IDENTITY_PACK_FINDINGS_LIMIT,
  sink?: DiagnosticSink,
): Promise<IdentityPackSweepFindings> {
  const findings: IdentityPackSweepFindings = {
    missingCurrentCrop: 0,
    sourceMismatch: 0,
    ownerMismatch: 0,
    currentConflict: 0,
    hiddenAssetExposed: 0,
  };
  // Widened deliberately: `HIDDEN_IMAGE_KINDS` is a one-member tuple, so
  // `.includes()` on it would only accept that literal and reject the join's
  // `ImageKind` — which is the exact value this needs to test.
  const hiddenKinds: readonly ImageKind[] = HIDDEN_IMAGE_KINDS;

  const rows = await db()
    .select({
      packId: imageIdentityPacks.id,
      characterId: imageIdentityPacks.characterId,
      packSourceImageId: imageIdentityPacks.sourceImageId,
      cropImageId: imageIdentityPacks.faceCropImageId,
      cropRowId: images.id,
      cropKind: images.kind,
      cropStatus: images.status,
      cropOwnerId: images.ownerId,
      cropEntityId: images.entityId,
      cropSourceImageId: images.sourceImageId,
      characterOwnerId: characters.ownerId,
    })
    .from(imageIdentityPacks)
    .innerJoin(characters, eq(characters.id, imageIdentityPacks.characterId))
    .leftJoin(images, eq(images.id, imageIdentityPacks.faceCropImageId))
    .where(and(eq(imageIdentityPacks.current, true), eq(imageIdentityPacks.status, "ready")))
    .limit(limit);

  for (const row of rows) {
    const context = { packId: row.packId, characterId: row.characterId, imageId: row.cropImageId };
    if (row.cropImageId === null || row.cropRowId === null || row.cropKind === null || row.cropStatus !== "ready") {
      findings.missingCurrentCrop += 1;
      flagIdentityPack(sink, "missing_current_crop", "a current ready pack has no readable crop row", context);
      continue;
    }
    if (row.cropSourceImageId !== row.packSourceImageId) {
      findings.sourceMismatch += 1;
      flagIdentityPack(sink, "source_changed", "the crop names a different source image than its pack", context);
    }
    if (row.cropOwnerId !== row.characterOwnerId || row.cropEntityId !== row.characterId) {
      findings.ownerMismatch += 1;
      flagIdentityPack(sink, "owner_mismatch", "the crop is filed under another owner or character", context);
    }
    if (!hiddenKinds.includes(row.cropKind)) {
      findings.hiddenAssetExposed += 1;
      flagIdentityPack(sink, "hidden_asset_exposed", `a pack points at a listable image kind (${row.cropKind})`, context);
    }
  }

  // Cheap insurance against the storage-layer invariant: the partial unique index
  // on `current` makes this impossible, and an impossible row is precisely what an
  // operator must hear about rather than discover through a wrong face.
  const conflicts = await db()
    .select({ characterId: imageIdentityPacks.characterId, rows: count() })
    .from(imageIdentityPacks)
    .where(eq(imageIdentityPacks.current, true))
    .groupBy(imageIdentityPacks.characterId)
    .having(sql`count(*) > 1`)
    .limit(limit);
  for (const conflict of conflicts) {
    findings.currentConflict += 1;
    flagIdentityPack(sink, "current_conflict", `${conflict.rows} current revisions for one character`, {
      characterId: conflict.characterId,
    });
  }

  return findings;
}

function flagIdentityPack(
  sink: DiagnosticSink | undefined,
  code: string,
  message: string,
  context: Record<string, unknown>,
): void {
  log.warn("images", `identity pack finding: ${message}`, context);
  sink?.push(diag("warn", `images.identity_pack.${code}`, message, { context }));
}

/**
 * The pack service's share of one scheduled image sweep: flag inconsistencies,
 * then run the bounded retention cleanup. Contained — a degraded maintenance pass
 * returns no counters rather than failing the sweep, which also reclaims image and
 * job rows nothing else reclaims.
 */
async function identityPackSweepPass(now: Date): Promise<Record<string, number>> {
  try {
    const findings = await findIdentityPackInconsistencies();
    const cleanup = await cleanupIdentityPackRevisions({ now });
    return {
      identityPackMissingCurrentCrop: findings.missingCurrentCrop,
      identityPackSourceMismatch: findings.sourceMismatch,
      identityPackOwnerMismatch: findings.ownerMismatch,
      identityPackCurrentConflict: findings.currentConflict,
      identityPackHiddenAssetExposed: findings.hiddenAssetExposed,
      identityPackPendingRetired: cleanup.pendingRetired,
      identityPackCropsDeleted: cleanup.cropsDeleted,
      identityPackOrphanCropsDeleted: cleanup.orphanCropsDeleted,
    };
  } catch (err) {
    log.warn("images", "identity pack sweep pass degraded", { error: errorMessage(err).slice(0, 300) });
    return {};
  }
}

/**
 * Hand the two lifecycle call-backs to `assets.ts` at module load.
 *
 * This direction, and not a plain import from there, because `assets.ts` importing
 * this module would close an import cycle (`pnpm lint:cycles`) — the registry's doc
 * comment has the full reasoning. Registration is a side effect of loading the pack
 * service, which every path that can reach a sweep already does (`avatar.ts`,
 * `variants.ts`, the `@/server/images` barrel).
 */
registerIdentityPackMaintenance({
  invalidateForImages: async (imageIds) => {
    try {
      await invalidateIdentityPackForSource({ sourceImageIds: imageIds });
    } catch (err) {
      // Maintenance never fails the delete that triggered it; read-time hash
      // verification still catches whatever this pass missed.
      log.warn("images", "identity pack invalidation failed", { error: errorMessage(err).slice(0, 300) });
    }
  },
  sweep: identityPackSweepPass,
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
