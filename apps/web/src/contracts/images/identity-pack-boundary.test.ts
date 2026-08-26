import { imageIdentityPackQualitySchema, imageIdentityPackV1Schema } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";

/**
 * Identity-pack schemas live in `@vesper/image-core`; `parseOr` and the
 * diagnostic collector are the shared foundation, reached through the
 * application's own barrels (docs/resilience.md §1). These cases sit on the seam
 * between them: a malformed jsonb column degrades to null with a diagnostic
 * instead of throwing into a render route.
 *
 * They are here rather than in a package because the trust boundary is the
 * APPLICATION's — this is a database column, and `image-core` deliberately owns
 * no boundary parsing.
 */

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

describe("identity-pack boundary parsing", () => {
  it("degrades malformed quality jsonb to null with a diagnostic instead of throwing", () => {
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
