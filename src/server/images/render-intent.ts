import {
  effectiveImageLoraSelection,
  missingRequiredControlInputs,
  missingRequiredReferenceRoles,
  planIntentReferences,
  type DroppedImageReference,
  type ImageModel,
  type ImageReferenceRole,
  type ImageRenderIntentCore,
  type ImageRenderReferenceSpec,
  type ResolvedImageProfile,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { CompileReferenceBinding } from "@/lib/images/reference-role-prompt";
import { resolveImageLoraForRender } from "./image-loras";
import { renderWithModel, type RenderWithModelResult } from "./models";
import { compileProfileRenderPlan, pinnedImageModelVersion } from "./render-profile";

/**
 * THE production render entry point (image-model-capabilities.spec.md
 * §"Normalized render intent") — slice 2 of the capabilities plan, and the seam
 * the identity-pack render slice and the visual-state plan were both waiting on.
 *
 * Every image lane now describes what it wants in one vocabulary — a prompt, a
 * shape, role-carrying references — and this module turns that into the provider
 * payload by way of the profile the lane resolved. Before it, each lane called
 * `renderWithModel` with a model and an anonymous buffer list, so a reference's
 * meaning was its position and no lane could say "this one is the face".
 *
 * The compile step it delegates to ({@link compileProfileRenderPlan}) already
 * existed, built for the identity trial. This module adds only what a trial has
 * no use for: reference selection against the model's capacity, the profile's
 * required-role check, and per-request control overrides.
 *
 * TWO things it deliberately does NOT do, both of which would have changed live
 * renders on the day the lanes moved over:
 *
 * - **No version pin.** A compiled plan carries `versionId` because a controlled
 *   comparison must execute one exact version; production deliberately follows
 *   the slug's floating latest, and now that trial setup re-probes models, a row
 *   can carry a `probedVersionId` that would silently start pinning every
 *   player render to whatever version the trial happened to probe. Pinning
 *   production is the version-promotion slice's job, with the smoke test and
 *   activation flow that make it safe. The intent may CARRY an explicit pin
 *   from a controlled caller (`versionId` — today only the image lab's
 *   controlled experiments set it); the path itself still pins nothing for
 *   production lanes.
 * - **No forced prediction budget.** A plan always carries a numeric `timeoutMs`
 *   so a trial cell can hash its own deadline. All 17 seeded profiles store
 *   null, so honoring the plan's number here would replace
 *   `REPLICATE_PREDICTION_TIMEOUT_MS` with a hardcoded five minutes for every
 *   lane. A profile's budget is used when it declares one; otherwise the
 *   environment still decides.
 */

/** One reference with its bytes. The bytes are why this type is not in `contracts`. */
export interface ImageRenderReference extends ImageRenderReferenceSpec {
  buffer: Buffer;
}

export interface ImageRenderIntent extends ImageRenderIntentCore {
  /**
   * The profile and model this render runs on.
   *
   * Resolved by the CALLER rather than from a `profileSelection` string here,
   * which is the one deviation from the spec's signature. Every lane has to know
   * its model before it reserves an image row — the row's `meta.model` records
   * it, and a lane with no offered profile fails its precondition instead of
   * reserving — so resolving inside this call would mean a second registry read
   * on the render hot path, or a lane that reserves before it knows what it will
   * run. The stored pick still reaches `resolveImageProfileForTask` at the lane.
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
}

/** Exactly what the provider will be handed, and what capacity left behind. */
export interface PlannedImageRender {
  /**
   * The model row as stored. `renderWithModel` applies the reviewed-quality seam
   * itself, so handing it the raw row reproduces today's payload byte for byte;
   * the compile step's `effectiveModel` is the same object after that seam, and
   * passing it would apply the seam twice for no difference.
   */
  model: ImageModel;
  /** The strategy-compiled, model-dialect-prepared prompt. */
  prompt: string;
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
  targetRatio: number;
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
    | "image_profile.prompt_strategy_unsupported";
  message: string;
  context: Record<string, unknown>;
}

export type PlanImageRenderResult = { ok: true; plan: PlannedImageRender } | { ok: false; refusal: ImageRenderRefusal };

/**
 * The pure half: everything decided before a byte leaves the process.
 *
 * Separated from {@link renderImageIntent} so the interesting decisions —
 * capacity trimming, the two required-reference gates (the profile's roles and
 * the caller's own flags), control precedence, a strategy this path cannot
 * execute — are testable without a database or a provider. The IO half below is
 * deliberately thin enough to read in one screen.
 */
export function planImageRender(intent: ImageRenderIntent): PlanImageRenderResult {
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
    basePrompt: intent.prompt,
    baseNegativePrompt: null,
    ...(intent.controls ? { controlOverrides: intent.controls } : {}),
    // Threaded, never resolved here: planning is pure, and resolving a LoRA means
    // reading the library. `renderImageIntent` does that first, so a plan either
    // carries a binding somebody already judged or carries none.
    ...(intent.resolvedLora ? { resolvedLora: intent.resolvedLora } : {}),
    // Built from the PLANNED primary rather than from the caller's list, so a
    // subject travels with the reference through selection and reordering. A
    // subject read off the caller's order instead would name the wrong slot the
    // moment the policy moved one.
    references: { vocabulary: "render_intent", references: compileBindings(primary) },
  });
  if (!compiled.ok) {
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
      references: primary.map((reference) => reference.buffer),
      controlReferences: dedicated.map((input) => ({
        field: input.field,
        arity: input.arity,
        buffers: input.references.map((reference) => reference.buffer),
      })),
      controlInput: compiled.plan.controlInput,
      targetRatio: intent.target.aspectRatio,
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
 * The prompt compiler's view of the references being sent: the role, plus the
 * subject when this reference names one.
 *
 * The subject is omitted rather than passed as `undefined` so a render that names
 * nobody hands the compiler exactly the shape it saw before subjects existed —
 * the compiled text is hashed into comparison identity, and every existing lane
 * must keep producing the same bytes.
 */
function compileBindings(references: readonly ImageRenderReferenceSpec[]): CompileReferenceBinding[] {
  return references.map((reference) => ({
    role: reference.role,
    ...(reference.subject === undefined ? {} : { subject: reference.subject }),
  }));
}

/** The intent a plan will be built from, or the refusal that stops the render. */
type PreparedIntent = { ok: true; intent: ImageRenderIntent } | { ok: false; error: string };

/**
 * Resolve the LoRA this render is asking for, if any, BEFORE anything is planned.
 *
 * The order is the point. Resolution reads the library, so it cannot happen
 * inside the pure planner; and it must happen before the provider call, so a LoRA
 * that does not suit this model costs an operator a refusal rather than a
 * prediction. That makes this the same pre-spend seam as the required-role gate
 * one layer down.
 *
 * A caller that already resolved — the image lab, which settles the refusal onto
 * its own row — passes the binding on the intent and is left alone here, so a lab
 * run reads the library once rather than twice.
 *
 * The version asked about is the intent's explicit pin when it has one, and
 * otherwise whatever pins the row: a LoRA row that lists exact compatible versions
 * must be judged against the version that will actually execute, and a production
 * render following a floating latest honestly has none to offer — which
 * `evaluateImageLoraForRender` answers with `unreachable_configuration` rather
 * than a guess.
 */
async function resolveIntentLora(intent: ImageRenderIntent, sink?: DiagnosticSink): Promise<PreparedIntent> {
  if (intent.resolvedLora) return { ok: true, intent };
  const { profile, model } = intent.profile;
  const selection = effectiveImageLoraSelection(profile.controlDefaults, intent.controls);
  if (!selection) return { ok: true, intent };

  const resolved = await resolveImageLoraForRender(
    selection,
    { model, versionId: intent.versionId ?? pinnedImageModelVersion(model), task: profile.task },
    sink,
  );
  // The refusal's diagnostic is pushed by the resolver, in the code it decided —
  // reporting it again here would double every LoRA failure in the sink.
  if (!resolved.ok) return { ok: false, error: resolved.message };
  return { ok: true, intent: { ...intent, resolvedLora: resolved.binding } };
}

/**
 * Render one intent.
 *
 * A refusal is reported as a returned failure with its own diagnostic, never a
 * throw: a profile that requires a reference the lane has not got is an ordinary
 * configuration state, and every caller already has somewhere to put a failed
 * render (the pipeline marks the row failed; the scene chain falls to its next
 * rung).
 */
export async function renderImageIntent(
  intent: ImageRenderIntent,
  sink?: DiagnosticSink,
): Promise<RenderWithModelResult> {
  const prepared = await resolveIntentLora(intent, sink);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const planned = planImageRender(prepared.intent);
  if (!planned.ok) {
    const { code, message, context } = planned.refusal;
    sink?.push(diag("warn", code, message, { path: "image_model_profiles", context }));
    return { ok: false, error: message };
  }
  const { plan } = planned;
  if (plan.dropped.length > 0) {
    sink?.push(
      diag("info", "image_profile.references_trimmed", "this render will not send every reference it was offered", {
        path: "image_model_profiles",
        context: {
          profile: intent.profile.profile.id,
          slug: plan.model.slug,
          // The roles actually going, read off the plan. Slicing the caller's
          // list by the sent COUNT was equivalent while selection was a
          // positional trim; under policy ordering it names the wrong images.
          sent: roleNames(plan.sentReferences),
          // Roles alone were not enough once a drop could mean three different
          // things: "location dropped" reads as a capacity problem when it may be
          // a profile that never allowed a location at all.
          dropped: plan.dropped.map((entry) => ({ role: entry.reference.role, reason: entry.reason })),
        },
      }),
    );
  }
  // Renumbering is a WARNING, not an observation. Lanes that number their
  // references in the prompt build that text from their own order, before the
  // policy is consulted (`buildSceneRenderPrompt` writes "Image 2: the
  // location"). Reordering is one way the slots move and removal from ahead of a
  // kept reference is the other — dedicate or disallow the second of three and
  // the third arrives as image two under a prompt still calling it image three.
  // No lane triggers either today; if one starts, the prompt and the payload
  // have begun describing different images and the operator needs to know before
  // the renders look subtly wrong.
  if (plan.referencesRenumbered) {
    sink?.push(
      diag("warn", "image_profile.references_renumbered", "a reference is being sent in a slot the lane did not number it as", {
        path: "image_model_profiles",
        context: {
          profile: intent.profile.profile.id,
          slug: plan.model.slug,
          supplied: roleNames(intent.references),
          sending: roleNames(plan.sentReferences),
        },
      }),
    );
  }
  return renderWithModel(
    {
      model: plan.model,
      prompt: plan.prompt,
      references: plan.references,
      controlReferences: plan.controlReferences,
      targetRatio: plan.targetRatio,
      controlInput: plan.controlInput,
      timeoutMs: plan.timeoutMs,
      ...(intent.versionId ? { versionId: intent.versionId } : {}),
    },
    sink,
  );
}
