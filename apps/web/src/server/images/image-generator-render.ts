import type { ImageRenderIntent } from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { renderImageIntent, type RenderImageIntentResult } from "./render-intent";

/**
 * The Image Generator's injectable render seam — the `ImageLabRenderer` shape
 * with only the intent arm, because the Generator has no probe: every run
 * reaches the provider through `renderImageIntent`, with the version pin
 * travelling INSIDE the intent (`intent.versionId`), so the seam needs no
 * Generator-specific parameters and a stub captures exactly what production
 * would send.
 *
 * Its own seam rather than the Lab's on purpose (spec §Ownership rules): the
 * Generator must not import `image-lab-render.ts`, and an integration suite
 * stubbing one bench must not silently stub the other.
 */
export interface GeneratorRenderRequest {
  mode: "intent";
  intent: ImageRenderIntent;
}

export type GeneratorRenderer = (
  request: GeneratorRenderRequest,
  sink?: DiagnosticSink,
) => Promise<RenderImageIntentResult>;

/**
 * Test-only override; `null` restores the real render. Process-local, the
 * `setImageLabRendererForTesting` shape, for the same reason: the integration
 * suite must drive every outcome without a provider call.
 */
let injectedRenderer: GeneratorRenderer | null = null;

export function setImageGeneratorRendererForTesting(renderer: GeneratorRenderer | null): void {
  injectedRenderer = renderer;
}

/**
 * The renderer this run goes through. The real arm is a bare delegation to
 * `renderImageIntent` — the moment this seam starts deciding anything, what a
 * test captures stops being evidence of what the provider was sent.
 */
export function generatorRenderer(): GeneratorRenderer {
  return injectedRenderer ?? ((request, sink) => renderImageIntent(request.intent, sink));
}
