import { describe, expect, it } from "vitest";
import type { ExchangeCoverageEntry, ExchangeStageEvent } from "@/contracts/turns/chat-exchange-trace";
import { groupCoverageByStatus, highlightedStageSeqs, shortId } from "./chat-inspector-exchange-trace-format";

/**
 * Coverage for the two non-trivial pieces this panel extracts out of React
 * (vesper-testing: pure deterministic logic stays in a pure suite) — the
 * coverage summary's fixed reading order and the timeline's highlight-seq
 * derivation — plus the short-id truncation boundary.
 */

function coverageEntry(status: ExchangeCoverageEntry["status"], family: string): ExchangeCoverageEntry {
  return { family, status };
}

function stage(seq: number, status: ExchangeStageEvent["status"] = "success"): ExchangeStageEvent {
  return { seq, stage: `stage-${seq}`, phase: "prepare", startedAt: "", durationMs: 0, status };
}

describe("groupCoverageByStatus", () => {
  it("orders missing, degraded, and suppressed before present and empty, regardless of input order", () => {
    const entries: ExchangeCoverageEntry[] = [
      coverageEntry("present", "history"),
      coverageEntry("empty", "summary"),
      coverageEntry("suppressed", "contact"),
      coverageEntry("missing", "memory.facts"),
      coverageEntry("degraded", "scene"),
    ];
    expect(groupCoverageByStatus(entries).map((g) => g.status)).toEqual([
      "missing",
      "degraded",
      "suppressed",
      "present",
      "empty",
    ]);
  });

  it("omits a status with no entries instead of rendering an empty group", () => {
    const entries = [coverageEntry("present", "history")];
    expect(groupCoverageByStatus(entries)).toEqual([{ status: "present", entries }]);
  });

  it("keeps every entry of a status together and drops or duplicates nothing", () => {
    const entries: ExchangeCoverageEntry[] = [
      coverageEntry("missing", "a"),
      coverageEntry("missing", "b"),
      coverageEntry("present", "c"),
    ];
    const groups = groupCoverageByStatus(entries);
    expect(groups.find((g) => g.status === "missing")?.entries).toHaveLength(2);
    expect(groups.flatMap((g) => g.entries)).toHaveLength(entries.length);
  });

  it("returns no groups for an empty trace", () => {
    expect(groupCoverageByStatus([])).toEqual([]);
  });
});

describe("highlightedStageSeqs", () => {
  it("marks a retried stage", () => {
    const seqs = highlightedStageSeqs({ retriedStages: [stage(2, "retried")], fallbackStages: [] });
    expect(seqs.has(2)).toBe(true);
    expect(seqs.size).toBe(1);
  });

  it("marks the stage a fallback links to, and skips a fallback with no linked stage", () => {
    const linked = stage(5);
    const seqs = highlightedStageSeqs({
      retriedStages: [],
      fallbackStages: [{ stage: linked }, { stage: null }],
    });
    expect([...seqs]).toEqual([5]);
  });

  it("dedupes a stage that is both retried and fallback-linked", () => {
    const shared = stage(1, "retried");
    const seqs = highlightedStageSeqs({ retriedStages: [shared], fallbackStages: [{ stage: shared }] });
    expect(seqs.size).toBe(1);
  });

  it("returns an empty set when nothing is highlighted", () => {
    expect(highlightedStageSeqs({ retriedStages: [], fallbackStages: [] }).size).toBe(0);
  });
});

describe("shortId", () => {
  it("renders an em dash for null, undefined, or empty", () => {
    expect(shortId(null)).toBe("—");
    expect(shortId(undefined)).toBe("—");
    expect(shortId("")).toBe("—");
  });

  it("passes a short id through unchanged", () => {
    expect(shortId("short-id")).toBe("short-id");
  });

  it("truncates a long id to 8 characters plus an ellipsis", () => {
    expect(shortId("0123456789abcdef")).toBe("01234567…");
  });
});
