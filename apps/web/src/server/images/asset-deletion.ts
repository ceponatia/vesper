import fs from "node:fs/promises";
import { and, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import { characters, db, images, items, locations } from "../db";
import { log } from "@/server/log";
import { absoluteImagePath } from "./paths";
import { type ImageKind, type ImageFileRef, GALLERY_IMAGE_KINDS, HIDDEN_IMAGE_KINDS } from "./asset-storage";
import { identityPackMaintenance } from "./asset-lifecycle-hooks";

/**
 * Delete every images row matching `where` and unlink their files best-effort
 * (image_sweep reconciles stragglers). The CALLER owns the predicate — build it
 * with the same owner/kind/chat guards the call site needs; this helper adds
 * nothing and so can never widen one. Returns how many rows were removed.
 *
 * An `undefined` predicate would match the whole table, so it is refused: a
 * caller whose guards all collapsed to `undefined` deletes nothing rather than
 * everything.
 *
 * **Derived state is retired BEFORE the delete, never after.**
 * `image_identity_packs.source_image_id` is a `set null` foreign key, so the
 * moment these rows go the pack that named one of them can no longer be FOUND by
 * source id — an invalidation sequenced after the delete matches nothing and
 * leaves a `current`, `ready` pack with a null source. Ordering is the
 * fix; it is deliberately not a transaction, because the hook is a registry call
 * into a module this one must not know about and threading a transaction handle
 * through that seam would re-couple them. The FK, and the read seam's refusal to
 * report a null-source pack as ready, cover the window between the two
 * statements.
 */
export async function purgeImagesWhere(where: SQL | undefined): Promise<number> {
  if (where === undefined) {
    log.warn("images", "purgeImagesWhere refused an unguarded predicate");
    return 0;
  }
  const rows = await db()
    .select({ id: images.id, ownerId: images.ownerId, path: images.path, kind: images.kind })
    .from(images)
    .where(where);
  if (rows.length === 0) return 0;
  // Hidden kinds are derived state themselves, never a pack's source — skipping
  // them spares the pack service's own crop reclamation a guaranteed-no-op
  // invalidation round trip on every cleanup pass.
  const sources = rows.filter((row) => !HIDDEN_IMAGE_KINDS.some((kind) => kind === row.kind));
  if (sources.length > 0) await invalidateDerivedState(sources.map((row) => row.id));
  await db().delete(images).where(where);
  await Promise.all(rows.map((row) => unlinkImageFile(row)));
  return rows.length;
}

/** Best-effort file removal for a purged row — never throws; image_sweep reconciles stragglers. */
async function unlinkImageFile(row: ImageFileRef): Promise<void> {
  try {
    await fs.unlink(absoluteImagePath(row));
  } catch {
    // already gone, or a path that no longer resolves — the sweep reconciles
  }
}

/**
 * Hard-delete one owned image — the row first, then its file best-effort
 * (image_sweep reconciles a straggler). Owner-scoped, with an optional `kind`
 * guard so a route can't delete the wrong class of asset through it. Returns
 * false when no matching row exists (already gone, not owned, wrong kind). The
 * single-asset counterpart to the bulk deleteEntityImages.
 */
export async function deleteOwnedImage(
  imageId: string,
  ownerId: string,
  opts: { kind?: ImageKind; kinds?: readonly ImageKind[] } = {},
): Promise<boolean> {
  const removed = await purgeImagesWhere(and(eq(images.id, imageId), eq(images.ownerId, ownerId), kindGuard(opts)));
  return removed > 0;
}

/** The optional single/multi kind guard shared by the owned-delete helpers. */
function kindGuard(opts: { kind?: ImageKind; kinds?: readonly ImageKind[] }) {
  if (opts.kinds) return inArray(images.kind, [...opts.kinds]);
  return opts.kind ? eq(images.kind, opts.kind) : undefined;
}

/**
 * The character-deletion survival rule, stated once: **an image survives its
 * character iff its kind is Gallery-listable** (`GALLERY_IMAGE_KINDS` in asset-storage.ts —
 * scene, portrait_variant, entity). Everything else — `avatar` included, and
 * every `HIDDEN_IMAGE_KINDS` entry — is hard-deleted with the character, rows
 * and files alike, by this one `notInArray` predicate.
 *
 * `avatar` is neither Gallery-listable nor hidden: it is reachable only through
 * the character's own portrait studio, which dies with the character, so it is
 * not Gallery history. Left uncovered, a canonical avatar outlives its character
 * with no surface left to view or delete it through, while still counting
 * against the owner's storage quota forever (quota sums every non-hidden
 * image). Routing `avatar` and every hidden kind through the same predicate as
 * this one call, rather than two, keeps the rule impossible to state
 * inconsistently at the two call sites.
 *
 * Owner-scoped and guarded by kind AND entity, the same shape every purge here
 * uses, so a wrong character id can only ever delete nothing.
 */
export async function deleteNonGalleryCharacterImages(characterId: string, ownerId: string): Promise<number> {
  return purgeImagesWhere(
    and(
      eq(images.ownerId, ownerId),
      eq(images.entityKind, "character"),
      eq(images.entityId, characterId),
      notInArray(images.kind, [...GALLERY_IMAGE_KINDS]),
    ),
  );
}

/**
 * The invalidation call, contained here as well as inside the hook. The
 * registered implementation already swallows its own failures, but the delete
 * now runs DOWNSTREAM of this call rather than before it, so "maintenance never
 * fails the delete that triggered it" stops being a property of one
 * implementation and becomes a property of the sequence.
 */
async function invalidateDerivedState(imageIds: readonly string[]): Promise<void> {
  try {
    await identityPackMaintenance?.invalidateForImages(imageIds);
  } catch (err) {
    log.warn("images", "identity pack invalidation before an image delete failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Null out the soft pointers entity rows keep at deleted image ids — a
 * gallery-deleted portrait leaves its character avatar-less (the portrait
 * studio's own rule), a deleted entity render leaves its location/item
 * imageless — never dangling. No-op for scene ids (nothing points at scenes).
 *
 * Clearing a canonical portrait pointer also invalidates whatever was derived
 * FROM it: an identity pack whose source pointer just went away must not keep
 * serving its crop. Read-time hash
 * verification is still the backstop — this is the belt to its braces, for the
 * paths that bypass the assignment triggers.
 *
 * The two portrait pointers clear INDEPENDENTLY, because they answer different
 * questions: deleting the ACCEPTED portrait leaves the character with no
 * identity source (both accepted columns go together — an acceptance time with
 * nothing accepted is not a state), while deleting a candidate the owner never
 * accepted must leave the accepted portrait and its pack exactly where they
 * were. That separation is the whole point of the second pointer.
 *
 * The delete paths retire the pack in `purgeImagesWhere`, before the row goes,
 * so for a deleted id this pass usually matches nothing. It stays because the
 * ids a caller hands over are not always the ids that were deleted: the Gallery's
 * bulk route passes every REQUESTED id, and one the kind guard skipped still owns
 * its image row — so its pack is still reachable by source id and must go with
 * the pointer.
 */
export async function clearEntityImagePointers(imageIds: readonly string[]): Promise<void> {
  if (imageIds.length === 0) return;
  const ids = [...imageIds];
  await Promise.all([
    db().update(characters).set({ avatarImageId: null }).where(inArray(characters.avatarImageId, ids)),
    db().update(locations).set({ imageId: null }).where(inArray(locations.imageId, ids)),
    db().update(items).set({ imageId: null }).where(inArray(items.imageId, ids)),
  ]);
  // Sequential, not a fourth entry above: two concurrent statements updating
  // overlapping rows of the same table is a deadlock waiting for the day a
  // character's accepted portrait and its candidate are deleted in one call.
  await db()
    .update(characters)
    .set({ acceptedAvatarImageId: null, acceptedAt: null })
    .where(inArray(characters.acceptedAvatarImageId, ids));
  await identityPackMaintenance?.invalidateForImages(ids);
}

/**
 * Hard-delete many owned images by id in one statement — the bulk counterpart to
 * deleteOwnedImage, used by the Gallery's "Delete all" (delete every scene the
 * active world/character filter shows). Owner-scoped with the same optional
 * `kind` guard, so ids not owned / of the wrong kind / already gone are silently
 * skipped — a caller can never reach another owner's or another class of asset.
 * Files are unlinked best-effort (image_sweep reconciles stragglers). Returns
 * the count actually removed.
 */
export async function deleteOwnedImages(
  imageIds: string[],
  ownerId: string,
  opts: { kind?: ImageKind; kinds?: readonly ImageKind[] } = {},
): Promise<number> {
  if (imageIds.length === 0) return 0;
  return purgeImagesWhere(and(inArray(images.id, imageIds), eq(images.ownerId, ownerId), kindGuard(opts)));
}
