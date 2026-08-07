import { z } from "zod";
import {
  identityReferenceRoleSchema,
  identityReferenceStrategySchema,
  imageIdentityCropMethodSchema,
  sourcePixelCropSchema,
} from "./identity-pack";
import { imageProfileOperationSchema, imageProfileTaskSchema } from "./image-model-profiles";

/**
 * The fixed identity-reference trial's vocabulary and contracts
 * (docs/developer-notes/image-identity-packs.spec.trial.md).
 *
 * A trial run renders the SAME character, prompt fixture, and pinned profile
 * across different identity-reference ARMS, then collects blinded pairwise
 * grades so a strategy is promoted on provider evidence rather than on a sharp
 * crop or a hunch. An arm varies one of two things — the reference strategy
 * (which roles, in what order) or the pack variant (which revision, or none at
 * all) — and never both at once, or the grade could not be attributed to either.
 * Everything here is data and vocabulary: the pure expansion, pairing, and
 * aggregation logic lives in `src/lib/images/identity-pack-trial.ts`,
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
 *
 * `running` is the DURABLE CLAIM: an execution pass moves a cell out of
 * `planned` in the database BEFORE it calls the provider, so the claim is
 * visible to every process, not just to the in-process execution lock. Without
 * it, two machines (or one machine restarted mid-pass) both read the cell as
 * `planned` and both pay for the same render. A cell left `running` by a crashed
 * pass is therefore a real state a later pass has to reason about — it is not a
 * transient in-memory flag, and nothing may silently reset it to `planned`,
 * because "this render may already have been paid for" is exactly what it
 * records.
 */
export const trialCellStatuses = ["planned", "running", "rendered", "failed", "refused"] as const;
export const trialCellStatusSchema = z.enum(trialCellStatuses);
export type TrialCellStatus = (typeof trialCellStatuses)[number];

/**
 * Which identity-reference pack a cell renders from — the SECOND comparison
 * axis beside the strategy (spec.trial.md §"Fixed variables").
 *
 * - `current` pins whatever pack revision is current for each character at
 *   planning time. This is the historical single-variant behavior and stays the
 *   default when a run names no variants.
 * - `revision` pins one NAMED historical or manually prepared revision of ONE
 *   character. It is deliberately character-scoped: revision 3 of one character
 *   has nothing to do with revision 3 of another, so a run carrying this
 *   selector generates cells only for `characterId` and simply produces none for
 *   the run's other characters.
 * - `none` is the no-pack baseline: zero identity references, the control arm
 *   that answers "is the pack helping at all?". It is only expressible on
 *   `generate`-operation profiles (an edit profile with no reference image has
 *   nothing to edit), carries a NULL `identityStrategy` because there is no
 *   reference order to choose, is excluded from verdict slots (a verdict rules
 *   on a (profile, strategy), and the baseline has no strategy), and pairs
 *   against pack cells purely as evidence.
 */
export const trialPackVariantSelectorSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("current") }),
  z.object({ source: z.literal("none") }),
  z.object({
    source: z.literal("revision"),
    characterId: z.string().min(1),
    revision: z.number().int().min(1),
  }),
]);
export type TrialPackVariantSelector = z.infer<typeof trialPackVariantSelectorSchema>;

/**
 * The stable string identity of a pack variant — what a cell stores, what the
 * pairing rule compares, and what a comparison bucket is keyed by. Derived
 * rather than stored on the selector so two spellings of the same variant can
 * never claim to be different arms of the same run.
 *
 * The revision form embeds colons, which is why every key layout built from it
 * (`trialCellPlan.cellKey`) puts the variant key LAST.
 */
export function trialPackVariantKey(selector: TrialPackVariantSelector): string {
  switch (selector.source) {
    case "current":
      return "current";
    case "none":
      return "none";
    case "revision":
      return `rev:${selector.characterId}:${selector.revision}`;
  }
}

/**
 * The compiled configuration a cell actually hands the provider — the resolved
 * profile controls after every unsupported knob has been dropped, not the
 * profile row's wishes.
 *
 * `resolvedControlsHash` proves the configuration did not MOVE; this proves what
 * the configuration WAS. Both are needed: a hash that matches tells you nothing
 * about which controls the model silently ignored, and a grid where one arm
 * quietly lost its guidance setting is a comparison of two different renders
 * wearing one name. `droppedControls` therefore records every omission with its
 * reason instead of leaving the absence to be inferred.
 */
export const trialResolvedControlsSchema = z.object({
  operation: imageProfileOperationSchema,
  /** Null means "no per-profile budget" — the env/default timeout applies. */
  timeoutMs: z.number().int().min(1).nullable(),
  /** The provider-shaped control payload, already mapped to this version's field names. */
  controlInput: z.record(z.string(), z.unknown()),
  droppedControls: z.array(z.object({ control: z.string().min(1), reason: z.string().min(1) })),
});
export type TrialResolvedControls = z.infer<typeof trialResolvedControlsSchema>;

/**
 * The spec-time identity of one comparison cell
 * (spec.trial.md §"Trial manifest"): everything held constant plus the variables
 * under test (`identityStrategy` and `packVariantKey`), snapshotted at planning
 * time so the cell stays explainable after the pack, profile, or model version
 * moves on.
 *
 * Three fields are load-bearing in ways their names understate:
 *
 * - `positivePromptHash` / `negativePromptHash` hash the FINAL COMPILED text
 *   actually sent — role preamble included (`compileIdentityReferencePrompt`) —
 *   not the raw fixture. Two cells whose fixture matches but whose reference
 *   role bindings differ are not the same prompt, and hashing the fixture would
 *   claim they were.
 * - `modelVersion` is always a real pinned provider version. A model whose exact
 *   version cannot be identified refuses `version_unpinned` at planning: the old
 *   `"unprobed"` floor let a cell claim a pin it did not have, so an unannounced
 *   provider-side version bump mid-run read as a matching re-check.
 * - `requestedSeed` is still always null — no seed transport exists yet (the
 *   capabilities plan owns seeds) — but the field is modelled now so a seeded
 *   rerun is a value change, not a schema change.
 *
 * The pack columns are nullable ONLY for the no-pack baseline
 * (`referenceSource: "none"`), and the `superRefine` below is what keeps that
 * from becoming a general licence to store a half-resolved pack identity: a
 * pack-source cell must carry every pack field, a none-source cell must carry
 * none of them and no reference roles at all.
 */
export const imageIdentityPackTrialCellSpecSchema = z
  .object({
    id: z.string().min(1),
    characterId: z.string().min(1),
    task: imageProfileTaskSchema,
    promptFixtureId: z.string().min(1),

    modelSlug: z.string().min(1),
    modelVersion: z.string().min(1),
    profileId: z.string().min(1),
    profileKey: z.string().min(1),
    /** Null ONLY on the no-pack baseline: with zero references there is no order to pick. */
    identityStrategy: identityReferenceStrategySchema.nullable(),

    /**
     * Which pack variant this cell renders from ({@link trialPackVariantKey}).
     * Defaulted so specs stored before the variant axis existed parse as what
     * they were: single-variant cells against the then-current revision.
     */
    packVariantKey: z.string().min(1).max(80).default("current"),
    referenceSource: z.enum(["pack", "none"]).default("pack"),

    packId: z.string().min(1).nullable(),
    packRevision: z.number().int().min(1).nullable(),
    sourceImageId: z.string().min(1).nullable(),
    sourceContentHash: z.string().min(1).nullable(),
    cropMethod: imageIdentityCropMethodSchema.nullable(),
    crop: sourcePixelCropSchema.nullable(),
    derivationVersion: z.string().min(1).nullable(),
    policyVersion: z.string().min(1).nullable(),

    /** Null is "not measured", never zero — the identity-pack measurement rule. */
    effectiveReferenceSize: z.object({
      widthPx: z.number().int().nullable(),
      heightPx: z.number().int().nullable(),
      faceWidthPx: z.number().int().nullable(),
      faceHeightPx: z.number().int().nullable(),
    }),

    orderedReferenceRoles: z.array(identityReferenceRoleSchema).max(4),
    resolvedControlsHash: z.string().min(1),
    /**
     * Null means the cell was planned before the control-compile step existed,
     * so nothing can say what it would send. Such a cell refuses `cell_conflict`
     * at execution rather than rendering under a guess — an un-compiled cell in
     * a grid of compiled ones is not a comparison, it is a confound.
     */
    resolvedControls: trialResolvedControlsSchema.nullable().default(null),
    positivePromptHash: z.string().min(1),
    negativePromptHash: z.string().min(1).nullable(),
    requestedSeed: z.number().int().min(0).nullable(),
  })
  .superRefine((spec, ctx) => {
    const packFields = [
      "packId",
      "packRevision",
      "sourceImageId",
      "sourceContentHash",
      "derivationVersion",
      "policyVersion",
    ] as const;
    if (spec.referenceSource === "pack") {
      if (spec.identityStrategy === null) {
        ctx.addIssue({ code: "custom", path: ["identityStrategy"], message: "a pack-source cell must name a strategy" });
      }
      for (const field of packFields) {
        if (spec[field] === null) {
          ctx.addIssue({ code: "custom", path: [field], message: "a pack-source cell must carry its pack identity" });
        }
      }
      return;
    }
    if (spec.identityStrategy !== null) {
      ctx.addIssue({ code: "custom", path: ["identityStrategy"], message: "the no-pack baseline carries no strategy" });
    }
    for (const field of packFields) {
      if (spec[field] !== null) {
        ctx.addIssue({ code: "custom", path: [field], message: "the no-pack baseline carries no pack identity" });
      }
    }
    if (spec.orderedReferenceRoles.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["orderedReferenceRoles"],
        message: "the no-pack baseline sends no references",
      });
    }
  });
export type ImageIdentityPackTrialCellSpec = z.infer<typeof imageIdentityPackTrialCellSpecSchema>;

/**
 * The two fields a verdict must match against a cell, as a schema of its own.
 *
 * It exists as a separate export rather than a `.pick()` off the spec schema for
 * a hard reason and a soft one. Hard: zod refuses `.pick()` on an object
 * carrying refinements, and the spec schema now carries the pack/baseline
 * cross-field rules. Soft: this read is deliberately LENIENT — a cell refused
 * before full resolution stores an honestly partial spec that fails the whole
 * contract, yet its plan fields (profile and strategy among them) are always
 * present, and a combo the run refused is still a combo the run named.
 */
export const trialCellComboSchema = z.object({
  profileId: z.string().min(1),
  identityStrategy: identityReferenceStrategySchema.nullable(),
});

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
  /**
   * Recorded true when an admin deliberately ruled before every reviewable pair
   * was graded (`review_incomplete` otherwise refuses the verdict). Stored on the
   * ruling itself rather than inferred later: whether the evidence was complete
   * AT DECISION TIME is unrecoverable once more grades arrive, and a promotion
   * made on half the pairs must stay distinguishable from one made on all of
   * them. Defaulted so verdicts written before the gate existed parse as what
   * they were — decisions nobody was asked to override.
   */
  overrideIncompleteReview: z.boolean().default(false),
});
export type TrialVerdict = z.infer<typeof trialVerdictSchema>;

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
 *
 * The four later codes exist because a CONTROLLED trial has to refuse where a
 * production render would degrade:
 *
 * - `version_unpinned` — the exact provider version cannot be identified, so the
 *   cell cannot promise it rendered what it claims. Production may happily run
 *   the model's floating latest; a trial that did would be comparing whatever
 *   the provider shipped that hour.
 * - `spec_invalid` — a planned cell's stored spec is malformed or incompatible
 *   with the current contract. It settles TERMINALLY, is never charged, and is
 *   never sent to a provider: an unreadable cell cannot be executed honestly,
 *   and leaving it `planned` would make every later pass re-pick and re-skip it
 *   forever.
 * - `review_incomplete` — a verdict was refused because the run is not in
 *   review, executable cells remain, or reviewable pairs are still ungraded and
 *   no explicit override was given. A ruling recorded over unseen evidence is
 *   the one failure mode the whole blinded procedure exists to prevent.
 * - `pack_revision_unavailable` — a pinned pack revision does not exist, is no
 *   longer usable, or its selector names a character outside this run.
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
  "version_unpinned",
  "spec_invalid",
  "review_incomplete",
  "pack_revision_unavailable",
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
 * (12 × 6 × 4 × 8 × 4) are wire sanity rails; the real ceiling is the planner's
 * `TRIAL_MAX_CELLS` refusal over the cells actually generated.
 *
 * `packVariants` omitted means one `current` variant, which is exactly the
 * pre-variant behavior — an old stored config still describes the run it ran.
 * The uniqueness refinement is over DERIVED KEYS, not over the objects: two
 * selectors that spell the same variant would silently collapse in the planner
 * and leave the reviewer believing they configured two arms.
 */
export const imageIdentityPackTrialCreateRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    characterIds: z.array(z.string().min(1)).min(1).max(12).optional(),
    corpusId: z.string().trim().min(1).max(120).optional(),
    profileIds: z.array(z.string().min(1)).min(1).max(6),
    strategies: z.array(identityReferenceStrategySchema).min(1).max(4),
    promptFixtureIds: z.array(z.string().min(1)).min(1).max(8),
    packVariants: z.array(trialPackVariantSelectorSchema).min(1).max(4).optional(),
  })
  .refine((value) => (value.characterIds === undefined) !== (value.corpusId === undefined), {
    message: "supply exactly one of characterIds or corpusId",
    path: ["characterIds"],
  })
  .refine(
    (value) => {
      const keys = (value.packVariants ?? []).map((selector) => trialPackVariantKey(selector));
      return new Set(keys).size === keys.length;
    },
    { message: "packVariants must name distinct variants", path: ["packVariants"] },
  );
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

/** Cell counts by status — the progress numbers every run surface shows.
 * `running` is surfaced rather than folded into `planned` because a nonzero
 * count there after a pass ends is the operator's signal that a claim outlived
 * its pass. */
export const trialCellCountsSchema = z.object({
  planned: z.number().int().min(0),
  running: z.number().int().min(0),
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
 * prompt fixture — deliberately no strategy, pack, crop, or pack-variant fields,
 * because the reviewer must not know which reference strategy or which pack
 * revision produced which side (spec.trial.md §"Review procedure"). The pack
 * variant axis changes nothing here on purpose: "this side used the newer pack"
 * would bias a grade exactly as effectively as naming the strategy. The client
 * resolves `promptFixtureId` against the checked-in fixture list to show the
 * instruction being judged.
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
 * One profile's arm-vs-arm aggregate, in canonical A/B space. An "arm" is a
 * (strategy, pack variant) pair, and every comparison here differs in EXACTLY
 * ONE of the two — or has the no-pack baseline (null strategy) on one side.
 * Comparing two cells that differ in both would be a confounded result dressed
 * up as a measurement, so the pairing rule never builds one and no bucket here
 * can contain one.
 *
 * A/B is canonical, not presentation: A is the arm that sorts first (strategy in
 * `identityReferenceStrategies` order with the null baseline last, then variant),
 * so every pair of the same two arms lands in the same bucket rather than
 * splitting across (A vs B) and (B vs A). Wins and losses come from the sign of
 * `overall_preference`; catastrophic counts are total recorded defect labels per
 * side.
 */
export const trialStrategyComparisonSchema = z.object({
  profileId: z.string().min(1),
  /** Null on the no-pack baseline side — it carries no reference strategy. */
  strategyA: identityReferenceStrategySchema.nullable(),
  strategyB: identityReferenceStrategySchema.nullable(),
  variantKeyA: z.string().min(1),
  variantKeyB: z.string().min(1),
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
 *
 * The no-pack baseline never appears here: it has no strategy, so there is
 * nothing for a verdict to rule on. It is evidence, not a verdict slot.
 *
 * `totalPairs`/`gradedPairs` count the pairs this combo takes part in on either
 * side. They ride along so a slot with zero pairs says so out loud — "this
 * ruling has no pairwise evidence" is a fact the reviewer must see BEFORE
 * promoting, and an empty comparison list next to a populated verdict list does
 * not communicate it.
 */
export const trialRenderedComboSchema = z.object({
  profileId: z.string().min(1),
  identityStrategy: identityReferenceStrategySchema,
  renderedCells: z.number().int().min(1),
  totalPairs: z.number().int().min(0),
  gradedPairs: z.number().int().min(0),
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
