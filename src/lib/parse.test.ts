import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseOr, parseOrNull } from "./parse";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectCleanSink, expectDiagnostics } from "@/test/diagnostics";

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
    expectDiagnostics(sink, ["parse.boundary_failed"]);
  });

  it("does not record diagnostics on success", () => {
    const sink = new DiagnosticCollector();
    parseOr(shape, '{"name":"ok"}', fallback, sink);
    expectCleanSink(sink);
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
    expectDiagnostics(sink, ["parse.boundary_failed", "parse.boundary_failed", "parse.boundary_failed"]);
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
