import { describe, expect, it } from "vitest";
import { renderAdvisoryCodes, renderAdvisoryOffers } from "@vesper/image-core";
import { renderAdvisoryCodeCopy, renderAdvisoryOfferCopy } from "./advisory-copy";

/**
 * The runtime half of the exhaustive-copy guard: every code and offer the
 * registry currently declares must produce real, distinct copy. The compile
 * half — a code ADDED to the registry without a matching switch arm — is
 * caught by `tsc`, not this file (an exhaustive switch with no `default`
 * fails to compile on a missing case); this test instead catches a copy
 * arm that regresses to an empty string or a duplicate of another code's
 * line, which a passing compile would not.
 */

describe("renderAdvisoryCodeCopy", () => {
  it("returns distinct, non-empty copy for every registered code", () => {
    const lines = renderAdvisoryCodes.map(renderAdvisoryCodeCopy);
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe("renderAdvisoryOfferCopy", () => {
  it("returns distinct, non-empty copy for every registered offer", () => {
    const lines = renderAdvisoryOffers.map(renderAdvisoryOfferCopy);
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(lines.length);
  });
});
