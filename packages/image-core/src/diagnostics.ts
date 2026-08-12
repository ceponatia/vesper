/**
 * The diagnostic shapes image-core needs to REPORT degradation without
 * depending on the application.
 *
 * These are structurally identical to `src/contracts/diagnostics.ts`, which
 * remains the app's canonical owner — it also carries the zod schema, the
 * `DiagnosticCollector`, `teeSink` and `diag`, none of which the package needs.
 * Because a `DiagnosticSink` is a one-method structural interface, the app's
 * collector satisfies the package's sink with no adapter, and
 * `src/contracts/diagnostics.compat.test.ts` fails typecheck if the two shapes
 * ever drift.
 *
 * The duplication is deliberate and temporary: `Diagnostic` is a generic
 * primitive, not an image concept, and it belongs in a shared foundation
 * package. Extracting one now would mean a second package in the same change,
 * so the seam is recorded here and in monorepo-image-core.plan.md §"Open
 * questions" instead. When `@vesper/contracts` is carved out, both definitions
 * collapse into it.
 */

export type DiagnosticSeverity = "info" | "warn" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  context?: Record<string, unknown>;
}

export interface DiagnosticSink {
  push(diagnostic: Diagnostic): void;
}
