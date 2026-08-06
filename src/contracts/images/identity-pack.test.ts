import { describe, expect, it } from "vitest";
import { parseOr } from "@/lib/parse";
import { DiagnosticCollector } from "../diagnostics";
import {
  identityPackAdminOverrideRequestSchema,
  identityPackBatchRequestSchema,
  identityPackManualCropRequestSchema,
  identityPackSummarySchema,
  identityReferenceProvenanceListSchema,
  identityReferenceProvenanceSchema,
  identityReferenceRoles,
  identityReferenceStrategies,
  imageIdentityPackQualitySchema,
  imageIdentityPackStatuses,
  imageIdentityPackV1Schema,
  imageIdentityPackWarningCodeListSchema,
  isAllowedIdentityPackTransition,
  sourcePixelCropSchema,
  type ImageIdentityPackStatus,
} from "./identity-pack";

function derivationFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    derivationVersion: "derive_v1",
    policyVersion: "policy_v1",
    method: "detector",
    detectorVersion: "null_v1",
    confidence: 0.91,
    createdAt: "2026-08-05T00:00:00.000Z",
  };
}

function packFixture(): Record<string, unknown> {
  return {
    version: 1,
    id: "pack_1",
    characterId: "char_1",
    revision: 1,
    current: true,
    status: "ready",
    source: { imageId: "img_src", contentHash: "a".repeat(64), width: 768, height: 1024 },
    derivation: derivationFixture(),
    faceDetail: {
      imageId: "img_crop",
      crop: { left: 111, top: 51, width: 546, height: 546 },
      outputWidth: 546,
      outputHeight: 546,
    },
    quality: null,
    warningCodes: [],
    failureCode: null,
    review: { actorUserId: null, reason: null, reviewedAt: null },
  };
}

function qualityFixture(): Record<string, unknown> {
  return {
    algorithmVersion: "laplacian_v1",
    detectedFaces: 1,
    faceBox: { left: 284, top: 220, width: 200, height: 260 },
    faceWidthPx: 200,
    faceHeightPx: 260,
    faceAreaRatio: 0.174,
    blurScore: 180.5,
    occlusionScore: null,
    padding: { topPx: 169, rightPx: 173, bottomPx: 117, leftPx: 173 },
  };
}

describe("state transitions", () => {
  const allowed: ReadonlyArray<readonly [ImageIdentityPackStatus, ImageIdentityPackStatus]> = [
    ["pending", "ready"],
    ["pending", "unusable"],
    ["pending", "failed"],
    ["pending", "stale"],
    ["ready", "stale"],
    ["ready", "superseded"],
    ["unusable", "stale"],
    ["unusable", "superseded"],
    ["failed", "stale"],
    ["failed", "superseded"],
  ];

  it("permits exactly the transitions the spec lists, and nothing else", () => {
    const expected = new Set(allowed.map(([from, to]) => `${from}->${to}`));
    for (const from of imageIdentityPackStatuses) {
      for (const to of imageIdentityPackStatuses) {
        expect({ from, to, ok: isAllowedIdentityPackTransition(from, to) }).toEqual({
          from,
          to,
          ok: expected.has(`${from}->${to}`),
        });
      }
    }
  });

  it("treats stale and superseded as terminal — a retry is a new revision, not a reset", () => {
    for (const to of imageIdentityPackStatuses) {
      expect(isAllowedIdentityPackTransition("stale", to)).toBe(false);
      expect(isAllowedIdentityPackTransition("superseded", to)).toBe(false);
    }
  });

  it("never allows a status to transition to itself", () => {
    for (const status of imageIdentityPackStatuses) {
      expect(isAllowedIdentityPackTransition(status, status)).toBe(false);
    }
  });
});

describe("source pixel crop", () => {
  it("accepts a crop flush against the source origin — zero is a coordinate", () => {
    expect(sourcePixelCropSchema.safeParse({ left: 0, top: 0, width: 1, height: 1 }).success).toBe(true);
  });

  it("rejects a zero-area or negative rectangle", () => {
    expect(sourcePixelCropSchema.safeParse({ left: 0, top: 0, width: 0, height: 10 }).success).toBe(false);
    expect(sourcePixelCropSchema.safeParse({ left: -1, top: 0, width: 10, height: 10 }).success).toBe(false);
  });

  it("rejects fractional pixels — coordinates are integers in the stored orientation", () => {
    expect(sourcePixelCropSchema.safeParse({ left: 0.5, top: 0, width: 10, height: 10 }).success).toBe(false);
  });
});

describe("quality measurements", () => {
  it("round-trips a full measurement record", () => {
    const parsed = imageIdentityPackQualitySchema.safeParse(qualityFixture());
    expect(parsed.success).toBe(true);
  });

  it("preserves zero everywhere a measurement can legitimately be zero", () => {
    const parsed = imageIdentityPackQualitySchema.safeParse({
      ...qualityFixture(),
      detectedFaces: 0,
      faceAreaRatio: 0,
      blurScore: 0,
      occlusionScore: 0,
      padding: { topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 },
    });
    if (!parsed.success) throw new Error("expected a valid record");
    expect(parsed.data.detectedFaces).toBe(0);
    expect(parsed.data.faceAreaRatio).toBe(0);
    expect(parsed.data.blurScore).toBe(0);
    expect(parsed.data.occlusionScore).toBe(0);
    expect(parsed.data.padding).toEqual({ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 });
  });

  it("keeps null distinct from zero for every optional metric", () => {
    const parsed = imageIdentityPackQualitySchema.safeParse({
      ...qualityFixture(),
      detectedFaces: null,
      faceBox: null,
      faceWidthPx: null,
      faceHeightPx: null,
      faceAreaRatio: null,
      blurScore: null,
      padding: { topPx: null, rightPx: null, bottomPx: null, leftPx: null },
    });
    if (!parsed.success) throw new Error("expected a valid record");
    expect(parsed.data.detectedFaces).toBeNull();
    expect(parsed.data.blurScore).toBeNull();
    expect(parsed.data.padding.topPx).toBeNull();
  });

  it("keeps negative padding, which is the evidence a face escaped its crop", () => {
    const parsed = imageIdentityPackQualitySchema.safeParse({
      ...qualityFixture(),
      padding: { topPx: -12, rightPx: 173, bottomPx: 117, leftPx: 173 },
    });
    if (!parsed.success) throw new Error("expected a valid record");
    expect(parsed.data.padding.topPx).toBe(-12);
  });

  it("rejects a record with no algorithm version — a raw blur score alone means nothing", () => {
    const rest = qualityFixture();
    delete rest.algorithmVersion;
    expect(imageIdentityPackQualitySchema.safeParse(rest).success).toBe(false);
  });

  it("degrades malformed jsonb to null with a diagnostic instead of throwing", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseOr(
      imageIdentityPackQualitySchema.nullable(),
      JSON.stringify({ ...qualityFixture(), faceBox: { left: -5, top: 0, width: 0, height: 0 } }),
      null,
      sink,
      "image_identity_packs.quality_json",
    );
    expect(parsed).toBeNull();
    expect(sink.items[0]?.code).toBe("parse.boundary_failed");
    expect(sink.items[0]?.path).toBe("image_identity_packs.quality_json");
  });
});

describe("warning code list", () => {
  it("parses a real list", () => {
    expect(imageIdentityPackWarningCodeListSchema.parse(["heuristic_crop", "mild_blur"])).toEqual([
      "heuristic_crop",
      "mild_blur",
    ]);
  });

  it("degrades an unknown code or a malformed value to an empty list", () => {
    expect(imageIdentityPackWarningCodeListSchema.parse(["not_a_code"])).toEqual([]);
    expect(imageIdentityPackWarningCodeListSchema.parse("garbage")).toEqual([]);
    expect(imageIdentityPackWarningCodeListSchema.parse(null)).toEqual([]);
  });

  it("hands every caller its own empty list, never one shared array", () => {
    const first = imageIdentityPackWarningCodeListSchema.parse("garbage");
    const second = imageIdentityPackWarningCodeListSchema.parse("garbage");
    expect(first).not.toBe(second);
  });
});

describe("pack contract", () => {
  it("parses a ready revision", () => {
    const parsed = imageIdentityPackV1Schema.safeParse(packFixture());
    if (!parsed.success) throw new Error("expected a valid pack");
    expect(parsed.data.version).toBe(1);
    expect(parsed.data.faceDetail.crop).toEqual({ left: 111, top: 51, width: 546, height: 546 });
  });

  it("refuses a pack claiming another contract version", () => {
    expect(imageIdentityPackV1Schema.safeParse({ ...packFixture(), version: 2 }).success).toBe(false);
    const derivation = { ...derivationFixture(), schemaVersion: 2 };
    expect(imageIdentityPackV1Schema.safeParse({ ...packFixture(), derivation }).success).toBe(false);
  });

  it("defaults an absent warning list without sharing one array between packs", () => {
    const rest = packFixture();
    delete rest.warningCodes;
    const first = imageIdentityPackV1Schema.parse(rest);
    const second = imageIdentityPackV1Schema.parse(rest);
    expect(first.warningCodes).toEqual([]);
    expect(first.warningCodes).not.toBe(second.warningCodes);
  });

  it("keeps a zero detector confidence rather than folding it into null", () => {
    const derivation = { ...derivationFixture(), confidence: 0 };
    const parsed = imageIdentityPackV1Schema.safeParse({ ...packFixture(), derivation });
    if (!parsed.success) throw new Error("expected a valid pack");
    expect(parsed.data.derivation.confidence).toBe(0);
  });

  it("accepts an unusable revision with no crop and a failure code", () => {
    const parsed = imageIdentityPackV1Schema.safeParse({
      ...packFixture(),
      status: "unusable",
      faceDetail: { imageId: null, crop: null, outputWidth: null, outputHeight: null },
      warningCodes: ["heuristic_crop"],
      failureCode: "no_usable_face",
    });
    if (!parsed.success) throw new Error("expected a valid pack");
    expect(parsed.data.failureCode).toBe("no_usable_face");
    expect(parsed.data.faceDetail.crop).toBeNull();
  });

  it("rejects a revision number below the 1-based sequence", () => {
    expect(imageIdentityPackV1Schema.safeParse({ ...packFixture(), revision: 0 }).success).toBe(false);
  });

  it("degrades a malformed pack payload rather than throwing into a render route", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseOr(
      imageIdentityPackV1Schema.nullable(),
      { ...packFixture(), status: "half_done" },
      null,
      sink,
      "image_identity_packs",
    );
    expect(parsed).toBeNull();
    expect(sink.items[0]?.code).toBe("parse.boundary_failed");
  });
});

describe("render provenance", () => {
  function provenanceFixture(): Record<string, unknown> {
    return {
      characterId: "char_1",
      packId: "pack_1",
      packRevision: 3,
      packSchemaVersion: 1,
      derivationVersion: "derive_v1",
      policyVersion: "policy_v1",
      role: "face_detail",
      imageId: "img_crop",
      sourceImageId: "img_src",
      sourceContentHash: "a".repeat(64),
      cropMethod: "detector",
      crop: { left: 111, top: 51, width: 546, height: 546 },
      warningCodes: ["heuristic_crop"],
      adminOverride: false,
      effectiveReferenceWidthPx: 1024,
      effectiveReferenceHeightPx: 1024,
      effectiveFaceWidthPx: 375,
      effectiveFaceHeightPx: 488,
    };
  }

  it("records the exact revision and effective measurements behind a render", () => {
    const parsed = identityReferenceProvenanceSchema.safeParse(provenanceFixture());
    if (!parsed.success) throw new Error("expected valid provenance");
    expect(parsed.data.packRevision).toBe(3);
    expect(parsed.data.effectiveFaceWidthPx).toBe(375);
  });

  it("keeps unmeasured effective sizes null and measured zeroes zero", () => {
    const unknown = identityReferenceProvenanceSchema.safeParse({
      ...provenanceFixture(),
      effectiveReferenceWidthPx: null,
      effectiveReferenceHeightPx: null,
      effectiveFaceWidthPx: null,
      effectiveFaceHeightPx: null,
    });
    if (!unknown.success) throw new Error("expected valid provenance");
    expect(unknown.data.effectiveFaceWidthPx).toBeNull();

    const zeroed = identityReferenceProvenanceSchema.safeParse({
      ...provenanceFixture(),
      effectiveFaceWidthPx: 0,
      effectiveFaceHeightPx: 0,
    });
    if (!zeroed.success) throw new Error("expected valid provenance");
    expect(zeroed.data.effectiveFaceWidthPx).toBe(0);
  });

  it("accepts a canonical reference with no crop of its own", () => {
    const parsed = identityReferenceProvenanceSchema.safeParse({
      ...provenanceFixture(),
      role: "canonical_identity",
      cropMethod: null,
      crop: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("degrades a malformed provenance list to empty, per row", () => {
    const first = identityReferenceProvenanceListSchema.parse([{ characterId: "only" }]);
    const second = identityReferenceProvenanceListSchema.parse("garbage");
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(first).not.toBe(second);
  });
});

describe("reference vocabulary", () => {
  it("exposes exactly the two v1 roles", () => {
    expect(identityReferenceRoles).toEqual(["canonical_identity", "face_detail"]);
  });

  it("covers every ordering a profile can declare", () => {
    expect(identityReferenceStrategies).toEqual([
      "canonical_only",
      "face_detail_only",
      "canonical_then_face_detail",
      "face_detail_then_canonical",
    ]);
  });
});

/**
 * The wire contracts the routes and the crop editor exchange. These are trust
 * boundaries in the literal sense — everything here arrives from a browser — so
 * the cases below are the ones where accepting the input would do damage rather
 * than merely be untidy.
 */
function manualCropFixture(): Record<string, unknown> {
  return {
    packId: "pack_1",
    revision: 3,
    sourceContentHash: "a".repeat(64),
    crop: { space: "normalized", left: 0, top: 0.05, width: 1, height: 0.75 },
  };
}

describe("identity pack summary wire", () => {
  function summaryFixture(): Record<string, unknown> {
    return {
      packId: "pack_1",
      status: "ready",
      revision: 2,
      current: true,
      stale: false,
      method: "manual",
      source: { imageId: "img_src", width: 384, height: 512 },
      crop: { left: 0, top: 0, width: 384, height: 384 },
      cropImageId: "img_crop",
      warningCodes: ["heuristic_crop"],
      failureCode: null,
      sourceContentHash: "a".repeat(64),
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
  }

  it("carries a prepared pack unchanged", () => {
    expect(identityPackSummarySchema.parse(summaryFixture())).toMatchObject({ status: "ready", revision: 2 });
  });

  it("admits the empty state the stored vocabulary has no room for", () => {
    const parsed = identityPackSummarySchema.safeParse({
      ...summaryFixture(),
      packId: null,
      status: "none",
      revision: null,
      current: false,
      method: null,
      source: { imageId: "img_src", width: null, height: null },
      crop: null,
      cropImageId: null,
      warningCodes: [],
      sourceContentHash: null,
      updatedAt: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("exposes pending explicitly rather than folding it into a failure", () => {
    const parsed = identityPackSummarySchema.safeParse({ ...summaryFixture(), status: "pending" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a status outside the vocabulary", () => {
    expect(identityPackSummarySchema.safeParse({ ...summaryFixture(), status: "almost" }).success).toBe(false);
  });
});

describe("manual crop request", () => {
  it("accepts a normalized rectangle with the concurrency guard", () => {
    const parsed = identityPackManualCropRequestSchema.safeParse(manualCropFixture());
    expect(parsed.success).toBe(true);
  });

  it("rejects coordinates outside the unit square", () => {
    // 1.4 of the source is not a rectangle anybody framed; resolving it to
    // pixels would clamp silently and store a crop the user never saw.
    for (const crop of [
      { space: "normalized", left: 1.4, top: 0, width: 0.5, height: 0.5 },
      { space: "normalized", left: 0, top: -0.1, width: 0.5, height: 0.5 },
      { space: "normalized", left: 0, top: 0, width: 1.2, height: 0.5 },
    ]) {
      expect(identityPackManualCropRequestSchema.safeParse({ ...manualCropFixture(), crop }).success).toBe(false);
    }
  });

  it("rejects a zero-area rectangle — a malformed crop, not a small one", () => {
    const crop = { space: "normalized", left: 0.5, top: 0.5, width: 0, height: 0.4 };
    expect(identityPackManualCropRequestSchema.safeParse({ ...manualCropFixture(), crop }).success).toBe(false);
  });

  it("requires the whole guard, so a client cannot save without saying what it opened", () => {
    for (const missing of ["packId", "revision", "sourceContentHash"]) {
      const body = manualCropFixture();
      delete body[missing];
      expect(identityPackManualCropRequestSchema.safeParse(body).success, missing).toBe(false);
    }
  });

  it("keeps the untagged pixel space out — magnitude is not a reliable tell", () => {
    const crop = { space: "source_pixels", left: 0, top: 0, width: 384, height: 384 };
    expect(identityPackManualCropRequestSchema.safeParse({ ...manualCropFixture(), crop }).success).toBe(false);
  });
});

describe("admin override request", () => {
  function overrideFixture(): Record<string, unknown> {
    return { packId: "pack_1", revision: 3, sourceContentHash: "a".repeat(64), reason: "support ticket 41" };
  }

  it("accepts a reason with no crop — the re-approval case", () => {
    const parsed = identityPackAdminOverrideRequestSchema.safeParse(overrideFixture());
    expect(parsed.success).toBe(true);
  });

  it("refuses an empty or whitespace-only reason", () => {
    // The override's whole value is the audit row it leaves; a blank reason is
    // indistinguishable from a mistake six months later.
    for (const reason of ["", "   ", undefined]) {
      expect(identityPackAdminOverrideRequestSchema.safeParse({ ...overrideFixture(), reason }).success).toBe(false);
    }
  });

  it("validates a submitted crop the same way an owner's is validated", () => {
    const crop = { space: "normalized", left: 0, top: 0, width: 1.5, height: 0.5 };
    expect(identityPackAdminOverrideRequestSchema.safeParse({ ...overrideFixture(), crop }).success).toBe(false);
  });
});

describe("admin batch request", () => {
  it("defaults to a dry run when the caller omits the flag", () => {
    const parsed = identityPackBatchRequestSchema.parse({ characterIds: ["char_1"] });
    expect(parsed.dryRun).toBe(true);
  });

  it("requires exactly one selector", () => {
    // Both would make "which characters did this run against?" unanswerable from
    // the report; neither would run an empty batch that reports success.
    expect(identityPackBatchRequestSchema.safeParse({ characterIds: ["char_1"], corpusId: "trial_a" }).success).toBe(
      false,
    );
    expect(identityPackBatchRequestSchema.safeParse({ dryRun: false }).success).toBe(false);
    expect(identityPackBatchRequestSchema.safeParse({ corpusId: "trial_a", dryRun: false }).success).toBe(true);
  });

  it("refuses an oversized selection rather than truncating it", () => {
    const ids = Array.from({ length: 201 }, (_, index) => `char_${index}`);
    expect(identityPackBatchRequestSchema.safeParse({ characterIds: ids }).success).toBe(false);
    expect(identityPackBatchRequestSchema.safeParse({ characterIds: ids.slice(0, 200) }).success).toBe(true);
  });

  it("rejects an empty id list and a fractional concurrency", () => {
    expect(identityPackBatchRequestSchema.safeParse({ characterIds: [] }).success).toBe(false);
    expect(identityPackBatchRequestSchema.safeParse({ characterIds: ["char_1"], concurrency: 2.5 }).success).toBe(false);
  });
});
