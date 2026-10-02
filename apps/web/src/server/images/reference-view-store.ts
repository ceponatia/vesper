import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { parseOr, parseOrNull } from "@/lib/parse";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  allReferenceViews,
  characterProfileSchema,
  emptyCharacterProfile,
  plannedReferenceViews,
  emptyReferenceViewSetSummary,
  projectReferenceViewSlots,
  REFERENCE_VIEW_GENERATION_VERSION,
  referenceViewAngleIdSchema,
  referenceViewBodySetKey,
  referenceViewBodySetMoved,
  referenceViewBuildsOnApproval,
  referenceViewDescendantBusy,
  referenceViewHistoryVerdict,
  referenceViewLineBusy,
  referenceViewFeedbackSchema,
  referenceViewLineageId,
  referenceViewsReadyToBuild,
  referenceViewUpstream,
  referenceViewWardrobeSchema,
  sameReferenceView,
  type CharacterProfile,
  type ReferenceView,
  type ReferenceViewHistoryEntry,
  type ReferenceViewMethod,
  type ReferenceViewSetSummary,
  type ReferenceViewSlotFacts,
  type ReferenceViewSlotProjection,
  type ReferenceViewSlotRow,
  type ReferenceViewSummary,
  type ReferenceViewReviewRequest,
} from "@/contracts";
import { characterReferenceViews, characters, db, images, jobs, JOB_STALE_MS } from "../db";
import {
  createImageAsset,
  failImage,
  mergeMetaSql,
  READY_RETIRED_META_KEYS,
  readImageBytes,
  reclaimAbandonedRenderRows,
  type ImageRow,
  type WrittenImageInfo,
} from "./asset-storage";
import { deleteOwnedImage } from "./asset-deletion";
import { paidOutputOffer, type PaidOutput } from "./paid-output";
import { absoluteImagePath, containedAbsoluteImagePath } from "./paths";
import { log } from "@/server/log";
import { currentSendableBodyReferences } from "./body-reference-store";
import { sourceContentHashOf } from "./identity-pack-store";

/**
 * The reference view SET's storage and its read-time projection — every write to
 * `character_reference_views`, and the one place a stored row becomes a state
 * the studio and the render lanes can act on.
 *
 * ## Why the projection lives here and only here
 *
 * A stored `status` says what the last writer did; it does not say whether the
 * view is still true. A `ready` row goes on saying `ready` after its portrait is
 * replaced, after its asset is deleted, and after the instruction wording it was
 * rendered under changes. Comparing those things at read time — rather than
 * chasing them with background writes — is what lets the set survive a portrait
 * being accepted, un-accepted, and accepted again: nothing was rewritten, so
 * re-accepting the earlier portrait makes exactly the views rendered from it
 * current again.
 *
 * The rule itself is pure (`contracts/images/reference-views.ts`); this module
 * supplies it with rows.
 *
 * ## Refusals are values
 *
 * Nothing here throws for a schema-legal request. A slot that has no row is
 * `missing`, a row whose angle or wardrobe left the registry is dropped with a
 * diagnostic, and a character that is not the caller's reads as a character with
 * no views — the same not-yours ≡ gone indistinguishability every character
 * surface keeps.
 */

/** A row whose stored ids no longer resolve against the registry. Dropped, never guessed at. */
export const REFERENCE_VIEW_UNKNOWN = "images.reference_views.unknown_view";

/**
 * A queued view did not start because the view it is built from is no longer
 * approved — regenerated, undone or gone stale since the approval that queued
 * it. Nothing was reserved or rendered; that view's next approval queues it.
 * Pushed by the build lane when its read finds no approved upstream, and by the
 * reservation when the upstream moved after that read.
 */
export const REFERENCE_VIEW_UPSTREAM_UNAPPROVED = "images.reference_views.upstream_unapproved";

export type ReferenceViewRow = typeof characterReferenceViews.$inferSelect;

/** The same character lock serializes reservation, review and restoration. */
type ReferenceViewTransaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
export type ReferenceViewExecutor = ReturnType<typeof db> | ReferenceViewTransaction;
export async function withReferenceViewLock<T>(
  characterId: string,
  operation: (tx: ReferenceViewTransaction) => Promise<T>,
): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.select({ id: characters.id }).from(characters).where(eq(characters.id, characterId)).for("update");
    return operation(tx);
  });
}

/** A job payload lease. The attempt id is filled atomically when its worker reserves the row. */
export interface ReferenceViewLease extends ReferenceView {
  readonly attemptId: string | null;
}

export interface ReferenceViewLeaseClaim {
  readonly claimed: readonly ReferenceViewLease[];
  readonly busy: readonly ReferenceView[];
}

export const REFERENCE_VIEW_LEASE_EXPIRED = "images.reference_views.lease_expired";

type ReferenceViewLeaseJob = Pick<typeof jobs.$inferSelect, "id" | "ownerId" | "payload" | "heartbeatAt">;

function objectPayload(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>) }
    : {};
}

function payloadLeases(payload: unknown): ReferenceViewLease[] {
  const candidate = objectPayload(payload).leases;
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const angle = parseOrNull(referenceViewAngleIdSchema, record.angle);
    const wardrobe = parseOrNull(referenceViewWardrobeSchema, record.wardrobe);
    const attemptId = record.attemptId === null || typeof record.attemptId === "string" ? record.attemptId : null;
    return angle === null || wardrobe === null ? [] : [{ angle, wardrobe, attemptId }];
  });
}

function payloadReferenceViewAttemptIds(payload: unknown): string[] {
  const candidate = objectPayload(payload).referenceViewAttemptIds;
  if (!Array.isArray(candidate)) return [];
  return [...new Set(candidate.filter((value): value is string => typeof value === "string" && value.length > 0))]
    .slice(0, 64);
}

async function liveReferenceViewLeaseJobs(
  executor: ReferenceViewExecutor,
  characterId: string,
  now: Date,
  ownerId?: string,
  excludeJobId?: string,
): Promise<readonly ReferenceViewLeaseJob[]> {
  const rows = await executor
    .select({ id: jobs.id, ownerId: jobs.ownerId, payload: jobs.payload, heartbeatAt: jobs.heartbeatAt })
    .from(jobs)
    .where(and(
      eq(jobs.type, "reference_views"),
      inArray(jobs.status, ["queued", "running"]),
      gt(jobs.heartbeatAt, new Date(now.getTime() - JOB_STALE_MS)),
      sql`${jobs.payload} ->> 'characterId' = ${characterId}`,
      ownerId === undefined ? undefined : eq(jobs.ownerId, ownerId),
      excludeJobId === undefined ? undefined : ne(jobs.id, excludeJobId),
    ));
  return rows.filter((row) => payloadLeases(row.payload).length > 0);
}

/** Lock one live lease job before binding or settling an attempt. */
async function lockLiveReferenceViewLeaseJob(
  tx: ReferenceViewTransaction,
  input: { characterId: string; ownerId: string; jobId: string },
  now: Date,
): Promise<ReferenceViewLeaseJob | null> {
  const [job] = await tx
    .select({ id: jobs.id, ownerId: jobs.ownerId, payload: jobs.payload, heartbeatAt: jobs.heartbeatAt })
    .from(jobs)
    .where(and(
      eq(jobs.id, input.jobId),
      eq(jobs.ownerId, input.ownerId),
      eq(jobs.type, "reference_views"),
      eq(jobs.status, "running"),
      gt(jobs.heartbeatAt, new Date(now.getTime() - JOB_STALE_MS)),
      sql`${jobs.payload} ->> 'characterId' = ${input.characterId}`,
    ))
    .limit(1)
    .for("update");
  return job && payloadLeases(job.payload).length > 0 ? job : null;
}

/**
 * Fail every expired build job for this character, then every pending attempt
 * no live lease owns — under the character lock, on its transaction. An
 * abandoned attempt ends one of three ways, by what its render's own row says
 * ({@link abandonedViewRenders}):
 *
 * - the render still holds a live render lease: it is running, so the attempt
 *   stays `pending` and the next read judges it again;
 * - the render was paid for and its output never arrived — it recorded both
 *   ids before downloading, or failed undelivered before its build could say
 *   so: the attempt fails LINKED to that row, as `failReferenceView` would
 *   leave it, and the slot projects `recoverable`;
 * - anything else: the attempt fails with no link, retryable.
 *
 * Returns how many attempts it failed.
 */
async function reconcileReferenceViewLeasesInTransaction(
  tx: ReferenceViewTransaction,
  characterId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - JOB_STALE_MS);
  await tx
    .update(jobs)
    .set({
      status: "failed",
      error: "reference view lease expired before the job settled",
      finishedAt: now,
    })
    .where(and(
      eq(jobs.type, "reference_views"),
      inArray(jobs.status, ["queued", "running"]),
      lt(jobs.heartbeatAt, cutoff),
      sql`${jobs.payload} ->> 'characterId' = ${characterId}`,
    ));

  const liveJobs = await liveReferenceViewLeaseJobs(tx, characterId, now);
  const leasedAttempts = new Set(liveJobs.flatMap((job) => payloadLeases(job.payload).flatMap((lease) =>
    lease.attemptId === null ? [] : [lease.attemptId],
  )));
  const pending = await tx
    .select({ id: characterReferenceViews.id })
    .from(characterReferenceViews)
    .where(and(
      eq(characterReferenceViews.characterId, characterId),
      eq(characterReferenceViews.current, true),
      eq(characterReferenceViews.status, "pending"),
    ));
  const orphaned = pending.filter((row) => !leasedAttempts.has(row.id)).map((row) => row.id);
  if (orphaned.length === 0) return 0;
  const renders = await abandonedViewRenders(tx, characterId, orphaned, now);
  const cleared: string[] = [];
  let linked = 0;
  for (const attemptId of orphaned) {
    const render = renders.get(attemptId);
    // The render itself still beats its own lease: it is running, so the
    // attempt stays pending — building — until that lease lapses or the render
    // settles, exactly as the image sweep never fails a live render's row.
    if (render?.status === "pending") continue;
    if (render === undefined || paidOutputOffer(render).state !== "on_offer") {
      cleared.push(attemptId);
      continue;
    }
    // The render was paid for and its output never arrived: the attempt fails
    // linked to that render's row, with the upstream lineage it actually sent,
    // exactly as `failReferenceView` leaves an ordinary undelivered failure —
    // so the slot projects `recoverable` and Build never pays for it again.
    const sentUpstream = sentUpstreamLineage(render.meta);
    await tx
      .update(characterReferenceViews)
      .set({
        status: "failed",
        imageId: render.id,
        ...(sentUpstream === undefined ? {} : { upstreamViewId: sentUpstream }),
        failureCode: REFERENCE_VIEW_LEASE_EXPIRED,
        failureMessage: REFERENCE_VIEW_INTERRUPTED_PAID_MESSAGE,
      })
      .where(and(eq(characterReferenceViews.id, attemptId), eq(characterReferenceViews.status, "pending")));
    linked += 1;
  }
  if (cleared.length > 0) {
    await tx
      .update(characterReferenceViews)
      .set({
        status: "failed",
        // An abandoned attempt with no paid output to offer keeps no link: its
        // render never ran, never succeeded, or is already gone.
        imageId: null,
        failureCode: REFERENCE_VIEW_LEASE_EXPIRED,
        failureMessage: "The previous build was interrupted. This slot is ready to retry.",
      })
      .where(and(inArray(characterReferenceViews.id, cleared), eq(characterReferenceViews.status, "pending")));
  }
  return cleared.length + linked;
}

/**
 * The stored failure message of an attempt whose build died after its render
 * was paid for, while the output was still downloading. True whether or not the
 * output can still be recovered: while it can, the slot projects `recoverable`.
 */
const REFERENCE_VIEW_INTERRUPTED_PAID_MESSAGE =
  "The previous build was interrupted while its paid image was downloading.";

/** The failure an abandoned view render's own row records when reconciliation reclaims it. */
const REFERENCE_VIEW_RENDER_ABANDONED_ERROR = "render abandoned with its reference view build; reclaimed on read";

/** One view render's row, as reconciliation reads it. */
type ViewRenderRow = Pick<ImageRow, "id" | "status" | "meta">;

/**
 * The render rows of attempts whose build lease expired, by attempt id, each
 * settled as far as the build's death allows.
 *
 * A view render's row names its attempt (`meta.referenceView.attemptId`, written
 * when the build reserves it), so this needs no link on the pending attempt. A
 * render row still `pending` is reclaimed here, on the caller's transaction,
 * through the image sweep's own guarded shape (`reclaimAbandonedRenderRows`) —
 * the build that ran it is gone, so its silence is not waited on for the next
 * scheduled sweep — unless the row still holds a live render lease, which
 * leaves it `pending`. The reclaim keeps `meta.render`, so a render that
 * recorded its paid output's ids before it downloaded now offers that output.
 */
async function abandonedViewRenders(
  tx: ReferenceViewTransaction,
  characterId: string,
  attemptIds: readonly string[],
  now: Date,
): Promise<Map<string, ViewRenderRow>> {
  // Owner-, kind- and entity-scoped like every asset read here: the character's
  // owner owns its views' renders.
  const [character] = await tx.select({ ownerId: characters.ownerId }).from(characters).where(eq(characters.id, characterId)).limit(1);
  if (character === undefined) return new Map();
  const attemptKey = sql<string>`(${images.meta} -> 'referenceView' ->> 'attemptId')`;
  const rows = await tx
    .select({ id: images.id, status: images.status, meta: images.meta, attemptId: attemptKey })
    .from(images)
    .where(and(
      eq(images.ownerId, character.ownerId),
      eq(images.kind, "reference_view"),
      eq(images.entityKind, "character"),
      eq(images.entityId, characterId),
      inArray(attemptKey, [...attemptIds]),
    ))
    .orderBy(desc(images.createdAt));
  const byAttempt = new Map<string, ViewRenderRow>();
  // One render per attempt; were there ever more, the newest is the one that ran last.
  for (const row of rows) {
    if (!byAttempt.has(row.attemptId)) byAttempt.set(row.attemptId, { id: row.id, status: row.status, meta: row.meta });
  }
  const pendingIds = [...byAttempt.values()].filter((row) => row.status === "pending").map((row) => row.id);
  const reclaimed = new Map(
    (await reclaimAbandonedRenderRows(tx, pendingIds, REFERENCE_VIEW_RENDER_ABANDONED_ERROR, now)).map((row) => [row.id, row]),
  );
  for (const imageId of reclaimed.keys()) {
    log.warn("images", "abandoned reference view render marked failed", { characterId, imageId });
  }
  return new Map([...byAttempt].map(([attemptId, row]) => [attemptId, reclaimed.get(row.id) ?? row]));
}

/** What a view render's row says it sent upstream (`meta.referenceView.upstream`, recorded only when sent). */
const renderedViewMetaSchema = z.object({
  referenceView: z.object({
    upstream: z.object({ lineageId: z.string().min(1) }).optional(),
  }),
});

/**
 * The upstream lineage a view render actually sent, read off its own row: the
 * lineage when the render recorded one, null when it recorded a view meta with
 * none — it sent no upstream — and undefined when the meta is unreadable, which
 * leaves the reservation's record standing.
 */
function sentUpstreamLineage(meta: unknown): string | null | undefined {
  const parsed = parseOrNull(renderedViewMetaSchema, meta);
  if (parsed === null) return undefined;
  return parsed.referenceView.upstream?.lineageId ?? null;
}

/** Reconcile expired leases and their abandoned pending attempts under the character lock. */
export function reconcileExpiredReferenceViewWork(characterId: string, now: Date = new Date()): Promise<number> {
  return withReferenceViewLock(characterId, (tx) => reconcileReferenceViewLeasesInTransaction(tx, characterId, now));
}

/** The error a lost view file settles its asset with — the image sweep's transition, on read. */
export const REFERENCE_VIEW_LOST_FILE_ERROR = "ready row lost its file; reclaimed on read";

/**
 * Whether a stored image's file is GONE — not merely unreadable for a moment.
 * Only a missing file (`ENOENT`) settles an asset: a transient read error must
 * never turn an approved view into a failed one, and a path that is not
 * canonical is left for the sweep to judge.
 */
async function imageFileGone(image: { id: string; ownerId: string; path: string }): Promise<boolean> {
  try {
    await fs.stat(absoluteImagePath(image));
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

/**
 * Settle one view asset whose file is gone exactly as `image_sweep` settles a
 * ready row that lost its file — `failImage`, which stamps the failure time
 * retention reads — instead of waiting for the next scheduled pass.
 *
 * The sheet reads an asset's row status, so a view whose bytes vanished would
 * otherwise go on reading `approved`: every build of the views made from it
 * would be charged, find no bytes to send, and render nothing, and Build would
 * offer them again. Once the asset is failed the view reads stale and its
 * dependents wait, as for any upstream that is no longer approved.
 *
 * Owner-scoped and kind-scoped; true when it settled the asset. Never throws.
 */
export async function failLostReferenceViewAsset(imageId: string, ownerId: string): Promise<boolean> {
  try {
    const [asset] = await db()
      .select({ id: images.id, ownerId: images.ownerId, path: images.path, status: images.status })
      .from(images)
      .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId), eq(images.kind, "reference_view")))
      .limit(1);
    if (asset?.status !== "ready" || !(await imageFileGone(asset))) return false;
    await failImage(asset.id, REFERENCE_VIEW_LOST_FILE_ERROR);
    log.warn("images", "reference view lost its file; marked failed", { imageId: asset.id });
    return true;
  } catch (error) {
    log.warn("images", "a lost reference view file could not be settled", {
      imageId,
      error: String(error).slice(0, 300),
    });
    return false;
  }
}

/**
 * Settle every CURRENT view of one character whose file is gone — the read-time
 * repair the sheet runs beside lease reconciliation, so a build never admits
 * (and charges) work from an upstream whose bytes no longer exist.
 */
export async function reconcileLostReferenceViewFiles(characterId: string): Promise<number> {
  const assets = await db()
    .select({ imageId: images.id, ownerId: images.ownerId })
    .from(characterReferenceViews)
    .innerJoin(images, eq(images.id, characterReferenceViews.imageId))
    .where(and(
      eq(characterReferenceViews.characterId, characterId),
      eq(characterReferenceViews.current, true),
      eq(images.status, "ready"),
    ));
  let settled = 0;
  for (const asset of assets) {
    if (await failLostReferenceViewAsset(asset.imageId, asset.ownerId)) settled += 1;
  }
  return settled;
}

/** Sweep every character that still has a pending attempt; live leases are preserved. */
export async function reconcileOrphanedReferenceViewAttempts(now: Date = new Date()): Promise<number> {
  const pending = await db()
    .selectDistinct({ characterId: characterReferenceViews.characterId })
    .from(characterReferenceViews)
    .where(and(
      eq(characterReferenceViews.current, true),
      eq(characterReferenceViews.status, "pending"),
    ));
  let reconciled = 0;
  for (const row of pending) {
    reconciled += await reconcileExpiredReferenceViewWork(row.characterId, now);
  }
  return reconciled;
}

/** Claim every currently available requested slot for one already-inserted job. */
export function claimReferenceViewLeases(input: {
  characterId: string;
  ownerId: string;
  jobId: string;
  targets: readonly ReferenceView[];
  now?: Date;
}): Promise<ReferenceViewLeaseClaim> {
  return withReferenceViewLock(input.characterId, async (tx) => {
    const now = input.now ?? new Date();
    await reconcileReferenceViewLeasesInTransaction(tx, input.characterId, now);
    const [job] = await tx
      .select({ id: jobs.id, ownerId: jobs.ownerId, payload: jobs.payload, heartbeatAt: jobs.heartbeatAt })
      .from(jobs)
      .where(and(
        eq(jobs.id, input.jobId),
        eq(jobs.ownerId, input.ownerId),
        eq(jobs.type, "reference_views"),
        eq(jobs.status, "running"),
        gt(jobs.heartbeatAt, new Date(now.getTime() - JOB_STALE_MS)),
        sql`${jobs.payload} ->> 'characterId' = ${input.characterId}`,
      ))
      .limit(1)
      .for("update");
    if (!job) return { claimed: [], busy: [...input.targets] };

    const others = leasedSlots(await liveReferenceViewLeaseJobs(tx, input.characterId, now, input.ownerId, input.jobId));
    const occupied = new Set(others.map(slotKey));
    // Every slot building now, as the lock serializes it: other live leases,
    // and pending attempts (reconciliation above has already failed every
    // pending attempt no live lease owns, but for one whose render still
    // holds its own live render lease — still running, so still building).
    const building = [...others, ...(await pendingReferenceViewSlots(tx, input.characterId))];
    const claimed: ReferenceViewLease[] = [];
    const busy: ReferenceView[] = [];
    for (const target of input.targets) {
      // The build order, under the same lock as the claim: a slot whose
      // upstream (at any depth) or whose dependent (at any depth) is building
      // — or was just claimed by this same request — is `busy`, never leased,
      // so it is never charged. Two requests that each passed the route's
      // pre-admission checks cannot both lease one line of the sheet.
      if (occupied.has(slotKey(target)) || referenceViewLineBusy(target, [...building, ...claimed])) busy.push(target);
      else claimed.push({ ...target, attemptId: null });
    }
    const payload = objectPayload(job.payload);
    const [updated] = await tx
      .update(jobs)
      .set({
        payload: {
          ...payload,
          targets: claimed.map(slotKey),
          leases: claimed,
        },
      })
      .where(and(
        eq(jobs.id, job.id),
        eq(jobs.status, "running"),
        gt(jobs.heartbeatAt, new Date(now.getTime() - JOB_STALE_MS)),
      ))
      .returning({ id: jobs.id });
    if (!updated) return { claimed: [], busy: [...input.targets] };
    return { claimed, busy };
  });
}

/**
 * Whether one slot currently belongs to a heartbeat-live lease — a build's, or
 * a recovery's claim (`claimReferenceViewRecovery`). `excludeJobId` leaves out
 * the caller's own lease, so a recovery's commit does not find itself busy.
 */
export async function referenceViewSlotBusy(
  characterId: string,
  ownerId: string,
  view: ReferenceView,
  executor: ReferenceViewExecutor = db(),
  now: Date = new Date(),
  excludeJobId?: string,
): Promise<boolean> {
  const live = await liveReferenceViewLeaseJobs(executor, characterId, now, ownerId, excludeJobId);
  return live.some((job) => payloadLeases(job.payload).some((lease) => slotKey(lease) === slotKey(view)));
}

/** Every slot a heartbeat-live build holds a lease on, from jobs already read. */
function leasedSlots(live: readonly ReferenceViewLeaseJob[]): ReferenceView[] {
  return live.flatMap((job) => payloadLeases(job.payload).map((lease) => ({ angle: lease.angle, wardrobe: lease.wardrobe })));
}

/**
 * Every slot that is building right now: leased by a heartbeat-live job, or
 * holding a pending current attempt. Read on the caller's connection, so a
 * write under the character lock sees what the lock serializes.
 */
async function buildingReferenceViewSlots(
  executor: ReferenceViewExecutor,
  characterId: string,
  ownerId: string,
  now: Date = new Date(),
  excludeJobId?: string,
): Promise<ReferenceView[]> {
  const leased = leasedSlots(await liveReferenceViewLeaseJobs(executor, characterId, now, ownerId, excludeJobId));
  return [...leased, ...(await pendingReferenceViewSlots(executor, characterId))];
}

/** The slots holding a pending current attempt, on the caller's connection. */
async function pendingReferenceViewSlots(executor: ReferenceViewExecutor, characterId: string): Promise<ReferenceView[]> {
  const pending = await executor
    .select({ angleId: characterReferenceViews.angleId, wardrobe: characterReferenceViews.wardrobe })
    .from(characterReferenceViews)
    .where(and(
      eq(characterReferenceViews.characterId, characterId),
      eq(characterReferenceViews.current, true),
      eq(characterReferenceViews.status, "pending"),
    ));
  return pending.flatMap((row) => {
    const angle = parseOrNull(referenceViewAngleIdSchema, row.angleId);
    const wardrobe = parseOrNull(referenceViewWardrobeSchema, row.wardrobe);
    return angle === null || wardrobe === null ? [] : [{ angle, wardrobe }];
  });
}

/**
 * Whether any reference-view build is live for this character — a slot leased
 * by a heartbeat-live job, or a pending current attempt. A body-image write
 * waits while this is true: every view it renders sends, or records, the body
 * images, so changing them mid-build strands the renders already admitted and
 * charged. Read on the caller's connection, so a write under the character lock
 * sees what the lock serializes.
 */
export async function referenceViewBuildLive(
  characterId: string,
  ownerId: string,
  executor: ReferenceViewExecutor = db(),
  now: Date = new Date(),
): Promise<boolean> {
  return (await buildingReferenceViewSlots(executor, characterId, ownerId, now)).length > 0;
}

/**
 * Whether replacing this slot's view must wait: the slot itself belongs to a
 * live build, or a view built from it — directly or through another — is
 * building (`referenceViewDescendantBusy`). Replacing the upstream mid-render
 * would let those renders land stale, paid for and offered by Build again, so
 * an upload, a restoration and a regeneration of the slot all answer `busy`.
 * `excludeJobId` leaves out the caller's own lease (`referenceViewSlotBusy`).
 */
export async function referenceViewReplacementBusy(
  characterId: string,
  ownerId: string,
  view: ReferenceView,
  executor: ReferenceViewExecutor = db(),
  now: Date = new Date(),
  excludeJobId?: string,
): Promise<boolean> {
  if (await referenceViewSlotBusy(characterId, ownerId, view, executor, now, excludeJobId)) return true;
  return referenceViewDescendantBusy(view, await buildingReferenceViewSlots(executor, characterId, ownerId, now, excludeJobId));
}

/** Shared with the sweep; restoration eligibility expires even before a delayed sweep runs. */
export const REFERENCE_VIEW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Why a retained attempt cannot be restored, or null when it can.
 *
 * `approvedUpstreamId` is the lineage of the slot's upstream approved current attempt right
 * now: an attempt rendered from an upstream view is compatible only with that
 * same view, exactly as it is only compatible with the portrait it came from —
 * restoring it beside a different upstream would install a candidate that
 * already reads stale. `currentBodyReferenceSet` is the character's body-image
 * set right now, for the same reason: a rendered attempt is compatible only
 * with the set it was rendered against.
 */
function restoreUnavailable(
  row: ReferenceViewRow,
  source: AcceptedPortraitSource,
  busy: boolean,
  eligible: boolean,
  approvedUpstreamId: string | null,
  currentBodyReferenceSet: string | null,
): ReferenceViewHistoryEntry["restoreUnavailable"] {
  if (!eligible) return "ineligible";
  if (row.current) return "current";
  if (row.updatedAt.getTime() < Date.now() - REFERENCE_VIEW_RETENTION_MS) return "expired";
  if (!row.imageId || !row.method) return "unavailable";
  if (!source.ok || row.sourceImageId !== source.imageId || row.sourceContentHash !== source.contentHash ||
      row.generationVersion !== REFERENCE_VIEW_GENERATION_VERSION ||
      (row.upstreamViewId !== null && row.upstreamViewId !== approvedUpstreamId) ||
      referenceViewBodySetMoved({ method: row.method, bodyReferenceSet: row.bodyReferenceSet, currentBodyReferenceSet })) {
    return "incompatible";
  }
  if (busy) return "busy";
  return null;
}

/**
 * The slot key as one comparable string — the map key the projection groups
 * on. A visible separator: registry ids carry no colon, and a key nobody can
 * read in a debugger or a log is a key nobody can debug.
 */
function slotKey(view: ReferenceView): string {
  return `${view.angle}:${view.wardrobe}`;
}

function planIncludes(plan: readonly ReferenceView[], view: ReferenceView): boolean {
  return plan.some((candidate) => candidate.angle === view.angle && candidate.wardrobe === view.wardrobe);
}

/**
 * The LINEAGE of the approved current attempt of the view this slot is built
 * from (`referenceViewLineageId`), or null — for a root view, and while that
 * upstream slot has none. Read off a projected sheet, so an upstream that is
 * itself stale (its own upstream moved) answers null exactly as the projection
 * says, and a restored copy answers as the attempt it copies.
 */
function approvedUpstreamLineageId(set: ReferenceViewSetSummary, view: ReferenceView): string | null {
  const upstream = referenceViewUpstream(view);
  if (upstream === null) return null;
  const summary = set.views.find((entry) => sameReferenceView(entry, upstream));
  return summary?.state === "approved" ? (summary.lineageId ?? summary.attemptId) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The character's accepted portrait, or null when the character is not this owner's. */
async function readAcceptedPortrait(characterId: string, ownerId: string, executor: ReferenceViewExecutor = db()): Promise<string | null | undefined> {
  const [row] = await executor
    .select({ acceptedAvatarImageId: characters.acceptedAvatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  return row === undefined ? undefined : row.acceptedAvatarImageId;
}

/**
 * The views an accept or a build would actually render for this character — the
 * age gate applied to the stored profile.
 *
 * Exported because the accept route charges the daily budget for exactly this
 * count and the studio shows it on the button. Two counts derived separately
 * would drift, and the direction they drift in is billing for renders that were
 * never made.
 */
export async function plannedReferenceViewsForCharacter(
  characterId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<readonly ReferenceView[]> {
  const plan = await readReferenceViewPlan(characterId, ownerId, db(), sink);
  return plan ?? [];
}

/** Read the age-gated plan on the caller's connection so writes can check it under the character lock. */
async function readReferenceViewPlan(
  characterId: string,
  ownerId: string,
  executor: ReferenceViewExecutor,
  sink?: DiagnosticSink,
): Promise<readonly ReferenceView[] | undefined> {
  const profile = await readReferenceViewProfile(characterId, ownerId, executor, sink);
  return profile === undefined ? undefined : plannedReferenceViews(profile);
}

/** The owner's character profile, parsed, or undefined when the character is not theirs. */
async function readReferenceViewProfile(
  characterId: string,
  ownerId: string,
  executor: ReferenceViewExecutor,
  sink?: DiagnosticSink,
): Promise<CharacterProfile | undefined> {
  const [row] = await executor
    .select({ profile: characters.profile })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (row === undefined) return undefined;
  return parseOr(characterProfileSchema, row.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
}

/**
 * The character facts every sheet question reads on the caller's connection:
 * the age-gated plan, and the body-image set each view would be rendered
 * against right now — the key of the sendable images routed to its wardrobe
 * (`referenceViewBodySetKey`), the same function the build records with. Both
 * are functions of the one stored profile, read once.
 */
async function readReferenceViewCharacter(
  characterId: string,
  ownerId: string,
  executor: ReferenceViewExecutor,
  sink?: DiagnosticSink,
): Promise<{ plan: readonly ReferenceView[]; bodySetFor: (view: ReferenceView) => string | null } | undefined> {
  const profile = await readReferenceViewProfile(characterId, ownerId, executor, sink);
  if (profile === undefined) return undefined;
  const sendable = await currentSendableBodyReferences(characterId, profile, executor);
  return {
    plan: plannedReferenceViews(profile),
    bodySetFor: (view) => referenceViewBodySetKey(view.wardrobe, sendable),
  };
}

/**
 * The accepted portrait every attempt in the set derives from: its id, its row,
 * and the SHA-256 of the bytes actually on disk.
 *
 * Hashed rather than trusted by id, on `image_identity_packs.source_content_hash`'s
 * rule — a byte-level change invalidates the sheet even when the portrait looks
 * identical, and nothing may claim a derivation from bytes it did not read.
 *
 * Every refusal is a value: not this owner's character, nothing accepted, an
 * asset that is not `ready`, or bytes that would not read.
 */
export type AcceptedPortraitSource =
  | { ok: true; imageId: string; contentHash: string }
  | { ok: false; reason: "not_found" | "not_accepted" | "source_unreadable" };

export async function readAcceptedPortraitSource(characterId: string, ownerId: string, executor: ReferenceViewExecutor = db()): Promise<AcceptedPortraitSource> {
  const accepted = await readAcceptedPortrait(characterId, ownerId, executor);
  if (accepted === undefined) return { ok: false, reason: "not_found" };
  if (accepted === null) return { ok: false, reason: "not_accepted" };

  const [row] = await executor
    .select()
    .from(images)
    .where(and(eq(images.id, accepted), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!row || row.status !== "ready") return { ok: false, reason: "source_unreadable" };
  const bytes = await readImageBytes(row);
  if (bytes === null) return { ok: false, reason: "source_unreadable" };
  return { ok: true, imageId: accepted, contentHash: sourceContentHashOf(bytes) };
}

/** Every current row for this character, whatever slot it belongs to. */
export async function currentReferenceViewRows(
  characterId: string,
  executor: ReferenceViewExecutor = db(),
): Promise<readonly ReferenceViewRow[]> {
  return executor
    .select()
    .from(characterReferenceViews)
    .where(and(eq(characterReferenceViews.characterId, characterId), eq(characterReferenceViews.current, true)));
}

/** One slot's current row, or undefined when the slot has never been built. */
export async function currentReferenceViewRow(
  characterId: string,
  view: ReferenceView,
  executor: ReferenceViewExecutor = db(),
): Promise<ReferenceViewRow | undefined> {
  const [row] = await executor
    .select()
    .from(characterReferenceViews)
    .where(
      and(
        eq(characterReferenceViews.characterId, characterId),
        eq(characterReferenceViews.angleId, view.angle),
        eq(characterReferenceViews.wardrobe, view.wardrobe),
        eq(characterReferenceViews.current, true),
      ),
    )
    .limit(1);
  return row;
}

/**
 * One slot's attempts, newest first — what was tried, what was rejected, what
 * replaced it. Backed by `character_reference_views_slot_idx`.
 */
export async function referenceViewHistory(
  characterId: string,
  view: ReferenceView,
  limit = 20,
): Promise<readonly ReferenceViewRow[]> {
  return db()
    .select()
    .from(characterReferenceViews)
    .where(
      and(
        eq(characterReferenceViews.characterId, characterId),
        eq(characterReferenceViews.angleId, view.angle),
        eq(characterReferenceViews.wardrobe, view.wardrobe),
      ),
    )
    .orderBy(desc(characterReferenceViews.createdAt))
    .limit(limit);
}

/** The asset statuses of every image a set's rows point at, by image id. */
async function readViewImageStatuses(
  rows: readonly ReferenceViewRow[],
  executor: ReferenceViewExecutor = db(),
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.imageId === null ? [] : [row.imageId])))];
  if (ids.length === 0) return new Map();
  const assets = await executor.select({ id: images.id, status: images.status }).from(images).where(inArray(images.id, ids));
  return new Map(assets.map((asset) => [asset.id, asset.status]));
}

// ---------------------------------------------------------------------------
// A failed render's paid output
// ---------------------------------------------------------------------------

/**
 * The image ids, among a sheet's failed rows' linked assets, that still offer a
 * paid output. A failed row's link is its failed render's own row
 * (`failReferenceView`), and nothing else carries an offer, so no other row is
 * read. Owner- and kind-scoped like every asset read here.
 */
async function readOfferedOutputs(
  rows: readonly ReferenceViewRow[],
  ownerId: string,
  executor: ReferenceViewExecutor,
): Promise<Set<string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.status === "failed" && row.imageId !== null ? [row.imageId] : [])))];
  if (ids.length === 0) return new Set();
  const assets = await executor
    .select({ id: images.id, status: images.status, meta: images.meta })
    .from(images)
    .where(and(inArray(images.id, ids), eq(images.ownerId, ownerId), eq(images.kind, "reference_view")));
  return new Set(assets.flatMap((asset) => (paidOutputOffer(asset).state === "on_offer" ? [asset.id] : [])));
}

/**
 * One slot's attempts as the studio's history list reads them, newest first —
 * every image the slot has produced, rendered and uploaded alike, each with the
 * ruling the owner gave it.
 *
 * Owner-scoped through the CHARACTER, exactly as {@link getReferenceViewSet} is,
 * and refused the same way: a character that is not this owner's reads as a
 * character with no history rather than as an error, keeping the not-yours ≡
 * gone indistinguishability every character surface holds. A character with no
 * accepted portrait still has a history — the sheet's rows outlive the pointer.
 *
 * Two filters, and both mean "there is nothing to look at": a row with no
 * `image_id` never produced bytes or had them collected by the retention sweep,
 * and a row whose asset is not `ready` points at a file that was reserved and
 * never written — which is what a failed render's link is: its failed row,
 * kept so a paid output can be recovered (`failReferenceView`). The list is
 * evidence for a wording comparison; a row with no picture is not evidence.
 *
 * The first filter is the query's, and there is no row cap on top of it: the
 * retention sweep is the list's ONLY bound, and the studio states that bound in
 * words. A window of N attempts would be a second, unstated bound — a slot that
 * spent N attempts on refused `bare` renders would read as empty while an older
 * approved image still sat within the window with its bytes intact.
 */
export async function referenceViewHistoryEntries(
  characterId: string,
  ownerId: string,
  view: ReferenceView,
): Promise<readonly ReferenceViewHistoryEntry[]> {
  const accepted = await readAcceptedPortrait(characterId, ownerId);
  if (accepted === undefined) return [];

  const rows = await db()
    .select()
    .from(characterReferenceViews)
    .where(
      and(
        eq(characterReferenceViews.characterId, characterId),
        eq(characterReferenceViews.angleId, view.angle),
        eq(characterReferenceViews.wardrobe, view.wardrobe),
        isNotNull(characterReferenceViews.imageId),
      ),
    )
    .orderBy(desc(characterReferenceViews.createdAt));
  const statuses = await readViewImageStatuses(rows);
  const source = await readAcceptedPortraitSource(characterId, ownerId);
  const busy = await referenceViewReplacementBusy(characterId, ownerId, view);
  const character = await readReferenceViewCharacter(characterId, ownerId, db());
  if (character === undefined) return [];
  const eligible = planIncludes(character.plan, view);
  const approvedUpstream = approvedUpstreamLineageId(await getReferenceViewSet(characterId, ownerId), view);

  return rows.flatMap((row) => {
    const imageId = row.imageId;
    if (imageId === null || statuses.get(imageId) !== "ready") return [];
    return [
      {
        id: row.id,
        imageId,
        method: row.method,
        verdict: referenceViewHistoryVerdict(row),
        feedback: parseOrNull(referenceViewFeedbackSchema, row.feedback),
        restoreUnavailable: restoreUnavailable(row, source, busy, eligible, approvedUpstream, character.bodySetFor(view)),
        current: row.current,
        createdAt: row.createdAt.toISOString(),
        reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
        generationVersion: row.generationVersion,
        sourceImageId: row.sourceImageId,
      },
    ];
  });
}

/** The facts one current row hands the sheet projection. */
function slotRowFacts(
  row: ReferenceViewRow,
  acceptedImageId: string | null,
  imageStatus: string | null,
  currentBodyReferenceSet: string | null,
  outputRecoverable: boolean,
): ReferenceViewSlotRow {
  return {
    attemptId: row.id,
    current: row.current,
    status: row.status,
    sourceImageId: row.sourceImageId,
    imageId: row.imageId,
    imageStatus,
    generationVersion: row.generationVersion,
    reviewedAt: row.reviewedAt,
    acceptedImageId,
    upstreamViewId: row.upstreamViewId,
    method: row.method,
    bodyReferenceSet: row.bodyReferenceSet,
    currentBodyReferenceSet,
    originAttemptId: row.originAttemptId,
    outputRecoverable,
  };
}

/** A slot nothing has been built in — what an unreachable lookup degrades to. */
function unbuiltSummary(view: ReferenceView, eligible: boolean): ReferenceViewSummary {
  return {
    angle: view.angle,
    wardrobe: view.wardrobe,
    state: eligible ? "missing" : "ineligible",
    attemptId: null,
    reviewRevision: 0,
    feedback: null,
    imageId: null,
    method: null,
    reviewedAt: null,
    failureCode: null,
    failureMessage: null,
    updatedAt: null,
    consumable: false,
    waitingOn: null,
    approvalBuilds: [],
    uploadBuilds: [],
    lineageId: null,
    downstreamBuilding: false,
    recoverable: false,
  };
}

/**
 * Every slot of the sheet as one summary each, in registry order.
 *
 * The states come from ONE projection over the whole sheet
 * (`projectReferenceViewSlots`), because a slot's staleness reads its
 * upstream's projected answer; and each slot's disclosed builds come from the
 * same projection with that slot's approval assumed, so the Approve control's
 * count is the rule the review route charges by.
 */
function projectSheet(input: {
  bySlot: ReadonlyMap<string, ReferenceViewRow>;
  statuses: ReadonlyMap<string, string>;
  /** The failed rows' linked assets that still offer a paid output (`readOfferedOutputs`). */
  offered: ReadonlySet<string>;
  acceptedImageId: string | null;
  eligible: ReadonlySet<string>;
  /** Each view's body-image set now — what its rendered row is compared against. */
  bodySetFor: (view: ReferenceView) => string | null;
  /** The slots building right now — leased by a live job, or holding a pending attempt. */
  building: readonly ReferenceView[];
}): ReferenceViewSummary[] {
  const facts: ReferenceViewSlotFacts[] = allReferenceViews().map((view) => {
    const row = input.bySlot.get(slotKey(view));
    const imageStatus = row === undefined || row.imageId === null ? null : (input.statuses.get(row.imageId) ?? null);
    const outputRecoverable = row !== undefined && row.status === "failed" && row.imageId !== null && input.offered.has(row.imageId);
    return {
      view,
      eligible: input.eligible.has(slotKey(view)),
      row: row === undefined ? null : slotRowFacts(row, input.acceptedImageId, imageStatus, input.bodySetFor(view), outputRecoverable),
    };
  });
  const projected = projectReferenceViewSlots(facts);
  return facts.map((slot) => {
    const row = input.bySlot.get(slotKey(slot.view));
    const projection: ReferenceViewSlotProjection | undefined = projected.find((entry) => sameReferenceView(entry, slot.view));
    if (projection === undefined) return unbuiltSummary(slot.view, slot.eligible);
    return {
      angle: slot.view.angle,
      wardrobe: slot.view.wardrobe,
      state: projection.state,
      attemptId: row?.id ?? null,
      reviewRevision: row?.reviewRevision ?? 0,
      feedback: row === undefined ? null : parseOrNull(referenceViewFeedbackSchema, row.feedback),
      // The asset id rides even on a stale or rejected row: the studio shows the
      // owner what it is calling stale, which is the difference between a state
      // they can act on and one they have to take on faith. Never on a FAILED
      // row, whatever it projects: its link is its failed render's own row,
      // kept only so a paid output can be recovered, and nothing may draw or
      // consume it.
      imageId: row === undefined || row.status === "failed" ? null : row.imageId,
      method: row?.method ?? null,
      reviewedAt: row?.reviewedAt ? row.reviewedAt.toISOString() : null,
      failureCode: row?.failureCode ?? null,
      failureMessage: row?.failureMessage ?? null,
      updatedAt: row === undefined ? null : row.updatedAt.toISOString(),
      consumable: projection.consumable,
      waitingOn: projection.waitingOn,
      // Only an attempt the owner has not ruled on can be approved.
      // Approving publishes the attempt's lineage, so a restored copy of the
      // attempt a dependent was built from builds nothing for that dependent.
      approvalBuilds:
        projection.state === "unreviewed" && slot.row !== null
          ? referenceViewBuildsOnApproval(facts, { view: slot.view, attemptId: referenceViewLineageId(slot.row) })
          : [],
      // An upload installs a NEW approved attempt, which no stored row was
      // rendered from.
      uploadBuilds: slot.eligible ? referenceViewBuildsOnApproval(facts, { view: slot.view, attemptId: null }) : [],
      lineageId: slot.row === null ? null : referenceViewLineageId(slot.row),
      downstreamBuilding: referenceViewDescendantBusy(slot.view, input.building),
      recoverable: projection.recoverable,
    };
  });
}

/**
 * The whole sheet for one character, as the studio and slice 3's consumers read
 * it: every `angles × wardrobes` slot, always, `missing` where no row exists.
 *
 * A character that is not this owner's reads as an empty set rather than an
 * error — the surface is additive, and a foreign id must not be distinguishable
 * from an unbuilt one.
 */
export async function getReferenceViewSet(
  characterId: string,
  ownerId: string,
  sink?: DiagnosticSink,
  executor?: ReferenceViewExecutor,
): Promise<ReferenceViewSetSummary> {
  // Ordinary reads repair crash-left pending rows first, and settle any current
  // view whose file is gone (the image sweep's transition, on read) so no build
  // is admitted from bytes that no longer exist. Callers already inside the
  // character lock pass their executor and observe the transaction's snapshot.
  if (executor === undefined) {
    await reconcileExpiredReferenceViewWork(characterId);
    await reconcileLostReferenceViewFiles(characterId);
  }
  const reader = executor ?? db();
  const accepted = await readAcceptedPortrait(characterId, ownerId, reader);
  if (accepted === undefined) return emptyReferenceViewSetSummary();
  const character = await readReferenceViewCharacter(characterId, ownerId, reader, sink);
  if (character === undefined) return emptyReferenceViewSetSummary();
  const eligibleSlots = new Set(character.plan.map(slotKey));

  const rows = await currentReferenceViewRows(characterId, reader);
  const statuses = await readViewImageStatuses(rows, reader);
  const offered = await readOfferedOutputs(rows, ownerId, reader);

  const bySlot = new Map<string, ReferenceViewRow>();
  for (const row of rows) {
    // A stored id the registry no longer knows describes a view nothing can
    // render, review or consume. It is dropped rather than surfaced: the slot it
    // used to fill reads `missing`, which is an action the owner can take.
    const angle = parseOrNull(referenceViewAngleIdSchema, row.angleId);
    const wardrobe = parseOrNull(referenceViewWardrobeSchema, row.wardrobe);
    if (angle === null || wardrobe === null) {
      sink?.push(
        diag("warn", REFERENCE_VIEW_UNKNOWN, "a stored reference view names an angle or wardrobe the registry dropped", {
          context: { characterId, viewId: row.id, angleId: row.angleId, wardrobe: row.wardrobe },
        }),
      );
      continue;
    }
    bySlot.set(slotKey({ angle, wardrobe }), row);
  }

  // Any leased slot keeps the set's background-status and polling surfaces
  // active; leased and pending slots together are what a replacement waits on.
  const live = await liveReferenceViewLeaseJobs(reader, characterId, new Date());
  const pendingSlots = [...bySlot.values()].flatMap((row): ReferenceView[] => {
    if (row.status !== "pending") return [];
    const angle = parseOrNull(referenceViewAngleIdSchema, row.angleId);
    const wardrobe = parseOrNull(referenceViewWardrobeSchema, row.wardrobe);
    return angle === null || wardrobe === null ? [] : [{ angle, wardrobe }];
  });
  return {
    acceptedImageId: accepted,
    building: live.length > 0,
    views: projectSheet({
      bySlot,
      statuses,
      offered,
      acceptedImageId: accepted,
      eligible: eligibleSlots,
      bodySetFor: character.bodySetFor,
      building: [...leasedSlots(live), ...pendingSlots],
    }),
  };
}

/**
 * Hold the character lock across eligibility projection and the selected asset
 * read. This is the consumer boundary: an apparent-age edit cannot commit
 * between approving a bare slot for use and opening its bytes.
 */
export async function withLockedReferenceViewSet<T>(
  characterId: string,
  ownerId: string,
  sink: DiagnosticSink | undefined,
  operation: (snapshot: {
    set: ReferenceViewSetSummary;
    /**
     * The ready view asset: its bytes, and the row's own `meta`.
     *
     * The meta rides along because a view's APPEARANCE REVISION lives there
     * (issue #551) and this is the read that already has the row open under the
     * lock; a caller that re-read it to ask what the view depicts could see a
     * different row than the one whose bytes it is about to send.
     */
    readReadyAsset: (imageId: string) => Promise<{ buffer: Buffer; meta: unknown } | null>;
  }) => Promise<T>,
): Promise<T> {
  return withReferenceViewLock(characterId, async (tx) => {
    const set = await getReferenceViewSet(characterId, ownerId, sink, tx);
    const readReadyAsset = async (imageId: string): Promise<{ buffer: Buffer; meta: unknown } | null> => {
      const [asset] = await tx.select().from(images).where(and(
        eq(images.id, imageId), eq(images.ownerId, ownerId), eq(images.kind, "reference_view"),
      )).limit(1);
      if (asset?.status !== "ready") return null;
      const buffer = await readImageBytes(asset);
      return buffer === null ? null : { buffer, meta: asset.meta };
    };
    return operation({ set, readReadyAsset });
  });
}

/** One slot's summary, read fresh — what every per-view write answers with. */
export async function getReferenceViewSummary(
  characterId: string,
  ownerId: string,
  view: ReferenceView,
  sink?: DiagnosticSink,
): Promise<ReferenceViewSummary> {
  const set = await getReferenceViewSet(characterId, ownerId, sink);
  return set.views.find((entry) => sameReferenceView(entry, view)) ?? unbuiltSummary(view, false);
}

/** One slot's summary read inside the caller's transaction, so a write answers with what it wrote. */
async function slotSummaryInTransaction(
  tx: ReferenceViewTransaction,
  characterId: string,
  ownerId: string,
  view: ReferenceView,
  sink?: DiagnosticSink,
): Promise<ReferenceViewSummary> {
  const set = await getReferenceViewSet(characterId, ownerId, sink, tx);
  return set.views.find((entry) => sameReferenceView(entry, view)) ?? unbuiltSummary(view, true);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface ReserveReferenceViewInput {
  /** The heartbeat-live job that owns this slot's lease. */
  jobId: string;
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  /** The accepted portrait this attempt renders from. */
  sourceImageId: string;
  sourceContentHash: string;
  /**
   * The upstream attempt whose bytes this render will send
   * (`referenceViewUpstream`). Required to be that slot's approved current
   * attempt for any view that has an upstream; ignored for a root view.
   */
  upstreamViewId?: string | null;
  /**
   * The key of the body images the worker read and routed to this view
   * (`referenceViewBodySetKey`); absent is the empty set. Required to be the
   * same key over the character's images at reservation, under the lock, and
   * recorded on the row.
   */
  bodyReferenceSet?: string | null;
  /** Where a refusal the worker should hear about is said — the upstream moving under it. */
  sink?: DiagnosticSink;
}

/**
 * Claim the slot for a new attempt: retire whatever was current and insert a
 * `pending` row in its place, in ONE transaction.
 *
 * One statement, not two, because the partial unique index means a retire that
 * commits without its insert leaves a slot with no current row and an insert
 * without its retire fails outright. Retiring to `superseded` rather than
 * deleting is the lifecycle's whole shape: the previous attempt stays readable
 * as history, and its asset is collected by the sweep a week later rather than
 * the instant the owner asked for a retry.
 */
export async function reserveReferenceView(input: ReserveReferenceViewInput): Promise<string | null> {
  const { characterId, view } = input;
  return withReferenceViewLock(characterId, async (tx) => {
    const now = new Date();
    const job = await lockLiveReferenceViewLeaseJob(tx, input, now);
    const lease = job && payloadLeases(job.payload).find((candidate) => slotKey(candidate) === slotKey(view));
    if (!job || !lease || lease.attemptId !== null) return null;
    // The build reads and hashes its portrait before workers reserve slots. If
    // the owner accepts another portrait while those workers are waiting for
    // this lock, refuse the stale reservation before any provider call.
    const acceptedImageId = await readAcceptedPortrait(characterId, input.ownerId, tx);
    if (acceptedImageId !== input.sourceImageId) return null;
    const character = await readReferenceViewCharacter(characterId, input.ownerId, tx);
    if (character === undefined || !planIncludes(character.plan, view)) return null;
    // The body images, under the same lock: a render whose worker read a set
    // the owner has since changed would arrive stale, so it spends nothing and
    // the slot keeps what it shows; the next build reads the new set.
    const bodyReferenceSet = input.bodyReferenceSet ?? null;
    if (bodyReferenceSet !== character.bodySetFor(view)) return null;
    // The build order, under the same lock: a dependent renders only from its
    // upstream's approved current attempt, and only from the one the worker has
    // already read. An upstream regenerated, undone or gone stale since the
    // approval that queued this slot refuses here, before any provider call,
    // and the slot waits for that view's next approval to queue it again.
    const upstream = referenceViewUpstream(view);
    let upstreamViewId: string | null = null;
    if (upstream !== null) {
      const approved = approvedUpstreamLineageId(await getReferenceViewSet(characterId, input.ownerId, undefined, tx), view);
      if (approved === null || approved !== (input.upstreamViewId ?? null)) {
        input.sink?.push(
          diag("warn", REFERENCE_VIEW_UPSTREAM_UNAPPROVED, "the view this one is built from changed before it rendered, so nothing was reserved", {
            context: {
              characterId,
              angle: view.angle,
              wardrobe: view.wardrobe,
              upstreamAngle: upstream.angle,
              upstreamWardrobe: upstream.wardrobe,
              read: input.upstreamViewId ?? null,
              approved,
            },
          }),
        );
        return null;
      }
      upstreamViewId = approved;
    }
    await tx
      .update(characterReferenceViews)
      // `updated_at` is bumped by the column's own `$onUpdate`, and it is what the
      // retention window is measured from: the clock on a retired view's bytes
      // starts when it was retired, not when it was made.
      .set({ current: false, status: "superseded" })
      .where(
        and(
          eq(characterReferenceViews.characterId, characterId),
          eq(characterReferenceViews.angleId, view.angle),
          eq(characterReferenceViews.wardrobe, view.wardrobe),
          eq(characterReferenceViews.current, true),
        ),
      );
    const [row] = await tx
      .insert(characterReferenceViews)
      .values({
        characterId,
        angleId: view.angle,
        wardrobe: view.wardrobe,
        current: true,
        status: "pending",
        sourceImageId: input.sourceImageId,
        sourceContentHash: input.sourceContentHash,
        generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
        upstreamViewId,
        bodyReferenceSet,
      })
      .returning({ id: characterReferenceViews.id });
    if (!row) throw new Error("character_reference_views insert returned no row");
    const leases = payloadLeases(job.payload).map((candidate) =>
      slotKey(candidate) === slotKey(view) ? { ...candidate, attemptId: row.id } : candidate,
    );
    const payload = objectPayload(job.payload);
    const [updated] = await tx
      .update(jobs)
      .set({
        payload: {
          ...payload,
          leases,
          referenceViewAttemptIds: [...new Set([...payloadReferenceViewAttemptIds(payload), row.id])].slice(0, 64),
        },
      })
      .where(and(
        eq(jobs.id, job.id),
        eq(jobs.status, "running"),
        gt(jobs.heartbeatAt, new Date(now.getTime() - JOB_STALE_MS)),
      ))
      .returning({ id: jobs.id });
    if (!updated) throw new Error("reference view lease disappeared during reservation");
    return row.id;
  });
}

export interface FinalizeReferenceViewInput {
  jobId: string;
  viewId: string;
  characterId: string;
  ownerId: string;
  imageId: string;
  method: ReferenceViewMethod;
  /** Owner id to stamp as the reviewer, for a view that arrives already reviewed (an upload). */
  reviewedByUserId?: string;
  /**
   * The upstream attempt the render actually SENT, or null when the model had
   * no room for it — the reservation recorded the one it was given, and a view
   * the upstream never reached does not depend on it. Absent keeps the
   * reservation's record.
   */
  upstreamViewId?: string | null;
}

export interface InstallUploadedReferenceViewInput extends Omit<ReserveReferenceViewInput, "jobId"> {
  imageId: string;
  expectedCurrentAttemptId: string | null;
  expectedCurrentRevision: number;
}

export type InstallUploadedReferenceViewResult =
  | { status: "uploaded"; view: ReferenceViewSummary }
  | { status: "busy" }
  | { status: "changed" }
  | { status: "not_found" }
  | { status: "not_accepted" }
  | { status: "ineligible" };

/** Install a processed upload only while the slot and accepted source still match its initial read. */
export async function installUploadedReferenceView(input: InstallUploadedReferenceViewInput): Promise<InstallUploadedReferenceViewResult> {
  return withReferenceViewLock<InstallUploadedReferenceViewResult>(input.characterId, async (tx) => {
    const plan = await readReferenceViewPlan(input.characterId, input.ownerId, tx);
    if (plan === undefined) return { status: "not_found" };
    if (!planIncludes(plan, input.view)) return { status: "ineligible" };
    const source = await readAcceptedPortraitSource(input.characterId, input.ownerId, tx);
    if (!source.ok) return { status: source.reason === "not_found" ? "not_found" : "not_accepted" };
    if (await referenceViewReplacementBusy(input.characterId, input.ownerId, input.view, tx)) return { status: "busy" };
    const current = await currentReferenceViewRow(input.characterId, input.view, tx);
    if (source.imageId !== input.sourceImageId || source.contentHash !== input.sourceContentHash ||
        (current?.id ?? null) !== input.expectedCurrentAttemptId || (current?.reviewRevision ?? 0) !== input.expectedCurrentRevision) {
      return { status: "changed" };
    }
    if (current) await tx.update(characterReferenceViews).set({ current: false, status: "superseded" }).where(eq(characterReferenceViews.id, current.id));
    // An upload is the owner's own answer, rendered from nothing upstream and
    // from no body image, so it records neither and goes stale by neither.
    const [candidate] = await tx.insert(characterReferenceViews).values({
      characterId: input.characterId, angleId: input.view.angle, wardrobe: input.view.wardrobe,
      current: true, status: "ready", sourceImageId: source.imageId, sourceContentHash: source.contentHash,
      generationVersion: REFERENCE_VIEW_GENERATION_VERSION, imageId: input.imageId, method: "uploaded",
      verdict: "approved", reviewedByUserId: input.ownerId, reviewedAt: new Date(), upstreamViewId: null,
      bodyReferenceSet: null,
    }).returning({ id: characterReferenceViews.id });
    if (!candidate) throw new Error("reference upload returned no candidate");
    return { status: "uploaded", view: await slotSummaryInTransaction(tx, input.characterId, input.ownerId, input.view) };
  });
}

/** `fenced` means this worker no longer owns the current slot and wrote nothing. */
export type FinalizeReferenceViewResult = "ready" | "stale" | "fenced";

async function liveLeaseForAttempt(
  tx: ReferenceViewTransaction,
  input: { jobId: string; characterId: string; ownerId: string; viewId: string },
): Promise<{ job: ReferenceViewLeaseJob; lease: ReferenceViewLease } | null> {
  const job = await lockLiveReferenceViewLeaseJob(tx, input, new Date());
  if (!job) return null;
  const lease = payloadLeases(job.payload).find((candidate) => candidate.attemptId === input.viewId);
  return lease ? { job, lease } : null;
}

async function releaseReferenceViewLease(
  tx: ReferenceViewTransaction,
  job: ReferenceViewLeaseJob,
  viewId: string,
): Promise<void> {
  await tx
    .update(jobs)
    .set({
      payload: {
        ...objectPayload(job.payload),
        leases: payloadLeases(job.payload).filter((candidate) => candidate.attemptId !== viewId),
      },
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
}

/**
 * Settle a reserved row with the bytes it produced.
 *
 * A compare-and-set on the character's accepted pointer, INSIDE the transaction:
 * a render takes tens of seconds, and the owner can accept a different portrait
 * in the middle of one. If the pointer still names the portrait this attempt
 * rendered from, the row is `ready`; if it moved, the row is `stale` and stays
 * current, because the owner is better served by a tile that says "this was made
 * from the portrait you replaced" than by a slot that silently reads `missing`.
 * (Read-time projection would call it stale regardless — writing it is what
 * lets the row say so without a join.)
 *
 * An upload arrives already reviewed: an owner who supplies a view has, by
 * supplying it, performed the review the render path asks them for.
 */
export async function finalizeReferenceView(input: FinalizeReferenceViewInput): Promise<FinalizeReferenceViewResult> {
  return withReferenceViewLock(input.characterId, async (tx) => {
    const [row] = await tx
      .select({
        sourceImageId: characterReferenceViews.sourceImageId,
        angleId: characterReferenceViews.angleId,
        wardrobe: characterReferenceViews.wardrobe,
        current: characterReferenceViews.current,
        status: characterReferenceViews.status,
      })
      .from(characterReferenceViews)
      .where(eq(characterReferenceViews.id, input.viewId))
      .limit(1);
    const ownedLease = await liveLeaseForAttempt(tx, input);
    if (
      row === undefined ||
      !row.current ||
      row.status !== "pending" ||
      ownedLease === null ||
      ownedLease.lease.angle !== row.angleId ||
      ownedLease.lease.wardrobe !== row.wardrobe
    ) return "fenced";
    const [character] = await tx
      .select({ acceptedAvatarImageId: characters.acceptedAvatarImageId })
      .from(characters)
      .where(and(eq(characters.id, input.characterId), eq(characters.ownerId, input.ownerId)))
      .limit(1);
    const angle = row === undefined ? null : parseOrNull(referenceViewAngleIdSchema, row.angleId);
    const wardrobe = row === undefined ? null : parseOrNull(referenceViewWardrobeSchema, row.wardrobe);
    const plan = await readReferenceViewPlan(input.characterId, input.ownerId, tx);
    const eligible = angle !== null && wardrobe !== null && plan !== undefined && planIncludes(plan, { angle, wardrobe });
    const stale =
      row === undefined ||
      row.sourceImageId === null ||
      character === undefined ||
      character.acceptedAvatarImageId !== row.sourceImageId ||
      !eligible;
    const reviewed = input.reviewedByUserId;
    const [updated] = await tx
      .update(characterReferenceViews)
      .set({
        status: stale ? "stale" : "ready",
        imageId: input.imageId,
        method: input.method,
        ...(input.upstreamViewId === undefined ? {} : { upstreamViewId: input.upstreamViewId }),
        // An upload arrives reviewed, so it arrives with a verdict: supplying a
        // view IS the approval, and the row has to say so in the one column
        // that outlives its own supersession.
        ...(reviewed === undefined
          ? {}
          : { verdict: "approved" as const, reviewedByUserId: reviewed, reviewedAt: new Date() }),
      })
      .where(and(
        eq(characterReferenceViews.id, input.viewId),
        eq(characterReferenceViews.current, true),
        eq(characterReferenceViews.status, "pending"),
      ))
      .returning({ id: characterReferenceViews.id });
    if (!updated) return "fenced";
    await releaseReferenceViewLease(tx, ownedLease.job, input.viewId);
    return stale ? "stale" : "ready";
  });
}

/**
 * Mark a reserved row failed with the reason.
 *
 * A failed view is an ordinary outcome, not an incident: the expected instance
 * is a `bare` view a provider's moderation refused, and the row records the
 * refusal so the studio can offer an upload instead. The row stays current —
 * there is nothing better to be current — and a regenerate makes a new one.
 *
 * The row keeps its failed render's own images row as its `image_id`, with the
 * upstream lineage that render actually sent — exactly what
 * `finalizeReferenceView` would have recorded — because a render can succeed
 * and be billed and still fail its download, and that failed row is what
 * offers the paid output for recovery (`recoverable`). The sheet never draws or
 * consumes a failed row; the offer ends when retention deletes that images row
 * and the foreign key nulls the link.
 */
export async function failReferenceView(input: {
  jobId: string;
  viewId: string;
  characterId: string;
  ownerId: string;
  failureCode: string;
  failureMessage: string;
  /** The failed render's own images row (`runImagePipeline`'s `imageId`). */
  imageId: string;
  /** The upstream lineage the render actually SENT, or null when it sent none. */
  upstreamViewId: string | null;
}): Promise<"failed" | "fenced"> {
  return withReferenceViewLock(input.characterId, async (tx) => {
    const ownedLease = await liveLeaseForAttempt(tx, input);
    if (ownedLease === null) return "fenced";
    const [updated] = await tx
      .update(characterReferenceViews)
      .set({
        status: "failed",
        imageId: input.imageId,
        upstreamViewId: input.upstreamViewId,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage.slice(0, 500),
      })
      .where(and(
        eq(characterReferenceViews.id, input.viewId),
        eq(characterReferenceViews.current, true),
        eq(characterReferenceViews.status, "pending"),
      ))
      .returning({ id: characterReferenceViews.id });
    if (!updated) return "fenced";
    await releaseReferenceViewLease(tx, ownedLease.job, input.viewId);
    return "failed";
  });
}

export type ReferenceViewReviewVerdict = ReferenceViewReviewRequest["verdict"];
export type ReferenceViewWriteRefusal = "not_found" | "not_ready" | "changed" | "incompatible" | "ineligible" | "busy" | "expired" | "unavailable";
export type ReviewReferenceViewResult =
  | { status: "reviewed"; view: ReferenceViewSummary }
  | { status: ReferenceViewWriteRefusal };

/** Review exactly the attempt and revision displayed; Undo only clears that last verdict. */
export async function reviewReferenceView(input: ReferenceViewReviewRequest & {
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  sink?: DiagnosticSink;
}): Promise<ReviewReferenceViewResult> {
  return withReferenceViewLock<ReviewReferenceViewResult>(input.characterId, async (tx) => {
    const character = await readReferenceViewCharacter(input.characterId, input.ownerId, tx, input.sink);
    if (character === undefined) return { status: "not_found" };
    if (!planIncludes(character.plan, input.view)) return { status: "ineligible" };
    const accepted = await readAcceptedPortrait(input.characterId, input.ownerId, tx);
    if (accepted === undefined) return { status: "not_found" };
    const row = await currentReferenceViewRow(input.characterId, input.view, tx);
    if (!row || row.id !== input.attemptId || row.reviewRevision !== input.expectedRevision) return { status: "changed" };
    const undo = input.verdict === "undo";
    if (undo ? row.reviewedAt === null || !["ready", "rejected"].includes(row.status)
      : row.status !== "ready" || row.reviewedAt !== null) return { status: "not_ready" };
    // Undoing an APPROVAL while views built from this one are rendering would
    // leave those paid renders stale on arrival — finalization does not
    // revalidate the upstream — so it waits, like any replacement of the view.
    // An approval, a rejection, and an undo of a rejection change nothing a
    // dependent was built from, so they never wait on this.
    if (undo && row.status === "ready" &&
        referenceViewDescendantBusy(input.view, await buildingReferenceViewSlots(tx, input.characterId, input.ownerId))) {
      return { status: "busy" };
    }
    const source = await readAcceptedPortraitSource(input.characterId, input.ownerId, tx);
    if (!source.ok || row.sourceImageId !== source.imageId || row.sourceContentHash !== source.contentHash ||
        row.generationVersion !== REFERENCE_VIEW_GENERATION_VERSION) return { status: "incompatible" };
    // A rendered view from a body-image set the owner has since changed is
    // stale like one from a replaced portrait, and approving it would build its
    // dependents from a body the owner has moved away from.
    if (referenceViewBodySetMoved({
      method: row.method, bodyReferenceSet: row.bodyReferenceSet, currentBodyReferenceSet: character.bodySetFor(input.view),
    })) return { status: "incompatible" };
    // A view rendered from an upstream view that is no longer that slot's
    // approved current attempt is stale exactly as one from a replaced portrait
    // is — and approving it would build its own dependents from a stale body.
    if (row.upstreamViewId !== null) {
      const set = await getReferenceViewSet(input.characterId, input.ownerId, input.sink, tx);
      if (approvedUpstreamLineageId(set, input.view) !== row.upstreamViewId) return { status: "incompatible" };
    }
    const [asset] = await tx.select().from(images).where(and(eq(images.id, row.imageId ?? ""), eq(images.ownerId, input.ownerId))).limit(1);
    if (!asset || asset.status !== "ready" || await readImageBytes(asset) === null) return { status: "unavailable" };
    const [updated] = await tx.update(characterReferenceViews).set({
      status: input.verdict === "reject" ? "rejected" : "ready",
      verdict: undo ? null : input.verdict === "reject" ? "rejected" : "approved",
      reviewedByUserId: undo ? null : input.ownerId,
      reviewedAt: undo ? null : new Date(),
      reviewRevision: row.reviewRevision + 1,
      ...(input.verdict === "reject" ? { feedback: input.feedback ?? null } : {}),
    }).where(and(eq(characterReferenceViews.id, row.id), eq(characterReferenceViews.current, true),
      eq(characterReferenceViews.reviewRevision, input.expectedRevision))).returning({ id: characterReferenceViews.id });
    if (!updated) return { status: "changed" };
    return { status: "reviewed", view: await slotSummaryInTransaction(tx, input.characterId, input.ownerId, input.view, input.sink) };
  });
}

export type RestoreReferenceViewResult =
  | { status: "restored"; view: ReferenceViewSummary }
  | { status: ReferenceViewWriteRefusal };

/** A fresh candidate owns its own bytes. The original attempt and its verdict remain history. */
export async function restoreReferenceView(input: {
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  attemptId: string;
  expectedCurrentAttemptId: string | null;
  expectedCurrentRevision: number;
}): Promise<RestoreReferenceViewResult> {
  const accepted = await readAcceptedPortrait(input.characterId, input.ownerId);
  if (accepted === undefined) return { status: "not_found" };
  const initial = await readReferenceViewCharacter(input.characterId, input.ownerId, db());
  if (initial === undefined) return { status: "not_found" };
  if (!planIncludes(initial.plan, input.view)) return { status: "ineligible" };
  const [attempt] = await db().select().from(characterReferenceViews).where(and(
    eq(characterReferenceViews.id, input.attemptId), eq(characterReferenceViews.characterId, input.characterId),
    eq(characterReferenceViews.angleId, input.view.angle), eq(characterReferenceViews.wardrobe, input.view.wardrobe),
  )).limit(1);
  if (!attempt) return { status: "not_found" };
  const source = await readAcceptedPortraitSource(input.characterId, input.ownerId);
  const unavailable = restoreUnavailable(
    attempt,
    source,
    await referenceViewReplacementBusy(input.characterId, input.ownerId, input.view),
    true,
    approvedUpstreamLineageId(await getReferenceViewSet(input.characterId, input.ownerId), input.view),
    initial.bodySetFor(input.view),
  );
  if (unavailable) return { status: unavailable === "current" ? "changed" : unavailable };
  const [asset] = await db().select().from(images).where(and(eq(images.id, attempt.imageId ?? ""),
    eq(images.ownerId, input.ownerId), eq(images.kind, "reference_view"))).limit(1);
  const bytes = asset?.status === "ready" ? await readImageBytes(asset) : null;
  if (!asset || !bytes) return { status: "unavailable" };

  const copy = await createImageAsset({ ownerId: input.ownerId, kind: "reference_view", entityKind: "character",
    entityId: input.characterId, prompt: asset.prompt,
    meta: { restoredFromAttemptId: attempt.id, restoredFromImageId: asset.id } });
  let installed = false;
  try {
    const destination = absoluteImagePath(copy);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(containedAbsoluteImagePath(destination), bytes, { flag: "wx", mode: 0o600 });
    const result = await withReferenceViewLock<RestoreReferenceViewResult>(input.characterId, async (tx) => {
      // Recheck ownership and accepted bytes after copying: no stale read authorizes a write.
      const latestSource = await readAcceptedPortraitSource(input.characterId, input.ownerId, tx);
      if (!latestSource.ok) return { status: latestSource.reason === "not_found" ? "not_found" : "incompatible" };
      const latestCharacter = await readReferenceViewCharacter(input.characterId, input.ownerId, tx);
      if (latestCharacter === undefined) return { status: "not_found" };
      if (!planIncludes(latestCharacter.plan, input.view)) return { status: "ineligible" };
      const current = await currentReferenceViewRow(input.characterId, input.view, tx);
      if ((current?.id ?? null) !== input.expectedCurrentAttemptId || (current?.reviewRevision ?? 0) !== input.expectedCurrentRevision) {
        return { status: "changed" };
      }
      const [latest] = await tx.select().from(characterReferenceViews).where(eq(characterReferenceViews.id, attempt.id)).limit(1);
      if (!latest) return { status: "unavailable" };
      const busy = current?.status === "pending" ||
        await referenceViewReplacementBusy(input.characterId, input.ownerId, input.view, tx);
      const approvedUpstream = approvedUpstreamLineageId(
        await getReferenceViewSet(input.characterId, input.ownerId, undefined, tx),
        input.view,
      );
      const refusal = restoreUnavailable(latest, latestSource, busy, true, approvedUpstream, latestCharacter.bodySetFor(input.view));
      if (refusal) return { status: refusal === "current" ? "changed" : refusal };
      const [liveAsset] = await tx.select({ status: images.status }).from(images).where(eq(images.id, asset.id)).limit(1);
      if (liveAsset?.status !== "ready" || latest.imageId !== asset.id) return { status: "unavailable" };
      // The retained image can expire immediately after this check; the candidate's independent bytes survive it.
      await tx.update(images).set({ status: "ready", bytes: bytes.length }).where(eq(images.id, copy.id));
      if (current) await tx.update(characterReferenceViews).set({ current: false, status: "superseded" }).where(eq(characterReferenceViews.id, current.id));
      // The copy shows exactly what the original shows, so it was rendered from
      // the same upstream attempt and the same body-image set — which the check
      // above has just confirmed are still that slot's approved upstream and the
      // character's set.
      const [candidate] = await tx.insert(characterReferenceViews).values({
        characterId: input.characterId, angleId: input.view.angle, wardrobe: input.view.wardrobe,
        current: true, status: "ready", sourceImageId: latestSource.imageId,
        sourceContentHash: latestSource.contentHash, generationVersion: latest.generationVersion,
        imageId: copy.id, method: latest.method, upstreamViewId: latest.upstreamViewId,
        bodyReferenceSet: latest.bodyReferenceSet,
        // The copy carries the original's lineage, so the views built from that
        // original read current again once the copy is approved.
        originAttemptId: latest.originAttemptId ?? latest.id,
      }).returning({ id: characterReferenceViews.id });
      if (!candidate) throw new Error("reference restoration returned no candidate");
      return { status: "restored", view: await slotSummaryInTransaction(tx, input.characterId, input.ownerId, input.view) };
    });
    installed = result.status === "restored";
    return result;
  } catch (error) {
    log.warn("images", "reference restoration failed", { characterId: input.characterId, attemptId: input.attemptId, error: String(error).slice(0, 300) });
    return { status: "unavailable" };
  } finally {
    // Only this operation's unused copy is compensated. No retained attempt is deleted.
    if (!installed) {
      try { await deleteOwnedImage(copy.id, input.ownerId, { kind: "reference_view" }); }
      catch (error) { log.warn("images", "unused reference copy cleanup failed", { imageId: copy.id, error: String(error).slice(0, 300) }); }
    }
  }
}

// ---------------------------------------------------------------------------
// Recovering a failed render's paid output
// ---------------------------------------------------------------------------

/**
 * What a recovery answers (`recoverReferenceView`). `unavailable` is transient —
 * the offer stands and the owner may try again; `expired` means the paid
 * output is gone for good and the offer is withdrawn.
 */
export type RecoverReferenceViewResult =
  | { status: "recovered"; view: ReferenceViewSummary }
  | { status: ReferenceViewWriteRefusal };

/** A recovery the pre-read admits: the failed attempt, its failed render's row, and the output to fetch. */
export type ReferenceViewRecoveryRead =
  | { readonly ok: true; readonly attempt: ReferenceViewRow; readonly asset: ImageRow; readonly output: PaidOutput }
  | { readonly ok: false; readonly refusal: ReferenceViewWriteRefusal };

/**
 * Every check a recovery makes before it spends a download, outside any lock —
 * restoration's pre-read, for a failed attempt. In order: the owned character
 * has an accepted portrait, the slot is in its plan, the slot's current row is
 * this attempt and still `failed`, nothing is building on the slot or below
 * it, the failed render's row still offers its paid output and the attempt
 * still projects `recoverable`, and the accepted portrait's bytes are still the
 * ones the attempt was rendered from.
 *
 * An offer that exists but no longer fits the sheet is `incompatible`; an offer
 * the provider has shown is gone is `expired`, and so is a link retention has
 * already nulled — the commit's answer for the same condition, and only a stale
 * tab can ask, since recovery is offered only on a linked row. A link this
 * owner-, kind- and entity-scoped read cannot resolve, or a failure with no
 * paid output, is `unavailable`. The commit re-checks all of it under the
 * character lock.
 */
export async function readReferenceViewRecovery(input: {
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  attemptId: string;
}): Promise<ReferenceViewRecoveryRead> {
  const { characterId, ownerId, view } = input;
  const refuse = (refusal: ReferenceViewWriteRefusal): ReferenceViewRecoveryRead => ({ ok: false, refusal });
  const accepted = await readAcceptedPortrait(characterId, ownerId);
  if (accepted === undefined || accepted === null) return refuse("not_found");
  const character = await readReferenceViewCharacter(characterId, ownerId, db());
  if (character === undefined) return refuse("not_found");
  if (!planIncludes(character.plan, view)) return refuse("ineligible");
  // The sheet as an ordinary read projects it: expired leases and lost files
  // are reconciled first, so the offer is judged against what the studio shows.
  const set = await getReferenceViewSet(characterId, ownerId);
  const summary = set.views.find((entry) => sameReferenceView(entry, view));
  const attempt = await currentReferenceViewRow(characterId, view);
  if (summary === undefined || attempt === undefined || attempt.id !== input.attemptId ||
      summary.attemptId !== attempt.id || attempt.status !== "failed") {
    return refuse("changed");
  }
  if (await referenceViewReplacementBusy(characterId, ownerId, view)) return refuse("busy");
  // Retention deleted the failed render's row and the foreign key nulled the
  // link: the window has closed, exactly as the commit finds it.
  if (attempt.imageId === null) return refuse("expired");
  const [asset] = await db().select().from(images).where(and(
    eq(images.id, attempt.imageId), eq(images.ownerId, ownerId), eq(images.kind, "reference_view"),
    eq(images.entityKind, "character"), eq(images.entityId, characterId),
  )).limit(1);
  if (asset === undefined) return refuse("unavailable");
  const offer = paidOutputOffer(asset);
  if (offer.state === "withdrawn") return refuse("expired");
  if (offer.state === "none") return refuse("unavailable");
  if (!summary.recoverable) return refuse("incompatible");
  const source = await readAcceptedPortraitSource(characterId, ownerId);
  if (!source.ok) return refuse(source.reason === "not_found" ? "not_found" : "incompatible");
  if (source.imageId !== attempt.sourceImageId || source.contentHash !== attempt.sourceContentHash) return refuse("incompatible");
  return { ok: true, attempt, asset, output: offer.output };
}

/**
 * A recovery's claim on its slot, or why it could not take one.
 *
 * A recovery downloads for as long as the provider is slow — minutes, at the
 * worst moment — and the browser tab that asked is no guard on what another
 * tab, a reload or another process does meanwhile. So for its whole run a
 * recovery holds the slot exactly as a build does: a heartbeat-live
 * `reference_views` job whose payload leases the slot, with the lease's
 * attempt set to the failed attempt being recovered. Every lease reader sees
 * it — `claimReferenceViewLeases` (single and batch regenerate),
 * `referenceViewSlotBusy`, `referenceViewReplacementBusy` (upload,
 * restoration, another recovery) and the sheet's `building` — and answers
 * `busy`. It lives as long as its process beats it (`JOB_HEARTBEAT_INTERVAL_MS`)
 * whatever happens to the client, and it lapses within `JOB_STALE_MS` of the
 * process dying, which leaves the failed attempt and its offer exactly as they
 * were. The leased row is `failed`, never `pending`, so lease reconciliation
 * and the build's own finalize and fail fencing never act on it.
 */
export type ReferenceViewRecoveryClaim =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly refusal: "changed" | "busy" | "unavailable" };

/**
 * Take the slot for one recovery, under the character lock: the slot's current
 * row must still be this failed attempt (`changed` otherwise), and nothing may
 * be building on the slot or below it (`busy`) — the pre-read's checks, made
 * again where they cannot race. The claim is free: no admission and no budget,
 * and it is not counted in through the per-user job cap, though while it is
 * live it is in-flight work for the cap's own count.
 */
export async function claimReferenceViewRecovery(input: {
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  attemptId: string;
}): Promise<ReferenceViewRecoveryClaim> {
  const { characterId, ownerId, view } = input;
  return withReferenceViewLock<ReferenceViewRecoveryClaim>(characterId, async (tx) => {
    const current = await currentReferenceViewRow(characterId, view, tx);
    if (current === undefined || current.id !== input.attemptId || current.status !== "failed") {
      return { ok: false, refusal: "changed" };
    }
    if (await referenceViewReplacementBusy(characterId, ownerId, view, tx)) return { ok: false, refusal: "busy" };
    const now = new Date();
    const [job] = await tx
      .insert(jobs)
      .values({
        ownerId,
        type: "reference_views",
        status: "running",
        attempts: 1,
        startedAt: now,
        heartbeatAt: now,
        payload: {
          characterId,
          targets: [slotKey(view)],
          leases: [{ angle: view.angle, wardrobe: view.wardrobe, attemptId: input.attemptId }],
          // The character media-jobs read lists this attempt, with its image
          // once the recovery has installed one.
          referenceViewAttemptIds: [input.attemptId],
          recovery: true,
        },
      })
      .returning({ id: jobs.id });
    return job === undefined ? { ok: false, refusal: "unavailable" } : { ok: true, jobId: job.id };
  });
}

/** One heartbeat on a recovery's claim, while and only while it is still running. Never throws. */
export async function beatReferenceViewRecoveryClaim(jobId: string, at: Date = new Date()): Promise<boolean> {
  try {
    const beat = await db()
      .update(jobs)
      .set({ heartbeatAt: at })
      .where(and(eq(jobs.id, jobId), eq(jobs.type, "reference_views"), eq(jobs.status, "running")))
      .returning({ id: jobs.id });
    return beat.length > 0;
  } catch {
    // Heartbeats are best-effort: a claim the database stops taking lapses
    // within JOB_STALE_MS, as it would had the process died.
    return false;
  }
}

/**
 * How a recovery's claim settles. A recovery that ended in a refusal settles
 * `done` with nothing built and the refusal's diagnostic code, the way a build
 * that rendered nothing settles; one that threw settles `failed` with its text.
 */
export type ReferenceViewRecoveryClaimSettlement =
  | { readonly recovered: true }
  | { readonly recovered: false; readonly code: string | null; readonly error: string | null };

/** Settle a claim on the caller's connection: its lease goes, and the job reads as finished. */
async function settleRecoveryClaim(
  executor: ReferenceViewExecutor,
  jobId: string,
  settlement: ReferenceViewRecoveryClaimSettlement,
): Promise<void> {
  const outcome = settlement.recovered
    ? { leases: [], planned: 1, built: 1, failed: 0 }
    : { leases: [], planned: 1, built: 0, failed: 1, ...(settlement.code === null ? {} : { code: settlement.code }) };
  const error = settlement.recovered ? null : settlement.error;
  await executor
    .update(jobs)
    .set({
      status: error === null ? "done" : "failed",
      finishedAt: new Date(),
      payload: sql`${jobs.payload} || ${JSON.stringify(outcome)}::jsonb`,
      ...(error === null ? {} : { error: error.slice(0, 500) }),
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.type, "reference_views"), eq(jobs.status, "running")));
}

/**
 * Release a recovery's claim after any end but an installed one — the install
 * releases its own claim in the transaction that installs. Guarded on a claim
 * still running, so releasing twice changes nothing.
 */
export async function releaseReferenceViewRecoveryClaim(
  jobId: string,
  settlement: ReferenceViewRecoveryClaimSettlement,
): Promise<void> {
  await settleRecoveryClaim(db(), jobId, settlement);
}

export interface InstallRecoveredReferenceViewInput {
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  attemptId: string;
  /** The recovery's own claim on the slot (`claimReferenceViewRecovery`), which must still be live. */
  claimJobId: string;
  /** The failed render's row the output was fetched for — the offer the attempt must still link. */
  failedImageId: string;
  /** The pending copy holding the recovered bytes. */
  copyId: string;
  /** What writing those bytes recorded — `saveImageBuffer`'s file facts. */
  written: WrittenImageInfo;
}

/**
 * Install a recovered output as the SAME attempt, under the character lock:
 * the failed row goes `ready`, unreviewed, rendered, its failure cleared and
 * its recorded upstream and body-image set untouched, pointing at the copy —
 * which goes `ready` in the same transaction. Restoration's commit, for a
 * failed attempt.
 *
 * Every pre-read check is made again here: the owner, the accepted portrait's
 * id and bytes, the plan, the current attempt still this one and still failed,
 * the recovery's own claim still live, nothing else building on the slot or
 * below it, the generation version, the upstream slot's approved lineage, the
 * body-image set, and the failed render's row still linked. A link that is
 * gone means retention deleted that row and the foreign key nulled it: the
 * window closed while the bytes were in flight, so the answer is `expired`. A
 * claim that lapsed means other writers may already have been admitted to the
 * slot, so nothing is installed and the offer stands (`unavailable`).
 *
 * The claim is released in the same transaction that installs, so the slot
 * never reads free with the failed attempt still current. A refusal leaves the
 * claim to the caller, which releases it after every other end.
 *
 * The review revision moves on, because the attempt now shows an image a
 * viewer of the failed tile never saw; a verdict sent against the failure is
 * refused as `changed`. Nothing here deletes anything — the caller compensates
 * a copy this refuses.
 */
export async function installRecoveredReferenceView(input: InstallRecoveredReferenceViewInput): Promise<RecoverReferenceViewResult> {
  const { characterId, ownerId, view } = input;
  return withReferenceViewLock<RecoverReferenceViewResult>(characterId, async (tx) => {
    const source = await readAcceptedPortraitSource(characterId, ownerId, tx);
    if (!source.ok) return { status: source.reason === "not_found" ? "not_found" : "incompatible" };
    const character = await readReferenceViewCharacter(characterId, ownerId, tx);
    if (character === undefined) return { status: "not_found" };
    if (!planIncludes(character.plan, view)) return { status: "ineligible" };
    const current = await currentReferenceViewRow(characterId, view, tx);
    if (current === undefined || current.id !== input.attemptId || current.status !== "failed") return { status: "changed" };
    const now = new Date();
    const claim = await lockLiveReferenceViewLeaseJob(tx, { characterId, ownerId, jobId: input.claimJobId }, now);
    const claimed = claim !== null && payloadLeases(claim.payload).some((lease) =>
      slotKey(lease) === slotKey(view) && lease.attemptId === input.attemptId);
    if (!claimed) return { status: "unavailable" };
    if (await referenceViewReplacementBusy(characterId, ownerId, view, tx, now, input.claimJobId)) return { status: "busy" };
    if (current.sourceImageId !== source.imageId || current.sourceContentHash !== source.contentHash ||
        current.generationVersion !== REFERENCE_VIEW_GENERATION_VERSION ||
        referenceViewBodySetMoved({
          method: "rendered", bodyReferenceSet: current.bodyReferenceSet, currentBodyReferenceSet: character.bodySetFor(view),
        })) {
      return { status: "incompatible" };
    }
    if (current.upstreamViewId !== null &&
        approvedUpstreamLineageId(await getReferenceViewSet(characterId, ownerId, undefined, tx), view) !== current.upstreamViewId) {
      return { status: "incompatible" };
    }
    if (current.imageId === null) return { status: "expired" };
    if (current.imageId !== input.failedImageId) return { status: "changed" };

    const [updated] = await tx
      .update(characterReferenceViews)
      .set({
        status: "ready",
        imageId: input.copyId,
        method: "rendered",
        failureCode: null,
        failureMessage: null,
        verdict: null,
        reviewedByUserId: null,
        reviewedAt: null,
        reviewRevision: current.reviewRevision + 1,
      })
      .where(and(
        eq(characterReferenceViews.id, current.id),
        eq(characterReferenceViews.current, true),
        eq(characterReferenceViews.status, "failed"),
      ))
      .returning({ id: characterReferenceViews.id });
    if (!updated) return { status: "changed" };
    // The copy becomes `ready` exactly as `saveImageBuffer` makes a render
    // ready: its byte count, the file facts the write recorded, and none of the
    // failure or lease keys a ready row never carries.
    await tx
      .update(images)
      .set({
        status: "ready",
        bytes: input.written.bytes,
        meta: mergeMetaSql(
          { width: input.written.width, height: input.written.height, bytes: input.written.bytes },
          READY_RETIRED_META_KEYS,
        ),
      })
      .where(and(eq(images.id, input.copyId), eq(images.ownerId, ownerId), eq(images.kind, "reference_view")));
    await settleRecoveryClaim(tx, input.claimJobId, { recovered: true });
    return { status: "recovered", view: await slotSummaryInTransaction(tx, characterId, ownerId, view) };
  });
}

// ---------------------------------------------------------------------------
// Which slots want building
// ---------------------------------------------------------------------------

/**
 * The slots a "build what is missing" request should render: every planned view
 * whose projected state is `missing`, `failed` or `stale` and whose upstream is
 * approved (`referenceViewsReadyToBuild`) — on a fresh character, the root view
 * alone. The rest build as their upstream views are approved.
 *
 * Deliberately NOT `rejected` — the owner said no to that view, and a bulk build
 * must not quietly re-render something they turned down. A rejected slot is
 * rebuilt one at a time, through its own regenerate. Nor a `recoverable` failed
 * slot: its render was paid for, and recovery brings its image back for free.
 */
export function referenceViewsToRebuild(
  set: ReferenceViewSetSummary,
  planned: readonly ReferenceView[],
): readonly ReferenceView[] {
  const wanted = new Set(planned.map((view) => slotKey(view)));
  return referenceViewsReadyToBuild(set.views).filter((view) => wanted.has(slotKey(view)));
}

/**
 * Retired rows whose assets have outlived their diagnostic window — the sweep's
 * input. Never a `current` row, whatever its status: a stale or failed current
 * row is what the studio is showing the owner right now.
 */
export async function retiredReferenceViewAssets(before: Date, limit: number): Promise<readonly ReferenceViewRow[]> {
  return db()
    .select()
    .from(characterReferenceViews)
    .where(
      and(
        eq(characterReferenceViews.current, false),
        isNotNull(characterReferenceViews.imageId),
        lt(characterReferenceViews.updatedAt, before),
      ),
    )
    .orderBy(asc(characterReferenceViews.updatedAt))
    .limit(limit);
}

/** Drop the collected assets' pointers. The rows stay: they are the slot's history. */
export async function clearReferenceViewAssetPointers(viewIds: readonly string[]): Promise<void> {
  if (viewIds.length === 0) return;
  await db()
    .update(characterReferenceViews)
    .set({ imageId: null })
    .where(inArray(characterReferenceViews.id, [...viewIds]));
}
