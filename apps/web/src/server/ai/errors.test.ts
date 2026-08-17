import { RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { apiError } from "@/server/test-support";
import { classifyProviderError, describeProviderError } from "./errors";

describe("describeProviderError", () => {
  it("surfaces an upstream moderation reason hidden behind 'Invalid JSON response'", () => {
    const body = JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: JSON.stringify({ status: "Request Moderated", details: { "Moderation Reasons": ["Sexual Content"] } }) },
      },
    });
    // BFL Flux moderation surfaced through OpenRouter — the real reason, not "Invalid JSON response".
    expect(describeProviderError(apiError(body))).toBe("Provider returned error: Sexual Content");
  });

  it("surfaces the provider message even without moderation metadata (the 200-after-stream case)", () => {
    const body = JSON.stringify({ error: { message: "Provider returned error", code: 400 } });
    expect(describeProviderError(apiError(body))).toBe("Provider returned error");
  });

  it("falls back to the API error message when the body carries no provider error", () => {
    expect(describeProviderError(apiError("not json at all"))).toBe("Invalid JSON response");
  });

  it("passes plain errors through untouched", () => {
    expect(describeProviderError(new Error("boom"))).toBe("boom");
    expect(describeProviderError("weird")).toBe("weird");
  });

  // Observed live 2026-08-17: a Featherless cold start answers HTTP 200 and puts the
  // error in an SSE frame, so the transport hands on a plain JSON object. Read as an
  // Error it stringifies to "[object Object]".
  it("reads a provider error object reported in-stream rather than thrown", () => {
    expect(
      describeProviderError({ message: "model is temporarily at capacity. Please try again shortly.", code: "capacity_exhausted" }),
    ).toBe("model is temporarily at capacity. Please try again shortly. (capacity_exhausted)");
    // Nested one level, the way some upstreams wrap it.
    expect(describeProviderError({ error: { message: "upstream exploded" } })).toBe("upstream exploded");
  });

  it("still stringifies an object that is not a provider envelope", () => {
    expect(describeProviderError({ chatId: "abc" })).toBe("[object Object]");
  });
});

describe("classifyProviderError", () => {
  it("maps provider status codes to their failure classes", () => {
    expect(classifyProviderError(apiError("", "Payment required", 402)).code).toBe("no_credits");
    expect(classifyProviderError(apiError("", "Invalid API key", 401)).code).toBe("auth_failed");
    expect(classifyProviderError(apiError("", "Forbidden", 403)).code).toBe("auth_failed");
    expect(classifyProviderError(apiError("", "Request timed out", 408)).code).toBe("timeout");
    expect(classifyProviderError(apiError("", "Too many requests", 429)).code).toBe("rate_limited");
    expect(classifyProviderError(apiError("", "Internal server error", 502)).code).toBe("provider_error");
  });

  it("classifies a moderation block before the auth fallback (OpenRouter flags inputs as 403)", () => {
    const body = JSON.stringify({ error: { message: "Your input was flagged", code: 403 } });
    const result = classifyProviderError(apiError(body, "Forbidden", 403));
    expect(result.code).toBe("moderation_blocked");
    expect(result.detail).toBe("Your input was flagged");
  });

  it("classifies a context-window overflow reported under a generic 400", () => {
    const body = JSON.stringify({
      error: { message: "This model's maximum context length is 32768 tokens", code: 400 },
    });
    expect(classifyProviderError(apiError(body, "Bad request", 400)).code).toBe("context_too_long");
  });

  it("keeps the provider's words and status as detail", () => {
    const body = JSON.stringify({ error: { message: "Rate limit exceeded: free tier", code: 429 } });
    const result = classifyProviderError(apiError(body, "Too Many Requests", 429));
    expect(result).toEqual({ code: "rate_limited", detail: "Rate limit exceeded: free tier", status: 429 });
  });

  it("unwraps the AI SDK RetryError to the last real attempt", () => {
    const inner = apiError("", "Too many requests", 429);
    const retry = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner, inner],
    });
    expect(classifyProviderError(retry).code).toBe("rate_limited");
  });

  it("classifies transport-level failures as network", () => {
    const fetchFail = new TypeError("fetch failed");
    expect(classifyProviderError(fetchFail).code).toBe("network");
    const reset = new Error("read ECONNRESET");
    expect(classifyProviderError(reset).code).toBe("network");
  });

  // The in-stream envelope (a Featherless cold start). There is no HTTP status to read,
  // so the vendor's words are the whole signal — but it IS an upstream failure, and
  // `unknown` would send the player "no cause recorded" for a failure the provider named.
  it("classifies an in-stream provider error envelope as a provider failure", () => {
    const cold = classifyProviderError({
      message: "model is temporarily at capacity. Please try again shortly.",
      code: "capacity_exhausted",
    });
    expect(cold.code).toBe("provider_error");
    expect(cold.detail).toContain("temporarily at capacity");
    expect(cold.status).toBeUndefined();
  });

  it("still reads moderation and context overflow out of an in-stream envelope", () => {
    expect(classifyProviderError({ message: "flagged by the content policy" }).code).toBe("moderation_blocked");
    expect(classifyProviderError({ message: "maximum context length exceeded" }).code).toBe("context_too_long");
  });

  it("falls back to unknown for anything else", () => {
    expect(classifyProviderError(new Error("boom")).code).toBe("unknown");
    expect(classifyProviderError("weird").code).toBe("unknown");
    // An object that is not a provider envelope must not be dressed up as one.
    expect(classifyProviderError({ chatId: "abc" }).code).toBe("unknown");
  });
});
