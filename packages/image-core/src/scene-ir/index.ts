/**
 * `scene-ir` — the compiler-input vocabulary for a chat scene.
 *
 * The intermediate representation the application lowers game state into and the dialects
 * read: the closed scene vocabularies, what a staging arrangement means in facts, the carrier
 * for the registry's measured wording, and what a render records about it. Three layers, and
 * this is the middle one — the application owns the registries, the planning, the evidence
 * gates and the measured sentences; `image-core` proper owns compilation, dialect
 * interpretation and the coarsened vocabularies a provider guard reasons over.
 *
 * **This directory is a package boundary drawn inside a package.** It may depend on
 * `@vesper/contracts` and Zod, and on nothing else — never `../prompt-program`, never a
 * dialect, never `../render-intent`, never any other compiler internal. That is what keeps a
 * later extraction a file move plus an import rewrite, and it stops being true the moment a
 * scene type reaches for a dialect id, a provider config or compiler state. The dependency
 * runs one way: the compiler reads this vocabulary, and this vocabulary knows nothing about
 * the compiler.
 *
 * The public names reach consumers through the package's single `.` entry, listed explicitly
 * in the root barrel; `@vesper/image-core/scene-ir` is not an import path.
 */

export * from "./scene-staging";
export * from "./scene-staging-provenance";
export * from "./scene-vocabulary";
