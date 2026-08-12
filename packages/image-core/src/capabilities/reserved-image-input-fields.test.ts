import { describe, expect, it } from "vitest";
import { imageModelSchema, type ImageModel } from "../models/image-models";
import { reservedImageInputFields } from "./reserved-image-input-fields";

function model(over: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "m1",
    slug: "qwen/qwen-image-2512",
    label: "Qwen Image 2512",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "single",
    maxReferences: 1,
    supportedAspects: ["1:1", "3:4"],
    ...over,
  });
}

describe("reservedImageInputFields", () => {
  it("names the aspect key each model actually writes as reserved", () => {
    expect(reservedImageInputFields(model())).toContain("aspect_ratio");
    expect(reservedImageInputFields(model({ aspectMode: "size" }))).toContain("size");
    // Safety enforcement and the version pin are the render path's, not a profile's.
    expect(reservedImageInputFields(model())).toEqual(
      expect.arrayContaining(["prompt", "image", "version", "disable_safety_checker"]),
    );
  });

  it("also reserves a probed prompt field that is not called `prompt`", () => {
    // The structural fields are what the payload builder writes; a version whose
    // schema calls the prompt something else must not be overridable through the
    // name it happens to use.
    const probed = model({
      advancedCapabilities: { prompt: { field: "text_prompt", type: "string" }, knownInputFields: ["text_prompt"] },
    });
    expect(reservedImageInputFields(probed)).toContain("text_prompt");
    expect(reservedImageInputFields(probed)).toContain("prompt");
  });
});
