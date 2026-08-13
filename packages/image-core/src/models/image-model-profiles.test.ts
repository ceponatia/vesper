import { describe, expect, it } from "vitest";
import {
  emptyImageReferencePolicy,
  imageControlDefaultsSchema,
  imageModelProfileListSchema,
  imageModelProfileSchema,
  imageProfileCandidates,
  imageProfileOffered,
  imageReferencePolicySchema,
  isImageIdentityCriticalTask,
  legacySurfaceForImageTask,
  profileEligibility,
  resolveImageProfile,
  type ImageModelProfile,
} from "./image-model-profiles";
import { imageModelSchema, type ImageModel } from "./image-models";

// Both factories go through their own parser: every field past the identity ones
// is defaulted, so a short literal exercises the defaults a stored row relies on
// instead of restating them.
const model = (overrides: Partial<ImageModel> = {}): ImageModel =>
  imageModelSchema.parse({
    id: "mdl",
    slug: "vendor/model",
    label: "Model",
    canGenerate: true,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
    forPortrait: true,
    forVariant: true,
    forScene: true,
    ...overrides,
  });

const profile = (overrides: Partial<ImageModelProfile> = {}): ImageModelProfile =>
  imageModelProfileSchema.parse({
    id: "prf",
    imageModelId: "mdl",
    key: "scene-standard",
    label: "Scene Standard",
    task: "scene",
    operation: "edit",
    promptStrategy: "instruction_edit",
    ...overrides,
  });

describe("imageModelProfileSchema", () => {
  it("parses a seeded row whose jsonb columns are empty objects", () => {
    // All 17 seeded profiles store `'{}'::jsonb` for policy, defaults and
    // overrides, so `{}` must mean "inert", not "invalid".
    const parsed = imageModelProfileSchema.parse({
      id: "imgprf2511sceneaaaaaaaaa",
      imageModelId: "imgmdlqwenedit2511aaaaaa",
      key: "scene-standard",
      label: "Scene Standard",
      task: "scene",
      operation: "edit",
      promptStrategy: "instruction_edit",
      referencePolicy: {},
      controlDefaults: {},
      providerOverrides: {},
      timeoutMs: null,
    });
    expect(parsed.referencePolicy).toEqual(emptyImageReferencePolicy());
    expect(parsed.controlDefaults).toEqual({ seedPolicy: "random" });
    expect(parsed.enabled).toBe(true);
    expect(parsed.builtin).toBe(false);
    expect(parsed.isDefault).toBe(false);
    expect(parsed.sort).toBe(0);
  });

  it("defaults a reference policy to inert rather than to a required identity", () => {
    // A row that predates a later column, and the reason the default is empty: the
    // scene ladder's generate rung runs with zero references today, so a policy
    // that required identity by default would fail that render outright.
    const parsed = profile();
    expect(parsed.referencePolicy.requiredRoles).toEqual([]);
    expect(parsed.referencePolicy.allowedRoles).toEqual([]);
    expect(parsed.providerOverrides).toEqual({});
    expect(parsed.timeoutMs).toBeNull();
  });

  it("keeps a per-role cap partial, so an allowed role without a cap is not capped at zero", () => {
    // Through the policy schema so the fixture stays a STORED shape — one that
    // predates `identityStrategy` and relies on its default.
    const parsed = profile({
      referencePolicy: imageReferencePolicySchema.parse({
        allowedRoles: ["identity", "location", "style"],
        requiredRoles: ["identity"],
        roleOrder: ["identity", "location", "style"],
        maxPerRole: { location: 1 },
      }),
    });
    expect(parsed.referencePolicy.maxPerRole).toEqual({ location: 1 });
    expect(parsed.referencePolicy.maxPerRole?.style).toBeUndefined();
  });

  it("defaults every stored policy's identity strategy to canonical-only (5B)", () => {
    // All seeded rows predate the field: `{}` and the identity-critical shapes
    // written by migration 0100 both carry no `identityStrategy` key, and both
    // must keep sending exactly the single canonical reference they send today.
    expect(imageReferencePolicySchema.parse({}).identityStrategy).toBe("canonical_only");
    expect(
      imageReferencePolicySchema.parse({
        allowedRoles: ["identity", "style"],
        requiredRoles: ["identity"],
        roleOrder: ["identity", "style"],
      }).identityStrategy,
    ).toBe("canonical_only");
    // A declared strategy round-trips; an unknown one refuses the row rather
    // than degrading to a strategy nobody reviewed.
    expect(
      imageReferencePolicySchema.parse({ identityStrategy: "canonical_then_face_detail" }).identityStrategy,
    ).toBe("canonical_then_face_detail");
    expect(imageReferencePolicySchema.safeParse({ identityStrategy: "both_faces" }).success).toBe(false);
  });

  it("refuses a timeout outside the table's 30s-to-15min bounds", () => {
    expect(imageModelProfileSchema.safeParse({ ...profile(), timeoutMs: 5_000 }).success).toBe(false);
    expect(imageModelProfileSchema.safeParse({ ...profile(), timeoutMs: 1_800_000 }).success).toBe(false);
    expect(imageModelProfileSchema.safeParse({ ...profile(), timeoutMs: 120_000 }).success).toBe(true);
  });

  it("refuses a task or strategy outside the registered vocabularies", () => {
    expect(imageModelProfileSchema.safeParse({ ...profile(), task: "banner" }).success).toBe(false);
    expect(imageModelProfileSchema.safeParse({ ...profile(), promptStrategy: "freeform" }).success).toBe(false);
  });
});

describe("imageControlDefaultsSchema", () => {
  it("drops a stored numeric seed and states a policy instead", () => {
    // A seed stored as a permanent default is a pin, not a default: every render
    // from the profile would reproduce one composition.
    expect(imageControlDefaultsSchema.parse({ seed: 42, guidance: 4 })).toEqual({ seedPolicy: "random", guidance: 4 });
  });

  it("defaults to the random policy, which is what sending no seed key already does", () => {
    expect(imageControlDefaultsSchema.parse({}).seedPolicy).toBe("random");
    expect(imageControlDefaultsSchema.parse({ seedPolicy: "reuse_source" }).seedPolicy).toBe("reuse_source");
  });

  it("rejects an edit strength outside the 0-1 scale every seeded model uses", () => {
    expect(imageControlDefaultsSchema.safeParse({ editStrength: 1.4 }).success).toBe(false);
  });
});

describe("imageModelProfileListSchema", () => {
  it("parses a well-formed list through untouched", () => {
    expect(imageModelProfileListSchema.parse([profile({ id: "a" }), profile({ id: "b" })]).map((p) => p.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("degrades a malformed payload to an empty list instead of throwing at the boundary", () => {
    // The list schema is all-or-nothing, which is why the server loader parses row
    // by row with `image_profile.row_invalid` and keeps the good rows. This catch is
    // the last resort for a payload that is not a profile list at all.
    expect(imageModelProfileListSchema.parse([{ id: "prf" }])).toEqual([]);
    expect(imageModelProfileListSchema.parse("not a list")).toEqual([]);
    expect(imageModelProfileListSchema.parse(null)).toEqual([]);
  });
});

describe("isImageIdentityCriticalTask", () => {
  it("names the tasks that must show one specific person again", () => {
    expect(isImageIdentityCriticalTask("variant")).toBe(true);
    expect(isImageIdentityCriticalTask("scene")).toBe(true);
    expect(isImageIdentityCriticalTask("chat_look")).toBe(true);
    // A portrait CREATES the reference the others preserve, so it has no identity
    // to lose yet; items and rooms have none at all.
    expect(isImageIdentityCriticalTask("portrait")).toBe(false);
    expect(isImageIdentityCriticalTask("item")).toBe(false);
  });
});

describe("legacySurfaceForImageTask", () => {
  it("maps only the three tasks that had a model toggle", () => {
    expect(legacySurfaceForImageTask("portrait")).toBe("portrait");
    expect(legacySurfaceForImageTask("variant")).toBe("variant");
    expect(legacySurfaceForImageTask("scene")).toBe("scene");
    expect(legacySurfaceForImageTask("chat_look")).toBeNull();
    expect(legacySurfaceForImageTask("image_set")).toBeNull();
  });
});

describe("profileEligibility", () => {
  const generate = profile({ task: "portrait", operation: "generate", promptStrategy: "text_to_image_description" });

  it("allows a generate profile only on a model that can run without a reference", () => {
    expect(profileEligibility(generate, model())).toEqual({ ok: true });
    expect(profileEligibility(generate, model({ canGenerate: false }))).toEqual({
      ok: false,
      reason: "operation_unsupported",
    });
  });

  it("refuses an edit profile on a model with no image input", () => {
    expect(profileEligibility(profile(), model({ canEdit: false }))).toEqual({
      ok: false,
      reason: "operation_unsupported",
    });
  });

  it("refuses an edit profile on a model reviewed as not an editor", () => {
    // The mechanical flag says there is an image input; the reviewed kind says it
    // does not amount to editing.
    expect(profileEligibility(profile(), model({ editKind: "none" }))).toEqual({
      ok: false,
      reason: "edit_kind_none",
    });
  });

  it("keeps a weak-identity model out of identity-critical tasks but not out of portraits", () => {
    const weak = model({ identityPreservation: "weak", editKind: "multi_reference_compose" });
    expect(profileEligibility(profile({ task: "scene" }), weak)).toEqual({ ok: false, reason: "identity_too_weak" });
    expect(profileEligibility(profile({ task: "chat_look" }), weak)).toEqual({ ok: false, reason: "identity_too_weak" });
    expect(profileEligibility(generate, weak)).toEqual({ ok: true });
  });

  it("treats an img2img model as a remix tool rather than a scene default", () => {
    // Strength repainting can hand back a different person even when the rating is
    // not outright weak, so the mechanism is screened separately.
    const remix = model({ editKind: "img2img", identityPreservation: "moderate" });
    expect(profileEligibility(profile({ task: "variant" }), remix)).toEqual({
      ok: false,
      reason: "img2img_identity_task",
    });
    // Still usable for a deliberate non-identity edit.
    expect(profileEligibility(profile({ task: "text_repair", promptStrategy: "text_repair" }), remix)).toEqual({
      ok: true,
    });
  });

  it("stays permissive while a model is unreviewed", () => {
    // An operator-added row rates `unknown` on both axes and must keep working
    // exactly as it does today; ratings gate, missing ratings do not.
    const unreviewed = model({ editKind: "unknown", identityPreservation: "unknown" });
    expect(profileEligibility(profile({ task: "scene" }), unreviewed)).toEqual({ ok: true });
    expect(profileEligibility(generate, unreviewed)).toEqual({ ok: true });
  });
});

// One task's worth of fixtures shared by the join and the resolver: a strong
// instruction editor carrying the global default, a moderate composer with two
// profiles and no default of its own, and a weak img2img row that is ticked for
// scenes but must never be offered for one.
const editModel = model({ id: "mdl-edit", slug: "qwen/qwen-image-edit-2511", canGenerate: false, forPortrait: false });
const composeModel = model({
  id: "mdl-compose",
  slug: "bytedance/seedream-4.5",
  editKind: "multi_reference_compose",
  identityPreservation: "moderate",
});
const remixModel = model({
  id: "mdl-remix",
  slug: "stability-ai/stable-diffusion-3.5-large",
  editKind: "img2img",
  identityPreservation: "weak",
});
const allModels = [editModel, composeModel, remixModel];

const sceneDefault = profile({ id: "prf-scene-edit", imageModelId: "mdl-edit", isDefault: true, sort: 22 });
const sceneCompose = profile({ id: "prf-scene-compose", imageModelId: "mdl-compose", sort: 32 });
const sceneCompose4k = profile({ id: "prf-scene-compose-4k", key: "scene-4k", imageModelId: "mdl-compose", sort: 33 });
const sceneRemix = profile({ id: "prf-scene-remix", imageModelId: "mdl-remix", sort: 50 });
// Deliberately not in sort order — the join is what imposes it.
const allProfiles = [sceneRemix, sceneCompose4k, sceneCompose, sceneDefault];

describe("imageProfileOffered", () => {
  it("names the switch, the legacy surface, and the structural gate separately", () => {
    expect(imageProfileOffered(sceneDefault, editModel)).toEqual({ ok: true });
    expect(imageProfileOffered(profile({ ...sceneDefault, enabled: false }), editModel)).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(imageProfileOffered(sceneCompose, model({ ...composeModel, forScene: false }))).toEqual({
      ok: false,
      reason: "legacy_surface_excluded",
    });
    // The structural half is `profileEligibility`'s verdict, passed through
    // verbatim — the trial planner reads the reason, not just the boolean.
    expect(imageProfileOffered(sceneRemix, remixModel)).toEqual({ ok: false, reason: "identity_too_weak" });
  });

  it("is the SAME judgment the candidate join applies, once the join's own task filter is accounted for", () => {
    // Trial eligibility must be unable to drift from production eligibility, so
    // every profile the join keeps is one this predicate offers, and vice versa.
    //
    // The equivalence is only over ONE task, and that has to be spelled out
    // rather than relied on: `imageProfileCandidates` additionally filters by
    // task, which `imageProfileOffered` does not judge at all. With every fixture
    // sharing a task the two agreed by accident, and the case would have kept
    // passing if offerability had silently started answering a task question.
    const sceneProfiles = allProfiles.filter((candidate) => candidate.task === "scene");
    const offeredHere = sceneProfiles.filter((candidate) => {
      const owner = allModels.find((m) => m.id === candidate.imageModelId);
      return owner !== undefined && imageProfileOffered(candidate, owner).ok;
    });
    const joined = imageProfileCandidates(allProfiles, allModels, "scene");
    expect(new Set(offeredHere.map((p) => p.id))).toEqual(new Set(joined.map((c) => c.profile.id)));
  });

  it("offers a profile for ANOTHER task, which only the join's task filter excludes", () => {
    // The other half of the same fact, and the reason the filter above is
    // explicit: this profile is perfectly offerable — its model is fine, its
    // ratings are fine — and it is absent from a scene join purely because it
    // answers a different job. An assertion that read its absence as
    // "unofferable" would be reading the wrong gate.
    const variantProfile = profile({
      id: "prf-variant-edit",
      imageModelId: "mdl-edit",
      key: "variant-standard",
      task: "variant",
    });
    expect(imageProfileOffered(variantProfile, editModel)).toEqual({ ok: true });
    const joined = imageProfileCandidates([...allProfiles, variantProfile], allModels, "scene");
    expect(joined.map((candidate) => candidate.profile.id)).not.toContain("prf-variant-edit");
    // And it IS offered for its own task, so nothing about it is disabled.
    expect(imageProfileCandidates([variantProfile], allModels, "variant").map((c) => c.profile.id)).toEqual([
      "prf-variant-edit",
    ]);
  });
});

describe("imageProfileCandidates", () => {
  it("joins each profile to its model and returns them in sort order", () => {
    const candidates = imageProfileCandidates(allProfiles, allModels, "scene");
    expect(candidates.map((candidate) => candidate.profile.id)).toEqual([
      "prf-scene-edit",
      "prf-scene-compose",
      "prf-scene-compose-4k",
    ]);
    expect(candidates[0]?.model.slug).toBe("qwen/qwen-image-edit-2511");
  });

  it("drops a profile whose model row is not in the list", () => {
    // A row the owner deleted, or one `imageModelListSchema` dropped as unparseable:
    // either way the profile cannot be rendered, so it is never offered.
    const candidates = imageProfileCandidates(allProfiles, [editModel], "scene");
    expect(candidates.map((candidate) => candidate.profile.id)).toEqual(["prf-scene-edit"]);
  });

  it("drops a profile whose model was unticked for the task's legacy surface", () => {
    // Both selection systems coexist during migration: an operator who unticked
    // this model for scenes expects it gone, and a seeded profile must not put it
    // back.
    const untickedForScenes = model({ ...composeModel, forScene: false });
    const candidates = imageProfileCandidates(allProfiles, [editModel, untickedForScenes], "scene");
    expect(candidates.map((candidate) => candidate.profile.id)).toEqual(["prf-scene-edit"]);
  });

  it("offers an anchor task's profiles without consulting any legacy toggle", () => {
    // `item` never had a surface toggle, so an untoggled model still serves it.
    const untoggled = model({ id: "mdl-item", forPortrait: false, forVariant: false, forScene: false });
    const itemProfile = profile({
      id: "prf-item",
      imageModelId: "mdl-item",
      key: "item-standard",
      task: "item",
      operation: "generate",
      promptStrategy: "text_to_image_description",
    });
    expect(imageProfileCandidates([itemProfile], [untoggled], "item").map((c) => c.profile.id)).toEqual(["prf-item"]);
  });

  it("drops a disabled profile", () => {
    const disabled = [profile({ ...sceneDefault, enabled: false }), sceneCompose];
    expect(imageProfileCandidates(disabled, allModels, "scene").map((c) => c.profile.id)).toEqual(["prf-scene-compose"]);
  });
});

describe("resolveImageProfile", () => {
  it("honours a stored profile id and hands back its model with it", () => {
    const resolved = resolveImageProfile(allProfiles, allModels, "scene", "prf-scene-compose");
    expect(resolved?.profile.id).toBe("prf-scene-compose");
    expect(resolved?.model.id).toBe("mdl-compose");
  });

  it("resolves a legacy stored model id or slug to that model's own profile", () => {
    // `sceneModel` used to hold a model id or a slug. Only one profile per task may
    // be the global default, so most models have none of their own — falling back to
    // the global default here would move a stored Seedream scene onto Qwen Edit.
    expect(resolveImageProfile(allProfiles, allModels, "scene", "mdl-compose")?.profile.id).toBe("prf-scene-compose");
    expect(resolveImageProfile(allProfiles, allModels, "scene", "bytedance/seedream-4.5")?.profile.id).toBe(
      "prf-scene-compose",
    );
  });

  it("falls back to the task's global default when nothing usable is stored", () => {
    expect(resolveImageProfile(allProfiles, allModels, "scene", null)?.profile.id).toBe("prf-scene-edit");
    expect(resolveImageProfile(allProfiles, allModels, "scene", undefined)?.profile.id).toBe("prf-scene-edit");
    // "reference" is a dead Venice-era key; old chats are not migrated.
    expect(resolveImageProfile(allProfiles, allModels, "scene", "reference")?.profile.id).toBe("prf-scene-edit");
  });

  it("degrades a stored pick whose model has since been rated too weak", () => {
    const resolved = resolveImageProfile(allProfiles, allModels, "scene", "prf-scene-remix");
    expect(resolved?.profile.id).toBe("prf-scene-edit");
    // The fallback and the reason it happened: the row is offered nowhere for an
    // identity-critical task.
    expect(profileEligibility(sceneRemix, remixModel)).toEqual({ ok: false, reason: "identity_too_weak" });
  });

  it("degrades a stored pick that has been disabled", () => {
    const profiles = [profile({ ...sceneCompose, enabled: false }), sceneDefault];
    expect(resolveImageProfile(profiles, allModels, "scene", "prf-scene-compose")?.profile.id).toBe("prf-scene-edit");
  });

  it("skips a stored model the legacy surface no longer offers", () => {
    const models = [editModel, model({ ...composeModel, forScene: false }), remixModel];
    expect(resolveImageProfile(allProfiles, models, "scene", "mdl-compose")?.profile.id).toBe("prf-scene-edit");
  });

  it("takes the first offered profile in sort order when no default is enabled", () => {
    const profiles = [sceneCompose4k, sceneCompose];
    expect(resolveImageProfile(profiles, allModels, "scene", null)?.profile.id).toBe("prf-scene-compose");
  });

  it("returns null when a task has nothing to offer", () => {
    // The caller reports `image_profile.none_offered`; there is no default to
    // invent, because a profile Vesper made up would render something nobody
    // configured.
    expect(resolveImageProfile(allProfiles, allModels, "text_repair", null)).toBeNull();
    expect(resolveImageProfile([], [], "scene", "prf-scene-edit")).toBeNull();
    expect(resolveImageProfile([sceneRemix], [remixModel], "scene", "prf-scene-remix")).toBeNull();
  });
});
