import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  imageReferencePolicySchema,
  parseImagePromptProgramProvenance,
  IMAGE_PROMPT_PROGRAM_META_KEY,
  type ResolvedImageAttempt,
  type ResolvedImageProfile,
  type SceneVisualReference,
} from "@vesper/image-core";
import {
  identityProvenanceFixture as record,
  LANE_PROBE_SECOND_SUBJECT_ID,
  LANE_PROBE_SUBJECT_ID,
  laneProbeCastScenePlan,
  laneProbeCastSubjects,
} from "@/server/test-support";

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
import { emptySceneRenderPlan } from "./prompts-scene-plan";
import { renderResolvedScene, type RenderResolvedSceneInput } from "./scene";
import { applySceneCastVisual } from "./scene-subject-visual";

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

/**
 * The same shape on a BOUND endpoint, so the prompt-program cutover actually
 * compiles. `vendor/model` above is deliberately unbound: every other case in
 * this file is about identity provenance, which the cutover does not touch, and
 * leaving them unbound keeps them exercising the legacy path they were written
 * for.
 */
const boundProfile: ResolvedImageProfile = {
  model: imageModelSchema.parse({
    id: "mdl-2511",
    slug: "qwen/qwen-image-edit-2511",
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
    referenceArity: "array",
    maxReferences: 2,
  }),
  profile: profile.profile,
};

/** The two-person cast, realized from their own committed cuts — #256. */
const castVisuals = applySceneCastVisual({
  plan: laneProbeCastScenePlan(laneProbeCastSubjects().map((subject) => subject.member)),
  members: laneProbeCastSubjects(),
}).visuals;

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
   * Codex P1 (PR #381), carried over to the cutover: the reserve-time row
   * records the PRIMARY rung's compiled program, and the fallback correction
   * rewrites the row to the winning rung — so it must replace that provenance
   * too. A row that kept the primary's `meta.promptProgram` beside the winning
   * rung's prompt would claim a world state and a program fingerprint that
   * describe a different render, which is exactly what provenance exists to
   * prevent. Pinned as: the corrected prompt differs from the reserved one, the
   * corrected row carries parseable program provenance, and the stale fragment
   * that was on the row did not survive the merge.
   *
   * It is also this file's one end-to-end multi-subject scene (#256): a cast
   * of two, each realized from their own committed cut, folded into one digest
   * and compiled into one prompt. A seam that could only carry the focal would
   * fail here rather than silently describing one woman for a payload carrying
   * two faces.
   */
  it("a fallback correction replaces the reserve-time program provenance with the winning rung's", async () => {
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([
      {
        meta: {
          model: "replicate/vendor/model",
          [IMAGE_PROMPT_PROGRAM_META_KEY]: { stale: true },
        },
      },
    ]);

    await renderResolvedScene(
      baseInput({
        profile: boundProfile,
        references: [
          { ...characterRef("Nyx", "imgA"), entityId: LANE_PROBE_SUBJECT_ID },
          { ...characterRef("Ilsa", "imgB"), entityId: LANE_PROBE_SECOND_SUBJECT_ID },
        ],
        referenceBuffers: new Map([
          ["imgA", Buffer.from("a")],
          ["imgB", Buffer.from("b")],
        ]),
        cast: castVisuals,
      }),
    );

    // Reserved beside the primary (multi_edit) rung's compiled prompt.
    const reservedPrompt = pipelineCalls[0]?.asset.prompt as string;
    expect(
      parseImagePromptProgramProvenance(pipelineCalls[0]?.asset.meta?.[IMAGE_PROMPT_PROGRAM_META_KEY]),
    ).not.toBeNull();
    // Both people are in the one prompt — the whole cast compiled, not the focal.
    expect(reservedPrompt).toContain("Nyx");
    expect(reservedPrompt).toContain("Ilsa");

    // The corrected row describes the WINNING rung: a different compiled prompt,
    // its own parseable provenance, and no trace of the stale fragment.
    const corrected = updateCalls[0];
    expect(corrected).toBeDefined();
    const correctedPrompt = corrected?.prompt as string;
    expect(correctedPrompt).not.toBe(reservedPrompt);
    const correctedMeta = corrected?.meta as Record<string, unknown>;
    const provenance = parseImagePromptProgramProvenance(correctedMeta[IMAGE_PROMPT_PROGRAM_META_KEY]);
    expect(provenance).not.toBeNull();
    expect(correctedMeta[IMAGE_PROMPT_PROGRAM_META_KEY]).not.toMatchObject({ stale: true });
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
