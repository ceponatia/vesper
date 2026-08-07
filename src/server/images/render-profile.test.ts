import { describe, expect, it } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  type ImageModel,
  type ImageModelProfile,
} from "@/contracts";
import { preparePromptForImageModel } from "./quality-presets";
import {
  compileProfileRenderPlan,
  pinnedImageModelVersion,
  profileRenderControlsHash,
  sha256Hex,
  stableJson,
} from "./render-profile";

/**
 * The compile step's contract, asserted where it is cheapest to assert: pure
 * rows in, a plan out. The integration suite proves the plan REACHES the
 * provider seam; these cases prove the plan is right.
 */

const CAPABILITIES = {
  controls: {
    negativePrompt: { field: "negative_prompt", type: "string" },
    guidance: { field: "guidance_scale", type: "number", minimum: 0, maximum: 20 },
  },
  knownInputFields: ["negative_prompt", "guidance_scale", "scheduler"],
};

function model(over: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "model-1",
    slug: "vesper-test/compile",
    label: "Compile Fixture",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 4,
    supportedAspects: ["1:1", "3:4"],
    probedVersionId: "version-probed",
    advancedCapabilities: CAPABILITIES,
    ...over,
  });
}

function profile(over: Record<string, unknown> = {}): ImageModelProfile {
  return imageModelProfileSchema.parse({
    id: "profile-1",
    imageModelId: "model-1",
    key: "compile-fixture",
    label: "Compile Fixture",
    task: "variant",
    operation: "edit",
    promptStrategy: "instruction_edit",
    ...over,
  });
}

function plan(modelOver: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}) {
  return compileProfileRenderPlan({
    model: model(modelOver),
    profile: profile(profileOver),
    basePrompt: "change the outfit",
    baseNegativePrompt: null,
    referenceRoles: ["canonical_identity"],
  });
}

function hashOf(compiled: ReturnType<typeof plan>): string {
  return profileRenderControlsHash(compiled, {
    profileId: "profile-1",
    profileKey: "compile-fixture",
    promptStrategy: "instruction_edit",
    orderedReferenceRoles: ["canonical_identity"],
  });
}

describe("pinnedImageModelVersion", () => {
  it("prefers the probed version and falls back to the slug's own pin", () => {
    expect(pinnedImageModelVersion(model())).toBe("version-probed");
    expect(pinnedImageModelVersion(model({ probedVersionId: null, slug: "owner/name:slugpin" }))).toBe("slugpin");
  });

  it("returns null when nothing pins the row", () => {
    // A bare slug with no probe runs whatever `latest_version` is that hour,
    // which a controlled comparison may not do.
    expect(pinnedImageModelVersion(model({ probedVersionId: null }))).toBeNull();
  });

  it("returns null when the probe and the slug disagree", () => {
    // The stored bindings describe one version while the slug names another:
    // there is no single version this row can honestly claim to execute, and
    // picking either would be a coin flip recorded as a pin.
    expect(pinnedImageModelVersion(model({ probedVersionId: "a", slug: "owner/name:b" }))).toBeNull();
    expect(pinnedImageModelVersion(model({ probedVersionId: "a", slug: "owner/name:a" }))).toBe("a");
  });
});

describe("compileProfileRenderPlan", () => {
  it("leaves a single-reference prompt exactly as the caller wrote it", () => {
    expect(plan().finalPrompt).toBe("change the outfit");
  });

  it("prefixes numbered role bindings when more than one reference is sent", () => {
    const compiled = compileProfileRenderPlan({
      model: model(),
      profile: profile(),
      basePrompt: "change the outfit",
      baseNegativePrompt: null,
      referenceRoles: ["face_detail", "canonical_identity"],
    });
    expect(compiled.finalPrompt.startsWith("Image 1: a close facial-detail reference")).toBe(true);
    expect(compiled.finalPrompt.endsWith("change the outfit")).toBe(true);
  });

  it("maps the profile's control defaults onto the version's real field names", () => {
    const compiled = plan({}, { controlDefaults: { negativePrompt: "blurry", guidance: 6, seedPolicy: "random" } });
    expect(compiled.controlInput).toEqual({ negative_prompt: "blurry", guidance_scale: 6 });
    expect(compiled.negativePrompt).toBe("blurry");
    expect(compiled.resolvedControls.droppedControls).toEqual([]);
  });

  it("prefers the caller's negative prompt over the profile default", () => {
    const compiled = compileProfileRenderPlan({
      model: model(),
      profile: profile({ controlDefaults: { negativePrompt: "profile default", seedPolicy: "random" } }),
      basePrompt: "p",
      baseNegativePrompt: "fixture negative",
      referenceRoles: [],
    });
    expect(compiled.negativePrompt).toBe("fixture negative");
    expect(compiled.controlInput).toEqual({ negative_prompt: "fixture negative" });
  });

  it("reports a negative prompt this version cannot carry as null, with the drop recorded", () => {
    // "Nothing goes" is the render-facing truth; WHY nothing goes survives in
    // the drop list, so the hash still distinguishes the two configurations.
    const compiled = plan(
      { advancedCapabilities: { knownInputFields: ["scheduler"] } },
      { controlDefaults: { negativePrompt: "blurry", seedPolicy: "random" } },
    );
    expect(compiled.negativePrompt).toBeNull();
    expect(compiled.controlInput).toEqual({});
    expect(compiled.resolvedControls.droppedControls).toEqual([{ control: "negativePrompt", reason: "no_binding" }]);
  });

  it("records an unsendable seed policy rather than pretending the run was seeded", () => {
    const compiled = plan({}, { controlDefaults: { seedPolicy: "reuse_source" } });
    expect(compiled.resolvedControls.droppedControls).toEqual([
      { control: "seedPolicy", reason: "no_seed_transport" },
    ]);
    // The default policy sends nothing anyway, so it drops nothing.
    expect(plan().resolvedControls.droppedControls).toEqual([]);
  });

  it("merges validated provider overrides last and refuses reserved fields", () => {
    const compiled = plan(
      {},
      {
        controlDefaults: { guidance: 6, seedPolicy: "random" },
        providerOverrides: { scheduler: "KarrasDPM", prompt: "hijacked", made_up: 1 },
      },
    );
    expect(compiled.controlInput).toEqual({ guidance_scale: 6, scheduler: "KarrasDPM" });
    expect(compiled.resolvedControls.droppedControls).toEqual([
      { control: "made_up", reason: "unknown_field" },
      { control: "prompt", reason: "reserved" },
    ]);
  });

  it("carries the profile's operation, timeout, aspect and version onto the plan", () => {
    const compiled = plan({}, { timeoutMs: 90_000 });
    expect(compiled.timeoutMs).toBe(90_000);
    expect(compiled.resolvedControls.timeoutMs).toBe(90_000);
    expect(compiled.resolvedControls.operation).toBe("edit");
    expect(compiled.aspectValue).toBe("3:4");
    expect(compiled.versionId).toBe("version-probed");
  });

  it("compiles against the reviewed-quality model, not the raw row", () => {
    // Qwen Edit's provider default optimizes speed where fidelity matters; the
    // reviewed seam corrects it, and the plan must describe the corrected model.
    const compiled = plan({ slug: "qwen/qwen-image-edit-2511", extraInput: { go_fast: true } });
    expect(compiled.effectiveModel.extraInput).toEqual({ go_fast: false });
  });
});

describe("preparePromptForImageModel idempotency", () => {
  it("leaves an already-prepared prompt byte-identical", () => {
    // `compileProfileRenderPlan` hashes the prepared prompt and `renderWithModel`
    // prepares again on the way out. If this ever stops holding, every trial cell
    // starts refusing cell_conflict against its own compiled prompt.
    const legacy =
      "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";
    const target = { slug: "qwen/qwen-image-edit-2511" };
    for (const count of [1, 2]) {
      const once = preparePromptForImageModel(target, `${legacy} Then change the outfit.`, count);
      expect(preparePromptForImageModel(target, once, count)).toBe(once);
    }
  });
});

describe("profileRenderControlsHash", () => {
  it("is stable across two identical compiles", () => {
    expect(hashOf(plan())).toBe(hashOf(plan()));
  });

  it("moves when the EFFECTIVE model's payload constants move", () => {
    // The gap this closes: the reviewed-quality table rewrites `extraInput` at
    // the render boundary, so hashing the raw row let that table change what a
    // pinned comparison sends with no conflict to show for it.
    const raw = plan({ slug: "qwen/qwen-image-edit-2511", extraInput: { go_fast: true } });
    const asStored = profileRenderControlsHash(
      { ...raw, effectiveModel: model({ slug: "qwen/qwen-image-edit-2511", extraInput: { go_fast: true } }) },
      {
        profileId: "profile-1",
        profileKey: "compile-fixture",
        promptStrategy: "instruction_edit",
        orderedReferenceRoles: ["canonical_identity"],
      },
    );
    expect(hashOf(raw)).not.toBe(asStored);
  });

  it("moves when a control, a drop, the timeout, the version, or the role order changes", () => {
    const base = hashOf(plan());
    expect(hashOf(plan({}, { controlDefaults: { guidance: 6, seedPolicy: "random" } }))).not.toBe(base);
    expect(hashOf(plan({}, { controlDefaults: { steps: 30, seedPolicy: "random" } }))).not.toBe(base);
    expect(hashOf(plan({}, { timeoutMs: 90_000 }))).not.toBe(base);
    expect(hashOf(plan({ probedVersionId: "version-other" }))).not.toBe(base);
    expect(
      profileRenderControlsHash(plan(), {
        profileId: "profile-1",
        profileKey: "compile-fixture",
        promptStrategy: "instruction_edit",
        orderedReferenceRoles: ["face_detail", "canonical_identity"],
      }),
    ).not.toBe(base);
  });

  it("ignores display-only edits", () => {
    // A renamed profile is the same experiment; invalidating a grid over a label
    // edit would train operators to ignore cell_conflict.
    expect(hashOf(plan({ label: "Renamed", sort: 99 }, { label: "Renamed too", sort: 42 }))).toBe(hashOf(plan()));
  });
});

describe("stableJson", () => {
  it("sorts keys recursively so two spellings of one object hash alike", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(sha256Hex(stableJson({ a: 1 }))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves array order, which is meaningful", () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });

  it("drops undefined members and renders null honestly", () => {
    expect(stableJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});
