/**
 * `@vesper/image-models` — how model families DIFFER.
 *
 * Everything exported here answers one question: what does Vesper have to do
 * differently because this render is going to that family of models? A prompt
 * dialect, a reference convention, an endpoint that queues for minutes before
 * it starts, an endpoint whose negative field is decorative. Without this
 * package that knowledge has nowhere to live, and it leaks back into shared
 * code as slug checks — which is what it was doing before.
 *
 * **It never replaces the probed capability registry.** The registry row stays
 * the authority on provider wire fields: which key carries the prompt, whether
 * the reference input is one URI or a list, which optional controls this
 * version exposes. Adapters own BEHAVIOR; the probe owns FIELD TRUTH, and a
 * feature that named a provider field would be a second, staler copy of a row
 * an operator edits. The two meet in the application, which resolves a model,
 * asks this package for its adapter, and hands both to the render kernel.
 *
 * `@vesper/image-core` is below this package and may not import it — model
 * behavior reaches the kernel through an injected hook, never an upward import.
 * `@vesper/image-replicate` and `@vesper/image-sd` are PEERS at the same rank
 * and are never imported from here: this package says what a family needs, the
 * transport executes it, the SD layer defines recipes, and the application is
 * where they meet.
 *
 * **This list is the package's entire public API, and it is deliberately
 * explicit.** Internal folder barrels may still use `export *` — they are
 * reading aids, not publication. The root may not: a wildcard here would make
 * every helper added to an internal barrel public without appearing in any
 * diff, and `pnpm lint:package-boundaries` fails the build if one appears.
 * Adding an entry below is a public-API change, and reviewers should read it as
 * one.
 */

export { defineImageModel } from "./composer";
export type {
  ImageModelAdapter,
  ImageModelDefinition,
  ImageModelExecutionHints,
  ImageModelQuirk,
  ImagePromptPreparer,
  ImageRequestValidator,
} from "./composer";
export {
  aspectRatioFeature,
  guidanceFeature,
  loraFeature,
  multiReferenceFeature,
  negativePromptFeature,
  outputFormatFeature,
  outputQualityFeature,
  promptFeature,
  safetyToggleFeature,
  seedFeature,
} from "./features";
export type { ImageFeature, ImageModelRequestFacts } from "./features";
export {
  QWEN_IMAGE_FAMILY,
  qwenEditFeatures,
  qwenImage2512,
  qwenImageEdit2511,
} from "./families";
export { adapterForImageModel } from "./registry";
export { FAL_QWEN3_EDIT_SLUG, FAL_QWEN3_TEXT_SLUG, imageModelProvider } from "./provider";
export type { ImageModelProvider } from "./provider";
