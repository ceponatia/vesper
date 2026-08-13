/**
 * `@vesper/contracts` — the shared foundation.
 *
 * Two primitive groups, and deliberately nothing else: the diagnostic contract
 * every workspace reports degradation through, and the defensive parser a trust
 * boundary reads untrusted data with. A reader should be able to finish this
 * file and know the complete shared foundation.
 *
 * This is NOT the new home for `src/contracts/` at large — attributes, meters,
 * body locations, species, facts and the rest are Vesper's game vocabulary and
 * stay in the application. The rule of thumb: if a primitive can describe a
 * chat, a character or the simulation, it belongs to the app; if it is generic
 * infrastructure for the boundary between workspaces, it may belong here.
 * Convenience alone is never a reason to move something in
 * (docs/developer-notes/monorepo-image-core.spec.foundation.md).
 *
 * **This list is the package's entire public API, and it is deliberately
 * explicit.** `export *` in a package root barrel would publish helpers without
 * showing them in any diff, and `pnpm lint:package-boundaries` fails the build
 * if one appears.
 */

export { DiagnosticCollector, diag, diagnosticSchema, diagnosticSeveritySchema, teeSink } from "./diagnostics";
export type { Diagnostic, DiagnosticSeverity, DiagnosticSink } from "./diagnostics";
export { parseOr, parseOrNull } from "./parse";
