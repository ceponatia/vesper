import { and, eq, inArray } from "drizzle-orm";
import { images } from "../db";
import { log } from "@/server/log";
import { purgeImagesWhere } from "./asset-deletion";
import { registerReferenceViewMaintenance } from "./asset-lifecycle-hooks";
import { clearReferenceViewAssetPointers, retiredReferenceViewAssets } from "./reference-view-store";

/**
 * Retention for the reference view set: the bounded pass that collects a
 * SUPERSEDED view's bytes once nobody could still want to look at them.
 *
 * Rows are never deleted — they are the slot's history, and re-accepting an
 * earlier portrait revives exactly the views rendered from it. Their ASSETS are
 * a different question: a superseded view's file has no future consumer, and
 * without this pass every regenerate would leave one behind forever.
 *
 * {@link installReferenceViewMaintenance} at the foot of this file is how the
 * pass reaches asset-maintenance through asset-lifecycle-hooks.ts, without
 * closing a cycle through this service's asset-deletion dependency.
 */

/**
 * How long a retired view keeps its bytes. The identity pack's window, for the
 * identity pack's reason: a week is long enough that "why did this view change
 * last Tuesday?" can still be answered from the actual picture, short enough
 * that nobody is storing months of superseded bodies.
 */
export const REFERENCE_VIEW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * The window in whole days, for the one sentence the studio's history list owes
 * its reader: a list bounded by a sweep the owner cannot see is a list that
 * silently lies about what a slot has produced.
 *
 * Derived here rather than typed as a number at the UI boundary, so moving the
 * window moves the promise with it.
 */
export function referenceViewRetentionDays(): number {
  return Math.round(REFERENCE_VIEW_RETENTION_MS / (24 * 60 * 60_000));
}

/** Rows touched per pass. Maintenance rides a render; it never becomes one. */
const REFERENCE_VIEW_CLEANUP_LIMIT = 200;

export interface ReferenceViewSweepOptions {
  now?: Date;
  limit?: number;
}

/**
 * Purge the assets of retired views older than the window, and null the pointers
 * that named them.
 *
 * `current` rows are never touched, whatever their status: a stale or failed
 * current row is what the studio is showing its owner right now, and collecting
 * its bytes would turn a tile they can act on into a broken image.
 *
 * The pointer is cleared AFTER the purge, not before: the FK is `set null`
 * anyway, so this is bookkeeping rather than integrity, and doing it in this
 * order means a crash between the two leaves rows whose asset is gone — which
 * the projection already refuses — rather than assets nothing points at, which
 * only the orphan sweep would ever find.
 */
export async function referenceViewSweepPass(options: ReferenceViewSweepOptions = {}): Promise<Record<string, number>> {
  const now = options.now ?? new Date();
  const rows = await retiredReferenceViewAssets(
    new Date(now.getTime() - REFERENCE_VIEW_RETENTION_MS),
    options.limit ?? REFERENCE_VIEW_CLEANUP_LIMIT,
  );
  if (rows.length === 0) return { referenceViewAssetsPurged: 0 };

  const imageIds = [...new Set(rows.flatMap((row) => (row.imageId === null ? [] : [row.imageId])))];
  // Kind-guarded like every purge here, so a pointer that somehow named another
  // class of asset can only ever delete nothing.
  const removed = await purgeImagesWhere(and(inArray(images.id, imageIds), eq(images.kind, "reference_view")));
  await clearReferenceViewAssetPointers(rows.map((row) => row.id));
  return { referenceViewAssetsPurged: removed };
}

/**
 * Hand the pass to asset-lifecycle-hooks.ts. Called once, from the folder barrel — see
 * `installIdentityPackMaintenance` for why the registration lives there rather
 * than being a side effect of loading this module.
 */
export function installReferenceViewMaintenance(): void {
  registerReferenceViewMaintenance({
    sweep: async (now) => {
      try {
        return await referenceViewSweepPass({ now });
      } catch (err) {
        // Maintenance never fails the sweep it rides, and never the render that
        // kicked the sweep. The next pass finds the same rows.
        log.warn("images", "reference view retention pass failed", {
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        });
        return {};
      }
    },
  });
}
