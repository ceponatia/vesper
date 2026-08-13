import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DiagnosticCollector } from "./diagnostics";
import { parseOr, parseOrNull } from "./parse";

/**
 * The application's `expectDiagnostics`/`expectCleanSink` helpers live in
 * `src/test/`, which this package may not reach into. The assertion they make
 * is one line of `.map`, so the vocabulary is restated here rather than the
 * boundary being bent for it.
 */
const codes = (sink: DiagnosticCollector): string[] => sink.items.map((item) => item.code);

const shape = z.object({ name: z.string(), count: z.number().default(0) });
const fallback = { name: "fallback", count: -1 };

describe("parseOr", () => {
  it("parses an already-decoded object", () => {
    expect(parseOr(shape, { name: "mara", count: 2 }, fallback)).toEqual({ name: "mara", count: 2 });
  });

  it("parses a JSON-string input (JSONB-as-text boundary)", () => {
    expect(parseOr(shape, '{"name":"mara","count":3}', fallback)).toEqual({ name: "mara", count: 3 });
    expect(parseOr(z.array(z.number()), "[1,2,3]", [])).toEqual([1, 2, 3]);
  });

  it("returns the fallback and records a warn diagnostic on garbage", () => {
    const sink = new DiagnosticCollector();
    const result = parseOr(shape, "{definitely not json", fallback, sink, "turns.state");
    expect(result).toEqual(fallback);
    expect(sink.items).toHaveLength(1);
    const d = sink.items[0];
    expect(d?.severity).toBe("warn");
    expect(d?.code).toBe("parse.boundary_failed");
    expect(d?.path).toBe("turns.state");
  });

  it("returns the fallback on schema mismatch, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(parseOr(shape, { name: 42 }, fallback, sink)).toEqual(fallback);
    expect(codes(sink)).toEqual(["parse.boundary_failed"]);
  });

  it("does not record diagnostics on success", () => {
    const sink = new DiagnosticCollector();
    parseOr(shape, '{"name":"ok"}', fallback, sink);
    expect(codes(sink)).toEqual([]);
  });

  it("lets a brace-shaped string through to a string schema when JSON.parse fails", () => {
    expect(parseOr(z.string(), "{not json, just prose}", "x")).toBe("{not json, just prose}");
  });

  it("never throws on hostile input", () => {
    const sink = new DiagnosticCollector();
    expect(parseOr(shape, undefined, fallback, sink)).toEqual(fallback);
    expect(parseOr(shape, null, fallback, sink)).toEqual(fallback);
    expect(parseOr(shape, Symbol("boom"), fallback, sink)).toEqual(fallback);
    // One record per hostile input — exact, where `.every` also passed on an
    // empty sink.
    expect(codes(sink)).toEqual(["parse.boundary_failed", "parse.boundary_failed", "parse.boundary_failed"]);
  });

  it("summarizes the first few issues rather than persisting the whole zod error", () => {
    const sink = new DiagnosticCollector();
    const wide = z.object({ alpha: z.string(), bravo: z.string(), charlie: z.string(), delta: z.string() });
    const empty = { alpha: "", bravo: "", charlie: "", delta: "" };
    parseOr(wide, {}, empty, sink, "api.body");
    const recorded = sink.items[0];
    expect(recorded?.message).toContain("alpha:");
    expect(recorded?.message).toContain("charlie:");
    // Truncated, with the real count kept in context — a persisted diagnostic
    // stays a summary however wide the failing row is.
    expect(recorded?.message).not.toContain("delta:");
    expect(recorded?.context).toEqual({ issueCount: 4 });
  });
});

describe("parseOrNull", () => {
  it("returns the parsed value on success", () => {
    expect(parseOrNull(shape, { name: "mara" })).toEqual({ name: "mara", count: 0 });
  });

  it("returns null and records a diagnostic on failure", () => {
    const sink = new DiagnosticCollector();
    expect(parseOrNull(shape, "garbage", sink, "api.body")).toBeNull();
    expect(sink.items[0]?.code).toBe("parse.boundary_failed");
    expect(sink.items[0]?.path).toBe("api.body");
  });
});
