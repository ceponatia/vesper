import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { CHAT_SUMMARY_MAX_CHARS } from "@/contracts/turns/chat-summary";
import { clampSummary, normalizeChatSummary, planChatFold } from "./chat-summary";
import {
  CHARACTER_CHAT_HISTORY_TURNS,
  CHARACTER_CHAT_SUMMARIZE_AT,
  CHARACTER_CHAT_VERBATIM_KEEP,
} from "./constants";

// Pure core of the rolling chat summary. The fold decision, the length clamp, and
// the "did it actually fold" gate are all pure — the DB-bound processChatSummary
// is covered in the int suite.

const TRIGGER = CHARACTER_CHAT_SUMMARIZE_AT * 2;
const KEEP = CHARACTER_CHAT_VERBATIM_KEEP * 2;
const CEIL = CHARACTER_CHAT_HISTORY_TURNS * 2;

describe("planChatFold", () => {
  it("returns null below the fold trigger (the window just stays verbatim)", () => {
    expect(planChatFold(0)).toBeNull();
    expect(planChatFold(TRIGGER - 1)).toBeNull();
  });

  it("at the trigger, folds down to the verbatim-keep floor", () => {
    expect(planChatFold(TRIGGER)).toBe(TRIGGER - KEEP); // 70 → 40
    expect(planChatFold(TRIGGER + 10)).toBe(TRIGGER + 10 - KEEP); // 80 → 50
  });

  it("caps a single fold at the window ceiling so a degraded backlog can't blow one call", () => {
    expect(planChatFold(1000)).toBe(CEIL);
  });
});

describe("clampSummary", () => {
  it("returns short text trimmed, unchanged", () => {
    expect(clampSummary("  a tidy recap.  ")).toBe("a tidy recap.");
  });

  it("clamps overlong text to the cap, preferring a sentence boundary", () => {
    const long = "They talked. ".repeat(400); // ~5200 chars
    const out = clampSummary(long);
    expect(out.length).toBeLessThanOrEqual(CHAT_SUMMARY_MAX_CHARS);
    expect(out.endsWith(".")).toBe(true);
  });

  it("still respects the cap when there is no sentence boundary to cut on", () => {
    const out = clampSummary("x".repeat(CHAT_SUMMARY_MAX_CHARS + 500));
    expect(out.length).toBe(CHAT_SUMMARY_MAX_CHARS);
  });
});

describe("normalizeChatSummary", () => {
  it("keeps the prior summary and does NOT advance when the fold degraded", () => {
    const sink = new DiagnosticCollector();
    const out = normalizeChatSummary("prior recap.", { summary: "anything" }, true, sink);
    expect(out).toEqual({ summary: "prior recap.", advance: false });
    expect(sink.items.map((d) => d.code)).toContain("chat_summary.fold.degraded");
  });

  it("treats a null result as a non-advancing degrade", () => {
    const sink = new DiagnosticCollector();
    const out = normalizeChatSummary("prior.", null, false, sink);
    expect(out.advance).toBe(false);
    expect(out.summary).toBe("prior.");
    expect(sink.items.map((d) => d.code)).toContain("chat_summary.fold.degraded");
  });

  it("does NOT advance on an empty summary (never replace a good recap with nothing)", () => {
    const sink = new DiagnosticCollector();
    const out = normalizeChatSummary("prior.", { summary: "   " }, false, sink);
    expect(out.advance).toBe(false);
    expect(out.summary).toBe("prior.");
    expect(sink.items.map((d) => d.code)).toContain("chat_summary.fold.empty");
  });

  it("advances with the clamped new summary on a real fold", () => {
    const sink = new DiagnosticCollector();
    const out = normalizeChatSummary("prior.", { summary: "  a fresh, integrated recap.  " }, false, sink);
    expect(out).toEqual({ summary: "a fresh, integrated recap.", advance: true });
    expect(sink.items).toHaveLength(0);
  });
});
