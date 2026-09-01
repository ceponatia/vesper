/**
 * The prompt-program layer: one world digest in, one positive prompt and one
 * negative field out, with the two channels versioned apart and reconciled by a
 * linter rather than by anyone's memory.
 *
 * Reading order: `conflict-keys` and `concepts` (the two shared vocabularies),
 * `world-digest` (the immutable input), `positive-claims` and
 * `negative-constraints` (the two channels), `collision` (the reconciliation),
 * `dialects` (the per-endpoint seam), `prompt-packs` (the versioned data),
 * `compile-program` (the pipeline), `provenance` (what a render stores).
 * `scene-facts` sits beside `world-digest`: it is what a scene fact's untyped
 * value is allowed to be, narrowed once so no dialect has to guess.
 *
 * The two `dialect-*` / `packs-*` modules are imported for their SIDE EFFECT —
 * each registers itself — so importing this barrel is what makes an endpoint
 * available. That is deliberate: registration at import time is what keeps the
 * registry closed to callers while staying one file per endpoint.
 */

export * from "./camera-bands";
export * from "./collision";
export * from "./compile-program";
export * from "./concepts";
export * from "./conflict-keys";
export * from "./dialect-prose-family";
export * from "./dialect-qwen-2511";
export * from "./dialect-qwen-2512";
export * from "./dialect-tag-family";
export * from "./dialects";
export * from "./negative-constraints";
export * from "./packs-qwen-2512";
export * from "./positive-claims";
export * from "./prompt-packs";
export * from "./provenance";
export * from "./scene-facts";
export * from "./scene-staging-surfaces";
export * from "./world-digest";
