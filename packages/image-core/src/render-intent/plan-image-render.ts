import type { DiagnosticSink } from "@vesper/contracts";
import type { ImageModel } from "../models/image-models";
import type { ImageReferenceRole } from "../capabilities/image-model-capabilities";
import type { ResolvedImageProfile } from "../models/image-model-profiles";
import type { ProviderExecutionPolicy } from "../provider-interface/execution-policy";
import {
  compileProfileRenderPlan,
  type ImagePromptPreparer,
  type ImageRenderDimensionFacts,
} from "../render-kernel/compile-profile-plan";
import type { CompileReferenceBinding } from "../references/reference-role-prompt";
import { compileImagePromptSegments, imagePromptBudgetFromBinding } from "./prompt-segments";
import {
  type DroppedImageReference,
  type ImageRenderIntentCore,
  type ImageRenderPolicy,
  type ImageRenderReferenceSpec,
  missingRequiredControlInputs,
  missingRequiredReferenceRoles,
  planIntentReferences,
  resolveImageRenderPolicy,
} from "./render-intent";

/**
 * THE production render planner — everything decided before a byte leaves the
 * process.
 *
 * Every image lane describes what it wants in one vocabulary — a prompt, a
 * shape, role-carrying references — and this turns that into the exact
 * provider-bound plan by way of the profile the lane resolved. Before it, each
 * lane called the transport with a model and an anonymous buffer list, so a
 * reference's meaning was its position and no lane could say "this one is the
 * face".
 *
 * It is pure: no database, no provider, no environment. The application half
 * (`renderImageIntent`) resolves the LoRA binding and the deployment's runtime
 * facts first, reports diagnostics, and calls the transport.
 *
 * TWO things it deliberately does NOT do, both of which would have changed live
 * renders on the day the lanes moved over:
 *
 * - **No version pin.** A compiled plan carries `versionId` because a controlled
 *   comparison must execute one exact version; production deliberately follows
 *   the slug's floating latest, and now that trial setup re-probes models, a row
 *   can carry a `probedVersionId` that would silently start pinning every player
 *   render to whatever version the trial happened to probe. Pinning production
 *   is the version-promotion slice's job, with the smoke test and activation
 *   flow that make it safe. The intent may CARRY an explicit pin from a
 *   controlled caller (`versionId` — today only the image lab's controlled
 *   experiments set it); the path itself still pins nothing for production lanes.
 * - **No forced prediction budget.** A plan always carries a numeric `timeoutMs`
 *   so a trial cell can fingerprint its own deadline. All seeded profiles store
 *   null, so honoring the plan's number here would replace the deployment's
 *   prediction timeout with a hardcoded five minutes for every lane. A profile's
 *   budget is used when it declares one; otherwise the environment still decides.
 */

/**
 * One reference with its bytes.
 *
 * `Buffer` is named here as a TYPE only — this package never constructs one, and
 * the images travel through it untouched. It is the same provider seam the
 * failure and detector contracts already sit on: naming a platform type at a
 * provider seam is allowed, evaluating one is not.
 */
export interface ImageRenderReference extends ImageRenderReferenceSpec {
  buffer: Buffer;
}

export interface ImageRenderIntent extends ImageRenderIntentCore {
  /**
   * The profile and model this render runs on.
   *
   * Resolved by the CALLER rather than from a `profileSelection` string here.
   * Every lane has to know
   * its model before it reserves an image row — the row's `meta.model` records
   * it, and a lane with no offered profile fails its precondition instead of
   * reserving — so resolving inside this call would mean a second registry read
   * on the render hot path, or a lane that reserves before it knows what it will
   * run.
   */
  profile: ResolvedImageProfile;
  references: ImageRenderReference[];
  /**
   * Execute exactly this provider version. Set ONLY by controlled callers —
   * today the image lab's controlled experiments, whose evidence identity is
   * the pin — never by a production lane, which follows the slug's floating
   * latest (see the module note). Threaded to the transport untouched;
   * reference planning ignores it.
   */
  versionId?: string;
  /**
   * How this render's prediction budget is split between waiting for a start and
   * waiting for an image ({@link ProviderExecutionPolicy}).
   *
   * ABSENT is the production answer and the default: the transport keeps its
   * legacy single-budget behavior byte for byte, so no lane changes by this
   * field existing. Set only by the admin bench lanes, which can afford to wait
   * out a cold-boot queue and must not read a never-started prediction as a
   * failed render.
   *
   * Carried on the intent rather than resolved in the transport because it is a
   * property of what this CALLER is willing to wait for, not of the provider;
   * planning ignores it and threads it through untouched.
   */
  executionPolicy?: ProviderExecutionPolicy;
}

/**
 * The deployment facts a plan needs that are not properties of the render.
 *
 * Deliberately NOT part of {@link ImageRenderIntent}: an intent describes what
 * the render wants, and how this process is configured is a different kind of
 * fact. Keeping them apart is what lets a caller compile the same intent under
 * two deployments and see the difference in the fingerprint, and what keeps this
 * package from reading an environment it does not own.
 */
export interface ImageRenderRuntimeFacts {
  /** Whether this deployment bypasses the provider's safety checker. */
  safetyCheckerDisabled: boolean;
  /**
   * The model-boundary prompt step for the family this render runs on
   * ({@link ImagePromptPreparer}).
   *
   * It sits with the deployment facts rather than on the intent for the same
   * reason the safety setting does: a lane says what it wants rendered, and
   * which dialect the chosen model speaks is something the process resolves
   * around it. Absent means no dialect at all — the prompt crosses the model
   * boundary untouched, because model dialects live in the adapter package and
   * a kernel that guessed one would re-create the slug checks the adapters
   * replaced.
   */
  preparePrompt?: ImagePromptPreparer;
}

/** Exactly what the provider will be handed, and what capacity left behind. */
export interface PlannedImageRender {
  /**
   * The model row as stored. The transport applies the reviewed-quality seam
   * itself, so handing it the raw row reproduces today's payload byte for byte;
   * the compile step's `effectiveModel` is the same object after that seam, and
   * passing it would apply the seam twice for no difference.
   */
  model: ImageModel;
  /** The strategy-compiled, model-dialect-prepared prompt. */
  prompt: string;
  /**
   * The negative text that will actually accompany this render, or null —
   * the compile step's own resolution ({@link ProfileRenderPlan.negativePrompt}),
   * surfaced so a caller recording render provenance (the Stage 3 render-intent
   * capture) can state the negative half without recomputing the merge.
   */
  negativePrompt: string | null;
  references: Buffer[];
  /**
   * Structural controls this version gave a field of their own, keyed by that
   * field — a ControlNet-style `pose_image` rather than another numbered entry
   * in the primary array.
   *
   * Empty on every seeded model, because none declares an
   * `additionalImageInputs` entry. A control on such a model rides `references`
   * as a numbered image instead, which is how Qwen Image Edit 2511 takes one.
   */
  controlReferences: PlannedControlReference[];
  /** Mapped controls plus validated overrides, keyed by provider field name. */
  controlInput: Record<string, unknown>;
  /**
   * The `controlInput` fields a typed semantic control produced
   * ({@link ProfileRenderPlan.typedControlFields}) — the set the strict
   * provider-input validator extends its typed-owner trust to, so a curated
   * LoRA's probed weights field passes where a raw advanced URL never does.
   */
  typedControlFields: readonly string[];
  /**
   * The controls that actually reached `controlInput`, keyed by NORMALIZED name
   * — the compile step's provenance record ({@link ProfileRenderPlan.appliedControls}),
   * surfaced so the caller can store what this render was configured as without
   * re-deriving it from provider field names.
   */
  appliedControls: Record<string, unknown>;
  /** Every control that did not reach the payload, each with its reason. */
  droppedControls: { control: string; reason: string }[];
  /**
   * The shape this render asked for, or `null` for the model's own default
   * (`ImageRenderTarget`). Null travels all the way to the transport
   * wrapper, where it means "write no aspect/size key and do not crop".
   */
  targetRatio: number | null;
  /**
   * The compile step's dimension-resolver inputs (operation, merged
   * resolution/width/height, the mapped custom pair). `renderWithModel` hands
   * them to `chooseDimensions` beside `targetRatio`; a caller that renders
   * without them gets the pure `chooseAspect` shape, unchanged.
   */
  dimensionFacts: ImageRenderDimensionFacts;
  /** The caller's send-strictness policy, resolved against the production defaults. */
  policy: Required<ImageRenderPolicy>;
  /** The profile's own budget, or null to leave it to the environment. */
  timeoutMs: number | null;
  /** References that will not be sent, in caller order, each with its reason. */
  dropped: DroppedImageReference<ImageRenderReference>[];
  /**
   * The primary references in SEND order — the same images as
   * {@link PlannedImageRender.references}, with the roles still attached so a
   * diagnostic can name them.
   */
  sentReferences: ImageRenderReference[];
  /** Whether any sent reference occupies a different slot than the lane assumed. */
  referencesRenumbered: boolean;
}

/** One dedicated control input's bytes, ready for the transport. */
export interface PlannedControlReference {
  field: string;
  /** `single` writes one URL; `array` writes a list, exactly as the schema declares. */
  arity: "single" | "array";
  buffers: Buffer[];
}

/** Why a render was refused before any provider work happened. */
export interface ImageRenderRefusal {
  code:
    | "image_profile.required_reference_missing"
    | "image_profile.required_reference_dropped"
    | "image_profile.required_control_input_missing"
    | "image_profile.prompt_strategy_unsupported"
    /**
     * The compile step's final-wire LoRA invariant: the plan would have claimed
     * a LoRA its own payload does not carry. Pre-spend, and never expected —
     * unlike its neighbours here, this one reports a defect rather than a
     * configuration an operator can fix.
     */
    | "image_profile.lora_binding_not_sent";
  message: string;
  context: Record<string, unknown>;
}

export type PlanImageRenderResult = { ok: true; plan: PlannedImageRender } | { ok: false; refusal: ImageRenderRefusal };

/**
 * Plan one render.
 *
 * Separated from the application's IO half so the interesting decisions —
 * capacity trimming, the two required-reference gates (the profile's roles and
 * the caller's own flags), control precedence, a strategy this path cannot
 * execute — are testable without a database, a provider, or a deployment.
 *
 * The `sink` is the one concession to reporting, and it is optional: prompt
 * fitting can degrade (optional detail dropped, a mandatory sentence given up)
 * and a degradation nobody is told about is the failure mode `docs/resilience.md`
 * exists to prevent. It stays a sink rather than a returned list because every
 * caller already has one and the refusal channel is reserved for decisions that
 * stop the render.
 */
export function planImageRender(
  intent: ImageRenderIntent,
  runtime: ImageRenderRuntimeFacts,
  sink?: DiagnosticSink,
): PlanImageRenderResult {
  const { profile, model } = intent.profile;
  const planned = planIntentReferences(model, profile.referencePolicy, intent.references);
  const { primary, dedicated, dropped } = planned;

  // Checked against everything that will actually be SENT — the primary array
  // and the dedicated control fields alike — not the references the lane
  // supplied. A required identity anchor that capacity pushed out is exactly as
  // absent as one the lane never had, and rendering anyway would produce a
  // stranger; a required pose map that reached its own provider field is
  // present, even though it never entered the primary contest.
  const sent = [...primary, ...dedicated.flatMap((input) => input.references)];
  const missing = missingRequiredReferenceRoles(profile.referencePolicy, sent);
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "image_profile.required_reference_missing",
        message: `profile ${profile.key} requires reference roles this render cannot supply`,
        context: { profile: profile.id, task: profile.task, missing, supplied: roleNames(intent.references) },
      },
    };
  }

  // The CALLER's demand, as against the profile's one check up, and the reason
  // both exist: `requiredRoles` is answered with a set, so it asks whether a
  // role survived and never how many of it the lane needed. A lane sending two
  // required identity references is asking for both faces, and a capacity trim
  // that takes the second leaves `identity` present — the check above passes and
  // the render goes out one character short of the scene it was ordered as.
  //
  // Every drop reason is refused, because none of them is "send it without this
  // reference": `model_capacity` and `role_cap` are the two ways a second
  // reference of one role disappears, `role_not_allowed` is a profile that was
  // never going to send it at all, and a dedicated input's own ceiling arrives
  // in the same list. Sorting already gave required references the first slots,
  // so reaching here means the request genuinely does not fit the profile.
  const droppedRequired = dropped.filter((entry) => entry.reference.required === true);
  if (droppedRequired.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "image_profile.required_reference_dropped",
        message: `profile ${profile.key} cannot send a reference this render marked required`,
        context: {
          profile: profile.id,
          task: profile.task,
          // Role AND reason, for the reason the trim diagnostic carries both: an
          // operator reading "identity dropped" cannot tell a model too small
          // from a profile that never allowed the role, and only one of those is
          // fixed by picking a bigger model. The source asset is named when
          // there is one, so the answer points at an image rather than a slot.
          dropped: droppedRequired.map((entry) => ({
            role: entry.reference.role,
            reason: entry.reason,
            ...(entry.reference.sourceImageId === undefined ? {} : { sourceImageId: entry.reference.sourceImageId }),
          })),
        },
      },
    };
  }

  // The version's own demand, as against the profile's. A model declaring
  // `pose_image` as a required input rejects a prediction that omits it, so the
  // round trip is refused here rather than spent discovering that.
  const unfilled = missingRequiredControlInputs(model, dedicated);
  if (unfilled.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "image_profile.required_control_input_missing",
        message: `${model.slug} requires control image inputs this render cannot supply`,
        context: {
          profile: profile.id,
          task: profile.task,
          missing: unfilled,
          supplied: roleNames(intent.references),
        },
      },
    };
  }

  // Only the PRIMARY references are named to the strategy, and in send order. A
  // dedicated-input control is bound by its provider field, not by a position in
  // a numbered list, so numbering it in the prompt would name a slot that does
  // not exist in the array the text is describing.
  const compiled = compileProfileRenderPlan({
    model,
    profile,
    basePrompt: resolveIntentPrompt(intent, model, sink),
    baseNegativePrompt: null,
    safetyCheckerDisabled: runtime.safetyCheckerDisabled,
    // Absent leaves the compile step on its legacy dialect step, which is what
    // every lane runs until the application resolves an adapter for the model.
    ...(runtime.preparePrompt ? { preparePrompt: runtime.preparePrompt } : {}),
    ...(intent.controls ? { controlOverrides: intent.controls } : {}),
    // Threaded, never resolved here: planning is pure, and resolving a LoRA means
    // reading the library. The application does that first, so a plan either
    // carries a binding somebody already judged or carries none.
    ...(intent.resolvedLora ? { resolvedLora: intent.resolvedLora } : {}),
    // Built from the PLANNED primary rather than from the caller's list, so a
    // subject travels with the reference through selection and reordering. A
    // subject read off the caller's order instead would name the wrong slot the
    // moment the policy moved one.
    references: { vocabulary: "render_intent", references: compileBindings(primary) },
  });
  if (!compiled.ok) {
    // Each compile refusal keeps its own code and context: one names a strategy
    // an operator can change, the other names a payload field that went missing.
    // Collapsing them would send both to the same screen, and only one of them
    // has anything an operator could do there.
    if (compiled.reason === "lora_binding_not_sent") {
      return {
        ok: false,
        refusal: {
          code: "image_profile.lora_binding_not_sent",
          message: `profile ${profile.key} compiled a plan claiming a LoRA the payload does not carry: ${compiled.message}`,
          context: { profile: profile.id, task: profile.task, missingField: compiled.missingField },
        },
      };
    }
    return {
      ok: false,
      refusal: {
        code: "image_profile.prompt_strategy_unsupported",
        message: `profile ${profile.key} declares prompt strategy ${compiled.promptStrategy}, which the render path cannot compile`,
        context: { profile: profile.id, task: profile.task, promptStrategy: compiled.promptStrategy },
      },
    };
  }

  return {
    ok: true,
    plan: {
      model,
      prompt: compiled.plan.finalPrompt,
      negativePrompt: compiled.plan.negativePrompt,
      references: primary.map((reference) => reference.buffer),
      controlReferences: dedicated.map((input) => ({
        field: input.field,
        arity: input.arity,
        buffers: input.references.map((reference) => reference.buffer),
      })),
      controlInput: compiled.plan.controlInput,
      typedControlFields: compiled.plan.typedControlFields,
      appliedControls: compiled.plan.appliedControls,
      droppedControls: compiled.plan.resolvedControls.droppedControls,
      targetRatio: intent.target.aspectRatio,
      dimensionFacts: compiled.plan.dimensionFacts,
      policy: resolveImageRenderPolicy(intent.policy),
      timeoutMs: profile.timeoutMs,
      dropped,
      sentReferences: primary,
      referencesRenumbered: planned.renumbered,
    },
  };
}

function roleNames(references: readonly ImageRenderReferenceSpec[]): ImageReferenceRole[] {
  return references.map((reference) => reference.role);
}

/**
 * The text the profile's prompt strategy compiles from: the lane's segments when
 * it supplied any, and otherwise its prompt exactly as before.
 *
 * The budget comes off the model's OWN probed prompt binding — `maxChars` is a
 * provider ceiling and `recommendedChars` the documented quality knee — rather
 * than from anything decided here. That matters twice over. It keeps the limit a
 * measured fact about one version instead of a family-wide guess — the
 * assumption this seam exists not to reintroduce — and because no
 * seeded model has a probed prompt binding at all, every budget resolves empty
 * today and no render is fitted by this seam's arrival.
 *
 * An empty segment list falls through to `prompt` rather than compiling to "": a
 * lane that built no segments has not asked for an empty prompt.
 */
function resolveIntentPrompt(intent: ImageRenderIntent, model: ImageModel, sink?: DiagnosticSink): string {
  const segments = intent.promptSegments;
  if (!segments || segments.length === 0) return intent.prompt;
  return compileImagePromptSegments(segments, imagePromptBudgetFromBinding(model.advancedCapabilities.prompt), sink);
}

/**
 * The prompt compiler's view of the references being sent: the role, plus the
 * subject when this reference names one.
 *
 * The subject is omitted rather than passed as `undefined` so a render that names
 * nobody hands the compiler exactly the shape it saw before subjects existed —
 * the compiled text is fingerprinted into comparison identity, and every existing
 * lane must keep producing the same bytes.
 */
function compileBindings(references: readonly ImageRenderReferenceSpec[]): CompileReferenceBinding[] {
  return references.map((reference) => ({
    role: reference.role,
    ...(reference.subject === undefined ? {} : { subject: reference.subject }),
  }));
}
