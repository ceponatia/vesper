import { and, count, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { ImageIdentityPackStatus } from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { characters, db, imageIdentityPacks, images, JOB_STALE_MS } from "../db";
import { log } from "@/server/log";
import { HIDDEN_IMAGE_KINDS, type ImageKind, purgeImagesWhere, registerIdentityPackMaintenance } from "./assets";
import { errorMessage } from "./identity-pack-store";

/**
 * Maintenance: invalidation, bounded retention cleanup, character-deletion of
 * hidden assets, and the consistency findings the scheduled image sweep runs.
 *
 * {@link installIdentityPackMaintenance} at the foot of this file is how the last
 * two reach `assets.ts` without closing an import cycle.
 */

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
 * outside the assignment triggers.
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
 * How long a retired revision keeps its hidden crop bytes.
 *
 * A week is a diagnostic window, not a retention policy: long enough that "why did
 * my character's face change last Tuesday?" can still be answered from the actual
 * crop, short enough that nobody is storing months of superseded faces. The
 * number belongs with the image-lifecycle owner rather than in the schema, which
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
  /** Current revisions whose source row is gone — retired so their crop can age out. */
  sourcelessRetired: number;
  cropsDeleted: number;
  /** Crops no pack row named at all — a derivation that died between write and finalize. */
  orphanCropsDeleted: number;
  /** Already gone when cleanup got there. Idempotence, not an error. */
  cropsAlreadyGone: number;
}

/**
 * Bounded, idempotent removal of hidden crop bytes nothing can use.
 *
 * Four passes, each a different way a crop outlives its purpose:
 *
 * 1. **Stale reservations.** A `pending` revision older than the job staleness
 *    bound belonged to a process that is gone (a deploy replaced the machine
 *    mid-derivation). It is retired so the character's next reservation is not
 *    refused by a row nothing will ever finalize — the same 15-minute reasoning
 *    `answerFromCurrent` applies when it declines to honour one.
 * 2. **Sourceless current revisions.** A current row whose `source_image_id` went
 *    null describes bytes nobody can produce. The delete paths retire these
 *    before the row goes; this pass is what reclaims one that arrived by another
 *    route, and it is the ONLY thing that can — pass 3 takes retired rows only, and
 *    pass 4 takes crops no pack names, so a current row would shield its hidden
 *    crop from both indefinitely.
 * 3. **Retired revisions past the window.** Superseded, stale, unusable and failed
 *    revisions give up their crop row and file; the PACK row stays, because the
 *    metadata is the audit trail and contains no image content or URL. The current
 *    revision and its crop are never touched, whatever their age.
 * 4. **Orphan crops.** A hidden row no pack row names, older than the window. The
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
    sourcelessRetired: 0,
    cropsDeleted: 0,
    orphanCropsDeleted: 0,
    cropsAlreadyGone: 0,
  };

  try {
    result.pendingRetired = await retireAbandonedReservations(now);
    result.sourcelessRetired = await retireSourcelessCurrentPacks(limit, opts.sink);

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
 * Retire current revisions whose source row is gone (`source_image_id` null through
 * the set-null foreign key), so the crop they still name can age out of the
 * retention window like any other retired revision.
 *
 * Bounded by a select-then-update rather than a single statement, because the
 * cleanup limit is a promise about how much work one pass does and an unbounded
 * `UPDATE … WHERE current` cannot keep it.
 *
 * Retiring is the whole action: the crop bytes stay for the diagnostic window,
 * exactly as they do for a superseded revision, and the pack row survives as the
 * audit record of what this character's face reference used to be.
 */
async function retireSourcelessCurrentPacks(limit: number, sink: DiagnosticSink | undefined): Promise<number> {
  const sourceless = await db()
    .select({ id: imageIdentityPacks.id })
    .from(imageIdentityPacks)
    .where(
      and(
        eq(imageIdentityPacks.current, true),
        isNull(imageIdentityPacks.sourceImageId),
        inArray(imageIdentityPacks.status, [...INVALIDATABLE_STATUSES]),
      ),
    )
    .limit(limit);
  if (sourceless.length === 0) return 0;

  const retired = await db()
    .update(imageIdentityPacks)
    .set({ current: false, status: "stale" })
    .where(
      and(
        inArray(imageIdentityPacks.id, sourceless.map((row) => row.id)),
        eq(imageIdentityPacks.current, true),
        isNull(imageIdentityPacks.sourceImageId),
        inArray(imageIdentityPacks.status, [...INVALIDATABLE_STATUSES]),
      ),
    )
    .returning({ id: imageIdentityPacks.id, characterId: imageIdentityPacks.characterId });
  if (retired.length === 0) return 0;

  sink?.push(
    diag("warn", "images.identity_pack.source_missing", `${retired.length} current revision(s) lost their source image`, {
      context: { packIds: retired.slice(0, 10).map((row) => row.id) },
    }),
  );
  log.warn("images", "identity packs retired for a vanished source", {
    packs: retired.length,
    characters: new Set(retired.map((row) => row.characterId)).size,
  });
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
 * Deletion                                                                  *
 * ------------------------------------------------------------------------ */

/**
 * Hard-delete a character's hidden identity assets — rows and files.
 *
 * The pack ROWS cascade with the character; these image rows do not (they hang off
 * `entity_kind`/`entity_id`, which carry no foreign key), so the delete path calls
 * this explicitly. A character's Gallery-visible images (avatars, portraits, scenes)
 * survive the character as owner-visible Gallery history — `deleteEntityImages` is
 * never called for a character — and this is what keeps hidden crops dying with it
 * anyway. The broader retention rule deliberately does not extend to internal render
 * inputs: nobody browses a face crop.
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
 * Flag identity-pack inconsistencies; repair none of them.
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
  // Widened deliberately: `HIDDEN_IMAGE_KINDS` is a literal tuple, so
  // `.includes()` on it would only accept those literals and reject the join's
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
      identityPackSourcelessRetired: cleanup.sourcelessRetired,
      identityPackCropsDeleted: cleanup.cropsDeleted,
      identityPackOrphanCropsDeleted: cleanup.orphanCropsDeleted,
    };
  } catch (err) {
    log.warn("images", "identity pack sweep pass degraded", { error: errorMessage(err).slice(0, 300) });
    return {};
  }
}

/**
 * Hand the two lifecycle call-backs to `assets.ts`.
 *
 * This direction, and not a plain import from there, because `assets.ts` importing
 * this module would close an import cycle (`pnpm lint:cycles`) — the registry's doc
 * comment has the full reasoning.
 *
 * Called explicitly, from the folder barrel (`./index.ts`), rather than as a side
 * effect of loading the pack service. Every consumer reaches this folder through
 * that barrel — reaching past it into a module is a lint error — so the front door
 * is the one place the registration is a visible import edge instead of a fact that
 * happens to be true because something else imported the pack service first.
 * Idempotent: registering the same hooks twice is an assignment.
 */
export function installIdentityPackMaintenance(): void {
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
}
