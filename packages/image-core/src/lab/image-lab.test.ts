import { describe, expect, it } from "vitest";
import {
  emptyImageLabSettings,
  imageLabControlMetaSchema,
  imageLabControlRole,
  imageLabCreateExperimentRequestSchema,
  imageLabDiagnosticCode,
  imageLabExperimentKinds,
  imageLabExperimentListSchema,
  imageLabExperimentSchema,
  imageLabExtractControlsRequestSchema,
  imageLabFailureCodeFromDiagnostic,
  imageLabFailureCodes,
  imageLabInputListSchema,
  imageLabOutcomeSchema,
  imageLabRecordVerdictRequestSchema,
  imageLabSettingsSchema,
  imageLabStoredInputListSchema,
  imageLabStoredSettingsSchema,
  imageLabUploadControlRequestSchema,
  imageLabFinishingVerdicts,
  imageLabProbeVerdicts,
  imageLabTwoCharacterVerdicts,
  imageLabVerdictKinds,
  imageLabVerdictOptions,
  imageLabVerdicts,
  isImageLabVerdictForKind,
  isImageLabVerdictKind,
  type ImageLabExperiment,
  type ImageLabOutcome,
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

  it("accepts two identity references, because the cap is now the kind's rather than the list's", () => {
    // The Stage 0 cap — two faces make an unhonoured control unattributable — is
    // still enforced, one layer up where the KIND is known
    // (`imageLabCreateExperimentRequestSchema`), because a two-character scene
    // legitimately sends two. It cannot live here: the stored read-back schema
    // derives from this one and degrades a failure to `[]`, so a refusal here
    // would make a valid two-character row read back as NO inputs and fail its
    // run as `input_missing`.
    const twoIdentities = [
      { position: 1, role: "identity" as const, imageId: "img_face_a", characterId: "chr_a" },
      { position: 2, role: "identity" as const, imageId: "img_face_b", characterId: "chr_b" },
    ];
    expect(imageLabInputListSchema.parse(twoIdentities)).toEqual(twoIdentities);
    expect(imageLabStoredInputListSchema.parse(twoIdentities)).toEqual(twoIdentities);
  });

  it("round-trips the character an identity input depicts", () => {
    const inputs = [
      { position: 1, role: "identity" as const, imageId: "img_face", characterId: "chr_sabrina", note: "canonical" },
    ];
    expect(imageLabInputListSchema.parse(inputs)).toEqual(inputs);
    // Absent is the ordinary case — every kind but the two-character scene.
    expect(imageLabInputListSchema.parse(probeInputs)[0]?.characterId).toBeUndefined();
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
      originNote: "edge pass over the sofa shot",
      reviewedAt: "2026-08-10T12:00:00.000Z",
      reviewNote: "limbs read clearly",
    };
    expect(imageLabControlMetaSchema.parse(meta)).toEqual(meta);
  });

  it("keeps the create path's note apart from the review's", () => {
    // The two notes shared one field once, which made marking a fixture reviewed
    // destroy the record of what it was made for. They are separate fields, and a
    // fixture may carry either alone.
    const madeNotReviewed = imageLabControlMetaSchema.parse({
      controlKind: "pose",
      generator: "hand_authored",
      originNote: "drawn over the sofa shot",
    });
    expect(madeNotReviewed.originNote).toBe("drawn over the sofa shot");
    expect(madeNotReviewed.reviewNote).toBeUndefined();

    const reviewedNotAnnotated = imageLabControlMetaSchema.parse({
      controlKind: "pose",
      generator: "hand_authored",
      reviewedAt: "2026-08-10T12:00:00.000Z",
      reviewNote: "limbs read clearly",
    });
    expect(reviewedNotAnnotated.originNote).toBeUndefined();
    expect(reviewedNotAnnotated.reviewNote).toBe("limbs read clearly");
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
      outcome: null,
      sourceExperimentId: null,
      finishingVariant: null,
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
    // Every Stage 0 row predates the recorded outcome, so absent parses to null.
    expect(parsed.outcome).toBeNull();
    // Only a finishing pass refines another run; every other kind reports none.
    expect(parsed.sourceExperimentId).toBeNull();
  });

  it("carries a finishing pass's source and its own vocabulary's ruling", () => {
    const parsed = imageLabExperimentSchema.parse({
      id: "exp_finish",
      kind: "finishing_pass",
      modelSlug: "qwen/qwen-image-edit-2511",
      status: "succeeded",
      sourceExperimentId: "exp_controlled",
      verdict: "improves_identity",
      verdictNote: "jaw matches the reference; pose, jacket and lighting unchanged",
      createdAt: "2026-08-11T12:00:00.000Z",
    });
    expect(parsed.sourceExperimentId).toBe("exp_controlled");
    expect(parsed.verdict).toBe("improves_identity");
  });

  it("carries the arm a Stage 5 pass ran, and reads an undeclared one as absent", () => {
    const loraOnly = imageLabExperimentSchema.parse({
      id: "exp_lora_only",
      kind: "finishing_pass",
      modelSlug: "qwen/qwen-image-edit-plus-lora",
      status: "succeeded",
      sourceExperimentId: "exp_controlled",
      finishingVariant: "lora_only",
      createdAt: "2026-08-11T12:00:00.000Z",
    });
    expect(loraOnly.finishingVariant).toBe("lora_only");

    // Absent is a real state, not a defaulted "identity": every Stage 3 row
    // predates the vocabulary, and the RUNNER is where absence becomes a choice.
    const stageThree = imageLabExperimentSchema.parse({
      id: "exp_stage_three",
      kind: "finishing_pass",
      modelSlug: "qwen/qwen-image-edit-2511",
      status: "succeeded",
      sourceExperimentId: "exp_controlled",
      createdAt: "2026-08-11T12:00:00.000Z",
    });
    expect(stageThree.finishingVariant).toBeNull();
  });

  it("costs a bad finishing variant the field, never the row", () => {
    const parsed = imageLabExperimentSchema.parse({
      id: "exp_bad_variant",
      kind: "finishing_pass",
      modelSlug: "qwen/qwen-image-edit-2511",
      status: "succeeded",
      finishingVariant: "identity_and_lora",
      createdAt: "2026-08-11T12:00:00.000Z",
    });
    expect(parsed.finishingVariant).toBeNull();
    expect(parsed.id).toBe("exp_bad_variant");
  });

  it("costs a bad source pointer the field, never the row", () => {
    const parsed = imageLabExperimentSchema.parse({
      id: "exp_finish_bad",
      kind: "finishing_pass",
      modelSlug: "qwen/qwen-image-edit-2511",
      status: "succeeded",
      sourceExperimentId: 17,
      createdAt: "2026-08-11T12:00:00.000Z",
    });
    expect(parsed.sourceExperimentId).toBeNull();
    expect(parsed.id).toBe("exp_finish_bad");
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

describe("imageLabOutcomeSchema", () => {
  it("defaults an empty record to the inert decision: nothing sent, nothing dropped", () => {
    expect(imageLabOutcomeSchema.parse({})).toEqual({ sentRoles: [], dropped: [], renumbered: false });
  });

  it("round-trips a controlled run's full decision", () => {
    const outcome: ImageLabOutcome = {
      recipeKey: "controlled_portrait/pose",
      sentRoles: ["identity", "pose", "outfit"],
      dropped: [{ role: "style", reason: "model_capacity", sourceImageId: "img_style" }],
      renumbered: false,
    };
    expect(imageLabOutcomeSchema.parse(outcome)).toEqual(outcome);
  });

  it("costs one bad meta bag the field, never the experiment row", () => {
    const experiment = imageLabExperimentSchema.parse({
      id: "exp_outcome",
      kind: "controlled_portrait",
      modelSlug: "qwen/qwen-image-edit-2511",
      status: "succeeded",
      createdAt: "2026-08-11T12:00:00.000Z",
      outcome: { sentRoles: "not-an-array" },
    });
    expect(experiment.outcome).toBeNull();
    expect(experiment.id).toBe("exp_outcome");
  });

  it("carries a recorded outcome through the experiment schema intact", () => {
    const experiment = imageLabExperimentSchema.parse({
      id: "exp_outcome_ok",
      kind: "controlled_scene",
      modelSlug: "qwen/qwen-image-edit-2511",
      status: "succeeded",
      createdAt: "2026-08-11T12:00:00.000Z",
      outcome: { recipeKey: "controlled_scene/depth", sentRoles: ["identity", "depth"], dropped: [], renumbered: true },
    });
    expect(experiment.outcome).toEqual({
      recipeKey: "controlled_scene/depth",
      sentRoles: ["identity", "depth"],
      dropped: [],
      renumbered: true,
    });
  });

  it("refuses a drop reason outside the planner's vocabulary", () => {
    // The reasons restate `planIntentReferences`' own union; an invented one in
    // a stored bag must not survive into the record.
    const result = imageLabOutcomeSchema.safeParse({
      dropped: [{ role: "style", reason: "operator_whim" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("imageLabVerdictKinds", () => {
  it("covers every kind that asks a question, and only those", () => {
    expect(imageLabVerdictKinds).toEqual([
      "control_probe",
      "controlled_portrait",
      "controlled_scene",
      "two_character_scene",
      "finishing_pass",
    ]);
    for (const kind of imageLabExperimentKinds) {
      const isBaseline = kind === "baseline_portrait" || kind === "baseline_scene";
      expect(isImageLabVerdictKind(kind)).toBe(!isBaseline);
    }
  });

  it("agrees with the per-kind options: a kind rules if and only if it offers rulings", () => {
    for (const kind of imageLabExperimentKinds) {
      expect(imageLabVerdictOptions(kind) !== null).toBe(isImageLabVerdictKind(kind));
    }
  });
});

describe("imageLabVerdictOptions", () => {
  it("offers the control vocabulary to the kinds that declare a control", () => {
    expect(imageLabVerdictOptions("control_probe")).toEqual(imageLabProbeVerdicts);
    expect(imageLabVerdictOptions("controlled_portrait")).toEqual(imageLabProbeVerdicts);
    expect(imageLabVerdictOptions("controlled_scene")).toEqual(imageLabProbeVerdicts);
  });

  it("offers the finishing vocabulary — the plan's promotion rule — to a finishing pass", () => {
    expect(imageLabVerdictOptions("finishing_pass")).toEqual([
      "improves_identity",
      "identity_unchanged",
      "changes_beyond_identity",
      "inconclusive",
    ]);
  });

  it("offers the cast vocabulary to a two-character scene, whose control is optional", () => {
    // The list used to be "the kinds that declare a control". This kind may
    // declare none and is still rulable, because it is judged on its subjects.
    expect(imageLabVerdictOptions("two_character_scene")).toEqual([
      "both_identities_held",
      "identities_swapped",
      "character_missing",
      "character_duplicated",
      "identity_degraded",
      "inconclusive",
    ]);
  });

  it("offers a baseline nothing to rule on", () => {
    expect(imageLabVerdictOptions("baseline_portrait")).toBeNull();
    expect(imageLabVerdictOptions("baseline_scene")).toBeNull();
  });

  it("keeps the union a superset of all three vocabularies, with inconclusive shared once", () => {
    for (const verdict of [...imageLabProbeVerdicts, ...imageLabFinishingVerdicts, ...imageLabTwoCharacterVerdicts]) {
      expect(imageLabVerdicts).toContain(verdict);
    }
    expect(new Set(imageLabVerdicts).size).toBe(imageLabVerdicts.length);
  });

  it("keeps the two-character rulings inside their own kind", () => {
    // The one failure the split exists to prevent, in the third vocabulary's
    // direction: `character_missing` filed against a controlled portrait would
    // be a ruling about a cast that run never had.
    expect(isImageLabVerdictForKind("two_character_scene", "both_identities_held")).toBe(true);
    expect(isImageLabVerdictForKind("two_character_scene", "identities_swapped")).toBe(true);
    expect(isImageLabVerdictForKind("two_character_scene", "inconclusive")).toBe(true);
    // Control obedience is recorded in the NOTE, not the verdict: one column,
    // one ruling, and the kind's defining question is the two-character one.
    expect(isImageLabVerdictForKind("two_character_scene", "honours_control")).toBe(false);
    expect(isImageLabVerdictForKind("two_character_scene", "improves_identity")).toBe(false);
    for (const kind of ["control_probe", "controlled_portrait", "controlled_scene", "finishing_pass"] as const) {
      expect(isImageLabVerdictForKind(kind, "character_missing")).toBe(false);
      expect(isImageLabVerdictForKind(kind, "both_identities_held")).toBe(false);
    }
    expect(isImageLabVerdictForKind("baseline_scene", "both_identities_held")).toBe(false);
  });

  it("refuses a ruling from the other kind's vocabulary", () => {
    // The one failure the split exists to prevent: a control judgment filed
    // against a run that sent no control reads, six months later, exactly like
    // one that did.
    expect(isImageLabVerdictForKind("finishing_pass", "honours_control")).toBe(false);
    expect(isImageLabVerdictForKind("controlled_portrait", "improves_identity")).toBe(false);
    expect(isImageLabVerdictForKind("finishing_pass", "improves_identity")).toBe(true);
    expect(isImageLabVerdictForKind("control_probe", "honours_control")).toBe(true);
    // Shared by both, refused by neither — and still refused on a baseline.
    expect(isImageLabVerdictForKind("finishing_pass", "inconclusive")).toBe(true);
    expect(isImageLabVerdictForKind("control_probe", "inconclusive")).toBe(true);
    expect(isImageLabVerdictForKind("baseline_portrait", "inconclusive")).toBe(false);
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

  it("sends an edge fixture under its own role now that one exists", () => {
    // `imageLabControlRole` is one-to-one since `edge` joined the reference
    // roles. Before that it collapsed onto the generic `control`, which meant a
    // profile could not require an edge map specifically.
    expect(imageLabControlRole("edge")).toBe("edge");
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

  it("still accepts the generic control role that pre-edge experiments recorded", () => {
    // Archived probes stored their edge fixtures under `control`. A validator that
    // stopped accepting it would refuse to re-read its own history.
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "control_probe",
      inputs: [
        { position: 1, role: "identity", imageId: "img_face" },
        { position: 2, role: "control", imageId: "img_edges" },
      ],
      controlImageId: "img_edges",
      controlKind: "edge",
    });
    expect(result.success).toBe(true);
  });

  it("refuses an unregistered experiment kind", () => {
    expect(imageLabCreateExperimentRequestSchema.safeParse({ kind: "freestyle" }).success).toBe(false);
  });

  it("refuses a controlled portrait with no character to be about", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "controlled_portrait",
      inputs: probeInputs,
      controlImageId: "img_skeleton",
      controlKind: "pose",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a controlled scene with no chat to be about", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "controlled_scene",
      characterId: "chr_1",
      inputs: probeInputs,
      controlImageId: "img_skeleton",
      controlKind: "pose",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a LoRA-only finishing pass that names the LoRA it measures", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "finishing_pass",
      sourceExperimentId: "exp_controlled",
      finishingVariant: "lora_only",
      settings: { controls: { lora: { id: "lora_sabrina", scale: 0.9 } } },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.finishingVariant).toBe("lora_only");
  });

  it("refuses a LoRA-only pass with no LoRA — it would only re-render its own source", () => {
    // The arm withholds the identity references so the weights can be judged
    // alone. With no weights either, there is nothing left for the pass to do.
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "finishing_pass",
      sourceExperimentId: "exp_controlled",
      finishingVariant: "lora_only",
    });
    expect(result.success).toBe(false);

    const emptyOverlay = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "finishing_pass",
      sourceExperimentId: "exp_controlled",
      finishingVariant: "lora_only",
      settings: { controls: {}, controlInput: {} },
    });
    expect(emptyOverlay.success).toBe(false);
  });

  it("accepts the identity arm with no LoRA, and a pass that declares no arm at all", () => {
    expect(
      imageLabCreateExperimentRequestSchema.safeParse({
        kind: "finishing_pass",
        sourceExperimentId: "exp_controlled",
        finishingVariant: "identity",
      }).success,
    ).toBe(true);
    const undeclared = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "finishing_pass",
      sourceExperimentId: "exp_controlled",
    });
    expect(undeclared.success).toBe(true);
    if (undeclared.success) expect(undeclared.data.finishingVariant).toBeUndefined();
  });

  it("refuses a variant on a kind whose runner reads none", () => {
    // A stored variant on a controlled run would describe an arm its render
    // never had — the same reason a source pointer is refused there.
    for (const kind of ["control_probe", "baseline_portrait", "controlled_portrait"] as const) {
      const result = imageLabCreateExperimentRequestSchema.safeParse({
        kind,
        characterId: "chr_1",
        inputs: probeInputs,
        controlImageId: "img_skeleton",
        controlKind: "pose",
        finishingVariant: "lora_only",
      });
      expect(result.success).toBe(false);
    }
  });

  it("accepts a controlled portrait naming its character with its control declared among the inputs", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "controlled_portrait",
      characterId: "chr_1",
      instruction: "Render the person from Image 1 in the pose drawn in Image 2.",
      inputs: probeInputs,
      controlImageId: "img_skeleton",
      controlKind: "pose",
    });
    expect(result.success).toBe(true);
  });
});

describe("imageLabCreateExperimentRequestSchema — two-character scenes", () => {
  const castInputs = [
    { position: 1, role: "identity" as const, imageId: "img_face_a", characterId: "chr_a" },
    { position: 2, role: "identity" as const, imageId: "img_face_b", characterId: "chr_b" },
  ];

  function twoCharacter(overrides: Record<string, unknown> = {}) {
    return imageLabCreateExperimentRequestSchema.safeParse({
      kind: "two_character_scene",
      chatId: "cht_1",
      instruction: "The two of them on the balcony at dusk.",
      inputs: castInputs,
      ...overrides,
    });
  }

  it("accepts two named identities on a chat with no control at all", () => {
    // The uncontrolled arm is a real arm, not a degenerate one: "do two people
    // survive?" is answerable without a fixture.
    const result = twoCharacter();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inputs.map((input) => input.characterId)).toEqual(["chr_a", "chr_b"]);
      expect(result.data.controlImageId).toBeUndefined();
    }
  });

  it("accepts a declared control sent exactly once under a control role", () => {
    const result = twoCharacter({
      inputs: [...castInputs, { position: 3, role: "pose", imageId: "img_skeleton" }],
      controlImageId: "img_skeleton",
      controlKind: "pose",
    });
    expect(result.success).toBe(true);
  });

  it("refuses a cast that is not exactly two", () => {
    expect(twoCharacter({ inputs: [castInputs[0]] }).success).toBe(false);
    expect(
      twoCharacter({
        inputs: [...castInputs, { position: 3, role: "identity", imageId: "img_face_c", characterId: "chr_c" }],
      }).success,
    ).toBe(false);
  });

  it("refuses an identity reference that does not say whom it depicts", () => {
    // Without the binding the prompt cannot name the right face in the right
    // numbered slot, and "identities swapped" stops being checkable.
    const result = twoCharacter({
      inputs: [castInputs[0], { position: 2, role: "identity", imageId: "img_face_b" }],
    });
    expect(result.success).toBe(false);
  });

  it("refuses one character sent twice — the duplication this kind measures", () => {
    const result = twoCharacter({
      inputs: [castInputs[0], { position: 2, role: "identity", imageId: "img_face_b", characterId: "chr_a" }],
    });
    expect(result.success).toBe(false);
  });

  it("refuses a top-level subject, which cannot say which of the two it means", () => {
    expect(twoCharacter({ characterId: "chr_a" }).success).toBe(false);
  });

  it("refuses a two-character scene with no chat to be about", () => {
    expect(twoCharacter({ chatId: undefined }).success).toBe(false);
  });

  it("refuses a character bound to an input that depicts no person", () => {
    const result = twoCharacter({
      inputs: [...castInputs, { position: 3, role: "location", imageId: "img_room", characterId: "chr_a" }],
    });
    expect(result.success).toBe(false);
  });

  it("still refuses a source experiment and a finishing variant, like every non-finishing kind", () => {
    expect(twoCharacter({ sourceExperimentId: "exp_controlled" }).success).toBe(false);
    expect(twoCharacter({ finishingVariant: "lora_only" }).success).toBe(false);
  });

  it("still refuses half a control pointer and a control it does not send", () => {
    expect(twoCharacter({ controlImageId: "img_skeleton" }).success).toBe(false);
    expect(twoCharacter({ controlKind: "pose" }).success).toBe(false);
    expect(twoCharacter({ controlImageId: "img_elsewhere", controlKind: "pose" }).success).toBe(false);
  });
});

describe("imageLabCreateExperimentRequestSchema — the relocated identity cap", () => {
  it("refuses a second identity reference on every kind but the two-character scene", () => {
    // The Stage 0 rule, enforced where the kind is known now that one kind
    // legitimately sends two.
    const twoFaces = [
      { position: 1, role: "identity" as const, imageId: "img_face_a" },
      { position: 2, role: "identity" as const, imageId: "img_face_b" },
    ];
    for (const kind of ["control_probe", "baseline_portrait", "controlled_portrait"] as const) {
      const result = imageLabCreateExperimentRequestSchema.safeParse({
        kind,
        characterId: "chr_1",
        inputs: twoFaces,
      });
      expect(result.success).toBe(false);
    }
  });

  it("refuses a per-input character on a kind whose runner reads none", () => {
    // A subject binding on a kind that never reads one would record a fact with
    // no effect on the render — and read, later, exactly like one that had an effect.
    for (const kind of ["control_probe", "baseline_portrait", "controlled_portrait"] as const) {
      const result = imageLabCreateExperimentRequestSchema.safeParse({
        kind,
        characterId: "chr_1",
        inputs: [{ position: 1, role: "identity", imageId: "img_face", characterId: "chr_1" }],
      });
      expect(result.success).toBe(false);
    }
  });

  it("leaves a single unbound identity reference alone, which is every other kind's shape", () => {
    expect(
      imageLabCreateExperimentRequestSchema.safeParse({
        kind: "controlled_portrait",
        characterId: "chr_1",
        inputs: probeInputs,
        controlImageId: "img_skeleton",
        controlKind: "pose",
      }).success,
    ).toBe(true);
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

  it("refuses a verdict outside the vocabulary", () => {
    expect(imageLabRecordVerdictRequestSchema.safeParse({ verdict: "mostly", note: "hm" }).success).toBe(false);
  });

  it("takes a finishing ruling too — the kind gate is the service's, not the wire's", () => {
    const parsed = imageLabRecordVerdictRequestSchema.parse({
      verdict: "changes_beyond_identity",
      note: "the camera pulled back and the jacket changed colour",
    });
    expect(parsed.verdict).toBe("changes_beyond_identity");
  });
});

describe("imageLabCreateExperimentRequestSchema — finishing passes", () => {
  it("accepts a finishing pass that names only the run it refines", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "finishing_pass",
      sourceExperimentId: "exp_controlled",
      instruction: "the left eye is drifting",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.inputs).toEqual([]);
  });

  it("refuses a finishing pass with nothing to refine", () => {
    expect(imageLabCreateExperimentRequestSchema.safeParse({ kind: "finishing_pass" }).success).toBe(false);
  });

  it("refuses ordered inputs on a finishing pass, which the runner resolves itself", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "finishing_pass",
      sourceExperimentId: "exp_controlled",
      inputs: probeInputs,
    });
    expect(result.success).toBe(false);
  });

  it("refuses a subject on a finishing pass, which inherits one", () => {
    for (const subject of [{ characterId: "chr_1" }, { chatId: "cht_1" }]) {
      const result = imageLabCreateExperimentRequestSchema.safeParse({
        kind: "finishing_pass",
        sourceExperimentId: "exp_controlled",
        ...subject,
      });
      expect(result.success).toBe(false);
    }
  });

  it("refuses a control fixture on a finishing pass, which sends none", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "finishing_pass",
      sourceExperimentId: "exp_controlled",
      controlImageId: "img_skeleton",
      controlKind: "pose",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a source experiment on a kind that never reads one", () => {
    const result = imageLabCreateExperimentRequestSchema.safeParse({
      kind: "baseline_portrait",
      characterId: "chr_1",
      sourceExperimentId: "exp_controlled",
    });
    expect(result.success).toBe(false);
  });
});

describe("imageLabDiagnosticCode", () => {
  it("reports lab failures on the image_lab namespace", () => {
    expect(imageLabDiagnosticCode("version_unpinned")).toBe("image_lab.version_unpinned");
    expect(imageLabDiagnosticCode("preprocessor_output_invalid")).toBe("image_lab.preprocessor_output_invalid");
  });

  it("owns the controlled runner's raw-bag refusal in both spellings", () => {
    expect(imageLabFailureCodes).toContain("settings_unsupported");
    expect(imageLabDiagnosticCode("settings_unsupported")).toBe("image_lab.settings_unsupported");
    expect(imageLabFailureCodeFromDiagnostic("image_lab.settings_unsupported")).toBe("settings_unsupported");
  });

  // The two-character kind's whole claim is that each numbered binding names the
  // right person, so the refusal that fires when it cannot has to survive the
  // round trip through the row it is stored on.
  it("owns the two-character subject refusal in both spellings", () => {
    expect(imageLabFailureCodes).toContain("subject_invalid");
    expect(imageLabDiagnosticCode("subject_invalid")).toBe("image_lab.subject_invalid");
    expect(imageLabFailureCodeFromDiagnostic("image_lab.subject_invalid")).toBe("subject_invalid");
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
