import { describe, expect, it } from "vitest";
import { emptyImageModelAdvancedCapabilities } from "../capabilities/image-model-capabilities";
import {
  chooseAspect,
  chooseDimensions,
  fitReferences,
  imageModelOffersSurface,
  imageModelSchema,
  imageModelsForSurface,
  isUndisclosedProviderVersion,
  parseAspectValue,
  providerVersionsDisagree,
  referenceCapacity,
  REPLICATE_VERSION_UNDISCLOSED,
  type ImageModel,
} from "./image-models";

const model = (overrides: Partial<ImageModel> = {}): ImageModel => ({
  id: "m1",
  slug: "qwen/qwen-image-2512",
  label: "Qwen Image 2512",
  canGenerate: true,
  canEdit: true,
  referenceField: "image",
  referenceArity: "array",
  referenceTransport: "file",
  maxReferences: 3,
  aspectMode: "aspect_ratio",
  supportedAspects: ["1:1", "3:4", "16:9"],
  outputFormat: "webp",
  extraInput: {},
  // The reviewed ratings this slug actually carries: its optional `image` +
  // `strength` input is conventional repainting, not identity-preserving editing.
  probedVersionId: null,
  editKind: "img2img",
  identityPreservation: "weak",
  operatorWarning: null,
  advancedCapabilities: emptyImageModelAdvancedCapabilities(),
  forPortrait: true,
  forVariant: true,
  forScene: true,
  builtin: true,
  sort: 10,
  ...overrides,
});

describe("imageModelSchema", () => {
  // A stored row as it reads back before any of the later columns existed.
  const priorRow = {
    id: "m1",
    slug: "qwen/qwen-image-2512",
    label: "Qwen Image 2512",
    canGenerate: true,
    canEdit: true,
  };

  it("defaults the reference transport to an uploaded file", () => {
    // The column arrived after the seeded rows (drizzle/0099); a payload that
    // predates it must parse to the transport every model but Wan wants rather
    // than failing the picker.
    expect(imageModelSchema.parse(priorRow).referenceTransport).toBe("file");
  });

  it("leaves a row that predates the capability columns unreviewed and inert", () => {
    // `unknown` ratings are permissive and an empty capability set sends no
    // optional control, so such a row behaves exactly as it does today.
    const parsed = imageModelSchema.parse(priorRow);
    expect(parsed.probedVersionId).toBeNull();
    expect(parsed.editKind).toBe("unknown");
    expect(parsed.identityPreservation).toBe("unknown");
    expect(parsed.operatorWarning).toBeNull();
    expect(parsed.advancedCapabilities).toEqual(emptyImageModelAdvancedCapabilities());
  });

  it("gives each parsed row its own advanced-capability object", () => {
    // The default is a thunk: zod passes a default value through without cloning,
    // so a shared literal would let a probe writing one model's known fields
    // rewrite every other model's.
    const first = imageModelSchema.parse(priorRow);
    first.advancedCapabilities.knownInputFields.push("prompt");
    expect(imageModelSchema.parse(priorRow).advancedCapabilities.knownInputFields).toEqual([]);
  });
});

describe("parseAspectValue", () => {
  it("reads both spellings", () => {
    expect(parseAspectValue("3:4")).toBeCloseTo(0.75);
    // Wan uses an asterisk, not an x.
    expect(parseAspectValue("1536*2048")).toBeCloseTo(0.75);
  });

  it("returns null for tier names that carry no shape", () => {
    expect(parseAspectValue("2K")).toBeNull();
    expect(parseAspectValue("custom")).toBeNull();
    expect(parseAspectValue("")).toBeNull();
  });
});

describe("chooseAspect", () => {
  it("sends an exact match without cropping", () => {
    expect(chooseAspect(model())).toEqual({ value: "3:4", needsCrop: false });
  });

  it("picks the closest offered ratio and crops when there is no exact match", () => {
    // Stable Diffusion 3.5 Large's real enum — no 3:4. 4:5 (0.80) is nearer to
    // 0.75 than 2:3 (0.667), which is the owner's 2026-08-05 ruling.
    const sd = model({ supportedAspects: ["16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"] });
    expect(chooseAspect(sd)).toEqual({ value: "4:5", needsCrop: true });
  });

  it("prefers the largest exact match among pixel pairs", () => {
    // Wan offers three exactly-3:4 sizes; taking the first would render
    // portraits at a quarter of everything else's resolution.
    const wan = model({
      aspectMode: "size",
      supportedAspects: ["1024*768", "768*1024", "2048*1536", "1536*2048", "3072*4096"],
    });
    expect(chooseAspect(wan)).toEqual({ value: "3072*4096", needsCrop: false });
  });

  it("serves the entity lanes' non-portrait ratios from the same menu", () => {
    expect(chooseAspect(model(), 1)).toEqual({ value: "1:1", needsCrop: false });
    // 3:2 is not offered here, so the closest landscape option is cropped down.
    expect(chooseAspect(model(), 1.5)).toEqual({ value: "16:9", needsCrop: true });
  });

  it("breaks ties toward the wider option", () => {
    // 1:2 (0.5) and 1:1 (1.0) are equidistant from 0.75. Cropping a too-wide
    // image trims background from the sides; a too-tall one trims heads.
    expect(chooseAspect(model({ supportedAspects: ["1:2", "1:1"] }))).toEqual({ value: "1:1", needsCrop: true });
  });

  it("asks for nothing when the model offers no parseable shape", () => {
    expect(chooseAspect(model({ supportedAspects: [] }))).toEqual({ value: null, needsCrop: false });
    expect(chooseAspect(model({ supportedAspects: ["2K", "custom"] }))).toEqual({ value: null, needsCrop: false });
  });
});

describe("chooseDimensions", () => {
  /** Wan's real menu: three pixel pairs, all exactly 3:4. */
  const wan = (overrides: Partial<ImageModel> = {}) =>
    model({ aspectMode: "size", supportedAspects: ["768*1024", "1536*2048", "3072*4096"], ...overrides });

  it("answers a factless request exactly as chooseAspect, in both modes", () => {
    expect(chooseDimensions(model(), { targetRatio: 3 / 4 })).toEqual({
      input: { aspect_ratio: "3:4" },
      expectedAspect: 3 / 4,
      needsCrop: false,
    });
    expect(chooseDimensions(wan(), { targetRatio: 3 / 4 })).toEqual({
      input: { size: "3072*4096" },
      expectedAspect: 3 / 4,
      needsCrop: false,
    });
    // Absent facts leave no requestedResolution echo behind either.
    expect("requestedResolution" in chooseDimensions(wan(), { targetRatio: 3 / 4 })).toBe(false);
  });

  it("delegates the aspect_ratio shape to chooseAspect even when a tier rides along", () => {
    // On an aspect_ratio model the tier is an ordinary mapped control — it must
    // not move the shape, only be echoed as what was asked.
    const sd = model({ supportedAspects: ["1:1", "4:5"] });
    expect(chooseDimensions(sd, { targetRatio: 3 / 4, operation: "generate", resolution: "2K" })).toEqual({
      input: { aspect_ratio: "4:5" },
      expectedAspect: 4 / 5,
      needsCrop: true,
      requestedResolution: "2K",
    });
  });

  it("picks the same-ratio size nearest each tier's pixel area", () => {
    expect(chooseDimensions(wan(), { targetRatio: 3 / 4, resolution: "1K" }).input).toEqual({ size: "768*1024" });
    expect(chooseDimensions(wan(), { targetRatio: 3 / 4, resolution: "2K" })).toEqual({
      input: { size: "1536*2048" },
      expectedAspect: 3 / 4,
      needsCrop: false,
      requestedResolution: "2K",
    });
    expect(chooseDimensions(wan(), { targetRatio: 3 / 4, resolution: "4K" }).input).toEqual({ size: "3072*4096" });
  });

  it("keeps the largest-area choice when no tier is set", () => {
    expect(chooseDimensions(wan(), { targetRatio: 3 / 4, operation: "generate" })).toEqual({
      input: { size: "3072*4096" },
      expectedAspect: 3 / 4,
      needsCrop: false,
    });
  });

  it("still runs the ratio contest first when the tier has no same-ratio candidate", () => {
    // Nothing 3:4 on offer: the closest ratio wins as it always did, and the
    // tier only picks the area WITHIN that ratio. A tier must never move a
    // render to a worse shape to hit a pixel count.
    const wide = wan({ supportedAspects: ["1024*576", "2048*1152"] });
    expect(chooseDimensions(wide, { targetRatio: 3 / 4, resolution: "2K" })).toEqual({
      input: { size: "2048*1152" },
      expectedAspect: 2048 / 1152,
      needsCrop: true,
      requestedResolution: "2K",
    });
  });

  it("honors an explicit pair only when the schema offers it verbatim", () => {
    const exact = chooseDimensions(wan(), { targetRatio: 3 / 4, resolution: "custom", width: 1536, height: 2048 });
    expect(exact).toEqual({
      input: { size: "1536*2048" },
      expectedAspect: 3 / 4,
      needsCrop: false,
      requestedResolution: "custom",
    });
    // A pair the enum does not offer is ignored — a size-mode model accepts
    // nothing but its enum — so the choice falls back to the default answer.
    const invented = chooseDimensions(wan(), { targetRatio: 3 / 4, resolution: "custom", width: 1500, height: 2000 });
    expect(invented.input).toEqual({ size: "3072*4096" });
  });

  it("crops an offered pair whose shape misses the lane's target", () => {
    // The pair is sent (it is a real enum entry), but the lane's ratio still
    // wins downstream: the mismatch is declared so the caller crops.
    expect(chooseDimensions(wan(), { targetRatio: 1, width: 768, height: 1024 })).toEqual({
      input: { size: "768*1024" },
      expectedAspect: 3 / 4,
      needsCrop: true,
    });
  });

  it("judges the expected shape by a mapped custom pair on an aspect_ratio model", () => {
    // The pair rides the mapped controlInput, not this choice — but the model
    // will RETURN the pair's shape, so the crop expectation follows it.
    const sd = model({ supportedAspects: ["1:1", "4:5"] });
    const matched = chooseDimensions(sd, {
      targetRatio: 3 / 4,
      resolution: "custom",
      width: 1200,
      height: 1600,
      mappedCustomSize: { width: 1200, height: 1600 },
    });
    expect(matched).toEqual({
      input: { aspect_ratio: "4:5" },
      expectedAspect: 3 / 4,
      needsCrop: false,
      requestedResolution: "custom",
    });
    const sideways = chooseDimensions(sd, {
      targetRatio: 3 / 4,
      resolution: "custom",
      mappedCustomSize: { width: 1600, height: 1200 },
    });
    expect(sideways.expectedAspect).toBe(1600 / 1200);
    expect(sideways.needsCrop).toBe(true);
  });

  it("ignores a custom pair that never mapped", () => {
    // Width and height that dropped at the mapper reach the provider nowhere,
    // so expecting their shape would expect a render nobody requested.
    const sd = model({ supportedAspects: ["1:1", "4:5"] });
    expect(chooseDimensions(sd, { targetRatio: 3 / 4, resolution: "custom", width: 1200, height: 1600 })).toEqual({
      input: { aspect_ratio: "4:5" },
      expectedAspect: 4 / 5,
      needsCrop: true,
      requestedResolution: "custom",
    });
  });

  it("returns the null choice for a shapeless model, whatever was asked", () => {
    expect(chooseDimensions(model({ supportedAspects: [] }), { targetRatio: 3 / 4, resolution: "2K" })).toEqual({
      input: {},
      expectedAspect: null,
      needsCrop: false,
      requestedResolution: "2K",
    });
    // Tier names in the enum carry no shape, exactly as chooseAspect reads them.
    expect(
      chooseDimensions(wan({ supportedAspects: ["2K", "custom"] }), { targetRatio: 3 / 4, resolution: "2K" }).input,
    ).toEqual({});
  });
});

describe("referenceCapacity and fitReferences", () => {
  it("reports zero for a model that cannot edit, whatever its stored cap says", () => {
    expect(referenceCapacity(model({ canEdit: false, maxReferences: 9 })).max).toBe(0);
    expect(fitReferences(model({ canEdit: false, maxReferences: 9 }), ["a", "b"])).toEqual([]);
  });

  it("never reports more than one for a single-arity model", () => {
    expect(referenceCapacity(model({ referenceArity: "single", maxReferences: 14 })).max).toBe(1);
    expect(fitReferences(model({ referenceArity: "single", maxReferences: 14 }), ["a", "b", "c"])).toEqual(["a"]);
  });

  it("trims a list to the stored cap and keeps order", () => {
    expect(fitReferences(model({ maxReferences: 2 }), ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("carries the field name and arity through for the payload builder", () => {
    expect(referenceCapacity(model({ referenceField: "image_input" }))).toMatchObject({
      field: "image_input",
      arity: "array",
    });
  });
});

describe("surface filtering", () => {
  it("requires the capability as well as the toggle", () => {
    // An edit-only model may be ticked for portraits and still not be listed —
    // it cannot make an image from nothing.
    const editOnly = model({ canGenerate: false, forPortrait: true });
    expect(imageModelOffersSurface(editOnly, "portrait")).toBe(false);
    expect(imageModelOffersSurface(editOnly, "scene")).toBe(true);

    const generateOnly = model({ canEdit: false, forScene: true, forVariant: true });
    expect(imageModelOffersSurface(generateOnly, "scene")).toBe(false);
    expect(imageModelOffersSurface(generateOnly, "variant")).toBe(false);
    expect(imageModelOffersSurface(generateOnly, "portrait")).toBe(true);
  });

  it("lists a surface in stored sort order", () => {
    const models = [model({ id: "b", sort: 20 }), model({ id: "a", sort: 10 })];
    expect(imageModelsForSurface(models, "portrait").map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("provider version disclosure", () => {
  const PIN = "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729";

  it("reads Replicate's official-model answer as a non-disclosure", () => {
    expect(isUndisclosedProviderVersion(REPLICATE_VERSION_UNDISCLOSED)).toBe(true);
    expect(isUndisclosedProviderVersion("hidden")).toBe(true);
    // A real sha, an absence, and the empty string all NAME something (or
    // nothing) — none of them is the provider declining to say.
    expect(isUndisclosedProviderVersion(PIN)).toBe(false);
    expect(isUndisclosedProviderVersion(null)).toBe(false);
    expect(isUndisclosedProviderVersion(undefined)).toBe(false);
    expect(isUndisclosedProviderVersion("Hidden")).toBe(false);
  });

  it("calls a genuinely different echo a disagreement", () => {
    expect(providerVersionsDisagree(PIN, "b1780b8f58e6086458d216c7df82567d5488e622aa4a86a99238efd14db7d830")).toBe(
      true,
    );
  });

  it("never disagrees when a side is absent", () => {
    // Silence is silence. Most model-endpoint responses carry no version at
    // all, and a baseline pins none — refusing on either would fail everything.
    expect(providerVersionsDisagree(null, PIN)).toBe(false);
    expect(providerVersionsDisagree(PIN, null)).toBe(false);
    expect(providerVersionsDisagree(null, null)).toBe(false);
  });

  it("never disagrees when the provider does not disclose", () => {
    // The owner ruling of 2026-08-11: `"hidden"` is non-disclosure, not a
    // disagreeing version. The run's identity is the requested pin, which
    // Replicate validated at create time (an unresolvable version is refused
    // 422 before any spend).
    expect(providerVersionsDisagree(PIN, REPLICATE_VERSION_UNDISCLOSED)).toBe(false);
    expect(providerVersionsDisagree(PIN, "hidden")).toBe(false);
  });

  it("still agrees with itself", () => {
    expect(providerVersionsDisagree(PIN, PIN)).toBe(false);
    // Undisclosed on BOTH sides is the degenerate equal case, not a mismatch.
    expect(providerVersionsDisagree("hidden", "hidden")).toBe(false);
  });
});
