import { describe, expect, it } from "vitest";
import { chatReplyFailureCodes, type ChatReplyFailure } from "@/contracts";
import { replyFailureToast } from "./reply-failure";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

const failure = (over: Partial<ChatReplyFailure>): ChatReplyFailure => ({
  code: "unknown",
  detail: "",
  model: "test-model",
  at: new Date(NOW - 5_000).toISOString(),
  ...over,
});

describe("replyFailureToast", () => {
  it("has distinct, non-empty copy for every failure class", () => {
    const seen = new Set(
      chatReplyFailureCodes.map((code) => {
        const { title, description } = replyFailureToast("Wren", failure({ code }), NOW);
        expect(title).toBe("Wren didn't reply");
        expect(description.length).toBeGreaterThan(20);
        return description;
      }),
    );
    expect(seen.size).toBe(chatReplyFailureCodes.length);
  });

  it("quotes the provider's words where they add signal, truncated", () => {
    const long = "x".repeat(400);
    const { description } = replyFailureToast("Wren", failure({ code: "moderation_blocked", detail: long }), NOW);
    expect(description).toContain("Provider said:");
    expect(description.length).toBeLessThan(400);
    // …but not on classes whose copy already says everything (a timeout has no provider words).
    const timeout = replyFailureToast("Wren", failure({ code: "timeout", detail: "no output within 50s" }), NOW);
    expect(timeout.description).not.toContain("Provider said:");
  });

  it("falls back to honest no-cause copy when the record is missing or stale", () => {
    const missing = replyFailureToast("Wren", null, NOW);
    expect(missing.description).toContain("recorded no cause");
    const stale = replyFailureToast("Wren", failure({ code: "no_credits", at: new Date(NOW - 3_600_000).toISOString() }), NOW);
    expect(stale.description).toBe(missing.description);
  });

  it("trusts a degraded record with no timestamp — it was just fetched", () => {
    const { description } = replyFailureToast("Wren", failure({ code: "rate_limited", at: "" }), NOW);
    expect(description).toContain("rate-limiting");
  });
});
