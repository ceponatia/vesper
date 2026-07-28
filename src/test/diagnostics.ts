import { expect } from "vitest";
import type { Diagnostic } from "@/contracts/diagnostics";

/**
 * One vocabulary for asserting on a diagnostic sink.
 *
 * Degradation tests must assert the fallback AND its diagnostic code
 * (docs/resilience.md), and five competing idioms had grown for the second half
 * — `toEqual` over mapped codes, `toContain`, `.some(...)`, a
 * `.filter(...).toHaveLength(n)` count, and an "empty sink" check. These four
 * cover all five and put the code in the failure message.
 */

/** Structural: `DiagnosticCollector` and any array-backed stand-in both satisfy it. */
export interface CollectedDiagnostics {
  readonly items: readonly Diagnostic[];
}

/** The recorded codes, in the order they were pushed. */
export function codes(sink: CollectedDiagnostics): string[] {
  return sink.items.map((item) => item.code);
}

/** The sink recorded exactly these codes, in this order — nothing more, nothing less. */
export function expectDiagnostics(sink: CollectedDiagnostics, expected: readonly string[]): void {
  expect(codes(sink)).toEqual([...expected]);
}

/**
 * The sink recorded `code` — at least once, or exactly `times` when the count
 * itself is the claim (one drop per malformed row, not one per list).
 */
export function expectDiagnostic(sink: CollectedDiagnostics, code: string, options: { times?: number } = {}): void {
  const recorded = codes(sink);
  if (options.times === undefined) {
    expect(recorded, `expected a ${code} diagnostic, got [${recorded.join(", ")}]`).toContain(code);
    return;
  }
  const matches = recorded.filter((item) => item === code);
  expect(matches, `expected ${options.times} x ${code}, got [${recorded.join(", ")}]`).toHaveLength(options.times);
}

/** The happy path recorded nothing at all. */
export function expectCleanSink(sink: CollectedDiagnostics): void {
  expect(codes(sink)).toEqual([]);
}
