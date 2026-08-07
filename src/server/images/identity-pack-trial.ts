import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lt } from "drizzle-orm";
import {
  imageIdentityPackTrialCellSpecSchema,
  imageIdentityPackTrialDiagnosticCode,
  imageIdentityPackTrialResultSchema,
  imageProfileOffered,
  referenceCapacity,
  trialCellComboSchema,
  trialPairGradeSchema,
  type IdentityReferenceRole,
  type IdentityReferenceStrategy,
  type ImageIdentityPackStatus,
  type ImageIdentityPackTrialCellSpec,
  type ImageIdentityPackTrialCreateRequest,
  type ImageIdentityPackTrialGradeRequest,
  type ImageIdentityPackTrialRefusalCode,
  type ImageIdentityPackTrialResult,
  type ImageIdentityPackTrialReviewPairWire,
  type ImageIdentityPackTrialRunSummary,
  type ImageIdentityPackTrialSummaryWire,
  type ImageModel,
  type ImageModelProfile,
  type TrialCellCounts,
  type TrialCellStatus,
  type TrialRenderedCombo,
  type TrialRunStatus,
  type TrialVerdict,
  type TrialVerdictValue,
  type EnsureIdentityPackResult,
  type EvaluateIdentityPackResult,
  type ImageIdentityPackV1,
} from "@/contracts";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { IDENTITY_PACK_POLICY_VERSION } from "@/lib/images/identity-pack-policy";
import {
  buildTrialCellPlans,
  compareTrialCellKeys,
  pairTrialCells,
  trialPromptFixtureById,
  unblindTrialPairGrade,
  aggregateTrialGrades,
  type IdentityPackTrialPromptFixture,
  type TrialCellPair,
  type TrialCellPlan,
  type TrialGradeRecord,
  type TrialPairableCell,
} from "@/lib/images/identity-pack-trial";
import { newId } from "@/lib/ids";
import { classifyImageFailure, OUTPUT_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "../ai";
import {
  db,
  imageIdentityPackTrialCells,
  imageIdentityPackTrialGrades,
  imageIdentityPackTrialRuns,
  imageIdentityPackTrialVerdicts,
  images,
} from "../db";
// Direct module path for the reason identity-packs.ts records on ITS import of
// this file: the `@/server/engine` barrel re-exports `chat-pipeline.ts`, which
// imports `@/server/images` — naming the barrel here would close a real import
// cycle. `keyed-lock.ts` itself imports nothing.
import { tryKeyedLock } from "../engine/keyed-lock";
import { createImageAsset, deleteOwnedImage, imageMeta, purgeImagesWhere, readImageBytes, saveImageBuffer } from "./assets";
import {
  ensureIdentityPack,
  getIdentityPackRevisionForTrial,
  IDENTITY_PACK_TRIAL_CORPORA,
  readJsonColumn,
  type IdentityPackRevisionForTrialResult,
} from "./identity-packs";
import {
  evaluateIdentityPackContractForProfile,
  evaluateIdentityPackForProfile,
  identityRolePlan,
} from "./identity-pack-references";
import { loadImageModels, renderWithModel, type RenderWithModelResult } from "./models";
import { loadImageModelProfiles } from "./model-profiles";
import {
  compileProfileRenderPlan,
  MAX_TRIAL_PREDICTION_MS,
  pinnedImageModelVersion,
  profileRenderControlsHash,
  sha256Hex,
  type ProfileRenderPlan,
} from "./render-profile";

/**
 * The fixed identity-reference trial service
 * (docs/developer-notes/image-identity-packs.spec.trial.md): plan a bounded
 * grid of comparison cells, execute them a few renders at a time, serve blinded
 * pairs for review, aggregate the grades, and record per-(profile, strategy)
 * verdicts. Everything pure — the cartesian planner, the pairing rule, the
 * unblinding flip, the aggregation math — lives in
 * `src/lib/images/identity-pack-trial.ts`; this module owns persistence, the
 * pack/profile resolution at planning time, and the provider call.
 *
 * Four rules shape it:
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
function trialCellCompiledIdentity(
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
const GRADES_JSON_PATH = "image_identity_pack_trial_grades.grades_json";

function refusal(
  code: ImageIdentityPackTrialRefusalCode,
  message: string,
  sink: DiagnosticSink | undefined,
  context: Record<string, unknown>,
): IdentityPackTrialRefusal {
  sink?.push(diag("warn", imageIdentityPackTrialDiagnosticCode(code), message, { context }));
  return { code, message };
}

/** A refused/failed cell's result: nulls everywhere except the why. */
function trialResult(partial: Partial<ImageIdentityPackTrialResult>): ImageIdentityPackTrialResult {
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

async function ownedTrialRun(runId: string, ownerId: string): Promise<IdentityPackTrialRunRow | undefined> {
  const [row] = await db()
    .select()
    .from(imageIdentityPackTrialRuns)
    .where(and(eq(imageIdentityPackTrialRuns.id, runId), eq(imageIdentityPackTrialRuns.ownerId, ownerId)))
    .limit(1);
  return row;
}

async function trialCellRows(runId: string): Promise<IdentityPackTrialCellRow[]> {
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

function zeroTrialCellCounts(): TrialCellCounts {
  return { planned: 0, running: 0, rendered: 0, failed: 0, refused: 0 };
}

function countTrialCells(rows: readonly Pick<IdentityPackTrialCellRow, "status">[]): TrialCellCounts {
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
function verdictComboKey(profileId: string, strategy: IdentityReferenceStrategy): string {
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
type RenderedComboTally = Omit<TrialRenderedCombo, "totalPairs" | "gradedPairs">;

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
function renderedTrialCombos(
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
async function settleTrialRunStatus(
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
 * Run creation                                                              *
 * ------------------------------------------------------------------------ */

export interface CreateIdentityPackTrialRunInput {
  ownerId: string;
  request: ImageIdentityPackTrialCreateRequest;
  sink?: DiagnosticSink;
}

export type CreateIdentityPackTrialRunResult =
  | { ok: true; runId: string; counts: TrialCellCounts }
  | { ok: false; refusal: IdentityPackTrialRefusal };

type ResolvedTrialCell =
  | { status: "planned"; spec: ImageIdentityPackTrialCellSpec }
  | {
      status: "refused";
      code: ImageIdentityPackTrialRefusalCode;
      message: string;
      /** Whatever resolved before the refusal — honestly partial, never faked. */
      spec: Record<string, unknown>;
    };

interface TrialPlanResolution {
  ownerId: string;
  profilesById: Map<string, ImageModelProfile>;
  modelsById: Map<string, ImageModel>;
  /** One `ensureIdentityPack` per character per create call. */
  packs: Map<string, Promise<EnsureIdentityPackResult>>;
  /** One read per pinned `(character, revision)` per create call. */
  revisions: Map<string, Promise<IdentityPackRevisionForTrialResult>>;
  /** One profile-eligibility evaluation per (character, strategy, pack variant). */
  evaluations: Map<string, Promise<EvaluateIdentityPackResult>>;
  sink: DiagnosticSink | undefined;
}

/**
 * The one memo spelling the per-create caches share.
 *
 * Each of them keys work that is either expensive (a pack ensure, a pinned
 * revision read) or noisy (an evaluation that pushes diagnostics), and whose
 * answer cannot change inside one create call. The get/set dance is written once
 * because the DANGEROUS mistake in a cache like this is not the lookup, it is the
 * key: a cache whose key omits an axis silently answers one arm's question with
 * another arm's answer, and nothing about the code reads as wrong. Keeping the
 * mechanics in one place leaves the key expressions as the only thing to review.
 */
function memoized<T>(store: Map<string, Promise<T>>, key: string, produce: () => Promise<T>): Promise<T> {
  const cached = store.get(key);
  if (cached) return cached;
  const created = produce();
  store.set(key, created);
  return created;
}

function ensurePackOnce(resolution: TrialPlanResolution, characterId: string): Promise<EnsureIdentityPackResult> {
  return memoized(resolution.packs, characterId, () =>
    ensureIdentityPack({ ownerId: resolution.ownerId, characterId, purpose: "admin_trial", sink: resolution.sink }),
  );
}

function pinnedRevisionOnce(
  resolution: TrialPlanResolution,
  characterId: string,
  revision: number,
): Promise<IdentityPackRevisionForTrialResult> {
  return memoized(resolution.revisions, `${characterId}:${revision}`, () =>
    getIdentityPackRevisionForTrial({
      ownerId: resolution.ownerId,
      characterId,
      revision,
      sink: resolution.sink,
    }),
  );
}

/**
 * The evaluation depends only on the pack a variant resolved and the strategy —
 * the profile policy in force is the v1 defaults for every profile, and no
 * reviewed effective-size fact exists yet (`effectiveReferenceSize` omitted keeps
 * the evaluation conservative) — so it is cached rather than run once per cell.
 *
 * The VARIANT KEY is part of the cache key, and that is load-bearing rather than
 * defensive: two arms of one run may ask the same (character, strategy) question
 * of two different pack revisions, and a cache that could not tell them apart
 * would hand one revision's verdict — its roles, its measurements — to the other
 * and call the result a comparison.
 */
function evaluateCurrentPackOnce(
  resolution: TrialPlanResolution,
  characterId: string,
  strategy: IdentityReferenceStrategy,
): Promise<EvaluateIdentityPackResult> {
  return memoized(resolution.evaluations, `${characterId}:${strategy}:current`, () =>
    evaluateIdentityPackForProfile({
      ownerId: resolution.ownerId,
      characterId,
      strategy,
      purpose: "admin_trial",
      sink: resolution.sink,
    }),
  );
}

/**
 * The SAME eligibility interpretation, run against a pinned historical revision
 * the caller already read.
 *
 * `evaluateIdentityPackContractForProfile` is the render path's own judgment
 * minus the ensure, which is the whole point: a trial-local copy of "may this
 * role be sent?" would drift, and the harness would end up measuring its own
 * rules. `treatRetiredRevisionAsReady` is set because a superseded or stale
 * revision — the OLD side of every old-vs-new comparison — would otherwise walk
 * past the policy projection unjudged.
 */
function evaluatePinnedRevisionOnce(
  resolution: TrialPlanResolution,
  pack: ImageIdentityPackV1,
  strategy: IdentityReferenceStrategy,
  variantKey: string,
): Promise<EvaluateIdentityPackResult> {
  return memoized(resolution.evaluations, `${pack.characterId}:${strategy}:${variantKey}`, () =>
    Promise.resolve(
      evaluateIdentityPackContractForProfile({
        pack,
        strategy,
        treatRetiredRevisionAsReady: true,
        sink: resolution.sink,
      }),
    ),
  );
}

/** The pack columns of a cell's spec — all null on the no-pack baseline. Sliced
 * off the contract rather than restated, so a pack field added there is a type
 * error here until this fills it. */
type TrialSpecPackFields = Pick<
  ImageIdentityPackTrialCellSpec,
  | "packId"
  | "packRevision"
  | "sourceImageId"
  | "sourceContentHash"
  | "cropMethod"
  | "crop"
  | "derivationVersion"
  | "policyVersion"
>;

/** The measurement columns a strategy evaluation fills in. */
type TrialSpecEvaluationFields = Pick<
  ImageIdentityPackTrialCellSpec,
  "effectiveReferenceSize" | "orderedReferenceRoles"
>;

/**
 * What a cell's PACK VARIANT resolves to: the pack identity and the reference
 * plan it supports, or the refusal that stops the cell.
 *
 * A refusal carries whatever pack identity it had already established — `null`
 * only when the refusal landed before any of it did. A partial spec is honest; a
 * spec padded out to parse would be a fabricated pack identity on a cell that
 * never resolved one.
 */
type TrialVariantResolution =
  | { ok: true; pack: TrialSpecPackFields; evaluation: TrialSpecEvaluationFields }
  | {
      ok: false;
      code: ImageIdentityPackTrialRefusalCode;
      message: string;
      pack: TrialSpecPackFields | null;
    };

/**
 * Detector-derived cells are structurally supported but unbuildable until a
 * reviewed detector ships (the null adapter finds nothing, so this only fires for
 * injected or future detectors) — refused, never faked. Spelled once because
 * BOTH pack arms apply it, to whichever revision they resolved: a pinned
 * revision derived by a detector is exactly as unreproducible as a current one.
 */
const DETECTOR_UNAVAILABLE_MESSAGE =
  "detector-derived cells are not runnable until a reviewed face detector ships";

/** The pack identity a resolved revision contributes to a cell's spec. */
function trialSpecPackFields(pack: ImageIdentityPackV1, sourceImageId: string): TrialSpecPackFields {
  return {
    packId: pack.id,
    packRevision: pack.revision,
    sourceImageId,
    sourceContentHash: pack.source.contentHash,
    cropMethod: pack.derivation.method,
    crop: pack.faceDetail.crop,
    derivationVersion: pack.derivation.derivationVersion,
    policyVersion: pack.derivation.policyVersion,
  };
}

/** The measurement half of a cell's spec, from an eligible evaluation. */
function trialSpecEvaluationFields(
  evaluated: Extract<EvaluateIdentityPackResult, { eligible: true }>,
): TrialSpecEvaluationFields {
  const primary = evaluated.candidates[0];
  return {
    effectiveReferenceSize: {
      widthPx: primary?.evaluation.effectiveReferenceWidthPx ?? null,
      heightPx: primary?.evaluation.effectiveReferenceHeightPx ?? null,
      faceWidthPx: primary?.evaluation.effectiveFaceWidthPx ?? null,
      faceHeightPx: primary?.evaluation.effectiveFaceHeightPx ?? null,
    },
    orderedReferenceRoles: evaluated.candidates.map((candidate) => candidate.role),
  };
}

/**
 * Whether a pinned revision has a finished derivation a comparison arm can
 * actually render from.
 *
 * `superseded` and `stale` PASS, and that is the entire point of the axis: the
 * old side of a manual-vs-automatic or old-vs-new comparison is by definition no
 * longer current, and refusing it would leave the variant axis able to express
 * only the arm it was already able to run. Their crop bytes exist and their own
 * source row and content hash are recorded on the revision — `stale` says the
 * CHARACTER's canonical source moved on, not that this revision's bytes did, and
 * execution re-checks that identity before rendering either way.
 *
 * `failed` and `unusable` have no crop to send, and `pending` never finished.
 * Those are refusals, never a fallback to some other revision.
 */
function pinnedRevisionIsRenderable(status: ImageIdentityPackStatus): boolean {
  switch (status) {
    case "ready":
    case "superseded":
    case "stale":
      return true;
    case "pending":
    case "unusable":
    case "failed":
      return false;
  }
}

/**
 * The `current` arm: ensure the character's pack and evaluate the strategy
 * against it. This is the historical single-variant behavior, unchanged — it
 * pins whatever revision is current at planning time, and execution re-ensures
 * and refuses `cell_conflict` if that moved.
 */
async function currentPackVariantResolution(
  resolution: TrialPlanResolution,
  characterId: string,
  strategy: IdentityReferenceStrategy,
): Promise<TrialVariantResolution> {
  const ensured = await ensurePackOnce(resolution, characterId);
  const sourceImageId = ensured.status === "ready" ? ensured.pack.source.imageId : null;
  if (ensured.status !== "ready" || sourceImageId === null) {
    const code = ensured.status === "ready" ? "source_missing" : ensured.code;
    return { ok: false, code: "pack_blocked", message: `identity pack unavailable (${code})`, pack: null };
  }
  const pack = trialSpecPackFields(ensured.pack, sourceImageId);
  if (ensured.pack.derivation.method === "detector") {
    return { ok: false, code: "detector_unavailable", message: DETECTOR_UNAVAILABLE_MESSAGE, pack };
  }
  const evaluated = await evaluateCurrentPackOnce(resolution, characterId, strategy);
  if (!evaluated.eligible) {
    const message = `identity references unavailable for this strategy (${evaluated.messageKey})`;
    return { ok: false, code: "profile_ineligible", message, pack };
  }
  return { ok: true, pack, evaluation: trialSpecEvaluationFields(evaluated) };
}

/**
 * The `rev:…` arm: one NAMED revision, read strictly read-only.
 *
 * It never calls `ensureIdentityPack` and never falls back to the current pack.
 * A pinned arm that quietly resolved against the current revision would render a
 * different comparison under the name of the one that was planned — which is the
 * exact corruption this axis exists to MEASURE, and so is the one thing it must
 * not itself commit. A revision that cannot be read, cannot be rendered from, or
 * that today's policy refuses is `pack_revision_unavailable`; the cell is
 * recorded and nothing is spent.
 */
async function pinnedRevisionVariantResolution(
  resolution: TrialPlanResolution,
  characterId: string,
  revision: number,
  strategy: IdentityReferenceStrategy,
  variantKey: string,
): Promise<TrialVariantResolution> {
  const pinned = await pinnedRevisionOnce(resolution, characterId, revision);
  if (!pinned.ok) {
    const message = `pinned pack revision ${revision} is unavailable (${pinned.code})`;
    return { ok: false, code: "pack_revision_unavailable", message, pack: null };
  }
  const sourceImageId = pinned.pack.source.imageId;
  if (!pinnedRevisionIsRenderable(pinned.pack.status) || sourceImageId === null) {
    const message = `pinned pack revision ${revision} has no usable derivation (${pinned.pack.status})`;
    return { ok: false, code: "pack_revision_unavailable", message, pack: null };
  }
  const pack = trialSpecPackFields(pinned.pack, sourceImageId);
  if (pinned.pack.derivation.method === "detector") {
    return { ok: false, code: "detector_unavailable", message: DETECTOR_UNAVAILABLE_MESSAGE, pack };
  }
  const evaluated = await evaluatePinnedRevisionOnce(resolution, pinned.pack, strategy, variantKey);
  if (!evaluated.eligible) {
    // The same split the current arm makes one step earlier, at its ensure: a
    // code from the PACK's own failure vocabulary means today's policy refuses
    // this revision outright, while `profile_ineligible` means the revision is
    // fine and it is the STRATEGY that cannot be carried from it.
    const code = evaluated.code === "profile_ineligible" ? "profile_ineligible" : "pack_revision_unavailable";
    const message = `pinned pack revision ${revision} cannot carry this strategy (${evaluated.messageKey})`;
    return { ok: false, code, message, pack };
  }
  return { ok: true, pack, evaluation: trialSpecEvaluationFields(evaluated) };
}

/**
 * The `none` arm: the no-pack baseline, which resolves no pack at all.
 *
 * It is expressible only on a GENERATE profile, for two reasons of different
 * weight. Mechanically, an edit profile with zero references has nothing to
 * edit. More importantly, a zero-reference generate IS the reproducible
 * historical behavior this control arm is supposed to represent, whereas an edit
 * lane's historical behavior always involved reference wiring the trial cannot
 * reproduce — so a zero-reference edit cell would be a baseline for a render
 * nobody ever made.
 */
function baselineVariantResolution(profile: ImageModelProfile): TrialVariantResolution {
  if (profile.operation !== "generate") {
    return {
      ok: false,
      code: "profile_ineligible",
      message:
        `the no-pack baseline needs a generate profile; ${profile.key} is an edit profile, ` +
        "whose zero-reference behavior this trial cannot reproduce",
      pack: null,
    };
  }
  return {
    ok: true,
    pack: {
      packId: null,
      packRevision: null,
      sourceImageId: null,
      sourceContentHash: null,
      cropMethod: null,
      crop: null,
      derivationVersion: null,
      policyVersion: null,
    },
    evaluation: {
      // Nothing was measured because nothing was selected — null is "not
      // measured", never zero.
      effectiveReferenceSize: { widthPx: null, heightPx: null, faceWidthPx: null, faceHeightPx: null },
      orderedReferenceRoles: [],
    },
  };
}

/** Dispatch one cell to the arm its variant names. Three genuinely different
 * reads — collapsing any two of them would be a correctness bug, not a tidy-up
 * (the same ruling {@link resolveTrialCellPack} records for execution). */
async function resolveTrialCellVariant(
  resolution: TrialPlanResolution,
  plan: TrialCellPlan,
  profile: ImageModelProfile,
): Promise<TrialVariantResolution> {
  const variant = plan.packVariant;
  if (variant.source === "none") return baselineVariantResolution(profile);

  // Both pack arms need a strategy to evaluate. The planner pairs a null
  // strategy with the `none` variant and nothing else, so this is an invariant
  // guard rather than a reachable product state — spelled out because a `!` here
  // would turn a planner bug into a cell claiming references it never chose.
  const strategy = plan.identityStrategy;
  if (strategy === null) {
    return {
      ok: false,
      code: "profile_ineligible",
      message: "a pack-source cell was planned with no reference strategy",
      pack: null,
    };
  }

  switch (variant.source) {
    case "current":
      return currentPackVariantResolution(resolution, plan.characterId, strategy);
    case "revision":
      // The CELL's character, not the selector's: the planner emits a revision
      // variant only for its own character, and reading under the selector
      // instead would let a mismatch resolve a pack for somebody the cell does
      // not name.
      return pinnedRevisionVariantResolution(
        resolution,
        plan.characterId,
        variant.revision,
        strategy,
        plan.packVariantKey,
      );
  }
}

/**
 * Why this evaluated arm would be a DUPLICATE of a shorter one, or null when it
 * is a real comparison.
 *
 * `identityRolePlan` marks `face_detail` optional in both two-role strategies.
 * A pack whose face crop is unusable therefore evaluates `eligible` for
 * `canonical_then_face_detail` with a warning and a candidate list of just the
 * canonical portrait — which is byte-for-byte what `canonical_only` sends. That
 * is the RIGHT answer for a production render (a slightly weaker likeness beats
 * no image) and the wrong one for a trial: the grid would render the same
 * request twice, pair the two, and report whatever the model did differently
 * between them as an effect of reference ordering.
 *
 * So the trial refuses the cell instead of letting a degenerate arm into the
 * grid — a refusal of the CELL, never a change to the evaluation. Production's
 * interpretation of eligibility is exactly what the harness exists to measure,
 * and editing `identityRolePlan` to suit the harness would make it measure
 * itself. The refusal is also cheap in the right way: it happens at planning, so
 * the arm costs nothing and reads back with its reason attached.
 */
function degenerateArmRefusal(
  strategy: IdentityReferenceStrategy,
  roles: readonly IdentityReferenceRole[],
): string | null {
  const missing = identityRolePlan(strategy)
    .map((entry) => entry.role)
    .filter((role) => !roles.includes(role));
  if (missing.length === 0) return null;
  // Only `face_detail` is ever optional, and a missing REQUIRED role already
  // refused inside the evaluation — so in practice this names the face crop and
  // the surviving arm is `canonical_only`. The general spelling is here so a
  // future role plan cannot make the message quietly untrue.
  const surviving = roles.length === 1 && roles[0] === "canonical_identity" ? "canonical_only" : "a shorter arm";
  return (
    `the ${missing.join(", ").replaceAll("_", "-")} reference is unavailable for this pack; ` +
    `the cell would duplicate ${surviving}`
  );
}

/**
 * Resolve one planned cell to a full spec, or to the refusal that stops it
 * (spec.trial.md §"Trial manifest"). The order is the design's: profile, then
 * the fixture's task, then production offerability, then the version pin, then
 * the pack variant and its strategy evaluation, then capacity — each refusal
 * records everything that DID resolve, so the run report can say how far a cell
 * got.
 *
 * The two eligibility gates before the version pin are what keep the grid from
 * grading renders production could never make:
 *
 * - **Task match.** A profile answers for ONE job. Running a scene profile
 *   against a variant fixture produces an image, and grading it produces a
 *   number, but the number describes a combination the render path would never
 *   resolve — evidence for a render nobody can have.
 * - **Offerability**, through {@link imageProfileOffered} — the same predicate
 *   production selection reads, reused rather than restated. That single call
 *   carries the profile's `enabled` switch, the task's legacy model surface
 *   during the capabilities migration, operation-vs-model support, `edit_kind`,
 *   and the identity ratings that keep an img2img or weak-identity model out of
 *   an identity-critical task. Restating any of them here would let trial
 *   eligibility drift from production eligibility, which is the one thing this
 *   harness cannot afford.
 *
 * Two further gates keep the grid from grading arms that are not comparisons at
 * all, and they sit either side of the pack resolution because that is where
 * their evidence arrives:
 *
 * - **The reference-policy floor**, just before the variant resolves. A profile
 *   whose reviewed policy allows roles but not `identity` would never be handed
 *   an identity reference in production; an empty policy is the unreviewed
 *   default and stays permissive.
 * - **Degenerate arms** ({@link degenerateArmRefusal}), just after the
 *   evaluation. An arm whose optional role was dropped sends exactly what a
 *   shorter strategy sends, and pairing two identical requests measures provider
 *   noise under a strategy's name.
 *
 * The control COMPILE sits between the evaluation and the capacity check, and it
 * is the LAST gate. Running it before the capacity check is what lets a
 * `capacity_exceeded` cell keep a fully parseable spec — the one refusal that has
 * resolved everything and should read back complete.
 *
 * It refuses on exactly one thing: a `promptStrategy` the identity-reference path
 * cannot execute (`text_repair`, `example_transform`, `style_render`,
 * `coherent_set` — see {@link compileProfileRenderPlan}). The refusal is
 * `profile_ineligible` and names the strategy, because that is what it is: a
 * profile configured for a job this harness has no vocabulary for. The check is
 * NOT hoisted up beside the profile-row gates even though the profile row alone
 * answers it — a second copy of "which strategies are executable?" living here
 * would be free to drift from the dispatch that actually compiles them, and the
 * cell would then be planned against a prompt nobody can produce.
 */
async function resolveTrialCell(
  resolution: TrialPlanResolution,
  cellId: string,
  plan: TrialCellPlan,
  fixture: IdentityPackTrialPromptFixture,
): Promise<ResolvedTrialCell> {
  const planFields = {
    id: cellId,
    characterId: plan.characterId,
    task: fixture.task,
    promptFixtureId: plan.promptFixtureId,
    profileId: plan.profileId,
    identityStrategy: plan.identityStrategy,
    packVariantKey: plan.packVariantKey,
    // Derived from the variant rather than assumed: `none` is the one arm that
    // sends nothing, and the spec contract's cross-field rules key off exactly
    // this value.
    referenceSource: plan.packVariant.source === "none" ? ("none" as const) : ("pack" as const),
    // No seed transport exists anywhere in the render path yet, so every cell
    // records the honest null rather than a number nothing would send.
    requestedSeed: null,
  };

  const profile = resolution.profilesById.get(plan.profileId);
  const model = profile ? resolution.modelsById.get(profile.imageModelId) : undefined;
  if (!profile || !model) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `profile ${plan.profileId} is not a runnable registry profile`,
      spec: planFields,
    };
  }
  const profileFields = { modelSlug: model.slug, profileKey: profile.key };

  if (profile.task !== fixture.task) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `profile task ${profile.task} cannot run a ${fixture.task} fixture`,
      spec: { ...planFields, ...profileFields },
    };
  }

  const offered = imageProfileOffered(profile, model);
  if (!offered.ok) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `profile ${profile.key} is not offered on ${model.slug} (${offered.reason})`,
      spec: { ...planFields, ...profileFields },
    };
  }

  // A controlled comparison must know EXACTLY which provider version produced
  // its evidence. Production is happy to follow a model's floating latest; a
  // trial that did would be comparing whatever Replicate shipped that hour, and
  // the execute-time re-check would have nothing real to compare against.
  const modelVersion = pinnedImageModelVersion(model);
  if (modelVersion === null) {
    return {
      status: "refused",
      code: "version_unpinned",
      message: `${model.slug} has no probed or slug-pinned provider version, so a controlled trial cannot pin it`,
      spec: { ...planFields, ...profileFields },
    };
  }
  const versionFields = { modelVersion };

  // The reference-policy floor, and the LAST gate that can be answered from the
  // profile row alone. A profile whose reviewed policy names allowed roles and
  // omits `identity` is one production would never hand an identity reference
  // to, so a trial cell that sent one would be grading a configuration the
  // render path cannot produce. An EMPTY `allowedRoles` is the seeded default —
  // "nobody has reviewed a policy for this profile yet" — and stays permissive,
  // because reading "nothing recorded" as "nothing allowed" would refuse all 17
  // seeded profiles and empty the grid. The no-pack baseline sends no references
  // at all and is untouched either way.
  if (planFields.referenceSource === "pack") {
    const allowedRoles = profile.referencePolicy.allowedRoles;
    if (allowedRoles.length > 0 && !allowedRoles.includes("identity")) {
      return {
        status: "refused",
        code: "profile_ineligible",
        message: `the profile's reference policy does not allow identity references (allows ${allowedRoles.join(", ")})`,
        spec: { ...planFields, ...profileFields, ...versionFields },
      };
    }
  }

  const variant = await resolveTrialCellVariant(resolution, plan, profile);
  if (!variant.ok) {
    return {
      status: "refused",
      code: variant.code,
      message: variant.message,
      spec: { ...planFields, ...profileFields, ...versionFields, ...(variant.pack ?? {}) },
    };
  }
  const roles = variant.evaluation.orderedReferenceRoles;

  // The evaluation is production's, and production's answer to a missing
  // OPTIONAL role is "render anyway with a warning" — right for a portrait, and
  // a fabricated experiment for a grid. See {@link degenerateArmRefusal}.
  const degenerate = plan.identityStrategy === null ? null : degenerateArmRefusal(plan.identityStrategy, roles);
  if (degenerate !== null) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: degenerate,
      spec: { ...planFields, ...profileFields, ...versionFields, ...variant.pack, ...variant.evaluation },
    };
  }

  // Compile what this cell WOULD send, with the roles now known: the profile's
  // prompt strategy applied to the fixture text (numbered role bindings and
  // model dialect included), the negative that survives to a real provider
  // field, and the resolved control payload with every drop recorded. These are
  // the facts the execute-time re-check recomputes — the planner and the
  // executor call the same compiler, so a mismatch means the world moved, never
  // that the two disagreed. The baseline compiles with an EMPTY role list, which
  // is what leaves its prompt as the fixture wrote it: the control arm must not
  // differ from the pack arms by any text the harness itself added.
  const compiled = compileProfileRenderPlan({
    model,
    profile,
    basePrompt: fixture.prompt,
    baseNegativePrompt: fixture.negativePrompt,
    referenceRoles: roles,
  });
  if (!compiled.ok) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `prompt strategy ${compiled.promptStrategy} is not executable by the identity trial`,
      spec: { ...planFields, ...profileFields, ...versionFields, ...variant.pack, ...variant.evaluation },
    };
  }
  const renderPlan = compiled.plan;
  const controlFields = {
    ...trialCellCompiledIdentity(renderPlan, profile, roles),
    resolvedControls: renderPlan.resolvedControls,
  };

  const capacity = referenceCapacity(model);
  if (roles.length > capacity.max) {
    return {
      status: "refused",
      code: "capacity_exceeded",
      message: `${roles.length} reference(s) exceed ${model.slug}'s capacity of ${capacity.max}`,
      spec: {
        ...planFields,
        ...profileFields,
        ...versionFields,
        ...variant.pack,
        ...variant.evaluation,
        ...controlFields,
      },
    };
  }

  const spec: ImageIdentityPackTrialCellSpec = {
    ...planFields,
    ...profileFields,
    ...versionFields,
    ...variant.pack,
    ...variant.evaluation,
    ...controlFields,
  };
  return { status: "planned", spec };
}

/**
 * Plan a run: expand the grid, resolve every cell, and persist the run with its
 * cells — eligible ones `planned`, blocked ones `refused` with the code that
 * stopped them (spending nothing). Whole-run refusals — an unknown corpus, an
 * unknown fixture, a revision selector naming a character outside the run, a grid
 * over `TRIAL_MAX_CELLS` — create no rows at all: they are configuration errors,
 * not outcomes worth recording.
 *
 * An unowned character is NOT a whole-run refusal: its cells resolve exactly
 * like a character that does not exist (`pack_blocked` over `source_missing`,
 * the batch surface's deliberate not-yours ≡ gone indistinguishability).
 */
export async function createIdentityPackTrialRun(
  input: CreateIdentityPackTrialRunInput,
): Promise<CreateIdentityPackTrialRunResult> {
  const { ownerId, request, sink } = input;

  let characterIds: readonly string[];
  if (request.corpusId !== undefined) {
    const corpus = IDENTITY_PACK_TRIAL_CORPORA.get(request.corpusId);
    if (!corpus) {
      return {
        ok: false,
        refusal: refusal("unknown_corpus", `no checked-in trial corpus named "${request.corpusId}"`, sink, {
          corpusId: request.corpusId,
        }),
      };
    }
    characterIds = corpus;
  } else {
    characterIds = request.characterIds ?? [];
  }

  const fixturesById = new Map<string, IdentityPackTrialPromptFixture>();
  for (const fixtureId of request.promptFixtureIds) {
    const fixture = trialPromptFixtureById(fixtureId);
    if (!fixture) {
      return {
        ok: false,
        refusal: refusal("fixture_unknown", `no checked-in prompt fixture named "${fixtureId}"`, sink, { fixtureId }),
      };
    }
    fixturesById.set(fixtureId, fixture);
  }

  // A revision selector is CHARACTER-SCOPED, so one naming a character this run
  // does not include produces no cells at all — the planner would drop it in
  // silence and the reviewer would believe an arm ran that never existed. That is
  // a configuration error like an unknown corpus or fixture, not an outcome worth
  // recording, so it refuses the whole run and creates no rows.
  for (const selector of request.packVariants ?? []) {
    if (selector.source !== "revision" || characterIds.includes(selector.characterId)) continue;
    return {
      ok: false,
      refusal: refusal(
        "pack_revision_unavailable",
        "a revision selector names a character this run does not include",
        sink,
        { characterId: selector.characterId, revision: selector.revision },
      ),
    };
  }

  const planned = buildTrialCellPlans({
    characterIds,
    profileIds: request.profileIds,
    strategies: request.strategies,
    promptFixtureIds: request.promptFixtureIds,
    packVariants: request.packVariants,
  });
  if (!planned.ok) {
    return {
      ok: false,
      refusal: refusal(
        "too_many_cells",
        `${planned.requestedCells} cells exceed the ${planned.maximumCells} allowed in one run`,
        sink,
        { requestedCells: planned.requestedCells },
      ),
    };
  }

  const [profiles, models] = await Promise.all([loadImageModelProfiles(sink), loadImageModels(sink)]);
  const resolution: TrialPlanResolution = {
    ownerId,
    profilesById: new Map(profiles.map((profile) => [profile.id, profile])),
    modelsById: new Map(models.map((model) => [model.id, model])),
    packs: new Map(),
    revisions: new Map(),
    evaluations: new Map(),
    sink,
  };

  const counts = zeroTrialCellCounts();
  const cellValues: (typeof imageIdentityPackTrialCells.$inferInsert)[] = [];
  const runId = newId();
  for (const plan of planned.plans) {
    const fixture = fixturesById.get(plan.promptFixtureId);
    if (!fixture) continue; // unreachable: every fixture id was resolved above
    const cellId = newId();
    const resolved = await resolveTrialCell(resolution, cellId, plan, fixture);
    counts[resolved.status] += 1;
    if (resolved.status === "planned") {
      cellValues.push({ id: cellId, runId, cellKey: plan.cellKey, status: "planned", specJson: resolved.spec });
      continue;
    }
    sink?.push(
      diag("warn", imageIdentityPackTrialDiagnosticCode(resolved.code), resolved.message, {
        context: { runId, cellKey: plan.cellKey },
      }),
    );
    cellValues.push({
      id: cellId,
      runId,
      cellKey: plan.cellKey,
      status: "refused",
      specJson: resolved.spec,
      resultJson: trialResult({ failureCode: resolved.code, failureMessage: resolved.message.slice(0, 2000) }),
    });
  }

  // A run with nothing plannable is born in `review`, not `draft`: nothing will
  // ever execute (the Execute affordance hides at planned = 0, and the
  // draft→review settle only fires on execute), so `draft` would wedge it
  // forever. `review` is the honest position — its refused cells are its whole
  // record — and the vacuous-completion rule keeps it from claiming `complete`.
  //
  // Both inserts go in ONE transaction: a run row is a claim about a grid, and a
  // crash between the two writes left a draft run with zero cells — permanently
  // wedged (nothing to execute, so nothing ever settles it) and indistinguishable
  // from a run whose cells were all deleted. Either the whole grid exists or the
  // run does not.
  await db().transaction(async (tx) => {
    await tx
      .insert(imageIdentityPackTrialRuns)
      .values({
        id: runId,
        ownerId,
        label: request.label,
        status: counts.planned === 0 ? "review" : "draft",
        configJson: request,
      });
    if (cellValues.length > 0) await tx.insert(imageIdentityPackTrialCells).values(cellValues);
  });

  return { ok: true, runId, counts };
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
 * Execution                                                                 *
 * ------------------------------------------------------------------------ */

/** Default and ceiling for one execute pass — the wire schema's numbers. */
const EXECUTE_DEFAULT_MAX_RENDERS = 5;
const EXECUTE_MAX_RENDERS_CAP = 20;

/**
 * The two render-path diagnostics that mean "the provider did not receive what
 * this cell compiled". Spelled here so the watches in
 * {@link executeOneTrialCell} cannot drift from the codes the transport emits.
 *
 * - `image_model.references_trimmed` — a reference was dropped against
 *   `runRegistryImageModel`'s `data_url` inline-byte budget.
 * - `image_model.reserved_field_ignored` — a control field collided with one the
 *   render path owns and was discarded by `overlayControlInput`. The compile step
 *   filters those out beforehand, so reaching this means the two disagreed —
 *   which is exactly when a cell must not be trusted.
 */
const REFERENCES_TRIMMED_DIAGNOSTIC = "image_model.references_trimmed";
const RESERVED_FIELD_IGNORED_DIAGNOSTIC = "image_model.reserved_field_ignored";

/**
 * How long a claim may sit before a later pass may take it back.
 *
 * It must EXCEED the longest ONE CELL SPAN can legitimately take — a render plus
 * its settle — and NOT the longest a queued cell can wait, because
 * {@link beatTrialQueueClaims} re-stamps `claimed_at` on the pass's WHOLE
 * REMAINING QUEUE at every cell boundary. A queued claim is therefore never
 * older than the cell currently in flight, whatever its position in a 20-cell
 * batch; without that heartbeat this window would have to cover an entire batch,
 * and a 20-render pass would age its own tail claims into recovery while they
 * queued — while it was still alive, still rendering, and about to pay for them.
 *
 * Derived rather than guessed, from the four things that actually elapse:
 *
 *     900_000  the prediction budget ceiling (MAX_TRIAL_PREDICTION_MS, itself
 *              `imageModelProfileSchema.timeoutMs`'s `.max(900_000)` bound, and
 *              what Replicate's own `Cancel-After` carries)
 *   + 300_000  4 × REQUEST_TIMEOUT_MS — three reference uploads plus the poll GET
 *              that observes the settled prediction
 *   +  60_000  OUTPUT_TIMEOUT_MS — downloading the produced image
 *   + 300_000  margin for the rest of one cell span — storing the output, the
 *              settle write, the next cell's pack resolution and reference
 *              reads — plus retries and clock skew between two machines
 *   ---------
 *   1_560_000  (26 minutes)
 *
 * Recovering too early hands a live render to a second worker and pays twice;
 * never recovering wedges a run short of `review` forever. Sizing it off the
 * real bounds is what keeps that trade an engineering decision rather than a
 * number that silently stopped covering the thing it was chosen for.
 */
export const STALE_CLAIM_MS = MAX_TRIAL_PREDICTION_MS + 4 * REQUEST_TIMEOUT_MS + OUTPUT_TIMEOUT_MS + 5 * 60_000;

/**
 * Exactly what the profile compiled, handed to the renderer.
 *
 * This seam is the PROOF SURFACE for "the trial renders the profile it says it
 * renders": an integration test captures this object and compares it against the
 * cell's stored `resolvedControls`. Anything the provider receives that is not
 * visible here is something the harness cannot prove it sent.
 */
export interface TrialCellRenderInput {
  /** The EFFECTIVE model — post reviewed-quality seam, as the provider sees it. */
  model: ImageModel;
  /** The final compiled text, role preamble included. Hashed as `positivePromptHash`. */
  prompt: string;
  references: Buffer[];
  /** Mapped controls plus validated overrides, keyed by real provider fields. */
  controlInput: Record<string, unknown>;
  /**
   * The resolved prediction budget — a NUMBER, always. A trial cell never leaves
   * its deadline to `REPLICATE_PREDICTION_TIMEOUT_MS`: an env-resolved budget is
   * one the cell cannot record, cannot hash, and cannot bound, and the
   * stale-claim window above is sized against this being a real ceiling.
   */
  timeoutMs: number;
  /** The pinned provider version this cell must execute. */
  versionId: string | null;
}

export type TrialCellRenderer = (
  input: TrialCellRenderInput,
  sink?: DiagnosticSink,
) => Promise<RenderWithModelResult>;

/** Test-only override; `null` restores the real registry render. Process-local —
 * the `setIdentityFaceDetectorForTesting` seam shape, for the same reason:
 * integration tests must drive every outcome without a provider call. */
let injectedRenderer: TrialCellRenderer | null = null;

export function setTrialRendererForTesting(renderer: TrialCellRenderer | null): void {
  injectedRenderer = renderer;
}

/**
 * The real renderer maps the compiled plan straight onto `renderWithModel` —
 * field for field, no interpretation. That is deliberate: the moment this seam
 * starts deciding anything, the captured input stops being evidence of what the
 * provider was sent.
 */
function trialRenderer(): TrialCellRenderer {
  return (
    injectedRenderer ??
    ((input, sink) =>
      renderWithModel(
        {
          model: input.model,
          prompt: input.prompt,
          references: input.references,
          controlInput: input.controlInput,
          timeoutMs: input.timeoutMs,
          versionId: input.versionId,
        },
        sink,
      ))
  );
}

export interface ExecuteIdentityPackTrialCellsInput<TReject> {
  runId: string;
  ownerId: string;
  /** Clamped to the wire schema's 1–20; defaults to 5. */
  maxRenders?: number;
  /**
   * Charge the daily render budget for exactly `count` cells; `null` means the
   * charge succeeded. Called INSIDE the run lock, after this pass has picked
   * its planned cells and can no longer be refused `run_locked` — so a refused
   * pass never leaves charged units behind. Never called with 0. A non-null
   * rejection is returned to the caller uninterpreted (`budgetRejected`); the
   * route's rejection is already the house 429/503 response.
   */
  chargeBudget: (count: number) => Promise<TReject | null>;
  sink?: DiagnosticSink;
}

export interface ExecutedTrialCell {
  cellId: string;
  cellKey: string;
  status: "rendered" | "failed" | "refused" | "skipped";
}

export type ExecuteIdentityPackTrialCellsResult<TReject> =
  | { ok: true; executed: ExecutedTrialCell[]; remainingPlanned: number; runStatus: TrialRunStatus }
  | { ok: false; refusal: IdentityPackTrialRefusal }
  | { ok: false; budgetRejected: TReject };

/**
 * Run up to `maxRenders` planned cells.
 *
 * TWO layers guard against paying twice for one cell's evidence, and they guard
 * different things:
 *
 * - The keyed lock is the SAME-PROCESS double-click guard. A second caller meets
 *   `run_locked` instead of queueing, because a second click while a pass is
 *   rendering means the operator cannot see the first pass yet, and stacking
 *   passes would spend budget nobody asked for. It is in-memory and dies with
 *   the process, which is exactly why it is not the correctness layer.
 * - The DURABLE CLAIM inside the pass is the cross-process one. Cells move to
 *   `running` with a token in the database BEFORE the provider is called, so a
 *   second machine — or this machine after a restart — sees the claim rather
 *   than a `planned` cell it is free to re-render. The claim is taken for the
 *   whole batch at once and RE-ASSERTED over the whole remaining queue at every
 *   cell boundary, which is what keeps a lost race free (no provider call) and
 *   keeps a queued cell from aging past the stale window while cells ahead of it
 *   render — the claims of a LIVE pass are never older than its current cell.
 *
 * Null when the run is not this owner's.
 *
 * Cells settle in `cellKey` order — deterministic, so "run 5 more" walks the
 * grid the same way every time, and comparison-group-adjacent, because that key
 * layout puts one comparison's arms next to each other. A `failed` cell stays
 * failed: a rerun is a new run, never a silent retry of a cell whose evidence
 * already exists.
 */
export async function executeIdentityPackTrialCells<TReject>(
  input: ExecuteIdentityPackTrialCellsInput<TReject>,
): Promise<ExecuteIdentityPackTrialCellsResult<TReject> | null> {
  const { runId, ownerId, sink } = input;
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;

  const held = tryKeyedLock(identityPackTrialLockKey(runId), () => runTrialExecutionPass(input), "trial_execute");
  if (held === null) {
    return {
      ok: false,
      refusal: refusal("run_locked", "another execution pass holds this run", sink, { runId }),
    };
  }
  return held;
}

/**
 * The post-lock pass, exposed so a test can race TWO of them against one run.
 *
 * Production always enters through {@link executeIdentityPackTrialCells}; this
 * door exists because the in-process lock would serialize the very contention
 * the durable claim exists to survive, and a concurrency guarantee nothing can
 * exercise is a guarantee nobody knows is broken.
 */
export function runTrialExecutionPassForTesting<TReject>(
  input: ExecuteIdentityPackTrialCellsInput<TReject>,
): Promise<ExecuteIdentityPackTrialCellsResult<TReject> | null> {
  return runTrialExecutionPass(input);
}

async function runTrialExecutionPass<TReject>(
  input: ExecuteIdentityPackTrialCellsInput<TReject>,
): Promise<ExecuteIdentityPackTrialCellsResult<TReject> | null> {
  const { runId, ownerId, sink } = input;
  // Re-read under the lock: the pre-lock row may predate another pass's settle.
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const maxRenders = Math.min(
    Math.max(1, Math.floor(input.maxRenders ?? EXECUTE_DEFAULT_MAX_RENDERS)),
    EXECUTE_MAX_RENDERS_CAP,
  );

  await recoverStaleTrialClaims(runId, sink);

  // Comparison-group-adjacent by construction: `cellKey` is
  // `character:profile:fixture:strategy:variant`, so plain ascending order runs
  // every arm of one comparison back to back. Nothing seeds the provider, so
  // renders drift with whatever the model was doing between them; adjacency is
  // the only lever the harness has to keep that drift SHARED by a group rather
  // than becoming the difference being measured.
  const picked = await db()
    .select({ id: imageIdentityPackTrialCells.id })
    .from(imageIdentityPackTrialCells)
    .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "planned")))
    .orderBy(asc(imageIdentityPackTrialCells.cellKey))
    .limit(maxRenders);

  const claimToken = newId();
  const claimed: IdentityPackTrialCellRow[] =
    picked.length === 0 ? [] : await claimTrialCells(runId, picked.map((row) => row.id), claimToken);
  // Re-sorted after the claim: `UPDATE … RETURNING` hands rows back in whatever
  // order it touched them, and the group adjacency the key layout buys is worth
  // nothing if the execution loop then walks the claims in storage order.
  claimed.sort((a, b) => compareTrialCellKeys(a.cellKey, b.cellKey));

  const [models, profiles] = await Promise.all([loadImageModels(sink), loadImageModelProfiles(sink)]);
  const context: ExecuteCellContext = {
    runId,
    ownerId,
    claimToken,
    modelsBySlug: new Map(models.map((model) => [model.slug, model])),
    profilesById: new Map(profiles.map((profile) => [profile.id, profile])),
    render: trialRenderer(),
    sink,
  };

  // A row this pass picked but did not claim was taken by another machine
  // between the select and the update. That is the durable claim working, not an
  // error: proceed with what this pass actually holds.
  //
  // Every claimed cell is settled or admitted HERE, before the charge, and both
  // gates are free. A malformed spec is one; a spec that parses but names a
  // fixture, model or profile that no longer exists is the other, and it is the
  // registry maps loaded just above that make it answerable this early. A cell
  // that cannot reach a provider must never be billed for the attempt — the
  // post-charge re-checks in `executeOneTrialCell` still run, because a row can
  // vanish between these two moments, but a run left stale by a deleted profile
  // no longer burns a budget unit per cell per pass to rediscover it.
  const executed: ExecutedTrialCell[] = [];
  const valid: ClaimedTrialCell[] = [];
  for (const cell of claimed) {
    const read = readRunnableTrialSpec(cell, context);
    if (read.ok) {
      valid.push({ cell, spec: read.spec });
      continue;
    }
    const status = await refuseTrialCell(cell, context, read.code, read.message);
    executed.push({ cellId: cell.id, cellKey: cell.cellKey, status });
  }

  // Charge for exactly the cells this pass will attempt, and only once they are
  // claimed: a pass with nothing to run costs nothing (reviewing a finished grid
  // must keep working after the daily budget is spent), and an unrunnable cell —
  // settled terminally above, never sent anywhere — is never billed. Charged
  // slots are a reservation: a cell that then conflicts or fails mid-batch does
  // not refund its unit, deliberately, because the pass was admitted at this size.
  if (valid.length > 0) {
    const claimedIds = valid.map((entry) => entry.cell.id);
    let rejected: TReject | null;
    try {
      rejected = await input.chargeBudget(claimedIds.length);
    } catch (error) {
      // A guard that THREW decided nothing, and its claims are as unspent as a
      // refusal's. Leaving them `running` would wedge the grid for the whole
      // stale window over a fault that never touched a provider, so they go back
      // before the throw continues to the caller.
      await releaseTrialClaims(claimedIds, claimToken);
      throw error;
    }
    if (rejected !== null) {
      // Hand the claims back immediately. A refused pass that left its cells
      // `running` would wedge them until the stale window elapsed, turning a
      // budget refusal into half an hour of a frozen grid.
      await releaseTrialClaims(claimedIds, claimToken);
      sink?.push(
        diag("warn", imageIdentityPackTrialDiagnosticCode("budget_refused"), "the render budget refused this pass", {
          context: { runId, cells: claimedIds.length },
        }),
      );
      return { ok: false, budgetRejected: rejected };
    }
  }

  // The execution queue, drained head-first with a WHOLE-QUEUE heartbeat at
  // every cell boundary ({@link beatTrialQueueClaims}). The queue is a mutable
  // list rather than an index walk because the heartbeat can remove entries: a
  // cell whose claim was taken over while it waited is dropped here and settled
  // by nobody, since another worker now owns it.
  let queue = valid;
  while (queue.length > 0) {
    const held = await beatTrialQueueClaims(queue, context);
    const holding: ClaimedTrialCell[] = [];
    for (const entry of queue) {
      if (held.has(entry.cell.id)) {
        holding.push(entry);
        continue;
      }
      // Zero provider calls for it, and no settle either — the row belongs to
      // whoever took it, and writing an outcome onto it would overwrite theirs.
      executed.push({ cellId: entry.cell.id, cellKey: entry.cell.cellKey, status: "skipped" });
    }
    queue = holding;
    const head = queue.shift();
    // Even the head lost its claim, so this pass holds nothing at all.
    if (head === undefined) break;

    const status = await executeTrialCellContained(head.cell, head.spec, context);
    if (status === null) {
      // The containment settle itself failed, so this pass stops. The cells it
      // has not REACHED were charged but never sent anywhere, and returning an
      // untouched claim costs nothing — so they go back to `planned` rather than
      // waiting out the stale window. Their charge stays spent: a charged slot is
      // a reservation for a pass admitted at that size, exactly as for a cell that
      // conflicted mid-batch.
      await releaseTrialClaims(queue.map((remaining) => remaining.cell.id), claimToken);
      break;
    }
    executed.push({ cellId: head.cell.id, cellKey: head.cell.cellKey, status });
  }

  const runStatus = await settleTrialRunStatus(runId, run.status, true, sink);
  const [remaining] = await db()
    .select({ planned: count() })
    .from(imageIdentityPackTrialCells)
    .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "planned")));
  return { ok: true, executed, remainingPlanned: remaining?.planned ?? 0, runStatus };
}

/** A cell this pass holds, with its spec already parsed once at the boundary. */
interface ClaimedTrialCell {
  cell: IdentityPackTrialCellRow;
  spec: ImageIdentityPackTrialCellSpec;
}

/**
 * Take the picked cells by compare-and-set from `planned` to `running`, stamping
 * this pass's token and the clock.
 *
 * The returned rows are the ones this pass owns — fewer than were picked means
 * another writer won those, which is the whole point. Nothing is rendered before
 * this write lands, so a crash between claim and provider call costs a cell's
 * evidence but never a double charge.
 *
 * The clock stamped here dates the CLAIM, and it is the only stamp a cell would
 * ever carry if nothing re-stamped it — which is why {@link beatTrialQueueClaims}
 * re-stamps the pass's whole remaining queue at every cell boundary. A batch's
 * last cell may sit here for the length of nineteen renders, and none of that
 * waiting is evidence the worker died.
 */
async function claimTrialCells(
  runId: string,
  cellIds: readonly string[],
  claimToken: string,
): Promise<IdentityPackTrialCellRow[]> {
  return db()
    .update(imageIdentityPackTrialCells)
    .set({ status: "running", claimToken, claimedAt: new Date() })
    .where(
      and(
        eq(imageIdentityPackTrialCells.runId, runId),
        inArray(imageIdentityPackTrialCells.id, [...cellIds]),
        eq(imageIdentityPackTrialCells.status, "planned"),
      ),
    )
    .returning();
}

/**
 * Hand claims back to `planned`, token-guarded so a pass can only release its
 * OWN.
 *
 * Every caller shares one precondition: the cells being released were NEVER
 * SENT ANYWHERE. That is what makes returning them free of the double-pay risk
 * recovery carries — there is no in-flight render to collide with. Three cases
 * qualify: a budget guard that refused, a budget guard that threw, and the cells
 * a pass never reached because its containment settle failed. A cell whose
 * provider call has begun is never released; it settles, or it goes stale.
 */
async function releaseTrialClaims(cellIds: readonly string[], claimToken: string): Promise<void> {
  if (cellIds.length === 0) return;
  await db()
    .update(imageIdentityPackTrialCells)
    .set({ status: "planned", claimToken: null, claimedAt: null })
    .where(
      and(
        inArray(imageIdentityPackTrialCells.id, [...cellIds]),
        eq(imageIdentityPackTrialCells.status, "running"),
        eq(imageIdentityPackTrialCells.claimToken, claimToken),
      ),
    );
}

/**
 * Re-stamp this pass's claim on the WHOLE REMAINING QUEUE — the cell about to
 * render and every cell still waiting behind it — and report which ids the pass
 * still holds.
 *
 * Called at every cell boundary, and that scope is the correctness property.
 * The pass claims and charges its whole batch up front, so a per-cell heartbeat
 * left cell 10's `claimed_at` dated at batch start while cells 1–9 rendered: it
 * could age past {@link STALE_CLAIM_MS} purely by QUEUE POSITION, be recovered by
 * another worker, and be paid for twice while this pass was perfectly alive. With
 * the queue-wide beat, a queued claim's age is bounded by ONE cell span (the
 * previous render plus its settle), which the stale window already exceeds with
 * margin — so staleness measures pass DEATH, never queue depth.
 *
 * Two further jobs, both about money:
 *
 * - **The head cell must be in the returned set to render.** The compare-and-set
 *   is the same one every settle uses, so a claim already taken over costs ZERO
 *   provider calls instead of one paid render whose settle then loses and has to
 *   delete the image it just bought. Only the head's own pre-render reads — its
 *   pack resolution and reference bytes — separate this beat from the spend, and
 *   a claim lost inside that gap is caught at the settle as it always was.
 * - **A queued cell that lost its claim is dropped, not settled.** Another worker
 *   owns that row now; writing an outcome onto it would overwrite theirs.
 *
 * Every cell whose claim is gone gets its own warn, because a live pass losing
 * claims is either a second worker racing it or a stale recovery that fired too
 * early — both worth seeing.
 */
async function beatTrialQueueClaims(
  queue: readonly ClaimedTrialCell[],
  context: ExecuteCellContext,
): Promise<Set<string>> {
  const beat = await db()
    .update(imageIdentityPackTrialCells)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(imageIdentityPackTrialCells.runId, context.runId),
        inArray(imageIdentityPackTrialCells.id, queue.map((entry) => entry.cell.id)),
        eq(imageIdentityPackTrialCells.status, "running"),
        eq(imageIdentityPackTrialCells.claimToken, context.claimToken),
      ),
    )
    .returning({ id: imageIdentityPackTrialCells.id });
  const held = new Set(beat.map((row) => row.id));
  for (const entry of queue) {
    if (held.has(entry.cell.id)) continue;
    context.sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "the claim was taken over before the render started", {
        context: { runId: context.runId, cellId: entry.cell.id, cellKey: entry.cell.cellKey },
      }),
    );
  }
  return held;
}

/**
 * Return claims abandoned by a dead worker to the grid.
 *
 * The trade this makes is real and worth stating: a claim older than
 * {@link STALE_CLAIM_MS} MIGHT belong to a render that was paid for and whose
 * result was lost with the process that started it. Recovering it can therefore
 * pay a second time. The alternative is worse — a cell stuck `running` forever
 * wedges its run short of `review` and can never be graded or ruled on — so
 * recovery happens, on a clock long enough that no live render can be inside it,
 * and loudly enough that an operator sees it happened.
 *
 * `claimed_at` is a HEARTBEAT, not a queue timestamp: {@link beatTrialQueueClaims}
 * re-stamps it on the owning pass's WHOLE REMAINING QUEUE at every cell boundary,
 * so what this cutoff measures is "how long has the pass holding this cell been
 * silent", not "how long since that pass started". That distinction is what lets
 * the window be sized against one cell span (see {@link STALE_CLAIM_MS}) instead
 * of against a full 20-cell batch, and it is why a cell waiting its turn behind
 * nineteen others cannot age itself into recovery while the pass holding it is
 * perfectly alive.
 *
 * A `running` row with NO `claimed_at` is deliberately not recovered: it records
 * a claim nothing can date, and resetting an undateable claim on sight is
 * exactly the double-pay these columns exist to prevent.
 */
async function recoverStaleTrialClaims(runId: string, sink: DiagnosticSink | undefined): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  const recovered = await db()
    .update(imageIdentityPackTrialCells)
    .set({ status: "planned", claimToken: null, claimedAt: null })
    .where(
      and(
        eq(imageIdentityPackTrialCells.runId, runId),
        eq(imageIdentityPackTrialCells.status, "running"),
        lt(imageIdentityPackTrialCells.claimedAt, cutoff),
      ),
    )
    .returning({ cellKey: imageIdentityPackTrialCells.cellKey });
  if (recovered.length === 0) return;
  sink?.push(
    diag("warn", "images.identity_pack.trial.claim_recovered", "recovered execution claims left behind by a dead pass", {
      context: { runId, cells: recovered.length, cellKeys: recovered.map((row) => row.cellKey).slice(0, 10) },
    }),
  );
}

type ClaimedTrialSpecRead =
  | { ok: true; spec: ImageIdentityPackTrialCellSpec }
  | { ok: false; code: ImageIdentityPackTrialRefusalCode; message: string };

/**
 * One claimed cell's spec, or the terminal refusal it earns.
 *
 * Two distinct corruptions, two codes, both TERMINAL and both FREE:
 *
 * - A spec that does not parse is `spec_invalid`. Nothing can say what this cell
 *   was supposed to render, and a cell nothing can describe cannot be executed
 *   honestly.
 * - A spec that parses but carries `resolvedControls: null` is `cell_conflict`.
 *   It was planned before anything could compile what it would send, so running
 *   it now would put an uncompiled cell in a grid of compiled ones — not a
 *   comparison, a confound.
 *
 * Settling rather than skipping is the point, and the reason this read happens
 * BEFORE the budget charge. A malformed cell left `planned` is re-picked by
 * every later pass forever, and each of those passes charged for it before ever
 * discovering it could not run. Now it is charged never and settles exactly once.
 */
function readClaimedTrialSpec(cell: IdentityPackTrialCellRow): ClaimedTrialSpecRead {
  const parsed = imageIdentityPackTrialCellSpecSchema.safeParse(cell.specJson);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      code: "spec_invalid",
      message: `the cell's stored spec no longer satisfies the manifest contract (${detail})`.slice(0, 500),
    };
  }
  if (parsed.data.resolvedControls === null) {
    return {
      ok: false,
      code: "cell_conflict",
      message: "the cell was planned before its controls were compiled, so nothing can say what it would send",
    };
  }
  return { ok: true, spec: parsed.data };
}

/**
 * One claimed cell's spec AND whether anything it names still exists — the whole
 * pre-charge judgment, in the one shape the loop settles on.
 *
 * The composition matters more than either half. `readClaimedTrialSpec` catches
 * a spec nothing can read; {@link unreachableClaimedTrialCell} catches a spec
 * that reads perfectly and names a fixture, model or profile that is gone. Both
 * are cells no provider will ever see, and both used to be discovered AFTER the
 * budget charge — so a run whose profile an admin deleted paid a unit per cell
 * per pass to keep rediscovering it.
 */
function readRunnableTrialSpec(cell: IdentityPackTrialCellRow, context: ExecuteCellContext): ClaimedTrialSpecRead {
  const read = readClaimedTrialSpec(cell);
  if (!read.ok) return read;
  const unreachable = unreachableClaimedTrialCell(read.spec, context);
  return unreachable === null ? read : { ok: false, ...unreachable };
}

/**
 * Why this cell could never reach a provider, or null when it can.
 *
 * The three lookups are exactly the ones {@link executeOneTrialCell} performs
 * after the charge, asked here against the SAME maps that pass already loaded.
 * The post-charge copies stay — a registry row can be deleted between these two
 * moments, and the executor must still refuse rather than dereference nothing —
 * so this is a cheaper first answer to the same question, never a replacement
 * for it. The codes and messages match their post-charge counterparts on
 * purpose: an operator reading a refused cell should not be able to tell which
 * of the two noticed.
 */
function unreachableClaimedTrialCell(
  spec: ImageIdentityPackTrialCellSpec,
  context: ExecuteCellContext,
): { code: ImageIdentityPackTrialRefusalCode; message: string } | null {
  if (!trialPromptFixtureById(spec.promptFixtureId)) {
    return { code: "fixture_unknown", message: "the cell's prompt fixture is no longer checked in" };
  }
  if (!context.modelsBySlug.has(spec.modelSlug) || !context.profilesById.has(spec.profileId)) {
    return { code: "cell_conflict", message: "the pinned model or profile is no longer registered" };
  }
  return null;
}

interface ExecuteCellContext {
  runId: string;
  ownerId: string;
  /** This pass's claim; every settle compares against it. */
  claimToken: string;
  modelsBySlug: Map<string, ImageModel>;
  profilesById: Map<string, ImageModelProfile>;
  render: TrialCellRenderer;
  sink: DiagnosticSink | undefined;
}

/**
 * Where a cell records the output it has already stored, so the containment
 * catch can settle WITH it.
 *
 * A mutable holder rather than a return value because the point is to survive a
 * THROW: `executeOneTrialCell` writes `imageId` the moment `saveImageBuffer`
 * reports ready, and anything that throws after that — a failing settle, a bug
 * in the audit checks — leaves the id readable to the catch below. Without it a
 * throw between store and settle produced a `ready`, owner-scoped, hidden image
 * that no cell pointed at, which means the run's delete sweep (it walks cell
 * pointers) could never find it and nothing in the app could either.
 */
interface StoredTrialOutput {
  imageId: string | null;
}

/**
 * One cell with its exceptions contained. A throw out of
 * {@link executeOneTrialCell} — a DB error storing the output, a bug — may land
 * AFTER provider spend, and letting it abort the batch would 500 the route and
 * leave the cell `planned`, so the next execute would re-render it: double
 * provider spend for one cell's evidence. Instead the thrown cell settles
 * `failed` through the same claim CAS every other settle uses, CARRYING whatever
 * output was already stored, and the batch continues.
 *
 * Settling with the stored id is what keeps the bytes accounted for: the cell
 * owns them, the run's delete sweep reaches them, and an operator can look at
 * the image a failed cell paid for. `failed` cells never pair, so an image that
 * arrived through a broken path still cannot enter the comparison grid.
 *
 * Only a failure of that settle itself stops the pass (`null`) — at that point
 * nothing can be recorded, and continuing would repeat the same write failure
 * cell after cell. The caller returns this pass's UNREACHED claims to the grid;
 * this cell's own claim stays `running` and waits out stale recovery, because
 * writing more rows to a database that just refused a write is not a recovery
 * plan.
 */
async function executeTrialCellContained(
  cell: IdentityPackTrialCellRow,
  spec: ImageIdentityPackTrialCellSpec,
  context: ExecuteCellContext,
): Promise<ExecutedTrialCell["status"] | null> {
  const stored: StoredTrialOutput = { imageId: null };
  try {
    return await executeOneTrialCell(cell, spec, context, stored);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "cell execution threw; settling the cell failed", {
        context: {
          runId: context.runId,
          cellId: cell.id,
          cellKey: cell.cellKey,
          outputImageId: stored.imageId,
          error: message.slice(0, 300),
        },
      }),
    );
    try {
      return await settleTrialCell(
        cell,
        context,
        "failed",
        trialResult({
          outputImageId: stored.imageId,
          failureCode: "other",
          failureMessage: message.slice(0, 2000),
        }),
        stored.imageId,
      );
    } catch {
      context.sink?.push(
        diag("error", "images.identity_pack.trial.cell_degraded", "could not settle a thrown cell; stopping this pass", {
          context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey, outputImageId: stored.imageId },
        }),
      );
      return null;
    }
  }
}

/**
 * Settle one cell with a compare-and-set against THIS PASS'S CLAIM — the row
 * must still be `running` under the same token — so a writer that took the cell
 * over (a stale-claim recovery elsewhere, a second machine) loses cleanly rather
 * than overwriting an outcome that already exists.
 *
 * The claim columns are deliberately LEFT ON the terminal row. They are the
 * audit trail of which pass settled it and when the render started; clearing
 * them would erase the only evidence tying a stored output to the pass that paid
 * for it.
 *
 * When the CAS finds nothing, any output this settle was carrying is ORPHANED —
 * the cell's pointer was never written, so nothing in the app references those
 * bytes again and the run's delete sweep (which walks cell pointers) would never
 * find them. It is deleted here, immediately, guarded by owner and kind.
 */
async function settleTrialCell(
  cell: IdentityPackTrialCellRow,
  context: ExecuteCellContext,
  status: Extract<TrialCellStatus, "rendered" | "failed" | "refused">,
  result: ImageIdentityPackTrialResult,
  outputImageId: string | null,
): Promise<Extract<TrialCellStatus, "rendered" | "failed" | "refused"> | "skipped"> {
  const updated = await db()
    .update(imageIdentityPackTrialCells)
    .set({ status, resultJson: result, outputImageId })
    .where(
      and(
        eq(imageIdentityPackTrialCells.id, cell.id),
        eq(imageIdentityPackTrialCells.status, "running"),
        eq(imageIdentityPackTrialCells.claimToken, context.claimToken),
      ),
    )
    .returning({ id: imageIdentityPackTrialCells.id });
  if (updated.length === 0) {
    context.sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "another writer took this cell's claim first", {
        context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey },
      }),
    );
    await discardOrphanedTrialOutput(outputImageId, context, cell);
    return "skipped";
  }
  return status;
}

/**
 * Remove a stored output whose settle lost the claim race.
 *
 * One helper rather than a check at each settle site: several post-render paths
 * carry an output image, and a cleanup written once per site is a cleanup that
 * eventually exists at only some of them.
 *
 * Best-effort, and the cost of "best" failing is worth stating plainly: nothing
 * reconciles a leftover. A `ready` `identity_trial_output` whose delete failed
 * is a hidden row no cell points at, so the run's delete sweep (which walks cell
 * pointers) will never reach it and the Gallery cannot show it — it survives
 * until the CHARACTER is deleted and the owner-scoped image cascade takes it.
 * That is a small, bounded leak; throwing here instead would turn a lost claim
 * race into a failed pass, which is worse and far more likely.
 */
async function discardOrphanedTrialOutput(
  outputImageId: string | null,
  context: ExecuteCellContext,
  cell: IdentityPackTrialCellRow,
): Promise<void> {
  if (outputImageId === null) return;
  const removed = await deleteOwnedImage(outputImageId, context.ownerId, { kind: "identity_trial_output" }).catch(
    () => false,
  );
  context.sink?.push(
    diag("warn", "images.identity_pack.trial.output_orphaned", "discarded a trial output whose cell was taken over", {
      context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey, outputImageId, removed },
    }),
  );
}

function refuseTrialCell(
  cell: IdentityPackTrialCellRow,
  context: ExecuteCellContext,
  code: ImageIdentityPackTrialRefusalCode,
  message: string,
): Promise<Extract<TrialCellStatus, "rendered" | "failed" | "refused"> | "skipped"> {
  refusal(code, message, context.sink, { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey });
  return settleTrialCell(
    cell,
    context,
    "refused",
    trialResult({ failureCode: code, failureMessage: message.slice(0, 2000) }),
    null,
  );
}

async function readOwnedImageBytes(imageId: string, ownerId: string): Promise<Buffer | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!row || row.status !== "ready") return null;
  return readImageBytes(row);
}

/** An images-row meta number, or null — never a fabricated dimension. */
function metaDimension(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

type ResolvedTrialCellPack = { ok: true; pack: ImageIdentityPackV1 | null } | { ok: false; message: string };

/** Whether a pack IS the one this cell pinned — identity, revision, and the
 * bytes it was derived from, all three. */
function packMatchesTrialCell(pack: ImageIdentityPackV1, spec: ImageIdentityPackTrialCellSpec): boolean {
  return (
    pack.id === spec.packId &&
    pack.revision === spec.packRevision &&
    pack.source.contentHash === spec.sourceContentHash
  );
}

/**
 * The pack this cell renders from, by the variant its spec names.
 *
 * The three arms are genuinely different reads, and collapsing them would be a
 * correctness bug rather than a tidy-up:
 *
 * - `none` — the no-pack baseline. No pack work at all, no references.
 * - `current` — ensure the character's pack and check it has not moved. This arm
 *   MAY derive a fresh revision (that is what `ensureIdentityPack` does), which
 *   is precisely why the check that follows exists.
 * - `rev:…` — a PINNED historical revision, read strictly read-only. This arm
 *   must never call `ensureIdentityPack`: a pinned-revision cell that quietly
 *   re-derived, or silently fell back to the current pack, would render a
 *   different comparison under the name of the one that was planned — which is
 *   the exact corruption the pack-variant axis exists to measure and must not
 *   itself commit. A swept revision is a refusal, not a fallback.
 */
async function resolveTrialCellPack(
  spec: ImageIdentityPackTrialCellSpec,
  context: ExecuteCellContext,
): Promise<ResolvedTrialCellPack> {
  const { ownerId, sink } = context;
  if (spec.referenceSource === "none") return { ok: true, pack: null };

  if (spec.packVariantKey === "current") {
    const ensured = await ensureIdentityPack({ ownerId, characterId: spec.characterId, purpose: "admin_trial", sink });
    if (ensured.status !== "ready" || !packMatchesTrialCell(ensured.pack, spec)) {
      return { ok: false, message: "the identity pack moved since this cell was planned" };
    }
    return { ok: true, pack: ensured.pack };
  }

  if (spec.packVariantKey.startsWith("rev:")) {
    if (spec.packRevision === null) return { ok: false, message: "the pinned-revision cell names no revision" };
    const pinned = await getIdentityPackRevisionForTrial({
      ownerId,
      characterId: spec.characterId,
      revision: spec.packRevision,
      sink,
    });
    if (!pinned.ok) return { ok: false, message: `the pinned pack revision is unavailable (${pinned.code})` };
    if (!packMatchesTrialCell(pinned.pack, spec)) {
      return { ok: false, message: "the pinned pack revision no longer matches the identity this cell recorded" };
    }
    return { ok: true, pack: pinned.pack };
  }

  return { ok: false, message: `the cell names a pack variant this build cannot resolve (${spec.packVariantKey})` };
}

/**
 * One cell, end to end: re-verify the pinned world (provider version, compiled
 * prompt, compiled negative, resolved controls, and the pack identity behind its
 * variant), read the reference bytes in role order, render through the seam, and
 * store the output through the normal row-before-file pipeline as a hidden
 * `identity_trial_output`.
 *
 * Anything that moved since planning is `cell_conflict`: the cell describes a
 * comparison that can no longer be run AS PLANNED, and running some other
 * comparison under its name would poison the whole grid's evidence.
 *
 * Anything the PROVIDER did differently from what was compiled is `failed` with
 * the output kept ({@link postRenderAuditFailure}): a trimmed reference, a
 * discarded control field, a version that is not the pinned one. The image is
 * real and auditable, and a failed cell never pairs, so it cannot enter the
 * comparison grid it does not belong in.
 *
 * The spec arrives already parsed. The pass parsed it once at the claim boundary
 * — a cell whose spec does not parse never reaches here, it settles terminally
 * and free — so there is no second interpretation of the same JSON to drift.
 *
 * `stored` is the containment wrapper's holder: the output id is written into it
 * the instant the bytes land, so a throw anywhere after that still settles a
 * cell that OWNS its image rather than orphaning it (see
 * {@link executeTrialCellContained}).
 */
async function executeOneTrialCell(
  cell: IdentityPackTrialCellRow,
  spec: ImageIdentityPackTrialCellSpec,
  context: ExecuteCellContext,
  stored: StoredTrialOutput,
): Promise<ExecutedTrialCell["status"]> {
  const { ownerId, runId, sink } = context;

  const fixture = trialPromptFixtureById(spec.promptFixtureId);
  if (!fixture) return refuseTrialCell(cell, context, "fixture_unknown", "the cell's prompt fixture is no longer checked in");

  const model = context.modelsBySlug.get(spec.modelSlug);
  const profile = context.profilesById.get(spec.profileId);
  if (!model || !profile) {
    return refuseTrialCell(cell, context, "cell_conflict", "the pinned model or profile is no longer registered");
  }

  // The version is checked BEFORE anything is compiled: a model whose pin moved
  // or vanished cannot execute this cell at all, and saying "the controls
  // changed" about a version bump would send an operator looking in the wrong place.
  const modelVersion = pinnedImageModelVersion(model);
  if (modelVersion === null || modelVersion !== spec.modelVersion) {
    return refuseTrialCell(cell, context, "cell_conflict", "the pinned provider version moved or vanished");
  }

  // Recompile from the rows in force NOW, with the SAME compiler planning used,
  // and compare all three fingerprints. Between them they cover fixture text
  // drift, role-wording drift (the preamble is part of the prompt), a changed
  // negative, and any registry or profile edit that would change what is sent.
  // A cell pinned a configuration; running a different one under its name
  // poisons the grid's evidence, so every difference is a conflict.
  const recompiled = compileProfileRenderPlan({
    model,
    profile,
    basePrompt: fixture.prompt,
    baseNegativePrompt: fixture.negativePrompt,
    referenceRoles: spec.orderedReferenceRoles,
  });
  if (!recompiled.ok) {
    // Planning refuses an unexecutable prompt strategy outright, so a cell that
    // reaches execution and meets one did not come from a planner that allowed
    // it — the PROFILE ROW moved under the cell (its strategy was edited after
    // the grid was planned). That is a conflict, not an ineligibility: the cell
    // pinned a comparison whose configuration no longer exists.
    return refuseTrialCell(
      cell,
      context,
      "cell_conflict",
      `the profile's prompt strategy changed to ${recompiled.promptStrategy}, which the identity trial cannot execute`,
    );
  }
  const plan = recompiled.plan;
  const compiled = trialCellCompiledIdentity(plan, profile, spec.orderedReferenceRoles);
  if (compiled.positivePromptHash !== spec.positivePromptHash) {
    return refuseTrialCell(cell, context, "cell_conflict", "the compiled prompt text changed since planning");
  }
  if (compiled.negativePromptHash !== spec.negativePromptHash) {
    return refuseTrialCell(cell, context, "cell_conflict", "the compiled negative prompt changed since planning");
  }
  if (compiled.resolvedControlsHash !== spec.resolvedControlsHash) {
    return refuseTrialCell(cell, context, "cell_conflict", "the resolved model/profile controls changed since planning");
  }

  const resolvedPack = await resolveTrialCellPack(spec, context);
  if (!resolvedPack.ok) return refuseTrialCell(cell, context, "cell_conflict", resolvedPack.message);
  const pack = resolvedPack.pack;

  // A null pack is the no-pack baseline, whose contract forbids reference roles
  // outright — so this loop simply does not run for it, and no reference is
  // ever read from a pack that is not there.
  const references: Buffer[] = [];
  if (pack !== null) {
    for (const role of spec.orderedReferenceRoles) {
      const imageId = role === "canonical_identity" ? pack.source.imageId : pack.faceDetail.imageId;
      const buffer = imageId === null ? null : await readOwnedImageBytes(imageId, ownerId);
      if (!buffer) return refuseTrialCell(cell, context, "cell_conflict", `the ${role} reference bytes are unreadable`);
      references.push(buffer);
    }
  }

  // Everything above this line is a read; everything below it costs money. The
  // claim was re-asserted at this cell's queue boundary
  // ({@link beatTrialQueueClaims}) and the pass would not have reached here
  // without holding it, so a race lost before now cost ZERO provider calls. Only
  // the bounded reads between that boundary and this point — the pack resolution
  // and the reference bytes — sit inside the gap, which is what the stale
  // window's margin exists to cover.

  // Tee the renderer's diagnostics through a local collector: the plan-time
  // capacity check makes `fitReferences` a no-op here, but the `data_url`
  // transport can still drop a reference against its inline byte budget
  // (`withinDataUrlBudget`), and the control overlay can still refuse a field
  // that collided with one the render path owns. Both surface ONLY as warn
  // diagnostics — a cell rendered from fewer references, or fewer controls, than
  // its spec names is not the comparison the grid claims, so they have to be
  // observed, not assumed.
  const renderDiagnostics = new DiagnosticCollector();
  const startedMs = Date.now();
  const rendered = await context.render(
    {
      // The EFFECTIVE model and the COMPILED prompt: what crosses this seam is
      // exactly what the profile compiled and exactly what the hashes cover.
      model: plan.effectiveModel,
      prompt: plan.finalPrompt,
      references,
      controlInput: plan.controlInput,
      timeoutMs: plan.timeoutMs,
      versionId: plan.versionId,
    },
    sink ? teeSink(sink, renderDiagnostics) : renderDiagnostics,
  );
  const latencyMs = Date.now() - startedMs;
  // The provider's own handles on this attempt, recorded on every outcome below.
  // `providerVersionId` is what Replicate says it RAN, as against `modelVersion`,
  // which is what the cell asked for; null means it echoed nothing, never "it
  // matched". `moderationOutcome` and `postCrop` stay null throughout: the
  // Replicate adapter exposes neither a moderation verdict nor a post-download
  // crop rectangle, and a fabricated value in a provenance field is worse than
  // an honest absence.
  const provenance = {
    providerPredictionId: rendered.predictionId ?? null,
    providerVersionId: rendered.executedVersionId ?? null,
  };

  if (!rendered.ok || !rendered.image) {
    const message = rendered.error ?? `${model.slug} returned no image`;
    sink?.push(
      diag("warn", imageIdentityPackTrialDiagnosticCode("provider_failed"), message.slice(0, 300), {
        context: { runId, cellId: cell.id, cellKey: cell.cellKey, ...provenance },
      }),
    );
    return settleTrialCell(
      cell,
      context,
      "failed",
      trialResult({
        ...provenance,
        failureCode: classifyImageFailure(message),
        failureMessage: message.slice(0, 2000),
        latencyMs,
      }),
      null,
    );
  }

  const asset = await createImageAsset({
    ownerId,
    kind: "identity_trial_output",
    entityKind: "character",
    entityId: spec.characterId,
    // Null only on the no-pack baseline, which has no source to record; the
    // provenance column is optional, so absent is the honest value there.
    sourceImageId: spec.sourceImageId ?? undefined,
    prompt: plan.finalPrompt,
    meta: { hidden: true, trialRunId: runId, trialCellId: cell.id, cellKey: cell.cellKey },
  });
  const saved = await saveImageBuffer(asset.id, rendered.image, sink);
  if (saved?.status !== "ready") {
    // The pending row is removed rather than left `failed`: nothing references
    // it (the cell's pointer is only ever set on success), so a straggler here
    // would outlive even the run's delete sweep.
    await deleteOwnedImage(asset.id, ownerId, { kind: "identity_trial_output" });
    const message = "trial output could not be written";
    return settleTrialCell(
      cell,
      context,
      "failed",
      trialResult({
        ...provenance,
        failureCode: classifyImageFailure(message),
        failureMessage: message,
        latencyMs,
      }),
      null,
    );
  }
  // The bytes exist and this cell owns them, from HERE — before any step that
  // could throw. If one does, the containment catch settles the cell carrying
  // this id, so the image stays owned, auditable and reachable by the run's
  // delete sweep instead of becoming a hidden row nothing points at.
  stored.imageId = saved.id;

  const meta = imageMeta(saved.meta);
  const measured = {
    ...provenance,
    outputImageId: saved.id,
    latencyMs,
    finalWidthPx: metaDimension(meta, "width"),
    finalHeightPx: metaDimension(meta, "height"),
  };

  // A render the provider did not make as compiled is a FAILED cell that KEEPS
  // its output: the image exists and is auditable (why did the provider get
  // fewer references? which version actually ran?), but it is not the comparison
  // the grid claims, and failed cells never pair.
  const audit = postRenderAuditFailure(spec, renderDiagnostics, provenance.providerVersionId);
  if (audit !== null) {
    return settleTrialCell(
      cell,
      context,
      "failed",
      trialResult({ ...measured, failureCode: audit.code, failureMessage: audit.message.slice(0, 2000) }),
      saved.id,
    );
  }

  return settleTrialCell(cell, context, "rendered", trialResult(measured), saved.id);
}

/**
 * Why a produced image is not the evidence this cell promised, or null when it
 * is.
 *
 * Three different ways a render can succeed and still be worthless as a
 * comparison, all discovered only AFTER the provider answered — which is why
 * each one keeps the image (it was paid for, and an operator investigating
 * needs to see it) and settles the cell `failed` rather than `rendered`:
 *
 * - `references_trimmed` — the `data_url` transport dropped a reference against
 *   its inline byte budget, so the render used fewer references than its spec
 *   names.
 * - `controls_trimmed` — the transport refused a control field for colliding
 *   with one the render path owns. `compileProfileRenderPlan` filters those
 *   before they enter the payload, so reaching this means the compile step and
 *   the transport disagree about what is reserved; a cell whose controls were
 *   silently narrowed in transit is not the configuration the hash records.
 * - `version_mismatch` — Replicate echoed a version that is not the pinned one.
 *   The whole reason a trial pins a version is that "whatever ran that hour" is
 *   not a controlled comparison; an echo that disagrees says plainly that
 *   something else ran. A MISSING echo is not a mismatch — the provider simply
 *   did not say, and refusing on silence would fail every cell against a model
 *   endpoint that omits the field.
 */
function postRenderAuditFailure(
  spec: ImageIdentityPackTrialCellSpec,
  renderDiagnostics: DiagnosticCollector,
  providerVersionId: string | null,
): { code: string; message: string } | null {
  const trimmed = renderDiagnostics.items.find((entry) => entry.code === REFERENCES_TRIMMED_DIAGNOSTIC);
  if (trimmed) {
    return {
      code: "references_trimmed",
      message:
        `a planned reference was dropped in transport (${trimmed.code}): ` +
        `planned roles ${spec.orderedReferenceRoles.join(", ")} — ${trimmed.message}`,
    };
  }
  const narrowed = renderDiagnostics.items.find((entry) => entry.code === RESERVED_FIELD_IGNORED_DIAGNOSTIC);
  if (narrowed) {
    return {
      code: "controls_trimmed",
      message: `a compiled control field was refused in transport (${narrowed.code}): ${narrowed.message}`,
    };
  }
  if (providerVersionId !== null && providerVersionId !== spec.modelVersion) {
    return {
      code: "version_mismatch",
      message: `the provider ran version ${providerVersionId}, not the pinned ${spec.modelVersion}`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Blinded review                                                            *
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
function reviewableTrialCells(
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

async function gradedPairIds(runId: string): Promise<Set<string>> {
  const rows = await db()
    .select({ pairId: imageIdentityPackTrialGrades.pairId })
    .from(imageIdentityPackTrialGrades)
    .where(eq(imageIdentityPackTrialGrades.runId, runId));
  return new Set(rows.map((row) => row.pairId));
}

export type NextUnreviewedTrialPairResult = { pair: ImageIdentityPackTrialReviewPairWire | null };

/**
 * The next blinded pair, or `{ pair: null }` when the queue is empty. Null when
 * the run is not this owner's. Deliberately stateless: the left/right mapping
 * is derived ({@link trialPairLeftIsA}), so serving the same pair twice shows
 * the same sides, and nothing strategy-shaped crosses the wire.
 */
export async function nextUnreviewedTrialPair(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<NextUnreviewedTrialPairResult | null> {
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const { pairable, outputImageIdByCellId } = reviewableTrialCells(await trialCellRows(runId), sink);
  const graded = await gradedPairIds(runId);
  for (const pair of pairTrialCells(pairable)) {
    if (graded.has(pair.pairId)) continue;
    const imageA = outputImageIdByCellId.get(pair.cellAId);
    const imageB = outputImageIdByCellId.get(pair.cellBId);
    if (imageA === undefined || imageB === undefined) continue; // unreachable: pairs are built from reviewable cells
    const leftIsA = trialPairLeftIsA(runId, pair.pairId);
    return {
      pair: {
        pairId: pair.pairId,
        leftImageId: leftIsA ? imageA : imageB,
        rightImageId: leftIsA ? imageB : imageA,
        task: pair.task,
        promptFixtureId: pair.promptFixtureId,
      },
    };
  }
  return { pair: null };
}

export interface SubmitTrialPairGradeInput {
  runId: string;
  ownerId: string;
  request: ImageIdentityPackTrialGradeRequest;
  sink?: DiagnosticSink;
}

export type SubmitTrialPairGradeResult =
  | { ok: true; leftIsA: boolean; runStatus: TrialRunStatus }
  | { ok: false; refusal: IdentityPackTrialRefusal };

/**
 * Store one blinded submission, unblinded into A/B space with the same derived
 * mapping the pair was served under — which is then PERSISTED on the row, so
 * the stored grade is interpretable on its own. Insert-once under the
 * `(run, pair)` unique via `onConflictDoNothing`: a duplicate is a loud
 * `grade_conflict`, never a silent averaging of two opinions. Null when the run
 * — or the named pair — does not exist for this owner.
 *
 * **The run's status is re-settled after a successful insert, and returned.**
 * Grading is one of exactly two writes that can complete a run — the other is a
 * verdict — because `complete` needs full verdict coverage AND every reviewable
 * pair graded. Without this, a run whose slots were all ruled early (through the
 * explicit override) stayed in `review` after its final grade landed, and only
 * an unrelated later verdict write would notice. Status is derived at WRITE
 * time in this module; a write that changes one of its inputs has to settle it.
 *
 * A grade is accepted on a `complete` run, deliberately and narrowly: the pair
 * must ALREADY exist, since pairs are derived from rendered cells and a complete
 * run has none left to settle. No NEW pair can appear on one either — with the
 * degraded-evidence gates, evidence can only be LOST after completion, and
 * losing it blocks a future completion rather than manufacturing a pair. So this
 * path is for a slot that was legitimately gradable all along, and the re-settle
 * keeps the status consistent with the evidence either way.
 */
export async function submitTrialPairGrade(input: SubmitTrialPairGradeInput): Promise<SubmitTrialPairGradeResult | null> {
  const { runId, ownerId, request, sink } = input;
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const { pairable } = reviewableTrialCells(await trialCellRows(runId), sink);
  const pair = pairTrialCells(pairable).find((candidate) => candidate.pairId === request.pairId);
  if (!pair) return null;

  const leftIsA = trialPairLeftIsA(runId, pair.pairId);
  const grade = unblindTrialPairGrade(
    {
      grades: request.grades,
      catastrophicLeft: request.catastrophicLeft,
      catastrophicRight: request.catastrophicRight,
      notes: request.notes,
    },
    leftIsA,
  );
  const inserted = await db()
    .insert(imageIdentityPackTrialGrades)
    .values({
      runId,
      pairId: pair.pairId,
      cellAId: pair.cellAId,
      cellBId: pair.cellBId,
      leftIsA,
      gradesJson: grade,
      reviewedByUserId: ownerId,
    })
    .onConflictDoNothing({ target: [imageIdentityPackTrialGrades.runId, imageIdentityPackTrialGrades.pairId] })
    .returning({ id: imageIdentityPackTrialGrades.id });
  if (inserted.length === 0) {
    return {
      ok: false,
      refusal: refusal("grade_conflict", "this pair already has a grade", sink, { runId, pairId: pair.pairId }),
    };
  }
  const runStatus = await settleTrialRunStatus(runId, run.status, false, sink);
  return { ok: true, leftIsA, runStatus };
}

/* ------------------------------------------------------------------------ *
 * Summary and verdicts                                                      *
 * ------------------------------------------------------------------------ */

/**
 * The unblinded aggregates, every rendered (profile, strategy) combination, and
 * the verdicts recorded so far. Null when the run is not this owner's.
 * Unblinding happened at submission — the stored grades are already in
 * canonical A/B space — so this is a read: pairs from the rendered cells,
 * grades from the rows, math from the pure lib. `renderedCombos` rides along
 * because it is the verdict-slot list: comparisons alone cannot carry a
 * strategy whose counterpart cells all failed.
 *
 * `degradedCells` rides along for the mirror-image reason: it is the ONLY signal
 * on this wire for evidence that has been LOST. Everything else here counts what
 * survives, so a run whose degradation deleted the affected pair outright reads
 * as fully graded — exactly when {@link recordTrialVerdict} will refuse it
 * `review_incomplete`. The client needs the number to offer the override the
 * server is about to demand.
 */
export async function identityPackTrialSummary(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageIdentityPackTrialSummaryWire | null> {
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const rows = await trialCellRows(runId);
  const { pairable, degraded } = reviewableTrialCells(rows, sink);
  const pairs: TrialCellPair[] = pairTrialCells(pairable);

  const gradeRows = await db()
    .select()
    .from(imageIdentityPackTrialGrades)
    .where(eq(imageIdentityPackTrialGrades.runId, runId));
  const grades: TrialGradeRecord[] = [];
  for (const row of gradeRows) {
    const grade = readJsonColumn(trialPairGradeSchema, row.gradesJson, sink, GRADES_JSON_PATH).value;
    if (grade) grades.push({ pairId: row.pairId, grade });
  }

  return {
    comparisons: aggregateTrialGrades(pairs, grades),
    // Only the NAMEABLE combos ride the wire. A rendered row whose spec no longer
    // parses has no slot to offer — it is counted where it matters (it blocks
    // completion, `verdictsCoverRenderedCombos`) rather than fabricated into a
    // verdict slot the reviewer could not act on.
    renderedCombos: withComboPairCounts(
      renderedTrialCombos(rows, sink).combos,
      pairs,
      new Set(grades.map((record) => record.pairId)),
    ),
    verdicts: await readTrialVerdicts(runId),
    // THE SAME NUMBER the verdict gate refuses on — `reviewableTrialCells`'
    // `degraded`, read from the same call that produced the pairs above, not
    // re-derived. Two derivations of "is this run's evidence intact?" would be
    // free to disagree, and the disagreement would surface as the UI insisting
    // review is complete while the server refuses the ruling.
    //
    // It also covers `renderedTrialCombos`' own degraded count, which completion
    // consults separately ({@link verdictsCoverRenderedCombos}): that one counts
    // rendered rows with an UNREADABLE SPEC, a strict subset of the rows counted
    // here (unreadable spec OR missing output image). So zero here is zero there,
    // and one number is the honest wire shape for one condition.
    degradedCells: degraded,
  };
}

/**
 * Attach each verdict slot's pairwise evidence: how many pairs it takes part in
 * on either side, and how many of those are graded.
 *
 * A slot showing 0 of 0 is the case worth surfacing — a strategy that rendered
 * but whose every counterpart cell failed has no comparative evidence at all,
 * and the reviewer must see that BEFORE promoting it. An empty comparison list
 * beside a populated verdict list does not say which slot is unsupported.
 */
function withComboPairCounts(
  combos: readonly RenderedComboTally[],
  pairs: readonly TrialCellPair[],
  gradedPairIdSet: ReadonlySet<string>,
): TrialRenderedCombo[] {
  return combos.map((combo): TrialRenderedCombo => {
    const involved = pairs.filter(
      (pair) =>
        pair.profileId === combo.profileId &&
        (pair.strategyA === combo.identityStrategy || pair.strategyB === combo.identityStrategy),
    );
    return {
      ...combo,
      totalPairs: involved.length,
      gradedPairs: involved.filter((pair) => gradedPairIdSet.has(pair.pairId)).length,
    };
  });
}

export interface RecordTrialVerdictInput {
  runId: string;
  ownerId: string;
  profileId: string;
  identityStrategy: IdentityReferenceStrategy;
  verdict: TrialVerdictValue;
  reason: string;
  /**
   * Rule anyway, with reviewable pairs still ungraded. An EXPLICIT, RECORDED
   * admin decision, never a silent bypass: without it the ruling is refused
   * `review_incomplete`, and with it the flag is persisted on the row so a
   * promotion made on partial evidence stays distinguishable from one made on
   * all of it. It cannot override the other two gates — a run still executing
   * has evidence in flight, and an unknown combo is a typo, not a judgment call.
   */
  overrideIncompleteReview?: boolean;
  sink?: DiagnosticSink;
}

export type RecordTrialVerdictResult =
  | { ok: true; runStatus: TrialRunStatus; verdicts: TrialVerdict[] }
  | { ok: false; refusal: IdentityPackTrialRefusal };

/**
 * Every (profile, strategy) any cell of the run carries, regardless of status.
 * Null-strategy cells contribute nothing: the no-pack baseline is not a verdict
 * slot, so a verdict naming it would have no combo to match.
 */
function runCellCombos(rows: readonly IdentityPackTrialCellRow[]): Set<string> {
  const combos = new Set<string>();
  for (const row of rows) {
    const parsed = trialCellComboSchema.safeParse(row.specJson);
    if (!parsed.success || parsed.data.identityStrategy === null) continue;
    combos.add(verdictComboKey(parsed.data.profileId, parsed.data.identityStrategy));
  }
  return combos;
}

/**
 * Why this run is in no position to be ruled on, or null when it is.
 *
 * Two separate things are being asserted, and both matter. A cell still
 * `planned` or `running` means evidence is in flight — a ruling recorded now
 * would be a judgment on a grid that is still growing, and the `running` half
 * is the sharper case: those renders may already have been PAID for, so their
 * outputs are coming. And a run that has not reached `review` has nothing to
 * rule on at all, whatever its cell counts say.
 *
 * `complete` is deliberately allowed: revising a ruling after the fact is the
 * upsert path, and a trial whose verdict can never be corrected is a trial
 * whose first mistake is permanent.
 */
function trialRunPositionBlocker(status: TrialRunStatus, counts: TrialCellCounts): string | null {
  const unexecuted = counts.planned + counts.running;
  if (unexecuted > 0) {
    return `the run is still executing: ${counts.planned} planned, ${counts.running} running cell(s) remain`;
  }
  switch (status) {
    case "draft":
      return "the run is in draft: nothing has been rendered to review";
    case "running":
      return "the run has not settled out of execution yet";
    case "review":
    case "complete":
      return null;
  }
}

/**
 * Upsert one (profile, strategy) verdict — the actor, reason and clock stamped
 * here, the policy version being the one in force — then settle the run's
 * status: when every combination present in the rendered cells is ruled AND
 * every reviewable pair is graded, `review` becomes `complete` with no separate
 * close action. Null when the run is not this owner's.
 *
 * Three gates, in this order, each refusing rather than storing:
 *
 * 1. **Position** ({@link trialRunPositionBlocker}) — `review_incomplete` while
 *    the run is in draft or has cells still planned or running.
 * 2. **Combo** — `verdict_unknown_combo` for a (profile, strategy) no cell of
 *    the run carries. A typo'd profile id would otherwise record a verdict
 *    nothing can surface, and enough of them would push the summary past its
 *    64-verdict wire cap.
 * 3. **Evidence** — `review_incomplete` while reviewable pairs are ungraded OR
 *    any rendered cell's evidence has been lost, unless the caller passes
 *    `overrideIncompleteReview`. This is the gate the whole blinded procedure
 *    exists to enforce: a ruling recorded over unseen comparisons is exactly the
 *    failure mode the grades were collected to prevent, and a ruling recorded
 *    over comparisons that no longer EXIST is the same failure wearing a full
 *    grade count. The override is honored, and RECORDED on the row.
 *
 * The write itself is a single-row upsert on `(run, profile, strategy)`, not a
 * rewrite of a verdict array. That is what makes two admins ruling on two
 * different slots at the same moment safe: each write touches only its own
 * ruling, so neither can erase the other.
 *
 * On ONE slot, though, the ledger is deliberately LAST-WRITE-WINS and keeps no
 * history. A revision replaces the whole row in place — verdict, reason, actor,
 * timestamp and override flag together — so the previous ruling is gone, not
 * superseded, and two admins ruling the same (profile, strategy) at the same
 * moment leave whichever landed last with no trace that the other happened. That
 * is the intended shape: this table answers "what is the current ruling on this
 * combination?", and the revision path exists precisely so a first mistake is not
 * permanent. A run needing an audit trail of who changed their mind and when
 * would need an append-only ledger, which this is not.
 */
export async function recordTrialVerdict(input: RecordTrialVerdictInput): Promise<RecordTrialVerdictResult | null> {
  const { runId, ownerId, sink } = input;
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;

  // Read the cells ONCE and share them across all three gates: re-reading
  // between gates would let a run change position underneath its own ruling.
  const rows = await trialCellRows(runId);

  const blocked = trialRunPositionBlocker(run.status, countTrialCells(rows));
  if (blocked !== null) {
    return {
      ok: false,
      refusal: refusal("review_incomplete", blocked, sink, { runId, runStatus: run.status }),
    };
  }

  if (!runCellCombos(rows).has(verdictComboKey(input.profileId, input.identityStrategy))) {
    return {
      ok: false,
      refusal: refusal(
        "verdict_unknown_combo",
        `no cell in this run tested profile ${input.profileId} under ${input.identityStrategy}`,
        sink,
        { runId, profileId: input.profileId, identityStrategy: input.identityStrategy },
      ),
    };
  }

  const { pairable, degraded } = reviewableTrialCells(rows, sink);
  const graded = await gradedPairIds(runId);
  const ungradedPairs = pairTrialCells(pairable).filter((pair) => !graded.has(pair.pairId)).length;
  const overrideRequested = input.overrideIncompleteReview === true;
  // Two ways the evidence can be short of complete, and they are the same fact
  // to a ruling: a pair nobody has graded, and a rendered cell whose image or
  // spec has vanished (taking its pairs with it, so "0 ungraded" would otherwise
  // read as full evidence precisely when there is less of it).
  //
  // `degraded` here and the summary wire's `degradedCells` are the SAME number
  // from the SAME derivation ({@link identityPackTrialSummary}) — deliberately,
  // because the client decides whether to offer the override from the wire and
  // this decides whether to demand it. A second derivation on either side would
  // let the UI report a complete review over evidence this gate refuses.
  const incompleteEvidence: string[] = [];
  if (ungradedPairs > 0) incompleteEvidence.push(`${ungradedPairs} reviewable pair(s) are still ungraded`);
  if (degraded > 0) incompleteEvidence.push(`${degraded} rendered cell(s) no longer carry reviewable evidence`);
  if (incompleteEvidence.length > 0 && !overrideRequested) {
    return {
      ok: false,
      refusal: refusal(
        "review_incomplete",
        `${incompleteEvidence.join("; ")} — complete the evidence or rule with an explicit override`,
        sink,
        { runId, ungradedPairs, degradedCells: degraded },
      ),
    };
  }

  // True only when the override actually carried the ruling past missing
  // evidence. Stamping it on a fully graded run would claim the evidence was
  // incomplete when it was not — a fabricated fact in the one field that exists
  // to keep partial-evidence promotions honest.
  const overrodeIncompleteReview = overrideRequested && incompleteEvidence.length > 0;
  const decidedAt = new Date();
  await db()
    .insert(imageIdentityPackTrialVerdicts)
    .values({
      id: newId(),
      runId,
      profileId: input.profileId,
      identityStrategy: input.identityStrategy,
      verdict: input.verdict,
      reason: input.reason,
      policyVersion: IDENTITY_PACK_POLICY_VERSION,
      overrideIncompleteReview: overrodeIncompleteReview,
      decidedByUserId: ownerId,
      decidedAt,
    })
    .onConflictDoUpdate({
      target: [
        imageIdentityPackTrialVerdicts.runId,
        imageIdentityPackTrialVerdicts.profileId,
        imageIdentityPackTrialVerdicts.identityStrategy,
      ],
      // A revision replaces the whole ruling, `updatedAt` included — drizzle's
      // `$onUpdate` fires for `.update()`, never for a conflict arm, so a
      // timestamp left implicit here would freeze at the original insert.
      set: {
        verdict: input.verdict,
        reason: input.reason,
        policyVersion: IDENTITY_PACK_POLICY_VERSION,
        overrideIncompleteReview: overrodeIncompleteReview,
        decidedByUserId: ownerId,
        decidedAt,
        updatedAt: new Date(),
      },
    });

  const runStatus = await settleTrialRunStatus(runId, run.status, false, sink);
  return { ok: true, runStatus, verdicts: await readTrialVerdicts(runId) };
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
