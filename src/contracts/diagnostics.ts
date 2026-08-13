/**
 * The application's entry point for the diagnostic contract.
 *
 * The implementation lives in `@vesper/contracts` — one definition for the whole
 * repository, so a package can report degradation without a structural copy of
 * this shape (docs/developer-notes/monorepo-image-core.spec.foundation.md).
 * This file stays because it is a genuine application-facing API that several
 * hundred modules already import; it is a re-export barrel and holds no
 * implementation. How the app uses diagnostics: docs/resilience.md §2.
 */

export { DiagnosticCollector, diag, diagnosticSchema, diagnosticSeveritySchema, teeSink } from "@vesper/contracts";
export type { Diagnostic, DiagnosticSeverity, DiagnosticSink } from "@vesper/contracts";
