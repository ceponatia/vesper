import { describe, expect, it } from "vitest";
import { imageLabControlKinds, imageLabExperimentKinds } from "./image-lab";
import {
  IMAGE_LAB_FINISHING_IDENTITY_STRATEGY,
  IMAGE_LAB_FINISHING_LORA_ONLY_RECIPE_KEY,
  IMAGE_LAB_FINISHING_RECIPE_KEY,
  IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX,
  imageLabControlledKinds,
  imageLabFinishableKinds,
  imageLabFinishingRecipeKey,
  imageLabFinishingRecipeProfile,
  imageLabRecipeKey,
  imageLabRecipeProfile,
  imageLabRecipeTask,
  isImageLabControlledKind,
  isImageLabFinishableKind,
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

describe("imageLabFinishingRecipeProfile", () => {
  it("names itself under the recipe id prefix, keyed by its one stable key", () => {
    const profile = imageLabFinishingRecipeProfile("mdl_x", "identity");
    expect(profile.key).toBe(IMAGE_LAB_FINISHING_RECIPE_KEY);
    expect(profile.id).toBe(`${IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX}${IMAGE_LAB_FINISHING_RECIPE_KEY}`);
    expect(profile.imageModelId).toBe("mdl_x");
  });

  it("requires the base render and the identity reference, in that order", () => {
    const policy = imageLabFinishingRecipeProfile("mdl_x", "identity").referencePolicy;
    expect(policy.requiredRoles).toEqual(["before", "identity"]);
    expect(policy.allowedRoles).toEqual(["before", "identity"]);
    expect(policy.roleOrder).toEqual(["before", "identity"]);
  });

  it("sends no control map at all — the pass changes nothing structural", () => {
    const policy = imageLabFinishingRecipeProfile("mdl_x", "identity").referencePolicy;
    for (const role of ["pose", "depth", "edge", "control"] as const) {
      expect(policy.allowedRoles).not.toContain(role);
    }
  });

  it("leaves room for the pack's face crop while today's strategy sends one reference", () => {
    // The gap is deliberate headroom, not an oversight: the Stage 1/2 trial
    // watched every three-reference send collapse identity, so the third slot
    // stays unspent until an arm says otherwise.
    expect(IMAGE_LAB_FINISHING_IDENTITY_STRATEGY).toBe("canonical_only");
    expect(imageLabFinishingRecipeProfile("mdl_x", "identity").referencePolicy.maxPerRole).toEqual({ before: 1, identity: 2 });
  });

  it("screens as an identity task whatever the source rendered", () => {
    const profile = imageLabFinishingRecipeProfile("mdl_x", "identity");
    expect(profile.task).toBe("variant");
    expect(profile.operation).toBe("edit");
    expect(profile.promptStrategy).toBe("multi_reference_compose");
  });

  it("is a valid profile row in every way but storage", () => {
    const profile = imageLabFinishingRecipeProfile("mdl_x", "identity");
    expect(imageModelProfileSchema.parse(profile)).toEqual(profile);
  });

  it("passes eligibility on the plan's model and refuses one that would render a stranger", () => {
    const model = qwen2511();
    expect(profileEligibility(imageLabFinishingRecipeProfile(model.id, "identity"), model)).toEqual({ ok: true });
    expect(profileEligibility(imageLabFinishingRecipeProfile("mdl_x", "identity"), qwen2511({ identityPreservation: "weak" }))).toEqual({
      ok: false,
      reason: "identity_too_weak",
    });
  });
});

describe("imageLabFinishingRecipeProfile — the LoRA-only arm", () => {
  it("names itself under its own key, so a recorded outcome says which arm ran", () => {
    const profile = imageLabFinishingRecipeProfile("mdl_x", "lora_only");
    expect(profile.key).toBe(IMAGE_LAB_FINISHING_LORA_ONLY_RECIPE_KEY);
    expect(profile.id).toBe(`${IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX}${IMAGE_LAB_FINISHING_LORA_ONLY_RECIPE_KEY}`);
    // The two arms are two recipes, and a reader of the record must be able to
    // tell them apart — "this face improved" means different things in each.
    expect(profile.key).not.toBe(IMAGE_LAB_FINISHING_RECIPE_KEY);
    expect(imageLabFinishingRecipeKey("identity")).toBe(IMAGE_LAB_FINISHING_RECIPE_KEY);
    expect(imageLabFinishingRecipeKey("lora_only")).toBe(IMAGE_LAB_FINISHING_LORA_ONLY_RECIPE_KEY);
  });

  it("sends the base render and nothing else, and cannot be handed an identity reference", () => {
    const policy = imageLabFinishingRecipeProfile("mdl_x", "lora_only").referencePolicy;
    expect(policy.requiredRoles).toEqual(["before"]);
    expect(policy.roleOrder).toEqual(["before"]);
    expect(policy.maxPerRole).toEqual({ before: 1 });
    // ALLOWED, not merely unsent: the isolation is the measurement, so no caller
    // and no later edit can smuggle a pack reference into this arm.
    expect(policy.allowedRoles).toEqual(["before"]);
    expect(policy.allowedRoles).not.toContain("identity");
  });

  it("changes nothing but key, label and policy — everything a comparison holds fixed", () => {
    const identity = imageLabFinishingRecipeProfile("mdl_x", "identity");
    const loraOnly = imageLabFinishingRecipeProfile("mdl_x", "lora_only");
    // Same identity-critical screening, whatever the likeness arrives as.
    expect(loraOnly.task).toBe(identity.task);
    expect(loraOnly.operation).toBe(identity.operation);
    expect(loraOnly.promptStrategy).toBe(identity.promptStrategy);
    expect(loraOnly.controlDefaults).toEqual(identity.controlDefaults);
    expect(loraOnly.providerOverrides).toEqual(identity.providerOverrides);
    expect(loraOnly.timeoutMs).toBe(identity.timeoutMs);
    expect(loraOnly.label).not.toBe(identity.label);
  });

  it("is a valid profile row the eligibility gate still screens as identity-critical", () => {
    const profile = imageLabFinishingRecipeProfile("mdl_x", "lora_only");
    expect(imageModelProfileSchema.parse(profile)).toEqual(profile);
    const model = qwen2511();
    expect(profileEligibility(imageLabFinishingRecipeProfile(model.id, "lora_only"), model)).toEqual({ ok: true });
    expect(
      profileEligibility(imageLabFinishingRecipeProfile("mdl_x", "lora_only"), qwen2511({ identityPreservation: "weak" })),
    ).toEqual({ ok: false, reason: "identity_too_weak" });
  });
});

describe("imageLabFinishableKinds", () => {
  it("finishes the runs that produced a production-shaped render, and nothing else", () => {
    expect(imageLabFinishableKinds).toEqual([
      "baseline_portrait",
      "baseline_scene",
      "controlled_portrait",
      "controlled_scene",
    ]);
    for (const kind of imageLabExperimentKinds) {
      const refused = kind === "control_probe" || kind === "finishing_pass";
      expect(isImageLabFinishableKind(kind)).toBe(!refused);
    }
  });
});
