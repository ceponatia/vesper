import type { ImageModel } from "@vesper/image-core";
import type { DiagnosticSink } from "@vesper/contracts";
import type { ReplicateConfig } from "./config";
import { createReplicateHttp } from "./http";
import type { RegistryModelRequest } from "./payload";
import type { ReplicateImageResult } from "./prediction";
import { type ReplicatePreprocessorRequest, runReplicatePreprocessor } from "./preprocessor";
import { type ProbeResult, probeReplicateModel } from "./probe";
import { runRegistryImageModel } from "./render";

/**
 * One configured provider, for the lifetime of a process.
 *
 * Everything that needs credentials hangs off this object rather than reading
 * them per call, which is what makes the safety posture single-source: the value
 * a render's plan was fingerprinted with is the same immutable value the payload
 * builder writes, because both come from this client's config — one safety value
 * from plan to send.
 */
export interface ReplicateClient {
  /** False when no token was configured; every call fails before network work. */
  readonly configured: boolean;
  /**
   * Whether generated images bypass the provider's safety checker. Read this
   * when planning a render, so the plan and the request agree.
   */
  readonly safetyCheckerDisabled: boolean;

  runRegistryImageModel(
    model: ImageModel,
    request: RegistryModelRequest,
    sink?: DiagnosticSink,
  ): Promise<ReplicateImageResult>;

  runReplicatePreprocessor(request: ReplicatePreprocessorRequest): Promise<ReplicateImageResult>;

  probeReplicateModel(slug: string): Promise<ProbeResult>;
}

export function createReplicateClient(config: ReplicateConfig): ReplicateClient {
  // Copied, not captured by reference: a caller that mutates the object it
  // passed in must not be able to change what an in-flight render sends.
  const settings: ReplicateConfig = { ...config };
  const http = createReplicateHttp(settings);
  return {
    configured: http.configured,
    safetyCheckerDisabled: settings.safetyCheckerDisabled,
    runRegistryImageModel: (model, request, sink) => runRegistryImageModel(http, settings, model, request, sink),
    runReplicatePreprocessor: (request) => runReplicatePreprocessor(http, settings, request),
    probeReplicateModel: (slug) => probeReplicateModel(http, slug),
  };
}
