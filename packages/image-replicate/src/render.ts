import { fitReferences, type ImageModel } from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@vesper/contracts";
import type { ReplicateConfig } from "./config";
import {
  deleteReplicateFile,
  type ReplicateFile,
  referenceDataUrl,
  uploadReplicateFile,
  withinDataUrlBudget,
} from "./files";
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
  const controlBuffers = controls.flatMap((control) => control.buffers);

  if (model.referenceTransport === "data_url") {
    const reserved = controlBuffers.reduce((total, buffer) => total + buffer.byteLength, 0);
    const inlined = withinDataUrlBudget(references, reserved);
    if (inlined.length < references.length) {
      sink?.push(
        diag("warn", "image_model.references_trimmed", "dropped references that did not fit the inline byte budget", {
          path: "image_models",
          context: { slug: model.slug, sent: inlined.length, requested: references.length, reservedBytes: reserved },
        }),
      );
    }
    return await runPrediction(
      http,
      config,
      model.slug,
      buildPayload(
        model,
        request,
        inlined.map(referenceDataUrl),
        controlUris(controls, controlBuffers.map(referenceDataUrl)),
        config.safetyCheckerDisabled,
        sink,
      ),
      request,
    );
  }

  const uploads: ReplicateFile[] = [];
  try {
    // One numbering across both lists so a Replicate file name is unique within
    // the run; the control images upload last so a reference's name stays what it
    // was before controls existed.
    for (const [index, buffer] of [...references, ...controlBuffers].entries()) {
      const upload = await uploadReplicateFile(http, buffer, `vesper-reference-${index + 1}.webp`);
      if (!upload.ok) return { ok: false, error: upload.error };
      uploads.push(upload.file);
    }
    // Split back POSITIONALLY, on the same order they were uploaded in. Keying a
    // lookup by buffer would collapse two identical control images onto one URL.
    const urls = uploads.map((file) => file.url);
    return await runPrediction(
      http,
      config,
      model.slug,
      buildPayload(
        model,
        request,
        urls.slice(0, references.length),
        controlUris(controls, urls.slice(references.length)),
        config.safetyCheckerDisabled,
        sink,
      ),
      request,
    );
  } finally {
    await Promise.allSettled(uploads.map((file) => deleteReplicateFile(http, file.id)));
  }
}
