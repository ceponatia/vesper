import { z } from "zod";
import { imageReferenceRoleSchema } from "./image-model-capabilities";
import { imageRenderControlsSchema, type ImageRenderControls } from "./image-model-profiles";

/**
 * The Advanced Image Lab's vocabulary and record shapes
 * (docs/developer-notes/qwen-advanced-image-subsystem.spec.md §Contracts).
 *
 * The lab is an admin-only bench: one experiment is one deliberate render whose
 * every input, setting, and outcome is written down, so a question nobody can
 * answer from a provider schema — "does this model actually honour a pose
 * skeleton?" — gets settled by evidence instead of by reading release notes. Its
 * whole reason to exist is that the ordinary lanes must not move while it runs,
 * which is why nothing here reaches the render-intent path: an experiment names
 * its model, its ordered references, and its prompt itself.
 *
 * Two vocabularies are deliberately IMPORTED rather than restated. Reference
 * roles come from `./image-model-capabilities` — a role a lab input can carry and
 * a role a model can be fed must be the same word, or a probe verdict would be
 * about a slot production does not have. Render controls come from
 * `./image-model-profiles` for the same reason: the lab's per-experiment overlay
 * is the normalized control set the profile layer already speaks, not a second
 * spelling of guidance and steps.
 *
 * Everything is pure data and shape. Persistence lives in
 * `src/server/images/image-lab.ts`, extraction in `image-lab-controls.ts`.
 */

/**
 * What one experiment is FOR.
 *
 * Stage 0 uses the first three: `control_probe` answers the plan's opening
 * question (send a pose or depth map as a numbered image and see whether the
 * output obeys it), and the two baselines re-run an ordinary lane's own
 * configuration so a later comparison has a same-settings control to sit beside.
 * The remaining three are declared NOW, unused, because the record shape has to
 * survive Stages 1–3 without a migration — an experiment kind arriving later
 * would otherwise mean altering a column every stored row uses.
 *
 * `schema.ts` imports this tuple for its `text(..., { enum })` column (the
 * `trialRunStatuses` precedent), so the column and the parser cannot drift.
 */
export const imageLabExperimentKinds = [
  "control_probe",
  "baseline_portrait",
  "baseline_scene",
  "controlled_portrait",
  "controlled_scene",
  "finishing_pass",
] as const;
export const imageLabExperimentKindSchema = z.enum(imageLabExperimentKinds);
export type ImageLabExperimentKind = (typeof imageLabExperimentKinds)[number];

/**
 * Which pull an experiment is biased toward when identity and composition
 * compete — the knob the later stages tune, recorded from the start so a Stage 0
 * run can say it chose none.
 *
 * Optional on every Stage 0 experiment: a probe that declared a mode would be
 * claiming a recipe existed to be biased, and none does yet.
 */
export const imageLabModes = ["identity_priority", "controlled_composition", "balanced", "style_priority"] as const;
export const imageLabModeSchema = z.enum(imageLabModes);
export type ImageLabMode = (typeof imageLabModes)[number];

/**
 * The structural control an image carries. `pose` is a skeleton diagram, `depth`
 * a depth map, `edge` a white-on-black edge map.
 *
 * Deliberately NOT the same list as `imageReferenceRoles`: the reference roles
 * say what slot an image occupies in a model's inputs (and already reserve
 * `pose`/`depth`/`control` for exactly this), while these three say what a lab
 * FIXTURE is — what was extracted, how it may be reviewed, and which recipe can
 * use it. An `edge` fixture is fed under the `control` role; collapsing the two
 * would lose that distinction.
 */
export const imageLabControlKinds = ["pose", "depth", "edge"] as const;
export const imageLabControlKindSchema = z.enum(imageLabControlKinds);
export type ImageLabControlKind = (typeof imageLabControlKinds)[number];

/**
 * Where a control fixture came from. Provenance is not decoration here: a
 * skeleton a human drew and a skeleton a preprocessor extracted fail in
 * different ways, and a probe that reads `ignores_control` has to be able to
 * rule out "the fixture was wrong" before it rules on the model.
 */
export const imageLabControlGenerators = [
  "extracted_pose",
  "extracted_depth",
  "computed_edge",
  "hand_authored",
] as const;
export const imageLabControlGeneratorSchema = z.enum(imageLabControlGenerators);
export type ImageLabControlGenerator = (typeof imageLabControlGenerators)[number];

/**
 * The reviewing admin's ruling on a `control_probe`. This is the one fact the
 * whole Stage 0 protocol exists to produce, and no probe of a provider schema
 * can produce it: whether the output limbs match the skeleton is a judgment made
 * by looking at the image.
 *
 * `inconclusive` is a real outcome, not a missing one — a run whose fixture was
 * ambiguous or whose identity collapsed for unrelated reasons says so, rather
 * than being recorded as evidence it is not.
 */
export const imageLabProbeVerdicts = ["honours_control", "ignores_control", "inconclusive"] as const;
export const imageLabProbeVerdictSchema = z.enum(imageLabProbeVerdicts);
export type ImageLabProbeVerdict = (typeof imageLabProbeVerdicts)[number];

/**
 * An experiment's lifecycle position. `pending` has spent nothing, `running` has
 * begun charging the image budget, and the two terminal states are settled by
 * the runner — never by the reviewer, whose verdict is a separate field
 * (a `succeeded` render can still be ruled `ignores_control`).
 */
export const imageLabExperimentStatuses = ["pending", "running", "succeeded", "failed"] as const;
export const imageLabExperimentStatusSchema = z.enum(imageLabExperimentStatuses);
export type ImageLabExperimentStatus = (typeof imageLabExperimentStatuses)[number];

/**
 * Every way a lab run stops, as stable codes (spec §Resilience). Each is a
 * recorded outcome on the experiment row, never a thrown error: the runner
 * settles the row and returns, because a lab experiment that throws through
 * `startJob` leaves an admin staring at a `pending` record with no reason on it.
 *
 * - `input_missing` — the stored `inputs` are absent or no longer parse.
 * - `version_unpinned` — the model's exact provider version cannot be
 *   identified, so the run is refused BEFORE any provider spend. Production may
 *   happily run a floating latest; evidence rendered against an unknown version
 *   answers no question.
 * - `control_invalid` — the named control asset is not a `lab_control`, or its
 *   meta does not parse, so nothing can say what the fixture is.
 * - `preprocessor_output_invalid` — the extractor answered with bytes sharp
 *   could not decode; no asset is written.
 * - `render_failed` — the provider call failed; the render classifier's own code
 *   is recorded alongside.
 */
export const imageLabFailureCodes = [
  "input_missing",
  "version_unpinned",
  "control_invalid",
  "preprocessor_output_invalid",
  "render_failed",
] as const;
export const imageLabFailureCodeSchema = z.enum(imageLabFailureCodes);
export type ImageLabFailureCode = (typeof imageLabFailureCodes)[number];

/** The dotted diagnostic code a lab failure is reported under. */
export function imageLabDiagnosticCode(code: ImageLabFailureCode): string {
  return `image_lab.${code}`;
}

/**
 * A wire sanity rail on how many images one experiment may order, not a model
 * capability: the pinned version's own reference arity is the real ceiling, and a
 * run asking for more than it exposes is refused at render time with the reason.
 */
export const IMAGE_LAB_MAX_INPUTS = 8;

/**
 * One ordered reference an experiment sends.
 *
 * `position` is 1-based because the prompt dialect the lab writes talks about
 * "Image 1" and "Image 2" — a 0-based slot would make the instruction and the
 * payload disagree by one, in the single place where that disagreement is
 * invisible in the output and fatal to the conclusion.
 *
 * `note` is the admin's own annotation ("skeleton drawn over the sofa shot"),
 * carried so a verdict written weeks later can still say what the slot held.
 */
export const imageLabInputSchema = z.object({
  position: z.number().int().min(1).max(IMAGE_LAB_MAX_INPUTS),
  role: imageReferenceRoleSchema,
  imageId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});
export type ImageLabInput = z.infer<typeof imageLabInputSchema>;

/**
 * An experiment's ordered inputs, with the two rules the spec states.
 *
 * **Positions are contiguous from 1 AND match array order.** The looser reading
 * — "the set of positions is {1..n}" — would allow an array whose order
 * disagrees with its own numbering, leaving the runner to choose which of the
 * two orderings it sends. There is no safe choice there: reference order is what
 * the numbered-role prompt is written against, so a shuffled array and its
 * numbering describe two different renders wearing one record. Requiring
 * `position === index + 1` collapses that to one answer.
 *
 * **At most one `identity` role.** Two identity references in Stage 0 would make
 * an unhonoured control unattributable — was the pose ignored, or was the model
 * busy reconciling two faces? The cap is a Stage 0 rule and lives here rather
 * than in the runner so an experiment carrying two can never be stored.
 *
 * An EMPTY list is valid: a baseline experiment resolves the lane's own
 * references itself and orders none.
 */
export const imageLabInputListSchema = z
  .array(imageLabInputSchema)
  .max(IMAGE_LAB_MAX_INPUTS)
  .superRefine((inputs, ctx) => {
    inputs.forEach((input, index) => {
      if (input.position !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: [index, "position"],
          message: "inputs must be numbered contiguously from 1, in array order",
        });
      }
    });
    if (inputs.filter((input) => input.role === "identity").length > 1) {
      ctx.addIssue({ code: "custom", message: "an experiment carries at most one identity reference" });
    }
  });
export type ImageLabInputList = z.infer<typeof imageLabInputListSchema>;

/**
 * Degraded-safe read of an experiment's stored inputs: a malformed list parses
 * to `[]`, which the runner then refuses with `input_missing` rather than
 * rendering against a half-read order (docs/resilience.md §1).
 */
export const imageLabStoredInputListSchema = imageLabInputListSchema.catch((): ImageLabInputList => []);

/**
 * What a `lab_control` asset is, stored in its `images.meta`.
 *
 * It lives in the asset's own meta rather than in a fixtures table because a
 * fixture IS an image — the row already exists, already carries owner and
 * bytes, already rides the sweep — and a parallel table would only add a second
 * thing to keep in step with it.
 *
 * `reviewedAt`/`reviewNote` record the human check the Stage 0 protocol demands
 * before a fixture is used ("extract a pose skeleton and a depth map … review
 * both in the fixtures panel"). Absent means unreviewed, which is a fact the
 * panel shows rather than a default it hides.
 *
 * Unknown keys are dropped, not rejected: `images.meta` is a shared bag that
 * already carries encode metadata, so a strict parse would fail on every real
 * row.
 */
export const imageLabControlMetaSchema = z.object({
  controlKind: imageLabControlKindSchema,
  generator: imageLabControlGeneratorSchema,
  /** The render this fixture was derived from. Absent on a hand-authored skeleton
   * drawn from nothing. */
  sourceImageId: z.string().min(1).optional(),
  preprocessorSlug: z.string().min(1).max(200).optional(),
  preprocessorVersionId: z.string().min(1).max(200).optional(),
  /** ISO instant. Nothing in this module reads a clock. */
  reviewedAt: z.string().min(1).optional(),
  reviewNote: z.string().trim().max(2000).optional(),
});
export type ImageLabControlMeta = z.infer<typeof imageLabControlMetaSchema>;

/**
 * One control fixture as the fixtures panel reads it — ids and metadata only, no
 * bytes and no URLs (the owner reads the pixels through the ordinary image file
 * route, exactly as the trial review UI does).
 */
export const imageLabControlSchema = z.object({
  imageId: z.string().min(1),
  meta: imageLabControlMetaSchema,
  createdAt: z.string().min(1),
});
export type ImageLabControl = z.infer<typeof imageLabControlSchema>;

/** Degraded-safe list: a malformed payload parses to `[]` so one bad fixture
 * empties a slot rather than breaking the admin page. */
export const imageLabControlListSchema = z.array(imageLabControlSchema).catch((): ImageLabControl[] => []);

/**
 * The per-experiment settings overlay.
 *
 * Two layers on purpose. `controls` is the NORMALIZED vocabulary — the same one
 * profiles carry — so a control the pinned version cannot express is dropped
 * with a reason instead of being sent under a guessed field name. `controlInput`
 * is the raw provider-shaped escape hatch merged last, which the lab needs and
 * production does not: settling whether a model honours an undocumented input is
 * precisely the kind of question this bench exists to answer, and it cannot be
 * asked through a vocabulary that predates the answer.
 *
 * Seed and LoRA arrive inside `controls` when their transports exist (the
 * capabilities plan owns both); modelling them now means a seeded rerun is a
 * value change rather than a schema change.
 *
 * Both defaults are THUNKS — zod hands a default through without cloning, so a
 * literal `{}` would be one object shared by every parsed experiment.
 */
export const imageLabSettingsSchema = z.object({
  controls: imageRenderControlsSchema.default((): ImageRenderControls => ({})),
  controlInput: z.record(z.string(), z.unknown()).default((): Record<string, unknown> => ({})),
});
export type ImageLabSettings = z.infer<typeof imageLabSettingsSchema>;

/** The inert overlay: send no normalized control and no raw key — what a Stage 0
 * probe stores, and what `{}` parses to. A function for the reason above. */
export function emptyImageLabSettings(): ImageLabSettings {
  return { controls: {}, controlInput: {} };
}

/** Degraded-safe read of a stored overlay: an unreadable settings bag falls back
 * to the inert one, so a bad row costs the experiment its knobs, not its run. */
export const imageLabStoredSettingsSchema = imageLabSettingsSchema.catch(emptyImageLabSettings);

/**
 * One experiment as the lab's routes report it.
 *
 * Timestamps are ISO strings and `ownerId` is absent, matching
 * `imageIdentityPackTrialRunSummarySchema`: every lab surface is owner-scoped by
 * the route, so the owner id would be a fact the client already knows travelling
 * where it can only leak.
 *
 * `failureCode` is a bounded string rather than {@link imageLabFailureCodeSchema}
 * for the reason the trial's result schema gives: it also carries codes from the
 * render-failure classifier, and freezing the union here would make adding a
 * classifier code a contract change.
 *
 * Everything an unfinished run has not learned yet is nullable — a `pending`
 * experiment has no executed version, no prediction id, no result, and no
 * verdict, and a fabricated placeholder in any of those would be indistinguish-
 * able from a recorded one later.
 */
export const imageLabExperimentSchema = z.object({
  id: z.string().min(1),
  kind: imageLabExperimentKindSchema,
  mode: imageLabModeSchema.nullable().default(null),
  characterId: z.string().min(1).nullable().default(null),
  chatId: z.string().min(1).nullable().default(null),

  modelSlug: z.string().min(1),
  /** The version the experiment ASKED for (the pin resolved at start). */
  requestedVersionId: z.string().min(1).nullable().default(null),
  /** The version the provider says it RAN. A disagreement between the two is what
   * makes an unannounced provider-side bump visible instead of silent. */
  executedVersionId: z.string().min(1).nullable().default(null),
  /** The resolved profile — baselines only; a probe resolves no profile. Stored
   * as a plain id snapshot, so deleting a profile cannot erase what a finished
   * baseline says it ran. */
  profileId: z.string().min(1).nullable().default(null),

  /** What the admin typed. */
  instruction: z.string().default(""),
  /** What was actually sent, recorded by the runner. */
  finalPrompt: z.string().nullable().default(null),

  inputs: imageLabStoredInputListSchema.default((): ImageLabInputList => []),
  controlImageId: z.string().min(1).nullable().default(null),
  controlKind: imageLabControlKindSchema.nullable().default(null),

  settings: imageLabStoredSettingsSchema.default(emptyImageLabSettings),
  resultImageId: z.string().min(1).nullable().default(null),

  status: imageLabExperimentStatusSchema,
  failureCode: z.string().min(1).max(120).nullable().default(null),
  verdict: imageLabProbeVerdictSchema.nullable().default(null),
  verdictNote: z.string().max(2000).nullable().default(null),

  predictionId: z.string().min(1).nullable().default(null),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).nullable().default(null),
  finishedAt: z.string().min(1).nullable().default(null),
});
export type ImageLabExperiment = z.infer<typeof imageLabExperimentSchema>;

/** Degraded-safe list: a malformed payload parses to `[]` (docs/resilience.md §1). */
export const imageLabExperimentListSchema = z.array(imageLabExperimentSchema).catch((): ImageLabExperiment[] => []);

/**
 * The create-experiment request.
 *
 * `modelSlug` is optional because the runner's default is the model the plan is
 * about (`qwen/qwen-image-edit-2511`); naming one is how the fallback connector
 * gets probed if the first verdict is `ignores_control`.
 *
 * Two cross-field rules, both grounded in what the runner must be able to do:
 *
 * - a `baseline_portrait` needs a character (it renders that character's variant
 *   configuration from the canonical avatar) and a `baseline_scene` needs a chat
 *   (it renders through the scene profile from that chat's reference anchor). A
 *   baseline missing its subject is not a baseline, it is a run with nothing to
 *   compare against.
 * - a control image and a control kind travel TOGETHER. Half a pointer is
 *   unreadable: an asset with no declared kind cannot be checked against the
 *   fixture it claims to be, and a kind with no asset names a control that was
 *   never sent.
 *
 * Deliberately NOT enforced here: that a probe carries any particular inputs.
 * Missing inputs are the runner's `input_missing` refusal (spec §Algorithms
 * step 1), recorded on the experiment where the admin can see the reason,
 * instead of a 400 that leaves no trace of the attempt.
 */
export const imageLabCreateExperimentRequestSchema = z
  .object({
    kind: imageLabExperimentKindSchema,
    mode: imageLabModeSchema.optional(),
    modelSlug: z.string().trim().min(1).max(200).optional(),
    characterId: z.string().min(1).optional(),
    chatId: z.string().min(1).optional(),
    instruction: z.string().trim().max(8000).default(""),
    inputs: imageLabInputListSchema.default((): ImageLabInputList => []),
    controlImageId: z.string().min(1).optional(),
    controlKind: imageLabControlKindSchema.optional(),
    settings: imageLabSettingsSchema.optional(),
  })
  .superRefine((request, ctx) => {
    if (request.kind === "baseline_portrait" && request.characterId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["characterId"],
        message: "a portrait baseline names the character it re-runs",
      });
    }
    if (request.kind === "baseline_scene" && request.chatId === undefined) {
      ctx.addIssue({ code: "custom", path: ["chatId"], message: "a scene baseline names the chat it re-runs" });
    }
    if ((request.controlImageId === undefined) !== (request.controlKind === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["controlKind"],
        message: "a control image and its kind are recorded together",
      });
    }
  });
export type ImageLabCreateExperimentRequest = z.infer<typeof imageLabCreateExperimentRequestSchema>;

/**
 * The extract-controls request: one `lab_control_extract` job per source image,
 * producing one fixture per requested kind.
 *
 * Both lists are deduplicated by refusal rather than silently: a request naming
 * `pose` twice would otherwise charge two preprocessor runs and leave two
 * indistinguishable fixtures for the admin to pick between. The `sourceImageIds`
 * cap is a spend rail — extraction is a paid provider call for pose and depth.
 */
export const imageLabExtractControlsRequestSchema = z
  .object({
    sourceImageIds: z.array(z.string().min(1)).min(1).max(4),
    controlKinds: z.array(imageLabControlKindSchema).min(1).max(imageLabControlKinds.length),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((request, ctx) => {
    if (new Set(request.sourceImageIds).size !== request.sourceImageIds.length) {
      ctx.addIssue({ code: "custom", path: ["sourceImageIds"], message: "name each source image once" });
    }
    if (new Set(request.controlKinds).size !== request.controlKinds.length) {
      ctx.addIssue({ code: "custom", path: ["controlKinds"], message: "name each control kind once" });
    }
  });
export type ImageLabExtractControlsRequest = z.infer<typeof imageLabExtractControlsRequestSchema>;

/**
 * The upload-control request — the metadata beside a hand-drawn skeleton's
 * bytes.
 *
 * `generator` is absent on purpose: this route always writes `hand_authored`. A
 * client that could name its own provenance could file a drawing as an
 * extraction, and provenance is exactly what a disputed probe verdict is
 * re-examined against.
 */
export const imageLabUploadControlRequestSchema = z.object({
  controlKind: imageLabControlKindSchema,
  /** What the skeleton was drawn over, when it was drawn over something. */
  sourceImageId: z.string().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});
export type ImageLabUploadControlRequest = z.infer<typeof imageLabUploadControlRequestSchema>;

/**
 * The review-fixture request — the human check the Stage 0 protocol demands
 * before a trial uses a fixture ("extract a pose skeleton and a depth map …
 * review both in the fixtures panel").
 *
 * The note is REQUIRED for the same reason a verdict's is: an unreviewed fixture
 * and one reviewed with nothing written beside it read identically six months
 * later, and "the fixture was wrong" is the first thing an `ignores_control`
 * verdict has to be able to rule out. The cap matches
 * {@link imageLabControlMetaSchema}'s own `reviewNote`, so nothing a client may
 * send is silently truncated on the way into `images.meta`.
 *
 * `reviewedAt` is deliberately ABSENT: the server stamps it from its own clock,
 * because a request that could name its own review time could file today's
 * glance as last week's review, and a fixture's review date is exactly what a
 * disputed verdict is re-examined against.
 */
export const imageLabReviewControlRequestSchema = z.object({
  reviewNote: z.string().trim().min(1).max(2000),
});
export type ImageLabReviewControlRequest = z.infer<typeof imageLabReviewControlRequestSchema>;

/**
 * The record-verdict request. The note is REQUIRED for the reason a trial
 * verdict's reason is: a ruling with nothing written beside it is
 * indistinguishable from a misclick six months later, and this ruling decides
 * whether the whole plan runs on 2511 or on a second registered connector.
 */
export const imageLabRecordVerdictRequestSchema = z.object({
  verdict: imageLabProbeVerdictSchema,
  note: z.string().trim().min(1).max(2000),
});
export type ImageLabRecordVerdictRequest = z.infer<typeof imageLabRecordVerdictRequestSchema>;
