import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import {
  chooseAspect,
  imageIdentityPackTrialCellSpecSchema,
  imageIdentityPackTrialDiagnosticCode,
  imageIdentityPackTrialResultSchema,
  referenceCapacity,
  trialPairGradeSchema,
  trialVerdictListSchema,
  type IdentityReferenceStrategy,
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
} from "@/contracts";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { IDENTITY_PACK_POLICY_VERSION } from "@/lib/images/identity-pack-policy";
import {
  buildTrialCellPlans,
  pairTrialCells,
  trialPromptFixtureById,
  unblindTrialPairGrade,
  aggregateTrialGrades,
  type IdentityPackTrialPromptFixture,
  type TrialCellPair,
  type TrialGradeRecord,
  type TrialPairableCell,
} from "@/lib/images/identity-pack-trial";
import { newId } from "@/lib/ids";
import { classifyImageFailure } from "../ai";
import {
  db,
  imageIdentityPackTrialCells,
  imageIdentityPackTrialGrades,
  imageIdentityPackTrialRuns,
  images,
} from "../db";
// Direct module path for the reason identity-packs.ts records on ITS import of
// this file: the `@/server/engine` barrel re-exports `chat-pipeline.ts`, which
// imports `@/server/images` — naming the barrel here would close a real import
// cycle. `keyed-lock.ts` itself imports nothing.
import { tryKeyedLock } from "../engine/keyed-lock";
import { createImageAsset, deleteOwnedImage, imageMeta, purgeImagesWhere, readImageBytes, saveImageBuffer } from "./assets";
import { ensureIdentityPack, IDENTITY_PACK_TRIAL_CORPORA, readJsonColumn } from "./identity-packs";
import { evaluateIdentityPackForProfile } from "./identity-pack-references";
import { loadImageModels, renderWithModel, type RenderWithModelResult } from "./models";
import { loadImageModelProfiles } from "./model-profiles";

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
 * Three rules shape it:
 *
 * 1. **Everything is owner-scoped.** Runs are selected by `(id, owner)`; a
 *    character the run owner does not own resolves exactly like a character
 *    that does not exist (`ensureIdentityPack`'s owner-rooted source
 *    resolution), so its cells are recorded `refused` and nothing about the
 *    foreign character leaks.
 * 2. **A cell settles once.** `failed` and `refused` are terminal — a rerun is
 *    a NEW run, never a retry — and every settle is a compare-and-set against
 *    `status = 'planned'`, so no writer can overwrite another's outcome.
 * 3. **The daily render budget is charged INSIDE the execution lock, through
 *    the caller's injected `chargeBudget`** — sized to exactly the planned
 *    cells this pass picked, after `run_locked` can no longer refuse the pass.
 *    The route supplies the charge function (`imageRenderRejection` bound to
 *    the request), because the guard needs the request and its user; this
 *    module decides WHEN and for HOW MANY, because charging before the lock
 *    billed passes that were then refused, with no refund path.
 *
 * Run status is derived-but-persisted, and every transition goes through
 * {@link nextTrialRunStatus}: draft → running on the first execute, running →
 * review when no planned cell remains, review → complete when a verdict covers
 * every (profile, strategy) present in the rendered cells.
 */

/* ------------------------------------------------------------------------ *
 * Keys, hashes, and the blind mapping                                       *
 * ------------------------------------------------------------------------ */

/**
 * The one spelling of the per-run execution key, for the reason
 * `identityPackLockKey` gives: a second copy that drifts serializes against
 * nobody and looks completely normal. In-process is correct on the
 * single-machine Fly deploy (the `keyed-lock.ts` ruling); the per-cell
 * compare-and-set on `status = 'planned'` is what keeps a second machine from
 * double-settling a cell regardless.
 */
export function identityPackTrialLockKey(runId: string): string {
  return `identity_pack_trial:${runId}`;
}

function sha256HexOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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

/**
 * Deterministic JSON for hashing: keys sorted recursively, `undefined` members
 * dropped. Local rather than imported from the engine's `canonicalJson` because
 * that module carries the contact-ledger machinery and reaching into it from
 * the image lane for a string formatter would couple two systems over nothing.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The version a cell pins. Prefers the probed Replicate version, then a version
 * pinned in the slug itself; `"unprobed"` is the honest floor for a row probed
 * before the version column existed — the execute-time re-check compares this
 * exact string, so a version that appears later is a conflict, not a match.
 */
function trialModelVersion(model: ImageModel): string {
  if (model.probedVersionId !== null) return model.probedVersionId;
  const pinned = model.slug.split(":")[1];
  return pinned !== undefined && pinned.length > 0 ? pinned : "unprobed";
}

/**
 * Everything about HOW this cell renders beyond the prompt and references,
 * hashed for provenance and drift detection: the execute-time re-check
 * recomputes this from the freshly loaded rows and refuses `cell_conflict` on
 * a mismatch. The fields are the resolved render-shaping configuration —
 * transport, capacity, aspect choice, control defaults, overrides — not the
 * whole rows, so an edit to a display label does not invalidate a cell. Note
 * that `controlDefaults` / `providerOverrides` / `timeoutMs` are recorded but
 * not yet applied by `renderWithModel` (task profiles reach the render path in
 * a later capabilities slice); hashing them now means the cell already
 * describes the configuration that WILL apply, not just what does today.
 */
function resolvedControlsHashFor(profile: ImageModelProfile, model: ImageModel): string {
  return sha256HexOf(
    stableJson({
      modelId: model.id,
      modelSlug: model.slug,
      modelVersion: trialModelVersion(model),
      referenceField: model.referenceField,
      referenceArity: model.referenceArity,
      referenceTransport: model.referenceTransport,
      maxReferences: model.maxReferences,
      aspect: chooseAspect(model).value,
      outputFormat: model.outputFormat,
      extraInput: model.extraInput,
      profileId: profile.id,
      profileKey: profile.key,
      operation: profile.operation,
      promptStrategy: profile.promptStrategy,
      controlDefaults: profile.controlDefaults,
      providerOverrides: profile.providerOverrides,
      timeoutMs: profile.timeoutMs,
    }),
  );
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
const VERDICTS_JSON_PATH = "image_identity_pack_trial_runs.verdicts_json";

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
  return { planned: 0, rendered: 0, failed: 0, refused: 0 };
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

function runVerdicts(run: IdentityPackTrialRunRow, sink: DiagnosticSink | undefined): TrialVerdict[] {
  return parseOr(trialVerdictListSchema, run.verdictsJson, [], sink, VERDICTS_JSON_PATH);
}

/* ------------------------------------------------------------------------ *
 * Run status                                                                *
 * ------------------------------------------------------------------------ */

/**
 * The one place a run's derived-but-persisted status moves. Exhaustive over the
 * current status so a new lifecycle position cannot ship without deciding what
 * it may become. `review` → `complete` requires the coverage fact to be TRUE of
 * something: a run with no rendered cell at all stays in `review` as the record
 * of a trial nothing came of, rather than claiming completion vacuously.
 */
function nextTrialRunStatus(
  current: TrialRunStatus,
  facts: { executing: boolean; plannedRemaining: number; verdictsCoverEveryRenderedCombo: boolean },
): TrialRunStatus {
  let status = current;
  switch (status) {
    case "draft":
      if (facts.executing) status = facts.plannedRemaining === 0 ? "review" : "running";
      break;
    case "running":
      if (facts.plannedRemaining === 0) status = "review";
      break;
    case "review":
    case "complete":
      break;
  }
  if (status === "review" && facts.verdictsCoverEveryRenderedCombo) status = "complete";
  return status;
}

/** `profileId:strategy` — the unit a verdict rules on. */
function verdictComboKey(profileId: string, strategy: IdentityReferenceStrategy): string {
  return `${profileId}:${strategy}`;
}

/**
 * Every (profile, strategy) with at least one rendered cell, in cell-key order.
 * The ONE derivation shared by run completion ({@link verdictsCoverRenderedCombos})
 * and the summary wire's `renderedCombos`: the verdict slots the UI offers must
 * be exactly the set completion waits on, or a run whose strategy lost every
 * counterpart cell (no pair, so no comparison) wedges in `review` with no slot
 * to rule it through.
 */
function renderedTrialCombos(
  rows: readonly IdentityPackTrialCellRow[],
  sink: DiagnosticSink | undefined,
): TrialRenderedCombo[] {
  const combos = new Map<string, TrialRenderedCombo>();
  for (const row of rows) {
    if (row.status !== "rendered") continue;
    const spec = readTrialCellSpec(row, sink);
    if (!spec) continue;
    const key = verdictComboKey(spec.profileId, spec.identityStrategy);
    const existing = combos.get(key);
    if (existing) existing.renderedCells += 1;
    else combos.set(key, { profileId: spec.profileId, identityStrategy: spec.identityStrategy, renderedCells: 1 });
  }
  return [...combos.values()];
}

function verdictsCoverRenderedCombos(
  rows: readonly IdentityPackTrialCellRow[],
  verdicts: readonly TrialVerdict[],
  sink: DiagnosticSink | undefined,
): boolean {
  const combos = renderedTrialCombos(rows, sink);
  if (combos.length === 0) return false;
  const ruled = new Set(verdicts.map((verdict) => verdictComboKey(verdict.profileId, verdict.identityStrategy)));
  return combos.every((combo) => ruled.has(verdictComboKey(combo.profileId, combo.identityStrategy)));
}

/** Recompute and persist the run's status from its cells and verdicts. */
async function settleTrialRunStatus(
  runId: string,
  current: TrialRunStatus,
  verdicts: readonly TrialVerdict[],
  executing: boolean,
  sink: DiagnosticSink | undefined,
): Promise<TrialRunStatus> {
  const rows = await trialCellRows(runId);
  const next = nextTrialRunStatus(current, {
    executing,
    plannedRemaining: countTrialCells(rows).planned,
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
  /** One profile-eligibility evaluation per (character, strategy). */
  evaluations: Map<string, Promise<EvaluateIdentityPackResult>>;
  sink: DiagnosticSink | undefined;
}

function ensurePackOnce(resolution: TrialPlanResolution, characterId: string): Promise<EnsureIdentityPackResult> {
  const cached = resolution.packs.get(characterId);
  if (cached) return cached;
  const ensured = ensureIdentityPack({
    ownerId: resolution.ownerId,
    characterId,
    purpose: "admin_trial",
    sink: resolution.sink,
  });
  resolution.packs.set(characterId, ensured);
  return ensured;
}

/**
 * The evaluation depends only on the character's pack and the strategy — the
 * profile policy in force is the v1 defaults for every profile, and no reviewed
 * effective-size fact exists yet (`effectiveReferenceSize` omitted keeps the
 * evaluation conservative) — so it is cached per (character, strategy) rather
 * than run once per cell.
 */
function evaluateOnce(
  resolution: TrialPlanResolution,
  characterId: string,
  strategy: IdentityReferenceStrategy,
): Promise<EvaluateIdentityPackResult> {
  const key = `${characterId}:${strategy}`;
  const cached = resolution.evaluations.get(key);
  if (cached) return cached;
  const evaluated = evaluateIdentityPackForProfile({
    ownerId: resolution.ownerId,
    characterId,
    strategy,
    purpose: "admin_trial",
    sink: resolution.sink,
  });
  resolution.evaluations.set(key, evaluated);
  return evaluated;
}

/**
 * Resolve one planned cell to a full spec, or to the refusal that stops it
 * (spec.trial.md §"Trial manifest"). The order is the design's: profile, then
 * pack, then strategy evaluation, then capacity — each refusal records
 * everything that DID resolve, so the run report can say how far a cell got.
 */
async function resolveTrialCell(
  resolution: TrialPlanResolution,
  cellId: string,
  plan: { characterId: string; profileId: string; identityStrategy: IdentityReferenceStrategy; promptFixtureId: string },
  fixture: IdentityPackTrialPromptFixture,
): Promise<ResolvedTrialCell> {
  const planFields = {
    id: cellId,
    characterId: plan.characterId,
    task: fixture.task,
    promptFixtureId: plan.promptFixtureId,
    profileId: plan.profileId,
    identityStrategy: plan.identityStrategy,
    positivePromptHash: sha256HexOf(fixture.prompt),
    negativePromptHash: fixture.negativePrompt === null ? null : sha256HexOf(fixture.negativePrompt),
    requestedSeed: null,
  };

  const profile = resolution.profilesById.get(plan.profileId);
  const model = profile ? resolution.modelsById.get(profile.imageModelId) : undefined;
  if (!profile || !profile.enabled || !model) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `profile ${plan.profileId} is not a runnable registry profile`,
      spec: planFields,
    };
  }
  const profileFields = {
    modelSlug: model.slug,
    modelVersion: trialModelVersion(model),
    profileKey: profile.key,
    resolvedControlsHash: resolvedControlsHashFor(profile, model),
  };

  const ensured = await ensurePackOnce(resolution, plan.characterId);
  const sourceImageId = ensured.status === "ready" ? ensured.pack.source.imageId : null;
  if (ensured.status !== "ready" || sourceImageId === null) {
    const code = ensured.status === "ready" ? "source_missing" : ensured.code;
    return {
      status: "refused",
      code: "pack_blocked",
      message: `identity pack unavailable (${code})`,
      spec: { ...planFields, ...profileFields },
    };
  }
  const pack = ensured.pack;
  const packFields = {
    packId: pack.id,
    packRevision: pack.revision,
    sourceImageId,
    sourceContentHash: pack.source.contentHash,
    cropMethod: pack.derivation.method,
    crop: pack.faceDetail.crop,
    derivationVersion: pack.derivation.derivationVersion,
    policyVersion: pack.derivation.policyVersion,
  };

  // Detector-derived cells are structurally supported but unbuildable until a
  // reviewed detector ships (the null adapter finds nothing, so this only fires
  // for injected or future detectors) — refused, never faked.
  if (pack.derivation.method === "detector") {
    return {
      status: "refused",
      code: "detector_unavailable",
      message: "detector-derived cells are not runnable until a reviewed face detector ships",
      spec: { ...planFields, ...profileFields, ...packFields },
    };
  }

  const evaluated = await evaluateOnce(resolution, plan.characterId, plan.identityStrategy);
  if (!evaluated.eligible) {
    return {
      status: "refused",
      code: "profile_ineligible",
      message: `identity references unavailable for this strategy (${evaluated.messageKey})`,
      spec: { ...planFields, ...profileFields, ...packFields },
    };
  }
  const primary = evaluated.candidates[0];
  const evaluationFields = {
    effectiveReferenceSize: {
      widthPx: primary?.evaluation.effectiveReferenceWidthPx ?? null,
      heightPx: primary?.evaluation.effectiveReferenceHeightPx ?? null,
      faceWidthPx: primary?.evaluation.effectiveFaceWidthPx ?? null,
      faceHeightPx: primary?.evaluation.effectiveFaceHeightPx ?? null,
    },
    orderedReferenceRoles: evaluated.candidates.map((candidate) => candidate.role),
  };

  const capacity = referenceCapacity(model);
  if (evaluationFields.orderedReferenceRoles.length > capacity.max) {
    return {
      status: "refused",
      code: "capacity_exceeded",
      message: `${evaluationFields.orderedReferenceRoles.length} reference(s) exceed ${model.slug}'s capacity of ${capacity.max}`,
      spec: { ...planFields, ...profileFields, ...packFields, ...evaluationFields },
    };
  }

  const spec: ImageIdentityPackTrialCellSpec = { ...planFields, ...profileFields, ...packFields, ...evaluationFields };
  return { status: "planned", spec };
}

/**
 * Plan a run: expand the grid, resolve every cell, and persist the run with its
 * cells — eligible ones `planned`, blocked ones `refused` with the code that
 * stopped them (spending nothing). Whole-run refusals — an unknown corpus, an
 * unknown fixture, a grid over `TRIAL_MAX_CELLS` — create no rows at all: they
 * are configuration errors, not outcomes worth recording.
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

  const planned = buildTrialCellPlans({
    characterIds,
    profileIds: request.profileIds,
    strategies: request.strategies,
    promptFixtureIds: request.promptFixtureIds,
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
  await db()
    .insert(imageIdentityPackTrialRuns)
    .values({
      id: runId,
      ownerId,
      label: request.label,
      status: counts.planned === 0 ? "review" : "draft",
      configJson: request,
      verdictsJson: [],
    });
  if (cellValues.length > 0) await db().insert(imageIdentityPackTrialCells).values(cellValues);

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

/** The one diagnostic code the render path emits when a reference is dropped in
 * transport (`runRegistryImageModel`'s `data_url` inline-byte budget). Spelled
 * here so the trim watch in {@link executeOneTrialCell} cannot drift from it. */
const REFERENCES_TRIMMED_DIAGNOSTIC = "image_model.references_trimmed";

export interface TrialCellRenderInput {
  model: ImageModel;
  prompt: string;
  references: Buffer[];
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

function trialRenderer(): TrialCellRenderer {
  return injectedRenderer ?? ((input, sink) => renderWithModel(input, sink));
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
 * Run up to `maxRenders` planned cells, single-flight per run: a second caller
 * meets `run_locked` instead of queueing, because a second click while a pass
 * is rendering means the operator cannot see the first pass yet, and stacking
 * passes would spend budget nobody asked for. Null when the run is not this
 * owner's.
 *
 * Cells settle in `cellKey` order — deterministic, so "run 5 more" walks the
 * grid the same way every time. A `failed` cell stays failed: a rerun is a new
 * run, never a silent retry of a cell whose evidence already exists.
 */
export async function executeIdentityPackTrialCells<TReject>(
  input: ExecuteIdentityPackTrialCellsInput<TReject>,
): Promise<ExecuteIdentityPackTrialCellsResult<TReject> | null> {
  const { runId, ownerId, sink } = input;
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;

  const held = tryKeyedLock(identityPackTrialLockKey(runId), () => executeUnderLock(input), "trial_execute");
  if (held === null) {
    return {
      ok: false,
      refusal: refusal("run_locked", "another execution pass holds this run", sink, { runId }),
    };
  }
  return held;
}

async function executeUnderLock<TReject>(
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

  const plannedRows = await db()
    .select()
    .from(imageIdentityPackTrialCells)
    .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "planned")))
    .orderBy(asc(imageIdentityPackTrialCells.cellKey));
  const picked = plannedRows.slice(0, maxRenders);

  // Charge for exactly the cells this pass will attempt, and only once they are
  // picked: a pass with nothing to run costs nothing (reviewing a finished grid
  // must keep working after the daily budget is spent). Charged slots are a
  // reservation — a cell that then conflicts or fails mid-batch does not refund
  // its unit, deliberately, because the pass was admitted at this size.
  if (picked.length > 0) {
    const rejected = await input.chargeBudget(picked.length);
    if (rejected !== null) {
      sink?.push(
        diag("warn", imageIdentityPackTrialDiagnosticCode("budget_refused"), "the render budget refused this pass", {
          context: { runId, cells: picked.length },
        }),
      );
      return { ok: false, budgetRejected: rejected };
    }
  }

  const [models, profiles] = await Promise.all([loadImageModels(sink), loadImageModelProfiles(sink)]);
  const context: ExecuteCellContext = {
    runId,
    ownerId,
    modelsBySlug: new Map(models.map((model) => [model.slug, model])),
    profilesById: new Map(profiles.map((profile) => [profile.id, profile])),
    render: trialRenderer(),
    sink,
  };

  const executed: ExecutedTrialCell[] = [];
  for (const cell of picked) {
    const status = await executeTrialCellContained(cell, context);
    if (status === null) break; // the containment settle itself failed; stop the pass
    executed.push({ cellId: cell.id, cellKey: cell.cellKey, status });
  }

  const runStatus = await settleTrialRunStatus(runId, run.status, runVerdicts(run, sink), true, sink);
  const [remaining] = await db()
    .select({ planned: count() })
    .from(imageIdentityPackTrialCells)
    .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "planned")));
  return { ok: true, executed, remainingPlanned: remaining?.planned ?? 0, runStatus };
}

interface ExecuteCellContext {
  runId: string;
  ownerId: string;
  modelsBySlug: Map<string, ImageModel>;
  profilesById: Map<string, ImageModelProfile>;
  render: TrialCellRenderer;
  sink: DiagnosticSink | undefined;
}

/**
 * One cell with its exceptions contained. A throw out of
 * {@link executeOneTrialCell} — a DB error storing the output, a bug — may land
 * AFTER provider spend, and letting it abort the batch would 500 the route and
 * leave the cell `planned`, so the next execute would re-render it: double
 * provider spend for one cell's evidence. Instead the thrown cell settles
 * `failed` through the same planned-only CAS every other settle uses, and the
 * batch continues. Only a failure of that settle itself stops the pass
 * (`null`) — at that point nothing can be recorded, and continuing would
 * repeat the same write failure cell after cell.
 */
async function executeTrialCellContained(
  cell: IdentityPackTrialCellRow,
  context: ExecuteCellContext,
): Promise<ExecutedTrialCell["status"] | null> {
  try {
    return await executeOneTrialCell(cell, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "cell execution threw; settling the cell failed", {
        context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey, error: message.slice(0, 300) },
      }),
    );
    try {
      return await settleTrialCell(
        cell,
        context,
        "failed",
        trialResult({ failureCode: "other", failureMessage: message.slice(0, 2000) }),
        null,
      );
    } catch {
      context.sink?.push(
        diag("error", "images.identity_pack.trial.cell_degraded", "could not settle a thrown cell; stopping this pass", {
          context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey },
        }),
      );
      return null;
    }
  }
}

/**
 * Settle one cell with a compare-and-set against `planned`, so a concurrent
 * writer (a second machine; the in-process lock cannot see it) loses cleanly
 * rather than overwriting an outcome that already exists.
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
    .where(and(eq(imageIdentityPackTrialCells.id, cell.id), eq(imageIdentityPackTrialCells.status, "planned")))
    .returning({ id: imageIdentityPackTrialCells.id });
  if (updated.length === 0) {
    context.sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "another writer settled this cell first", {
        context: { runId: context.runId, cellId: cell.id, cellKey: cell.cellKey },
      }),
    );
    return "skipped";
  }
  return status;
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

/**
 * One cell, end to end: re-verify the pinned world (fixture text, model
 * version, resolved controls hash, pack revision, source bytes hash), read the
 * reference bytes in role order, render through the seam, and store the output
 * through the normal row-before-file pipeline as a hidden
 * `identity_trial_output`.
 *
 * Anything that moved since planning is `cell_conflict`: the cell describes a
 * comparison that can no longer be run AS PLANNED, and running some other
 * comparison under its name would poison the whole grid's evidence.
 */
async function executeOneTrialCell(
  cell: IdentityPackTrialCellRow,
  context: ExecuteCellContext,
): Promise<ExecutedTrialCell["status"]> {
  const { ownerId, runId, sink } = context;
  const spec = readJsonColumn(imageIdentityPackTrialCellSpecSchema, cell.specJson, sink, SPEC_JSON_PATH).value;
  if (!spec) {
    sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "planned cell's stored spec did not parse; skipped", {
        context: { runId, cellId: cell.id, cellKey: cell.cellKey },
      }),
    );
    return "skipped";
  }

  const fixture = trialPromptFixtureById(spec.promptFixtureId);
  if (!fixture) return refuseTrialCell(cell, context, "fixture_unknown", "the cell's prompt fixture is no longer checked in");
  if (sha256HexOf(fixture.prompt) !== spec.positivePromptHash) {
    return refuseTrialCell(cell, context, "cell_conflict", "the fixture's prompt text changed since planning");
  }

  const model = context.modelsBySlug.get(spec.modelSlug);
  if (!model || trialModelVersion(model) !== spec.modelVersion) {
    return refuseTrialCell(cell, context, "cell_conflict", "the pinned model or version is no longer registered");
  }

  // The same hash the planner recorded, recomputed from the rows in force NOW:
  // a registry or profile edit that changes how this cell would render (its
  // capacity, transport, aspect, controls) is a conflict, even though today's
  // render path does not consult every hashed field yet — the cell pinned a
  // configuration, and running a different one under its name poisons the grid.
  const profile = context.profilesById.get(spec.profileId);
  if (!profile || resolvedControlsHashFor(profile, model) !== spec.resolvedControlsHash) {
    return refuseTrialCell(cell, context, "cell_conflict", "the resolved model/profile controls changed since planning");
  }

  const ensured = await ensureIdentityPack({ ownerId, characterId: spec.characterId, purpose: "admin_trial", sink });
  if (
    ensured.status !== "ready" ||
    ensured.pack.id !== spec.packId ||
    ensured.pack.revision !== spec.packRevision ||
    ensured.pack.source.contentHash !== spec.sourceContentHash
  ) {
    return refuseTrialCell(cell, context, "cell_conflict", "the identity pack moved since this cell was planned");
  }
  const pack = ensured.pack;

  const references: Buffer[] = [];
  for (const role of spec.orderedReferenceRoles) {
    const imageId = role === "canonical_identity" ? pack.source.imageId : pack.faceDetail.imageId;
    const buffer = imageId === null ? null : await readOwnedImageBytes(imageId, ownerId);
    if (!buffer) return refuseTrialCell(cell, context, "cell_conflict", `the ${role} reference bytes are unreadable`);
    references.push(buffer);
  }

  // Tee the renderer's diagnostics through a local collector: the plan-time
  // capacity check makes `fitReferences` a no-op here, but the `data_url`
  // transport can still drop a reference against its inline byte budget
  // (`withinDataUrlBudget`), and that trim surfaces ONLY as a warn diagnostic —
  // a cell rendered from fewer references than its spec names is not the
  // comparison the grid claims, so the trim has to be observed, not assumed.
  const renderDiagnostics = new DiagnosticCollector();
  const startedMs = Date.now();
  const rendered = await context.render(
    { model, prompt: fixture.prompt, references },
    sink ? teeSink(sink, renderDiagnostics) : renderDiagnostics,
  );
  const latencyMs = Date.now() - startedMs;

  if (!rendered.ok || !rendered.image) {
    const message = rendered.error ?? `${model.slug} returned no image`;
    sink?.push(
      diag("warn", imageIdentityPackTrialDiagnosticCode("provider_failed"), message.slice(0, 300), {
        context: { runId, cellId: cell.id, cellKey: cell.cellKey },
      }),
    );
    return settleTrialCell(
      cell,
      context,
      "failed",
      trialResult({ failureCode: classifyImageFailure(message), failureMessage: message.slice(0, 2000), latencyMs }),
      null,
    );
  }

  const asset = await createImageAsset({
    ownerId,
    kind: "identity_trial_output",
    entityKind: "character",
    entityId: spec.characterId,
    sourceImageId: spec.sourceImageId,
    prompt: fixture.prompt,
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
      trialResult({ failureCode: classifyImageFailure(message), failureMessage: message, latencyMs }),
      null,
    );
  }

  const meta = imageMeta(saved.meta);
  const measured = {
    outputImageId: saved.id,
    latencyMs,
    finalWidthPx: metaDimension(meta, "width"),
    finalHeightPx: metaDimension(meta, "height"),
  };

  // A trimmed render is a FAILED cell that keeps its output: the image exists
  // and is auditable (why did the provider get fewer references?), but it was
  // made from fewer references than the spec names, so letting it into pairing
  // would grade a comparison nobody planned. Failed cells never pair.
  const trimmed = renderDiagnostics.items.find((diagnostic) => diagnostic.code === REFERENCES_TRIMMED_DIAGNOSTIC);
  if (trimmed) {
    const message =
      `a planned reference was dropped in transport (${trimmed.code}): ` +
      `planned roles ${spec.orderedReferenceRoles.join(", ")} — ${trimmed.message}`;
    return settleTrialCell(
      cell,
      context,
      "failed",
      trialResult({ ...measured, failureCode: "references_trimmed", failureMessage: message.slice(0, 2000) }),
      saved.id,
    );
  }

  return settleTrialCell(cell, context, "rendered", trialResult(measured), saved.id);
}

/* ------------------------------------------------------------------------ *
 * Blinded review                                                            *
 * ------------------------------------------------------------------------ */

interface ReviewableTrialCells {
  pairable: TrialPairableCell[];
  outputImageIdByCellId: Map<string, string>;
}

/**
 * The rendered cells a pair may be built from. A rendered cell whose output
 * image is gone (the FK set-null safety net) or whose spec no longer parses is
 * skipped with a warn: it is a hole in the evidence, not a reason to fail the
 * review queue.
 */
function reviewableTrialCells(
  rows: readonly IdentityPackTrialCellRow[],
  sink: DiagnosticSink | undefined,
): ReviewableTrialCells {
  const pairable: TrialPairableCell[] = [];
  const outputImageIdByCellId = new Map<string, string>();
  for (const row of rows) {
    if (row.status !== "rendered") continue;
    const spec = readTrialCellSpec(row, sink);
    if (!spec || row.outputImageId === null) {
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
    });
  }
  return { pairable, outputImageIdByCellId };
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
  | { ok: true; leftIsA: boolean }
  | { ok: false; refusal: IdentityPackTrialRefusal };

/**
 * Store one blinded submission, unblinded into A/B space with the same derived
 * mapping the pair was served under — which is then PERSISTED on the row, so
 * the stored grade is interpretable on its own. Insert-once under the
 * `(run, pair)` unique via `onConflictDoNothing`: a duplicate is a loud
 * `grade_conflict`, never a silent averaging of two opinions. Null when the run
 * — or the named pair — does not exist for this owner.
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
  return { ok: true, leftIsA };
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
 */
export async function identityPackTrialSummary(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageIdentityPackTrialSummaryWire | null> {
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const rows = await trialCellRows(runId);
  const { pairable } = reviewableTrialCells(rows, sink);
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
    renderedCombos: renderedTrialCombos(rows, sink),
    verdicts: runVerdicts(run, sink),
  };
}

export interface RecordTrialVerdictInput {
  runId: string;
  ownerId: string;
  profileId: string;
  identityStrategy: IdentityReferenceStrategy;
  verdict: TrialVerdictValue;
  reason: string;
  sink?: DiagnosticSink;
}

export type RecordTrialVerdictResult =
  | { ok: true; runStatus: TrialRunStatus; verdicts: TrialVerdict[] }
  | { ok: false; refusal: IdentityPackTrialRefusal };

/**
 * The two fields a verdict must match against a cell, parsed leniently: a cell
 * refused before full resolution stores an honestly partial spec that fails the
 * full contract, but its plan fields — profile and strategy among them — are
 * always present, and a combo the run refused is still a combo the run named.
 */
const cellComboSchema = imageIdentityPackTrialCellSpecSchema.pick({ profileId: true, identityStrategy: true });

/** Every (profile, strategy) any cell of the run carries, regardless of status. */
function runCellCombos(rows: readonly IdentityPackTrialCellRow[]): Set<string> {
  const combos = new Set<string>();
  for (const row of rows) {
    const parsed = cellComboSchema.safeParse(row.specJson);
    if (parsed.success) combos.add(verdictComboKey(parsed.data.profileId, parsed.data.identityStrategy));
  }
  return combos;
}

/**
 * Upsert one (profile, strategy) verdict onto the run — the actor, reason and
 * clock stamped here, the policy version being the one in force — then settle
 * the run's status: when every combination present in the rendered cells is
 * ruled, `review` becomes `complete` with no separate close action. Null when
 * the run is not this owner's.
 *
 * A combo no cell of the run carries is refused (`verdict_unknown_combo`)
 * rather than stored: a typo'd profile id would otherwise record a verdict
 * nothing can surface, and enough of them would push the summary past its
 * 64-verdict wire cap.
 */
export async function recordTrialVerdict(input: RecordTrialVerdictInput): Promise<RecordTrialVerdictResult | null> {
  const { runId, ownerId, sink } = input;
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;

  if (!runCellCombos(await trialCellRows(runId)).has(verdictComboKey(input.profileId, input.identityStrategy))) {
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

  const entry: TrialVerdict = {
    profileId: input.profileId,
    identityStrategy: input.identityStrategy,
    verdict: input.verdict,
    reason: input.reason,
    policyVersion: IDENTITY_PACK_POLICY_VERSION,
    decidedByUserId: ownerId,
    decidedAt: new Date().toISOString(),
  };
  const verdicts = [
    ...runVerdicts(run, sink).filter(
      (verdict) => !(verdict.profileId === entry.profileId && verdict.identityStrategy === entry.identityStrategy),
    ),
    entry,
  ];
  await db()
    .update(imageIdentityPackTrialRuns)
    .set({ verdictsJson: verdicts })
    .where(eq(imageIdentityPackTrialRuns.id, runId));

  const runStatus = await settleTrialRunStatus(runId, run.status, verdicts, false, sink);
  return { ok: true, runStatus, verdicts };
}

/* ------------------------------------------------------------------------ *
 * Deletion                                                                  *
 * ------------------------------------------------------------------------ */

export interface DeleteIdentityPackTrialRunResult {
  deleted: boolean;
  outputImagesRemoved: number;
}

/**
 * Hard-delete a run: every output image row and file it produced, THEN the row
 * (cells and grades cascade with it). The purge goes first because the cell
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
