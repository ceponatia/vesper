import { describe, expect, it } from "vitest";
import {
  reviewedImageProfileControls,
  reviewedImageQualityControlFields,
  reviewedImageQualityInputs,
  reviewedImageQualityPolicy,
  reviewedImageQualitySlugs,
} from "./reviewed-profile-controls";

/**
 * The reviewed effective values, per model, written out as literal provider
 * fields.
 *
 * Hand-written rather than derived from the code under test, which is the
 * whole point: this fixture is what stops the two representations from agreeing
 * with each other while both drifting away from the reviewed judgment.
 */
const SPEC_EFFECTIVE_VALUES: Record<string, Record<string, unknown>> = {
  "qwen/qwen-image-edit-2511": { go_fast: false },
  "aisha-ai-official/nsfw-flux-dev": { width: 832, height: 1216 },
  "aisha-ai-official/likereality-pony-v1": { width: 832, height: 1216, negative_prompt: "" },
  "nsfw-api/sdxl-pulid": { width: 832, height: 1216, method: "fidelity" },
};

/**
 * Models the 2026-08-16 ruling dropped from the reviewed set. They keep their
 * catalog pages and an admin can still add them; what they must not have is a
 * reviewed correction, because nothing seeds a profile to reproduce it.
 */
const DEMOTED_SLUGS = [
  "lucataco/juggernaut-xl-v9",
  "nsfw-api/realvis-hyper-lora",
  "nsfw-api/pony-realism-v2.3",
];

describe("the reviewed policy in both vocabularies", () => {
  it("covers exactly the models the spec reviews", () => {
    expect([...reviewedImageQualitySlugs].sort()).toEqual(Object.keys(SPEC_EFFECTIVE_VALUES).sort());
  });

  it("derives the transitional overlay's provider fields from the one table", () => {
    for (const [slug, expected] of Object.entries(SPEC_EFFECTIVE_VALUES)) {
      expect(reviewedImageQualityInputs[slug], slug).toEqual(expected);
    }
  });

  it("expresses every reviewed provider field through exactly one profile channel", () => {
    for (const slug of reviewedImageQualitySlugs) {
      const policy = reviewedImageQualityPolicy(slug);
      expect(policy, slug).not.toBeNull();
      if (!policy) continue;
      const mappedFields = reviewedImageQualityControlFields(policy);
      const overrideFields = Object.keys(policy.providerOverrides);
      // No field may be claimed by both a normalized control and a raw override —
      // that is the shape where a value moves in one place and not the other, and
      // whichever layer merged last would silently win.
      expect(mappedFields.filter((field) => overrideFields.includes(field)), slug).toEqual([]);
      // And together they must account for the whole reviewed effect.
      expect([...mappedFields, ...overrideFields].sort(), slug).toEqual(
        Object.keys(SPEC_EFFECTIVE_VALUES[slug] ?? {}).sort(),
      );
    }
  });

  it("gates every pinned dimension pair behind the custom resolution tier", () => {
    // `compileProfileRenderPlan` only lets width/height reach the mapper when the
    // tier says `custom`. A policy pinning a size without the tier would map
    // nothing and record `requires_custom_resolution` — parity would fail on the
    // one setting these community wrappers most need.
    for (const slug of reviewedImageQualitySlugs) {
      const controls = reviewedImageProfileControls(slug)?.controlDefaults;
      if (controls?.width === undefined && controls?.height === undefined) continue;
      expect(controls?.resolution, slug).toBe("custom");
      expect(controls?.width, slug).toBeTypeOf("number");
      expect(controls?.height, slug).toBeTypeOf("number");
    }
  });

  it("keeps the resolution gate out of the provider payload", () => {
    // The tier is the profile vocabulary's gate, not a field any reviewed wrapper
    // declares. Sending it would be a guessed key on models Replicate rejects
    // unknown inputs for.
    for (const inputs of Object.values(reviewedImageQualityInputs)) {
      expect(Object.keys(inputs)).not.toContain("resolution");
      expect(Object.keys(inputs)).not.toContain("size");
    }
  });

  it("says nothing about an unreviewed model", () => {
    expect(reviewedImageQualityPolicy("operator/added-yesterday")).toBeNull();
    expect(reviewedImageProfileControls("operator/added-yesterday")).toBeNull();
  });

  it("says nothing about a demoted model, which now runs on wrapper defaults", () => {
    for (const slug of DEMOTED_SLUGS) {
      expect(reviewedImageQualityPolicy(slug), slug).toBeNull();
      expect(reviewedImageQualityInputs[slug], slug).toBeUndefined();
    }
  });

  it("reviews only models that have a seeded row to put the profile controls on", () => {
    // What the demotion bought: the reviewed set no longer contains a model the
    // seed migration cannot reach, so every reviewed setting is reproducible as a
    // task profile's controls rather than being overlay-only forever.
    expect(reviewedImageQualitySlugs).not.toContain("lucataco/juggernaut-xl-v9");
    expect(reviewedImageQualitySlugs).not.toContain("nsfw-api/realvis-hyper-lora");
    expect(reviewedImageQualitySlugs).toHaveLength(4);
  });

  it("puts a setting with no normalized control in provider overrides", () => {
    // The two that genuinely have no word in the control vocabulary.
    expect(reviewedImageProfileControls("qwen/qwen-image-edit-2511")?.providerOverrides).toEqual({ go_fast: false });
    expect(reviewedImageProfileControls("nsfw-api/sdxl-pulid")?.providerOverrides).toEqual({ method: "fidelity" });
  });

  it("prefers a normalized control wherever the vocabulary has one", () => {
    const pony = reviewedImageProfileControls("aisha-ai-official/likereality-pony-v1");
    expect(pony?.controlDefaults).toEqual({
      negativePrompt: "",
      resolution: "custom",
      width: 832,
      height: 1216,
    });
    // The reviewed empty negative is a VALUE, not an absence: it exists to clear a
    // wrapper default, so it has to survive into the profile representation as an
    // empty string rather than being omitted.
    expect(pony?.controlDefaults.negativePrompt).toBe("");
    expect(pony?.providerOverrides).toEqual({});
  });
});
