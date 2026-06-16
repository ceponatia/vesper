import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { describeImageGenError } from "./errors";

function apiError(responseBody: string, message = "Invalid JSON response"): APICallError {
  return new APICallError({
    message,
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 200,
    responseBody,
  });
}

describe("describeImageGenError", () => {
  it("surfaces an upstream moderation reason hidden behind 'Invalid JSON response'", () => {
    const body = JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: JSON.stringify({ status: "Request Moderated", details: { "Moderation Reasons": ["Sexual Content"] } }) },
      },
    });
    // BFL Flux moderation surfaced through OpenRouter — the real reason, not "Invalid JSON response".
    expect(describeImageGenError(apiError(body))).toBe("Provider returned error: Sexual Content");
  });

  it("surfaces the provider message even without moderation metadata (the 200-after-stream case)", () => {
    const body = JSON.stringify({ error: { message: "Provider returned error", code: 400 } });
    expect(describeImageGenError(apiError(body))).toBe("Provider returned error");
  });

  it("falls back to the API error message when the body carries no provider error", () => {
    expect(describeImageGenError(apiError("not json at all"))).toBe("Invalid JSON response");
  });

  it("passes plain errors through untouched", () => {
    expect(describeImageGenError(new Error("boom"))).toBe("boom");
    expect(describeImageGenError("weird")).toBe("weird");
  });
});
