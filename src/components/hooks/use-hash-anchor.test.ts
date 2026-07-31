import { describe, expect, it } from "vitest";
import { ADULT_ELIGIBILITY_ANCHOR_ID } from "@/contracts";
import { hashTargetId } from "./use-hash-anchor";

describe("hashTargetId — the deep-link half of useHashAnchorScroll", () => {
  it("resolves the adult-eligibility blocker anchor", () => {
    expect(hashTargetId(`#${ADULT_ELIGIBILITY_ANCHOR_ID}`)).toBe(ADULT_ELIGIBILITY_ANCHOR_ID);
  });

  it("decodes percent-encoded ids", () => {
    expect(hashTargetId("#a%20b")).toBe("a b");
  });

  it("degrades to no target on empty or malformed hashes instead of throwing", () => {
    expect(hashTargetId("")).toBeUndefined();
    expect(hashTargetId("#")).toBeUndefined();
    expect(hashTargetId("not-a-hash")).toBeUndefined();
    expect(hashTargetId("#%")).toBeUndefined(); // bad percent-encoding
  });
});
