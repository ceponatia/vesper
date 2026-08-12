import { describe, expect, it } from "vitest";
import { imageModelSchema, type ImageModel } from "../models/image-models";
import { imageModelProfileSchema, type ImageModelProfile } from "../models/image-model-profiles";
import { compileProfileRenderPlan, type ProfileRenderPlan } from "./compile-profile-plan";
import { profileRenderControlsFingerprintJson } from "./fingerprint-json";
import { stableJson } from "./stable-json";

/**
 * What the fingerprint covers, asserted on the STRING the package owns. The
 * application's `render-fingerprint.test.ts` pins the SHA-256 of that string
 * against the value stored before the kernel moved, so between the two suites
 * both halves of the split are held still.
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

function plan(modelOver: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}): ProfileRenderPlan {
  const result = compileProfileRenderPlan({
    model: model(modelOver),
    profile: profile(profileOver),
    basePrompt: "change the outfit",
    baseNegativePrompt: null,
    safetyCheckerDisabled: true,
    references: { vocabulary: "identity_pack", roles: ["canonical_identity"] },
  });
  if (!result.ok) throw new Error(`[render-kernel] unexpected refusal: ${result.reason}`);
  return result.plan;
}

function fingerprintOf(compiled: ProfileRenderPlan): string {
  return profileRenderControlsFingerprintJson(compiled, {
    profileId: "profile-1",
    profileKey: "compile-fixture",
    promptStrategy: "instruction_edit",
    orderedReferenceRoles: ["canonical_identity"],
  });
}

describe("profileRenderControlsFingerprintJson", () => {
  it("is stable across two identical compiles", () => {
    expect(fingerprintOf(plan())).toBe(fingerprintOf(plan()));
  });

  it("moves when the EFFECTIVE model's payload constants move", () => {
    // The gap this closes: the reviewed-quality table rewrites `extraInput` at
    // the render boundary, so fingerprinting the raw row let that table change
    // what a pinned comparison sends with no conflict to show for it.
    const raw = plan({ slug: "qwen/qwen-image-edit-2511", extraInput: { go_fast: true } });
    const asStored = profileRenderControlsFingerprintJson(
      { ...raw, effectiveModel: model({ slug: "qwen/qwen-image-edit-2511", extraInput: { go_fast: true } }) },
      {
        profileId: "profile-1",
        profileKey: "compile-fixture",
        promptStrategy: "instruction_edit",
        orderedReferenceRoles: ["canonical_identity"],
      },
    );
    expect(fingerprintOf(raw)).not.toBe(asStored);
  });

  it("moves when a control, a drop, the timeout, the version, or the role order changes", () => {
    const base = fingerprintOf(plan());
    expect(fingerprintOf(plan({}, { controlDefaults: { guidance: 6, seedPolicy: "random" } }))).not.toBe(base);
    expect(fingerprintOf(plan({}, { controlDefaults: { steps: 30, seedPolicy: "random" } }))).not.toBe(base);
    expect(fingerprintOf(plan({}, { timeoutMs: 90_000 }))).not.toBe(base);
    expect(fingerprintOf(plan({ probedVersionId: "version-other" }))).not.toBe(base);
    expect(
      profileRenderControlsFingerprintJson(plan(), {
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
    expect(fingerprintOf(plan({ label: "Renamed", sort: 99 }, { label: "Renamed too", sort: 42 }))).toBe(
      fingerprintOf(plan()),
    );
  });
});

describe("stableJson", () => {
  it("sorts keys recursively so two spellings of one object fingerprint alike", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("preserves array order, which is meaningful", () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });

  it("drops undefined members and renders null honestly", () => {
    expect(stableJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});
