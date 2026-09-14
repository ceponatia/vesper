import { describe, expect, it } from "vitest";
import { emptyCharacterProfile } from "@/contracts";
import { simVisualStateShadowInput, type SimVisualStateShadowContext } from "./sim-visual-state";
import type { SimChatGarments } from "./sim-surfaces";

/**
 * Pure, no-IO coverage for the #297 body-surface exposure mapping
 * `simVisualStateShadowInput` derives from a structured garment read. The
 * realistic bad implementation this guards against: swapping which
 * `RegionCoverage` band reads `visible` vs `hidden` — a body-surface exposure
 * inversion is exactly the kind of defect this app cannot afford to ship
 * silently.
 */

const BASE_CONTEXT: SimVisualStateShadowContext = {
  chatId: "chat-1",
  branchId: "branch-1",
  playerActorId: "actor-player",
  primaryActorId: "actor-primary",
  cutId: "cut-1",
  storySecond: 1_000,
  primary: { name: "Nora", profile: emptyCharacterProfile() },
};

function exposureOf(garments: SimChatGarments | undefined): Record<string, string> {
  const input = simVisualStateShadowInput({ ...BASE_CONTEXT, garments });
  if (input === null) throw new Error("expected a shadow input (a profile is present)");
  return { ...input.perception.exposure };
}

describe("simVisualStateShadowInput — #297 body-surface exposure from the garment read", () => {
  it("fails closed (no exposure entries) when no garment read is present", () => {
    expect(exposureOf(undefined)).toEqual({});
  });

  it("fails closed for a known-empty worn set", () => {
    expect(exposureOf({ status: "empty" })).toEqual({});
  });

  it("fails closed for a fallback (unresolved-mapping) read", () => {
    expect(exposureOf({ status: "fallback", reason: "sim_garment.mapping_unresolved", names: "a coat" })).toEqual({});
  });

  it("fails closed for a structured but UNRELIABLE (mixed) read", () => {
    expect(
      exposureOf({
        status: "structured",
        digest: "Wardrobe right now (authoritative): - Nora: coat",
        readouts: [],
        exposure: { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" },
        reliable: false,
      }),
    ).toEqual({});
  });

  it("maps bare to visible, sheer to hinted, and covered to hidden for a structured, reliable read", () => {
    const exposure = exposureOf({
      status: "structured",
      digest: "Wardrobe right now (authoritative): - Nora: nothing",
      readouts: [],
      exposure: { torso: "bare", pelvis: "covered", legs: "sheer", feet: "covered" },
      reliable: true,
    });
    // torso ⇒ chest, bare ⇒ visible (skin is what the eye reaches).
    expect(exposure.chest).toBe("visible");
    // pelvis ⇒ groin/hips/buttocks, covered ⇒ hidden.
    expect(exposure.groin).toBe("hidden");
    expect(exposure.hips).toBe("hidden");
    expect(exposure.buttocks).toBe("hidden");
    // legs ⇒ thighs, sheer ⇒ hinted.
    expect(exposure.thighs).toBe("hinted");
    // feet ⇒ every foot-part id, covered ⇒ hidden.
    expect(exposure.feet).toBe("hidden");
    expect(exposure.top_of_foot).toBe("hidden");
    expect(exposure.sole).toBe("hidden");
    expect(exposure.heel).toBe("hidden");
    expect(exposure.toes).toBe("hidden");
  });
});
