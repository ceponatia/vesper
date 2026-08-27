import type { ReplicateConfig } from "./config";
import { deleteReplicateFile, referenceDataUrl, uploadReplicateFile } from "./files";
import { NOT_CONFIGURED_ERROR, type ReplicateHttp } from "./http";
import { type ReplicateImageResult, runPrediction } from "./prediction";

/**
 * One image-in, image-out PREPROCESSOR run for control extraction — a pose
 * skeleton renderer, a depth estimator.
 *
 * It is a separate entry point rather than a registry model with a profile
 * because a preprocessor is a LAB TOOL, not something a player can be rendered
 * with: it has no prompt, no aspect, no reference arity, no quality overlay and
 * no picker, and registering one would put a skeleton renderer in every image
 * model list in the app. What it shares with a render — the prediction shell,
 * the poll regime, the output-host allow-list, the file upload and its
 * best-effort delete — it shares by using the same code.
 *
 * The version pin is REQUIRED and has no floating fallback, unlike a production
 * render. A control fixture is evidence: a skeleton extracted by whatever the
 * provider called `latest_version` that hour cannot be compared against one
 * extracted last week, and the probe verdict it feeds would be about an unknown
 * extractor as much as about the model under test.
 *
 * There is NO retry loop, exactly as the render path has none: a preprocessor
 * that failed once has spent provider money, and spending it again
 * automatically is a decision for the admin looking at the failure, not for
 * this function.
 */
export interface ReplicatePreprocessorRequest {
  /** `owner/name` of the pinned preprocessor — recorded, and shape-checked here. */
  slug: string;
  /** The EXACT provider version to execute. Never optional (see above). */
  versionId: string;
  /** The single source image, as stored (webp). */
  image: Buffer;
  /** The provider's own key for that image — `image` on both Stage 0 pins. */
  imageField: string;
  /**
   * Literal extra inputs this version needs, e.g. the thirteen switches that
   * turn every preprocessor but one OFF on a multi-preprocessor cog. Written
   * BEFORE the image field, so a stray key can never displace the source.
   */
  input?: Record<string, unknown>;
  /** Which member of an object output carries the produced map. */
  outputField?: string;
  /**
   * How the bytes travel. `file` (the default, and the house default for every
   * reference) uploads a private, short-lived Replicate file and deletes it as
   * soon as the prediction settles; `data_url` inlines them for a cog that
   * refuses uploaded-file URLs.
   */
  transport?: "file" | "data_url";
  /** This run's prediction budget; absent leaves it to the configured default. */
  timeoutMs?: number;
}

export async function runReplicatePreprocessor(
  http: ReplicateHttp,
  config: ReplicateConfig,
  request: ReplicatePreprocessorRequest,
): Promise<ReplicateImageResult> {
  if (!http.configured) return { ok: false, error: NOT_CONFIGURED_ERROR };

  const run = (imageUrl: string): Promise<ReplicateImageResult> =>
    runPrediction(
      http,
      config,
      request.slug,
      { ...request.input, [request.imageField]: imageUrl },
      {
        versionId: request.versionId,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.outputField !== undefined ? { outputField: request.outputField } : {}),
      },
    );

  // The source is always a stored Vesper asset, and those are webp by the
  // storage contract (`writeWebpAtomic`) — the one place a constant media type
  // is still a fact rather than an assumption.
  if (request.transport === "data_url") return run(referenceDataUrl(request.image, "image/webp"));

  const upload = await uploadReplicateFile(http, request.image, "vesper-preprocessor-source.webp", "image/webp");
  if (!upload.ok) return { ok: false, error: upload.error };
  try {
    return await run(upload.file.url);
  } finally {
    await deleteReplicateFile(http, upload.file.id).catch(() => undefined);
  }
}
