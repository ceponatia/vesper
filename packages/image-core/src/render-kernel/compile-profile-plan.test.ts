import { describe, expect, it } from "vitest";
import type { IdentityReferenceRole } from "../identity/identity-pack";
import { imageModelSchema, type ImageModel } from "../models/image-models";
import {
  imageModelProfileSchema,
  imagePromptStrategies,
  type ImageModelProfile,
  type ImagePromptStrategy,
} from "../models/image-model-profiles";
import { preparePromptForImageModel } from "../models/quality-presets";
import {
  compileProfileRenderPlan,
  MAX_TRIAL_PREDICTION_MS,
  pinnedImageModelVersion,
  TRIAL_FALLBACK_PREDICTION_MS,
  type CompileProfileRenderPlanInput,
  type ProfileRenderPlan,
} from "./compile-profile-plan";
import { profileRenderControlsFingerprintJson } from "./fingerprint-json";

/**
 * The compile step's contract, asserted where it is cheapest to assert: pure
 * rows in, a plan out. The application's integration suite proves the plan
 * REACHES the provider seam; these cases prove the plan is right.
 *
 * Nothing here reads or stubs an environment variable. That is the property the
 * render-kernel move bought: the safety setting arrives as a boolean input, so
 * every case that used to flip `REPLICATE_SAFE_MODE` is now an ordinary
 * argument, and a leaked env var can no longer change what a later case
 * compiles.
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

/**
 * Compile and UNWRAP. Every case that reaches for a plan uses one of the prompt
 * strategies this path can execute, so a refusal here is a broken fixture rather
 * than an outcome under test — throwing reports it at the line that caused it
 * instead of as a confusing property access on a refusal object.
 */
function compiledPlan(input: CompileProfileRenderPlanInput): ProfileRenderPlan {
  const result = compileProfileRenderPlan(input);
  if (!result.ok) throw new Error(`[render-kernel] unexpected refusal: ${result.reason} (${result.promptStrategy})`);
  return result.plan;
}

function plan(modelOver: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}): ProfileRenderPlan {
  return compiledPlan({
    model: model(modelOver),
    profile: profile(profileOver),
    basePrompt: "change the outfit",
    baseNegativePrompt: null,
    safetyCheckerDisabled: true,
    references: { vocabulary: "identity_pack", roles: ["canonical_identity"] },
  });
}

/**
 * The package's half of the fingerprint: the deterministic string. The final
 * SHA-256 is the application's, and `render-fingerprint.test.ts` pins that the
 * stored hash of this exact string never moved.
 */
function fingerprintOf(compiled: ProfileRenderPlan): string {
  return profileRenderControlsFingerprintJson(compiled, {
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

  it("treats a blank probe or a bare trailing colon as no pin at all", () => {
    // A whitespace `probed_version_id` and an `owner/name:` slug are both
    // "nothing pins this row" wearing a non-null value. Left untrimmed, a cell
    // would pin `" "`, post an empty version to the provider, and then re-check
    // successfully against its own blank.
    expect(pinnedImageModelVersion(model({ probedVersionId: "   ", slug: "owner/name" }))).toBeNull();
    expect(pinnedImageModelVersion(model({ probedVersionId: null, slug: "owner/name:" }))).toBeNull();
    expect(pinnedImageModelVersion(model({ probedVersionId: "  v9 ", slug: "owner/name" }))).toBe("v9");
    // A blank on one side is absent, so the other side simply wins — it is not
    // a disagreement between two pins.
    expect(pinnedImageModelVersion(model({ probedVersionId: " ", slug: "owner/name:v9" }))).toBe("v9");
  });
});

describe("the prompt-strategy dispatch", () => {
  /** The three the identity-reference path can honestly compile. Everything else
   * in `imagePromptStrategies` must fail closed, and the partition below is what
   * makes an eighth strategy a failing test until somebody decides which side it
   * is on. */
  const EXECUTABLE: readonly ImagePromptStrategy[] = [
    "instruction_edit",
    "text_to_image_description",
    "multi_reference_compose",
  ];

  function compileWith(promptStrategy: ImagePromptStrategy, roles: readonly IdentityReferenceRole[]) {
    return compileProfileRenderPlan({
      model: model(),
      profile: profile({ promptStrategy }),
      basePrompt: "change the outfit",
      baseNegativePrompt: null,
      safetyCheckerDisabled: true,
      references: { vocabulary: "identity_pack", roles },
    });
  }

  it("makes multi_reference_compose send different text than instruction_edit at ONE reference", () => {
    // THE BUG THIS CLOSES: `promptStrategy` was fingerprinted but never
    // consulted, so two profiles differing only in strategy fingerprinted
    // differently and sent byte-identical prompts — the fingerprint asserted a
    // difference nothing downstream made. The strategy's defining semantic is
    // that it NAMES each reference, so at one reference it must diverge or it is
    // `instruction_edit` under a second name.
    const edit = compileWith("instruction_edit", ["canonical_identity"]);
    const compose = compileWith("multi_reference_compose", ["canonical_identity"]);
    expect(edit.ok && compose.ok).toBe(true);
    if (!edit.ok || !compose.ok) return;

    expect(edit.plan.finalPrompt).toBe("change the outfit");
    expect(compose.plan.finalPrompt).toBe(
      "Image 1: the canonical identity reference for the subject.\n\nchange the outfit",
    );
  });

  it("leaves the zero-reference baseline alone under every executable strategy", () => {
    // The control arm must not differ from the pack arms by any text the harness
    // itself added — with nothing to name, naming is a no-op.
    for (const promptStrategy of EXECUTABLE) {
      const compiled = compileWith(promptStrategy, []);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;
      expect(compiled.plan.finalPrompt).toBe("change the outfit");
    }
  });

  it("compiles the executable strategies and fails closed on every other one", () => {
    for (const promptStrategy of imagePromptStrategies) {
      const compiled = compileWith(promptStrategy, ["canonical_identity"]);
      if (EXECUTABLE.includes(promptStrategy)) {
        expect(compiled.ok).toBe(true);
        continue;
      }
      // `text_repair`, `example_transform`, `style_render` and `coherent_set`
      // each need a contract the identity-reference vocabulary does not carry.
      // A typed refusal — never a throw, and never a prompt that is not the
      // strategy it claims to be.
      expect(compiled).toEqual({ ok: false, reason: "unsupported_prompt_strategy", promptStrategy });
    }
  });
});

describe("compileProfileRenderPlan", () => {
  it("leaves a single-reference prompt exactly as the caller wrote it", () => {
    expect(plan().finalPrompt).toBe("change the outfit");
  });

  it("prefixes numbered role bindings when more than one reference is sent", () => {
    const compiled = compiledPlan({
      model: model(),
      profile: profile(),
      basePrompt: "change the outfit",
      baseNegativePrompt: null,
      safetyCheckerDisabled: true,
      references: { vocabulary: "identity_pack", roles: ["face_detail", "canonical_identity"] },
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
    const compiled = compiledPlan({
      model: model(),
      profile: profile({ controlDefaults: { negativePrompt: "profile default", seedPolicy: "random" } }),
      basePrompt: "p",
      baseNegativePrompt: "fixture negative",
      safetyCheckerDisabled: true,
      references: { vocabulary: "identity_pack", roles: [] },
    });
    expect(compiled.negativePrompt).toBe("fixture negative");
    expect(compiled.controlInput).toEqual({ negative_prompt: "fixture negative" });
  });

  it("reports a negative prompt this version cannot carry as null, with the drop recorded", () => {
    // "Nothing goes" is the render-facing truth; WHY nothing goes survives in
    // the drop list, so the fingerprint still distinguishes the two configurations.
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

  it("resolves a profile with no timeout to an explicit budget instead of deferring to the env", () => {
    // `timeoutMs: null` used to reach the renderer as "ask
    // REPLICATE_PREDICTION_TIMEOUT_MS", which can be set to half an hour — so a
    // cell's real deadline was unrecorded, unfingerprinted, and unbounded, and
    // the stale-claim window had nothing firm to be sized against.
    const compiled = plan();
    expect(compiled.timeoutMs).toBe(TRIAL_FALLBACK_PREDICTION_MS);
    expect(compiled.resolvedControls.timeoutMs).toBe(TRIAL_FALLBACK_PREDICTION_MS);
    // And the profile ceiling is a hard clamp, whatever a row claims.
    const overLong = compiledPlan({
      model: model(),
      profile: { ...profile(), timeoutMs: 30 * 60_000 },
      basePrompt: "p",
      baseNegativePrompt: null,
      safetyCheckerDisabled: true,
      references: { vocabulary: "identity_pack", roles: [] },
    });
    expect(overLong.timeoutMs).toBe(MAX_TRIAL_PREDICTION_MS);
  });

  it("drops a mapped control whose probed binding collides with a render-path field", () => {
    // A size-mode model's shape key IS `size`, and `resolutionTier` is commonly
    // probed as `size` too. Left alone, the mapped value travels, the transport
    // discards it, and the fingerprint claims a control was sent that never was.
    const compiled = plan(
      {
        aspectMode: "size",
        advancedCapabilities: {
          controls: {
            resolutionTier: { field: "size", type: "enum", enumValues: ["1K", "2K"] },
            guidance: { field: "guidance_scale", type: "number", minimum: 0, maximum: 20 },
          },
          knownInputFields: ["size", "guidance_scale"],
        },
      },
      { controlDefaults: { resolution: "2K", guidance: 6, seedPolicy: "random" } },
    );
    // The colliding field never enters the payload; the innocent one does.
    expect(compiled.controlInput).toEqual({ guidance_scale: 6 });
    expect(compiled.resolvedControls.droppedControls).toEqual([{ control: "size", reason: "reserved" }]);
  });

  it("never sends an output count, whatever the profile stores", () => {
    // The trial is a single-image path: a profile asking for four outputs would
    // bill four and grade one. The request is RECORDED as a drop rather than
    // reinterpreted as 1, because "this profile wanted a set" is a real
    // difference between two configurations.
    const compiled = plan(
      {
        advancedCapabilities: {
          controls: { outputCount: { field: "num_outputs", type: "integer", minimum: 1, maximum: 4 } },
          knownInputFields: ["num_outputs"],
        },
      },
      { controlDefaults: { outputCount: 4, seedPolicy: "random" } },
    );
    expect(compiled.controlInput).toEqual({});
    expect(compiled.resolvedControls.droppedControls).toEqual([
      { control: "outputCount", reason: "single_image_path" },
    ]);
  });

  it("reports an extraInput negative prompt as sent, and a deliberately empty one as absent", () => {
    // The payload builder copies `extraInput` constants into the payload
    // verbatim, so a row carrying `negative_prompt` sends it with no binding and
    // no control involved. Reporting null claimed nothing was sent while
    // something was.
    expect(plan({ extraInput: { negative_prompt: "grainy, watermark" } }).negativePrompt).toBe("grainy, watermark");
    // The reviewed-quality rows clear their wrapper's boilerplate to `""`. That
    // is "deliberately no negative", and it stays null.
    expect(plan({ extraInput: { negative_prompt: "" } }).negativePrompt).toBeNull();
    expect(plan().negativePrompt).toBeNull();
  });

  it("compiles against the reviewed-quality model, not the raw row", () => {
    // Qwen Edit's provider default optimizes speed where fidelity matters; the
    // reviewed seam corrects it, and the plan must describe the corrected model.
    const compiled = plan({ slug: "qwen/qwen-image-edit-2511", extraInput: { go_fast: true } });
    expect(compiled.effectiveModel.extraInput).toEqual({ go_fast: false });
  });
});

describe("the safety setting as an input", () => {
  const withToggle = { extraInput: { disable_safety_checker: true } };

  function compileWithSafety(safetyCheckerDisabled: boolean): ProfileRenderPlan {
    return compiledPlan({
      model: model(withToggle),
      profile: profile(),
      basePrompt: "change the outfit",
      baseNegativePrompt: null,
      safetyCheckerDisabled,
      references: { vocabulary: "identity_pack", roles: ["canonical_identity"] },
    });
  }

  it("writes the caller's value into the effective model, not the row's placeholder", () => {
    // The row stores a placeholder; the deployment decides. Before the value was
    // resolved into the plan, an operator flipping enforcement between planning a
    // grid and executing it changed what every cell sent with nothing to show
    // for it — and two arms of one comparison could run under different
    // enforcement.
    expect(compileWithSafety(true).effectiveModel.extraInput).toEqual({ disable_safety_checker: true });
    expect(compileWithSafety(false).effectiveModel.extraInput).toEqual({ disable_safety_checker: false });
  });

  it("fingerprints the two enforcement postures differently", () => {
    expect(fingerprintOf(compileWithSafety(true))).not.toBe(fingerprintOf(compileWithSafety(false)));
  });

  it("never introduces the key on a model whose schema does not declare it", () => {
    // A model that has no such input must not be handed one, so its fingerprint
    // cannot move with the setting either.
    const off = compiledPlan({
      model: model(),
      profile: profile(),
      basePrompt: "change the outfit",
      baseNegativePrompt: null,
      safetyCheckerDisabled: false,
      references: { vocabulary: "identity_pack", roles: ["canonical_identity"] },
    });
    expect(off.effectiveModel.extraInput).toEqual({});
    expect(fingerprintOf(off)).toBe(fingerprintOf(plan()));
  });
});

describe("a resolved LoRA", () => {
  const LORA_CAPABILITIES = {
    controls: {
      loraWeights: { field: "lora_weights", type: "string" },
      loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
    },
    knownInputFields: ["lora_weights", "lora_scale"],
  };

  const binding = {
    id: "lora-1",
    label: "Ink Wash",
    locator: "owner/ink-wash-lora",
    scale: 0.8,
    promptPrefix: "Ink wash painting.",
    promptSuffix: null,
    triggerWords: ["sumi-e"],
  };

  function loraPlan(over: Partial<CompileProfileRenderPlanInput> = {}): ProfileRenderPlan {
    return compiledPlan({
      model: model({ advancedCapabilities: LORA_CAPABILITIES }),
      profile: profile(),
      basePrompt: "change the outfit",
      baseNegativePrompt: null,
      safetyCheckerDisabled: true,
      references: { vocabulary: "identity_pack", roles: ["canonical_identity"] },
      ...over,
    });
  }

  it("sends the locator and the scale on the fields this version declared", () => {
    const compiled = loraPlan({ resolvedLora: binding });
    expect(compiled.controlInput).toEqual({ lora_weights: "owner/ink-wash-lora", lora_scale: 0.8 });
  });

  it("weaves the prompt additions into the text that is fingerprinted and sent", () => {
    // The weave happens after the strategy compiles and before the dialect rewrite,
    // so `finalPrompt` is the whole truth about what the provider will read —
    // additions applied at the transport would leave a prompt in the record that
    // nobody sent.
    const compiled = loraPlan({ resolvedLora: binding });
    expect(compiled.finalPrompt.startsWith("Ink wash painting.")).toBe(true);
    expect(compiled.finalPrompt.endsWith("sumi-e")).toBe(true);
    expect(compiled.finalPrompt).toContain("change the outfit");
  });

  it("fingerprints differently from the same compile without it", () => {
    // A field that reaches the provider without reaching the fingerprint is a
    // change a pinned comparison cannot detect.
    expect(fingerprintOf(loraPlan({ resolvedLora: binding }))).not.toBe(fingerprintOf(loraPlan()));
  });

  it("changes nothing when no LoRA was resolved", () => {
    const compiled = loraPlan();
    expect(compiled.controlInput).toEqual({});
    expect(compiled.finalPrompt).toBe("change the outfit");
  });
});

describe("preparePromptForImageModel idempotency", () => {
  it("leaves an already-prepared prompt byte-identical", () => {
    // `compileProfileRenderPlan` fingerprints the prepared prompt and the
    // transport prepares again on the way out. If this ever stops holding, every
    // trial cell starts refusing cell_conflict against its own compiled prompt.
    const legacy =
      "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";
    const target = { slug: "qwen/qwen-image-edit-2511" };
    for (const count of [1, 2]) {
      const once = preparePromptForImageModel(target, `${legacy} Then change the outfit.`, count);
      expect(preparePromptForImageModel(target, once, count)).toBe(once);
    }
  });
});
