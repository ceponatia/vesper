import { describe, expect, it } from "vitest";
import { classifyImageFailureMessage, imageFailureHealthOutcome, isBillingFailureMessage } from "./failures";

describe("classifyImageFailureMessage", () => {
  it("classifies provider content-policy strings as content rejections", () => {
    expect(classifyImageFailureMessage("replicate 400: request blocked by content policy")).toBe("content_rejection");
    expect(classifyImageFailureMessage("replicate failed: NSFW content flagged")).toBe("content_rejection");
    // The shape `describeProviderError` digs out of an APICallError responseBody.
    expect(classifyImageFailureMessage('{"details":{"Moderation Reasons":["Sexual Content"]}}')).toBe(
      "content_rejection",
    );
  });

  it("classifies timeouts and 5xx/429 as transient", () => {
    expect(classifyImageFailureMessage("fetch failed: ETIMEDOUT")).toBe("transient");
    expect(classifyImageFailureMessage("replicate 503: service unavailable")).toBe("transient");
    expect(classifyImageFailureMessage("Too Many Requests")).toBe("transient");
  });

  it("treats missing keys and unknown failures as other", () => {
    expect(classifyImageFailureMessage("REPLICATE_API_TOKEN not configured")).toBe("other");
    expect(classifyImageFailureMessage("replicate returned no image")).toBe("other");
  });

  it("does not retry a billing failure as if it were transient", () => {
    // Observed on the Fly deploy 2026-08-05: `replicate 402: {"title":"Insufficient
    // credit"...}`. The `402` would match the transient status-code alternation and
    // earn a pointless retry, so billing is checked first.
    const insufficient = 'replicate 402: {"title":"Insufficient credit","detail":"..."}';
    expect(classifyImageFailureMessage(insufficient)).toBe("other");
    expect(isBillingFailureMessage(insufficient)).toBe(true);
    expect(isBillingFailureMessage("replicate 503: service unavailable")).toBe(false);
  });
});

describe("imageFailureHealthOutcome", () => {
  it("reports a transient failure to the breaker as a failed lane", () => {
    expect(imageFailureHealthOutcome("transient")).toBe(false);
  });

  it("says nothing about health when the provider answered about the request", () => {
    // A moderation refusal is the upstream WORKING, on a prompt it declined; the
    // scene chain treats it the same way, retrying sanitized rather than counting
    // it toward "possible image service outage". Shedding every caller's renders
    // over one prompt would be the wrong trade.
    expect(imageFailureHealthOutcome("content_rejection")).toBeNull();
  });

  it("says nothing about health for billing and configuration failures", () => {
    // `other` is where an empty Replicate balance and a missing token land. No
    // cooldown refills either, so a tripped breaker would only hide them.
    expect(imageFailureHealthOutcome("other")).toBeNull();
  });
});
