/**
 * `@vesper/image-core` — the provider-neutral image engine.
 *
 * Everything exported here answers a question about IMAGES: what a model can
 * do, which references a render may carry and in what role, how a prompt is
 * compiled for a given profile, what an identity pack is and when it is usable,
 * how a control map is bound to a provider's real input fields, and what a
 * failure message means. Nothing here knows that Vesper has characters, chats,
 * a database, or a Next.js app — see README.md §Boundary.
 *
 * The subfolder barrels are the reading order: start at `capabilities` (what a
 * model declares), then `models` (a registry row and its per-task profiles),
 * then `render-intent` (what one render asks for), then the domains that
 * consume them.
 */

export * from "./diagnostics";
export * from "./capabilities";
export * from "./models";
export * from "./loras";
export * from "./render-intent";
export * from "./references";
export * from "./identity";
export * from "./lab";
export * from "./geometry";
export * from "./provider-interface";
