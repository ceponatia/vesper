import { fitReferences, type ImageModel } from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@vesper/contracts";
import type { ReplicateConfig } from "./config";
import { deleteReplicateFile, transportReplicateReferences, withinDataUrlBudget } from "./files";
import { NOT_CONFIGURED_ERROR, type ReplicateHttp } from "./http";
import { buildPayload, controlUris, type RegistryModelRequest } from "./payload";
import { type ReplicateImageResult, runPrediction } from "./prediction";

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
  const references = fitReferences(model, request.references ?? []);
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

  // One numbering across both lists so a Replicate file name is unique within
  // the run; the control images travel last so a reference's name stays what it
  // was before controls existed.
  const transported = await transportReplicateReferences(http, [...send, ...controlImages], model.referenceTransport);
  if (!transported.ok) return { ok: false, error: transported.error };
  try {
    // Split back POSITIONALLY, on the same order they traveled in. Keying a
    // lookup by buffer would collapse two identical control images onto one URL.
    return await runPrediction(
      http,
      config,
      model.slug,
      buildPayload(
        model,
        request,
        transported.uris.slice(0, send.length),
        controlUris(controls, transported.uris.slice(send.length)),
        config.safetyCheckerDisabled,
        sink,
      ),
      request,
    );
  } finally {
    await Promise.allSettled(transported.files.map((file) => deleteReplicateFile(http, file.id)));
  }
}
