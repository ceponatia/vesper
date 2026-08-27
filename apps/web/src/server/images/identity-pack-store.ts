import { createHash } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { z, type ZodType } from "zod";
import {
  evaluateIdentityPackIntrinsic,
  IDENTITY_CROP_POLICY_V1,
  IDENTITY_PACK_DERIVATION_VERSION,
  IDENTITY_PACK_POLICY_VERSION,
  IDENTITY_PACK_SCHEMA_VERSION,
  identityCropOutputSide,
  type IdentityPackIntrinsicPolicy,
  type ImageIdentityPackFailureCode,
  imageIdentityPackQualitySchema,
  type ImageIdentityPackV1,
  type ImageIdentityPackWarningCode,
  imageIdentityPackWarningCodeSchema,
  INTRINSIC_POLICY_V1,
  type SourceDimensions,
  sourcePixelCropSchema,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr, parseOrNull } from "@/lib/parse";
import { db, imageIdentityPacks, JOB_STALE_MS } from "../db";
import type { ImageRow } from "./assets";

/**
 * The identity-pack service: the one place a character's face reference is
 * derived, promoted, and read.
 *
 * This module is the service's leaf: the row/contract boundary, the read-time
 * policy projection, the retry clock and the current-revision read, importing no
 * other pack module. The rest of the service sits on top of it —
 * `./identity-pack-derive.ts`, `./identity-pack-promotion.ts`,
 * `./identity-pack-ensure.ts`, `./identity-pack-read.ts`,
 * `./identity-pack-manual.ts`, `./identity-pack-preparation.ts` and
 * `./identity-pack-maintenance.ts` — and the invariants below govern all of it.
 *
 * Three invariants shape every function in the service.
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
 * another process) and is surfaced by `getIdentityPackForOwner`
 * (`./identity-pack-read.ts`), which is what a status view reads. A waiting
 * caller that meets one of those reservations
 * does not receive it either: it joins the reservation and answers from what that
 * derivation settles on, because the whole contract here is "you get an answer".
 */

export type IdentityPackRow = typeof imageIdentityPacks.$inferSelect;

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

/** The thresholds every evaluation in the service reads. */
export function intrinsicPolicy(): IdentityPackIntrinsicPolicy {
  return injectedIntrinsicPolicy ?? INTRINSIC_POLICY_V1;
}

/* ------------------------------------------------------------------------ *
 * Resolved source                                                           *
 * ------------------------------------------------------------------------ */

/** The canonical portrait, verified and read, as every derivation path sees it. */
export interface ResolvedSource {
  imageRow: ImageRow;
  buffer: Buffer;
  contentHash: string;
  dimensions: SourceDimensions;
}

/** Whether a revision was derived from exactly these bytes under these versions. */
export function coversSource(row: IdentityPackRow, source: ResolvedSource): boolean {
  return (
    row.sourceImageId === source.imageRow.id &&
    row.sourceContentHash === source.contentHash &&
    row.schemaVersion === IDENTITY_PACK_SCHEMA_VERSION &&
    row.derivationVersion === IDENTITY_PACK_DERIVATION_VERSION
  );
}

/* ------------------------------------------------------------------------ *
 * Row → contract                                                            *
 * ------------------------------------------------------------------------ */

export const warningCodeListSchema = z.array(imageIdentityPackWarningCodeSchema);

export interface JsonColumn<T> {
  value: T | null;
  /** The column held something, and it did not parse. Distinct from a stored null. */
  malformed: boolean;
}

/**
 * Read one jsonb column at the trust boundary, keeping "stored null" and
 * "stored garbage" apart. `parseOr` alone cannot: both would fall back to the
 * same value, and a pack whose crop rectangle is unreadable is a very different
 * thing from a pack that legitimately never had one.
 *
 * Exported for the trial service (`./identity-pack-trial-*.ts`), whose cell and
 * grade jsonb columns follow exactly this rule — a second copy of the
 * stored-null/stored-garbage distinction is how the two readers drift.
 */
export function readJsonColumn<T>(schema: ZodType<T>, raw: unknown, sink: DiagnosticSink | undefined, path: string): JsonColumn<T> {
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
export function readFailureCode(raw: string | null): ImageIdentityPackFailureCode | null {
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
 * Read-time policy projection                                               *
 * ------------------------------------------------------------------------ */

/**
 * The warning codes that record HOW a revision was authored rather than what a
 * threshold measured. A guessed rectangle stays a guessed rectangle and a waived
 * check stays waived whatever today's numbers say, so a re-judgment PRESERVES
 * these and RECOMPUTES everything else — every other code in the vocabulary is a
 * verdict `evaluateIdentityPackIntrinsic` derives from the stored measurements
 * (`mild_blur`, `partial_occlusion`, the two padding warnings), or a profile-time
 * observation (`small_effective_face`) that no stored row is entitled to assert.
 */
const PROVENANCE_WARNING_CODES: readonly ImageIdentityPackWarningCode[] = ["heuristic_crop", "manual_admin_override"];

export interface IdentityPackPolicyProjection {
  /** The revision as the policy in force sees it. Verdict fields only — no measurement is rewritten. */
  pack: ImageIdentityPackV1;
  /** The first blocker today's thresholds find in measurements an older policy accepted. */
  blockedBy: ImageIdentityPackFailureCode | null;
}

/**
 * Re-judge a stored revision under the CURRENT policy: `quality.accepted` is
 * not persisted as eternal truth, and a policy change re-evaluates existing
 * packs.
 *
 * A projection, never a repair. The row keeps the status and warnings it was
 * finalized with, because a revision is a historical claim about what one policy
 * version decided and the admin history exists to show exactly that. What changes
 * is what READERS are told: the ensure result, the owner summary and the render
 * seam all pass through here, so a policy bump can never leave one of them
 * quoting a verdict the other two have dropped.
 *
 * Only a `ready` revision is projected. The opposite direction — a loosened
 * policy that would now accept a stored `unusable` one — is deliberately not a
 * projection: a refused revision has no crop bytes to hand anybody, so the only
 * honest way to accept it is to derive it again.
 *
 * The comparison is against the version this build STAMPS, not against the
 * policy object in force, so the test seam's scripted thresholds re-judge
 * `policy_v1` rows instead of declaring every row foreign to themselves.
 *
 * **A revision with no source is refused here, ahead of any threshold.** The
 * source foreign key sets null, so a deleted portrait can leave a row still
 * reading `current`/`ready` that describes bytes nobody can produce. The delete
 * paths retire such a row
 * before the delete lands, and this is what makes that ordering a convenience
 * rather than the only line of defence: because every read seam passes through
 * here, no reader can surface a sourceless pack as ready however the row got
 * that way — a bypassing writer, a restored dump, a hand-run statement. It stays
 * a PROJECTION like everything else in this function: the row is not repaired
 * from a read path, and `cleanupIdentityPackRevisions` is what eventually retires
 * it for real.
 */
export function projectIdentityPackPolicy(
  pack: ImageIdentityPackV1,
  sink?: DiagnosticSink,
): IdentityPackPolicyProjection {
  if (pack.source.imageId === null && (pack.status === "ready" || pack.status === "pending")) {
    sink?.push(
      diag("warn", "images.identity_pack.source_missing", "the revision's canonical source row is gone", {
        context: { characterId: pack.characterId, packId: pack.id, revision: pack.revision },
      }),
    );
    return {
      pack: { ...pack, status: "unusable", failureCode: "source_missing" },
      blockedBy: "source_missing",
    };
  }

  if (pack.status !== "ready" || pack.derivation.policyVersion === IDENTITY_PACK_POLICY_VERSION) {
    return { pack, blockedBy: null };
  }

  const policy = intrinsicPolicy();
  const evaluation = evaluateIdentityPackIntrinsic(
    {
      method: pack.derivation.method,
      crop: pack.faceDetail.crop,
      quality: pack.quality,
      adminOverride: pack.warningCodes.includes("manual_admin_override"),
    },
    policy,
  );
  const warningCodes = [
    ...new Set([
      ...pack.warningCodes.filter((code) => PROVENANCE_WARNING_CODES.includes(code)),
      ...evaluation.warnings,
    ]),
  ];
  // The projected contract names the policy that actually produced its verdict:
  // render provenance copies this field verbatim, and carrying the row's older
  // version beside recomputed warnings would misattribute the judgment. The row
  // itself still reports its own version to admin history.
  const derivation = { ...pack.derivation, policyVersion: policy.version };

  const blockedBy = evaluation.blockers[0] ?? null;
  if (blockedBy === null) return { pack: { ...pack, derivation, warningCodes }, blockedBy: null };

  sink?.push(
    diag(
      "warn",
      `images.identity_pack.${blockedBy}`,
      `policy ${policy.version} refuses a revision ${pack.derivation.policyVersion} accepted`,
      { context: { characterId: pack.characterId, packId: pack.id, revision: pack.revision, blockers: evaluation.blockers } },
    ),
  );
  return { pack: { ...pack, derivation, warningCodes, status: "unusable", failureCode: blockedBy }, blockedBy };
}

/* ------------------------------------------------------------------------ *
 * Retry policy                                                              *
 * ------------------------------------------------------------------------ */

/**
 * Which failures a later attempt could plausibly fix.
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
export const MAX_RETRY_ATTEMPTS = 5;

export function retryBackoffMs(attempts: number): number {
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
export async function previousAttemptCount(characterId: string, sourceContentHash: string): Promise<number> {
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
 * Current-revision read                                                     *
 * ------------------------------------------------------------------------ */

/**
 * Whether a `pending` row is a reservation somebody is still working on, or a
 * headstone left by a process that died mid-derivation (a deploy replaces the
 * machine; nothing reclaims the row it was holding).
 *
 * The bound is {@link JOB_STALE_MS} — the job dedupe's constant, and the one
 * `retireAbandonedReservations` already sweeps by in SQL — deliberately rather than
 * an identity-pack number of its own. A reservation IS a job another process is
 * running. This predicate exists so the two decisions that must agree share one
 * expression: the pre-reserve read and the reserve transaction. If they drifted
 * from each other, or from the sweep's bound, a caller would settle in to wait out
 * a row somebody else had already retired. Same trade the job dedupe accepts: one
 * duplicate derivation after fifteen minutes costs far less than a character whose
 * pack can never be derived again.
 */
export function isLiveReservation(row: IdentityPackRow): boolean {
  return Date.now() - row.createdAt.getTime() < JOB_STALE_MS;
}

export async function currentPackRow(characterId: string): Promise<IdentityPackRow | undefined> {
  const [row] = await db()
    .select()
    .from(imageIdentityPacks)
    .where(and(eq(imageIdentityPacks.characterId, characterId), eq(imageIdentityPacks.current, true)))
    .limit(1);
  return row;
}

/* ------------------------------------------------------------------------ *
 * Shared internals                                                          *
 * ------------------------------------------------------------------------ */

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
