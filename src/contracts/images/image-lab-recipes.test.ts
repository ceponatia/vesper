import { describe, expect, it } from "vitest";
import { imageLabControlKinds } from "./image-lab";
import {
  IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX,
  imageLabControlledKinds,
  imageLabRecipeKey,
  imageLabRecipeProfile,
  imageLabRecipeTask,
  isImageLabControlledKind,
} from "./image-lab-recipes";
import { imageModelProfileSchema, profileEligibility } from "./image-model-profiles";
import { imageModelSchema, type ImageModel } from "./image-models";

/**
 * The controlled recipes as data: their identity, their policies, and the fact
 * that a recipe IS a valid profile row in every way but storage — the runner
 * hands one straight to `profileEligibility` and the compile step, so a recipe
 * the profile schema would refuse is a recipe production code cannot run.
 */

// The shape of the model the recipes were written for: an instruction editor
// with a usable identity rating and a three-slot reference array.
const qwen2511 = (overrides: Partial<ImageModel> = {}): ImageModel =>
  imageModelSchema.parse({
    id: "imgmdlqwenedit2511aaaaaa",
    slug: "qwen/qwen-image-edit-2511",
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "moderate",
    maxReferences: 3,
    ...overrides,
  });

describe("imageLabControlledKinds", () => {
  it("recognizes exactly the two recipe kinds", () => {
    for (const kind of imageLabControlledKinds) {
      expect(isImageLabControlledKind(kind)).toBe(true);
    }
    expect(isImageLabControlledKind("control_probe")).toBe(false);
    expect(isImageLabControlledKind("baseline_portrait")).toBe(false);
    expect(isImageLabControlledKind("finishing_pass")).toBe(false);
  });
});

describe("imageLabRecipeKey", () => {
  it("joins the kind and the control into the recipe's one stable name", () => {
    expect(imageLabRecipeKey("controlled_portrait", "pose")).toBe("controlled_portrait/pose");
    expect(imageLabRecipeKey("controlled_scene", "depth")).toBe("controlled_scene/depth");
  });
});

describe("imageLabRecipeTask", () => {
  it("maps each kind onto the identity-critical task whose screening it needs", () => {
    // The task is what makes `profileEligibility` refuse a weak-identity or
    // img2img model — the same protection the variant and scene lanes get.
    expect(imageLabRecipeTask("controlled_portrait")).toBe("variant");
    expect(imageLabRecipeTask("controlled_scene")).toBe("scene");
  });
});

describe("imageLabRecipeProfile", () => {
  it("names itself under the recipe id prefix, keyed by the recipe key", () => {
    const profile = imageLabRecipeProfile("controlled_portrait", "pose", "mdl_x");
    expect(profile.id).toBe("image-lab/controlled_portrait/pose");
    expect(profile.id.startsWith(IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX)).toBe(true);
    expect(profile.key).toBe("controlled_portrait/pose");
    expect(profile.imageModelId).toBe("mdl_x");
    expect(profile.label).toBe("Controlled portrait — pose skeleton");
  });

  it("requires identity plus the declared control, whichever control it is", () => {
    for (const controlKind of imageLabControlKinds) {
      const profile = imageLabRecipeProfile("controlled_portrait", controlKind, "mdl_x");
      expect(profile.referencePolicy.requiredRoles).toEqual(["identity", controlKind]);
    }
  });

  it("shapes the portrait policy around one subject: outfit, style, object after the control", () => {
    const policy = imageLabRecipeProfile("controlled_portrait", "pose", "mdl_x").referencePolicy;
    expect(policy.allowedRoles).toEqual(["identity", "pose", "outfit", "style", "object"]);
    expect(policy.roleOrder).toEqual(["identity", "pose", "outfit", "style", "object"]);
    expect(policy.maxPerRole).toEqual({ identity: 1, pose: 1, outfit: 1, style: 1, object: 1 });
  });

  it("shapes the scene policy around a placed subject: location joins, object yields", () => {
    const policy = imageLabRecipeProfile("controlled_scene", "depth", "mdl_x").referencePolicy;
    expect(policy.allowedRoles).toEqual(["identity", "depth", "location", "outfit", "style"]);
    expect(policy.roleOrder).toEqual(["identity", "depth", "location", "outfit", "style"]);
    expect(policy.maxPerRole).toEqual({ identity: 1, depth: 1, location: 1, outfit: 1, style: 1 });
  });

  it("declares the compose strategy on the edit operation with inert knobs", () => {
    const profile = imageLabRecipeProfile("controlled_scene", "edge", "mdl_x");
    expect(profile.operation).toBe("edit");
    expect(profile.promptStrategy).toBe("multi_reference_compose");
    expect(profile.controlDefaults).toEqual({ seedPolicy: "random" });
    expect(profile.providerOverrides).toEqual({});
    expect(profile.timeoutMs).toBeNull();
    expect(profile.isDefault).toBe(false);
    expect(profile.builtin).toBe(false);
  });

  it("is a valid profile row in every way but storage", () => {
    // The runner hands a recipe to the same eligibility and compile code a
    // stored row reaches; a shape the row schema would refuse is a recipe
    // nothing can run.
    for (const kind of imageLabControlledKinds) {
      for (const controlKind of imageLabControlKinds) {
        const profile = imageLabRecipeProfile(kind, controlKind, "mdl_x");
        expect(imageModelProfileSchema.parse(profile)).toEqual(profile);
      }
    }
  });

  it("passes eligibility on the model the recipes were written for", () => {
    const model = qwen2511();
    expect(profileEligibility(imageLabRecipeProfile("controlled_portrait", "pose", model.id), model)).toEqual({
      ok: true,
    });
    expect(profileEligibility(imageLabRecipeProfile("controlled_scene", "depth", model.id), model)).toEqual({
      ok: true,
    });
  });

  it("refuses a model that would render a stranger, because the task is identity-critical", () => {
    const profile = imageLabRecipeProfile("controlled_portrait", "pose", "mdl_x");
    expect(profileEligibility(profile, qwen2511({ editKind: "img2img" }))).toEqual({
      ok: false,
      reason: "img2img_identity_task",
    });
    expect(profileEligibility(profile, qwen2511({ identityPreservation: "weak" }))).toEqual({
      ok: false,
      reason: "identity_too_weak",
    });
  });
});
