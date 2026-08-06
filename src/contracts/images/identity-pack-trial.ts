import { z } from "zod";
import {
  identityReferenceRoleSchema,
  identityReferenceStrategySchema,
  imageIdentityCropMethodSchema,
  sourcePixelCropSchema,
} from "./identity-pack";
import { imageProfileTaskSchema } from "./image-model-profiles";

/**
 * The fixed identity-reference trial's vocabulary and contracts
 * (docs/developer-notes/image-identity-packs.spec.trial.md).
 *
 * A trial run renders the SAME character, prompt fixture, and pinned profile
 * under different identity-reference strategies, then collects blinded pairwise
 * grades so a strategy is promoted on provider evidence rather than on a sharp
 * crop or a hunch. Everything here is data and vocabulary: the pure expansion,
 * pairing, and aggregation logic lives in `src/lib/images/identity-pack-trial.ts`,
 * persistence and rendering in `src/server/images/identity-pack-trial.ts`.
 *
 * The identity vocabulary (strategies, roles, crop methods, crop rectangles) is
 * imported from `./identity-pack` rather than restated — a strategy the trial can
 * grade and a strategy a profile can carry must be the same word.
 */

/**
 * The whole-run ceiling on comparison cells. It bounds one paid admin action, so
 * it lives here where both the wire schemas and the pure planner read the SAME
 * number — and it is enforced by refusal (`too_many_cells`), never by silently
 * trimming a corner of the cartesian expansion the reviewer thinks they ran.
 */
export const TRIAL_MAX_CELLS = 96;

/**
 * A run's lifecycle position. `draft` has planned cells and has spent nothing;
 * `running` has begun charging the render budget; `review` has pairs awaiting
 * blinded grades — or was created with nothing plannable at all, in which case
 * it is born here as the deletable record of a trial that cannot run;
 * `complete` has recorded verdicts.
 *
 * `schema.ts` mirrors this vocabulary inline in its `text(..., { enum })`
 * column (the `images.kind` pattern); drift between the two surfaces as a
 * parse diagnostic at the read boundary, not silently.
 */
export const trialRunStatuses = ["draft", "running", "review", "complete"] as const;
export const trialRunStatusSchema = z.enum(trialRunStatuses);
export type TrialRunStatus = (typeof trialRunStatuses)[number];

/**
 * One cell's lifecycle. `refused` is an EXPECTED outcome, not a failure: a cell
 * whose pack is blocked or whose profile cannot carry the strategy is recorded
 * with its refusal code so the run report can say WHY that comparison never
 * spent provider budget. `failed` means the provider was actually asked.
 */
export const trialCellStatuses = ["planned", "rendered", "failed", "refused"] as const;
export const trialCellStatusSchema = z.enum(trialCellStatuses);
export type TrialCellStatus = (typeof trialCellStatuses)[number];

/**
 * The spec-time identity of one comparison cell
 * (spec.trial.md §"Trial manifest"): everything held constant plus the one
 * variable under test (`identityStrategy`), snapshotted at planning time so the
 * cell stays explainable after the pack, profile, or model version moves on.
 *
 * `requestedSeed` is always null in v1 — no seed transport exists yet (the
 * capabilities plan owns seeds) — but the field is modelled now so a seeded rerun
 * is a value change, not a schema change.
 */
export const imageIdentityPackTrialCellSpecSchema = z.object({
  id: z.string().min(1),
  characterId: z.string().min(1),
  task: imageProfileTaskSchema,
  promptFixtureId: z.string().min(1),

  modelSlug: z.string().min(1),
  modelVersion: z.string().min(1),
  profileId: z.string().min(1),
  profileKey: z.string().min(1),
  identityStrategy: identityReferenceStrategySchema,

  packId: z.string().min(1),
  packRevision: z.number().int().min(1),
  sourceImageId: z.string().min(1),
  sourceContentHash: z.string().min(1),
  cropMethod: imageIdentityCropMethodSchema.nullable(),
  crop: sourcePixelCropSchema.nullable(),
  derivationVersion: z.string().min(1),
  policyVersion: z.string().min(1),

  /** Null is "not measured", never zero — the identity-pack measurement rule. */
  effectiveReferenceSize: z.object({
    widthPx: z.number().int().nullable(),
    heightPx: z.number().int().nullable(),
    faceWidthPx: z.number().int().nullable(),
    faceHeightPx: z.number().int().nullable(),
  }),

  orderedReferenceRoles: z.array(identityReferenceRoleSchema).max(4),
  resolvedControlsHash: z.string().min(1),
  positivePromptHash: z.string().min(1),
  negativePromptHash: z.string().min(1).nullable(),
  requestedSeed: z.number().int().min(0).nullable(),
});
export type ImageIdentityPackTrialCellSpec = z.infer<typeof imageIdentityPackTrialCellSpecSchema>;

/**
 * What one execution attempt produced. Everything is nullable because a refused
 * cell has a result too — just a failure code and nothing else — and because a
 * provider that answered without dimensions must not fabricate any.
 *
 * `failureCode` is a bounded string rather than an enum on purpose: it carries
 * codes from more than one vocabulary (the render failure classifier for
 * provider errors, `imageIdentityPackTrialRefusalCodes` for pre-provider
 * refusals), and freezing their union here would make adding a classifier code a
 * trial-contract change.
 */
export const imageIdentityPackTrialResultSchema = z.object({
  providerPredictionId: z.string().min(1).nullable(),
  outputImageId: z.string().min(1).nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  moderationOutcome: z.string().max(200).nullable(),
  finalWidthPx: z.number().int().min(1).nullable(),
  finalHeightPx: z.number().int().min(1).nullable(),
  postCrop: sourcePixelCropSchema.nullable(),
  failureCode: z.string().min(1).max(120).nullable(),
  failureMessage: z.string().max(2000).nullable(),
});
export type ImageIdentityPackTrialResult = z.infer<typeof imageIdentityPackTrialResultSchema>;

/**
 * The eleven review dimensions, verbatim from spec.trial.md §"Review procedure".
 * `overall_preference` is the one win/tie/loss is computed from; the rest exist
 * because a strong face does not compensate for a changed outfit, body, or
 * setting, and the drift has to be visible per-axis to prove that.
 */
export const trialGradeDimensions = [
  "identity_likeness",
  "distinctive_landmarks",
  "hair",
  "apparent_age",
  "edit_fidelity",
  "body_morphology",
  "wardrobe_exposure",
  "pose_camera",
  "lighting_setting",
  "anatomy",
  "overall_preference",
] as const;
export const trialGradeDimensionSchema = z.enum(trialGradeDimensions);
export type TrialGradeDimension = (typeof trialGradeDimensions)[number];

/**
 * The one exhaustive enumeration of the dimensions as OBJECT KEYS. Every
 * per-dimension record — the grade schema, the aggregate schema, the lib's
 * aggregation output — is built through this, so a dimension added to the tuple
 * above is a compile error here until each of them decides what it holds
 * (the `Record` return type fails on a missing or extra key), and none of them
 * can drift into a partial `z.record` where a missing dimension parses.
 */
export function perTrialGradeDimension<T>(
  value: (dimension: TrialGradeDimension) => T,
): Record<TrialGradeDimension, T> {
  return {
    identity_likeness: value("identity_likeness"),
    distinctive_landmarks: value("distinctive_landmarks"),
    hair: value("hair"),
    apparent_age: value("apparent_age"),
    edit_fidelity: value("edit_fidelity"),
    body_morphology: value("body_morphology"),
    wardrobe_exposure: value("wardrobe_exposure"),
    pose_camera: value("pose_camera"),
    lighting_setting: value("lighting_setting"),
    anatomy: value("anatomy"),
    overall_preference: value("overall_preference"),
  };
}

/**
 * One relative judgment on the small anchored ordinal scale the spec calls for:
 * -2 strongly favors one side, 0 is a tie, +2 strongly favors the other. Which
 * side is which depends on the record it sits in — left/right in a blinded
 * submission, A/B once unblinded — and is documented there.
 */
export const trialPairGradeValueSchema = z.number().int().min(-2).max(2);
export type TrialPairGradeValue = z.infer<typeof trialPairGradeValueSchema>;

/**
 * Every dimension, required. A grade with a dimension missing fails parse rather
 * than averaging as an accidental zero — an ungraded axis and a graded tie are
 * different facts.
 */
export const trialPairGradesSchema = z.object(perTrialGradeDimension(() => trialPairGradeValueSchema));
export type TrialPairGrades = z.infer<typeof trialPairGradesSchema>;

/**
 * Free-text catastrophic-defect labels for one side of a pair ("second person",
 * "changed outfit", "extra limb"). Recorded separately from the ordinal grades
 * because one catastrophic regression can veto a promotion that the means alone
 * would have allowed (spec.trial.md §"Promotion rules").
 */
export const trialCatastrophicListSchema = z.array(z.string().trim().min(1).max(120)).max(8);

/**
 * One reviewed pair in A/B space: negative grades favor A, positive favor B.
 * This is the stored/aggregated shape — the reviewer never sees A or B, only
 * left and right (`imageIdentityPackTrialGradeRequestSchema`), and the server
 * unblinds the submission with the pair's persisted `leftIsA` mapping.
 */
export const trialPairGradeSchema = z.object({
  grades: trialPairGradesSchema,
  catastrophicA: trialCatastrophicListSchema,
  catastrophicB: trialCatastrophicListSchema,
  notes: z.string().max(2000).nullable(),
});
export type TrialPairGrade = z.infer<typeof trialPairGradeSchema>;

/**
 * The verdict vocabulary from spec.trial.md §"Version promotion", in the
 * snake_case every Vesper vocabulary uses — the spec doc spells the middle two
 * with hyphens (`retained-current`, `experimental-admin-only`); these are the
 * same four values.
 */
export const trialVerdicts = ["promoted", "retained_current", "experimental_admin_only", "rejected"] as const;
export const trialVerdictValueSchema = z.enum(trialVerdicts);
export type TrialVerdictValue = (typeof trialVerdicts)[number];

/**
 * One recorded verdict — per profile and strategy, never "generally superior"
 * without naming what was tested. The actor and reason are required for the same
 * reason an admin override records them: a promotion with no stated reason is
 * indistinguishable from a mistake six months later. `decidedAt` arrives from
 * the caller as an ISO string; nothing here reads a clock.
 */
export const trialVerdictSchema = z.object({
  profileId: z.string().min(1),
  identityStrategy: identityReferenceStrategySchema,
  verdict: trialVerdictValueSchema,
  reason: z.string().trim().min(1).max(2000),
  policyVersion: z.string().min(1),
  decidedByUserId: z.string().min(1),
  decidedAt: z.string().min(1),
});
export type TrialVerdict = z.infer<typeof trialVerdictSchema>;

/**
 * List shape for the run row's `verdicts_json` column. No `.catch` here: the
 * read site goes through `parseOr` with a `[]` fallback, which must be allowed
 * to fail so malformed stored verdicts surface as a warn diagnostic instead of
 * degrading silently.
 */
export const trialVerdictListSchema = z.array(trialVerdictSchema);

/**
 * Every way the trial surface says no, as stable codes. Refusals are product
 * feedback (an unbuildable cell, a paused budget, a duplicate grade), never
 * exceptions; human-readable copy is produced at the UI boundary.
 *
 * `detector_unavailable` exists because detector-vs-heuristic cells are
 * structurally supported but unbuildable until a real face detector ships — the
 * cell refuses with this code rather than faking a detector crop.
 * `verdict_unknown_combo` keeps the verdict ledger honest: a ruling must name a
 * (profile, strategy) some cell of the run actually carried, or a typo'd id
 * would record a meaningless verdict nothing can ever surface.
 */
export const imageIdentityPackTrialRefusalCodes = [
  "unknown_corpus",
  "too_many_cells",
  "pack_blocked",
  "profile_ineligible",
  "capacity_exceeded",
  "detector_unavailable",
  "fixture_unknown",
  "budget_refused",
  "provider_failed",
  "cell_conflict",
  "grade_conflict",
  "verdict_unknown_combo",
  "run_locked",
] as const;
export const imageIdentityPackTrialRefusalCodeSchema = z.enum(imageIdentityPackTrialRefusalCodes);
export type ImageIdentityPackTrialRefusalCode = (typeof imageIdentityPackTrialRefusalCodes)[number];

/** The dotted diagnostic code a refusal is reported under, on the
 * `images.identity_pack.trial.*` namespace beside the pack's own codes. */
export function imageIdentityPackTrialDiagnosticCode(code: ImageIdentityPackTrialRefusalCode): string {
  return `images.identity_pack.trial.${code}`;
}

/**
 * A run's configuration as the create route accepts it.
 *
 * Exactly one selector — explicit character ids or a checked-in trial corpus —
 * for the reason `identityPackBatchRequestSchema` gives: accepting both would
 * make "which characters did this run against?" unanswerable. The axis bounds
 * (12 × 6 × 4 × 8) are wire sanity rails; the real ceiling is the planner's
 * `TRIAL_MAX_CELLS` refusal over the deduped cartesian product.
 */
export const imageIdentityPackTrialCreateRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    characterIds: z.array(z.string().min(1)).min(1).max(12).optional(),
    corpusId: z.string().trim().min(1).max(120).optional(),
    profileIds: z.array(z.string().min(1)).min(1).max(6),
    strategies: z.array(identityReferenceStrategySchema).min(1).max(4),
    promptFixtureIds: z.array(z.string().min(1)).min(1).max(8),
  })
  .refine((value) => (value.characterIds === undefined) !== (value.corpusId === undefined), {
    message: "supply exactly one of characterIds or corpusId",
    path: ["characterIds"],
  });
export type ImageIdentityPackTrialCreateRequest = z.infer<typeof imageIdentityPackTrialCreateRequestSchema>;

/**
 * One bounded execution batch. The default is deliberately small: the owner
 * clicks through the run a few renders at a time, each click separately charged
 * against the daily render budget — inside the run's execution lock, for
 * exactly the planned cells the pass picks up.
 */
export const imageIdentityPackTrialExecuteRequestSchema = z.object({
  maxRenders: z.number().int().min(1).max(20).default(5),
});
export type ImageIdentityPackTrialExecuteRequest = z.infer<typeof imageIdentityPackTrialExecuteRequestSchema>;

/** Cell counts by status — the progress numbers every run surface shows. */
export const trialCellCountsSchema = z.object({
  planned: z.number().int().min(0),
  rendered: z.number().int().min(0),
  failed: z.number().int().min(0),
  refused: z.number().int().min(0),
} satisfies Record<TrialCellStatus, z.ZodType<number>>);
export type TrialCellCounts = z.infer<typeof trialCellCountsSchema>;

/** One run as the list route reports it. */
export const imageIdentityPackTrialRunSummarySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  status: trialRunStatusSchema,
  counts: trialCellCountsSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ImageIdentityPackTrialRunSummary = z.infer<typeof imageIdentityPackTrialRunSummarySchema>;

/** One cell as the run-detail route reports it: spec, status, and result —
 * ids and measurements only, no bytes and no URLs. */
export const imageIdentityPackTrialCellWireSchema = z.object({
  id: z.string().min(1),
  cellKey: z.string().min(1),
  status: trialCellStatusSchema,
  /**
   * Null for cells refused before resolution completed (for example a blocked
   * pack): a partial spec cannot honestly satisfy the full manifest shape, so
   * the refusal reason travels in `result.failureCode` instead.
   */
  spec: imageIdentityPackTrialCellSpecSchema.nullable(),
  result: imageIdentityPackTrialResultSchema.nullable(),
  outputImageId: z.string().min(1).nullable(),
});
export type ImageIdentityPackTrialCellWire = z.infer<typeof imageIdentityPackTrialCellWireSchema>;

export const imageIdentityPackTrialRunDetailSchema = z.object({
  run: imageIdentityPackTrialRunSummarySchema,
  cells: z.array(imageIdentityPackTrialCellWireSchema).max(TRIAL_MAX_CELLS),
});
export type ImageIdentityPackTrialRunDetail = z.infer<typeof imageIdentityPackTrialRunDetailSchema>;

/**
 * The next unreviewed pair, BLINDED: image ids, the shared task, and the shared
 * prompt fixture — deliberately no strategy, pack, or crop fields, because the
 * reviewer must not know which reference strategy produced which side
 * (spec.trial.md §"Review procedure"). The client resolves `promptFixtureId`
 * against the checked-in fixture list to show the instruction being judged.
 */
export const imageIdentityPackTrialReviewPairSchema = z.object({
  pairId: z.string().min(1),
  leftImageId: z.string().min(1),
  rightImageId: z.string().min(1),
  task: imageProfileTaskSchema,
  promptFixtureId: z.string().min(1),
});
export type ImageIdentityPackTrialReviewPairWire = z.infer<typeof imageIdentityPackTrialReviewPairSchema>;

/**
 * A blinded grade submission in LEFT/RIGHT space: negative values favor the left
 * image, positive the right. The server flips it into A/B space with the pair's
 * `leftIsA` mapping (`unblindTrialPairGrade` in the lib) before storing, so
 * nothing strategy-shaped ever round-trips through the reviewer's client.
 */
export const imageIdentityPackTrialGradeRequestSchema = z.object({
  pairId: z.string().min(1),
  grades: trialPairGradesSchema,
  catastrophicLeft: trialCatastrophicListSchema,
  catastrophicRight: trialCatastrophicListSchema,
  notes: z.string().max(2000).nullable(),
});
export type ImageIdentityPackTrialGradeRequest = z.infer<typeof imageIdentityPackTrialGradeRequestSchema>;

/**
 * A per-dimension aggregate. `mean` is null when nothing was graded — count 0
 * with a fabricated mean of 0 would read as "measured a tie", and null-is-not-
 * measured is the rule everywhere in this subsystem. `count` travels with the
 * mean so the UI can show the sample size behind every number.
 */
export const trialDimensionAggregateSchema = z.object({
  mean: z.number().nullable(),
  count: z.number().int().min(0),
});
export type TrialDimensionAggregate = z.infer<typeof trialDimensionAggregateSchema>;

/**
 * One profile's strategy-vs-strategy aggregate, in canonical A/B space (A is
 * always the strategy earlier in `identityReferenceStrategies` order, so every
 * pair of the same two strategies lands in the same bucket). Wins and losses
 * come from the sign of `overall_preference`; catastrophic counts are total
 * recorded defect labels per side.
 */
export const trialStrategyComparisonSchema = z.object({
  profileId: z.string().min(1),
  strategyA: identityReferenceStrategySchema,
  strategyB: identityReferenceStrategySchema,
  totalPairs: z.number().int().min(0),
  gradedPairs: z.number().int().min(0),
  dimensions: z.object(perTrialGradeDimension(() => trialDimensionAggregateSchema)),
  overall: z.object({
    winsA: z.number().int().min(0),
    ties: z.number().int().min(0),
    winsB: z.number().int().min(0),
  }),
  catastrophic: z.object({
    a: z.number().int().min(0),
    b: z.number().int().min(0),
  }),
});
export type TrialStrategyComparison = z.infer<typeof trialStrategyComparisonSchema>;

/**
 * One (profile, strategy) with at least one rendered cell. This — not the
 * comparison list — is what a verdict slot exists for: a strategy whose every
 * counterpart cell failed still rendered evidence and still needs a ruling, and
 * deriving slots from comparisons alone would make `complete` unreachable for
 * such a run.
 */
export const trialRenderedComboSchema = z.object({
  profileId: z.string().min(1),
  identityStrategy: identityReferenceStrategySchema,
  renderedCells: z.number().int().min(1),
});
export type TrialRenderedCombo = z.infer<typeof trialRenderedComboSchema>;

/** The summary route's body: every comparison with at least one pair, every
 * rendered (profile, strategy) combination, plus the verdicts recorded so far.
 * 96 cells cannot produce more than 96 comparisons or combos, and one verdict
 * slot exists per rendered combo. */
export const imageIdentityPackTrialSummarySchema = z.object({
  comparisons: z.array(trialStrategyComparisonSchema).max(TRIAL_MAX_CELLS),
  renderedCombos: z.array(trialRenderedComboSchema).max(TRIAL_MAX_CELLS),
  verdicts: z.array(trialVerdictSchema).max(64),
});
export type ImageIdentityPackTrialSummaryWire = z.infer<typeof imageIdentityPackTrialSummarySchema>;
