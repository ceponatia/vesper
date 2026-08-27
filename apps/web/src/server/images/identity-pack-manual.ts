import {
  buildIdentityPackQuality,
  type EnsureIdentityPackResult,
  evaluateIdentityPackIntrinsic,
  IDENTITY_CROP_POLICY_V1,
  type ImageIdentityPackFailureCode,
  type ImageIdentityPackV1,
  type ImageIdentityPackWarningCode,
  type NormalizedCrop,
  normalizedCropToSourcePixels,
  PROFILE_POLICY_DEFAULTS_V1,
  type SourceDimensions,
  type SourcePixelCrop,
  squareSourcePixelCrop,
  validateIdentityCrop,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { log } from "@/server/log";
// Direct module path rather than the `@/server/engine` barrel, for the reason
// `./identity-pack-ensure.ts` records on its own import of this file: the barrel
// would close a real import cycle.
import { acquireKeyedLockWithin } from "../engine/keyed-lock";
import {
  encodeAndMeasureCrop,
  type EncodedCrop,
  refusedRevision,
  type RevisionPatch,
  storeHiddenCropAsset,
} from "./identity-pack-derive";
import { LOCK_POLL_MS, LOCK_TIMEOUT_MS, resolveSource, runDerivation } from "./identity-pack-ensure";
import {
  abandonRevision,
  finalizeRevision,
  mayFinalizeReservation,
  reservePendingRevision,
} from "./identity-pack-promotion";
import {
  currentPackRow,
  errorMessage,
  identityPackLockKey,
  type IdentityPackRow,
  intrinsicPolicy,
  isRetryableIdentityPackFailure,
  packRowToContract,
  type ResolvedSource,
} from "./identity-pack-store";

/**
 * Manual correction: a human-authored crop saved as a `manual` revision, and the
 * reset that discards one.
 *
 * It reserves, stores and promotes through exactly the machinery automatic
 * derivation uses (`./identity-pack-promotion.ts`, `./identity-pack-derive.ts`),
 * so the two paths can never drift on what a revision means.
 */

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
 * Save a human-authored crop as a new `manual` revision.
 *
 * The order is deliberate, and each step exists to stop a specific way this could
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
    if (reserved.kind === "in_flight") {
      // A live reservation appeared between the read at the top of this function
      // and the advisory lock — another machine is deriving this character now.
      // `busy` is the whole answer: the editor's contract for every conflict is
      // "reload and retry", and a manual save is emphatically not entitled to the
      // one thing the automatic path refuses itself, which is to retire a
      // reservation somebody is mid-way through and delete the crop it produced.
      // A save that happens a second later costs nobody anything. The reload
      // target is the reservation itself, because that is what is current NOW.
      sink?.push(
        diag("warn", "images.identity_pack.pending_conflict", "a live reservation holds this character; the save must retry", {
          context: { characterId, packId: reserved.row.id, revision: reserved.row.revision },
        }),
      );
      return manualConflict("busy", reserved.row, source);
    }
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

  if (!mayFinalizeReservation(patch, { characterId, packId: reserved.row.id }, sink)) {
    return { status: "blocked", code: "derivation_failed", retryable: false };
  }

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
 * Discard a manual crop and re-derive automatically.
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
