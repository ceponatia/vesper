import { z } from "zod";

/**
 * The diagnostic contract — one definition for the whole repository.
 *
 * A diagnostic is how any layer reports that it degraded instead of failing:
 * the code that names what happened, the message a human reads, and where it
 * happened. Everything that produces one (the application's turn pipeline, the
 * image engine's planner, a provider transport) and everything that consumes one
 * (a collector persisted onto `turns.diagnostics`, a test asserting a fallback)
 * agrees on this shape. See docs/resilience.md.
 *
 * It lives in the shared foundation because it is not a game concept and not an
 * image concept — it is the vocabulary workspaces report through, and a second
 * declaration of it is a boundary the type system can only check by accident.
 */

export const diagnosticSeveritySchema = z.enum(["info", "warn", "error"]);
export type DiagnosticSeverity = z.infer<typeof diagnosticSeveritySchema>;

export const diagnosticSchema = z.object({
  severity: diagnosticSeveritySchema,
  code: z.string().min(1),
  message: z.string(),
  path: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type Diagnostic = z.infer<typeof diagnosticSchema>;

export interface DiagnosticSink {
  push(diagnostic: Diagnostic): void;
}

/** Collects diagnostics for persistence (e.g. onto turns.diagnostics). */
export class DiagnosticCollector implements DiagnosticSink {
  readonly items: Diagnostic[] = [];

  push(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

/**
 * Fan every diagnostic into several sinks at once, in the given order.
 *
 * The shape a pipeline uses to keep its own collector (it still needs `.items`
 * to log or persist the run's codes) while letting a caller observe the same
 * stream live — `input.sink ? teeSink(input.sink, collected) : collected`.
 */
export function teeSink(...sinks: readonly DiagnosticSink[]): DiagnosticSink {
  return {
    push(diagnostic) {
      for (const sink of sinks) sink.push(diagnostic);
    },
  };
}

export function diag(
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  extra?: { path?: string; context?: Record<string, unknown> },
): Diagnostic {
  return { severity, code, message, ...extra };
}
