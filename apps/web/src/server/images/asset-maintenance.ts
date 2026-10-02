import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db, images, jobs, JOB_STALE_MS, reclaimOrphanedJobs } from "../db";
import { log } from "@/server/log";
import { runRetentionPasses } from "@/server/retention";
import { absoluteImagePath, containedAbsoluteImagePath, dataRoot, imagesDirectoryPath } from "./paths";
import { imageMeta, failImage, failureStamp, mergeMetaSql, RENDER_LEASE_META_KEY } from "./asset-storage";
import { purgeImagesWhere, clearEntityImagePointers } from "./asset-deletion";
import { identityPackMaintenance, referenceViewMaintenance } from "./asset-lifecycle-hooks";

export interface SweepResult {
  filesScanned: number;
  rowsScanned: number;
  orphanFilesRemoved: number;
  stalePendingFilesRemoved: number;
  rowsMarkedFailed: number;
  /** Long-failed rows hard-deleted by the retention pass. */
  failedRowsRetired: number;
  errors: string[];
}

export interface SweepOptions {
  /** Restrict the sweep to one owner's rows + directory (tests, per-user maintenance). */
  ownerId?: string;
  now?: Date;
}

/**
 * Orphan files and crash-leftover `*.pending.webp` temps younger than this (by
 * mtime) are left alone — a write may be mid-protocol.
 */
const ORPHAN_FILE_GRACE_MS = 10 * 60_000;

/**
 * How long a `pending` row with NO render lease may wait before the sweep fails
 * it. A leased row is judged by its lease alone: it is reclaimed once the lease
 * has been silent for {@link JOB_STALE_MS}, however long the render has run.
 *
 * An unleased row was reserved outside `runImagePipeline`, by a direct
 * `createImageAsset` caller — the image lab, the Image Generator settle, the
 * identity-pack trial and derive, reference-view upload and copy, body-reference
 * upload, uploads — which does not beat. Each of those reserves its row once the
 * bytes are already in hand, so its age is the only signal left and two hours is
 * far beyond any such write.
 */
const UNLEASED_PENDING_ROW_GRACE_MS = 2 * 60 * 60_000;

/** The text a reclaimed pending row records — what the failed tile reads. */
const STALE_PENDING_ROW_ERROR = "stale pending row reclaimed by image_sweep";

/**
 * How long a `failed` row outlives the failure that produced it.
 *
 * A failed row is not garbage immediately: the scene strip, the portrait studio
 * and the entity studio each paint a "this render failed" tile from one, which
 * is how a player learns their render did not happen. A day later nobody is
 * looking and what remains is a row with no file, no bytes and no reader — the
 * eight that had accumulated by 2026-08-24 were all July/August scene failures
 * (owner report). Retention deletes it then, so the lifecycle finally closes:
 * `pending` → `failed` → gone, instead of `failed` forever.
 */
const FAILED_ROW_RETENTION_MS = 24 * 60 * 60_000;

/**
 * At most this many rows leave in one pass, oldest failure first. A burst of
 * failures drains over several passes, loudly, rather than in one statement.
 */
const FAILED_ROW_RETIREMENT_LIMIT = 200;

/**
 * Below this many rows in scope, "most of them are failed" is noise rather than
 * a signal — a fresh install, or a per-owner sweep of someone with three
 * images — so a small database still gets cleaned.
 */
const RETENTION_RAIL_MIN_ROWS = 20;

/** What retention needs to know about one failed row. */
export interface FailedImageCandidate {
  id: string;
  meta: unknown;
  createdAt: Date;
}

export interface FailedImageRetirementPlan {
  /** Rows to purge — oldest failure first, capped at one pass's budget. */
  ids: string[];
  /** The failed set is too large to read as garbage; nothing is retired. */
  disagreement: boolean;
}

/**
 * Which failed rows have outlived {@link FAILED_ROW_RETENTION_MS} — the decision
 * half of the retention pass, kept pure so the rule is testable without a
 * database (docs/images/asset-registry.md).
 *
 * The clock is `meta.failedAt`, stamped by {@link failImage}. `created_at` is the
 * fallback for rows that failed before that stamp existed; those are older than
 * the window by definition, so the fallback only ever frees genuine legacy
 * garbage.
 *
 * **Safety rail** — the row-side counterpart to the file side's empty-table
 * check in sweepOrphans: when MOST of the rows in scope are expired failures, that reading
 * is the database and the volume disagreeing (a volume that did not mount, a
 * mis-set `DATA_ROOT`, which marks every ready row failed), not a database full
 * of garbage. Deleting rows on that reading is exactly as unrecoverable as
 * wiping the volume, so nothing is retired and the disagreement is logged.
 */
export function planFailedImageRetirement(
  failed: readonly FailedImageCandidate[],
  rowsScanned: number,
  now: Date,
): FailedImageRetirementPlan {
  const expired = failed
    .map((row) => ({ id: row.id, failedAtMs: failedAtMs(row) }))
    .filter((row) => now.getTime() - row.failedAtMs >= FAILED_ROW_RETENTION_MS)
    .sort((left, right) => left.failedAtMs - right.failedAtMs);
  if (expired.length === 0) return { ids: [], disagreement: false };
  if (rowsScanned >= RETENTION_RAIL_MIN_ROWS && expired.length * 2 > rowsScanned) {
    return { ids: [], disagreement: true };
  }
  return { ids: expired.slice(0, FAILED_ROW_RETIREMENT_LIMIT).map((row) => row.id), disagreement: false };
}

/** When the failure happened: the stamp `failImage` wrote, else the row's own creation. */
function failedAtMs(row: FailedImageCandidate): number {
  const stamped = imageMeta(row.meta).failedAt;
  const parsed = typeof stamped === "string" ? Date.parse(stamped) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : row.createdAt.getTime();
}

/**
 * Fail every `pending` row whose render is presumed dead, in ONE guarded UPDATE,
 * and return the ids it actually failed.
 *
 * - **Leased** (`runImagePipeline` beats `meta.renderLeaseAtMs` every 30 s): dead
 *   once the lease has been silent for {@link JOB_STALE_MS}. A render still
 *   running keeps its row however long it takes.
 * - **Unleased**: dead once the row is older than
 *   {@link UNLEASED_PENDING_ROW_GRACE_MS}.
 *
 * The decision lives in the statement's own WHERE, never in a row read earlier:
 * a save landing or a heartbeat committing before this UPDATE is what Postgres
 * re-checks it against, so either one wins and the row is left alone. The
 * failure stamp merges in SQL for the same reason. The lease is cast only once
 * it is known to be a JSON number, so a malformed value reads as "no lease"
 * instead of failing the statement.
 */
export async function reclaimStalePendingRows(now: Date, ownerId?: string): Promise<string[]> {
  const lease = sql`${images.meta} -> ${RENDER_LEASE_META_KEY}::text`;
  const leaseAtMs = sql`(${images.meta} ->> ${RENDER_LEASE_META_KEY}::text)::numeric`;
  const presumedDead = sql`case
    when jsonb_typeof(${lease}) = 'number' then ${leaseAtMs} < ${now.getTime() - JOB_STALE_MS}::numeric
    else ${lt(images.createdAt, new Date(now.getTime() - UNLEASED_PENDING_ROW_GRACE_MS))}
  end`;
  const reclaimed = await db()
    .update(images)
    .set({
      status: "failed",
      meta: mergeMetaSql(failureStamp(STALE_PENDING_ROW_ERROR, now), [RENDER_LEASE_META_KEY]),
    })
    .where(
      and(
        eq(images.status, "pending"),
        ownerId === undefined ? undefined : eq(images.ownerId, ownerId),
        presumedDead,
      ),
    )
    .returning({ id: images.id });
  return reclaimed.map((row) => row.id);
}

/**
 * Idempotent rows↔files reconciliation (docs/images/asset-registry.md). Both directions:
 * ready rows whose file vanished are marked failed; pending rows whose render is
 * presumed dead are reclaimed ({@link reclaimStalePendingRows}); files without a
 * row (and crash-leftover `.pending.webp` temps) older than
 * {@link ORPHAN_FILE_GRACE_MS} are removed. Never throws, and every scanned or
 * row-derived path passes through the same DATA_ROOT containment and symlink
 * checks as ordinary asset access.
 *
 * A third pass RETIRES what the first two produce: a row failed longer ago than
 * {@link FAILED_ROW_RETENTION_MS} is hard-deleted, so a failure is user-visible
 * feedback for a day and then stops being a row at all.
 */
export async function sweepOrphans(opts: SweepOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const result: SweepResult = {
    filesScanned: 0,
    rowsScanned: 0,
    orphanFilesRemoved: 0,
    stalePendingFilesRemoved: 0,
    rowsMarkedFailed: 0,
    failedRowsRetired: 0,
    errors: [],
  };
  try {
    const baseQuery = db()
      .select({ id: images.id, ownerId: images.ownerId, path: images.path, status: images.status })
      .from(images);
    const rows = opts.ownerId ? await baseQuery.where(eq(images.ownerId, opts.ownerId)) : await baseQuery;
    result.rowsScanned = rows.length;
    const rowPaths = new Set(rows.map((row) => row.path));

    const root = dataRoot();
    const imagesDir = imagesDirectoryPath(opts.ownerId);
    let entries: Array<{ parentPath: string; name: string; isFile(): boolean }> = [];
    try {
      entries = await fs.readdir(imagesDir, { recursive: true, withFileTypes: true });
    } catch {
      // no data directory yet — nothing on the files side
    }

    // Safety rail, now that this actually runs on a schedule: NO rows at all with
    // files on disk means the database and the volume disagree — a fresh or branched
    // database, a mis-set DATABASE_URL — not that every file is an orphan. Wiping the
    // volume on that reading is unrecoverable, so the file side is skipped entirely
    // and the disagreement is logged. (Row-side reconciliation is a no-op anyway with
    // no rows, so nothing else is lost.)
    const filesPresent = entries.some((entry) => entry.isFile());
    if (rows.length === 0 && filesPresent) {
      log.warn("images", "sweep skipped the file side: image rows are empty but files exist", {
        dir: path.relative(root, imagesDir).split(path.sep).join("/"),
      });
      return result;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      result.filesScanned += 1;
      const absolute = containedAbsoluteImagePath(path.join(entry.parentPath, entry.name));
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const isPendingTemp = entry.name.endsWith(".pending.webp");
      if (!isPendingTemp && rowPaths.has(relative)) continue;
      try {
        const stat = await fs.stat(absolute);
        if (now.getTime() - stat.mtimeMs < ORPHAN_FILE_GRACE_MS) continue;
        await fs.unlink(absolute);
        if (isPendingTemp) {
          result.stalePendingFilesRemoved += 1;
          log.warn("images", "swept stale pending temp file", { path: relative });
        } else {
          result.orphanFilesRemoved += 1;
          log.warn("images", "swept orphan file without a row", { path: relative });
        }
      } catch (err) {
        result.errors.push(`file ${relative}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const row of rows) {
      if (row.status !== "ready") continue;
      try {
        const exists = await fileExists(absoluteImagePath(row));
        if (exists) continue;
        // Through `failImage` rather than a bare status update so the row carries
        // the `failedAt` stamp retention reads: this is precisely the transition
        // whose failure time is nothing like its `created_at`.
        await failImage(row.id, "ready row lost its file; reclaimed by image_sweep");
        result.rowsMarkedFailed += 1;
        log.warn("images", "ready row lost its file; marked failed", { imageId: row.id, path: row.path });
      } catch (err) {
        result.errors.push(`row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Pending rows are judged at write time, not from the read above: counted
    // only when the guarded UPDATE actually failed them.
    try {
      const reclaimed = await reclaimStalePendingRows(now, opts.ownerId);
      result.rowsMarkedFailed += reclaimed.length;
      for (const imageId of reclaimed) log.warn("images", "stale pending row marked failed", { imageId });
    } catch (err) {
      result.errors.push(`pending reclaim: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Last, so a row this pass just marked failed carries a stamp of NOW and is
    // therefore a day away from being eligible — never reconciled and retired in
    // the same tick.
    try {
      await retireFailedRows(now, opts, result);
    } catch (err) {
      result.errors.push(`retention: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    log.warn("images", "sweepOrphans degraded", { error: result.errors.at(-1) ?? "unknown" });
  }
  return result;
}

/**
 * Hard-delete the rows {@link planFailedImageRetirement} judges expired — the IO
 * half of retention, owner-scoped exactly like the pass around it.
 */
async function retireFailedRows(now: Date, opts: SweepOptions, result: SweepResult): Promise<void> {
  const ownerScope = opts.ownerId === undefined ? undefined : eq(images.ownerId, opts.ownerId);
  const failed = await db()
    .select({ id: images.id, meta: images.meta, createdAt: images.createdAt })
    .from(images)
    .where(and(eq(images.status, "failed"), ownerScope));
  const plan = planFailedImageRetirement(failed, result.rowsScanned, now);
  if (plan.disagreement) {
    log.warn("images", "retention skipped: most rows in scope are long-failed", {
      expiredFailures: failed.length,
      rowsScanned: result.rowsScanned,
    });
    return;
  }
  const removed = await purgeRetiredFailedRows(plan.ids, opts.ownerId);
  if (removed.length > 0) log.warn("images", "retired rows that failed over a day ago", { removed: removed.length });
  result.failedRowsRetired += removed.length;
}

/**
 * Purge the failed rows retention planned to retire, and return the ids it
 * actually removed.
 *
 * It goes through `purgeImagesWhere` like every other delete path, so a retired
 * row takes its identity-pack derivations and any stray file with it. The
 * predicate that helper both selects and deletes by is guarded on
 * `status = 'failed'`: the plan was read a moment earlier, and a row an
 * in-place recovery claims in between (`failed → pending`,
 * `image-output-recovery.ts`) is a live render again — neither its row nor the
 * file the recovery is writing may go. The soft pointers entity rows keep are
 * cleared the way the Gallery's own delete clears them, for the rows actually
 * removed and no others: a character whose avatar failed a day ago must not be
 * left pointing at a row that no longer exists, nor lose a pointer to one that
 * survived.
 */
export async function purgeRetiredFailedRows(ids: readonly string[], ownerId?: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const ownerScope = ownerId === undefined ? undefined : eq(images.ownerId, ownerId);
  await purgeImagesWhere(and(inArray(images.id, [...ids]), ownerScope, eq(images.status, "failed")));
  // What actually went, read back rather than taken from the helper's count:
  // a planned row that survived is still there.
  const surviving = new Set(
    (await db().select({ id: images.id }).from(images).where(inArray(images.id, [...ids]))).map((row) => row.id),
  );
  const removed = ids.filter((id) => !surviving.has(id));
  if (removed.length > 0) await clearEntityImagePointers(removed);
  return removed;
}

async function fileExists(absolute: string): Promise<boolean> {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduling the sweep
// ---------------------------------------------------------------------------

/**
 * `sweepOrphans` had no caller — it was written, tested, and documented as
 * "on-demand + periodic", but nothing ever ran it, so a row whose render died
 * (a deploy replacing the machine mid-generation) stayed `pending` forever and
 * painted a tile that never resolved (owner report 2026-08-02).
 *
 * Scheduling shape: **request-driven, not a timer** — the same pattern the durable
 * time-jobs use ("the boot/next-request sweep", `engine/sim-time-jobs.ts`). A
 * `setInterval` inside a Next server has no owner, no visibility, and silently
 * doubles under a second instance; a kick off work the app is already doing needs
 * no infrastructure and is self-limiting. The kick sits on `runImagePipeline`, so
 * maintenance runs while the app is doing image work — exactly when orphans are
 * created, and exactly when a stale tile is about to be looked at.
 *
 * Lives here rather than in its own module because the scheduler and the sweep it
 * schedules would otherwise import each other (a real cycle, and `pnpm lint:cycles`
 * is right to refuse it).
 */

/** How often the reconciliation actually runs. Orphans are rare and never urgent. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/** In-process throttle: a burst of renders costs one durable check, not one per render. */
let lastSweepAttemptMs = 0;

/** Guards a second kick starting while one pass is still running in this process. */
let sweepRunning = false;

/** Whether an `image_sweep` row exists inside the interval — the durable "already swept". */
async function sweptRecently(now: Date): Promise<boolean> {
  const [recent] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, "image_sweep"), gt(jobs.createdAt, new Date(now.getTime() - SWEEP_INTERVAL_MS))))
    .limit(1);
  return recent !== undefined;
}

/**
 * One reconciliation pass, recorded as an `image_sweep` job row — the row IS the
 * "last swept" marker the durable guard reads. Also reclaims job rows orphaned the
 * same way the image rows were (`reclaimOrphanedJobs`): one periodic tick, both
 * kinds of leftovers.
 */
async function runScheduledSweep(now: Date): Promise<void> {
  const [row] = await db()
    .insert(jobs)
    .values({ type: "image_sweep", status: "running", payload: {}, attempts: 1, startedAt: now })
    .returning({ id: jobs.id });
  if (!row) return;
  try {
    const result = await sweepOrphans();
    const jobsReclaimed = await reclaimOrphanedJobs();
    // Derived-asset maintenance rides the same tick: identity-pack consistency
    // findings (flagged, never silently repaired) and the bounded retention
    // cleanup for superseded crops. It runs AFTER `sweepOrphans` so a crop whose
    // file vanished is already marked failed when the findings look at it.
    const identity = (await identityPackMaintenance?.sweep(now)) ?? {};
    // The reference-view set's retired assets, on the same tick and the same
    // 7-day window. Contained inside its own hook, like the pack pass: a sweep
    // that cannot collect superseded views must still report everything else.
    const referenceViews = (await referenceViewMaintenance?.sweep(now)) ?? {};
    // Database retention rides the same tick (`@/server/retention`): bounded
    // deletes of expired telemetry, finished jobs, and expired auth rows. Each
    // pass isolates its own failure, so this call never throws.
    const retention = await runRetentionPasses(now);
    const summary = { ...result, jobsReclaimed, ...identity, ...referenceViews, ...retention };
    const identityTotal =
      Object.values(identity).reduce((total, value) => total + value, 0) +
      Object.values(referenceViews).reduce((total, value) => total + value, 0);
    const retentionTotal = Object.values(retention).reduce((total, value) => total + value, 0);
    if (
      result.orphanFilesRemoved +
        result.stalePendingFilesRemoved +
        result.rowsMarkedFailed +
        result.failedRowsRetired +
        jobsReclaimed +
        identityTotal +
        retentionTotal >
      0
    ) {
      log.warn("images", "sweep reconciled orphaned rows/files", summary);
    }
    await db().update(jobs).set({ status: "done", payload: summary, finishedAt: new Date() }).where(eq(jobs.id, row.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("images", "scheduled image sweep failed", { error: message });
    try {
      await db()
        .update(jobs)
        .set({ status: "failed", error: message.slice(0, 500), finishedAt: new Date() })
        .where(eq(jobs.id, row.id));
    } catch {
      // the marker row is bookkeeping; failing to close it just means the next kick re-sweeps
    }
  }
}

/**
 * Fire-and-forget maintenance kick. Returns immediately and never throws, so the
 * render that triggered it is never blocked, delayed, or failed by maintenance.
 * Safe to call on every image generation. A double sweep would be harmless anyway
 * (`sweepOrphans` is idempotent) — the guards are about cost, not correctness.
 */
export function kickImageSweep(): void {
  const now = new Date();
  if (sweepRunning || now.getTime() - lastSweepAttemptMs < SWEEP_INTERVAL_MS) return;
  lastSweepAttemptMs = now.getTime();
  sweepRunning = true;
  void (async () => {
    try {
      if (!(await sweptRecently(now))) await runScheduledSweep(now);
    } catch (err) {
      log.warn("images", "image sweep kick failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      sweepRunning = false;
    }
  })();
}
