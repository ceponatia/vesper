import { describe, expect, it } from "vitest";
import { apiError } from "@/server/test-support";
import { classifyImageFailure, isBillingFailure } from "./image-providers";

/**
 * The adapter's whole job is getting the REAL message out of a thrown value
 * before the pure classifier (`@vesper/image-core`) reads it — the case a plain
 * `error.message` loses. The classification rules themselves are covered in the
 * package (`provider-interface/failures.test.ts`); what is tested here is that a
 * thrown AI-SDK error still reaches them intact.
 */
describe("classifyImageFailure", () => {
  it("digs an upstream moderation verdict out of an APICallError response body", () => {
    const body = JSON.stringify({
      error: {
        message: "Provider returned error",
        metadata: { raw: JSON.stringify({ details: { "Moderation Reasons": ["Sexual Content"] } }) },
      },
    });
    expect(classifyImageFailure(apiError(body))).toBe("content_rejection");
  });

  it("classifies a plain thrown Error by its message", () => {
    expect(classifyImageFailure(new Error("replicate 503: service unavailable"))).toBe("transient");
    expect(classifyImageFailure("replicate returned no image")).toBe("other");
  });
});

describe("isBillingFailure", () => {
  it("recognizes an out-of-credit failure from a thrown value", () => {
    const insufficient = new Error('replicate 402: {"title":"Insufficient credit","detail":"..."}');
    expect(isBillingFailure(insufficient)).toBe(true);
    expect(isBillingFailure(new Error("replicate 503: service unavailable"))).toBe(false);
  });
});
