import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, count, eq, max, sql } from "drizzle-orm";
import { z, type ZodType } from "zod";
import {
  imageIdentityPackQualitySchema,
  imageIdentityPackWarningCodeSchema,
  isAllowedIdentityPackTransition,
  sourcePixelCropSchema,
  type DetectedFaceCandidate,
  type EnsureIdentityPackInput,
  type EnsureIdentityPackResult,
  type ImageIdentityCropMethod,
  type ImageIdentityPackFailureCode,
  type ImageIdentityPackQuality,
  type ImageIdentityPackStatus,
  type ImageIdentityPackV1,
  type ImageIdentityPackWarningCode,
  type SourcePixelCrop,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr, parseOrNull } from "@/lib/parse";
import {
  deriveDetectorCrop,
  heuristicCropV1,
  identityCropOutputSide,
  isHeuristicEligibleSource,
  validateIdentityCrop,
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
  readImageBytes,
  saveImageBuffer,
  SHARP_DECODE_LIMITS,
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
  const { ownerId, characterId, sink } = input;
  try {
    const resolved = await resolveSource(ownerId, characterId, sink);
    if (!resolved.ok) {
      return { status: "blocked", pack: null, code: resolved.code, retryable: isRetryableIdentityPackFailure(resolved.code) };
    }

    const acquired = await acquireKeyedLockWithin(
      identityPackLockKey(characterId),
      () => derivePackUnderLock(input, resolved.source),
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
async function derivePackUnderLock(input: EnsureIdentityPackInput, source: ResolvedSource): Promise<EnsureIdentityPackResult> {
  const { ownerId, characterId, sink } = input;
  const current = await currentPackRow(characterId);

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

  const outputSide = identityCropOutputSide(plan.crop.width, IDENTITY_CROP_POLICY_V1);
  let cropBuffer: Buffer;
  let blurScore: number | null;
  try {
    cropBuffer = await extractIdentityCrop(source.buffer, plan.crop, outputSide);
    blurScore = await measureBlur(cropBuffer);
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
    blurScore,
    occlusionScore: plan.occlusionScore,
  });
  const evaluation = evaluateIdentityPackIntrinsic({ method: plan.method, crop: plan.crop, quality }, INTRINSIC_POLICY_V1);
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

  const asset = await createImageAsset({
    ownerId: input.ownerId,
    kind: "identity_face_crop",
    entityKind: "character",
    entityId: characterId,
    sourceImageId: source.imageRow.id,
    meta: {
      hidden: true,
      identityPackId: input.packId,
      identityRole: "face_detail",
      sourceContentHash: source.contentHash,
      crop: plan.crop,
      derivationVersion: IDENTITY_PACK_DERIVATION_VERSION,
    },
  });
  const saved = await saveImageBuffer(asset.id, cropBuffer, sink);
  if (saved?.status !== "ready") {
    const message = "identity face crop could not be written";
    await failImage(asset.id, message);
    sink?.push(
      diag("warn", "images.identity_pack.crop_write_failed", message, {
        context: { characterId, packId: input.packId, imageId: asset.id },
      }),
    );
    return refusedRevision("crop_write_failed", message, measured);
  }

  return {
    status: "ready",
    method: plan.method,
    detectorVersion: plan.detectorVersion,
    confidence: plan.confidence,
    faceCropImageId: asset.id,
    crop: plan.crop,
    quality,
    warningCodes: evaluation.warnings,
    failureCode: null,
    failureMessage: null,
  };
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
  const selection = selectIdentityFaceCandidate(candidates, INTRINSIC_POLICY_V1);

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
