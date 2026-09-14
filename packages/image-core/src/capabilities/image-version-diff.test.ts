import { describe, expect, it } from "vitest";
import {
  emptyImageModelAdvancedCapabilities,
  type ImageModelAdvancedCapabilities,
} from "./image-model-capabilities";
import {
  diffImageModelCapabilities,
  type ImageModelCapabilitySnapshot,
  type ImageProfileCandidateFinding,
  type ImageProfileCandidateInput,
  validateImageProfileForCandidate,
} from "./image-version-diff";

/**
 * The version-candidate decision tables: what the capability diff reports, and
 * which profile configurations block versus warn on activation.
 */

function snapshot(overrides: Partial<ImageModelCapabilitySnapshot> = {}): ImageModelCapabilitySnapshot {
  return {
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    aspectMode: "aspect_ratio",
    supportedAspects: ["3:4", "1:1"],
    outputFormat: "webp",
    extraInput: { num_outputs: 1 },
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
    ...overrides,
  };
}

function advanced(overrides: Partial<ImageModelAdvancedCapabilities> = {}): ImageModelAdvancedCapabilities {
  return { ...emptyImageModelAdvancedCapabilities(), ...overrides };
}

describe("diffImageModelCapabilities", () => {
  it("reports nothing when the two versions agree", () => {
    expect(diffImageModelCapabilities(snapshot(), snapshot())).toEqual([]);
  });

  it("reports a changed scalar with both sides", () => {
    const diff = diffImageModelCapabilities(snapshot(), snapshot({ canEdit: false, referenceArity: "single" }));
    expect(diff).toEqual([
      { field: "canEdit", kind: "changed", active: true, candidate: false },
      { field: "referenceArity", kind: "changed", active: "array", candidate: "single" },
    ]);
  });

  it("compares supportedAspects as a set, flagging the entry owner-owned", () => {
    expect(diffImageModelCapabilities(snapshot(), snapshot({ supportedAspects: ["1:1", "3:4"] }))).toEqual([]);
    // The stored list is owner curation, so the entry is review-only: reported
    // with `ownerOwned` and never auto-written by activation or a re-probe.
    expect(diffImageModelCapabilities(snapshot(), snapshot({ supportedAspects: ["3:4", "16:9"] }))).toEqual([
      { field: "supportedAspects", kind: "changed", active: ["3:4", "1:1"], candidate: ["3:4", "16:9"], ownerOwned: true },
    ]);
  });

  it("reports a null-to-value outputFormat change", () => {
    expect(diffImageModelCapabilities(snapshot({ outputFormat: null }), snapshot())).toEqual([
      { field: "outputFormat", kind: "changed", active: null, candidate: "webp" },
    ]);
  });

  it("skips maxReferences when either side omits it, flagging a real entry owner-owned", () => {
    const active = snapshot();
    delete active.maxReferences;
    expect(diffImageModelCapabilities(active, snapshot({ maxReferences: 9 }))).toEqual([]);
    expect(diffImageModelCapabilities(snapshot({ maxReferences: 3 }), snapshot({ maxReferences: 9 }))).toEqual([
      { field: "maxReferences", kind: "changed", active: 3, candidate: 9, ownerOwned: true },
    ]);
  });

  it("reports extraInput keys added, removed, and changed", () => {
    const diff = diffImageModelCapabilities(
      snapshot({ extraInput: { num_outputs: 1, apply_watermark: false } }),
      snapshot({ extraInput: { num_outputs: 4, go_fast: true } }),
    );
    expect(diff).toEqual([
      { field: "extraInput.apply_watermark", kind: "removed", active: false },
      { field: "extraInput.go_fast", kind: "added", candidate: true },
      { field: "extraInput.num_outputs", kind: "changed", active: 1, candidate: 4 },
    ]);
  });

  it("reports a control binding appearing, vanishing, and changing", () => {
    const guidance = { field: "guidance", type: "number" as const, minimum: 0, maximum: 20 };
    const withGuidance = snapshot({ advancedCapabilities: advanced({ controls: { guidance } }) });

    expect(diffImageModelCapabilities(snapshot(), withGuidance)).toEqual([
      { field: "controls.guidance", kind: "added", candidate: guidance },
    ]);
    expect(diffImageModelCapabilities(withGuidance, snapshot())).toEqual([
      { field: "controls.guidance", kind: "removed", active: guidance },
    ]);
    const narrowed = { ...guidance, maximum: 10 };
    expect(
      diffImageModelCapabilities(
        withGuidance,
        snapshot({ advancedCapabilities: advanced({ controls: { guidance: narrowed } }) }),
      ),
    ).toEqual([{ field: "controls.guidance", kind: "changed", active: guidance, candidate: narrowed }]);
  });

  it("reports an enum binding whose members moved", () => {
    const tiers = { field: "size", type: "enum" as const, enumValues: ["1K", "2K"] };
    const wider = { field: "size", type: "enum" as const, enumValues: ["1K", "2K", "4K"] };
    expect(
      diffImageModelCapabilities(
        snapshot({ advancedCapabilities: advanced({ controls: { resolutionTier: tiers } }) }),
        snapshot({ advancedCapabilities: advanced({ controls: { resolutionTier: wider } }) }),
      ),
    ).toEqual([{ field: "controls.resolutionTier", kind: "changed", active: tiers, candidate: wider }]);
  });

  it("reports a type change on the same field as changed", () => {
    const integer = { field: "num_inference_steps", type: "integer" as const };
    const number = { field: "num_inference_steps", type: "number" as const };
    expect(
      diffImageModelCapabilities(
        snapshot({ advancedCapabilities: advanced({ controls: { steps: integer } }) }),
        snapshot({ advancedCapabilities: advanced({ controls: { steps: number } }) }),
      ),
    ).toEqual([{ field: "controls.steps", kind: "changed", active: integer, candidate: number }]);
  });

  it("reports the LoRA bindings like any other slot", () => {
    const weights = { field: "lora_weights", type: "string" as const };
    const scale = { field: "lora_scale", type: "number" as const, minimum: 0, maximum: 2 };
    expect(
      diffImageModelCapabilities(
        snapshot({ advancedCapabilities: advanced({ controls: { loraWeights: weights, loraScale: scale } }) }),
        snapshot(),
      ),
    ).toEqual([
      { field: "controls.loraWeights", kind: "removed", active: weights },
      { field: "controls.loraScale", kind: "removed", active: scale },
    ]);
  });

  it("reports knownInputFields per name, added and removed", () => {
    const diff = diffImageModelCapabilities(
      snapshot({ advancedCapabilities: advanced({ knownInputFields: ["prompt", "seed"] }) }),
      snapshot({ advancedCapabilities: advanced({ knownInputFields: ["guidance", "prompt"] }) }),
    );
    expect(diff).toEqual([
      { field: "knownInputFields.guidance", kind: "added" },
      { field: "knownInputFields.seed", kind: "removed" },
    ]);
  });

  it("reports dedicated image inputs keyed by their provider field", () => {
    const pose = {
      roleHint: "pose" as const,
      binding: { field: "pose_image", arity: "single" as const, required: false },
    };
    expect(
      diffImageModelCapabilities(
        snapshot(),
        snapshot({ advancedCapabilities: advanced({ additionalImageInputs: [pose] }) }),
      ),
    ).toEqual([{ field: "additionalImageInputs.pose_image", kind: "added", candidate: pose }]);
  });

  it("reports provider input descriptors keyed by field, between dedicated inputs and output", () => {
    const recipe = { field: "recipe", type: "string" as const, required: false, default: "identity_v1", reserved: false };
    const retuned = { ...recipe, default: "base_v1" };
    const seed = { field: "seed", type: "integer" as const, required: false, minimum: 0, reserved: true };
    const pose = {
      roleHint: "pose" as const,
      binding: { field: "pose_image", arity: "single" as const, required: false },
    };
    const multi = { arity: "array" as const, supportsMultiple: true };
    const diff = diffImageModelCapabilities(
      snapshot({ advancedCapabilities: advanced({ providerInputs: [recipe] }) }),
      snapshot({
        advancedCapabilities: advanced({ additionalImageInputs: [pose], providerInputs: [retuned, seed], output: multi }),
      }),
    );
    // A field whose declared shape moved is a change to that input, never a
    // remove-plus-add — and the section sits in the documented deterministic
    // order, after additionalImageInputs.* and before output.
    expect(diff).toEqual([
      { field: "additionalImageInputs.pose_image", kind: "added", candidate: pose },
      { field: "providerInputs.recipe", kind: "changed", active: recipe, candidate: retuned },
      { field: "providerInputs.seed", kind: "added", candidate: seed },
      { field: "output", kind: "changed", active: { arity: "single", supportsMultiple: false }, candidate: multi },
    ]);
  });

  it("reports output arity and prompt binding movement", () => {
    const multi = { arity: "array" as const, supportsMultiple: true };
    const prompt = { field: "prompt", maxChars: 2000 };
    const diff = diffImageModelCapabilities(
      snapshot(),
      snapshot({ advancedCapabilities: advanced({ output: multi, prompt }) }),
    );
    expect(diff).toEqual([
      { field: "prompt", kind: "added", candidate: prompt },
      { field: "output", kind: "changed", active: { arity: "single", supportsMultiple: false }, candidate: multi },
    ]);
  });
});

function profile(overrides: Partial<ImageProfileCandidateInput> = {}): ImageProfileCandidateInput {
  return {
    operation: "generate",
    providerOverrides: {},
    controlDefaults: { seedPolicy: "random" },
    ...overrides,
  };
}

function candidate(overrides: Partial<ImageModelCapabilitySnapshot> = {}): ImageModelCapabilitySnapshot {
  return snapshot(overrides);
}

/**
 * The existing cases judge an UNREVIEWED model: `validateImageProfileForCandidate`
 * takes the model's slug because the reviewed policy is keyed by it, and a slug
 * the reviewed table never matches leaves every case below asking exactly what it
 * asked before. The reviewed cases at the end pass a real reviewed slug.
 */
const UNREVIEWED_SLUG = "operator/added-yesterday";
const validate = (
  configuration: ImageProfileCandidateInput,
  caps: ImageModelCapabilitySnapshot,
): ImageProfileCandidateFinding[] => validateImageProfileForCandidate(configuration, caps, UNREVIEWED_SLUG);

describe("validateImageProfileForCandidate", () => {
  it("passes an inert profile against an inert candidate", () => {
    expect(validate(profile(), candidate())).toEqual([]);
  });

  it("blocks an edit profile when the candidate cannot edit", () => {
    const findings = validate(profile({ operation: "edit" }), candidate({ canEdit: false }));
    expect(findings).toEqual([
      expect.objectContaining({ level: "blocking", code: "operation_impossible" }),
    ]);
  });

  it("blocks a generate profile when the candidate cannot generate", () => {
    const findings = validate(profile(), candidate({ canGenerate: false }));
    expect(findings).toEqual([
      expect.objectContaining({ level: "blocking", code: "operation_impossible" }),
    ]);
  });

  it("accepts each operation the candidate supports", () => {
    expect(validate(profile({ operation: "edit" }), candidate())).toEqual([]);
    expect(validate(profile(), candidate({ canEdit: false }))).toEqual([]);
  });

  it("accepts an override key the candidate declares", () => {
    const caps = candidate({ advancedCapabilities: advanced({ knownInputFields: ["go_fast", "prompt"] }) });
    expect(validate(profile({ providerOverrides: { go_fast: true } }), caps)).toEqual([]);
  });

  it("blocks an override key the candidate does not declare", () => {
    const caps = candidate({ advancedCapabilities: advanced({ knownInputFields: ["prompt"] }) });
    expect(validate(profile({ providerOverrides: { go_fast: true } }), caps)).toEqual([
      expect.objectContaining({ level: "blocking", code: "override_field_unknown", context: { field: "go_fast" } }),
    ]);
  });

  it("fails CLOSED on an empty knownInputFields when overrides exist, one finding per key", () => {
    const findings = validate(
      profile({ providerOverrides: { b_field: 1, a_field: true } }),
      candidate(),
    );
    expect(findings).toEqual([
      expect.objectContaining({ level: "blocking", code: "override_field_unknown", context: { field: "a_field" } }),
      expect.objectContaining({ level: "blocking", code: "override_field_unknown", context: { field: "b_field" } }),
    ]);
  });

  it("passes empty overrides against an unprobed candidate", () => {
    expect(validate(profile(), candidate())).toEqual([]);
  });

  it("blocks a LoRA default unless the candidate exposes a usable LoRA weights/scale pair", () => {
    const withLora = profile({ controlDefaults: { seedPolicy: "random", lora: { id: "lora_house" } } });
    const weights = { field: "lora_weights", type: "string" as const };
    const scale = { field: "lora_scale", type: "number" as const };

    expect(validate(withLora, candidate())).toEqual([
      expect.objectContaining({ level: "blocking", code: "lora_binding_missing" }),
    ]);
    expect(
      validate(
        withLora,
        candidate({ advancedCapabilities: advanced({ controls: { loraWeights: weights } }) }),
      ),
    ).toEqual([expect.objectContaining({ level: "blocking", code: "lora_binding_missing" })]);
    expect(
      validate(
        withLora,
        candidate({ advancedCapabilities: advanced({ controls: { loraWeights: weights, loraScale: scale } }) }),
      ),
    ).toEqual([]);

    // Both fields present but disagreeing on shape — an array `lora_weights`
    // beside a scalar `lora_scale` — is exactly as unusable as a missing side:
    // `resolveImageLoraBindingPair` refuses it, and this candidate check must
    // block promotion for the same reason, not silently accept two fields
    // that do not form a pair.
    const arrayWeights = { field: "lora_weights", type: "string" as const, arity: "array" as const };
    expect(
      validate(
        withLora,
        candidate({ advancedCapabilities: advanced({ controls: { loraWeights: arrayWeights, loraScale: scale } }) }),
      ),
    ).toEqual([expect.objectContaining({ level: "blocking", code: "lora_binding_missing" })]);

    // A valid ARRAY pair — a FLUX.2 klein `-base-lora` endpoint's shape — is a
    // usable pair too, and must not block promotion just because it is not
    // the scalar shape Qwen's edit endpoints declare.
    const arrayScale = { field: "lora_scales", type: "number" as const, arity: "array" as const };
    expect(
      validate(
        withLora,
        candidate({ advancedCapabilities: advanced({ controls: { loraWeights: arrayWeights, loraScale: arrayScale } }) }),
      ),
    ).toEqual([]);
  });

  it("blocks a reviewed control the candidate binds nowhere", () => {
    // Qwen Edit's reviewed ruling lives in `fastMode` (migration 0140), and
    // `fastMode` has no row in the tuned-control warning list below — so before
    // this finding existed, promoting a version that stopped declaring
    // `go_fast` reported NOTHING, and every identity-critical render afterwards
    // shipped the provider's own speed preset.
    const findings = validateImageProfileForCandidate(
      profile({ controlDefaults: { seedPolicy: "random", fastMode: false } }),
      candidate(),
      "qwen/qwen-image-edit-2511",
    );
    expect(findings).toEqual([
      expect.objectContaining({
        level: "blocking",
        code: "reviewed_control_unbound",
        context: { control: "fastMode", reason: "no_binding", slug: "qwen/qwen-image-edit-2511" },
      }),
    ]);
  });

  it("accepts a reviewed control the candidate still binds", () => {
    const caps = candidate({
      advancedCapabilities: advanced({ controls: { fastMode: { field: "go_fast", type: "boolean" } } }),
    });
    expect(
      validateImageProfileForCandidate(
        profile({ controlDefaults: { seedPolicy: "random", fastMode: false } }),
        caps,
        "qwen/qwen-image-edit-2511",
      ),
    ).toEqual([]);
  });

  it("blocks a reviewed value the candidate's binding no longer accepts", () => {
    // The binding SURVIVES and the value does not: a candidate that narrows
    // `customWidth` to a 1024 minimum keeps the slot a presence check would have
    // been satisfied by, and refuses the reviewed 832 at render. The mapper is
    // asked, so activation names it here instead.
    const caps = candidate({
      advancedCapabilities: advanced({
        controls: {
          customWidth: { field: "width", type: "integer", minimum: 1024, maximum: 1536 },
          customHeight: { field: "height", type: "integer", minimum: 64, maximum: 1536 },
        },
      }),
    });
    const findings = validateImageProfileForCandidate(
      profile({ controlDefaults: { seedPolicy: "random", resolution: "custom", width: 832, height: 1216 } }),
      caps,
      "aisha-ai-official/nsfw-flux-dev",
    );
    expect(findings).toEqual([
      expect.objectContaining({
        level: "blocking",
        code: "reviewed_control_unbound",
        context: { control: "width", reason: "invalid", slug: "aisha-ai-official/nsfw-flux-dev" },
      }),
    ]);
  });

  it("accepts the reviewed pair on the range the production version declares", () => {
    // The other side of the same check, on the real numbers: 832x1216 inside
    // PuLID's own 64-1536 bindings is a configuration activation must not touch.
    const caps = candidate({
      advancedCapabilities: advanced({
        controls: {
          guidance: { field: "cfg", type: "number", minimum: 1, maximum: 20 },
          customWidth: { field: "width", type: "integer", minimum: 64, maximum: 1536 },
          customHeight: { field: "height", type: "integer", minimum: 64, maximum: 1536 },
        },
        knownInputFields: ["cfg", "face_weight", "height", "method", "width"],
      }),
    });
    expect(
      validateImageProfileForCandidate(
        profile({
          controlDefaults: { seedPolicy: "random", guidance: 7, resolution: "custom", width: 832, height: 1216 },
          providerOverrides: { method: "fidelity", face_weight: 1 },
        }),
        caps,
        "nsfw-api/sdxl-pulid:83bea6",
      ),
    ).toEqual([]);
  });

  it("replaces the ordinary control warning with the blocking finding, never both", () => {
    // PuLID's reviewed guidance and dimension pair have warning rows too. One
    // control gets one answer, and it is the stronger one. `resolution` is in
    // neither list: it is the gate that makes the pair a request, and no
    // version binds a field for it.
    const findings = validateImageProfileForCandidate(
      profile({
        controlDefaults: { seedPolicy: "random", guidance: 7, resolution: "custom", width: 832, height: 1216 },
      }),
      candidate(),
      "nsfw-api/sdxl-pulid:83bea6",
    );
    expect(findings.map((finding) => finding.context.control)).toEqual(["guidance", "width", "height"]);
    expect(findings.every((finding) => finding.level === "blocking")).toBe(true);
    expect(findings.every((finding) => finding.code === "reviewed_control_unbound")).toBe(true);
  });

  it.each([
    ["guidance", { guidance: 4.5 }, "guidance"],
    ["steps", { steps: 28 }, "steps"],
    ["negativePrompt", { negativePrompt: "text" }, "negativePrompt"],
    ["editStrength", { editStrength: 0.6 }, "editStrength"],
    ["resolution", { resolution: "2K" as const }, "resolutionTier"],
    ["width", { width: 1024 }, "customWidth"],
    ["height", { height: 1536 }, "customHeight"],
  ])("warns when the %s default loses its binding", (control, defaults, slot) => {
    const findings = validate(
      profile({ controlDefaults: { seedPolicy: "random", ...defaults } }),
      candidate(),
    );
    expect(findings).toEqual([
      expect.objectContaining({ level: "warning", code: "control_binding_missing", context: { control, slot } }),
    ]);
  });

  it("does not warn when the tuned default keeps its binding", () => {
    const caps = candidate({
      advancedCapabilities: advanced({
        controls: { guidance: { field: "cfg", type: "number" }, steps: { field: "num_inference_steps", type: "integer" } },
      }),
    });
    expect(
      validate(
        profile({ controlDefaults: { seedPolicy: "random", guidance: 4.5, steps: 28 } }),
        caps,
      ),
    ).toEqual([]);
  });

  it("does not map a custom resolution onto the tier binding — width/height carry it", () => {
    const findings = validate(
      profile({ controlDefaults: { seedPolicy: "random", resolution: "custom", width: 1024, height: 1536 } }),
      candidate(),
    );
    expect(findings).toEqual([
      expect.objectContaining({ code: "control_binding_missing", context: { control: "width", slot: "customWidth" } }),
      expect.objectContaining({ code: "control_binding_missing", context: { control: "height", slot: "customHeight" } }),
    ]);
  });

  it("collects blocking and warning findings together", () => {
    const findings = validate(
      profile({
        operation: "edit",
        providerOverrides: { go_fast: true },
        controlDefaults: { seedPolicy: "random", guidance: 4.5 },
      }),
      candidate({ canEdit: false }),
    );
    expect(findings.map((finding) => `${finding.level}:${finding.code}`)).toEqual([
      "blocking:operation_impossible",
      "blocking:override_field_unknown",
      "warning:control_binding_missing",
    ]);
  });
});
