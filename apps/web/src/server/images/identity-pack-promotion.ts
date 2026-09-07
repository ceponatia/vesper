import { and, eq, max, sql } from "drizzle-orm";
import {
  IDENTITY_PACK_DERIVATION_VERSION,
  IDENTITY_PACK_POLICY_VERSION,
  IDENTITY_PACK_SCHEMA_VERSION,
  type ImageIdentityPackFailureCode,
  type ImageIdentityPackStatus,
  isAllowedIdentityPackTransition,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { characters, type Db, db, imageIdentityPacks } from "../db";
import { deleteOwnedImage } from "./asset-deletion";
import { readImageBytes } from "./asset-storage";
import type { RevisionPatch } from "./identity-pack-derive";
import {
  coversSource,
  identityPackLockKey,
  type IdentityPackRow,
  isLiveReservation,
  type ResolvedSource,
  sourceContentHashOf,
} from "./identity-pack-store";

/**
 * Promotion: the compare-and-set pair that reserves a revision and finalizes it.
 *
 * Both halves take the same per-character advisory lock and re-verify the same
 * source; see {@link lockAndVerifySource} for why that is one function. What they
 * write is the {@link RevisionPatch} `./identity-pack-derive.ts` produced.
 */

/* ------------------------------------------------------------------------ *
 * Promotion                                                                 *
 * ------------------------------------------------------------------------ */

/** The transaction handle both promotion transactions run on (`SimTx`'s precedent). */
type PackTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Take the per-character advisory lock, then re-read whether the character still
 * ACCEPTS this source image. `true` means the compare-and-set may proceed.
 *
 * The pointer read is `accepted_avatar_image_id`, the same one `resolveSource`
 * derived from: a candidate portrait moving underneath a derivation is no longer
 * a race at all, and only an acceptance can invalidate one.
 *
 * One copy, deliberately, because the reserve and the finalize are two halves of
 * the SAME compare-and-set: if they ever drifted on what "still ours" means — a
 * different lock key, an owner predicate on one side only — the guard would still
 * look present at both ends while protecting nothing, and the symptom would be a
 * crop promoted from bytes nobody checked.
 *
 * The lock comes first: at READ COMMITTED the read only means anything once no
 * other transaction can move the pointer underneath it.
 */
async function lockAndVerifySource(
  tx: PackTx,
  input: { characterId: string; ownerId: string; source: ResolvedSource },
): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityPackLockKey(input.characterId)}, 0))`);
  const [character] = await tx
    .select({ acceptedAvatarImageId: characters.acceptedAvatarImageId })
    .from(characters)
    .where(and(eq(characters.id, input.characterId), eq(characters.ownerId, input.ownerId)))
    .limit(1);
  return character !== undefined && character.acceptedAvatarImageId === input.source.imageRow.id;
}

type ReserveResult =
  | { ok: true; row: IdentityPackRow }
  /**
   * A live reservation for these exact bytes, left standing for the process that
   * owns it. Not a failure — the work is happening, just not here.
   */
  | { ok: false; kind: "in_flight"; row: IdentityPackRow }
  | { ok: false; kind: "refused"; code: Extract<ImageIdentityPackFailureCode, "source_changed" | "derivation_failed"> };

interface ReserveInput {
  ownerId: string;
  characterId: string;
  source: ResolvedSource;
  sink: DiagnosticSink | undefined;
  /**
   * License to retire even a LIVE matching reservation — the ONE row it names,
   * and no other. Only a forced re-derivation that has already waited out the
   * join window sets it, to the id of the row it waited on; see
   * {@link joinInFlightReservation} for why that exception exists at all, and why
   * a reservation that replaced that row is deliberately not covered by it.
   */
  reclaimPackId?: string | null;
}

/**
 * Retire the current revision and reserve the next one, atomically.
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
 *
 * One current row is NOT retired: a live `pending` reservation for these exact
 * bytes. This is the only place that decision can correctly be made — it is the
 * one read of the current row taken under the advisory lock, so it sees
 * reservations inserted after any pre-check the caller ran — and getting it wrong
 * is expensive in a way the index cannot catch. Retiring one is a perfectly legal
 * write: the loser then loses its finalize compare-and-set, `abandonRevision`
 * deletes the crop it just encoded, and two machines have run one character's
 * detector twice to produce one rectangle. So the reservation stands and the
 * caller joins it.
 */
export async function reservePendingRevision(input: ReserveInput): Promise<ReserveResult> {
  const { ownerId, characterId, source, sink } = input;
  return db().transaction(async (tx): Promise<ReserveResult> => {
    if (!(await lockAndVerifySource(tx, { characterId, ownerId, source }))) {
      sink?.push(
        diag("warn", "images.identity_pack.source_changed", "the canonical portrait moved before this revision was reserved", {
          context: { characterId, sourceImageId: source.imageRow.id },
        }),
      );
      return { ok: false, kind: "refused", code: "source_changed" };
    }

    const [current] = await tx
      .select()
      .from(imageIdentityPacks)
      .where(and(eq(imageIdentityPacks.characterId, characterId), eq(imageIdentityPacks.current, true)))
      .limit(1);
    if (current) {
      // Someone else's live claim on these exact bytes: leave it alone (see the
      // comment above). Everything else is fair game — a reservation past the
      // staleness bound belongs to a process that is gone, and a reservation for
      // DIFFERENT bytes describes a portrait the character no longer has.
      // `reclaimPackId` is the one exception: a forced re-derivation that already
      // waited out the join window may retire the live claim it waited on,
      // because the alternative is a reset button that dead-ends on a wedged
      // reservation until the staleness bound elapses. It licenses THAT row and
      // nothing else — a reservation standing here in its place was opened by a
      // process that is deriving right now, and is joined like any other.
      if (current.status === "pending" && coversSource(current, source) && isLiveReservation(current)) {
        if (input.reclaimPackId !== current.id) return { ok: false, kind: "in_flight", row: current };
        sink?.push(
          diag("warn", "images.identity_pack.pending_conflict", "a forced re-derivation reclaimed an unsettled reservation", {
            context: { characterId, packId: current.id, revision: current.revision },
          }),
        );
      }

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
        return { ok: false, kind: "refused", code: "derivation_failed" };
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
    if (!inserted) return { ok: false, kind: "refused", code: "derivation_failed" };
    return { ok: true, row: inserted };
  });
}

/**
 * Whether a finished derivation may be written onto its `pending` reservation.
 *
 * Unreachable by construction — every patch status is a legal successor of
 * `pending` — and asserted anyway, by BOTH promotion paths, because the thing it
 * guards is a state machine that lives in the contracts module: if a future
 * version narrows the legal successors, the write must stop rather than quietly
 * put a revision into a status nothing downstream expects. One copy so the
 * automatic and manual paths cannot answer that question differently.
 */
export function mayFinalizeReservation(
  patch: RevisionPatch,
  context: { characterId: string; packId: string },
  sink: DiagnosticSink | undefined,
): boolean {
  if (isAllowedIdentityPackTransition("pending", patch.status)) return true;
  sink?.push(
    diag("error", "images.identity_pack.pending_conflict", `illegal transition pending -> ${patch.status}`, { context }),
  );
  return false;
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
export async function finalizeRevision(input: FinalizeInput): Promise<IdentityPackRow | null> {
  const { packId, characterId, ownerId, source, patch } = input;
  const fresh = await readImageBytes(source.imageRow);
  if (!fresh || sourceContentHashOf(fresh) !== source.contentHash) return null;

  return db().transaction(async (tx): Promise<IdentityPackRow | null> => {
    if (!(await lockAndVerifySource(tx, { characterId, ownerId, source }))) return null;

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
 * will ever point at it.
 */
export async function abandonRevision(packId: string, ownerId: string, cropImageId: string | null): Promise<void> {
  await db()
    .update(imageIdentityPacks)
    .set({ current: false, status: "stale" })
    .where(and(eq(imageIdentityPacks.id, packId), eq(imageIdentityPacks.status, "pending")));
  if (cropImageId) await deleteOwnedImage(cropImageId, ownerId, { kind: "identity_face_crop" });
}
