import {
  createReplicateClient,
  DEFAULT_PREDICTION_TIMEOUT_MS,
  MAX_PREDICTION_TIMEOUT_MS,
  MIN_PREDICTION_TIMEOUT_MS,
  type ReplicateClient,
  type ReplicateConfig,
  previewRegistryModelInput,
} from "@vesper/image-replicate";
import { imageAspectInputField, type ImageModel, type ImageRenderPolicy } from "@vesper/image-core";
import { imageModelProvider } from "@vesper/image-models";
import {
  falQwen3PayloadFromUrls,
  hasFal,
  isFalQwen3Slug,
  qwen3ImageSize,
  runFalQwen3ImageModel,
} from "./fal-runtime";

/**
 * The application's Replicate runtime — the ONLY code in Vesper that reads
 * Replicate environment variables.
 *
 * The transport package performs the network IO but owns no ambient
 * configuration. Deployment settings are the application's: this module
 * resolves them once, builds one configured client, and hands that client to
 * every render, preprocessor run and schema probe in the process.
 *
 * Qwen Image 3 is the narrow exception at the registry-render method: its two
 * fal endpoint rows are intercepted here and sent through `fal-runtime`. Keeping
 * the dispatch at this application boundary means all existing callers still
 * use one registry-render method while Replicate probes, preprocessors, LoRAs,
 * Qwen Image 2, 2511/2512 and every other model remain Replicate-native.
 *
 * That single snapshot is what makes the Replicate safety posture single-source.
 * The render kernel fingerprints a plan with `disableSafetyChecker()` and the
 * Replicate payload builder writes `client.safetyCheckerDisabled`; because both
 * are the same resolved value, a process cannot hash one posture and send another.
 * fal Qwen 3 owns its explicit `enable_safety_checker: false` in its endpoint row
 * and transport instead.
 */

let client: ReplicateClient | null = null;
let routedClient: ReplicateClient | null = null;

/**
 * Read the deployment's Replicate settings.
 *
 * Behavior is the transport's historical behavior, moved rather than changed:
 *
 * - a missing or blank token means the provider is unavailable;
 * - `REPLICATE_SAFE_MODE === "true"` keeps the provider's safety checker on;
 *   every other value (including unset) disables it, which is the controlled
 *   environment's default;
 * - the prediction budget is honored only when finite and at least 30 seconds,
 *   is clamped at 30 minutes, and otherwise falls back to five minutes.
 */
export function resolveReplicateConfig(): ReplicateConfig {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  const requested = Number(process.env.REPLICATE_PREDICTION_TIMEOUT_MS);
  return {
    apiToken: token ? token : null,
    safetyCheckerDisabled: process.env.REPLICATE_SAFE_MODE !== "true",
    predictionTimeoutMs:
      Number.isFinite(requested) && requested >= MIN_PREDICTION_TIMEOUT_MS
        ? Math.min(requested, MAX_PREDICTION_TIMEOUT_MS)
        : DEFAULT_PREDICTION_TIMEOUT_MS,
  };
}

/**
 * The process's configured image registry client, preserving Replicate's public
 * client surface while routing the two fal Qwen Image 3 rows at render time.
 *
 * A concrete object rather than a Proxy on purpose: all three methods stay
 * contextually typed as `ReplicateClient`, which keeps provider dispatch under
 * the repository's no-unsafe-any lint rule.
 *
 * Lazily rather than at module import: Next loads server modules while building
 * and analyzing routes, when runtime secrets are absent, and a snapshot taken
 * then would describe the build machine rather than the deployment.
 */
export function replicateClient(): ReplicateClient {
  client ??= createReplicateClient(resolveReplicateConfig());
  if (routedClient) return routedClient;

  const target = client;
  routedClient = {
    configured: target.configured,
    safetyCheckerDisabled: target.safetyCheckerDisabled,
    runRegistryImageModel: async (model, request, sink) => {
      if (isFalQwen3Slug(model.slug)) {
        if ((request.controlReferences?.length ?? 0) > 0) {
          return { ok: false, error: `${model.slug} does not expose dedicated structural image inputs` };
        }
        return runFalQwen3ImageModel(model, {
          prompt: request.prompt,
          references: request.references,
          aspect: request.aspect,
          controlInput: request.controlInput,
          timeoutMs: request.timeoutMs,
        });
      }
      return target.runRegistryImageModel(model, request, sink);
    },
    runReplicatePreprocessor: (request) => target.runReplicatePreprocessor(request),
    probeReplicateModel: (slug) => target.probeReplicateModel(slug),
  };
  return routedClient;
}

/** Whether this deployment can reach Replicate at all. */
export function hasReplicate(): boolean {
  client ??= createReplicateClient(resolveReplicateConfig());
  return client.configured;
}

/** Whether the credential for this model's actual provider is configured. */
export function hasImageProviderForModel(model: Pick<ImageModel, "slug"> | string): boolean {
  const slug = typeof model === "string" ? model : model.slug;
  return imageModelProvider(slug) === "fal" ? hasFal() : hasReplicate();
}

/** Whether this deployment has at least one image transport configured. */
export function hasAnyImageProvider(): boolean {
  return hasFal() || hasReplicate();
}

/** Stable persisted identity for the provider-qualified registry model. */
export function qualifiedImageModelIdentity(model: Pick<ImageModel, "slug"> | null | undefined): string {
  if (!model) return "replicate/none";
  return `${imageModelProvider(model.slug)}/${model.slug}`;
}

export interface PreviewImageModelRequest {
  model: ImageModel;
  prompt: string;
  referenceCount: number;
  controlReferences?: readonly { field: string; arity: "single" | "array"; count: number }[];
  aspect: string | null;
  controlInput?: Record<string, unknown>;
  policy?: ImageRenderPolicy;
}

/** Provider-dispatched wire preview beside the provider-dispatched actual send. */
export interface PreviewedImageModelRequest {
  request: Record<string, unknown>;
  sentShape: ImageModelSentShape;
}

export interface ImageModelSentShape {
  field: string | null;
  value: unknown;
}

/** The provider field/value pair the final transport writes for image shape. */
export function imageModelSentShape(input: {
  model: ImageModel;
  aspect: string | null;
  controlInput?: Readonly<Record<string, unknown>>;
}): ImageModelSentShape {
  if (imageModelProvider(input.model.slug) === "fal") {
    const tier = input.controlInput?.["image_size"] === "2K" ? "2K" : "1K";
    return { field: "image_size", value: qwen3ImageSize(input.aspect, tier) };
  }
  return {
    field: input.aspect === null ? null : imageAspectInputField(input.model),
    value: input.aspect,
  };
}

export function previewImageModelRequest(input: PreviewImageModelRequest): PreviewedImageModelRequest {
  if (imageModelProvider(input.model.slug) === "fal") {
    if ((input.controlReferences?.length ?? 0) > 0) {
      throw new Error(`${input.model.slug} does not expose dedicated structural image inputs`);
    }
    const references = Array.from(
      { length: input.referenceCount },
      (_unused, index) => `https://placeholder.invalid/reference-${String(index + 1)}`,
    );
    const request = falQwen3PayloadFromUrls(
      input.model,
      {
        prompt: input.prompt,
        aspect: input.aspect,
        controlInput: input.controlInput,
      },
      references,
    );
    return { request, sentShape: imageModelSentShape(input) };
  }
  return {
    request: previewRegistryModelInput({ ...input, safetyCheckerDisabled: disableSafetyChecker() }),
    sentShape: imageModelSentShape(input),
  };
}

/**
 * Whether generated Replicate images bypass the provider's safety checker.
 *
 * Anything that fingerprints what a Replicate render sends asks THIS, the same
 * value the payload builder writes — otherwise the fingerprint would describe a
 * stored placeholder while the provider received the deployment's answer.
 */
export function disableSafetyChecker(): boolean {
  client ??= createReplicateClient(resolveReplicateConfig());
  return client.safetyCheckerDisabled;
}

/**
 * Drop the memoized clients so the next call re-reads the environment.
 *
 * For tests that need to run under a different deployment posture than the one
 * the first call happened to resolve. Production never calls it: one process,
 * one snapshot.
 */
export function resetReplicateRuntimeForTesting(): void {
  client = null;
  routedClient = null;
}
