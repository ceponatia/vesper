import {
  effectiveImageLoraSelection,
  type ImageReferenceRole,
  type ImageRenderIntent,
  type ImageRenderReferenceSpec,
  type ImageRenderRuntimeFacts,
  pinnedImageModelVersion,
  planImageRender,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { disableSafetyChecker } from "../ai";
import { resolveImageLoraForRender } from "./image-loras";
import { renderWithModel, type RenderWithModelResult } from "./models";

/**
 * THE production render entry point (image-model-capabilities.spec.md
 * §"Normalized render intent") — the IO half of the render path.
 *
 * The planning half is `planImageRender` in `@vesper/image-core`: pure,
 * database-free, deployment-free. What is left here is everything that is not —
 * resolving the LoRA binding against the library, resolving the deployment facts
 * a pure planner may not read, reporting diagnostics, and calling the transport.
 *
 * That split is the point of the render-kernel slice: the decisions about what a
 * provider is sent can now be exercised with no application in the process,
 * while the application keeps ownership of everything stateful.
 */

/**
 * The deployment facts this process is configured with, read at the boundary and
 * handed to the pure planner.
 *
 * Resolved immediately before planning rather than cached, because that is where
 * today's payload builder reads it too: the compile path and the send path
 * currently ask the same environment the same question at two moments. Slice 4
 * of the monorepo plan closes that seam by resolving Replicate configuration
 * once for the process — until then, this matches existing behavior exactly.
 */
function currentRuntimeFacts(): ImageRenderRuntimeFacts {
  return { safetyCheckerDisabled: disableSafetyChecker() };
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
  const planned = planImageRender(prepared.intent, currentRuntimeFacts());
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

/** The roles a diagnostic is about, in the order they were given or sent. */
function roleNames(references: readonly ImageRenderReferenceSpec[]): ImageReferenceRole[] {
  return references.map((reference) => reference.role);
}
