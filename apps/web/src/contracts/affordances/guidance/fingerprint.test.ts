import { describe, expect, it } from "vitest";
import {
  compareGuidanceFingerprints,
  guidanceFingerprint,
  guidanceOrderedPart,
  guidanceUnorderedPart,
} from "./fingerprint";

/**
 * The fingerprint's contract is narrow and total: same parts ⇒ same digest,
 * different parts ⇒ (practically always) a different digest, and no dependence on
 * clock, locale, or process. Everything downstream — tie-breaks, over-budget
 * reporting, retake reproduction — is built on those three sentences.
 */

describe("guidanceFingerprint", () => {
  it("is stable across calls and shaped like a 16-digit hex digest", () => {
    const first = guidanceFingerprint(["constraint", "probe", "locus"]);
    const second = guidanceFingerprint(["constraint", "probe", "locus"]);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("is order-sensitive", () => {
    expect(guidanceFingerprint(["a", "b"])).not.toBe(guidanceFingerprint(["b", "a"]));
  });

  it("cannot be forged by re-splitting the same characters", () => {
    expect(guidanceFingerprint(["ab", "c"])).not.toBe(guidanceFingerprint(["a", "bc"]));
    expect(guidanceFingerprint(["a,b"])).not.toBe(guidanceFingerprint(["a", "b"]));
  });

  it("distinguishes the fields candidates actually vary", () => {
    const digests = new Set([
      guidanceFingerprint(["constraint", "probe", "one", "consistency_only", "normal"]),
      guidanceFingerprint(["constraint", "probe", "one", "consistency_only", "high"]),
      guidanceFingerprint(["constraint", "probe", "one", "resolver_only", "normal"]),
      guidanceFingerprint(["constraint", "probe", "two", "consistency_only", "normal"]),
      guidanceFingerprint(["transition", "probe", "one", "consistency_only", "normal"]),
    ]);
    expect(digests.size).toBe(5);
  });

  it("collapses the degenerate inputs, which no builder can produce", () => {
    // Both canonicalize to the empty string. Harmless and worth pinning: every
    // builder passes a fixed-arity list whose first part is a kind tag, so a
    // zero-part call is unreachable rather than merely unlikely.
    expect(guidanceFingerprint([])).toBe(guidanceFingerprint([""]));
  });
});

describe("the part helpers", () => {
  it("treats an unordered part as a set and an ordered part as a sequence", () => {
    expect(guidanceUnorderedPart(["b", "a"])).toBe(guidanceUnorderedPart(["a", "b"]));
    expect(guidanceOrderedPart(["b", "a"])).not.toBe(guidanceOrderedPart(["a", "b"]));
  });

  it("does not mutate its input", () => {
    const values = Object.freeze(["b", "a"]);
    expect(guidanceUnorderedPart(values)).toBe("a,b");
    expect(values).toEqual(["b", "a"]);
  });
});

describe("compareGuidanceFingerprints", () => {
  it("orders lexicographically and reports ties as 0", () => {
    expect(compareGuidanceFingerprints("00ff", "0100")).toBe(-1);
    expect(compareGuidanceFingerprints("0100", "00ff")).toBe(1);
    expect(compareGuidanceFingerprints("0100", "0100")).toBe(0);
  });
});
