import { describe, expect, it } from "vitest";
import {
  PROVISIONING_STAMP_LENGTH,
  deriveProvisioningStamp,
  provisioningPayloadHash,
  provisioningRequestIdSchema,
} from "./provisioning";

// successor-world-lifecycle.plan.md slice 3: the whole resume story rests on
// these three pure derivations — a stamp that is stable per key and distinct
// across keys, a payload hash that catches a reused key carrying a different
// request, and a token schema that keeps both safe as database/hash material.

describe("deriveProvisioningStamp", () => {
  it("is stable for one (owner, request) key", () => {
    const first = deriveProvisioningStamp("owner-a", "req-1");
    const second = deriveProvisioningStamp("owner-a", "req-1");
    expect(second).toBe(first);
  });

  it("keeps the cuid2 shape newId() produced (24 lowercase alphanumerics)", () => {
    const stamp = deriveProvisioningStamp("owner-a", "req-1");
    expect(stamp).toHaveLength(PROVISIONING_STAMP_LENGTH);
    expect(stamp).toMatch(/^[0-9a-z]{24}$/);
    // The ids the starter world composes from it stay well-formed simulation ids.
    expect(`stw-${stamp}-link-home-square`).not.toMatch(/\s/);
    expect(`stw-${stamp}-link-home-square`.length).toBeLessThan(256);
  });

  it("separates different owners and different requests", () => {
    expect(deriveProvisioningStamp("owner-a", "req-1")).not.toBe(deriveProvisioningStamp("owner-b", "req-1"));
    expect(deriveProvisioningStamp("owner-a", "req-1")).not.toBe(deriveProvisioningStamp("owner-a", "req-2"));
  });

  it("cannot alias two keys by moving the delimiter (length-prefixed material)", () => {
    // Without length prefixing, ("ab", "c") and ("a", "bc") would collide.
    expect(deriveProvisioningStamp("ab", "c")).not.toBe(deriveProvisioningStamp("a", "bc"));
  });
});

describe("provisioningPayloadHash", () => {
  it("matches for the same request and differs when the ask changes", () => {
    const base = { characterId: "char-1", title: "Their world" };
    expect(provisioningPayloadHash(base)).toBe(provisioningPayloadHash({ ...base }));
    expect(provisioningPayloadHash(base)).not.toBe(provisioningPayloadHash({ ...base, characterId: "char-2" }));
    expect(provisioningPayloadHash(base)).not.toBe(provisioningPayloadHash({ ...base, title: "Another world" }));
  });

  it("treats an omitted title and an empty title as the same ask", () => {
    expect(provisioningPayloadHash({ characterId: "char-1", title: "" })).toBe(
      provisioningPayloadHash({ characterId: "char-1", title: "" }),
    );
  });
});

describe("provisioningRequestIdSchema", () => {
  it("accepts ordinary client tokens", () => {
    expect(provisioningRequestIdSchema.safeParse("b8f3c1de-4a2b-4b5f-9c11-2f0a7d6e5c44").success).toBe(true);
    expect(provisioningRequestIdSchema.safeParse("kx7q2m9v0a1b2c3d4e5f6g7h").success).toBe(true);
  });

  it("rejects empty, over-long, and whitespace-bearing tokens", () => {
    expect(provisioningRequestIdSchema.safeParse("").success).toBe(false);
    expect(provisioningRequestIdSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(provisioningRequestIdSchema.safeParse("bad id").success).toBe(false);
    expect(provisioningRequestIdSchema.safeParse(" padded").success).toBe(false);
  });
});
