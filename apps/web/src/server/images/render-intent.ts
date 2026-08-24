import {
  effectiveImageLoraSelection,
  type ImageInputBinding,
  type ImageReferenceRole,
  type ImageRenderIntent,
  type ImageRenderReferenceSpec,
  pinnedImageModelVersion,
  planImageRender,
  type PlannedImageRender,
  type ResolvedImageAttempt,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { resolveImageLoraForRender } from "./image-loras";
import { withLoraDownloadCredential } from "./lora-credentials";
import { imageRenderRuntimeFacts } from "./model-adapters";
import { renderWithModel, type RenderWithModelResult } from "./models";

/**
 * THE production render entry point (image-model-capabilities.spec.md
 * §"Normalized render intent") — the IO half of the render path.
 *
 * The planning half is `planImageRender` in `@vesper/image-core`: pure,
 * database-free, deployment-free. What is left here is everything that is not —
 * resolving the LoRA binding against the library, resolving the seed (the one
 * place randomness may enter a plan), resolving the deployment facts and the
 * model family's dialect a pure planner may not read (`imageRenderRuntimeFacts`),
 * reporting diagnostics, calling the transport, and assembling the attempt's
 * provenance record.
 *
 * That split is the point of the render-kernel slice: the decisions about what a
 * provider is sent can now be exercised with no application in the process,
 * while the application keeps ownership of everything stateful.
 */

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
    {
      model,
      versionId: intent.versionId ?? pinnedImageModelVersion(model),
      // THE production lane: both the mechanical checks and the row's own
      // `allowedTasks` curation apply, exactly as they did before contexts
      // existed. Every caller reaching this function is serving a player.
      execution: { kind: "production", task: profile.task },
    },
    sink,
  );
  // The refusal's diagnostic is pushed by the resolver, in the code it decided —
  // reporting it again here would double every LoRA failure in the sink.
  if (!resolved.ok) return { ok: false, error: resolved.message };
  return { ok: true, intent: { ...intent, resolvedLora: resolved.binding } };
}

/**
 * Complete the resolved LoRA's locator with the download credential it needs.
 *
 * THE one point where a stored locator becomes a fetchable one, and it is here
 * rather than in the library or the mapper for two reasons. It is downstream of
 * BOTH resolution paths — the caller that pre-resolved (the image lab, the
 * intimate-scene route) and the caller that let `resolveIntentLora` do it — so
 * neither can reach a provider uncompleted. And it is the last app-side step
 * before planning, which keeps the credential out of everything upstream: the
 * database row, the admin screens, the image row's `meta`, and every diagnostic,
 * all of which only ever see the stored address.
 *
 * Downstream of here the locator travels in exactly one direction: into
 * `plan.controlInput` under the version's `loraWeights` field, and from there
 * into the prediction body. The mapper deliberately keeps it out of
 * `appliedControls` (which records `{ id, scale }`), so nothing that is stored
 * or reported carries it. The compile step's fingerprint hashes `controlInput`,
 * so a rotated token changes a comparison hash — accepted: the alternative is a
 * fingerprint that describes a payload the provider never received.
 *
 * Returns the intent UNCHANGED — same object — when nothing needed adding, so a
 * render with no LoRA, a Hugging Face slug, or a deployment without the token is
 * byte-identical to what it was before this seam existed.
 */
function withLoraCredential(intent: ImageRenderIntent): ImageRenderIntent {
  const binding = intent.resolvedLora;
  if (!binding) return intent;
  const completed = withLoraDownloadCredential(binding);
  return completed === binding ? intent : { ...intent, resolvedLora: completed };
}

/**
 * The ceiling of the generated-seed range when the version's binding declares
 * no maximum: 2^31 − 1, the widest span every seed-taking provider input in the
 * probed set accepts (signed 32-bit), and comfortably within the normalized
 * contract's non-negative integer.
 */
const DEFAULT_SEED_MAX = 2 ** 31 - 1;

/**
 * A uniform random integer inside the binding's declared range, floored at zero
 * (the normalized contract refuses a negative seed — some providers use `-1` as
 * a second spelling of "random", and two spellings of random is how a replayed
 * attempt stops being reproducible). Null when the declared range admits no
 * such integer — then nothing is generated and the run is honestly unseeded.
 */
function randomSeedWithin(binding: ImageInputBinding): number | null {
  const minimum = Math.max(0, Math.ceil(binding.minimum ?? 0));
  const maximum = Math.floor(Math.min(binding.maximum ?? DEFAULT_SEED_MAX, Number.MAX_SAFE_INTEGER));
  if (maximum < minimum) return null;
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

/**
 * Resolve the seed this render runs under — the ONE place randomness enters the
 * render path, kept here because the compile step is pure and a plan that
 * rolled its own dice could never be fingerprinted or replayed.
 *
 * An explicit `controls.seed` always wins, whatever the policy: it is either a
 * caller replaying a stored composition or a request that deserves to be
 * honoured verbatim. Otherwise a `random`-policy profile draws a fresh seed —
 * but only when the active version's probed bindings declare a seed field,
 * because a generated number the mapper would immediately drop records a seed
 * the provider never saw as if it shaped the image. An explicitly PINNED render
 * (`intent.versionId`) draws nothing either: the row's probed bindings describe
 * the ACTIVE version, not the pin, so a drawn number would be validated against
 * a range the pinned version never declared. `reuse_source` and `caller`
 * resolve nothing here (the source seed and the caller's seed both arrive as
 * the explicit value when they exist at all); unresolved, they surface as the
 * compile step's `seedPolicy` drop.
 */
function resolveIntentSeed(intent: ImageRenderIntent): { intent: ImageRenderIntent; seed: number | null } {
  const explicit = intent.controls?.seed;
  if (explicit !== undefined) return { intent, seed: explicit };
  if (intent.versionId) return { intent, seed: null };
  const { profile, model } = intent.profile;
  if (profile.controlDefaults.seedPolicy !== "random") return { intent, seed: null };
  const binding = model.advancedCapabilities.controls.seed;
  if (!binding) return { intent, seed: null };
  const seed = randomSeedWithin(binding);
  if (seed === null) return { intent, seed: null };
  return { intent: { ...intent, controls: { ...intent.controls, seed } }, seed };
}

/** What `renderImageIntent` returns: the render result plus, when a plan existed, its provenance. */
export interface RenderImageIntentResult extends RenderWithModelResult {
  /**
   * The attempt's provenance record, present on success AND failure whenever a
   * plan was compiled — a failed prediction's id is exactly what an operator
   * needs. Absent only when the render was refused before planning (LoRA
   * resolution, a plan refusal), where there is no attempt to describe.
   */
  attempt?: ResolvedImageAttempt;
}

/** Assemble the provenance record from the plan, the resolved seed, and the provider's echo. */
function resolvedAttempt(
  intent: ImageRenderIntent,
  plan: PlannedImageRender,
  seed: number | null,
  result: RenderWithModelResult,
): ResolvedImageAttempt {
  const { profile, model } = intent.profile;
  const plannedRoles = roleNames(plan.sentReferences);
  return {
    modelId: model.id,
    modelSlug: model.slug,
    profileId: profile.id,
    task: profile.task,
    promptStrategy: profile.promptStrategy,
    requestedVersionId: intent.versionId ?? null,
    seed,
    appliedControls: plan.appliedControls,
    droppedControls: plan.droppedControls,
    // Truncated to what the transport says it SENT (the data_url byte budget
    // can trim the plan's tail), so `meta.render` never claims a trimmed
    // reference went. Absent count means the transport never said — then the
    // plan's list is the only honest answer available.
    sentReferenceRoles:
      result.sentReferenceCount !== undefined ? plannedRoles.slice(0, result.sentReferenceCount) : plannedRoles,
    predictionId: result.predictionId ?? null,
    executedVersionId: result.executedVersionId ?? null,
  };
}

/** The produce-meta fragment recording one attempt under the row's `render` key. */
export function renderAttemptMeta(attempt: ResolvedImageAttempt | undefined): { meta?: Record<string, unknown> } {
  return attempt ? { meta: { render: attempt } } : {};
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
): Promise<RenderImageIntentResult> {
  const prepared = await resolveIntentLora(intent, sink);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const seeded = resolveIntentSeed(withLoraCredential(prepared.intent));
  // The sink reaches the planner because prompt fitting reports there: an intent
  // carrying segments can lose optional detail, or a mandatory sentence, to a
  // version's declared prompt ceiling, and that is a degradation an operator has
  // to be able to see.
  // The deployment facts, with this model family's dialect joined to them. Read
  // immediately before planning rather than cached, because that is where the
  // payload builder reads the same environment too.
  const planned = planImageRender(seeded.intent, imageRenderRuntimeFacts(seeded.intent.profile.model), sink);
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
  const result = await renderWithModel(
    {
      model: plan.model,
      prompt: plan.prompt,
      references: plan.references,
      // The plan's roles, index-parallel with its buffers, so the transport's
      // trim diagnostics name real roles rather than "reference".
      referenceRoles: roleNames(plan.sentReferences),
      controlReferences: plan.controlReferences,
      targetRatio: plan.targetRatio,
      dimensionFacts: plan.dimensionFacts,
      controlInput: plan.controlInput,
      typedControlFields: plan.typedControlFields,
      // The caller's send-strictness, resolved by the planner and passed
      // through: production keeps trimming what does not fit, and a bench that
      // asked for all-or-nothing gets its refusal before the prediction.
      policy: plan.policy,
      timeoutMs: plan.timeoutMs,
      ...(intent.versionId ? { versionId: intent.versionId } : {}),
      // PASSED THROUGH, never synthesized. A production lane deliberately
      // carries no execution policy and keeps the transport's single-budget
      // shell (plan §8, owner ruling 2026-08-24); only the benches put one on
      // their intent, and this is where theirs reaches the transport. Inventing
      // a default here would silently move every player-facing render onto
      // two-phase budgets and startup retries.
      ...(intent.executionPolicy ? { executionPolicy: intent.executionPolicy } : {}),
    },
    sink,
  );
  return { ...result, attempt: resolvedAttempt(seeded.intent, plan, seeded.seed, result) };
}

/** The roles a diagnostic is about, in the order they were given or sent. */
function roleNames(references: readonly ImageRenderReferenceSpec[]): ImageReferenceRole[] {
  return references.map((reference) => reference.role);
}
