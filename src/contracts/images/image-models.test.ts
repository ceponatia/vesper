import { describe, expect, it } from "vitest";
import {
  chooseAspect,
  fitReferences,
  imageModelOffersSurface,
  imageModelsForSurface,
  parseAspectValue,
  referenceCapacity,
  resolveImageModel,
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
  maxReferences: 3,
  aspectMode: "aspect_ratio",
  supportedAspects: ["1:1", "3:4", "16:9"],
  outputFormat: "webp",
  extraInput: {},
  forPortrait: true,
  forVariant: true,
  forScene: true,
  builtin: true,
  sort: 10,
  ...overrides,
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

describe("resolveImageModel", () => {
  const portrait = model({ id: "p", slug: "qwen/qwen-image-2512", forScene: false, forVariant: false });
  const scene = model({
    id: "s",
    slug: "qwen/qwen-image-edit-2511",
    canGenerate: false,
    forPortrait: false,
    sort: 20,
  });
  const models = [portrait, scene];

  it("honours a stored pick by id or slug", () => {
    expect(resolveImageModel(models, "scene", "s")?.id).toBe("s");
    expect(resolveImageModel(models, "scene", "qwen/qwen-image-edit-2511")?.id).toBe("s");
  });

  it("degrades an unavailable pick to the surface default rather than failing", () => {
    // "reference" is a legacy Venice key from before the registry; the owner
    // does not migrate old chats, so it simply resolves to the default.
    expect(resolveImageModel(models, "scene", "reference")?.id).toBe("s");
    expect(resolveImageModel(models, "portrait", "deleted-row-id")?.id).toBe("p");
  });

  it("never returns a model the surface cannot use", () => {
    // The portrait default is not offered on the scene surface, so asking for
    // it there falls through to something that is.
    expect(resolveImageModel(models, "scene", "p")?.id).toBe("s");
  });

  it("returns null when a surface has nothing to offer", () => {
    expect(resolveImageModel([], "portrait", null)).toBeNull();
  });

  it("falls back to the first offered model when the default slug is gone", () => {
    const other = model({ id: "x", slug: "bytedance/seedream-4.5", sort: 5 });
    expect(resolveImageModel([other], "portrait", null)?.id).toBe("x");
  });
});
