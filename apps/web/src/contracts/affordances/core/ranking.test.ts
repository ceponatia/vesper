import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { parseOr } from "@/lib/parse";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import {
  affordanceCueStateSchema,
  emptyAffordanceCueState,
  selectAffordanceCues,
  AFFORDANCE_CUES_PER_EXCHANGE,
  type AffordanceCueState,
} from "./ranking";
import type { AffordanceIntensityBand, AffordanceObservation } from "./types";

/**
 * Ranking is the anti-repetition gate, not a truth filter: everything here is
 * still true, the question is only what earns the exchange's one or two slots.
 */

const candidate = (repeatKey: string, band: AffordanceIntensityBand, id = "probe.read"): AffordanceObservation => ({
  kind: "observation",
  id,
  sourceLocationId: "eyes",
  intensityBand: band,
  semanticTags: [],
  repeatKey,
});

const keysOf = (cues: readonly AffordanceObservation[]): string[] => cues.map((cue) => cue.repeatKey);

describe("the repeat gate", () => {
  it("first sight of a key emits; the same key in the same band then stays silent", () => {
    const first = selectAffordanceCues({ candidates: [candidate("a", "clear")] });
    expect(keysOf(first.cues)).toEqual(["a"]);
    expect(first.nextCues.bands).toEqual({ a: "clear" });

    const second = selectAffordanceCues({ candidates: [candidate("a", "clear")], previous: first.nextCues });
    expect(second.cues).toEqual([]);
    expect(second.nextCues.bands).toEqual({ a: "clear" });
  });

  it("a band change re-emits the same key", () => {
    const first = selectAffordanceCues({ candidates: [candidate("a", "subtle")] });
    const second = selectAffordanceCues({ candidates: [candidate("a", "strong")], previous: first.nextCues });
    expect(keysOf(second.cues)).toEqual(["a"]);
    expect(second.nextCues.bands).toEqual({ a: "strong" });
  });

  it("stamps changedAt only when the band moved", () => {
    const first = selectAffordanceCues({ candidates: [candidate("a", "subtle")], atStoryTime: 10 });
    expect(first.nextCues.changedAt).toEqual({ a: 10 });

    const held = selectAffordanceCues({ candidates: [candidate("a", "subtle")], previous: first.nextCues, atStoryTime: 25 });
    expect(held.nextCues.changedAt).toEqual({ a: 10 });

    const moved = selectAffordanceCues({ candidates: [candidate("a", "clear")], previous: held.nextCues, atStoryTime: 40 });
    expect(moved.nextCues.changedAt).toEqual({ a: 40 });
  });
});

describe("rank and cap", () => {
  it("caps at two, strongest band first", () => {
    const selection = selectAffordanceCues({
      candidates: [candidate("a", "subtle"), candidate("b", "strong"), candidate("c", "clear")],
    });
    expect(AFFORDANCE_CUES_PER_EXCHANGE).toBe(2);
    expect(keysOf(selection.cues)).toEqual(["b", "c"]);
  });

  it("ties keep the domains' registration order", () => {
    const selection = selectAffordanceCues({
      candidates: [candidate("a", "clear"), candidate("b", "clear"), candidate("c", "clear")],
    });
    expect(keysOf(selection.cues)).toEqual(["a", "b"]);
  });

  it("the cap applies AFTER gating — unchanged reads never crowd out a change", () => {
    const previous: AffordanceCueState = { bands: { a: "strong", b: "strong" }, cues: ["a", "b"], changedAt: {} };
    const selection = selectAffordanceCues({
      candidates: [candidate("a", "strong"), candidate("b", "strong"), candidate("c", "subtle")],
      previous,
    });
    expect(keysOf(selection.cues)).toEqual(["c"]);
  });

  it("a cap of zero yields silence but still records the memory", () => {
    const selection = selectAffordanceCues({ candidates: [candidate("a", "strong")], cap: 0 });
    expect(selection.cues).toEqual([]);
    expect(selection.nextCues.bands).toEqual({ a: "strong" });
  });

  it("one read per key: the strongest band wins the key", () => {
    const selection = selectAffordanceCues({
      candidates: [candidate("a", "subtle"), candidate("a", "strong")],
    });
    expect(selection.cues).toHaveLength(1);
    expect(selection.cues[0]?.intensityBand).toBe("strong");
    expect(selection.nextCues.bands).toEqual({ a: "strong" });
  });
});

describe("the memory", () => {
  it("records every candidate's current band, emitted or not", () => {
    // Lossless: `c` and `d` lost the cap, but their bands are still what the
    // narrator's world looks like now — so next exchange they are not "new".
    const selection = selectAffordanceCues({
      candidates: [candidate("a", "strong"), candidate("b", "strong"), candidate("c", "clear"), candidate("d", "subtle")],
    });
    expect(keysOf(selection.cues)).toEqual(["a", "b"]);
    expect(selection.nextCues.bands).toEqual({ a: "strong", b: "strong", c: "clear", d: "subtle" });

    const next = selectAffordanceCues({
      candidates: [candidate("c", "clear"), candidate("d", "subtle")],
      previous: selection.nextCues,
    });
    expect(next.cues).toEqual([]);
  });

  it("keys that left the cut stop being written — the memory stays bounded", () => {
    const first = selectAffordanceCues({ candidates: [candidate("a", "clear"), candidate("b", "clear")] });
    const second = selectAffordanceCues({ candidates: [candidate("a", "clear")], previous: first.nextCues });
    expect(Object.keys(second.nextCues.bands)).toEqual(["a"]);
  });

  it("tracks recently emitted keys, most recent first", () => {
    const first = selectAffordanceCues({ candidates: [candidate("a", "clear")] });
    expect(first.nextCues.cues).toEqual(["a"]);
    const second = selectAffordanceCues({ candidates: [candidate("b", "clear")], previous: first.nextCues });
    expect(second.nextCues.cues).toEqual(["b", "a"]);
  });
});

describe("the JSONB boundary", () => {
  it("round-trips a real state", () => {
    const state: AffordanceCueState = { bands: { a: "clear" }, cues: ["a"], changedAt: { a: 12 } };
    const sink = new DiagnosticCollector();
    expect(parseOr(affordanceCueStateSchema, JSON.stringify(state), emptyAffordanceCueState(), sink, "cues")).toEqual(state);
    expectCleanSink(sink);
  });

  it("field-level rot degrades to empty records via .catch, keeping the rest of the row", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseOr(
      affordanceCueStateSchema,
      { bands: "nonsense", cues: 7, changedAt: { a: "later" } },
      emptyAffordanceCueState(),
      sink,
      "cues",
    );
    expect(parsed.bands).toEqual({});
    expect(parsed.cues).toEqual([]);
    // A leaf `.catch` keeps the key at the epoch rather than dropping it —
    // `changedAt` is provenance, and a lost stamp is cheaper than a lost row.
    expect(parsed.changedAt).toEqual({ a: 0 });
    // Field `.catch` is silent by design (the garment cue-state precedent): the
    // row still parses, so nothing DEGRADED at the boundary itself.
    expectCleanSink(sink);
  });

  it("an unparseable value falls back to the empty state AND records the boundary diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(parseOr(affordanceCueStateSchema, "not-json-at-all", emptyAffordanceCueState(), sink, "cues")).toEqual(
      emptyAffordanceCueState(),
    );
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("an unknown band degrades to the least-salient reading rather than rejecting the row", () => {
    const parsed = parseOr(
      affordanceCueStateSchema,
      { bands: { a: "catastrophic" } },
      emptyAffordanceCueState(),
      undefined,
      "cues",
    );
    expect(parsed.bands).toEqual({ a: "subtle" });
  });
});
