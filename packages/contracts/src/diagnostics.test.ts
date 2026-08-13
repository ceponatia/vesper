import { describe, expect, it } from "vitest";
import {
  DiagnosticCollector,
  diag,
  diagnosticSchema,
  diagnosticSeveritySchema,
  teeSink,
  type DiagnosticSink,
} from "./diagnostics";

describe("diag", () => {
  it("builds the minimal diagnostic without inventing optional fields", () => {
    const built = diag("warn", "parse.boundary_failed", "name: expected string");
    expect(built).toEqual({ severity: "warn", code: "parse.boundary_failed", message: "name: expected string" });
    // Not `path: undefined` — the value is persisted as jsonb, and an explicit
    // undefined key is a different stored shape from an absent one.
    expect(Object.keys(built)).toEqual(["severity", "code", "message"]);
  });

  it("carries the path and context when a caller supplies them", () => {
    expect(diag("error", "turn.failed", "boom", { path: "turns.state", context: { attempt: 2 } })).toEqual({
      severity: "error",
      code: "turn.failed",
      message: "boom",
      path: "turns.state",
      context: { attempt: 2 },
    });
  });
});

describe("DiagnosticCollector", () => {
  it("records pushes in order", () => {
    const collector = new DiagnosticCollector();
    collector.push(diag("info", "a", "first"));
    collector.push(diag("warn", "b", "second"));
    expect(collector.items.map((item) => item.code)).toEqual(["a", "b"]);
  });

  it("reports errors only when one was recorded", () => {
    const collector = new DiagnosticCollector();
    expect(collector.hasErrors).toBe(false);
    collector.push(diag("warn", "degraded", "fell back"));
    expect(collector.hasErrors).toBe(false);
    collector.push(diag("error", "failed", "gave up"));
    expect(collector.hasErrors).toBe(true);
  });
});

describe("teeSink", () => {
  it("fans each diagnostic into every sink, in the order given", () => {
    const order: string[] = [];
    const named = (name: string): DiagnosticSink => ({
      push: () => {
        order.push(name);
      },
    });
    const pipeline = new DiagnosticCollector();

    teeSink(named("first"), pipeline, named("last")).push(diag("warn", "parse.boundary_failed", "bad row"));

    expect(order).toEqual(["first", "last"]);
    expect(pipeline.items.map((item) => item.code)).toEqual(["parse.boundary_failed"]);
  });

  it("is a no-op sink when handed no sinks at all", () => {
    expect(() => {
      teeSink().push(diag("info", "nobody.listening", "ok"));
    }).not.toThrow();
  });
});

describe("diagnosticSchema", () => {
  it("accepts a built diagnostic, so what is produced is what is persisted", () => {
    expect(diagnosticSchema.safeParse(diag("warn", "a.b", "m", { path: "p" })).success).toBe(true);
  });

  it("rejects an unknown severity and an empty code", () => {
    expect(diagnosticSeveritySchema.safeParse("fatal").success).toBe(false);
    expect(diagnosticSchema.safeParse({ severity: "warn", code: "", message: "m" }).success).toBe(false);
  });
});
