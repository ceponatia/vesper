import { describe, expect, it } from "vitest";
import {
  identityReferenceProvenanceListSchema,
  imageModelProfileSchema,
  imageModelSchema,
  type ImageModel,
  type ImageModelProfile,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import {
  buildFaceRepairRunRequest,
  faceRepairInstruction,
  type FaceRepairSourceRow,
  pairFaceRepairIdentityProfile,
  planFaceRepair,
  type PlanFaceRepairInput,
  resolveFaceRepairMethod,
} from "./face-repair";

/**
 * Kills: a face-repair request that reaches the provider despite depicting (or
 * asserting) more than one person, a masked repair silently running full-frame
 * under the "regional" label, or a request whose numbered-reference instruction
 * disagrees with the images it actually sent — every one of which is a repair
 * that promises something the payload does not do.
 *
 * Pure: nothing here opens a database. `planFaceRepair` takes already-loaded
 * rows, so each row of the design's multi-person accept/deny table is one
 * fixture and one assertion, not an integration test.
 */

function model(overrides: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "model-1",
    slug: "qwen/qwen-image-edit-2511",
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    canEdit: true,
    ...overrides,
  });
}

function profile(overrides: Record<string, unknown> = {}): ImageModelProfile {
  return imageModelProfileSchema.parse({
    id: "profile-1",
    imageModelId: "model-1",
    key: "variant-standard",
    label: "Variant (standard)",
    task: "variant",
    operation: "edit",
    promptStrategy: "instruction_edit",
    ...overrides,
  });
}

function resolved(
  modelOverrides: Record<string, unknown> = {},
  profileOverrides: Record<string, unknown> = {},
): ResolvedImageProfile {
  return { model: model(modelOverrides), profile: profile(profileOverrides) };
}

function source(overrides: Partial<FaceRepairSourceRow> = {}): FaceRepairSourceRow {
  return {
    id: "img-source",
    kind: "avatar",
    status: "ready",
    entityKind: "character",
    entityId: "char-1",
    meta: {},
    ...overrides,
  };
}

function planInput(overrides: Partial<PlanFaceRepairInput> = {}): PlanFaceRepairInput {
  return {
    enabled: true,
    characterId: "char-1",
    characterOwned: true,
    source: source(),
    sceneCast: null,
    identityPack: null,
    ...overrides,
  };
}

describe("planFaceRepair — flag and basic gates", () => {
  it("refuses disabled when the flag is off, before any other check", () => {
    const result = planFaceRepair(planInput({ enabled: false, characterOwned: false, source: null }));
    expect(result).toEqual({ ok: false, code: "disabled", message: "face repair is not enabled" });
  });

  it("refuses character_not_found for a character this caller does not own", () => {
    const result = planFaceRepair(planInput({ characterOwned: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("character_not_found");
  });

  it("refuses source_unavailable when no source row was loaded", () => {
    const result = planFaceRepair(planInput({ source: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("source_unavailable");
  });

  it("refuses source_unavailable for a source that is not ready", () => {
    const result = planFaceRepair(planInput({ source: source({ status: "pending" }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("source_unavailable");
  });

  it("refuses source_unavailable for a hidden system kind", () => {
    const result = planFaceRepair(planInput({ source: source({ kind: "identity_face_crop" }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("source_unavailable");
  });
});

describe("planFaceRepair — the multi-person accept/deny table", () => {
  it("refuses multi_person for a scene whose cast names 2+ distinct characters", () => {
    const result = planFaceRepair(
      planInput({
        source: source({ kind: "scene", entityKind: null, entityId: null }),
        sceneCast: { characterEntityIds: ["char-1", "char-2"] },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("multi_person");
  });

  it("refuses multi_person for a chat_place row whose cast names 2+ characters", () => {
    const result = planFaceRepair(
      planInput({
        source: source({ kind: "chat_place", entityKind: null, entityId: null }),
        sceneCast: { characterEntityIds: ["char-1", "char-2", "char-3"] },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("multi_person");
  });

  it("refuses multi_person when the render's own world-digest asserts more than one subject", () => {
    const result = planFaceRepair(
      planInput({
        source: source({ meta: { worldState: { version: 1, readKind: "committed_cut", readToken: "t", worldFingerprint: "f", subjectRefs: ["subject.char-1", "subject.char-2"] } } }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("multi_person");
  });

  it("refuses multi_person when the identity pack itself records ambiguous_faces", () => {
    const result = planFaceRepair(planInput({ identityPack: { failureCode: "ambiguous_faces", detectedFaces: null } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("multi_person");
  });

  it("refuses multi_person when the identity pack detected more than one face", () => {
    const result = planFaceRepair(planInput({ identityPack: { failureCode: null, detectedFaces: 2 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("multi_person");
  });

  it("accepts an avatar with no contrary evidence, recording method none", () => {
    const result = planFaceRepair(planInput({ source: source({ kind: "avatar" }) }));
    expect(result).toEqual({ ok: true, subjectCheck: { method: "none", subjects: null } });
  });

  it("accepts a portrait_variant / chat_look / reference_view the same way", () => {
    for (const kind of ["portrait_variant", "chat_look", "reference_view"] as const) {
      const result = planFaceRepair(planInput({ source: source({ kind }) }));
      expect(result).toEqual({ ok: true, subjectCheck: { method: "none", subjects: null } });
    }
  });

  it("accepts a single-cast scene, recording reference_cast with one subject", () => {
    const result = planFaceRepair(
      planInput({
        source: source({ kind: "scene", entityKind: null, entityId: null }),
        sceneCast: { characterEntityIds: ["char-1"] },
      }),
    );
    expect(result).toEqual({ ok: true, subjectCheck: { method: "reference_cast", subjects: 1 } });
  });

  it("accepts a non-scene render whose world-digest asserts exactly one subject", () => {
    const result = planFaceRepair(
      planInput({
        source: source({
          kind: "portrait_variant",
          meta: { worldState: { version: 1, readKind: "committed_cut", readToken: "t", worldFingerprint: "f", subjectRefs: ["subject.char-1"] } },
        }),
      }),
    );
    expect(result).toEqual({ ok: true, subjectCheck: { method: "render_contract", subjects: 1 } });
  });

  it("refuses source_unavailable for a scene that does not include this character at all", () => {
    const result = planFaceRepair(
      planInput({
        source: source({ kind: "scene", entityKind: null, entityId: null }),
        sceneCast: { characterEntityIds: ["char-other"] },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("source_unavailable");
  });

  it("refuses source_unavailable for a source tied to a different character outright", () => {
    const result = planFaceRepair(planInput({ source: source({ kind: "avatar", entityKind: "character", entityId: "char-other" }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("source_unavailable");
  });
});

describe("resolveFaceRepairMethod", () => {
  it("resolves full_frame_identity_edit for a model with no dedicated mask input", () => {
    const result = resolveFaceRepairMethod(model());
    expect(result).toEqual({ ok: true, method: "full_frame_identity_edit" });
  });

  it("refuses method_unavailable for a model that declares a dedicated mask input", () => {
    const maskModel = model({
      referenceField: "image",
      advancedCapabilities: {
        additionalImageInputs: [
          { roleHint: "mask", binding: { field: "mask_image", arity: "single", required: false } },
        ],
      },
    });
    const result = resolveFaceRepairMethod(maskModel);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("method_unavailable");
      expect(result.message).toContain("no mask source exists yet");
    }
  });
});

describe("pairFaceRepairIdentityProfile", () => {
  it("pairs a multi-reference model with canonical_then_face_detail", () => {
    const paired = pairFaceRepairIdentityProfile(resolved({ maxReferences: 2 }));
    expect(paired.profile.referencePolicy.identityStrategy).toBe("canonical_then_face_detail");
    expect(paired.model.id).toBe("model-1");
  });

  it("degrades a single-reference model (e.g. PuLID) to canonical_only explicitly", () => {
    const paired = pairFaceRepairIdentityProfile(resolved({ maxReferences: 1 }));
    expect(paired.profile.referencePolicy.identityStrategy).toBe("canonical_only");
  });
});

describe("faceRepairInstruction", () => {
  it("names a single identity reference as Image 2", () => {
    expect(faceRepairInstruction(1)).toBe(
      "Repair the face in Image 1 to match the person shown in Image 2; keep the pose, clothing, background, lighting and composition of Image 1 unchanged.",
    );
  });

  it("names two identity references as Images 2 through 3", () => {
    expect(faceRepairInstruction(2)).toBe(
      "Repair the face in Image 1 to match the person shown in Images 2 through 3; keep the pose, clothing, background, lighting and composition of Image 1 unchanged.",
    );
  });
});

describe("buildFaceRepairRunRequest", () => {
  it("sends the source first, identity references after, and a complete provenance bag", () => {
    const provenance = identityReferenceProvenanceListSchema.parse([
      {
        characterId: "char-1",
        packId: "pack-1",
        packRevision: 1,
        packSchemaVersion: 1,
        derivationVersion: "v1",
        policyVersion: "v1",
        role: "canonical_identity",
        imageId: "img-canonical",
        sourceImageId: "img-accepted",
        sourceContentHash: "hash-1",
        cropMethod: null,
        crop: null,
        adminOverride: false,
        effectiveReferenceWidthPx: null,
        effectiveReferenceHeightPx: null,
        effectiveFaceWidthPx: null,
        effectiveFaceHeightPx: null,
      },
    ]);
    const request = buildFaceRepairRunRequest({
      modelId: "model-1",
      characterId: "char-1",
      sourceImageId: "img-source",
      identityReferenceImageIds: ["img-canonical"],
      method: "full_frame_identity_edit",
      subjectCheck: { method: "none", subjects: null },
      identityReferences: provenance,
    });

    expect(request.modelId).toBe("model-1");
    expect(request.inputs?.primary).toEqual([
      { imageId: "img-source", purpose: "reference" },
      { imageId: "img-canonical", purpose: "identity" },
    ]);
    expect(request.controls).toEqual({ imageCount: 1 });
    expect(request.prompt).toContain("Image 1");
    expect(request.prompt).toContain("Image 2");
    expect(request.purpose).toEqual({
      kind: "face_repair",
      characterId: "char-1",
      sourceImageId: "img-source",
      method: "full_frame_identity_edit",
      subjectCheck: { method: "none", subjects: null },
      identityReferences: provenance,
    });
  });
});
