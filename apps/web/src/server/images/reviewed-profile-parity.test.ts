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
} from "@vesper/image-core";
import { buildRegistryModelInput, overlayControlInput } from "@vesper/image-replicate";
import { describe, expect, it } from "vitest";

/**
 * THE reviewed settings, held against the FINAL provider payload — the one
 * statement worth making about them now that the task profile is their only
 * owner.
 *
 * The defect this file exists to kill: a reviewed correction that stops
 * arriving. Until #244 the settings reached the provider twice over — as a
 * slug-keyed rewrite of the model row's `extraInput` at the render boundary, and
 * as the profile's own controls — so a profile that carried none of them still
 * rendered correctly, and nothing could tell the two apart. With the rewrite
 * gone the profile is load-bearing on its own, and the only way to know a
 * reviewed value still ships is to read it out of the assembled payload.
 *
 * Anything short of the payload proves nothing: the controls travel as
 * `controlInput`, which `overlayControlInput` writes LAST, while the row's own
 * constants are written FIRST by `buildRegistryModelInput`. Same values,
 * opposite ends of the precedence order.
 */

/**
 * The four reviewed models' REAL probed bindings, read from the production
 * registry through the admin API on 2026-09-13.
 *
 * Hand-written rather than synthesized from the reviewed table's own
 * `controlFields`, which is the point: a probe derived from the table would
 * agree with whatever the table said, and the question here is whether the
 * reviewed settings survive the trip on the versions production actually runs.
 * `coversEveryReviewedControl` below refuses a fixture that has fallen behind
 * the policy it is supposed to carry.
 */
/** A type alias, not an interface: it is handed to `imageModelSchema.parse`. */
type ProbedFixture = {
  controls: Record<string, { field: string; type: string }>;
  knownInputFields: string[];
};

const PRODUCTION_BINDINGS: Record<string, ProbedFixture> = {
  "qwen/qwen-image-edit-2511": {
    controls: {
      seed: { field: "seed", type: "integer" },
      fastMode: { field: "go_fast", type: "boolean" },
      loraWeights: { field: "lora_weights", type: "string" },
      loraScale: { field: "lora_scale", type: "number" },
    },
    knownInputFields: ["go_fast", "image", "lora_scale", "lora_weights", "output_quality", "prompt", "seed"],
  },
  "aisha-ai-official/nsfw-flux-dev": {
    controls: {
      seed: { field: "seed", type: "integer" },
      customWidth: { field: "width", type: "integer" },
      customHeight: { field: "height", type: "integer" },
    },
    knownInputFields: ["guidance_scale", "height", "prompt", "seed", "steps", "width"],
  },
  "aisha-ai-official/likereality-pony-v1": {
    controls: {
      seed: { field: "seed", type: "integer" },
      negativePrompt: { field: "negative_prompt", type: "string" },
      customWidth: { field: "width", type: "integer" },
      customHeight: { field: "height", type: "integer" },
    },
    knownInputFields: ["height", "negative_prompt", "prompt", "seed", "width"],
  },
  "nsfw-api/sdxl-pulid": {
    controls: {
      seed: { field: "seed", type: "integer" },
      guidance: { field: "cfg", type: "number" },
      negativePrompt: { field: "negative_prompt", type: "string" },
      customWidth: { field: "width", type: "integer" },
      customHeight: { field: "height", type: "integer" },
    },
    knownInputFields: ["cfg", "face_weight", "height", "method", "negative_prompt", "prompt", "seed", "width"],
  },
};

function model(slug: string, advancedCapabilities: Record<string, unknown>, extraInput: Record<string, unknown> = {}) {
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

/** The reviewed model as production has it: its own probed bindings. */
function reviewedModel(slug: string, extraInput: Record<string, unknown> = {}): ImageModel {
  return model(slug, PRODUCTION_BINDINGS[slug] ?? {}, extraInput);
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

/** The profile a reviewed model's rows carry (migrations 0110/0122, and creation). */
function reviewedProfile(slug: string): ImageModelProfile {
  const controls = reviewedImageProfileControls(slug);
  return profile({ ...controls?.controlDefaults }, { ...controls?.providerOverrides });
}

/** The exact provider payload one configuration produces. */
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

/** Every provider field/value the reviewed policy for `slug` must produce. */
function reviewedPayloadValues(slug: string): Map<string, unknown> {
  const policy = reviewedImageQualityPolicy(slug);
  if (!policy) throw new Error(`${slug} has no reviewed policy`);
  const values = new Map<string, unknown>(Object.entries(policy.providerOverrides));
  const defaults = new Map<string, unknown>(Object.entries(policy.controlDefaults));
  for (const [control, field] of Object.entries(policy.controlFields)) {
    if (field === undefined) continue;
    values.set(field, defaults.get(control));
  }
  return values;
}

describe("the reviewed settings a task profile carries, on the final payload", () => {
  it("has a production binding fixture for exactly the reviewed set", () => {
    expect(Object.keys(PRODUCTION_BINDINGS).sort()).toEqual([...reviewedImageQualitySlugs].sort());
  });

  for (const slug of reviewedImageQualitySlugs) {
    const policy = reviewedImageQualityPolicy(slug);
    if (!policy) continue;

    it(`probes every reviewed control of ${slug} in the fixture`, () => {
      // A fixture missing a binding would make the payload assertion below pass
      // for a value that never went: the control would drop for want of a field
      // on a version that has one.
      const fixture = PRODUCTION_BINDINGS[slug];
      expect(fixture, slug).toBeDefined();
      if (!fixture) return;
      const bound = Object.values(fixture.controls).map((binding) => binding.field);
      for (const field of reviewedImageQualityControlFields(policy)) {
        expect(bound, `${slug}.${field}`).toContain(field);
      }
      for (const field of Object.keys(policy.providerOverrides)) {
        expect(fixture.knownInputFields, `${slug}.${field}`).toContain(field);
      }
    });

    it(`carries every reviewed value into the payload for ${slug}`, () => {
      const sent = payload(reviewedModel(slug), reviewedProfile(slug));
      for (const [field, value] of reviewedPayloadValues(slug)) {
        expect(sent[field], `${slug}.${field}`).toEqual(value);
      }
    });

    it(`sends no reviewed value for ${slug} when the profile carries none`, () => {
      // The retired overlay's whole behavior, asserted absent: a slug-keyed
      // rewrite of `extraInput` would put these values on the payload of an
      // inert profile, and the profile would have stopped being load-bearing
      // without anything failing.
      const sent = payload(reviewedModel(slug), profile({}, {}));
      for (const field of reviewedPayloadValues(slug).keys()) {
        expect(Object.keys(sent), `${slug}.${field}`).not.toContain(field);
      }
    });
  }

  it("lets a stale probe default lose to the reviewed value", () => {
    // Qwen Edit's stored row still says `go_fast: true` — the registry's probe
    // reads the provider's own default. The profile's override is written after
    // the row's constants, so the provider is told false.
    const slug = "qwen/qwen-image-edit-2511";
    const sent = payload(reviewedModel(slug, { go_fast: true, output_quality: 95 }), reviewedProfile(slug));
    expect(sent.go_fast).toBe(false);
    expect(sent.output_quality).toBe(95);
  });
});

describe("a reviewed model whose version is not probed", () => {
  const slug = "aisha-ai-official/likereality-pony-v1";

  it("drops every profile-borne reviewed control, with a reason for each", () => {
    // With `advanced_capabilities = '{}'` the mapper has no field to write to,
    // so the reviewed settings reach nothing — and every one of them is named in
    // `droppedControls`, which is what a run's own record and its fingerprint
    // carry. Silence here is the failure mode; a recorded drop is not.
    const compiled = compileProfileRenderPlan({
      model: model(slug, {}),
      profile: reviewedProfile(slug),
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

  it("fails an override closed rather than forwarding an unprobed key", () => {
    const compiled = compileProfileRenderPlan({
      model: model("nsfw-api/sdxl-pulid", {}),
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
