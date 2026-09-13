import { describe, expect, it } from "vitest";
import { imageModelSchema, type ImageModel } from "./image-models";
import {
  reviewedImageProfileControls,
  reviewedImageProfilePinnedFields,
  reviewedImageQualityControlFields,
  reviewedImageQualityPolicy,
  reviewedImageQualityPolicyDefects,
  reviewedImageQualitySlugs,
  withReviewedProfileDefaults,
  type ReviewedImageQualityPolicy,
} from "./reviewed-profile-controls";

/**
 * The policy rendered into the provider fields and values it is EXPECTED to
 * produce: the table's own `controlFields` mapping applied to its own control
 * values, then its raw overrides.
 *
 * Local to this file on purpose. Nothing in `src/` turns the reviewed policy
 * into a slug-keyed bag of raw provider fields any more — that was the
 * transitional overlay, and a copy of it living in production code would be the
 * same seam wearing a different name. Here it is fixture arithmetic, and its
 * only job is to be compared against the hand-written table below.
 */
function effectiveValues(policy: ReviewedImageQualityPolicy): Record<string, unknown> {
  const controls = policy.controlDefaults;
  const fields = policy.controlFields;
  const input: Record<string, unknown> = {};
  if (controls.steps !== undefined && fields.steps !== undefined) input[fields.steps] = controls.steps;
  if (controls.guidance !== undefined && fields.guidance !== undefined) input[fields.guidance] = controls.guidance;
  if (controls.negativePrompt !== undefined && fields.negativePrompt !== undefined) {
    input[fields.negativePrompt] = controls.negativePrompt;
  }
  if (controls.width !== undefined && fields.width !== undefined) input[fields.width] = controls.width;
  if (controls.height !== undefined && fields.height !== undefined) input[fields.height] = controls.height;
  return { ...input, ...policy.providerOverrides };
}

/** A model row, optionally carrying the probed bindings a reviewed control needs. */
function model(slug: string, advancedCapabilities: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: `model-${slug}`,
    slug,
    label: slug,
    canGenerate: true,
    canEdit: true,
    advancedCapabilities,
  });
}

/**
 * The reviewed effective values, per model, written out as literal provider
 * fields.
 *
 * Hand-written rather than derived from the code under test, which is the
 * whole point: this fixture is what stops the two representations from agreeing
 * with each other while both drifting away from the reviewed judgment.
 */
const SPEC_EFFECTIVE_VALUES: Record<string, Record<string, unknown>> = {
  "qwen/qwen-image-edit-2511": { go_fast: false },
  "aisha-ai-official/nsfw-flux-dev": { width: 832, height: 1216 },
  "aisha-ai-official/likereality-pony-v1": { width: 832, height: 1216, negative_prompt: "" },
  "nsfw-api/sdxl-pulid": { width: 832, height: 1216, method: "fidelity", cfg: 7, face_weight: 1 },
};

/**
 * Models the 2026-08-16 ruling dropped from the reviewed set. They keep their
 * catalog pages and an admin can still add them; what they must not have is a
 * reviewed correction, because nothing seeds a profile to reproduce it.
 */
const DEMOTED_SLUGS = [
  "lucataco/juggernaut-xl-v9",
  "nsfw-api/realvis-hyper-lora",
  "nsfw-api/pony-realism-v2.3",
];

describe("the reviewed policy in both vocabularies", () => {
  it("covers exactly the models the spec reviews", () => {
    expect([...reviewedImageQualitySlugs].sort()).toEqual(Object.keys(SPEC_EFFECTIVE_VALUES).sort());
  });

  it("states each reviewed setting as the exact provider value it must produce", () => {
    for (const [slug, expected] of Object.entries(SPEC_EFFECTIVE_VALUES)) {
      const policy = reviewedImageQualityPolicy(slug);
      expect(policy, slug).not.toBeNull();
      if (!policy) continue;
      expect(effectiveValues(policy), slug).toEqual(expected);
    }
  });

  it("accounts for the whole reviewed effect across the two profile channels", () => {
    for (const slug of reviewedImageQualitySlugs) {
      const policy = reviewedImageQualityPolicy(slug);
      expect(policy, slug).not.toBeNull();
      if (!policy) continue;
      expect([...reviewedImageQualityControlFields(policy), ...Object.keys(policy.providerOverrides)].sort(), slug).toEqual(
        Object.keys(SPEC_EFFECTIVE_VALUES[slug] ?? {}).sort(),
      );
    }
  });

  // The two shapes in which the one table can still say two different things,
  // each fed a real instance. The live table is held to both at module load, so
  // a contradictory row fails the import rather than a render; these cases prove
  // the check can actually fail, which the assertion it replaced could not —
  // it compared the mapped fields against the overrides after defining the
  // former as everything that was NOT an override.
  it("refuses a row whose default the overlay would never write", () => {
    // Live in the profile representation, invisible to the overlay, and cancelled
    // out by a parity probe synthesized from `controlFields` — the one-way drift
    // no fixture comparison can see.
    const unmapped: ReviewedImageQualityPolicy = {
      controlDefaults: { guidance: 7, resolution: "custom", width: 832, height: 1216 },
      providerOverrides: {},
      controlFields: { width: "width", height: "height" },
    };
    expect(reviewedImageQualityPolicyDefects(unmapped)).toEqual([{ kind: "unmapped_default", control: "guidance" }]);
  });

  it("refuses a row where a control and a raw override claim one provider field", () => {
    // The overrides spread last, so the mapped 7 would leave as a 3 with nothing
    // recording that the reviewed judgment had said otherwise.
    const colliding: ReviewedImageQualityPolicy = {
      controlDefaults: { guidance: 7 },
      providerOverrides: { cfg: 3 },
      controlFields: { guidance: "cfg" },
    };
    expect(reviewedImageQualityPolicyDefects(colliding)).toEqual([
      { kind: "field_collision", control: "guidance", field: "cfg" },
    ]);
  });

  it("gates every pinned dimension pair behind the custom resolution tier", () => {
    // `compileProfileRenderPlan` only lets width/height reach the mapper when the
    // tier says `custom`. A policy pinning a size without the tier would map
    // nothing and record `requires_custom_resolution` — parity would fail on the
    // one setting these community wrappers most need.
    for (const slug of reviewedImageQualitySlugs) {
      const controls = reviewedImageProfileControls(slug)?.controlDefaults;
      if (controls?.width === undefined && controls?.height === undefined) continue;
      expect(controls?.resolution, slug).toBe("custom");
      expect(controls?.width, slug).toBeTypeOf("number");
      expect(controls?.height, slug).toBeTypeOf("number");
    }
  });

  it("keeps the resolution gate out of the provider payload", () => {
    // The tier is the profile vocabulary's gate, not a field any reviewed wrapper
    // declares. Sending it would be a guessed key on models Replicate rejects
    // unknown inputs for.
    for (const slug of reviewedImageQualitySlugs) {
      const policy = reviewedImageQualityPolicy(slug);
      if (!policy) continue;
      expect(Object.keys(effectiveValues(policy)), slug).not.toContain("resolution");
      expect(Object.keys(effectiveValues(policy)), slug).not.toContain("size");
    }
  });

  it("says nothing about an unreviewed model", () => {
    expect(reviewedImageQualityPolicy("operator/added-yesterday")).toBeNull();
    expect(reviewedImageProfileControls("operator/added-yesterday")).toBeNull();
  });

  it("says nothing about a demoted model, which now runs on wrapper defaults", () => {
    for (const slug of DEMOTED_SLUGS) {
      expect(reviewedImageQualityPolicy(slug), slug).toBeNull();
      expect(reviewedImageProfileControls(slug), slug).toBeNull();
    }
  });

  it("reviews only models that have a seeded row to put the profile controls on", () => {
    // What the demotion bought: the reviewed set no longer contains a model the
    // seed migration cannot reach, so every reviewed setting is reproducible as a
    // task profile's controls rather than being overlay-only forever.
    expect(reviewedImageQualitySlugs).not.toContain("lucataco/juggernaut-xl-v9");
    expect(reviewedImageQualitySlugs).not.toContain("nsfw-api/realvis-hyper-lora");
    expect(reviewedImageQualitySlugs).toHaveLength(4);
  });

  it("puts a setting with no normalized control in provider overrides", () => {
    // The two that genuinely have no word in the control vocabulary.
    expect(reviewedImageProfileControls("qwen/qwen-image-edit-2511")?.providerOverrides).toEqual({ go_fast: false });
    // `face_weight` joins `method` here for the same reason: the control
    // vocabulary has no word for the strength of an identity adapter, and
    // inventing one for a single model would be a type change to say a number.
    expect(reviewedImageProfileControls("nsfw-api/sdxl-pulid")?.providerOverrides).toEqual({
      method: "fidelity",
      face_weight: 1,
    });
  });

  it("prefers a normalized control wherever the vocabulary has one", () => {
    const pony = reviewedImageProfileControls("aisha-ai-official/likereality-pony-v1");
    expect(pony?.controlDefaults).toEqual({
      negativePrompt: "",
      resolution: "custom",
      width: 832,
      height: 1216,
    });
    // The reviewed empty negative is a VALUE, not an absence: it exists to clear a
    // wrapper default, so it has to survive into the profile representation as an
    // empty string rather than being omitted.
    expect(pony?.controlDefaults.negativePrompt).toBe("");
    expect(pony?.providerOverrides).toEqual({});
  });
});

/**
 * The seam every profile-shaped configuration built in CODE passes through —
 * admin creation, the Image Generator's bench profile, the image lab's recipes.
 *
 * The defect it kills: the reviewed settings used to be merged into the model
 * row at the render boundary, so a configuration nobody seeded still rendered
 * with them. With the profile as their one owner, a configuration that omits
 * them renders the wrapper defaults the reviewed judgment exists to correct —
 * Qwen Edit back on its speed preset, PuLID back to a 512 square at four-fifths
 * identity strength — and nothing downstream says a word about it.
 */
describe("withReviewedProfileDefaults", () => {
  const pulid = model("nsfw-api/sdxl-pulid:83bea6");
  const inert = { controlDefaults: { seedPolicy: "random" as const }, providerOverrides: {} };

  it("seeds both channels of a reviewed model's policy onto a configuration that states none", () => {
    const seeded = withReviewedProfileDefaults(pulid, inert);
    expect(seeded.controlDefaults).toEqual({
      seedPolicy: "random",
      guidance: 7,
      resolution: "custom",
      width: 832,
      height: 1216,
    });
    expect(seeded.providerOverrides).toEqual({ method: "fidelity", face_weight: 1 });
  });

  it("leaves an unreviewed model's configuration exactly as it stands", () => {
    const configuration = {
      controlDefaults: { seedPolicy: "caller" as const, guidance: 3 },
      providerOverrides: { x: 1 },
    };
    const seeded = withReviewedProfileDefaults(model("operator/added-yesterday"), configuration);
    expect(seeded.controlDefaults).toEqual({ seedPolicy: "caller", guidance: 3 });
    expect(seeded.providerOverrides).toEqual({ x: 1 });
  });

  it("lets the configuration win every key it states, on both channels", () => {
    // The direction migration 0110 wrote (`reviewed || existing`) and the one the
    // render path already resolves in: a stated value outranks a default. Seeding
    // may only supply what nobody mentioned.
    const seeded = withReviewedProfileDefaults(pulid, {
      controlDefaults: { seedPolicy: "random", guidance: 3, width: 1024 },
      providerOverrides: { method: "style" },
    });
    expect(seeded.controlDefaults).toMatchObject({ guidance: 3, width: 1024, height: 1216 });
    expect(seeded.providerOverrides).toEqual({ method: "style", face_weight: 1 });
  });

  it("carries the Pony ruling's empty negative rather than reading it as unset", () => {
    // `""` IS the reviewed value — it clears the wrapper's hidden `"nsfw, naked"`
    // — so a falsiness test anywhere in the merge would restore exactly the
    // default the ruling removed.
    const seeded = withReviewedProfileDefaults(model("aisha-ai-official/likereality-pony-v1:f777e1"), inert);
    expect(seeded.controlDefaults.negativePrompt).toBe("");
  });

  it("does not let a key present with an explicit undefined erase a reviewed value", () => {
    // To the control mapper an `undefined` member and an absent one are the same
    // request, so a plain `{ ...reviewed, ...configured }` spread would drop the
    // reviewed value here and leave no drop record anywhere: the setting would
    // simply never have existed.
    const seeded = withReviewedProfileDefaults(pulid, {
      controlDefaults: { seedPolicy: "random", guidance: undefined, width: undefined },
      providerOverrides: {},
    });
    expect(seeded.controlDefaults.guidance).toBe(7);
    expect(seeded.controlDefaults.width).toBe(832);
  });
});

/**
 * Which provider fields a reviewed correction occupies on one version — the
 * answer the Image Generator's pre-spend gate refuses a raw advanced key
 * against.
 *
 * The defect it kills: that gate used to read `Object.keys(model.extraInput)`,
 * which the overlay had already merged the reviewed pins into. With the pins
 * living on the profile, a gate left reading the row alone would accept a bag
 * key for `cfg` or `method` and let it overwrite the reviewed value on the way
 * out, with the run's own record naming the admin's number as though the
 * reviewed one had never applied.
 */
describe("reviewedImageProfilePinnedFields", () => {
  /** SDXL PuLID's production bindings: guidance on `cfg`, the pair on width/height. */
  const probed = {
    controls: {
      guidance: { field: "cfg", type: "number" as const },
      customWidth: { field: "width", type: "integer" as const },
      customHeight: { field: "height", type: "integer" as const },
    },
    knownInputFields: ["cfg", "face_weight", "method", "width", "height"],
  };

  it("names the probed field of every reviewed control and every raw override key", () => {
    const fields = reviewedImageProfilePinnedFields(model("nsfw-api/sdxl-pulid:83bea6", probed));
    expect([...fields].sort()).toEqual(["cfg", "face_weight", "height", "method", "width"]);
  });

  it("never names the resolution gate, which no reviewed setting sends", () => {
    for (const slug of reviewedImageQualitySlugs) {
      const fields = reviewedImageProfilePinnedFields(model(slug, probed));
      expect(fields, slug).not.toContain("resolution");
      expect(fields, slug).not.toContain("size");
    }
  });

  it("names no field for a reviewed control this version declares no binding for", () => {
    // An unprobed version carries the reviewed controls nowhere: they are dropped
    // at compile with a recorded reason, and nothing can collide with a value
    // that was never sent. Only the raw override keys remain.
    const fields = reviewedImageProfilePinnedFields(model("nsfw-api/sdxl-pulid:83bea6"));
    expect([...fields].sort()).toEqual(["face_weight", "method"]);
  });

  it("says nothing about an unreviewed model", () => {
    expect(reviewedImageProfilePinnedFields(model("operator/added-yesterday", probed))).toEqual([]);
  });
});
