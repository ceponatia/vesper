import {
  compileProfileRenderPlan,
  type ImageModel,
  type ImageModelProfile,
  imageModelProfileSchema,
  imageModelSchema,
  reviewedImageProfileControls,
  reviewedImageQualityControlFields,
  reviewedImageQualityPolicy,
  reviewedImageQualitySlugs,
  type ReviewedImageQualityPolicy,
} from "@vesper/image-core";
import { buildRegistryModelInput, overlayControlInput } from "@vesper/image-replicate";
import { describe, expect, it } from "vitest";

/**
 * FINAL-PAYLOAD parity between the transitional exact-slug overlay and the task
 * profile that replaces it (image-render-quality.spec.md §"Migration off the
 * transitional policy", step 2).
 *
 * The migration's whole safety argument is that a reviewed setting reaches the
 * provider identically whichever layer supplies it, so a comparison of anything
 * short of the provider payload proves nothing: the two routes travel by
 * different merge levels — the overlay through `model.extraInput`, which
 * `buildRegistryModelInput` writes FIRST, and the profile through `controlInput`,
 * which `overlayControlInput` writes LAST. Same values, opposite ends of the
 * precedence order. Equal payloads is the only statement worth making.
 *
 * The three arms are the migration's three states:
 *
 * - `overlay` — today on an unmigrated model: the reviewed slug's `extraInput`,
 *   an inert profile.
 * - `profile` — after step 4 removes the override: an UNREVIEWED twin slug, so
 *   the overlay is a no-op, and a profile carrying the reviewed controls.
 * - `both` — today on a migrated model, which is what this slice ships: the
 *   overlay still applies and the profile now says the same thing.
 *
 * The twin-slug trick is what lets the middle arm exist before step 4 has run.
 * `compileProfileRenderPlan` always applies `withReviewedImageQuality`, so the
 * only way to observe the profile route alone is a model the reviewed table has
 * never heard of.
 */

/** A probed version that declares every field the reviewed policy needs. */
function probedCapabilities(policy: ReviewedImageQualityPolicy) {
  const fields = policy.controlFields;
  return {
    controls: {
      ...(fields.steps === undefined ? {} : { steps: { field: fields.steps, type: "integer" as const } }),
      ...(fields.guidance === undefined ? {} : { guidance: { field: fields.guidance, type: "number" as const } }),
      ...(fields.negativePrompt === undefined
        ? {}
        : { negativePrompt: { field: fields.negativePrompt, type: "string" as const } }),
      ...(fields.width === undefined ? {} : { customWidth: { field: fields.width, type: "integer" as const } }),
      ...(fields.height === undefined ? {} : { customHeight: { field: fields.height, type: "integer" as const } }),
    },
    // Provider overrides fail CLOSED against an empty list, so the raw keys the
    // reviewed policy uses have to be probed for the profile route to carry them.
    knownInputFields: Object.keys(policy.providerOverrides),
  };
}

function model(slug: string, advancedCapabilities: Record<string, unknown>, extraInput: Record<string, unknown>) {
  return imageModelSchema.parse({
    id: `model-${slug}`,
    slug,
    label: slug,
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    aspectMode: "aspect_ratio",
    supportedAspects: [],
    extraInput,
    advancedCapabilities,
  });
}

function profile(controlDefaults: Record<string, unknown>, providerOverrides: Record<string, unknown>) {
  return imageModelProfileSchema.parse({
    id: "profile-parity",
    imageModelId: "model-parity",
    key: "parity",
    label: "Parity",
    task: "portrait",
    operation: "generate",
    promptStrategy: "text_to_image_description",
    controlDefaults,
    providerOverrides,
  });
}

/** The exact provider payload one arm produces, references and shape held equal. */
function payload(subject: ImageModel, configuration: ImageModelProfile): Record<string, unknown> {
  const compiled = compileProfileRenderPlan({
    model: subject,
    profile: configuration,
    basePrompt: "a portrait of Mira",
    baseNegativePrompt: null,
    safetyCheckerDisabled: false,
    references: { vocabulary: "render_intent", references: [] },
  });
  if (!compiled.ok) throw new Error(`compile refused: ${compiled.reason}`);
  const built = buildRegistryModelInput(
    compiled.plan.effectiveModel,
    compiled.plan.finalPrompt,
    [],
    compiled.plan.aspectValue,
    false,
  );
  return overlayControlInput(built, compiled.plan.controlInput, compiled.plan.effectiveModel);
}

describe("reviewed overlay versus profile controls, on the final payload", () => {
  for (const slug of reviewedImageQualitySlugs) {
    const policy = reviewedImageQualityPolicy(slug);
    if (!policy) continue;
    const controls = reviewedImageProfileControls(slug);
    const capabilities = probedCapabilities(policy);
    // An unreviewed twin: same everything, a slug the reviewed table never matches.
    const twin = `parity-twin/${slug.split("/")[1] ?? slug}`;

    it(`sends the same payload either way for ${slug}`, () => {
      const overlayArm = payload(model(slug, capabilities, {}), profile({}, {}));
      const profileArm = payload(
        model(twin, capabilities, {}),
        profile({ ...controls?.controlDefaults }, { ...controls?.providerOverrides }),
      );
      expect(profileArm).toEqual(overlayArm);
    });

    it(`is unchanged when both layers are live for ${slug}`, () => {
      const overlayArm = payload(model(slug, capabilities, {}), profile({}, {}));
      const bothArm = payload(
        model(slug, capabilities, {}),
        profile({ ...controls?.controlDefaults }, { ...controls?.providerOverrides }),
      );
      expect(bothArm).toEqual(overlayArm);
    });

    it(`carries every reviewed value into the payload for ${slug}`, () => {
      // The parity assertions above would both pass if the reviewed settings
      // reached NEITHER arm. This one says the values are actually there.
      const sent = payload(
        model(twin, capabilities, {}),
        profile({ ...controls?.controlDefaults }, { ...controls?.providerOverrides }),
      );
      for (const [field, value] of Object.entries(policy.providerOverrides)) {
        expect(sent[field], `${slug}.${field}`).toEqual(value);
      }
      for (const field of reviewedImageQualityControlFields(policy)) {
        expect(Object.keys(sent), `${slug}.${field}`).toContain(field);
      }
    });
  }

  it("lets a stale probe default lose to the reviewed value on both routes", () => {
    // Qwen Edit's stored row says `go_fast: true`. Whichever layer corrects it,
    // the provider must be told false.
    const policy = reviewedImageQualityPolicy("qwen/qwen-image-edit-2511");
    expect(policy).not.toBeNull();
    if (!policy) return;
    const capabilities = probedCapabilities(policy);
    const stored = { go_fast: true };
    const overlayArm = payload(model("qwen/qwen-image-edit-2511", capabilities, stored), profile({}, {}));
    const profileArm = payload(
      model("parity-twin/qwen-image-edit-2511", capabilities, stored),
      profile({}, { go_fast: false }),
    );
    expect(overlayArm.go_fast).toBe(false);
    expect(profileArm.go_fast).toBe(false);
    expect(profileArm).toEqual(overlayArm);
  });
});

describe("an unprobed model, which is every seeded row today", () => {
  const slug = "aisha-ai-official/likereality-pony-v1";
  const controls = reviewedImageProfileControls(slug);

  it("drops every profile-borne reviewed control, with a reason for each", () => {
    // The degradation this slice cannot fix and step 4 therefore waits on: with
    // `advanced_capabilities = '{}'` the mapper has no field to write to and the
    // override validator fails closed, so the profile route contributes NOTHING.
    const compiled = compileProfileRenderPlan({
      model: model(`parity-twin/likereality-pony-v1`, {}, {}),
      profile: profile({ ...controls?.controlDefaults }, { ...controls?.providerOverrides }),
      basePrompt: "a portrait of Mira",
      baseNegativePrompt: null,
      safetyCheckerDisabled: false,
      references: { vocabulary: "render_intent", references: [] },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.plan.controlInput).toEqual({});
    const drops = compiled.plan.resolvedControls.droppedControls;
    expect(drops).toContainEqual({ control: "negativePrompt", reason: "no_binding" });
    expect(drops).toContainEqual({ control: "width", reason: "no_binding" });
    expect(drops).toContainEqual({ control: "height", reason: "no_binding" });
    expect(drops).toContainEqual({ control: "resolution", reason: "no_binding" });
  });

  it("still reaches the provider, because the overlay is still live", () => {
    // The reason the transitional policy must NOT be deleted yet: on the reviewed
    // slug the settings arrive through `extraInput` regardless of the probe.
    const sent = payload(model(slug, {}, {}), profile({ ...controls?.controlDefaults }, {}));
    expect(sent.width).toBe(832);
    expect(sent.height).toBe(1216);
    expect(sent.negative_prompt).toBe("");
  });

  it("fails an override closed rather than forwarding an unprobed key", () => {
    const compiled = compileProfileRenderPlan({
      model: model("parity-twin/sdxl-pulid", {}, {}),
      profile: profile({}, { method: "fidelity" }),
      basePrompt: "a portrait of Mira",
      baseNegativePrompt: null,
      safetyCheckerDisabled: false,
      references: { vocabulary: "render_intent", references: [] },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.plan.controlInput).toEqual({});
    expect(compiled.plan.resolvedControls.droppedControls).toContainEqual({
      control: "method",
      reason: "unknown_field",
    });
  });
});
