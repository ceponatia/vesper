import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  imageReferencePolicySchema,
  type ResolvedImageAttempt,
  type ResolvedImageProfile,
  type SceneVisualReference,
} from "@vesper/image-core";
import { identityProvenanceFixture as record } from "@/server/test-support";

/**
 * `meta.identityReferences` honesty (identity packs 5B, codex review): the row
 * records provenance ONLY for identity references that actually reached the
 * provider. A refused render (failedPrecondition) records none — the row is
 * failed before anything is sent — and a capacity trim or a fallback rung drops
 * the entries whose bytes never travelled.
 */

vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn(), classifyImageFailure: vi.fn() };
});
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>();
  return { ...actual, runImagePipeline: vi.fn() };
});
vi.mock("./render-intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-intent")>();
  return { ...actual, renderImageIntent: vi.fn() };
});
vi.mock("@/server/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logDiagnostics: vi.fn(),
}));

import { classifyImageFailure, isDemoMode } from "../ai";
import { db } from "../db";
import { runImagePipeline, type ImagePipelineOptions, type ImageProduceResult, type ImageRow } from "./assets";
import { renderImageIntent } from "./render-intent";
import { IMAGE_SHADOW_MULTI_SUBJECT } from "./character-shadow";
import { emptySceneRenderPlan } from "./prompts-scene-plan";
import { renderResolvedScene, type RenderResolvedSceneInput } from "./scene";
import { IMAGE_SHADOW_COMPARISON_META_KEY, parseImageShadowComparison } from "./shadow-comparison";

const mockPipeline = vi.mocked(runImagePipeline);
const mockIntent = vi.mocked(renderImageIntent);

const pipelineCalls: ImagePipelineOptions[] = [];
/** Each `db().select()...limit()` answers from here, in call order. */
const rowQueue: unknown[][] = [];
/** Every `db().update().set(payload)` lands here — the meta-correction writes. */
const updateCalls: Record<string, unknown>[] = [];

/** An edit-capable two-reference model, so `multi_edit → edit` is the real chain. */
const profile: ResolvedImageProfile = {
  model: imageModelSchema.parse({
    id: "mdl",
    slug: "vendor/model",
    label: "Model",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
    referenceArity: "array",
    maxReferences: 2,
  }),
  profile: imageModelProfileSchema.parse({
    id: "prf",
    imageModelId: "mdl",
    key: "scene-standard",
    label: "scene",
    task: "scene",
    operation: "edit",
    promptStrategy: "instruction_edit",
    referencePolicy: imageReferencePolicySchema.parse({ requiredRoles: ["identity"] }),
  }),
};

const characterRef = (name: string, imageId: string): SceneVisualReference => ({
  kind: "character",
  name,
  role: "other",
  allowForIntimate: true,
  imageId,
  source: "generated",
});

const baseInput = (overrides: Partial<RenderResolvedSceneInput>): RenderResolvedSceneInput => ({
  plan: emptySceneRenderPlan(),
  references: [],
  referenceBuffers: new Map(),
  mode: "multi",
  profile,
  linkage: { ownerId: "user1" },
  logResult: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  pipelineCalls.length = 0;
  rowQueue.length = 0;
  updateCalls.length = 0;
  vi.mocked(isDemoMode).mockReturnValue(false);
  vi.mocked(classifyImageFailure).mockReturnValue("other");
  vi.mocked(db).mockImplementation(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rowQueue.shift() ?? []),
      insert: () => chain,
      values: () => Promise.resolve([]),
      update: () => chain,
      set: (payload: Record<string, unknown>) => {
        updateCalls.push(payload);
        return { where: () => Promise.resolve([]) };
      },
    };
    return chain as unknown as ReturnType<typeof db>;
  });
  // The reserve → precondition → produce shell, minus the database. afterReserve
  // is deliberately not invoked — reference-row writes are not under test here.
  mockPipeline.mockImplementation(async (opts) => {
    pipelineCalls.push(opts);
    if ((opts.failedPrecondition ?? null) !== null) return { imageId: "img1", status: "failed" };
    const produced = await opts.produce({ id: "img1" } as unknown as ImageRow);
    return { imageId: "img1", status: produced.ok ? "ready" : "failed" };
  });
});

describe("renderResolvedScene identity provenance", () => {
  it("a refused render (failedPrecondition) records NO identityReferences — nothing was sent", async () => {
    await renderResolvedScene(
      baseInput({
        references: [characterRef("Mira", "imgA"), characterRef("Nadia", "imgB")],
        referenceBuffers: new Map([
          ["imgA", Buffer.from("a")],
          ["imgB", Buffer.from("b")],
        ]),
        identityProvenance: [record("canonical_identity", "imgA")],
        failedPrecondition: "identity references unavailable for Nadia",
      }),
    );
    expect(mockIntent).not.toHaveBeenCalled();
    const meta = pipelineCalls[0]?.asset.meta;
    expect(meta && "identityReferences" in meta).toBe(false);
  });

  it("the primary attempt's send set is what persists — a capacity-trimmed anchor's provenance is dropped", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    await renderResolvedScene(
      baseInput({
        // Three anchors on a two-reference model: imgC never travels.
        references: [characterRef("Mira", "imgA"), characterRef("Nadia", "imgB"), characterRef("Wren", "imgC")],
        referenceBuffers: new Map([
          ["imgA", Buffer.from("a")],
          ["imgB", Buffer.from("b")],
          ["imgC", Buffer.from("c")],
        ]),
        identityProvenance: [record("canonical_identity", "imgB"), record("canonical_identity", "imgC")],
      }),
    );
    const meta = pipelineCalls[0]?.asset.meta;
    expect(meta?.identityReferences).toEqual([record("canonical_identity", "imgB")]);
    expect(updateCalls).toHaveLength(0); // primary rung won — the reserve-time record stands
  });

  it("a fallback to the single-reference rung rewrites the row to what that rung actually sent", async () => {
    // multi_edit fails outright (non-transient), the edit rung succeeds sending
    // only the primary anchor imgA — whose provenance is not pack-sourced here.
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([{ meta: { model: "replicate/vendor/model", identityReferences: [record("canonical_identity", "imgB")] } }]);

    await renderResolvedScene(
      baseInput({
        references: [characterRef("Mira", "imgA"), characterRef("Nadia", "imgB")],
        referenceBuffers: new Map([
          ["imgA", Buffer.from("a")],
          ["imgB", Buffer.from("b")],
        ]),
        identityProvenance: [record("canonical_identity", "imgB")],
      }),
    );
    // Reserved against the multi_edit plan: imgB was going to travel.
    expect(pipelineCalls[0]?.asset.meta?.identityReferences).toEqual([record("canonical_identity", "imgB")]);
    // The surviving edit rung sent imgA alone, so the correction removes imgB's claim.
    const corrected = updateCalls[0];
    expect(corrected).toBeDefined();
    const correctedMeta = corrected?.meta as Record<string, unknown>;
    expect("identityReferences" in correctedMeta).toBe(false);
  });

  it("an exhausted chain still records the LAST rung's attempt on the failed row", async () => {
    // The failure the row's error text describes is the last rung's — its
    // prediction id is what an operator traces, so the failed row keeps it.
    const attempt = (predictionId: string): ResolvedImageAttempt => ({
      modelId: "mdl",
      modelSlug: "vendor/model",
      profileId: "prf",
      task: "scene",
      promptStrategy: "instruction_edit",
      requestedVersionId: null,
      seed: null,
      appliedControls: {},
      droppedControls: [],
      sentReferenceRoles: ["identity"],
      predictionId,
      executedVersionId: null,
    });
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom", attempt: attempt("pred-multi") })
      .mockResolvedValueOnce({ ok: false, error: "edit boom", attempt: attempt("pred-edit") });
    // Capture what produce hands the pipeline — the failed row's meta channel.
    let produced: ImageProduceResult | undefined;
    mockPipeline.mockImplementation(async (opts) => {
      pipelineCalls.push(opts);
      produced = await opts.produce({ id: "img1" } as unknown as ImageRow);
      return { imageId: "img1", status: produced.ok ? "ready" : "failed" };
    });

    await renderResolvedScene(
      baseInput({
        references: [characterRef("Mira", "imgA"), characterRef("Nadia", "imgB")],
        referenceBuffers: new Map([
          ["imgA", Buffer.from("a")],
          ["imgB", Buffer.from("b")],
        ]),
      }),
    );
    expect(produced?.ok).toBe(false);
    // The deeper `edit` rung's attempt, not the primary `multi_edit` plan's.
    expect((produced?.meta?.render as ResolvedImageAttempt | undefined)?.predictionId).toBe("pred-edit");
  });

  /**
   * Codex P1 (PR #381): the reserve-time shadow record compares the PRIMARY
   * rung's request, and the fallback correction rewrites the row to the
   * winning rung — so it must replace the shadow record too. Pinned as: the
   * corrected row's record measures the corrected prompt (the winning rung's),
   * and the stale reserve-time fragment is gone; a row never pairs one rung's
   * prompt and model with another rung's verdict.
   */
  it("a fallback correction replaces the reserve-time shadow record with the winning rung's", async () => {
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([
      {
        meta: {
          model: "replicate/vendor/model",
          [IMAGE_SHADOW_COMPARISON_META_KEY]: { stale: true },
        },
      },
    ]);

    await renderResolvedScene(
      baseInput({
        references: [characterRef("Mira", "imgA"), characterRef("Nadia", "imgB")],
        referenceBuffers: new Map([
          ["imgA", Buffer.from("a")],
          ["imgB", Buffer.from("b")],
        ]),
        // The multi-subject marker: a deterministic recorded refusal whose
        // payload still measures the rung's own prompt — which is exactly what
        // distinguishes the primary's record from the winning rung's.
        shadow: { kind: "multi_subject", subjectIds: ["chr-a", "chr-b"] },
      }),
    );

    // Reserved beside the primary (multi_edit) rung's prompt.
    const reservedPrompt = pipelineCalls[0]?.asset.prompt as string;
    const reserved = parseImageShadowComparison(
      pipelineCalls[0]?.asset.meta?.[IMAGE_SHADOW_COMPARISON_META_KEY],
    );
    expect(reserved?.codes).toEqual([IMAGE_SHADOW_MULTI_SUBJECT]);
    expect(reserved?.payload.legacyChars).toBe(reservedPrompt.length);

    // The corrected row describes the WINNING rung: its shadow record measures
    // the corrected prompt, and the stale fragment did not survive the merge.
    const corrected = updateCalls[0];
    expect(corrected).toBeDefined();
    const correctedPrompt = corrected?.prompt as string;
    expect(correctedPrompt).not.toBe(reservedPrompt);
    const correctedMeta = corrected?.meta as Record<string, unknown>;
    const record = parseImageShadowComparison(correctedMeta[IMAGE_SHADOW_COMPARISON_META_KEY]);
    expect(record).not.toBeNull();
    expect(record?.codes).toEqual([IMAGE_SHADOW_MULTI_SUBJECT]);
    expect(record?.payload.legacyChars).toBe(correctedPrompt.length);
  });

  it("a pack-sourced PRIMARY anchor keeps its provenance across the same fallback", async () => {
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([{ meta: { model: "replicate/vendor/model" } }]);

    await renderResolvedScene(
      baseInput({
        references: [characterRef("Mira", "imgA"), characterRef("Nadia", "imgB")],
        referenceBuffers: new Map([
          ["imgA", Buffer.from("a")],
          ["imgB", Buffer.from("b")],
        ]),
        identityProvenance: [record("canonical_identity", "imgA"), record("canonical_identity", "imgB")],
      }),
    );
    const correctedMeta = updateCalls[0]?.meta as Record<string, unknown>;
    expect(correctedMeta.identityReferences).toEqual([record("canonical_identity", "imgA")]);
  });
});
