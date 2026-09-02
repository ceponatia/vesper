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
  imageLabStagedSceneRecipeKey,
  imageLabStagedSceneRecipeProfile,
  imageLabTwoCharacterRecipeKey,
  imageLabTwoCharacterRecipeProfile,
  isImageLabControlledKind,
  isImageLabFinishableKind,
} from "./image-lab-recipes";
import { imageModelProfileSchema, profileEligibility } from "../models/image-model-profiles";
import { imageModelSchema, type ImageModel } from "../models/image-models";

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

describe("imageLabTwoCharacterRecipeProfile", () => {
  it("keys each control arm apart, and spells the uncontrolled one out", () => {
    expect(imageLabTwoCharacterRecipeKey("pose")).toBe("two_character_scene/pose");
    expect(imageLabTwoCharacterRecipeKey("depth")).toBe("two_character_scene/depth");
    // Not a bare `two_character_scene`: every key this file mints has the same
    // shape, so a reader never wonders whether a suffix went missing.
    expect(imageLabTwoCharacterRecipeKey(null)).toBe("two_character_scene/none");
    // Two arms, two keys — "both identities held" means something different when
    // a skeleton was also in the send.
    expect(imageLabTwoCharacterRecipeKey(null)).not.toBe(imageLabTwoCharacterRecipeKey("pose"));
  });

  it("names itself under the recipe id prefix, labelled by its arm", () => {
    const controlled = imageLabTwoCharacterRecipeProfile("mdl_x", "pose");
    expect(controlled.id).toBe(`${IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX}two_character_scene/pose`);
    expect(controlled.key).toBe("two_character_scene/pose");
    expect(controlled.imageModelId).toBe("mdl_x");
    expect(controlled.label).toBe("Two-character scene — pose skeleton");

    const uncontrolled = imageLabTwoCharacterRecipeProfile("mdl_x", null);
    expect(uncontrolled.id).toBe(`${IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX}two_character_scene/none`);
    expect(uncontrolled.label).toBe("Two-character scene — uncontrolled");
  });

  it("requires BOTH identities and allows two of them — the only policy here that does", () => {
    // Required rather than trimmable is the plan's own two-character rule: a
    // dropped identity is not a thinner render, it is a different experiment.
    const policy = imageLabTwoCharacterRecipeProfile("mdl_x", "pose").referencePolicy;
    expect(policy.requiredRoles).toEqual(["identity", "pose"]);
    expect(policy.allowedRoles).toEqual(["identity", "pose"]);
    expect(policy.roleOrder).toEqual(["identity", "pose"]);
    expect(policy.maxPerRole).toEqual({ identity: 2, pose: 1 });
  });

  it("requires the two identities alone when no control is declared", () => {
    const policy = imageLabTwoCharacterRecipeProfile("mdl_x", null).referencePolicy;
    expect(policy.requiredRoles).toEqual(["identity"]);
    expect(policy.allowedRoles).toEqual(["identity"]);
    expect(policy.roleOrder).toEqual(["identity"]);
    expect(policy.maxPerRole).toEqual({ identity: 2 });
  });

  it("carries the declared control under its own role, whichever kind it is", () => {
    for (const controlKind of imageLabControlKinds) {
      const policy = imageLabTwoCharacterRecipeProfile("mdl_x", controlKind).referencePolicy;
      expect(policy.requiredRoles).toEqual(["identity", controlKind]);
      expect(policy.maxPerRole?.[controlKind]).toBe(1);
    }
  });

  it("allows no optional content role at all, because two identities plus a control IS the capacity", () => {
    // Every other recipe here offers content roles after its required ones. This
    // one deliberately does not: a fourth allowed role on a three-slot model
    // could only ever be dropped, and a policy slot the model cannot honour
    // invites a trial arm that spends an admin's time discovering it.
    for (const arm of [null, "pose"] as const) {
      const policy = imageLabTwoCharacterRecipeProfile("mdl_x", arm).referencePolicy;
      for (const role of ["location", "outfit", "style", "object", "before"] as const) {
        expect(policy.allowedRoles).not.toContain(role);
      }
    }
  });

  it("screens as a scene on the compose strategy with inert knobs", () => {
    const profile = imageLabTwoCharacterRecipeProfile("mdl_x", null);
    expect(profile.task).toBe("scene");
    expect(profile.operation).toBe("edit");
    // The compose strategy does more work in this recipe than in any other: it is
    // the only thing in the request saying which face belongs to which image.
    expect(profile.promptStrategy).toBe("multi_reference_compose");
    expect(profile.controlDefaults).toEqual({ seedPolicy: "random" });
    expect(profile.providerOverrides).toEqual({});
    expect(profile.timeoutMs).toBeNull();
    expect(profile.isDefault).toBe(false);
    expect(profile.builtin).toBe(false);
  });

  it("is a valid profile row in every way but storage, on both arms", () => {
    for (const arm of [null, ...imageLabControlKinds] as const) {
      const profile = imageLabTwoCharacterRecipeProfile("mdl_x", arm);
      expect(imageModelProfileSchema.parse(profile)).toEqual(profile);
    }
  });

  it("passes eligibility on the plan's model and refuses one that would render a stranger", () => {
    const model = qwen2511();
    expect(profileEligibility(imageLabTwoCharacterRecipeProfile(model.id, "pose"), model)).toEqual({ ok: true });
    expect(profileEligibility(imageLabTwoCharacterRecipeProfile(model.id, null), model)).toEqual({ ok: true });
    expect(
      profileEligibility(imageLabTwoCharacterRecipeProfile("mdl_x", null), qwen2511({ identityPreservation: "weak" })),
    ).toEqual({ ok: false, reason: "identity_too_weak" });
  });

  it("stays out of the controlled-kind list, whose recipes are indexed by a required control", () => {
    // `imageLabRecipeKey` takes a NON-NULL control kind. A kind whose control is
    // optional cannot be a member without making that signature a lie.
    expect(isImageLabControlledKind("two_character_scene")).toBe(false);
    expect(imageLabControlledKinds).not.toContain("two_character_scene");
    // Nor finishable: a finishing pass improves ONE face toward one pack, and
    // this render has two people in it.
    expect(isImageLabFinishableKind("two_character_scene")).toBe(false);
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
      // A probe is not production-shaped, a chain has no bottom, a two-character
      // render has two faces where the pass improves one, and finishing a staged
      // render would ask a stock model with no LoRA to redraw the anatomy the
      // whole intimate-scene work exists to get drawn.
      const refused =
        kind === "control_probe" ||
        kind === "finishing_pass" ||
        kind === "two_character_scene" ||
        kind === "staged_scene";
      expect(isImageLabFinishableKind(kind)).toBe(!refused);
    }
  });
});

describe("imageLabStagedSceneRecipeProfile", () => {
  it("keys itself per staging, because the staging IS the experiment", () => {
    expect(imageLabStagedSceneRecipeKey("astride_viewer_facing")).toBe("staged_scene/astride_viewer_facing");
    // Two acts are two geometries and two things a model can fail at; one shared
    // key would leave a month-old outcome unable to say which was asked for.
    expect(imageLabStagedSceneRecipeKey("bent_over_surface")).not.toBe(
      imageLabStagedSceneRecipeKey("astride_viewer_facing"),
    );
  });

  it("names itself under the recipe id prefix, labelled by the id the package can see", () => {
    const profile = imageLabStagedSceneRecipeProfile("mdl_x", "astride_viewer_facing");
    expect(profile.id).toBe(`${IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX}staged_scene/astride_viewer_facing`);
    expect(profile.key).toBe("staged_scene/astride_viewer_facing");
    expect(profile.imageModelId).toBe("mdl_x");
    // The raw id, not a sentence: the registry that knows this entry as prose is
    // app-side, so an id is the only fact this package holds about it.
    expect(profile.label).toBe("Staged scene — astride_viewer_facing");
  });

  it("requires the identity and nothing else, because the structure arrives as words", () => {
    const policy = imageLabStagedSceneRecipeProfile("mdl_x", "on_all_fours").referencePolicy;
    expect(policy.requiredRoles).toEqual(["identity"]);
    expect(policy.roleOrder).toEqual(["identity", "location"]);
    expect(policy.maxPerRole).toEqual({ identity: 1, location: 1 });
  });

  it("allows a location beside the face and refuses every other content role", () => {
    // Where the act happens is a scene fact an image says better than a phrase.
    // An outfit or a style reference would fight a staging that describes bare
    // regions and a specific geometry.
    const policy = imageLabStagedSceneRecipeProfile("mdl_x", "on_all_fours").referencePolicy;
    expect(policy.allowedRoles).toEqual(["identity", "location"]);
    for (const role of ["outfit", "style", "object", "before", "pose", "depth", "edge", "control"] as const) {
      expect(policy.allowedRoles).not.toContain(role);
    }
  });

  it("screens as a scene on the instruction strategy, and holds every knob where the other recipes do", () => {
    const profile = imageLabStagedSceneRecipeProfile("mdl_x", "lying_beneath_viewer");
    expect(profile.task).toBe("scene");
    // The base prompt is a compiled prompt program that already numbers its own
    // reference slots, so the recipe must pass it through untouched: the compose
    // strategy would prefix a second numbering over the same slot.
    expect(profile.promptStrategy).toBe("instruction_edit");
    // The rest is asserted AGAINST the two-character recipe rather than restated,
    // because "the same request shape every other lab recipe declares" is the
    // claim itself — a recipe fixes the shape and the experiment's own settings
    // overlay moves the numbers within it.
    const sibling = imageLabTwoCharacterRecipeProfile("mdl_x", null);
    expect(profile.operation).toBe(sibling.operation);
    expect(profile.controlDefaults).toEqual(sibling.controlDefaults);
    expect(profile.providerOverrides).toEqual(sibling.providerOverrides);
    expect(profile.timeoutMs).toBe(sibling.timeoutMs);
    expect(profile.enabled).toBe(sibling.enabled);
    expect(profile.isDefault).toBe(sibling.isDefault);
    expect(profile.builtin).toBe(sibling.builtin);
    expect(profile.sort).toBe(sibling.sort);
  });

  it("is a valid profile row in every way but storage", () => {
    const profile = imageLabStagedSceneRecipeProfile("mdl_x", "astride_viewer_facing");
    expect(imageModelProfileSchema.parse(profile)).toEqual(profile);
  });

  it("passes eligibility on an edit model and refuses one that would render a stranger", () => {
    const model = qwen2511();
    expect(profileEligibility(imageLabStagedSceneRecipeProfile(model.id, "astride_viewer_facing"), model)).toEqual({
      ok: true,
    });
    expect(
      profileEligibility(
        imageLabStagedSceneRecipeProfile("mdl_x", "astride_viewer_facing"),
        qwen2511({ identityPreservation: "weak" }),
      ),
    ).toEqual({ ok: false, reason: "identity_too_weak" });
  });

  it("stays out of the controlled-kind list, whose recipes are indexed by a required control", () => {
    // `imageLabRecipeKey` takes a NON-NULL control kind, and this kind declares
    // none at all — its structure is the staging's own wording.
    expect(isImageLabControlledKind("staged_scene")).toBe(false);
    expect(imageLabControlledKinds).not.toContain("staged_scene");
  });
});
