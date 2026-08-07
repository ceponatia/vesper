import {
  missingRequiredReferenceRoles,
  selectIntentReferences,
  type ImageModel,
  type ImageReferenceRole,
  type ImageRenderIntentCore,
  type ImageRenderReferenceSpec,
  type ResolvedImageProfile,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { renderWithModel, type RenderWithModelResult } from "./models";
import { compileProfileRenderPlan } from "./render-profile";

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
 *   activation flow that make it safe.
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
  /** Mapped controls plus validated overrides, keyed by provider field name. */
  controlInput: Record<string, unknown>;
  targetRatio: number;
  /** The profile's own budget, or null to leave it to the environment. */
  timeoutMs: number | null;
  /** References the model's capacity could not take, in caller order. */
  dropped: ImageRenderReference[];
}

/** Why a render was refused before any provider work happened. */
export interface ImageRenderRefusal {
  code: "image_profile.required_reference_missing" | "image_profile.prompt_strategy_unsupported";
  message: string;
  context: Record<string, unknown>;
}

export type PlanImageRenderResult = { ok: true; plan: PlannedImageRender } | { ok: false; refusal: ImageRenderRefusal };

/**
 * The pure half: everything decided before a byte leaves the process.
 *
 * Separated from {@link renderImageIntent} so the interesting decisions —
 * capacity trimming, the required-role gate, control precedence, a strategy this
 * path cannot execute — are testable without a database or a provider. The IO
 * half below is deliberately thin enough to read in one screen.
 */
export function planImageRender(intent: ImageRenderIntent): PlanImageRenderResult {
  const { profile, model } = intent.profile;
  const { selected, dropped } = selectIntentReferences(model, intent.references);

  // Checked against the SELECTED references, not the supplied ones: a required
  // identity anchor that capacity pushed out is exactly as absent as one the
  // lane never had, and rendering anyway would produce a stranger.
  const missing = missingRequiredReferenceRoles(profile.referencePolicy, selected);
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

  const compiled = compileProfileRenderPlan({
    model,
    profile,
    basePrompt: intent.prompt,
    baseNegativePrompt: null,
    ...(intent.controls ? { controlOverrides: intent.controls } : {}),
    references: { vocabulary: "render_intent", roles: roleNames(selected) },
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
      references: selected.map((reference) => reference.buffer),
      controlInput: compiled.plan.controlInput,
      targetRatio: intent.target.aspectRatio,
      timeoutMs: profile.timeoutMs,
      dropped,
    },
  };
}

function roleNames(references: readonly ImageRenderReferenceSpec[]): ImageReferenceRole[] {
  return references.map((reference) => reference.role);
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
  const planned = planImageRender(intent);
  if (!planned.ok) {
    const { code, message, context } = planned.refusal;
    sink?.push(diag("warn", code, message, { path: "image_model_profiles", context }));
    return { ok: false, error: message };
  }
  const { plan } = planned;
  if (plan.dropped.length > 0) {
    sink?.push(
      diag("info", "image_profile.references_trimmed", "the model could not accept every reference this render offered", {
        path: "image_model_profiles",
        context: {
          profile: intent.profile.profile.id,
          slug: plan.model.slug,
          sent: roleNames(intent.references).slice(0, plan.references.length),
          dropped: roleNames(plan.dropped),
        },
      }),
    );
  }
  return renderWithModel(
    {
      model: plan.model,
      prompt: plan.prompt,
      references: plan.references,
      targetRatio: plan.targetRatio,
      controlInput: plan.controlInput,
      timeoutMs: plan.timeoutMs,
    },
    sink,
  );
}
