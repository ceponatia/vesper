import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import {
  type IdentityReferenceRole,
  type IdentityReferenceStrategy,
  type ImageIdentityPackTrialCellSpec,
  imageIdentityPackTrialCellSpecSchema,
  imageIdentityPackTrialDiagnosticCode,
  type ImageIdentityPackTrialRefusalCode,
  type ImageIdentityPackTrialResult,
  imageIdentityPackTrialResultSchema,
  type ImageIdentityPackTrialRunSummary,
  type ImageModelProfile,
  pairTrialCells,
  type ProfileRenderPlan,
  type TrialCellCounts,
  type TrialCellStatus,
  type TrialPairableCell,
  type TrialRenderedCombo,
  type TrialRunStatus,
  type TrialVerdict,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  db,
  imageIdentityPackTrialCells,
  imageIdentityPackTrialGrades,
  imageIdentityPackTrialRuns,
  imageIdentityPackTrialVerdicts,
  images,
} from "../db";
import { purgeImagesWhere } from "./assets";
import { readJsonColumn } from "./identity-pack-store";
import { profileRenderControlsHash, sha256Hex } from "./render-fingerprint";

/**
 * The fixed identity-reference trial service
 * (docs/developer-notes/image-identity-packs.spec.trial.md): plan a bounded
 * grid of comparison cells, execute them a few renders at a time, serve blinded
 * pairs for review, aggregate the grades, and record per-(profile, strategy)
 * verdicts. Everything pure — the cartesian planner, the pairing rule, the
 * unblinding flip, the aggregation math — lives in
 * `packages/image-core/src/identity/identity-pack-trial-planning.ts`; this service owns persistence, the
 * pack/profile resolution at planning time, and the provider call.
 *
 * This module is the service's leaf — keys and hashes, the row/refusal layer,
 * the shared readers, run-status settlement, the listing reads and run deletion
 * — importing no other trial module. The four stages sit on top of it:
 * `./identity-pack-trial-plan.ts`, `./identity-pack-trial-execute.ts`,
 * `./identity-pack-trial-render.ts` and `./identity-pack-trial-review.ts`.
 *
 * Four rules shape the service:
 *
 * 1. **Everything is owner-scoped.** Runs are selected by `(id, owner)`; a
 *    character the run owner does not own resolves exactly like a character
 *    that does not exist (`ensureIdentityPack`'s owner-rooted source
 *    resolution), so its cells are recorded `refused` and nothing about the
 *    foreign character leaks.
 * 2. **A cell is CLAIMED before it is rendered, the WHOLE REMAINING QUEUE is
 *    re-asserted at every cell boundary, and each cell settles once.** A pass
 *    moves its cells from `planned` to `running` with its own token in the
 *    database before the provider is called; at each boundary it then re-stamps
 *    that claim on every cell it has not yet attempted, head included. Staleness
 *    therefore measures how long a pass has been SILENT — one cell span at
 *    most — rather than a cell's position in the batch, so a live pass's queued
 *    claims can never look abandoned, and a claim already lost costs zero
 *    provider calls instead of one deleted image. Every settle is a
 *    compare-and-set against that exact claim. The in-process lock cannot see a
 *    second machine or survive a restart; this can. `failed` and `refused` remain
 *    terminal — a rerun is a NEW run, never a retry.
 * 3. **The daily render budget is charged INSIDE the execution lock, through
 *    the caller's injected `chargeBudget`** — sized to exactly the cells this
 *    pass CLAIMED and can honestly execute, after `run_locked` can no longer
 *    refuse the pass. The route supplies the charge function
 *    (`imageRenderRejection` bound to the request), because the guard needs the
 *    request and its user; this module decides WHEN and for HOW MANY, because
 *    charging before the lock billed passes that were then refused, with no
 *    refund path.
 * 4. **What is hashed is what is sent.** Planning and execution both compile the
 *    cell through `compileProfileRenderPlan`, so the prompt, negative and
 *    control payload a cell pinned are the ones the provider receives — and any
 *    drift between the two is a `cell_conflict` rather than a silently
 *    different render wearing a pinned cell's name.
 *
 * Run status is derived-but-persisted, and every transition goes through
 * {@link nextTrialRunStatus}: draft → running on the first execute, running →
 * review when no cell is left planned OR claimed, review → complete when a
 * verdict covers every (profile, strategy) present in the rendered cells AND
 * every reviewable pair has been graded.
 *
 * Verdicts are rows in `image_identity_pack_trial_verdicts`, one per ruling,
 * upserted under `(run, profile, strategy)` — never a jsonb array on the run
 * row, which made every ruling a read-modify-write that could erase a
 * concurrent one.
 */

/* ------------------------------------------------------------------------ *
 * Keys, hashes, and the blind mapping                                       *
 * ------------------------------------------------------------------------ */

/**
 * The one spelling of the per-run execution key, for the reason
 * `identityPackLockKey` gives: a second copy that drifts serializes against
 * nobody and looks completely normal. In-process is correct on the
 * single-machine Fly deploy (the `keyed-lock.ts` ruling); the durable per-cell
 * claim — `planned` → `running` under a token, settled by compare-and-set
 * against that same token — is what keeps a second machine from double-paying
 * for a cell regardless.
 */
export function identityPackTrialLockKey(runId: string): string {
  return `identity_pack_trial:${runId}`;
}

/**
 * Which side of a blinded pair the reviewer sees on the left, derived rather
 * than stored: the parity of the first byte of sha256(`runId:pairId`). Stable
 * across requests without a placeholder row — the review screen can be loaded
 * twice and show the same sides — while still unpredictable enough that a
 * reviewer cannot learn a rule like "left is always A". The mapping actually
 * used is ALSO persisted on the grade row at submission, so the stored grade
 * stays interpretable even if this derivation ever changes.
 */
export function trialPairLeftIsA(runId: string, pairId: string): boolean {
  const digest = createHash("sha256").update(`${runId}:${pairId}`).digest();
  return (digest[0] ?? 0) % 2 === 0;
}

/** The three fingerprints a cell pins and execution re-checks. */
interface TrialCellCompiledIdentity {
  positivePromptHash: string;
  negativePromptHash: string | null;
  resolvedControlsHash: string;
}

/**
 * The one place a cell's compiled identity is derived — at planning time and
 * again at execution time, through the same function, so the check cannot drift
 * from the thing it checks.
 *
 * Everything here comes out of {@link compileProfileRenderPlan}: the prompt the
 * provider will receive (role preamble and model dialect included), the negative
 * text that will accompany it, and the fingerprint of the resolved controls.
 * Planning stores these; execution recomputes them from the rows in force and
 * refuses `cell_conflict` on any difference, because a cell that renders under a
 * configuration other than the one it pinned is not the comparison the grid
 * claims.
 */
export function trialCellCompiledIdentity(
  plan: ProfileRenderPlan,
  profile: ImageModelProfile,
  roles: readonly IdentityReferenceRole[],
): TrialCellCompiledIdentity {
  return {
    positivePromptHash: sha256Hex(plan.finalPrompt),
    negativePromptHash: plan.negativePrompt === null ? null : sha256Hex(plan.negativePrompt),
    resolvedControlsHash: profileRenderControlsHash(plan, {
      profileId: profile.id,
      profileKey: profile.key,
      promptStrategy: profile.promptStrategy,
      orderedReferenceRoles: roles,
    }),
  };
}


/* ------------------------------------------------------------------------ *
 * Rows, refusals, shared readers                                            *
 * ------------------------------------------------------------------------ */

export type IdentityPackTrialRunRow = typeof imageIdentityPackTrialRuns.$inferSelect;
export type IdentityPackTrialCellRow = typeof imageIdentityPackTrialCells.$inferSelect;

/** A typed refusal — the service's "no", which routes turn into the wire shape. */
export interface IdentityPackTrialRefusal {
  code: ImageIdentityPackTrialRefusalCode;
  message: string;
}

const SPEC_JSON_PATH = "image_identity_pack_trial_cells.spec_json";
const RESULT_JSON_PATH = "image_identity_pack_trial_cells.result_json";
export const GRADES_JSON_PATH = "image_identity_pack_trial_grades.grades_json";

export function refusal(
  code: ImageIdentityPackTrialRefusalCode,
  message: string,
  sink: DiagnosticSink | undefined,
  context: Record<string, unknown>,
): IdentityPackTrialRefusal {
  sink?.push(diag("warn", imageIdentityPackTrialDiagnosticCode(code), message, { context }));
  return { code, message };
}

/** A refused/failed cell's result: nulls everywhere except the why. */
export function trialResult(partial: Partial<ImageIdentityPackTrialResult>): ImageIdentityPackTrialResult {
  return {
    providerPredictionId: null,
    providerVersionId: null,
    outputImageId: null,
    latencyMs: null,
    moderationOutcome: null,
    finalWidthPx: null,
    finalHeightPx: null,
    postCrop: null,
    failureCode: null,
    failureMessage: null,
    ...partial,
  };
}

export async function ownedTrialRun(runId: string, ownerId: string): Promise<IdentityPackTrialRunRow | undefined> {
  const [row] = await db()
    .select()
    .from(imageIdentityPackTrialRuns)
    .where(and(eq(imageIdentityPackTrialRuns.id, runId), eq(imageIdentityPackTrialRuns.ownerId, ownerId)))
    .limit(1);
  return row;
}

export async function trialCellRows(runId: string): Promise<IdentityPackTrialCellRow[]> {
  return db()
    .select()
    .from(imageIdentityPackTrialCells)
    .where(eq(imageIdentityPackTrialCells.runId, runId))
    .orderBy(asc(imageIdentityPackTrialCells.cellKey));
}

/**
 * One cell's spec at the trust boundary. A cell refused BEFORE full resolution
 * (a blocked pack, a missing profile) legitimately stores only the fields that
 * resolved — the wave-1 spec contract has no partial arm — so for a refused
 * cell a non-parsing spec is an expected shape and reads back as `null` with no
 * diagnostic. Any OTHER status must carry a full spec, and a parse failure
 * there is genuine corruption: degraded to `null` with the warn the sink rule
 * requires, never an exception.
 */
function readTrialCellSpec(
  row: IdentityPackTrialCellRow,
  sink: DiagnosticSink | undefined,
): ImageIdentityPackTrialCellSpec | null {
  if (row.status === "refused") {
    const parsed = imageIdentityPackTrialCellSpecSchema.safeParse(row.specJson);
    return parsed.success ? parsed.data : null;
  }
  return readJsonColumn(imageIdentityPackTrialCellSpecSchema, row.specJson, sink, SPEC_JSON_PATH).value;
}

export function zeroTrialCellCounts(): TrialCellCounts {
  return { planned: 0, running: 0, rendered: 0, failed: 0, refused: 0 };
}

export function countTrialCells(rows: readonly Pick<IdentityPackTrialCellRow, "status">[]): TrialCellCounts {
  const counts = zeroTrialCellCounts();
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function runSummary(run: IdentityPackTrialRunRow, counts: TrialCellCounts): ImageIdentityPackTrialRunSummary {
  return {
    id: run.id,
    label: run.label,
    status: run.status,
    counts,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

/**
 * The run's verdict ledger, one row per ruling, in a stable (profile, strategy)
 * order so two reads of an unchanged run are byte-identical on the wire.
 *
 * No parse step and no `parseOr` fallback: every field is a typed column
 * (`identity_strategy` and `verdict` are enum-typed against the contract
 * vocabularies), so the row IS the contract shape and there is no stored-JSON
 * trust boundary left to degrade at. That is the whole point of normalizing the
 * old `verdicts_json` array — a ledger that could half-parse was a ledger that
 * could silently lose a ruling.
 */
export async function readTrialVerdicts(runId: string): Promise<TrialVerdict[]> {
  const rows = await db()
    .select()
    .from(imageIdentityPackTrialVerdicts)
    .where(eq(imageIdentityPackTrialVerdicts.runId, runId))
    .orderBy(asc(imageIdentityPackTrialVerdicts.profileId), asc(imageIdentityPackTrialVerdicts.identityStrategy));
  return rows.map((row) => ({
    profileId: row.profileId,
    identityStrategy: row.identityStrategy,
    verdict: row.verdict,
    reason: row.reason,
    policyVersion: row.policyVersion,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt.toISOString(),
    overrideIncompleteReview: row.overrideIncompleteReview,
  }));
}


/** What one execution pass reports per cell it held (`./identity-pack-trial-execute.ts`). */
export interface ExecutedTrialCell {
  cellId: string;
  cellKey: string;
  status: "rendered" | "failed" | "refused" | "skipped";
}

/* ------------------------------------------------------------------------ *
 * Run status                                                                *
 * ------------------------------------------------------------------------ */

/**
 * The one place a run's derived-but-persisted status moves. Exhaustive over the
 * current status so a new lifecycle position cannot ship without deciding what
 * it may become.
 *
 * Two facts changed when the durable execution claim and the review gate landed:
 *
 * - **`unexecutedRemaining` counts `planned` AND `running`.** A run with claimed
 *   cells still in flight is not reviewable: its pairs are incomplete, and
 *   settling it into `review` would open the verdict surface over evidence that
 *   is still being paid for. The old `plannedRemaining` reached zero the instant
 *   the last cell was CLAIMED, which is exactly the wrong moment.
 * - **`review` → `complete` requires graded pairs as well as ruled combos.** A
 *   run whose every slot carries a verdict but whose pairs were never graded is
 *   a set of opinions, not a trial: `complete` is the claim that the blinded
 *   procedure actually ran, so both halves of the evidence must be in.
 *
 * Both facts are additionally FALSE while any rendered cell is degraded — its
 * image gone or its spec unreadable — because each of them is otherwise
 * satisfiable by evidence disappearing. A run with no pairs left to grade and a
 * run whose pairs were all graded look identical from here; only the degraded
 * count tells them apart.
 *
 * The coverage fact must still be TRUE of something — a run with no rendered
 * cell at all stays in `review` as the record of a trial nothing came of, rather
 * than claiming completion vacuously.
 */
function nextTrialRunStatus(
  current: TrialRunStatus,
  facts: {
    executing: boolean;
    unexecutedRemaining: number;
    allReviewablePairsGraded: boolean;
    verdictsCoverEveryRenderedCombo: boolean;
  },
): TrialRunStatus {
  let status = current;
  switch (status) {
    case "draft":
      if (facts.executing) status = facts.unexecutedRemaining === 0 ? "review" : "running";
      break;
    case "running":
      if (facts.unexecutedRemaining === 0) status = "review";
      break;
    case "review":
    case "complete":
      break;
  }
  if (status === "review" && facts.verdictsCoverEveryRenderedCombo && facts.allReviewablePairsGraded) {
    status = "complete";
  }
  return status;
}

/** `profileId:strategy` — the unit a verdict rules on. */
export function verdictComboKey(profileId: string, strategy: IdentityReferenceStrategy): string {
  return `${profileId}:${strategy}`;
}

/**
 * A rendered (profile, strategy) before its pairwise evidence is counted. The
 * wire shape ({@link TrialRenderedCombo}) additionally carries `totalPairs` /
 * `gradedPairs`, which only the summary path can compute — {@link
 * verdictsCoverRenderedCombos} needs the combo IDENTITY and nothing else, and
 * handing it a shape padded with zero counts would be a fabricated number
 * travelling under a real field name.
 */
export type RenderedComboTally = Omit<TrialRenderedCombo, "totalPairs" | "gradedPairs">;

interface RenderedTrialCombos {
  combos: RenderedComboTally[];
  /**
   * Rendered rows whose spec is UNREADABLE, so nothing can say which verdict
   * slot they belong to.
   *
   * Such a row is not "one fewer combo" — it is a combo of unknown identity, and
   * treating it as absent would silently delete a verdict slot the run was
   * supposed to be ruled on. Completion therefore refuses while any exist: a run
   * with an unaccountable rendered cell wedges loudly in `review` (the parse
   * failure already fires its own warn) rather than claiming every combination
   * was ruled when one of them could not even be named.
   */
  degraded: number;
}

/**
 * Every (profile, strategy) with at least one rendered cell, in cell-key order.
 * The ONE derivation shared by run completion ({@link verdictsCoverRenderedCombos})
 * and the summary wire's `renderedCombos`: the verdict slots the UI offers must
 * be exactly the set completion waits on, or a run whose strategy lost every
 * counterpart cell (no pair, so no comparison) wedges in `review` with no slot
 * to rule it through.
 *
 * A null-strategy cell — the no-pack baseline — is deliberately SKIPPED, and is
 * NOT degraded. It is evidence, not a verdict slot: a verdict rules on a
 * (profile, strategy), and the baseline has no strategy to promote or reject.
 * Counting it would create a slot nothing can ever fill and wedge the run short
 * of `complete`.
 */
export function renderedTrialCombos(
  rows: readonly IdentityPackTrialCellRow[],
  sink: DiagnosticSink | undefined,
): RenderedTrialCombos {
  const combos = new Map<string, RenderedComboTally>();
  let degraded = 0;
  for (const row of rows) {
    if (row.status !== "rendered") continue;
    const spec = readTrialCellSpec(row, sink);
    if (!spec) {
      degraded += 1;
      continue;
    }
    if (spec.identityStrategy === null) continue;
    const strategy = spec.identityStrategy;
    const key = verdictComboKey(spec.profileId, strategy);
    const existing = combos.get(key);
    if (existing) existing.renderedCells += 1;
    else combos.set(key, { profileId: spec.profileId, identityStrategy: strategy, renderedCells: 1 });
  }
  return { combos: [...combos.values()], degraded };
}

function verdictsCoverRenderedCombos(
  rows: readonly IdentityPackTrialCellRow[],
  verdicts: readonly TrialVerdict[],
  sink: DiagnosticSink | undefined,
): boolean {
  const { combos, degraded } = renderedTrialCombos(rows, sink);
  // A rendered cell nothing can name is a verdict slot nothing can rule. Reading
  // past it would let a run complete over a combination that was never ruled
  // because it could no longer be identified.
  if (degraded > 0 || combos.length === 0) return false;
  const ruled = new Set(verdicts.map((verdict) => verdictComboKey(verdict.profileId, verdict.identityStrategy)));
  return combos.every((combo) => ruled.has(verdictComboKey(combo.profileId, combo.identityStrategy)));
}

/**
 * Recompute and persist the run's status from its cells, its grades and its
 * verdicts.
 *
 * Every fact {@link nextTrialRunStatus} needs is gathered HERE rather than
 * passed in by the caller, verdicts included. Two callers reach this — the
 * execute pass and the verdict write — and each knows only its own half of the
 * evidence; a caller-supplied ledger was how the pre-normalization code let an
 * execute pass settle a run against a verdict list it had read before the last
 * ruling landed. One reader, one moment, no skew.
 */
export async function settleTrialRunStatus(
  runId: string,
  current: TrialRunStatus,
  executing: boolean,
  sink: DiagnosticSink | undefined,
): Promise<TrialRunStatus> {
  const rows = await trialCellRows(runId);
  const counts = countTrialCells(rows);
  const { pairable, degraded } = reviewableTrialCells(rows, sink);
  const [graded, verdicts] = await Promise.all([gradedPairIds(runId), readTrialVerdicts(runId)]);
  const next = nextTrialRunStatus(current, {
    executing,
    unexecutedRemaining: counts.planned + counts.running,
    // Degraded rendered evidence blocks completion as hard as an ungraded pair,
    // and for the same reason: `complete` asserts the blinded procedure RAN over
    // this run's evidence. A rendered cell whose image or spec has vanished
    // takes its pairs with it, so "every pair is graded" becomes vacuously true
    // exactly when the thing it certifies stopped being checkable.
    allReviewablePairsGraded: degraded === 0 && pairTrialCells(pairable).every((pair) => graded.has(pair.pairId)),
    verdictsCoverEveryRenderedCombo: verdictsCoverRenderedCombos(rows, verdicts, sink),
  });
  if (next !== current) {
    await db().update(imageIdentityPackTrialRuns).set({ status: next }).where(eq(imageIdentityPackTrialRuns.id, runId));
  }
  return next;
}


/* ------------------------------------------------------------------------ *
 * Reviewable cells                                                          *
 * ------------------------------------------------------------------------ */

interface ReviewableTrialCells {
  pairable: TrialPairableCell[];
  outputImageIdByCellId: Map<string, string>;
  /**
   * How many `rendered` rows were SKIPPED because their evidence is gone — a
   * null output pointer (the FK set-null safety net fired) or a spec that no
   * longer parses.
   *
   * It is counted rather than swallowed because it is the difference between
   * "every reviewable pair is graded" and "every pair we can still SEE is
   * graded". Those read identically at the review screen and mean opposite
   * things at a verdict: the second is a run whose blinded procedure cannot be
   * completed, and a `complete` stamped over it would be a claim about evidence
   * nobody can produce.
   */
  degraded: number;
}

/**
 * The rendered cells a pair may be built from. A rendered cell whose output
 * image is gone (the FK set-null safety net) or whose spec no longer parses is
 * skipped with a warn AND counted: it is a hole in the evidence, not a reason to
 * fail the review queue, but also not something completion may step over.
 */
export function reviewableTrialCells(
  rows: readonly IdentityPackTrialCellRow[],
  sink: DiagnosticSink | undefined,
): ReviewableTrialCells {
  const pairable: TrialPairableCell[] = [];
  const outputImageIdByCellId = new Map<string, string>();
  let degraded = 0;
  for (const row of rows) {
    if (row.status !== "rendered") continue;
    const spec = readTrialCellSpec(row, sink);
    if (!spec || row.outputImageId === null) {
      degraded += 1;
      sink?.push(
        diag("warn", "images.identity_pack.trial.cell_degraded", "rendered cell is unreviewable; skipped from pairing", {
          context: { cellId: row.id, cellKey: row.cellKey, missing: spec ? "output_image" : "spec" },
        }),
      );
      continue;
    }
    outputImageIdByCellId.set(row.id, row.outputImageId);
    pairable.push({
      id: row.id,
      status: row.status,
      characterId: spec.characterId,
      profileId: spec.profileId,
      promptFixtureId: spec.promptFixtureId,
      task: spec.task,
      identityStrategy: spec.identityStrategy,
      packVariantKey: spec.packVariantKey,
      referenceSource: spec.referenceSource,
      // The two facts the pairing rule needs to tell a real comparison from two
      // labels on one render: what this cell actually SENT, and which photograph
      // it was derived from.
      orderedReferenceRoles: spec.orderedReferenceRoles,
      sourceContentHash: spec.sourceContentHash,
    });
  }
  return { pairable, outputImageIdByCellId, degraded };
}

export async function gradedPairIds(runId: string): Promise<Set<string>> {
  const rows = await db()
    .select({ pairId: imageIdentityPackTrialGrades.pairId })
    .from(imageIdentityPackTrialGrades)
    .where(eq(imageIdentityPackTrialGrades.runId, runId));
  return new Set(rows.map((row) => row.pairId));
}

/* ------------------------------------------------------------------------ *
 * Listing and detail                                                        *
 * ------------------------------------------------------------------------ */

export async function listIdentityPackTrialRuns(ownerId: string): Promise<ImageIdentityPackTrialRunSummary[]> {
  const runs = await db()
    .select()
    .from(imageIdentityPackTrialRuns)
    .where(eq(imageIdentityPackTrialRuns.ownerId, ownerId))
    .orderBy(desc(imageIdentityPackTrialRuns.createdAt));
  if (runs.length === 0) return [];

  const countRows = await db()
    .select({
      runId: imageIdentityPackTrialCells.runId,
      status: imageIdentityPackTrialCells.status,
      cells: count(),
    })
    .from(imageIdentityPackTrialCells)
    .where(inArray(imageIdentityPackTrialCells.runId, runs.map((run) => run.id)))
    .groupBy(imageIdentityPackTrialCells.runId, imageIdentityPackTrialCells.status);
  const countsByRun = new Map<string, TrialCellCounts>();
  for (const row of countRows) {
    const counts = countsByRun.get(row.runId) ?? zeroTrialCellCounts();
    counts[row.status] = row.cells;
    countsByRun.set(row.runId, counts);
  }

  return runs.map((run) => runSummary(run, countsByRun.get(run.id) ?? zeroTrialCellCounts()));
}

/** One cell as the detail surface reads it. `spec` is null for the one expected
 * shape — a cell refused before full resolution — and for genuine corruption,
 * which arrives with its own warn diagnostic. */
export interface IdentityPackTrialCellView {
  id: string;
  cellKey: string;
  status: TrialCellStatus;
  spec: ImageIdentityPackTrialCellSpec | null;
  result: ImageIdentityPackTrialResult | null;
  outputImageId: string | null;
}

export interface IdentityPackTrialRunDetail {
  run: ImageIdentityPackTrialRunSummary;
  cells: IdentityPackTrialCellView[];
}

/** The run with every cell — ids and measurements only, no bytes. Null when the
 * run is not this owner's (indistinguishable from not existing). */
export async function getIdentityPackTrialRunDetail(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<IdentityPackTrialRunDetail | null> {
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const rows = await trialCellRows(runId);
  const cells = rows.map(
    (row): IdentityPackTrialCellView => ({
      id: row.id,
      cellKey: row.cellKey,
      status: row.status,
      spec: readTrialCellSpec(row, sink),
      result: readJsonColumn(imageIdentityPackTrialResultSchema, row.resultJson, sink, RESULT_JSON_PATH).value,
      outputImageId: row.outputImageId,
    }),
  );
  return { run: runSummary(run, countTrialCells(rows)), cells };
}


/* ------------------------------------------------------------------------ *
 * Deletion                                                                  *
 * ------------------------------------------------------------------------ */

export interface DeleteIdentityPackTrialRunResult {
  deleted: boolean;
  outputImagesRemoved: number;
}

/**
 * Hard-delete a run: every output image row and file it produced, THEN the row.
 *
 * Cells, grades AND verdicts cascade with it — all three tables FK `run_id`
 * with `on delete cascade`, so the run row is the single sweep point and no
 * ledger outlives the trial it belongs to. (The verdicts are the newest of the
 * three: when they lived in the run row's jsonb they could not survive it by
 * construction, and a normalized table only keeps that property because its FK
 * says so.)
 *
 * The purge goes first because the cell
 * rows are the only pointers to the hidden outputs — deleting the run first
 * would erase the pointers, and a crash between the two would orphan
 * `identity_trial_output` rows and files nothing can find again. Purge-first
 * fails safe: a crash leaves the run intact (its cell pointers FK-nulled by
 * the purge), so the delete can simply be run again. The purge is guarded by
 * owner AND kind, so a wrong id can only ever delete nothing. `deleted: false`
 * means the run was not this owner's, indistinguishable from never having
 * existed.
 */
export async function deleteIdentityPackTrialRun(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<DeleteIdentityPackTrialRunResult> {
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return { deleted: false, outputImagesRemoved: 0 };

  const cellRows = await db()
    .select({ outputImageId: imageIdentityPackTrialCells.outputImageId })
    .from(imageIdentityPackTrialCells)
    .where(eq(imageIdentityPackTrialCells.runId, runId));
  const outputImageIds = cellRows
    .map((row) => row.outputImageId)
    .filter((imageId): imageId is string => imageId !== null);

  const outputImagesRemoved =
    outputImageIds.length === 0
      ? 0
      : await purgeImagesWhere(
          and(
            inArray(images.id, outputImageIds),
            eq(images.ownerId, ownerId),
            eq(images.kind, "identity_trial_output"),
          ),
        );
  if (outputImagesRemoved < outputImageIds.length) {
    sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "some output image rows were already gone at delete", {
        context: { runId, expected: outputImageIds.length, removed: outputImagesRemoved },
      }),
    );
  }

  await db()
    .delete(imageIdentityPackTrialRuns)
    .where(and(eq(imageIdentityPackTrialRuns.id, runId), eq(imageIdentityPackTrialRuns.ownerId, ownerId)));

  return { deleted: true, outputImagesRemoved };
}
