import { createHash } from "node:crypto";
import {
  chooseAspect,
  type IdentityReferenceRole,
  type ImageModel,
  type ImageModelProfile,
  type ImagePromptStrategy,
  type ImageReferenceRole,
  type ImageRenderControls,
  type TrialResolvedControls,
} from "@/contracts";
import { compileIdentityReferencePrompt } from "@/lib/images/identity-reference-prompt";
import { compileReferenceRolePrompt } from "@/lib/images/reference-role-prompt";
import {
  disableSafetyChecker,
  filterReservedInputFields,
  mapImageRenderControls,
  reservedImageInputFields,
  validateProviderOverrides,
} from "../ai";
import { preparePromptForImageModel, withReviewedImageQuality } from "./quality-presets";

/**
 * THE profile compile step: one profile row plus one prompt in, the exact
 * provider-shaped configuration out (image-model-capabilities.spec.md
 * §"Normalized render intent" steps 5–11, §"Control mapping", §"Timeouts").
 *
 * This is the kernel of the capabilities plan's slice 2/4 work, landed early
 * because the identity trial needs it FIRST: a comparison harness that records a
 * profile's controls but sends the model row's raw defaults is grading a
 * configuration nobody ran. It is written to be adopted by the production render
 * intent rather than re-invented beside it — `renderImageIntent` should call
 * this for its resolved profile and add only the parts a trial has no use for
 * (reference selection by policy, LoRA resolution, per-request control
 * overrides, image sets).
 *
 * Three properties are load-bearing and are why this lives in ONE function:
 *
 * 1. **What is hashed is what is sent.** {@link profileRenderControlsHash}
 *    hashes fields taken from the plan this same call produced, so a field
 *    cannot enter the hash unless it entered the payload. The old trial hash was
 *    assembled independently of the render call and drifted from it immediately.
 * 2. **The EFFECTIVE model is what counts.** `withReviewedImageQuality` rewrites
 *    `extraInput` at the render boundary (Qwen Edit's `go_fast`, Juggernaut's
 *    step/CFG correction). Hashing the raw row let that table change the
 *    provider payload with no `cell_conflict` to show for it — a silent change
 *    to what a pinned comparison sends.
 * 3. **Nothing is guessed and nothing is silently dropped.** Controls map only
 *    through the version's probed bindings, and every omission is recorded in
 *    `resolvedControls.droppedControls`, which is itself hashed.
 */

/**
 * Deterministic JSON for hashing: keys sorted recursively, `undefined` members
 * dropped. Exported so the one hashing helper in the image lane has one home —
 * a second copy would be a second answer to "did this configuration move?".
 *
 * Local rather than imported from the engine's `canonicalJson` because that
 * module carries the contact-ledger machinery, and reaching into it from the
 * image lane for a string formatter would couple two systems over nothing.
 */
export function stableJson(value: unknown): string {
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

/** Hex sha256 of a string. One spelling, shared by prompt and control hashes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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
 * its references — `buildSceneRenderPrompt` writes the multi-reference bindings
 * for a scene, and Qwen Edit's multi-reference lock is applied by
 * {@link preparePromptForImageModel} on the way out.
 *
 * So the vocabulary decides whether the strategy prefixes anything at all. It is
 * a discriminated union rather than a widened role array because those two
 * answers are genuinely different, and a single array would force the compiler
 * to guess which naming convention a caller meant from the role names alone.
 */
export type PromptReferenceBinding =
  | { vocabulary: "identity_pack"; roles: readonly IdentityReferenceRole[] }
  | { vocabulary: "render_intent"; roles: readonly ImageReferenceRole[] };

export interface CompileProfileRenderPlanInput {
  model: ImageModel;
  profile: ImageModelProfile;
  /** The lane's or fixture's prompt, BEFORE the profile's prompt strategy compiles it. */
  basePrompt: string;
  /** The caller's negative prompt; null falls back to the profile's default. */
  baseNegativePrompt: string | null;
  /**
   * Per-render controls, merged OVER the profile's stored defaults (the spec's
   * "a later layer wins"). This is the request half of the control vocabulary:
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
   * trial's control hash — only ever renders 3:4. `renderImageIntent` ignores it
   * and negotiates the shape against its own target instead, since the entity and
   * place lanes ask for 1:1 and 3:2. Read this as "the shape a 3:4 render of this
   * profile would use", not "the shape this plan will produce".
   */
  aspectValue: string | null;
  /** Mapped controls plus validated overrides, keyed by provider field name. */
  controlInput: Record<string, unknown>;
  /** The auditable record of the above, drops included. */
  resolvedControls: TrialResolvedControls;
  /**
   * The prediction budget this plan WILL be run under — always a number, never
   * "ask the environment". The profile's own `timeoutMs` when it has one,
   * {@link TRIAL_FALLBACK_PREDICTION_MS} when it does not, clamped to
   * {@link MAX_TRIAL_PREDICTION_MS}. Being explicit is the whole point: an
   * env-resolved budget is a budget the compiled plan cannot state, cannot hash,
   * and cannot be bounded by.
   */
  timeoutMs: number;
  /** The pinned provider version, or null when this row has none. */
  versionId: string | null;
}

/**
 * A compiled plan, or the typed refusal that says this profile's declared prompt
 * strategy cannot be executed on the identity-reference path at all.
 *
 * A refusal rather than a throw because both callers have somewhere honest to
 * put it: the trial planner records the cell `profile_ineligible` and spends
 * nothing, and the execute-time recompile records `cell_conflict`. An exception
 * would have made "this profile is configured for a job this path cannot do" —
 * an ordinary, expected configuration state — indistinguishable from a bug.
 */
export type CompileProfileRenderPlanResult =
  | { ok: true; plan: ProfileRenderPlan }
  | { ok: false; reason: "unsupported_prompt_strategy"; promptStrategy: ImagePromptStrategy };

/** A strategy's compiled prompt text, or its refusal to compile one at all. */
type StrategyPromptCompile = { ok: true; prompt: string } | { ok: false };

/**
 * THE prompt-strategy dispatch — the seed of the code registry the capabilities
 * spec calls for (image-model-capabilities.spec.md §"Prompt strategies": "an
 * enum resolved through a code registry", never prompt logic stored in a row).
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
 *   hashed but never consulted, so two profiles differing only in strategy
 *   claimed different configurations and sent identical prompts.
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
      return compileRenderIntentPrompt(strategy, basePrompt, references.roles);
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
 * `multi_reference_compose` now COMPILES here, which it could not before slice
 * 3: its defining semantic is naming the purpose and order of each reference
 * (image-model-capabilities.spec.md §"Prompt strategies"), and this vocabulary
 * had no wording for that, so the only honest answer was refusal — returning the
 * base prompt would have let a profile claim the composing strategy while
 * sending text identical to `instruction_edit`. {@link compileReferenceRolePrompt}
 * is that wording. No seeded profile selects the strategy, so no live render
 * changes; a controlled Qwen recipe is the first thing that will.
 */
function compileRenderIntentPrompt(
  strategy: ImagePromptStrategy,
  basePrompt: string,
  roles: readonly ImageReferenceRole[],
): StrategyPromptCompile {
  switch (strategy) {
    case "instruction_edit":
    case "text_to_image_description":
      return { ok: true, prompt: basePrompt };
    case "multi_reference_compose":
      return { ok: true, prompt: compileReferenceRolePrompt({ basePrompt, roles }) };
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
 * The pipeline mirrors the spec's resolution order for the steps a single-image
 * render needs: reviewed-quality model, strategy-compiled prompt, model-dialect
 * prompt preparation, negative resolution, control mapping, override
 * validation, aspect choice, version pin.
 *
 * The FIRST step is the profile's declared `promptStrategy`
 * ({@link compilePromptForStrategy}), and it is the one step that can refuse.
 * That ordering is the point: a strategy this path cannot execute must stop the
 * compile before anything downstream produces controls, hashes, or a plan that
 * a caller could mistake for a runnable one.
 *
 * `preparePromptForImageModel` runs HERE and again inside `renderWithModel`.
 * That is deliberate and safe: the rewrite is idempotent (it replaces the legacy
 * identity lock, and a prompt with no legacy lock left in it passes through
 * untouched), so the text hashed here is byte-for-byte the text the provider
 * receives. Relying on that property beats adding a "already prepared" flag
 * whose two code paths would need keeping honest forever.
 */
export function compileProfileRenderPlan(input: CompileProfileRenderPlanInput): CompileProfileRenderPlanResult {
  const { model, profile, basePrompt, baseNegativePrompt, references } = input;
  const strategyPrompt = compilePromptForStrategy(profile.promptStrategy, basePrompt, references);
  if (!strategyPrompt.ok) {
    return { ok: false, reason: "unsupported_prompt_strategy", promptStrategy: profile.promptStrategy };
  }
  const effectiveModel = withResolvedSafetyChecker(withReviewedImageQuality(model));
  const finalPrompt = preparePromptForImageModel(effectiveModel, strategyPrompt.prompt, references.roles.length);

  const defaults = profile.controlDefaults;
  const requested = input.controlOverrides;
  // `baseNegativePrompt` is the fixture channel and `controls.negativePrompt` the
  // request channel; both are the CALLER's negative, and no caller sets both, so
  // the order between them is arbitrary and only the fall-through to the
  // profile's default is load-bearing.
  const negative = baseNegativePrompt ?? requested?.negativePrompt ?? defaults.negativePrompt ?? null;
  const outputCount = requested?.outputCount ?? defaults.outputCount;

  // The profile's stored defaults with the request's overrides merged over them
  // — the spec's "a later layer wins" between those two layers. Written as a
  // plain member-by-member merge because an `undefined` member and an absent one
  // are the same thing to `mapImageRenderControls`: it skips every control whose
  // value is undefined, so nothing here reaches a payload uninvited.
  //
  // `seedPolicy` is deliberately absent: it is a POLICY, not a value to send, and
  // no seed transport exists anywhere in the render path yet — so a seed-shaped
  // default is recorded as a DROP below rather than quietly ignored, because
  // "this run was not seeded" is a fact the comparison hash must carry. A
  // REQUESTED numeric seed does travel to the mapper, which refuses it as
  // `unsupported` and records that refusal, so asking for one is visible rather
  // than silently ineffective.
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

  const reservedFields = reservedImageInputFields(effectiveModel);
  const mapped = mapImageRenderControls({ controls, capabilities: effectiveModel.advancedCapabilities });
  // A mapped control can land on a reserved field — `resolutionTier` is commonly
  // probed as `size`, which IS the shape key on a size-mode model — and the
  // transport would then discard it on the way out. Filtering here rather than
  // letting that happen is what keeps the recorded payload equal to the sent
  // one; a control the hash claims was sent and the provider never saw is the
  // exact drift this compile step exists to make impossible.
  const sendableMapped = filterReservedInputFields(mapped.input, reservedFields);
  const overrides = validateProviderOverrides(
    profile.providerOverrides,
    effectiveModel.advancedCapabilities.knownInputFields,
    reservedFields,
  );
  // Overrides merge LAST, per the spec's "a later layer wins". They therefore
  // may also replace a mapped control's value, which is why the reported
  // negative below is read back out of the FINAL payload rather than from the
  // mapping step: a hash that described the pre-override text would be a hash of
  // something the provider never saw.
  const controlInput = { ...sendableMapped.input, ...overrides.input };

  // Typed as the contract's own list rather than the mapper's narrower union:
  // the notes below are this layer's facts, not ones the mapper can produce.
  const droppedControls: TrialResolvedControls["droppedControls"] = [
    ...mapped.dropped,
    ...sendableMapped.dropped,
    ...overrides.dropped,
  ];
  if (outputCount !== undefined) {
    // This compile step serves the SINGLE-IMAGE path. A profile asking for four
    // outputs would be billed for four and graded on one, so the count never
    // travels — and the request is recorded as a drop rather than silently
    // reinterpreted as 1, because "this profile wanted a set" is a real
    // difference between two configurations and the hash must carry it.
    droppedControls.push({ control: "outputCount", reason: "single_image_path" });
  }
  if (defaults.seedPolicy !== "random") {
    // Only a non-default policy is worth recording: `random` is what sending no
    // seed key already does at every provider, so it drops nothing.
    droppedControls.push({ control: "seedPolicy", reason: "no_seed_transport" });
  }

  const timeoutMs = Math.min(profile.timeoutMs ?? TRIAL_FALLBACK_PREDICTION_MS, MAX_TRIAL_PREDICTION_MS);
  return {
    ok: true,
    plan: {
      effectiveModel,
      finalPrompt,
      negativePrompt: resolvedNegativePrompt(effectiveModel, controlInput),
      aspectValue: chooseAspect(effectiveModel).value,
      controlInput,
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

/**
 * The negative text that will ACTUALLY accompany this render, or null.
 *
 * Two ways a negative reaches a provider, and both count. The ordinary one is a
 * mapped control or an override written to the version's `negativePrompt`
 * binding, read back out of the FINAL payload so an override that replaced the
 * mapped value is the text reported. The second is the model row's own
 * `extraInput`: `buildRegistryModelInput` copies those constants into the
 * payload verbatim, so a row carrying `negative_prompt: "blurry"` sends it with
 * no binding and no control involved. Reporting null there claimed no negative
 * was sent while one was — the reviewed-quality rows that set it to `""` are the
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
 * Resolve the env-owned safety toggle into the model's own `extraInput`, so the
 * effective model describes what the provider will be sent rather than what the
 * row happens to store.
 *
 * `buildRegistryModelInput` overrides this key's VALUE from
 * `REPLICATE_SAFE_MODE` at send time and never introduces the key. Hashing the
 * stored value therefore fingerprinted a placeholder: an operator flipping the
 * env between planning a grid and executing it changed provider enforcement for
 * every cell, with two arms of one comparison potentially running under
 * different enforcement and matching hashes to say nothing happened. Resolving
 * it here makes that flip a `cell_conflict` — loud, and refusing to spend —
 * which is the only honest outcome for a comparison whose safety posture moved.
 *
 * The key is never ADDED, exactly as at the payload builder: a model whose
 * schema does not declare the input must not be handed one.
 */
function withResolvedSafetyChecker(model: ImageModel): ImageModel {
  if (!("disable_safety_checker" in model.extraInput)) return model;
  return { ...model, extraInput: { ...model.extraInput, disable_safety_checker: disableSafetyChecker() } };
}

export interface ProfileRenderControlsHashInput {
  profileId: string;
  profileKey: string;
  promptStrategy: ImagePromptStrategy;
  /** Reference roles in send order — part of the configuration, not of the prompt. */
  orderedReferenceRoles: readonly IdentityReferenceRole[];
}

/**
 * The fingerprint of an ACTUALLY-EXECUTING configuration: everything about how
 * this render will be made beyond its prompt text.
 *
 * Two rules decide what goes in. Everything hashed must be something the render
 * sends or is shaped by — the effective model's identity and transport facts,
 * the resolved control payload, the drops, the version, the timeout, the
 * profile's identity and strategy. And nothing the render sends may be left out,
 * which is why the input is the PLAN rather than the rows: a field that reaches
 * the provider without reaching this hash is a change a pinned comparison cannot
 * detect.
 *
 * `promptStrategy` earns its place under the FIRST rule, and only since
 * {@link compilePromptForStrategy} shipped: the strategy now decides how the
 * references are named in the compiled text, or refuses the compile outright. It
 * was hashed before that dispatch existed too, and that was the bug — two
 * profiles differing only in strategy fingerprinted differently while sending
 * identical prompts, so the hash asserted a difference nothing downstream made.
 *
 * Display-only fields (labels, sort order, `enabled`) are deliberately absent: a
 * renamed profile is the same experiment, and invalidating a grid over a label
 * edit would train operators to ignore `cell_conflict`.
 *
 * What this hash describes is the MERGE INPUTS, not the post-merge payload, and
 * the distinction is worth stating because `buildRegistryModelInput` applies
 * `extraInput` AFTER the aspect key: a model whose `extraInput` carries `size`
 * or `aspect_ratio` overrides the `aspectValue` recorded here, so the two fields
 * below can disagree with what finally travels. That is safe rather than
 * sloppy — both are hashed, so any drift in either still moves the fingerprint —
 * and the alternative (hashing a payload this function would have to rebuild)
 * would be a second construction of the provider input, which is precisely the
 * duplication "what is hashed is what is sent" exists to remove.
 *
 * `extraInput`'s `disable_safety_checker` is the ENV-RESOLVED value by the time
 * a plan reaches here ({@link compileProfileRenderPlan}), so this hash tracks the
 * enforcement that will actually apply rather than the row's placeholder.
 */
export function profileRenderControlsHash(plan: ProfileRenderPlan, extra: ProfileRenderControlsHashInput): string {
  const model = plan.effectiveModel;
  return sha256Hex(
    stableJson({
      modelId: model.id,
      modelSlug: model.slug,
      modelVersion: plan.versionId,
      referenceField: model.referenceField,
      referenceArity: model.referenceArity,
      referenceTransport: model.referenceTransport,
      maxReferences: model.maxReferences,
      aspect: plan.aspectValue,
      outputFormat: model.outputFormat,
      extraInput: model.extraInput,
      operation: plan.resolvedControls.operation,
      promptStrategy: extra.promptStrategy,
      timeoutMs: plan.timeoutMs,
      controlInput: plan.controlInput,
      droppedControls: plan.resolvedControls.droppedControls,
      profileId: extra.profileId,
      profileKey: extra.profileKey,
      orderedReferenceRoles: [...extra.orderedReferenceRoles],
    }),
  );
}
