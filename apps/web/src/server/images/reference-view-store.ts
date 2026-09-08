import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { parseOr, parseOrNull } from "@/lib/parse";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  allReferenceViews,
  characterProfileSchema,
  emptyCharacterProfile,
  plannedReferenceViews,
  emptyReferenceViewSetSummary,
  isConsumableReferenceView,
  projectReferenceViewState,
  REFERENCE_VIEW_GENERATION_VERSION,
  referenceViewAngleIdSchema,
  referenceViewHistoryVerdict,
  referenceViewFeedbackSchema,
  referenceViewWardrobeSchema,
  type ReferenceView,
  type ReferenceViewHistoryEntry,
  type ReferenceViewMethod,
  type ReferenceViewSetSummary,
  type ReferenceViewSummary,
  type ReferenceViewReviewRequest,
} from "@/contracts";
import { characterReferenceViews, characters, db, hasLiveCharacterJob, images, jobs, JOB_STALE_MS } from "../db";
import { createImageAsset, readImageBytes } from "./asset-storage";
import { deleteOwnedImage } from "./asset-deletion";
import { absoluteImagePath, containedAbsoluteImagePath } from "./paths";
import { log } from "@/server/log";
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

/** Same staleness rule as db/job-liveness, queried on the transaction's own connection. */
async function hasLiveReferenceViewJob(executor: ReferenceViewExecutor, characterId: string): Promise<boolean> {
  const rows = await executor.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.type, "reference_views"), inArray(jobs.status, ["queued", "running"]),
    gt(jobs.createdAt, new Date(Date.now() - JOB_STALE_MS)), sql`${jobs.payload} ->> 'characterId' = ${characterId}`,
  )).limit(1);
  return rows.length > 0;
}

/** Includes the reservation window and abandoned pending attempts visible in the studio. */
export async function referenceViewBuildInFlight(characterId: string, executor: ReferenceViewExecutor = db()): Promise<boolean> {
  if (await hasLiveReferenceViewJob(executor, characterId)) return true;
  const pending = await executor.select({ id: characterReferenceViews.id }).from(characterReferenceViews).where(and(
    eq(characterReferenceViews.characterId, characterId), eq(characterReferenceViews.current, true),
    eq(characterReferenceViews.status, "pending"),
  )).limit(1);
  return pending.length > 0;
}

/** Shared with the sweep; restoration eligibility expires even before a delayed sweep runs. */
export const REFERENCE_VIEW_RETENTION_MS = 7 * 24 * 60 * 60_000;

function restoreUnavailable(
  row: ReferenceViewRow,
  source: AcceptedPortraitSource,
  busy: boolean,
  eligible: boolean,
): ReferenceViewHistoryEntry["restoreUnavailable"] {
  if (!eligible) return "ineligible";
  if (row.current) return "current";
  if (row.updatedAt.getTime() < Date.now() - REFERENCE_VIEW_RETENTION_MS) return "expired";
  if (!row.imageId || !row.method) return "unavailable";
  if (!source.ok || row.sourceImageId !== source.imageId || row.sourceContentHash !== source.contentHash ||
      row.generationVersion !== REFERENCE_VIEW_GENERATION_VERSION) return "incompatible";
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
  const [row] = await executor
    .select({ profile: characters.profile })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (row === undefined) return undefined;
  return plannedReferenceViews(
    parseOr(characterProfileSchema, row.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile"),
  );
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
 * `image_id` never produced bytes (a failed render) or had them collected by the
 * retention sweep, and a row whose asset is not `ready` points at a file that
 * was reserved and never written. The list is evidence for a wording comparison;
 * a row with no picture is not evidence.
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
  const busy = await hasLiveCharacterJob("reference_views", characterId);
  const plan = await readReferenceViewPlan(characterId, ownerId, db());
  if (plan === undefined) return [];
  const eligible = planIncludes(plan, view);

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
        restoreUnavailable: restoreUnavailable(row, source, busy, eligible),
        current: row.current,
        createdAt: row.createdAt.toISOString(),
        reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
        generationVersion: row.generationVersion,
        sourceImageId: row.sourceImageId,
      },
    ];
  });
}

/** One row plus the joined facts the projection needs, as one summary. */
function summarizeRow(
  view: ReferenceView,
  row: ReferenceViewRow | undefined,
  acceptedImageId: string | null,
  imageStatus: string | null,
  eligible: boolean,
): ReferenceViewSummary {
  if (row === undefined) {
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
    };
  }
  const projection = {
    eligible,
    current: row.current,
    status: row.status,
    sourceImageId: row.sourceImageId,
    imageId: row.imageId,
    imageStatus,
    generationVersion: row.generationVersion,
    reviewedAt: row.reviewedAt,
    acceptedImageId,
  };
  return {
    angle: view.angle,
    wardrobe: view.wardrobe,
    state: projectReferenceViewState(projection),
    attemptId: row.id,
    reviewRevision: row.reviewRevision,
    feedback: parseOrNull(referenceViewFeedbackSchema, row.feedback),
    // The asset id rides even on a stale or rejected row: the studio shows the
    // owner what it is calling stale, which is the difference between a state
    // they can act on and one they have to take on faith.
    imageId: row.imageId,
    method: row.method,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    updatedAt: row.updatedAt.toISOString(),
    consumable: isConsumableReferenceView(projection),
  };
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
  executor: ReferenceViewExecutor = db(),
): Promise<ReferenceViewSetSummary> {
  const accepted = await readAcceptedPortrait(characterId, ownerId, executor);
  if (accepted === undefined) return emptyReferenceViewSetSummary();
  const plan = await readReferenceViewPlan(characterId, ownerId, executor, sink);
  if (plan === undefined) return emptyReferenceViewSetSummary();
  const eligibleSlots = new Set(plan.map(slotKey));

  const rows = await currentReferenceViewRows(characterId, executor);
  const statuses = await readViewImageStatuses(rows, executor);

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

  return {
    acceptedImageId: accepted,
    building: await hasLiveReferenceViewJob(executor, characterId),
    views: allReferenceViews().map((view) => {
      const row = bySlot.get(slotKey(view));
      const imageStatus = row === undefined || row.imageId === null ? null : (statuses.get(row.imageId) ?? null);
      return summarizeRow(view, row, accepted, imageStatus, eligibleSlots.has(slotKey(view)));
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
    readReadyBytes: (imageId: string) => Promise<Buffer | null>;
  }) => Promise<T>,
): Promise<T> {
  return withReferenceViewLock(characterId, async (tx) => {
    const set = await getReferenceViewSet(characterId, ownerId, sink, tx);
    const readReadyBytes = async (imageId: string): Promise<Buffer | null> => {
      const [asset] = await tx.select().from(images).where(and(
        eq(images.id, imageId), eq(images.ownerId, ownerId), eq(images.kind, "reference_view"),
      )).limit(1);
      return asset?.status === "ready" ? readImageBytes(asset) : null;
    };
    return operation({ set, readReadyBytes });
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
  return (
    set.views.find((entry) => entry.angle === view.angle && entry.wardrobe === view.wardrobe) ??
    summarizeRow(view, undefined, set.acceptedImageId, null, false)
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface ReserveReferenceViewInput {
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  /** The accepted portrait this attempt renders from. */
  sourceImageId: string;
  sourceContentHash: string;
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
    const plan = await readReferenceViewPlan(characterId, input.ownerId, tx);
    if (plan === undefined || !planIncludes(plan, view)) return null;
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
      })
      .returning({ id: characterReferenceViews.id });
    if (!row) throw new Error("character_reference_views insert returned no row");
    return row.id;
  });
}

export interface FinalizeReferenceViewInput {
  viewId: string;
  characterId: string;
  ownerId: string;
  imageId: string;
  method: ReferenceViewMethod;
  /** Owner id to stamp as the reviewer, for a view that arrives already reviewed (an upload). */
  reviewedByUserId?: string;
}

export interface InstallUploadedReferenceViewInput extends ReserveReferenceViewInput {
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
    if (await referenceViewBuildInFlight(input.characterId, tx)) return { status: "busy" };
    const current = await currentReferenceViewRow(input.characterId, input.view, tx);
    if (source.imageId !== input.sourceImageId || source.contentHash !== input.sourceContentHash ||
        (current?.id ?? null) !== input.expectedCurrentAttemptId || (current?.reviewRevision ?? 0) !== input.expectedCurrentRevision) {
      return { status: "changed" };
    }
    if (current) await tx.update(characterReferenceViews).set({ current: false, status: "superseded" }).where(eq(characterReferenceViews.id, current.id));
    const [candidate] = await tx.insert(characterReferenceViews).values({
      characterId: input.characterId, angleId: input.view.angle, wardrobe: input.view.wardrobe,
      current: true, status: "ready", sourceImageId: source.imageId, sourceContentHash: source.contentHash,
      generationVersion: REFERENCE_VIEW_GENERATION_VERSION, imageId: input.imageId, method: "uploaded",
      verdict: "approved", reviewedByUserId: input.ownerId, reviewedAt: new Date(),
    }).returning();
    if (!candidate) throw new Error("reference upload returned no candidate");
    return { status: "uploaded", view: summarizeRow(input.view, candidate, source.imageId, "ready", true) };
  });
}

/** What a finalize concluded — `ready` or the honest `stale` when the portrait moved under it. */
export type FinalizeReferenceViewResult = "ready" | "stale";

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
      })
      .from(characterReferenceViews)
      .where(eq(characterReferenceViews.id, input.viewId))
      .limit(1);
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
    await tx
      .update(characterReferenceViews)
      .set({
        status: stale ? "stale" : "ready",
        imageId: input.imageId,
        method: input.method,
        // An upload arrives reviewed, so it arrives with a verdict: supplying a
        // view IS the approval, and the row has to say so in the one column
        // that outlives its own supersession.
        ...(reviewed === undefined
          ? {}
          : { verdict: "approved" as const, reviewedByUserId: reviewed, reviewedAt: new Date() }),
      })
      .where(eq(characterReferenceViews.id, input.viewId));
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
 */
export async function failReferenceView(viewId: string, failureCode: string, failureMessage: string): Promise<void> {
  await db()
    .update(characterReferenceViews)
    .set({
      status: "failed",
      imageId: null,
      failureCode,
      failureMessage: failureMessage.slice(0, 500),
    })
    .where(eq(characterReferenceViews.id, viewId));
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
    const plan = await readReferenceViewPlan(input.characterId, input.ownerId, tx, input.sink);
    if (plan === undefined) return { status: "not_found" };
    if (!planIncludes(plan, input.view)) return { status: "ineligible" };
    const accepted = await readAcceptedPortrait(input.characterId, input.ownerId, tx);
    if (accepted === undefined) return { status: "not_found" };
    const row = await currentReferenceViewRow(input.characterId, input.view, tx);
    if (!row || row.id !== input.attemptId || row.reviewRevision !== input.expectedRevision) return { status: "changed" };
    const undo = input.verdict === "undo";
    if (undo ? row.reviewedAt === null || !["ready", "rejected"].includes(row.status)
      : row.status !== "ready" || row.reviewedAt !== null) return { status: "not_ready" };
    const source = await readAcceptedPortraitSource(input.characterId, input.ownerId, tx);
    if (!source.ok || row.sourceImageId !== source.imageId || row.sourceContentHash !== source.contentHash ||
        row.generationVersion !== REFERENCE_VIEW_GENERATION_VERSION) return { status: "incompatible" };
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
      eq(characterReferenceViews.reviewRevision, input.expectedRevision))).returning();
    if (!updated) return { status: "changed" };
    return { status: "reviewed", view: summarizeRow(input.view, updated, accepted, asset.status, true) };
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
  const initialPlan = await readReferenceViewPlan(input.characterId, input.ownerId, db());
  if (initialPlan === undefined) return { status: "not_found" };
  if (!planIncludes(initialPlan, input.view)) return { status: "ineligible" };
  const [attempt] = await db().select().from(characterReferenceViews).where(and(
    eq(characterReferenceViews.id, input.attemptId), eq(characterReferenceViews.characterId, input.characterId),
    eq(characterReferenceViews.angleId, input.view.angle), eq(characterReferenceViews.wardrobe, input.view.wardrobe),
  )).limit(1);
  if (!attempt) return { status: "not_found" };
  const source = await readAcceptedPortraitSource(input.characterId, input.ownerId);
  const unavailable = restoreUnavailable(attempt, source, await hasLiveCharacterJob("reference_views", input.characterId), true);
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
    await fs.writeFile(containedAbsoluteImagePath(destination), bytes, { flag: "wx" });
    const result = await withReferenceViewLock<RestoreReferenceViewResult>(input.characterId, async (tx) => {
      // Recheck ownership and accepted bytes after copying: no stale read authorizes a write.
      const latestSource = await readAcceptedPortraitSource(input.characterId, input.ownerId, tx);
      if (!latestSource.ok) return { status: latestSource.reason === "not_found" ? "not_found" : "incompatible" };
      const latestPlan = await readReferenceViewPlan(input.characterId, input.ownerId, tx);
      if (latestPlan === undefined) return { status: "not_found" };
      if (!planIncludes(latestPlan, input.view)) return { status: "ineligible" };
      const current = await currentReferenceViewRow(input.characterId, input.view, tx);
      if ((current?.id ?? null) !== input.expectedCurrentAttemptId || (current?.reviewRevision ?? 0) !== input.expectedCurrentRevision) {
        return { status: "changed" };
      }
      const [latest] = await tx.select().from(characterReferenceViews).where(eq(characterReferenceViews.id, attempt.id)).limit(1);
      if (!latest) return { status: "unavailable" };
      const busy = current?.status === "pending" || await hasLiveReferenceViewJob(tx, input.characterId);
      const refusal = restoreUnavailable(latest, latestSource, busy, true);
      if (refusal) return { status: refusal === "current" ? "changed" : refusal };
      const [liveAsset] = await tx.select({ status: images.status }).from(images).where(eq(images.id, asset.id)).limit(1);
      if (liveAsset?.status !== "ready" || latest.imageId !== asset.id) return { status: "unavailable" };
      // The retained image can expire immediately after this check; the candidate's independent bytes survive it.
      await tx.update(images).set({ status: "ready", bytes: bytes.length }).where(eq(images.id, copy.id));
      if (current) await tx.update(characterReferenceViews).set({ current: false, status: "superseded" }).where(eq(characterReferenceViews.id, current.id));
      const [candidate] = await tx.insert(characterReferenceViews).values({
        characterId: input.characterId, angleId: input.view.angle, wardrobe: input.view.wardrobe,
        current: true, status: "ready", sourceImageId: latestSource.imageId,
        sourceContentHash: latestSource.contentHash, generationVersion: latest.generationVersion,
        imageId: copy.id, method: latest.method,
      }).returning();
      if (!candidate) throw new Error("reference restoration returned no candidate");
      return { status: "restored", view: summarizeRow(input.view, candidate, latestSource.imageId, "ready", true) };
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
// Which slots want building
// ---------------------------------------------------------------------------

/**
 * The slots a "build what is missing" request should render: every planned view
 * whose projected state is `missing`, `failed` or `stale`.
 *
 * Deliberately NOT `rejected` — the owner said no to that view, and a bulk build
 * must not quietly re-render something they turned down. A rejected slot is
 * rebuilt one at a time, through its own regenerate.
 */
export function referenceViewsToRebuild(
  set: ReferenceViewSetSummary,
  planned: readonly ReferenceView[],
): readonly ReferenceView[] {
  const wanted = new Set(planned.map((view) => slotKey(view)));
  return set.views
    .filter((view) => wanted.has(slotKey(view)))
    .filter((view) => view.state === "missing" || view.state === "failed" || view.state === "stale")
    .map((view) => ({ angle: view.angle, wardrobe: view.wardrobe }));
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
