import { fitReferences, type ImageModel, resolveImageRenderPolicy } from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@vesper/contracts";
import type { ReplicateConfig } from "./config";
import { deleteReplicateFile, transportReplicateReferences, withinDataUrlBudget } from "./files";
import { NOT_CONFIGURED_ERROR, type ReplicateHttp } from "./http";
import { buildPayload, controlUris, type RegistryModelRequest } from "./payload";
import { type ReplicateImageResult, runPrediction } from "./prediction";
import {
  providerInputViolationMessage,
  providerInputViolations,
  unsentReferenceMessage,
  unsentReferenceReports,
} from "./strict-request";

/**
 * Run one registry model.
 *
 * Reference bytes travel one of two ways, per the model's stored
 * `referenceTransport`:
 *
 * - `file` (default) uploads them as private, short-lived Replicate files,
 *   because Vesper's stored images are not publicly addressable and can exceed
 *   the data-URL recommendation; the uploads are deleted best-effort as soon as
 *   the prediction settles.
 * - `data_url` inlines them. Wan 2.7 rejects the uploaded-file URL outright
 *   (`Invalid image format ''` — see `imageReferenceTransports`), so for that
 *   model "smaller payload" is not a trade worth having.
 *
 * References are trimmed through `fitReferences` rather than a fixed cap, so a
 * single-reference model stops being handed three and silently ignoring two.
 *
 * The payload is BUILT and then overlaid: `buildRegistryModelInput` owns the
 * prompt, references, aspect and per-model constants, and `request.controlInput`
 * merges over the result minus the reserved fields. That order is the
 * capabilities spec's — a later layer wins — while keeping the render path's own
 * fields unreachable from a stored profile row.
 */
export async function runRegistryImageModel(
  http: ReplicateHttp,
  config: ReplicateConfig,
  model: ImageModel,
  request: RegistryModelRequest,
  sink?: DiagnosticSink,
): Promise<ReplicateImageResult> {
  if (!http.configured) return { ok: false, error: NOT_CONFIGURED_ERROR };
  const policy = resolveImageRenderPolicy(request.policy);
  const selected = request.references ?? [];
  const references = fitReferences(model, selected);
  const controls = request.controlReferences ?? [];
  // A bound control image is an input image: an edit-only model handed nothing
  // but a pose map has something to work from, and refusing it here would make
  // the dedicated-input path unusable on exactly the models it exists for.
  if (references.length === 0 && controls.length === 0 && !model.canGenerate) {
    return { ok: false, error: `${model.slug} requires at least one reference image` };
  }
  const controlImages = controls.flatMap((control) => control.buffers);

  // The inline byte budget is a SELECTION decision, so it happens before the
  // transport call: bound controls are charged first (they are not negotiable),
  // and the anchor survives even a blown budget. The file transport has no
  // budget — uploads keep the prediction payload small whatever the bytes.
  let send = references;
  if (model.referenceTransport === "data_url") {
    const reserved = controlImages.reduce((total, image) => total + image.bytes.byteLength, 0);
    send = withinDataUrlBudget(references, reserved);
    if (send.length < references.length) {
      sink?.push(
        diag("warn", "image_model.references_trimmed", "dropped references that did not fit the inline byte budget", {
          path: "image_models",
          context: {
            slug: model.slug,
            sent: send.length,
            requested: references.length,
            reservedBytes: reserved,
            // Roles, never bytes or URIs: what was kept and what was given up.
            sentRoles: send.map((image) => image.role ?? "reference"),
            droppedRoles: references.slice(send.length).map((image) => image.role ?? "reference"),
          },
        }),
      );
    }
  }

  // The strict arm's first refusal, and it lands BEFORE the upload: a caller
  // that said "all of these or none" must not pay for a prediction carrying a
  // prefix of its request, and must not leave short-lived files behind either.
  if (policy.references === "require_all" && send.length < selected.length) {
    const unsentReferences = unsentReferenceReports(selected, references.length, send.length);
    sink?.push(
      diag("warn", "image_model.references_untransmittable", "the request selected references this model cannot carry", {
        path: "image_models",
        context: { slug: model.slug, selected: selected.length, sending: send.length, unsentReferences },
      }),
    );
    return { ok: false, error: unsentReferenceMessage(model.slug, unsentReferences), unsentReferences };
  }

  // One numbering across both lists so a Replicate file name is unique within
  // the run; the control images travel last so a reference's name stays what it
  // was before controls existed.
  const transported = await transportReplicateReferences(http, [...send, ...controlImages], model.referenceTransport);
  if (!transported.ok) return { ok: false, error: transported.error };
  try {
    // Split back POSITIONALLY, on the same order they traveled in. Keying a
    // lookup by buffer would collapse two identical control images onto one URL.
    const payload = buildPayload(
      model,
      request,
      transported.uris.slice(0, send.length),
      controlUris(controls, transported.uris.slice(send.length)),
      config.safetyCheckerDisabled,
      sink,
    );
    // The strict arm's second refusal, over the FINISHED payload — the last
    // moment anything can be checked against the version's own schema, and the
    // last moment before the POST costs money.
    if (policy.providerInputs === "strict") {
      const violations = providerInputViolations(model, payload, controls.map((control) => control.field));
      if (violations.length > 0) {
        sink?.push(
          diag("warn", "image_model.provider_input_invalid", "the assembled request contradicts the version's schema", {
            path: "image_models",
            context: { slug: model.slug, violations },
          }),
        );
        return { ok: false, error: providerInputViolationMessage(model.slug, violations), providerInputViolations: violations };
      }
    }
    const result = await runPrediction(http, config, model.slug, payload, request);
    // Stamped on every prediction outcome, success and failure alike: the count
    // is a fact about what was POSTED, and a failed prediction still received
    // exactly these references. The pre-transport refusals above carry no count
    // because nothing was sent.
    return { ...result, sentReferenceCount: send.length };
  } finally {
    await Promise.allSettled(transported.files.map((file) => deleteReplicateFile(http, file.id)));
  }
}
