import { describe, expect, it } from "vitest";
import {
  emptyImageLabSettings,
  imageLabControlMetaSchema,
  imageLabControlRole,
  imageLabCreateExperimentRequestSchema,
  imageLabDiagnosticCode,
  imageLabExperimentListSchema,
  imageLabExperimentSchema,
  imageLabExtractControlsRequestSchema,
  imageLabFailureCodeFromDiagnostic,
  imageLabFailureCodes,
  imageLabInputListSchema,
  imageLabRecordVerdictRequestSchema,
  imageLabSettingsSchema,
  imageLabStoredInputListSchema,
  imageLabStoredSettingsSchema,
  imageLabUploadControlRequestSchema,
  type ImageLabExperiment,
} from "./image-lab";

const probeInputs = [
  { position: 1, role: "identity" as const, imageId: "img_face" },
  { position: 2, role: "pose" as const, imageId: "img_skeleton", note: "drawn over the sofa shot" },
];

describe("imageLabInputListSchema", () => {
  it("keeps the ordered numbered roles a control prompt is written against", () => {
    expect(imageLabInputListSchema.parse(probeInputs)).toEqual(probeInputs);
  });

  it("accepts an empty list, because a baseline orders no references of its own", () => {
    expect(imageLabInputListSchema.parse([])).toEqual([]);
  });

  it("rejects positions that are not contiguous from 1", () => {
    // "Image 2" in the instruction and slot 3 in the payload is a mismatch that is
    // invisible in the output and fatal to the conclusion drawn from it.
    const result = imageLabInputListSchema.safeParse([
      { position: 1, role: "identity", imageId: "img_face" },
      { position: 3, role: "pose", imageId: "img_skeleton" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects a list whose array order disagrees with its own numbering", () => {
    // Both positions are present, so a set-based check would pass this — and leave
    // the runner choosing which of the two orderings to send.
    const result = imageLabInputListSchema.safeParse([
      { position: 2, role: "pose", imageId: "img_skeleton" },
      { position: 1, role: "identity", imageId: "img_face" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects a second identity reference", () => {
    // Two faces make an unhonoured control unattributable: was the pose ignored, or
    // was the model reconciling two people?
    const result = imageLabInputListSchema.safeParse([
      { position: 1, role: "identity", imageId: "img_face" },
      { position: 2, role: "identity", imageId: "img_other_face" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects a role outside the shared reference vocabulary", () => {
    const result = imageLabInputListSchema.safeParse([{ position: 1, role: "skeleton", imageId: "img_skeleton" }]);
    expect(result.success).toBe(false);
  });

  it("degrades an unreadable stored list to nothing, which the runner then refuses", () => {
    expect(imageLabStoredInputListSchema.parse("not an array")).toEqual([]);
    expect(imageLabStoredInputListSchema.parse([{ position: 4, role: "identity", imageId: "img" }])).toEqual([]);
  });
});

describe("imageLabControlMetaSchema", () => {
  it("round-trips an extracted fixture's full provenance", () => {
    const meta = {
      controlKind: "pose" as const,
      generator: "extracted_pose" as const,
      sourceImageId: "img_source",
      preprocessorSlug: "some/pose-preprocessor",
      preprocessorVersionId: "ver_123",
      reviewedAt: "2026-08-10T12:00:00.000Z",
      reviewNote: "limbs read clearly",
    };
    expect(imageLabControlMetaSchema.parse(meta)).toEqual(meta);
  });

  it("accepts a hand-authored skeleton with no source and no review yet", () => {
    const parsed = imageLabControlMetaSchema.parse({ controlKind: "edge", generator: "hand_authored" });
    expect(parsed.sourceImageId).toBeUndefined();
    // Absent is "unreviewed", a fact the fixtures panel shows — never a defaulted date.
    expect(parsed.reviewedAt).toBeUndefined();
  });

  it("ignores the encode metadata images.meta already carries", () => {
    const parsed = imageLabControlMetaSchema.parse({
      controlKind: "depth",
      generator: "extracted_depth",
      bytes: 40_000,
      width: 1024,
    });
    expect(parsed).toEqual({ controlKind: "depth", generator: "extracted_depth" });
  });

  it("refuses an unregistered generator rather than storing unattributable provenance", () => {
    const result = imageLabControlMetaSchema.safeParse({ controlKind: "pose", generator: "traced_by_hand" });
    expect(result.success).toBe(false);
  });
});

describe("imageLabSettingsSchema", () => {
  it("parses the empty overlay a Stage 0 probe stores", () => {
    expect(imageLabSettingsSchema.parse({})).toEqual(emptyImageLabSettings());
  });

  it("does not share its defaulted bags between two parsed experiments", () => {
    // zod hands a default straight through without cloning, so a literal default
    // would make one experiment's raw override key appear on every other.
    const first = imageLabSettingsSchema.parse({});
    first.controlInput.cfg = 4;
    expect(imageLabSettingsSchema.parse({}).controlInput).toEqual({});
  });

  it("carries the normalized controls beside the raw provider bag", () => {
    const parsed = imageLabSettingsSchema.parse({
      controls: { guidance: 4, steps: 30, lora: { id: "lora_x", scale: 0.8 } },
      controlInput: { true_cfg_scale: 4 },
    });
    expect(parsed.controls.guidance).toBe(4);
    expect(parsed.controls.lora).toEqual({ id: "lora_x", scale: 0.8 });
    expect(parsed.controlInput).toEqual({ true_cfg_scale: 4 });
  });

  it("falls back to the inert overlay when a stored bag is unreadable", () => {
    expect(imageLabStoredSettingsSchema.parse("nope")).toEqual(emptyImageLabSettings());
  });
});

describe("imageLabExperimentSchema", () => {
  it("round-trips a finished probe with everything the run recorded", () => {
    const experiment: ImageLabExperiment = {
      id: "exp_1",
      kind: "control_probe",
      mode: null,
      characterId: "chr_1",
      chatId: null,
      modelSlug: "qwen/qwen-image-edit-2511",
      requestedVersionId: "ver_pinned",
      executedVersionId: "ver_pinned",
      profileId: null,
      instruction: "Image 1 is the identity reference.",
      finalPrompt: "Image 1 is the identity reference.",
      inputs: probeInputs,
      controlImageId: "img_skeleton",
      controlKind: "pose",
      settings: emptyImageLabSettings(),
      resultImageId: "img_result",
      status: "succeeded",
      failureCode: null,
      verdict: "honours_control",
      verdictNote: "limb-for-limb match, face preserved",
      predictionId: "pred_1",
      createdAt: "2026-08-10T12:00:00.000Z",
      startedAt: "2026-08-10T12:00:01.000Z",
      finishedAt: "2026-08-10T12:00:40.000Z",
    };
    expect(imageLabExperimentSchema.parse(experiment)).toEqual(experiment);
  });

  it("fills a pending experiment's unlearned facts with nulls, never placeholders", () => {
    const parsed = imageLabExperimentSchema.parse({
      id: "exp_2",
      kind: "baseline_portrait",
      modelSlug: "qwen/qwen-image-edit-2511",
      status: "pending",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    expect(parsed.executedVersionId).toBeNull();
    expect(parsed.predictionId).toBeNull();
    expect(parsed.resultImageId).toBeNull();
    expect(parsed.verdict).toBeNull();
    expect(parsed.inputs).toEqual([]);
    expect(parsed.settings).toEqual(emptyImageLabSettings());
  });

  it("keeps a classifier code that is not one of the lab's own", () => {
    // `failureCode` spans two vocabularies on purpose; freezing the union would make
    // adding a render-classifier code a contract change.
    const parsed = imageLabExperimentSchema.parse({
      id: "exp_3",
      kind: "control_probe",
      modelSlug: "qwen/qwen-image-edit-2511",
      status: "failed",
      failureCode: "provider_timeout",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    expect(parsed.failureCode).toBe("provider_timeout");
  });

  it("degrades a malformed list to an empty one rather than breaking the lab page", () => {
    expect(imageLabExperimentListSchema.parse([{ id: "exp_4" }])).toEqual([]);
    expect(imageLabExperimentListSchema.parse(undefined)).toEqual([]);
  });
});

describe("imageLabCreateExperimentRequestSchema", () => {
  it("accepts a control probe with its ordered inputs and its control pointer", () => {
    const parsed = imageLabCreateExperimentRequestSchema.parse({
      kind: "control_probe",
      instruction: "Render the person from Image 1 in the pose drawn in Image 2.",
      inputs: probeInputs,
      controlImageId: "img_skeleton",
      controlKind: "pose",
    });
    expect(parsed.inputs).toEqual(probeInputs);
    // Absent slug means the runner's own default model, not a missing field.
    expect(parsed.modelSlug).toBeUndefined();
  });

  it("refuses a portrait baseline with no character to re-run", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "baseline_portrait",
      instruction: "",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a scene baseline with no chat to re-run", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "baseline_scene",
      characterId: "chr_1",
      instruction: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a portrait baseline that names its character", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "baseline_portrait",
      characterId: "chr_1",
    });
    expect(result.success).toBe(true);
  });

  it("refuses half a control pointer, in either direction", () => {
    expect(
      imageLabCreateExperimentRequestSchema.safeParse({ kind: "control_probe", controlImageId: "img_skeleton" }).success,
    ).toBe(false);
    expect(imageLabCreateExperimentRequestSchema.safeParse({ kind: "control_probe", controlKind: "pose" }).success).toBe(
      false,
    );
  });

  it("refuses inputs the ordering rule rejects", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "control_probe",
      inputs: [{ position: 2, role: "identity", imageId: "img_face" }],
    });
    expect(result.success).toBe(false);
  });

  it("refuses a declared control that is not among the images sent", () => {
    // The runner validates the DECLARED fixture and renders the ORDERED inputs,
    // so this request would file a verdict against a skeleton nothing sent.
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "control_probe",
      inputs: probeInputs,
      controlImageId: "img_other_skeleton",
      controlKind: "pose",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a declared control sent under a role no fixture may occupy", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "control_probe",
      inputs: [
        { position: 1, role: "identity", imageId: "img_face" },
        { position: 2, role: "style", imageId: "img_skeleton" },
      ],
      controlImageId: "img_skeleton",
      controlKind: "pose",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an edge fixture sent under the generic control role", () => {
    // `imageLabControlRole("edge")` is `control`: the fixture vocabulary and the
    // reference-role vocabulary are different lists, and this is the seam.
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "control_probe",
      inputs: [
        { position: 1, role: "identity", imageId: "img_face" },
        { position: 2, role: imageLabControlRole("edge"), imageId: "img_edges" },
      ],
      controlImageId: "img_edges",
      controlKind: "edge",
    });
    expect(result.success).toBe(true);
  });

  it("refuses an unregistered experiment kind", () => {
    expect(imageLabCreateExperimentRequestSchema.safeParse({ kind: "freestyle" }).success).toBe(false);
  });
});

describe("imageLabExtractControlsRequestSchema", () => {
  it("accepts one source and several distinct kinds", () => {
    const parsed = imageLabExtractControlsRequestSchema.parse({
      sourceImageIds: ["img_source"],
      controlKinds: ["pose", "depth"],
    });
    expect(parsed.controlKinds).toEqual(["pose", "depth"]);
  });

  it("refuses a repeated control kind rather than paying for it twice", () => {
    const result = imageLabExtractControlsRequestSchema.safeParse({
      sourceImageIds: ["img_source"],
      controlKinds: ["pose", "pose"],
    });
    expect(result.success).toBe(false);
  });

  it("refuses a repeated source image", () => {
    const result = imageLabExtractControlsRequestSchema.safeParse({
      sourceImageIds: ["img_source", "img_source"],
      controlKinds: ["pose"],
    });
    expect(result.success).toBe(false);
  });

  it("refuses an extraction that names nothing to extract", () => {
    expect(
      imageLabExtractControlsRequestSchema.safeParse({ sourceImageIds: ["img_source"], controlKinds: [] }).success,
    ).toBe(false);
    expect(imageLabExtractControlsRequestSchema.safeParse({ sourceImageIds: [], controlKinds: ["pose"] }).success).toBe(
      false,
    );
  });
});

describe("imageLabUploadControlRequestSchema", () => {
  it("takes the fixture's kind and leaves provenance to the route", () => {
    const parsed = imageLabUploadControlRequestSchema.parse({ controlKind: "pose", note: "hand-drawn" });
    // A client that could name its own generator could file a drawing as an
    // extraction — the route always writes `hand_authored`.
    expect(Object.keys(parsed)).not.toContain("generator");
  });

  it("refuses an upload with no declared control kind", () => {
    expect(imageLabUploadControlRequestSchema.safeParse({ note: "hand-drawn" }).success).toBe(false);
  });
});

describe("imageLabRecordVerdictRequestSchema", () => {
  it("records a verdict with its note", () => {
    const parsed = imageLabRecordVerdictRequestSchema.parse({
      verdict: "ignores_control",
      note: "  the skeleton had no effect on the limbs  ",
    });
    expect(parsed).toEqual({ verdict: "ignores_control", note: "the skeleton had no effect on the limbs" });
  });

  it("refuses a ruling with nothing written beside it", () => {
    expect(imageLabRecordVerdictRequestSchema.safeParse({ verdict: "honours_control", note: "   " }).success).toBe(
      false,
    );
    expect(imageLabRecordVerdictRequestSchema.safeParse({ verdict: "honours_control" }).success).toBe(false);
  });

  it("refuses a verdict outside the probe vocabulary", () => {
    expect(imageLabRecordVerdictRequestSchema.safeParse({ verdict: "mostly", note: "hm" }).success).toBe(false);
  });
});

describe("imageLabDiagnosticCode", () => {
  it("reports lab failures on the image_lab namespace", () => {
    expect(imageLabDiagnosticCode("version_unpinned")).toBe("image_lab.version_unpinned");
    expect(imageLabDiagnosticCode("preprocessor_output_invalid")).toBe("image_lab.preprocessor_output_invalid");
  });
});

describe("imageLabFailureCodeFromDiagnostic", () => {
  // The pairing is the invariant: rows store what the writer minted, so a reader
  // that stops matching it leaves every failure on screen as a bare identifier.
  it("reads back every code the writer mints", () => {
    for (const code of imageLabFailureCodes) {
      expect(imageLabFailureCodeFromDiagnostic(imageLabDiagnosticCode(code))).toBe(code);
    }
  });

  it("accepts a code that was never namespaced", () => {
    expect(imageLabFailureCodeFromDiagnostic("version_unpinned")).toBe("version_unpinned");
  });

  // The render classifier's vocabulary is not this one, and a wrong lab reason
  // would be worse than the raw code the caller falls back to.
  it("disowns a code from outside the lab's vocabulary", () => {
    expect(imageLabFailureCodeFromDiagnostic("provider_timeout")).toBeNull();
    expect(imageLabFailureCodeFromDiagnostic("image_lab.not_a_code")).toBeNull();
  });
});
