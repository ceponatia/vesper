import {
  filterReservedInputFields,
  mapImageRenderControls,
  validateProviderOverrides,
} from "../capabilities/image-control-mapping";
import { reservedImageInputFields } from "../capabilities/reserved-image-input-fields";
import type { IdentityReferenceRole } from "../identity/identity-pack";
import type { TrialResolvedControls } from "../identity/identity-pack-trial";
import { applyImageLoraPromptAdditions, type ImageLoraRenderBinding } from "../loras/image-loras";
import { chooseAspect, type ImageModel } from "../models/image-models";
import type {
  ImageModelProfile,
  ImageProfileOperation,
  ImagePromptStrategy,
  ImageRenderControls,
  ImageResolutionTier,
} from "../models/image-model-profiles";
import { withReviewedImageQuality } from "../models/quality-presets";
import { compileIdentityReferencePrompt } from "../references/identity-reference-prompt";
import { type CompileReferenceBinding, compileReferenceRolePrompt } from "../references/reference-role-prompt";

/**
 * THE profile compile step: one profile row plus one prompt in, the exact
 * provider-shaped configuration out.
 *
 * Every kind of image the application makes — a portrait, a scene, a variant, a
 * lab experiment, a trial cell — passes through here on its way to a provider.
 * It is written to be adopted rather than re-invented beside: `planImageRender`
 * calls it for its resolved profile and adds only the parts a trial has no use
 * for (reference selection by policy, LoRA resolution, per-request control
 * overrides, image sets).
 *
 * Three properties are load-bearing and are why this lives in ONE function:
 *
 * 1. **What is fingerprinted is what is sent.**
 *    {@link profileRenderControlsFingerprintJson} reads fields taken from the
 *    plan this same call produced, so a field cannot enter the fingerprint
 *    unless it entered the payload. The old trial hash was assembled
 *    independently of the render call and drifted from it immediately.
 * 2. **The EFFECTIVE model is what counts.** `withReviewedImageQuality` rewrites
 *    `extraInput` at the render boundary (Qwen Edit's `go_fast`, PuLID's
 *    `method` pin). Hashing the raw row let that table change the
 *    provider payload with no `cell_conflict` to show for it — a silent change
 *    to what a pinned comparison sends.
 * 3. **Nothing is guessed and nothing is silently dropped.** Controls map only
 *    through the version's probed bindings, and every omission is recorded in
 *    `resolvedControls.droppedControls`, which is itself fingerprinted.
 *
 * Everything it needs arrives as a value. The safety setting in particular is an
 * input rather than an environment read, which is what lets the whole step be
 * exercised with no deployment in the process.
 */

/**
 * The prediction budget a compiled plan falls back to when its profile declares
 * none — the same five minutes `predictionTimeoutMs` defaults to, restated here
 * on purpose.
 *
 * The point is not the number, it is that a compiled plan ALWAYS carries one.
 * `timeoutMs: null` reaching the renderer means "whatever the environment says",
 * and `REPLICATE_PREDICTION_TIMEOUT_MS` can be set to half an hour — so a run
 * whose cells were planned under one deployment could execute under a budget
 * nobody recorded, and the stale-claim window that has to outlast a render would
 * be sized against a bound the env could widen underneath it.
 */
export const TRIAL_FALLBACK_PREDICTION_MS = 5 * 60_000;

/**
 * The longest prediction budget a compiled plan may carry: `imageModelProfiles`'
 * own ceiling (`imageModelProfileSchema.timeoutMs` is `.min(30_000).max(900_000)`,
 * matching the table's check constraint), restated as a clamp rather than
 * assumed.
 *
 * A stored row cannot exceed it today; the clamp is here so that stays true of
 * the PLAN even if a row ever arrived from somewhere the schema did not judge,
 * because everything downstream — the trial's stale-claim window above all —
 * treats this as the hard upper bound on how long one render can legitimately
 * take.
 */
export const MAX_TRIAL_PREDICTION_MS = 900_000;

/**
 * The exact provider version this model row runs, or null when nothing can say.
 *
 * Prefers the probed version id, then a version pinned in the slug itself. When
 * BOTH exist and DISAGREE the answer is null: the stored bindings describe one
 * version while the slug names another, so there is no single version this row
 * can honestly claim to execute, and picking either would be a coin flip
 * recorded as a pin.
 *
 * Null means a CONTROLLED run cannot use this model — the identity trial refuses
 * `version_unpinned` rather than planning a cell against whatever Replicate
 * calls `latest_version` that hour. Production is deliberately unaffected: an
 * ordinary render happily follows the floating latest, because a portrait that
 * came out well is still a portrait, whereas a comparison run against two
 * different versions is not a comparison.
 *
 * Both candidates are TRIMMED before they are judged, and blank counts as
 * absent. `"owner/name:"` and a `probed_version_id` an admin form saved as
 * whitespace are both "nothing pins this row" wearing a non-null value, and a
 * cell that pinned `" "` would post an empty `version` to the provider and then
 * re-check successfully against its own blank.
 */
export function pinnedImageModelVersion(model: ImageModel): string | null {
  const probed = nonBlank(model.probedVersionId);
  const pinned = nonBlank(model.slug.split(":")[1]);
  if (probed !== null && pinned !== null) return probed === pinned ? pinned : null;
  return probed ?? pinned;
}

/** A trimmed value, or null when it was absent or all whitespace. */
function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Which reference vocabulary a compile is speaking, and its roles in SEND order
 * — the same order the buffers travel in.
 *
 * Two vocabularies exist because two different things need naming, and they must
 * not be conflated. `identity_pack` is the trial's pair of identity references
 * (`canonical_identity`, `face_detail`), whose whole comparison is which one
 * comes first, so the compiled text has to say which image is which.
 * `render_intent` is the production lanes' general role vocabulary (identity,
 * location, style, object…), where the lane's own prompt builder ALREADY names
 * its references — the scene builder writes the multi-reference bindings for a
 * scene, and a family that addresses references by number (Qwen Edit) applies
 * its own lock through the injected {@link ImagePromptPreparer} on the way out.
 *
 * So the vocabulary decides whether the strategy prefixes anything at all. It is
 * a discriminated union rather than a widened role array because those two
 * answers are genuinely different, and a single array would force the compiler
 * to guess which naming convention a caller meant from the role names alone.
 *
 * The two arms carry different SHAPES as well as different role vocabularies:
 * the identity-pack arm is a role list, and the render-intent arm is a list of
 * {@link CompileReferenceBinding}. The asymmetry is real rather than untidy — a
 * render-intent send can hold two references of one role and needs a per-slot
 * name to keep them apart, while the identity pack's roles are distinct by
 * construction (`canonical_identity` and `face_detail` are one slot each) and a
 * subject on either would name the one person both already depict.
 */
export type PromptReferenceBinding =
  | { vocabulary: "identity_pack"; roles: readonly IdentityReferenceRole[] }
  | { vocabulary: "render_intent"; references: readonly CompileReferenceBinding[] };

/**
 * How many references this binding names, whichever arm it is.
 *
 * Handed to the {@link ImagePromptPreparer}, whose dialects choose between "the
 * reference image" and numbered bindings from the COUNT alone — so the two arms
 * have to answer it the same way even though they store their references
 * differently.
 */
function referenceBindingCount(references: PromptReferenceBinding): number {
  switch (references.vocabulary) {
    case "identity_pack":
      return references.roles.length;
    case "render_intent":
      return references.references.length;
  }
}

/**
 * The dimension resolver's input facts, resolved where the merged controls live
 * and carried on the plan so `renderWithModel`
 * can hand them to `chooseDimensions` without re-deriving any merge or mapping.
 *
 * These are INPUTS, not a choice: the shape itself is negotiated at the
 * transport wrapper against the lane's target ratio, which this step does not
 * know (see {@link ProfileRenderPlan.aspectValue} for why). A caller that
 * passes none of these — the trial, the lab's direct probes — gets the pure
 * `chooseAspect` behavior, which is also what these facts resolve to when the
 * profile sets no dimension control.
 */
export interface ImageRenderDimensionFacts {
  /** The profile's declared operation, for the future per-operation size rules. */
  operation: ImageProfileOperation;
  /** The merged tier request (defaults, then the render's override). */
  resolution?: ImageResolutionTier;
  width?: number;
  height?: number;
  /**
   * The explicit pair as it actually reached the payload through the version's
   * `customWidth`/`customHeight` bindings — null when either half dropped.
   * Resolved HERE because only this step sees the mapper's verdict; the
   * resolver takes it as a fact rather than re-running binding logic.
   */
  mappedCustomSize: { width: number; height: number } | null;
}

/**
 * The model-boundary prompt step: the last chance to say the same thing in a
 * particular model family's dialect, applied to the finished text.
 *
 * A function type rather than a direct call so the knowledge of HOW a family
 * wants to be spoken to can live with that family instead of here. The kernel
 * knows there is a dialect step; it must never know which slug needs which
 * sentence, because that is exactly the slug-checking-in-shared-code the adapter
 * work exists to end.
 *
 * The contract a preparer must keep is IDEMPOTENCE. This step runs here, where
 * the result is fingerprinted, and again in the transport on the way out; a
 * preparer whose second pass changes the text makes every pinned comparison
 * refuse `cell_conflict` against its own compiled prompt.
 *
 * `referenceCount` is how many references this render actually sends — the fact
 * a dialect needs to choose between "the reference image" and numbered bindings.
 */
export type ImagePromptPreparer = (model: ImageModel, prompt: string, referenceCount: number) => string;

export interface CompileProfileRenderPlanInput {
  model: ImageModel;
  profile: ImageModelProfile;
  /** The lane's or fixture's prompt, BEFORE the profile's prompt strategy compiles it. */
  basePrompt: string;
  /** The caller's negative prompt; null falls back to the profile's default. */
  baseNegativePrompt: string | null;
  /**
   * Whether this deployment bypasses the provider's safety checker — the value
   * the payload builder will apply at send time, handed in rather than read.
   *
   * REQUIRED even for a model that exposes no such provider field. Forgetting a
   * deployment-owned enforcement fact must be a compile error rather than a
   * silent default: the value is fingerprinted, so a plan that guessed it would
   * claim a safety posture the render did not run under. It is still only
   * APPLIED where the model's `extraInput` already declares the key
   * ({@link withResolvedSafetyChecker}) — a model whose schema does not have the
   * input is never handed one.
   */
  safetyCheckerDisabled: boolean;
  /**
   * Per-render controls, merged OVER the profile's stored defaults — a later
   * layer wins. This is the request half of the control vocabulary:
   * a profile says what its job normally needs, a render says what this one
   * needs. Absent — which is every caller today — leaves the profile's defaults
   * exactly as they were.
   *
   * A control here still has to survive mapping: an override for a field the
   * active version does not expose is dropped with a reason, never guessed onto
   * a field name that looks close.
   */
  controlOverrides?: ImageRenderControls;
  /** The references this render sends, in order, and which vocabulary names them. */
  references: PromptReferenceBinding;
  /**
   * A library LoRA already resolved against this model, version and task
   * (`resolveImageLoraForRender`) — never the raw `controls.lora` selection,
   * which this step has no library to check.
   *
   * It contributes to BOTH halves of the compile: the locator and scale become
   * provider fields through the mapper, and the row's prompt additions are woven
   * into the text below. That is why it is one input rather than two — a plan
   * whose payload carried the weights while its prompt lacked the trigger words
   * would render at a strength nobody could explain from the recorded text.
   */
  resolvedLora?: ImageLoraRenderBinding;
  /**
   * The model-dialect prompt step ({@link ImagePromptPreparer}).
   *
   * Absent means NO DIALECT — the compiled text reaches the provider exactly as
   * the strategy wrote it. That is the honest default because this package
   * cannot know which family a model belongs to: dialects live in
   * `@vesper/image-models`, which sits ABOVE this one, and an upward import is
   * the one thing the layering forbids. So the application resolves the adapter
   * and injects its preparer here; a model whose family has no adapter yet is
   * the ordinary case and compiles unchanged.
   */
  preparePrompt?: ImagePromptPreparer;
}

/**
 * One compiled render: the model that will actually run, the exact text that
 * will be sent, and the provider-shaped controls that will accompany it.
 */
export interface ProfileRenderPlan {
  /** The model AFTER the reviewed-quality seam — what the provider really sees. */
  effectiveModel: ImageModel;
  /** The final prompt text, strategy-compiled preamble and model-dialect rewrite included. */
  finalPrompt: string;
  /**
   * The negative text that WILL be sent, or null — counting BOTH routes it can
   * travel: a mapped control/override on the version's negative binding, and the
   * model row's own `extraInput` constant, which the payload builder copies
   * through with no binding involved ({@link resolvedNegativePrompt}). Null
   * covers "no negative was configured", "this version exposes no
   * negative-prompt field", and the reviewed-quality rows' deliberate `""`,
   * because from the render's point of view those are one fact: nothing goes.
   * Which of them applied survives in `resolvedControls.droppedControls`.
   */
  negativePrompt: string | null;
  /**
   * The aspect value `chooseAspect` picks at Vesper's DEFAULT 3:4 target, or null
   * when the model offers none.
   *
   * The default is baked in because the caller this field exists for — the
   * trial's control fingerprint — only ever renders 3:4. `renderImageIntent`
   * ignores it and negotiates the shape against its own target instead, since the
   * entity and place lanes ask for 1:1 and 3:2. Read this as "the shape a 3:4
   * render of this profile would use", not "the shape this plan will produce".
   */
  aspectValue: string | null;
  /** The dimension resolver's input facts — see {@link ImageRenderDimensionFacts}. */
  dimensionFacts: ImageRenderDimensionFacts;
  /** Mapped controls plus validated overrides, keyed by provider field name. */
  controlInput: Record<string, unknown>;
  /**
   * The `controlInput` fields a TYPED semantic control produced — written by
   * the normalized mapper and not replaced by the raw override bag. The strict
   * provider-input validator trusts a URI/array-shaped value only under a
   * field a typed transport owns; passing this set is how a curated LoRA's
   * probed weights field earns that trust while a raw advanced value never
   * does. Sorted, so two identical plans state the set identically.
   */
  typedControlFields: readonly string[];
  /**
   * The controls this render actually honors, keyed by NORMALIZED name — the
   * record a caller stores as provenance. Reserved-field collisions are already
   * removed (an entry here was really sent), each payload-mapped value is read
   * back out of the FINAL payload so an override that replaced a mapped value is
   * reported as what went, and the LoRA entry is the mapper's `{ id, scale }` —
   * never the locator. ONE entry is applied outside the payload: a size-mode
   * model's `resolution` tier, which the dimension resolver consumes via
   * `dimensionFacts` rather than a provider field. Deliberately NOT
   * fingerprinted: `profileRenderControlsFingerprintJson` already carries
   * `controlInput`, the drops, and the dimension request.
   */
  appliedControls: Record<string, unknown>;
  /** The auditable record of the above, drops included. */
  resolvedControls: TrialResolvedControls;
  /**
   * The prediction budget this plan WILL be run under — always a number, never
   * "ask the environment". The profile's own `timeoutMs` when it has one,
   * {@link TRIAL_FALLBACK_PREDICTION_MS} when it does not, clamped to
   * {@link MAX_TRIAL_PREDICTION_MS}. Being explicit is the whole point: an
   * env-resolved budget is a budget the compiled plan cannot state, cannot
   * fingerprint, and cannot be bounded by.
   */
  timeoutMs: number;
  /** The pinned provider version, or null when this row has none. */
  versionId: string | null;
}

/**
 * A compiled plan, or the typed refusal that says this compile cannot honestly
 * produce one.
 *
 * A refusal rather than a throw because every caller has somewhere honest to put
 * it: the trial planner records the cell `profile_ineligible` and spends
 * nothing, the execute-time recompile records `cell_conflict`, and
 * `planImageRender` turns it into an `ImageRenderRefusal`. An exception would
 * have made an ordinary, expected configuration state indistinguishable from a
 * bug.
 *
 * Two reasons exist, and they are not the same kind of fact:
 *
 * - `unsupported_prompt_strategy` — the profile declares a strategy this path
 *   has no vocabulary for. A CONFIGURATION problem an operator fixes.
 * - `lora_binding_not_sent` — the plan would have claimed a LoRA that its own
 *   payload does not carry. An INVARIANT breach: it means the compile and the
 *   record disagree, and the only safe outcome is to spend nothing.
 *
 * Discriminated on `reason`, so a caller reads the arm it is handling rather
 * than reaching for a field the other arm does not have.
 */
export type CompileProfileRenderPlanResult =
  | { ok: true; plan: ProfileRenderPlan }
  | { ok: false; reason: "unsupported_prompt_strategy"; promptStrategy: ImagePromptStrategy }
  | { ok: false; reason: "lora_binding_not_sent"; message: string; missingField: string };

/** A strategy's compiled prompt text, or its refusal to compile one at all. */
type StrategyPromptCompile = { ok: true; prompt: string } | { ok: false };

/**
 * THE prompt-strategy dispatch — a strategy is an enum resolved through a code
 * registry, never prompt logic stored in a row.
 *
 * It is a switch, not a registry framework, and deliberately so: three of the
 * seven strategies have an implementation here, four have none, and a framework
 * built around one honest arm and four empty ones would advertise a generality
 * that does not exist. The switch is EXHAUSTIVE over
 * {@link ImagePromptStrategy}, which is what makes an eighth strategy a compile
 * error here rather than a silent fall-through to whatever the last arm did.
 *
 * Why the arms land where they do:
 *
 * - `instruction_edit` / `text_to_image_description` name no references
 *   themselves; the numbered binding is added only when two or more references
 *   need disambiguating, which is the historical behavior every lane already
 *   renders under.
 * - `multi_reference_compose` explicitly names the purpose and order of EACH
 *   reference, so it binds from ONE reference upward. That is what makes the
 *   strategy genuinely change the compiled text relative to `instruction_edit`
 *   at a single reference — before this dispatch existed, `promptStrategy` was
 *   fingerprinted but never consulted, so two profiles differing only in
 *   strategy claimed different configurations and sent identical prompts.
 * - `text_repair`, `example_transform`, `style_render` and `coherent_set` REFUSE.
 *   Each needs a contract the identity-reference vocabulary does not carry — a
 *   text region and its replacement, a before/after role pair, curated style and
 *   LoRA language, the ordered image-set path — and compiling one of them out of
 *   an identity fixture would produce a prompt that is not the strategy it
 *   claims to be. Failing closed keeps an unexecutable configuration out of a
 *   grid instead of grading a made-up one.
 */
function compilePromptForStrategy(
  strategy: ImagePromptStrategy,
  basePrompt: string,
  references: PromptReferenceBinding,
): StrategyPromptCompile {
  switch (references.vocabulary) {
    case "identity_pack":
      return compileIdentityPackPrompt(strategy, basePrompt, references.roles);
    case "render_intent":
      return compileRenderIntentPrompt(strategy, basePrompt, references.references);
  }
}

/** The identity-pack arm: numbered bindings for the trial's canonical/face pair. */
function compileIdentityPackPrompt(
  strategy: ImagePromptStrategy,
  basePrompt: string,
  roles: readonly IdentityReferenceRole[],
): StrategyPromptCompile {
  switch (strategy) {
    case "instruction_edit":
    case "text_to_image_description":
      return { ok: true, prompt: compileIdentityReferencePrompt({ basePrompt, roles }) };
    case "multi_reference_compose":
      return { ok: true, prompt: compileIdentityReferencePrompt({ basePrompt, roles, nameEveryReference: true }) };
    case "text_repair":
    case "example_transform":
    case "style_render":
    case "coherent_set":
      return { ok: false };
  }
}

/**
 * The production arm: the lane's prompt, unchanged.
 *
 * The two strategies every seeded profile carries add NOTHING here, and that is
 * the correct answer rather than a gap. A production reference is already named
 * by whoever built the prompt — the scene builder writes its own numbered
 * multi-reference bindings, the variant and look builders write an identity lock
 * — so prefixing a second set of bindings would rewrite renders that work today
 * and describe the same image twice, in two conventions.
 *
 * `multi_reference_compose` COMPILES here, which it could not before: its
 * defining semantic is naming the purpose and order of each reference, and
 * this vocabulary had no wording for that, so the only honest answer was refusal
 * — returning the base prompt would have let a profile claim the composing
 * strategy while sending text identical to `instruction_edit`.
 * {@link compileReferenceRolePrompt} is that wording.
 *
 * The two non-composing arms ignore the bindings' subjects along with everything
 * else about them, which is correct rather than lossy: neither names a reference
 * at all, so there is no sentence for a subject to appear in, and inventing one
 * here would rewrite every live render that runs `instruction_edit`.
 */
function compileRenderIntentPrompt(
  strategy: ImagePromptStrategy,
  basePrompt: string,
  references: readonly CompileReferenceBinding[],
): StrategyPromptCompile {
  switch (strategy) {
    case "instruction_edit":
    case "text_to_image_description":
      return { ok: true, prompt: basePrompt };
    case "multi_reference_compose":
      return { ok: true, prompt: compileReferenceRolePrompt({ basePrompt, references }) };
    case "text_repair":
    case "example_transform":
    case "style_render":
    case "coherent_set":
      return { ok: false };
  }
}

/**
 * Compile one profile against one model and prompt.
 *
 * The pipeline follows one resolution order, for the steps a single-image
 * render needs: reviewed-quality model, strategy-compiled prompt, model-dialect
 * prompt preparation, negative resolution, control mapping, override
 * validation, aspect choice, version pin.
 *
 * The FIRST step is the profile's declared `promptStrategy`
 * ({@link compilePromptForStrategy}), and it is the one step that can refuse.
 * That ordering is the point: a strategy this path cannot execute must stop the
 * compile before anything downstream produces controls, fingerprints, or a plan
 * that a caller could mistake for a runnable one.
 *
 * The dialect step runs HERE and again inside the transport's render call. That
 * is deliberate and safe because {@link ImagePromptPreparer} makes idempotence a
 * CONTRACT: a family's rewrite leaves an already-rewritten prompt byte-identical,
 * so the text fingerprinted here is byte-for-byte the text the provider
 * receives. Relying on that property beats adding an "already prepared" flag
 * whose two code paths would need keeping honest forever.
 *
 * The LAST step is the final-wire LoRA invariant
 * ({@link loraWireInvariantBreach}), which is the second of the two ways this
 * function can refuse.
 */
export function compileProfileRenderPlan(input: CompileProfileRenderPlanInput): CompileProfileRenderPlanResult {
  const { model, profile, basePrompt, baseNegativePrompt, references } = input;
  const strategyPrompt = compilePromptForStrategy(profile.promptStrategy, basePrompt, references);
  if (!strategyPrompt.ok) {
    return { ok: false, reason: "unsupported_prompt_strategy", promptStrategy: profile.promptStrategy };
  }
  const effectiveModel = withResolvedSafetyChecker(withReviewedImageQuality(model), input.safetyCheckerDisabled);
  // The LoRA's prompt additions are woven HERE — after the strategy has produced
  // its text, before the model-dialect rewrite and before anything is
  // fingerprinted — so `finalPrompt` is the whole truth about what the provider
  // will read. Doing it at the transport instead would leave a prompt in the
  // record that nobody sent, and doing it before the strategy would let a
  // numbered-reference preamble be pushed below the LoRA's own prefix.
  const loraPrompt = applyImageLoraPromptAdditions(strategyPrompt.prompt, input.resolvedLora);
  // The dialect step, or none. There is no dialect without an injected preparer
  // — model dialects live in the adapter package, one layer up — so the default
  // is the identity function rather than a slug check this package would have to
  // keep in step with a registry it cannot see.
  const finalPrompt = input.preparePrompt
    ? input.preparePrompt(effectiveModel, loraPrompt, referenceBindingCount(references))
    : loraPrompt;

  const defaults = profile.controlDefaults;
  const requested = input.controlOverrides;
  // `baseNegativePrompt` is the fixture channel and `controls.negativePrompt` the
  // request channel; both are the CALLER's negative, and no caller sets both, so
  // the order between them is arbitrary and only the fall-through to the
  // profile's default is load-bearing.
  const negative = baseNegativePrompt ?? requested?.negativePrompt ?? defaults.negativePrompt ?? null;
  const outputCount = requested?.outputCount ?? defaults.outputCount;

  // The profile's stored defaults with the request's overrides merged over them
  // — a later layer wins between those two layers. Written as a
  // plain member-by-member merge because an `undefined` member and an absent one
  // are the same thing to `mapImageRenderControls`: it skips every control whose
  // value is undefined, so nothing here reaches a payload uninvited.
  //
  // `seedPolicy` is deliberately absent: it is a POLICY, not a value to send.
  // Resolving it into a number is the CALLER's job (`renderImageIntent` draws
  // the random seed and passes it as `controlOverrides.seed`), because this
  // step is pure and a compile that rolled its own dice could never be
  // fingerprinted. A policy that arrived here unresolved is recorded as a DROP
  // below — "this run was not seeded" is a fact the comparison fingerprint must
  // carry.
  const controls: ImageRenderControls = {
    seed: requested?.seed,
    negativePrompt: negative ?? undefined,
    guidance: requested?.guidance ?? defaults.guidance,
    steps: requested?.steps ?? defaults.steps,
    editStrength: requested?.editStrength ?? defaults.editStrength,
    // `outputCount` is deliberately NOT here — see the drop recorded below.
    coherentSet: requested?.coherentSet ?? defaults.coherentSet,
    thinkingMode: requested?.thinkingMode ?? defaults.thinkingMode,
    resolution: requested?.resolution ?? defaults.resolution,
    width: requested?.width ?? defaults.width,
    height: requested?.height ?? defaults.height,
    lora: requested?.lora ?? defaults.lora,
  };

  // Which dimension controls the MAPPER may see. Two rules, both about honesty:
  //
  // - On a size-mode model the resolution tier belongs to the DIMENSION
  //   RESOLVER, not the control mapper: the enum entries ARE the sizes, and
  //   `chooseSizeDimensions` consumes the tier via `dimensionFacts` to pick
  //   among them. Handing it to the mapper as well either sent a second copy
  //   through a probed binding or — when that binding is the reserved `size`
  //   key itself — recorded a `reserved` drop for a control that WAS applied.
  //   On aspect-ratio models the tier stays an ordinary binding-mapped control.
  // - `width`/`height` are honored ONLY when `resolution` is `custom`. The pair
  //   is the request exactly when the tier says so; mapped beside a named tier,
  //   leftover dimension defaults would silently outrank the tier the profile
  //   asked for. Excluded here and recorded below as `requires_custom_resolution`.
  const sizeModeTier = effectiveModel.aspectMode === "size" && controls.resolution !== undefined;
  const customPairRequested = controls.resolution === "custom";
  const mapperControls: ImageRenderControls = {
    ...controls,
    ...(sizeModeTier ? { resolution: undefined } : {}),
    ...(customPairRequested ? {} : { width: undefined, height: undefined }),
  };

  const reservedFields = reservedImageInputFields(effectiveModel);
  const mapped = mapImageRenderControls({
    controls: mapperControls,
    capabilities: effectiveModel.advancedCapabilities,
    // Only the three facts a payload needs. The label and the prompt additions
    // stay out: they have already done their work above, and a locator in the
    // mapper's `applied` record is the one thing a stored control set must not
    // carry.
    ...(input.resolvedLora
      ? {
          resolvedLora: {
            id: input.resolvedLora.id,
            locator: input.resolvedLora.locator,
            scale: input.resolvedLora.scale,
          },
        }
      : {}),
  });
  // A mapped control can land on a reserved field — `resolutionTier` is commonly
  // probed as `size`, which IS the shape key on a size-mode model — and the
  // transport would then discard it on the way out. Filtering here rather than
  // letting that happen is what keeps the recorded payload equal to the sent
  // one; a control the fingerprint claims was sent and the provider never saw is
  // the exact drift this compile step exists to make impossible.
  const sendableMapped = filterReservedInputFields(mapped.input, reservedFields);
  // A RESOLVED LoRA owns its bound provider fields for this render (owner
  // ruling 2026-08-24): the whole point of the wire invariant below is that the
  // recorded LoRA identity IS the sent LoRA identity, and an override replacing
  // `lora_weights` under a record naming the library row would ship LoRA B
  // labeled as LoRA A. The fields join the override validator's reserved set —
  // never the mapper's filter, which is what legitimately WRITES them — so a
  // colliding override is dropped with the ordinary recorded reason. Without a
  // resolved LoRA the fields stay ordinary advanced inputs: the escape hatch
  // only closes when there is a record it could falsify.
  const loraOwnedFields = input.resolvedLora
    ? [
        effectiveModel.advancedCapabilities.controls.loraWeights?.field,
        effectiveModel.advancedCapabilities.controls.loraScale?.field,
      ].filter((field): field is string => field !== undefined)
    : [];
  const overrides = validateProviderOverrides(
    profile.providerOverrides,
    effectiveModel.advancedCapabilities.knownInputFields,
    [...reservedFields, ...loraOwnedFields],
  );
  // Overrides merge LAST, because a later layer wins. They therefore
  // may also replace a mapped control's value — except a resolved LoRA's own
  // fields, reserved above — which is why the reported negative below is read
  // back out of the FINAL payload rather than from the mapping step: a
  // fingerprint that described the pre-override text would be a fingerprint of
  // something the provider never saw.
  const controlInput = { ...sendableMapped.input, ...overrides.input };
  // The provider fields a TYPED semantic control produced — mapper-written and
  // not replaced by the raw bag. The strict validator trusts a URI/array-shaped
  // value only under a field a typed transport owns, and this set is how a
  // curated LoRA's weights field earns that trust while a raw advanced value
  // never does (owner ruling 2026-08-24).
  const typedControlFields = Object.keys(sendableMapped.input)
    .filter((field) => !(field in overrides.input))
    .sort();

  // The normalized provenance record, kept consistent with the two adjustments
  // above by the same two rules: an entry whose provider field the reserved
  // filter refused is removed (it was never sent), and a surviving single-field
  // value is read back out of the FINAL payload so an override that replaced it
  // is reported as what went. The LoRA entry keeps the mapper's own record —
  // its two fields carry the locator and the scale, and the locator must never
  // enter a stored value.
  const reservedDrops = new Set(sendableMapped.dropped.map((entry) => entry.control));
  const appliedControls: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mapped.applied)) {
    const fields = mapped.appliedFields[name] ?? [];
    if (fields.some((field) => reservedDrops.has(field))) continue;
    const [field] = fields;
    appliedControls[name] =
      name !== "lora" && field !== undefined && field in controlInput ? controlInput[field] : value;
  }
  // A size-mode tier IS applied — through the dimension resolver, which reads it
  // off `dimensionFacts` below, not through a payload field. Recording it here
  // keeps the provenance record equal to what the render honors; recording a
  // drop for it would claim the request was refused while the size it chose ships.
  if (sizeModeTier) appliedControls.resolution = controls.resolution;

  // The one point where the payload and the record of it both exist, and
  // therefore the only place their agreement about the LoRA can be enforced.
  const loraWireBreach = loraWireInvariantBreach(effectiveModel, controlInput, appliedControls, input.resolvedLora);
  if (loraWireBreach) return loraWireBreach;

  // Typed as the contract's own list rather than the mapper's narrower union:
  // the notes below are this layer's facts, not ones the mapper can produce.
  const droppedControls: TrialResolvedControls["droppedControls"] = [
    ...mapped.dropped,
    ...sendableMapped.dropped,
    ...overrides.dropped,
  ];
  // The custom gate's record: a width/height the merge produced under a
  // non-custom resolution never reached the mapper (see `mapperControls`), and
  // "this pair was set but the tier outranks it" is a fact the fingerprint must
  // carry — silently ignoring it would make two different configurations hash alike.
  if (!customPairRequested) {
    if (controls.width !== undefined) droppedControls.push({ control: "width", reason: "requires_custom_resolution" });
    if (controls.height !== undefined) {
      droppedControls.push({ control: "height", reason: "requires_custom_resolution" });
    }
  }
  if (outputCount !== undefined) {
    // This compile step serves the SINGLE-IMAGE path. A profile asking for four
    // outputs would be billed for four and graded on one, so the count never
    // travels — and the request is recorded as a drop rather than silently
    // reinterpreted as 1, because "this profile wanted a set" is a real
    // difference between two configurations and the fingerprint must carry it.
    droppedControls.push({ control: "outputCount", reason: "single_image_path" });
  }
  if (defaults.seedPolicy !== "random" && controls.seed === undefined) {
    // A non-random policy that no caller resolved into a number: `reuse_source`
    // with no recorded source seed, `caller` with no seed supplied. Recorded
    // rather than quietly ignored — and ONLY when unresolved, because a run
    // that did get its seed must not report the policy as unmet beside the very
    // value that met it. (`random` drops nothing either way: an unseeded random
    // run is what sending no seed key already does at every provider.) The
    // reason string predates the seed transport and is kept verbatim: it is
    // part of stored trial fingerprints, and renaming it would conflict every
    // pinned cell that ever carried it.
    droppedControls.push({ control: "seedPolicy", reason: "no_seed_transport" });
  }

  // The custom pair only counts when BOTH halves survived mapping AND the
  // reserved filter — `appliedControls` is exactly that record, its values read
  // back out of the final payload so an override that replaced a mapped
  // dimension is the number reported. The typeof guards matter because an
  // override CAN write a non-number over a mapped width; a half-mapped or
  // nonsense pair is no pair, and the model's own shape answer stands.
  const mappedWidth = appliedControls.width;
  const mappedHeight = appliedControls.height;
  const dimensionFacts: ImageRenderDimensionFacts = {
    operation: profile.operation,
    ...(controls.resolution === undefined ? {} : { resolution: controls.resolution }),
    ...(controls.width === undefined ? {} : { width: controls.width }),
    ...(controls.height === undefined ? {} : { height: controls.height }),
    mappedCustomSize:
      typeof mappedWidth === "number" && mappedWidth > 0 && typeof mappedHeight === "number" && mappedHeight > 0
        ? { width: mappedWidth, height: mappedHeight }
        : null,
  };

  const timeoutMs = Math.min(profile.timeoutMs ?? TRIAL_FALLBACK_PREDICTION_MS, MAX_TRIAL_PREDICTION_MS);
  return {
    ok: true,
    plan: {
      effectiveModel,
      finalPrompt,
      negativePrompt: resolvedNegativePrompt(effectiveModel, controlInput),
      aspectValue: chooseAspect(effectiveModel).value,
      dimensionFacts,
      controlInput,
      typedControlFields,
      appliedControls,
      resolvedControls: {
        operation: profile.operation,
        // The RESOLVED budget, not the profile's wish: this column answers "what
        // was this cell run under?", and a null there answered "look at whatever
        // env the machine had at the time", which is not an answer.
        timeoutMs,
        controlInput,
        droppedControls,
      },
      timeoutMs,
      versionId: pinnedImageModelVersion(model),
    },
  };
}

/** The wire-invariant arm of {@link CompileProfileRenderPlanResult}. */
type LoraWireRefusal = Extract<CompileProfileRenderPlanResult, { reason: "lora_binding_not_sent" }>;

/**
 * THE final-wire LoRA invariant: a plan may claim an applied LoRA only if its
 * own payload carries both bound provider fields.
 *
 * It exists because the opposite was true for the whole life of the LoRA
 * library and nothing noticed: across the entire retained provider history, not
 * one prediction ever carried `lora_weights`, while unit tests, records and
 * fingerprints all agreed a LoRA had been applied. Every layer was checked
 * against its neighbour; nothing checked the payload against the record.
 *
 * So the check lives HERE, at the single point where both artifacts exist and
 * are final — `controlInput` after mapping, reserved filtering and overrides,
 * and `appliedControls` after the same three. Scattering it (the mapper asserts
 * it wrote the fields, the caller asserts the record) is how the drift got in:
 * each half was locally right.
 *
 * One comparison enforces BOTH directions of the invariant, because they are the
 * same statement read from either end — "recorded implies sent" and "not sent
 * implies not recorded" are contrapositives. A recorded LoRA whose fields are
 * missing REFUSES pre-spend; a LoRA whose fields never reached the payload has
 * already had its record removed upstream (the mapper drops it with a reason,
 * and the reserved filter takes its `appliedControls` entry with it), and this
 * gate is what makes that removal load-bearing rather than incidental.
 *
 * `missingField` names the PROVIDER field when the version declares one and the
 * binding name when it declares none at all — those are the two different fixes:
 * find out why the payload lost a field it had, or stop expecting a LoRA from a
 * version that has nowhere to put one.
 *
 * Presence is not the invariant — IDENTITY is (owner ruling 2026-08-24): the
 * payload's values must EQUAL the resolved binding's own locator and scale,
 * because "some value existed in a field called `lora_weights`" is exactly the
 * kind of locally-true claim that let the original drift live. The override
 * reserve above makes a mismatch unreachable through any legitimate path; this
 * gate is what turns "unreachable" into "refused", so a future path that
 * reopens it costs a pre-spend refusal rather than a mislabeled render.
 *
 * Deliberately silent when nothing recorded a LoRA: a payload field written by a
 * profile's provider overrides is that escape hatch working as designed — the
 * hatch only closes when there is a resolved LoRA whose record it could falsify.
 */
function loraWireInvariantBreach(
  model: ImageModel,
  controlInput: Record<string, unknown>,
  appliedControls: Record<string, unknown>,
  resolvedLora: CompileProfileRenderPlanInput["resolvedLora"],
): LoraWireRefusal | null {
  const applied = appliedControls.lora;
  if (applied === undefined) return null;

  const bindings = model.advancedCapabilities.controls;
  const missingField = missingLoraWireField(bindings.loraWeights?.field, bindings.loraScale?.field, controlInput);
  if (missingField !== null) {
    return {
      ok: false,
      reason: "lora_binding_not_sent",
      missingField,
      message: `plan records LoRA ${appliedLoraId(applied)} as applied, but the compiled payload carries no ${missingField}`,
    };
  }
  if (resolvedLora !== undefined) {
    const weightsField = bindings.loraWeights?.field;
    const scaleField = bindings.loraScale?.field;
    const mismatched =
      weightsField !== undefined && controlInput[weightsField] !== resolvedLora.locator
        ? weightsField
        : scaleField !== undefined && controlInput[scaleField] !== resolvedLora.scale
          ? scaleField
          : null;
    if (mismatched !== null) {
      return {
        ok: false,
        reason: "lora_binding_not_sent",
        missingField: mismatched,
        message: `plan records LoRA ${appliedLoraId(applied)} as applied, but the compiled payload carries a different ${mismatched} than the resolved binding's own value`,
      };
    }
  }
  return null;
}

/**
 * Which half of the binding is missing from the payload, or null when both are
 * really there. `undefined` for a field name means the version declares no such
 * binding, which is reported under the binding's own name.
 */
function missingLoraWireField(
  weightsField: string | undefined,
  scaleField: string | undefined,
  controlInput: Record<string, unknown>,
): string | null {
  if (weightsField === undefined) return "loraWeights";
  if (scaleField === undefined) return "loraScale";
  if (!carriesLoraWireValue(controlInput, weightsField)) return weightsField;
  if (!carriesLoraWireValue(controlInput, scaleField)) return scaleField;
  return null;
}

/**
 * Whether the payload really carries this field — present AND holding a value.
 *
 * A key set to null or undefined is not a weaker version of "sent", it is the
 * same as absent: the provider is handed nothing to fetch and no strength to
 * blend, and the render comes back as if no LoRA existed. The route that
 * produces it is a profile's `providerOverrides` writing over a mapped value
 * (overrides merge last, by design), which is exactly the case where the record
 * and the payload part company without anything else noticing.
 */
function carriesLoraWireValue(controlInput: Record<string, unknown>, field: string): boolean {
  const value = controlInput[field];
  return value !== undefined && value !== null;
}

/**
 * The library id inside the mapper's `{ id, scale }` record, for the refusal
 * message. Defensive rather than cast: this runs on the path that just proved
 * something is wrong, and a diagnostic that throws while reporting a breach
 * reports nothing.
 */
function appliedLoraId(applied: unknown): string {
  if (typeof applied === "object" && applied !== null && "id" in applied) {
    const { id } = applied;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "(unnamed)";
}

/**
 * The negative text that will ACTUALLY accompany this render, or null.
 *
 * Two ways a negative reaches a provider, and both count. The ordinary one is a
 * mapped control or an override written to the version's `negativePrompt`
 * binding, read back out of the FINAL payload so an override that replaced the
 * mapped value is the text reported. The second is the model row's own
 * `extraInput`: the payload builder copies those constants into the payload
 * verbatim, so a row carrying `negative_prompt: "blurry"` sends it with no
 * binding and no control involved. Reporting null there claimed no negative was
 * sent while one was — the reviewed-quality rows that set it to `""` are the
 * case that keeps this honest in the other direction, since an empty string is
 * "deliberately no negative" and stays null.
 */
function resolvedNegativePrompt(model: ImageModel, controlInput: Record<string, unknown>): string | null {
  const negativeField = model.advancedCapabilities.controls.negativePrompt?.field;
  const sent = negativeField === undefined ? undefined : controlInput[negativeField];
  if (typeof sent === "string") return sent;
  const constant = model.extraInput["negative_prompt"];
  return typeof constant === "string" && constant.length > 0 ? constant : null;
}

/**
 * Write the caller's safety fact into the model's own `extraInput`, so the
 * effective model describes what the provider will be sent rather than what the
 * row happens to store.
 *
 * The payload builder overrides this key's VALUE from the deployment setting at
 * send time and never introduces the key. Fingerprinting the stored value
 * therefore described a placeholder: an operator flipping the setting between
 * planning a grid and executing it changed provider enforcement for every cell,
 * with two arms of one comparison potentially running under different
 * enforcement and matching fingerprints to say nothing happened. Resolving it
 * here makes that flip a `cell_conflict` — loud, and refusing to spend — which
 * is the only honest outcome for a comparison whose safety posture moved.
 *
 * The key is never ADDED, exactly as at the payload builder: a model whose
 * schema does not declare the input must not be handed one.
 */
function withResolvedSafetyChecker(model: ImageModel, safetyCheckerDisabled: boolean): ImageModel {
  if (!("disable_safety_checker" in model.extraInput)) return model;
  return { ...model, extraInput: { ...model.extraInput, disable_safety_checker: safetyCheckerDisabled } };
}
