import { describe, expect, it } from "vitest";
import { chatReplyFailureCauses, chatReplyFailureCodes, type ChatReplyFailure } from "@/contracts";
import { replyFailureToast } from "./reply-failure";

const FABLE = "DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP";

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

  // The narrator list is multi-provider now, so a credential error may not be
  // OpenRouter's. Naming the wrong vendor sends the owner to check the wrong secret.
  describe("credential errors name the provider only when the record identifies one", () => {
    it("names OpenRouter for an OpenRouter narrator", () => {
      expect(replyFailureToast("Wren", failure({ code: "no_credits", model: "z-ai/glm-5.2" }), NOW).description).toContain(
        "OpenRouter is out of credits",
      );
      expect(
        replyFailureToast("Wren", failure({ code: "auth_failed", model: "aion-labs/aion-3.0" }), NOW).description,
      ).toContain("OpenRouter rejected");
    });

    it("names Featherless for a Featherless narrator", () => {
      expect(replyFailureToast("Wren", failure({ code: "no_credits", model: FABLE }), NOW).description).toContain(
        "Featherless is out of credits",
      );
      expect(replyFailureToast("Wren", failure({ code: "auth_failed", model: FABLE }), NOW).description).toContain(
        "Featherless rejected",
      );
    });

    // An unlisted id must NOT be read as OpenRouter just because that is the routing
    // default — a credential message naming the wrong vendor is worse than a neutral one.
    it("stays neutral when the record names no model, or one not on the narrator list", () => {
      for (const model of ["", "   ", "some-retired/slug"]) {
        const { description } = replyFailureToast("Wren", failure({ code: "auth_failed", model }), NOW);
        expect(description).toContain("The model provider rejected");
        expect(description).not.toContain("OpenRouter");
      }
    });

    it("no longer points at the OPENROUTER_API_KEY secret by name", () => {
      for (const model of ["z-ai/glm-5.2", FABLE, ""]) {
        expect(replyFailureToast("Wren", failure({ code: "auth_failed", model }), NOW).description).not.toContain(
          "OPENROUTER_API_KEY",
        );
      }
    });
  });

  // The falsehood this change removes: "finished without saying anything" was shown for
  // every zero-text reply, including ones where the server knew the model had generated.
  describe("an explained empty reply", () => {
    it("has distinct, non-empty copy for every cause", () => {
      const seen = new Set(
        chatReplyFailureCauses.map((cause) => {
          const { description } = replyFailureToast("Wren", failure({ code: "empty_reply", cause }), NOW);
          expect(description.length).toBeGreaterThan(20);
          return description;
        }),
      );
      expect(seen.size).toBe(chatReplyFailureCauses.length);
    });

    it("stops claiming the model said nothing when it burned its budget reasoning", () => {
      const { description } = replyFailureToast(
        "Wren",
        failure({ code: "empty_reply", cause: "reasoning_or_length" }),
        NOW,
      );
      expect(description).toContain("internal reasoning");
      expect(description).not.toContain("without saying anything");
    });

    it("says Vesper discarded the reply when the normalizers erased it", () => {
      const { description } = replyFailureToast("Wren", failure({ code: "empty_reply", cause: "normalizer_erased" }), NOW);
      expect(description).toContain("discarded");
      expect(description).not.toContain("without saying anything");
    });

    it("keeps the plain copy for an empty reply with no recorded cause", () => {
      const { description } = replyFailureToast("Wren", failure({ code: "empty_reply" }), NOW);
      expect(description).toContain("without saying anything");
    });
  });
});
