import { and, eq } from "drizzle-orm";
import {
  chooseAspect,
  type ImageLabControlledKind,
  imageLabRecipeProfile,
  type ImageRenderReference,
  mapImageRenderControls,
  referenceCapacity,
  withReviewedImageQuality,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { db, imageLabExperiments } from "../db";
import {
  carriesRawProviderBag,
  checkControlBinding,
  labFailure,
  labRenderer,
  RAW_BAG_REFUSAL,
  readOrderedInputBytes,
  resolvePinnedLabModel,
  runRecipeIntent,
  settleFailed,
  storeLabRender,
} from "./image-lab-render";
import { type ImageLabExperimentRow, type ImageLabRunPayload, storedInputs, storedSettings } from "./image-lab-store";

/**
 * The two control lanes: the Stage 0 `control_probe` and the production-shaped
 * `controlled` recipes.
 */

// --- control_probe ---------------------------------------------------------

/**
 * The Stage 0 probe, spec §Algorithms steps 1–6.
 *
 * Step order is load-bearing rather than incidental: the version pin is checked
 * BEFORE any byte is read and long before any provider call, because a run
 * against an unidentifiable version answers no question and must not be paid
 * for. Production is deliberately unaffected by that rule — an ordinary render
 * happily follows a floating latest, since a portrait that came out well is
 * still a portrait, whereas evidence rendered against an unknown version is not
 * evidence.
 */
export async function runControlProbe(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<ImageLabRunPayload> {
  const inputs = storedInputs(row, sink);
  if (inputs.length === 0) {
    return await settleFailed(row, labFailure("input_missing"), "the experiment records no ordered inputs", sink);
  }

  const resolved = await resolvePinnedLabModel(row.modelSlug, "a probe", sink);
  if (!resolved.ok) {
    return await settleFailed(row, labFailure("version_unpinned"), resolved.message, sink);
  }
  const { model, versionId } = resolved;

  // The quality overlay is applied HERE, before the capacity check, because it
  // is the model the provider is actually handed and the check has to be about
  // that one. (It only merges `extraInput`, so capacity is unchanged — reading
  // capacity off the effective model is what keeps that true if it ever stops
  // being.)
  const effectiveModel = withReviewedImageQuality(model);
  // Capacity is refused, never TRIMMED. `runRegistryImageModel` fits an overlong
  // reference list to the model's arity, so an experiment ordering more images
  // than the version accepts would render happily while its record claimed a
  // control was sent that the provider never received — the one failure mode a
  // bench cannot survive, since the verdict would be about an image nobody saw.
  const capacity = referenceCapacity(effectiveModel);
  if (inputs.length > capacity.max) {
    return await settleFailed(
      row,
      labFailure("capacity_exceeded"),
      `${effectiveModel.slug} accepts ${String(capacity.max)} reference image(s); this experiment orders ${String(inputs.length)}`,
      sink,
      { columns: { requestedVersionId: versionId } },
    );
  }

  const read = await readOrderedInputBytes(inputs, row.ownerId);
  if (!read.ok) {
    return await settleFailed(row, labFailure("input_missing"), read.message, sink, {
      columns: { requestedVersionId: versionId },
    });
  }
  const references = read.ordered.map((entry) => entry.buffer);

  const controlRefusal = await checkControlBinding(row, inputs, sink);
  if (controlRefusal) {
    return await settleFailed(row, labFailure(controlRefusal.code), controlRefusal.message, sink, {
      columns: { requestedVersionId: versionId },
    });
  }

  // The admin's instruction VERBATIM. The numbered-role template is pre-filled
  // in the UI, where the admin can read and edit it, never assembled silently
  // here — a probe whose prompt the runner rewrote would be evidence about the
  // runner.
  const finalPrompt = row.instruction;
  const settings = storedSettings(row, sink);
  const mapped = mapImageRenderControls({ controls: settings.controls, capabilities: effectiveModel.advancedCapabilities });
  if (mapped.dropped.length > 0) {
    sink?.push(
      diag("info", "image_lab.controls_dropped", "some normalized controls have no binding on this version", {
        context: { experimentId: row.id, slug: effectiveModel.slug, dropped: mapped.dropped },
      }),
    );
  }
  // The raw provider-shaped bag merges LAST, per the contract's own layering:
  // it is the escape hatch the lab needs and production does not, and settling
  // whether a model honours an undocumented input cannot be asked through a
  // vocabulary that predates the answer.
  const controlInput = { ...mapped.input, ...settings.controlInput };

  await db()
    .update(imageLabExperiments)
    .set({ requestedVersionId: versionId, finalPrompt })
    .where(and(eq(imageLabExperiments.id, row.id), eq(imageLabExperiments.ownerId, row.ownerId)));

  const rendered = await labRenderer()(
    {
      mode: "direct",
      model: effectiveModel,
      prompt: finalPrompt,
      references,
      controlInput,
      aspect: chooseAspect(effectiveModel).value,
      versionId,
    },
    sink,
  );
  return await storeLabRender(row, rendered, {
    finalPrompt,
    sourceImageId: inputs[0]?.imageId,
    columns: { requestedVersionId: versionId },
    sink,
  });
}

// --- controlled recipes ----------------------------------------------------

/**
 * A controlled run: the render-intent path, wearing a pinned version and a
 * code-defined recipe profile (`imageLabRecipeProfile`).
 *
 * The probe above deliberately BYPASSES `renderImageIntent`; this runner
 * deliberately goes through it, because its question is different. A probe asks
 * "does the model obey a control at all?", answered best by handing the
 * provider an exact ordered list. A controlled experiment asks "does the
 * control still hold when the request is production-shaped?" — policy-driven
 * selection, compose-strategy wording, capacity handled the way a lane handles
 * it. Running that any other way would prove something production never does.
 *
 * Two consequences of that choice are deliberate:
 *
 * - Capacity TRIMS here instead of refusing; `capacity_exceeded` stays a probe
 *   code. The intent path fits an overlong list exactly as every lane does,
 *   and the run stays honest because what went and what did not is recorded on
 *   the row as its `outcome` — the record keeps the render honest, where the
 *   probe needed a refusal.
 * - The raw `controlInput` bag is REFUSED (`settings_unsupported`), never
 *   merged and never silently stripped. It is a probe tool; production has no
 *   raw bag, so a run carrying one would not be the production-shaped evidence
 *   this kind exists to produce — and stripping it would render something
 *   other than what the admin recorded.
 *
 * The Stage 0 fixture gates are reused unchanged (`checkControlBinding`): a
 * controlled run still declares its control, sends it exactly once under a
 * control role, and refuses an unreviewed fixture or the fixture's own source
 * render — all before any spend.
 */
export async function runControlled(
  row: ImageLabExperimentRow,
  kind: ImageLabControlledKind,
  sink?: DiagnosticSink,
): Promise<ImageLabRunPayload> {
  const inputs = storedInputs(row, sink);
  if (inputs.length === 0) {
    return await settleFailed(row, labFailure("input_missing"), "the experiment records no ordered inputs", sink);
  }
  const controlKind = row.controlKind;
  if (controlKind === null) {
    return await settleFailed(
      row,
      labFailure("control_invalid"),
      "a controlled experiment records the control kind it runs",
      sink,
    );
  }

  const resolved = await resolvePinnedLabModel(row.modelSlug, "a controlled experiment", sink);
  if (!resolved.ok) {
    return await settleFailed(row, labFailure("version_unpinned"), resolved.message, sink);
  }
  const { model, versionId } = resolved;
  // Recorded on every settle from here on: the pin and the model are resolved
  // facts about this run whether or not it reaches the provider.
  const columns = { requestedVersionId: versionId, modelSlug: model.slug };

  const controlRefusal = await checkControlBinding(row, inputs, sink);
  if (controlRefusal) {
    return await settleFailed(row, labFailure(controlRefusal.code), controlRefusal.message, sink, { columns });
  }

  const settings = storedSettings(row, sink);
  if (carriesRawProviderBag(settings)) {
    return await settleFailed(row, labFailure("settings_unsupported"), RAW_BAG_REFUSAL, sink, { columns });
  }

  const read = await readOrderedInputBytes(inputs, row.ownerId);
  if (!read.ok) {
    return await settleFailed(row, labFailure("input_missing"), read.message, sink, { columns });
  }
  // Identity and the declared control are REQUIRED so the plan refuses rather
  // than renders when either is pushed out; everything else may be trimmed and
  // recorded. No priority — the recipe's roleOrder and the admin's own order
  // decide, and a second ranking would let the two disagree.
  const references: ImageRenderReference[] = read.ordered.map(({ input, buffer }) => ({
    role: input.role,
    buffer,
    sourceImageId: input.imageId,
    required: input.role === "identity" || input.imageId === row.controlImageId,
  }));

  return await runRecipeIntent(row, {
    model,
    versionId,
    recipeProfile: imageLabRecipeProfile(kind, controlKind, model.id),
    references,
    prompt: row.instruction,
    controls: settings.controls,
    columns,
    provenanceRole: "identity",
    fallbackSourceImageId: inputs[0]?.imageId,
    sink,
  });
}
