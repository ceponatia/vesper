import { and, desc, eq } from "drizzle-orm";
import {
  IDENTITY_PACK_DERIVATION_VERSION,
  IDENTITY_PACK_SCHEMA_VERSION,
  type IdentityPackAdminRevision,
  type IdentityPackSummaryWire,
  type ImageIdentityPackFailureCode,
  type ImageIdentityPackV1,
  type ImageIdentityPackWarningCode,
  sourcePixelCropSchema,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { characters, db, imageIdentityPacks } from "../db";
import {
  currentPackRow,
  type IdentityPackRow,
  isRetryableIdentityPackFailure,
  packRowToContract,
  projectIdentityPackPolicy,
  readFailureCode,
  readJsonColumn,
  warningCodeListSchema,
} from "./identity-pack-store";

/**
 * The read surfaces: the owner's status view, the admin revision history, and
 * the trial's pinned-revision read.
 *
 * All three are projections over stored rows — they derive, promote and repair
 * nothing — and all three pass through the same
 * {@link projectIdentityPackPolicy} so a policy bump can never leave one of them
 * quoting a verdict the others have dropped.
 */

/* ------------------------------------------------------------------------ *
 * Owner-safe read                                                           *
 * ------------------------------------------------------------------------ */

export interface IdentityPackSummary {
  /** Null until this character has any revision at all. */
  pack: ImageIdentityPackV1 | null;
  /**
   * The character's ACCEPTED portrait right now, whatever the pack says — the
   * identity source, not the candidate the studio is showing.
   */
  sourceImageId: string | null;
  current: boolean;
  /**
   * The revision no longer describes the character's accepted source. Computed
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
  /** When the current revision last changed, so a poller can tell "still running" from "stuck". */
  updatedAt: string | null;
}

/**
 * The owner's view of their character's pack. `null` when the character is not
 * theirs — the caller turns that into the same not-found a nonexistent character
 * gets, so a pack's existence never leaks: every operation starts from an
 * authorized CHARACTER, never from a bare pack or image id.
 */
export async function getIdentityPackForOwner(
  characterId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<IdentityPackSummary | null> {
  const [character] = await db()
    .select({ acceptedAvatarImageId: characters.acceptedAvatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!character) return null;

  const row = await currentPackRow(characterId);
  if (!row) {
    return {
      pack: null,
      sourceImageId: character.acceptedAvatarImageId,
      current: false,
      stale: false,
      pending: false,
      failureCode: null,
      retryable: false,
      warnings: [],
      updatedAt: null,
    };
  }

  // Same projection the ensure path applies, for the same reason: an owner whose
  // reference stopped qualifying under a new policy must be told so by the status
  // view too, or the panel says "ready" about a pack no render will accept.
  const pack = projectIdentityPackPolicy(packRowToContract(row, sink), sink).pack;
  const failureCode = pack.failureCode;
  return {
    pack,
    sourceImageId: character.acceptedAvatarImageId,
    current: row.current,
    stale:
      row.status === "stale" ||
      row.status === "superseded" ||
      // A revision that LOST its source describes no accepted portrait at all,
      // and the id comparison below cannot say so on its own: with the character's
      // accepted pointer cleared by the same delete, null equals null and the
      // summary would report a fresh pack over bytes that are gone.
      row.sourceImageId === null ||
      row.sourceImageId !== character.acceptedAvatarImageId ||
      row.schemaVersion !== IDENTITY_PACK_SCHEMA_VERSION ||
      row.derivationVersion !== IDENTITY_PACK_DERIVATION_VERSION,
    pending: pack.status === "pending",
    failureCode,
    retryable: failureCode === null ? false : isRetryableIdentityPackFailure(failureCode),
    warnings: pack.warningCodes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The summary as a route sends it (`identityPackSummarySchema` in contracts).
 *
 * A projection and nothing more — no query, no policy, no second opinion about
 * status — so the shape the crop editor parses cannot drift from the shape
 * {@link getIdentityPackForOwner} computed. Two facts it deliberately does NOT
 * carry across: `pack.quality` (raw measurements are the admin surface's
 * business, and the editor acts on warning codes) and `retryable` (a stable
 * failure code already says whether asking again could help, and shipping both
 * invites a client that trusts the boolean over the code).
 *
 * With no revision at all the source names the character's CURRENT accepted
 * portrait with null dimensions — there is no measured source yet. With a
 * revision, every source field comes from that revision, so `crop`, `source`,
 * and `sourceContentHash` describe one set of bytes even when the character has
 * since moved on (which `stale` is what reports).
 */
export function identityPackSummaryToWire(summary: IdentityPackSummary): IdentityPackSummaryWire {
  const pack = summary.pack;
  if (pack === null) {
    return {
      packId: null,
      status: "none",
      revision: null,
      current: false,
      stale: false,
      method: null,
      source: { imageId: summary.sourceImageId, width: null, height: null },
      crop: null,
      cropImageId: null,
      warningCodes: [],
      failureCode: null,
      sourceContentHash: null,
      updatedAt: null,
    };
  }
  return {
    packId: pack.id,
    status: pack.status,
    revision: pack.revision,
    current: summary.current,
    stale: summary.stale,
    method: pack.derivation.method,
    source: { imageId: pack.source.imageId, width: pack.source.width, height: pack.source.height },
    crop: pack.faceDetail.crop,
    cropImageId: pack.faceDetail.imageId,
    warningCodes: pack.warningCodes,
    failureCode: pack.failureCode,
    sourceContentHash: pack.source.contentHash,
    updatedAt: summary.updatedAt,
  };
}

/* ------------------------------------------------------------------------ *
 * Admin history                                                             *
 * ------------------------------------------------------------------------ */

/** Revisions returned by one history read. A character accumulates them slowly; this is a guard, not a page. */
const IDENTITY_PACK_HISTORY_LIMIT = 50;

export interface IdentityPackHistory {
  /** The revision that was addressed — the caller's `packId`, echoed so a response stands alone. */
  packId: string;
  characterId: string;
  /** The CHARACTER's owner, which is the authorization root every caller must check against itself. */
  ownerId: string;
  /** Newest revision first. */
  revisions: IdentityPackAdminRevision[];
}

/**
 * Every revision of the character behind one pack id, for admin inspection.
 *
 * Addressed by pack id but resolved through the CHARACTER, and it returns the
 * owner rather than deciding anything with it: authorization is the route's job,
 * and a service that quietly filtered by a caller id would make "not yours" and
 * "does not exist" two different code paths — which is exactly how one of them
 * eventually answers differently and confirms a hidden pack exists.
 *
 * History is metadata only: geometry, versions, stable codes, review actors. No
 * bytes and no URLs cross this boundary even for an admin — the privacy
 * boundary — and a malformed jsonb column degrades to `null` with a
 * diagnostic rather than failing the whole read.
 */
export async function getIdentityPackHistoryForAdmin(
  packId: string,
  sink?: DiagnosticSink,
): Promise<IdentityPackHistory | null> {
  const [addressed] = await db()
    .select({ characterId: imageIdentityPacks.characterId, ownerId: characters.ownerId })
    .from(imageIdentityPacks)
    .innerJoin(characters, eq(characters.id, imageIdentityPacks.characterId))
    .where(eq(imageIdentityPacks.id, packId))
    .limit(1);
  if (!addressed) return null;

  const rows = await db()
    .select()
    .from(imageIdentityPacks)
    .where(eq(imageIdentityPacks.characterId, addressed.characterId))
    .orderBy(desc(imageIdentityPacks.revision))
    .limit(IDENTITY_PACK_HISTORY_LIMIT);

  return {
    packId,
    characterId: addressed.characterId,
    ownerId: addressed.ownerId,
    revisions: rows.map((row) => packRowToAdminRevision(row, sink)),
  };
}

/**
 * One stored row as an admin revision. `readJsonColumn` rather than a bare
 * `parseOr` for the crop: a revision that never had a rectangle (a refusal) and
 * one whose rectangle is unreadable are different findings, and only the second
 * deserves a diagnostic.
 */
function packRowToAdminRevision(row: IdentityPackRow, sink: DiagnosticSink | undefined): IdentityPackAdminRevision {
  return {
    revision: row.revision,
    status: row.status,
    current: row.current,
    method: row.method,
    derivationVersion: row.derivationVersion,
    policyVersion: row.policyVersion,
    detectorVersion: row.detectorVersion,
    confidence: row.confidence,
    warningCodes: parseOr(warningCodeListSchema, row.warningCodes, [], sink, "image_identity_packs.warning_codes_json"),
    failureCode: readFailureCode(row.failureCode),
    failureMessage: row.failureMessage,
    crop: readJsonColumn(sourcePixelCropSchema, row.crop, sink, "image_identity_packs.crop_json").value,
    cropImageId: row.faceCropImageId,
    sourceImageId: row.sourceImageId,
    sourceContentHash: row.sourceContentHash,
    reviewedByUserId: row.reviewedByUserId,
    reviewReason: row.reviewReason,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------------ *
 * Pinned-revision read (trial)                                              *
 * ------------------------------------------------------------------------ */

/**
 * Why a pinned revision could not be handed back. `source_missing` is
 * deliberately the answer for BOTH "no such character" and "not your character"
 * — the same not-yours ≡ gone indistinguishability every pack surface keeps, and
 * the same code `resolveSource` already returns for a character with no
 * canonical portrait.
 */
export type IdentityPackRevisionForTrialCode = "source_missing" | "revision_missing";

export interface IdentityPackRevisionForTrialInput {
  ownerId: string;
  characterId: string;
  /** 1-based, as stored — the revision the trial cell pinned, not an offset. */
  revision: number;
  sink?: DiagnosticSink;
}

export type IdentityPackRevisionForTrialResult =
  | { ok: true; pack: ImageIdentityPackV1 }
  | { ok: false; code: IdentityPackRevisionForTrialCode };

/**
 * One NAMED historical revision of a character's identity pack, read-only —
 * the trial's pack-variant axis.
 *
 * It exists for the trial's pinned-revision comparison arms — manual-vs-automatic
 * crops, detector-vs-heuristic derivations — where the whole question is how the
 * SAME character renders from two different pack revisions. Nothing else in the
 * system reads a non-current revision as a usable pack: the render path always
 * wants the current one, which is why this is a separate entry rather than a
 * parameter on {@link ensureIdentityPack}.
 *
 * Three properties are load-bearing:
 *
 * 1. **Owner-rooted, exactly like every other pack surface.** The character is
 *    resolved under `ownerId` first (the `getIdentityPackForOwner` /
 *    `resolveSource` authorization root: never from a bare pack id), so a foreign
 *    character answers identically to one that does not exist. There is no second
 *    authz interpretation here to drift from the first.
 * 2. **Strictly read-only.** No ensure, no derivation, no promotion, no status
 *    write. A pinned-revision read that could regenerate or supersede anything
 *    would let the act of MEASURING a comparison change the thing being compared.
 * 3. **Eligibility is the caller's ruling, not this function's.** A revision
 *    whose status is `failed`/`unusable`, or whose face detail is incomplete for
 *    one strategy, still comes back `ok`. Planning decides per strategy what it
 *    can build from the returned contract (through the same
 *    `evaluateIdentityPackContractForProfile` the current-pack path uses); this
 *    function's job is honest retrieval plus ownership, and nothing more.
 *
 * **Retention window.** Superseded revisions survive only until the sweep
 * removes them ({@link IDENTITY_PACK_REVISION_RETENTION_MS}, 7 days), so a
 * cross-revision comparison must be planned, executed and reviewed inside that
 * window. Execution re-checks the pinned revision and refuses `cell_conflict`
 * when it has been swept — a comparison arm whose pack is gone is not run
 * against some other revision under its name.
 */
export async function getIdentityPackRevisionForTrial(
  input: IdentityPackRevisionForTrialInput,
): Promise<IdentityPackRevisionForTrialResult> {
  const { ownerId, characterId, revision, sink } = input;

  const [character] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!character) {
    sink?.push(
      diag("warn", "images.identity_pack.source_missing", "no such character for this owner", {
        context: { characterId, revision },
      }),
    );
    return { ok: false, code: "source_missing" };
  }

  const [row] = await db()
    .select()
    .from(imageIdentityPacks)
    .where(and(eq(imageIdentityPacks.characterId, characterId), eq(imageIdentityPacks.revision, revision)))
    .limit(1);
  if (!row) {
    // Expected, not exceptional: a revision the sweep has already retired reads
    // exactly like one that never existed, and both mean "this comparison arm
    // cannot be built" to the caller.
    sink?.push(
      diag("warn", "images.identity_pack.source_missing", "no such pack revision for this character", {
        context: { characterId, revision },
      }),
    );
    return { ok: false, code: "revision_missing" };
  }

  return { ok: true, pack: packRowToContract(row, sink) };
}
