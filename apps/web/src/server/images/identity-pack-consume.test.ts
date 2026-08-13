import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  imageReferencePolicySchema,
  type EvaluateIdentityPackResult,
  type IdentityReferenceCandidate,
  type IdentityReferenceProvenance,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { identityCandidateFixture as candidate, identityProvenanceFixture as record } from "@/server/test-support";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>();
  return { ...actual, readImageBytes: vi.fn() };
});
vi.mock("./identity-pack-references", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity-pack-references")>();
  return { ...actual, evaluateIdentityPackForProfile: vi.fn() };
});

import { db } from "../db";
import { readImageBytes } from "./assets";
import { evaluateIdentityPackForProfile } from "./identity-pack-references";
import { identityPackRenderReferences } from "./identity-pack-consume";

const mockEvaluate = vi.mocked(evaluateIdentityPackForProfile);
const mockReadBytes = vi.mocked(readImageBytes);

/** Sequential owned-row reads: each entry answers one `db().select()...limit(1)`. */
const rowQueue: unknown[][] = [];

beforeEach(() => {
  vi.resetAllMocks();
  rowQueue.length = 0;
  vi.mocked(db).mockImplementation(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rowQueue.shift() ?? []),
    };
    return chain as unknown as ReturnType<typeof db>;
  });
});

const resolvedProfile = (): ResolvedImageProfile => ({
  model: imageModelSchema.parse({
    id: "mdl",
    slug: "vendor/model",
    label: "Model",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
  }),
  profile: imageModelProfileSchema.parse({
    id: "prf",
    imageModelId: "mdl",
    key: "variant-standard",
    label: "Variant",
    task: "variant",
    operation: "edit",
    promptStrategy: "instruction_edit",
    referencePolicy: imageReferencePolicySchema.parse({
      requiredRoles: ["identity"],
      identityStrategy: "canonical_then_face_detail",
    }),
  }),
});

const eligible = (
  entries: [IdentityReferenceCandidate, IdentityReferenceProvenance][],
): EvaluateIdentityPackResult => ({
  eligible: true,
  candidates: entries.map(([c]) => c),
  provenance: entries.map(([, p]) => p),
  warnings: [],
});

const baseInput = () => ({
  ownerId: "user1",
  characterId: "charaaaaaaaaaaaaaaaaaaaa",
  profile: resolvedProfile(),
});

describe("identityPackRenderReferences", () => {
  it("evaluates under the profile's declared strategy with the render purpose, before any byte read", async () => {
    mockEvaluate.mockResolvedValue({ eligible: false, code: "profile_ineligible", messageKey: "images.identity_pack.profile_ineligible.no_roles" });
    const result = await identityPackRenderReferences(baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("profile_ineligible");
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "canonical_then_face_detail", purpose: "identity_render" }),
    );
    // Refusal before spend: an ineligible pack causes zero reads.
    expect(mockReadBytes).not.toHaveBeenCalled();
    expect(vi.mocked(db)).not.toHaveBeenCalled();
  });

  it("passes a pack failure code through unchanged (stale, missing, unusable — the lane's error names it)", async () => {
    mockEvaluate.mockResolvedValue({ eligible: false, code: "source_missing", messageKey: "images.identity_pack.source_missing" });
    const result = await identityPackRenderReferences(baseInput());
    expect(result).toEqual({ ok: false, code: "source_missing", error: expect.stringContaining("source_missing") as unknown });
  });

  it("maps candidates in plan order with bytes, parallel provenance, and the row's upload origin", async () => {
    mockEvaluate.mockResolvedValue(
      eligible([
        [candidate("canonical_identity", true, "imgportrait"), record("canonical_identity", "imgportrait")],
        [candidate("face_detail", false, "imgfacecrop"), record("face_detail", "imgfacecrop")],
      ]),
    );
    rowQueue.push([{ id: "imgportrait", meta: { source: "upload" } }], [{ id: "imgfacecrop", meta: {} }]);
    const portrait = Buffer.from("portrait");
    const crop = Buffer.from("crop");
    mockReadBytes.mockResolvedValueOnce(portrait).mockResolvedValueOnce(crop);

    const result = await identityPackRenderReferences(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references.map((entry) => entry.reference.role)).toEqual(["identity", "identity"]);
    expect(result.references.map((entry) => entry.reference.sourceImageId)).toEqual(["imgportrait", "imgfacecrop"]);
    expect(result.references.map((entry) => entry.reference.required)).toEqual([true, false]);
    expect(result.references.map((entry) => entry.reference.priority)).toEqual([2, 1]);
    expect(result.references.map((entry) => entry.reference.buffer)).toEqual([portrait, crop]);
    expect(result.references.map((entry) => entry.source)).toEqual(["uploaded", "generated"]);
    expect(result.provenance.map((entry) => entry.imageId)).toEqual(["imgportrait", "imgfacecrop"]);
  });

  it("refuses when a REQUIRED candidate's bytes cannot be read, with the fetch diagnostic", async () => {
    mockEvaluate.mockResolvedValue(
      eligible([[candidate("canonical_identity", true, "imgportrait"), record("canonical_identity", "imgportrait")]]),
    );
    rowQueue.push([]); // owned/ready read misses
    const sink = new DiagnosticCollector();
    const result = await identityPackRenderReferences({ ...baseInput(), sink });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("reference_fetch_failed");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.reference_fetch_failed");
  });

  it("omits an unreadable OPTIONAL candidate loudly and records provenance only for what is sent", async () => {
    mockEvaluate.mockResolvedValue(
      eligible([
        [candidate("canonical_identity", true, "imgportrait"), record("canonical_identity", "imgportrait")],
        [candidate("face_detail", false, "imgfacecrop"), record("face_detail", "imgfacecrop")],
      ]),
    );
    rowQueue.push([{ id: "imgportrait", meta: {} }], []); // crop row gone
    mockReadBytes.mockResolvedValueOnce(Buffer.from("portrait"));
    const sink = new DiagnosticCollector();

    const result = await identityPackRenderReferences({ ...baseInput(), sink });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references.map((entry) => entry.reference.sourceImageId)).toEqual(["imgportrait"]);
    expect(result.provenance.map((entry) => entry.imageId)).toEqual(["imgportrait"]);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.reference_fetch_failed");
  });
});
