import type { ImageFeature } from "./image-feature";

/**
 * The model takes a text prompt.
 *
 * Present in nearly every composition and still worth stating, because
 * `capabilities` is read as a complete list of what a family expresses: an
 * adapter that silently omitted the prompt would read as an endpoint that does
 * not take one (a pure upscaler is a real shape).
 *
 * **No `isBound`.** The record's prompt binding says WHERE the prompt goes and
 * HOW LONG it may be, and it is empty on rows probed before that derivation
 * existed. Reading that emptiness as "this model has no prompt" would refuse
 * every unprobed model's renders on the strength of a missing measurement.
 * Prompt fitting against a declared limit is `fitPromptToModel`'s job in
 * `@vesper/image-core`, not a family adapter's.
 */
export function promptFeature(): ImageFeature {
  return {
    id: "prompt",
    semantic: "Takes an authored text prompt describing (or instructing) the image.",
  };
}
