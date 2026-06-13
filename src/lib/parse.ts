import type { ZodType } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";

/**
 * Boundary parser for everything that crosses a trust boundary: JSONB columns,
 * LLM output, request bodies. Accepts a raw value or a JSON string, never
 * throws, records a diagnostic on failure. See docs/resilience.md §1.
 */
export function parseOr<T>(schema: ZodType<T>, raw: unknown, fallback: T, sink?: DiagnosticSink, path?: string): T {
  const value = parseOrNull(schema, raw, sink, path);
  return value === null ? fallback : value;
}

export function parseOrNull<T>(schema: ZodType<T>, raw: unknown, sink?: DiagnosticSink, path?: string): T | null {
  let candidate = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        candidate = JSON.parse(trimmed);
      } catch {
        // fall through; the schema may legitimately want a string
      }
    }
  }
  const result = schema.safeParse(candidate);
  if (result.success) return result.data;
  sink?.push(
    diag("warn", "parse.boundary_failed", summarizeIssues(result.error.issues), {
      path,
      context: { issueCount: result.error.issues.length },
    }),
  );
  return null;
}

function summarizeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
