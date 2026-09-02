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
  LANE_PROBE_IMAGE_ID,
  LANE_PROBE_NAME,
  LANE_PROBE_SECOND_IMAGE_ID,
  LANE_PROBE_SECOND_NAME,
  laneProbeCastSceneRender,
} from "@/server/test-support";

/**
 * `meta.identityReferences` honesty (identity packs 5B, codex review): the row
 * records provenance ONLY for identity references that actually reached the
 * provider. A refused render (failedPrecondition) records none — the row is
 * failed before anything is sent — and a capacity trim or a fallback rung drops
 * the entries whose bytes never travelled.
 *
 * Every case renders the probe's two-person scene over a REAL compiled program,
 * on an endpoint bound for the scene task: a rung that compiles no program is
 * dropped from the chain, so an unbound fixture would never reach the intent.
 * That also makes this the one end-to-end suite that reads a compiled scene
 * prompt beside the references its rung actually sent, which is where the
 * reference-payload invariant at the bottom lives.
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
import { renderResolvedScene, type RenderResolvedSceneInput } from "./scene";

const mockPipeline = vi.mocked(runImagePipeline);
const mockIntent = vi.mocked(renderImageIntent);

const pipelineCalls: ImagePipelineOptions[] = [];
/** Each `db().select()...limit()` answers from here, in call order. */
const rowQueue: unknown[][] = [];
/** Every `db().update().set(payload)` lands here — the meta-correction writes. */
const updateCalls: Record<string, unknown>[] = [];

const MODEL_SLUG = "qwen/qwen-image-edit-2511";

/**
 * The bound scene endpoint — Qwen Edit 2511, a numbered-image dialect — as an
 * edit-capable model of the given reference capacity, so `multi_edit → edit` is
 * the real chain. The policy allows identity references and nothing else, which
 * is what lets planning drop a reference the lane offered.
 */
function sceneProfile(maxReferences: number): ResolvedImageProfile {
  return {
    model: imageModelSchema.parse({
      id: "mdl-2511",
      slug: MODEL_SLUG,
      label: "Qwen Image Edit 2511",
      canGenerate: false,
      canEdit: true,
      editKind: "instruction_edit",
      identityPreservation: "strong",
      referenceArity: "array",
      maxReferences,
    }),
    profile: imageModelProfileSchema.parse({
      id: "prf",
      imageModelId: "mdl-2511",
      key: "scene-standard",
      label: "scene",
      task: "scene",
      operation: "edit",
      promptStrategy: "instruction_edit",
      referencePolicy: imageReferencePolicySchema.parse({ requiredRoles: ["identity"] }),
    }),
  };
}

const profile = sceneProfile(2);

/** A third person's anchor — nobody in the cast, so it only ever competes for a slot. */
const strangerRef = (imageId: string): SceneVisualReference => ({
  kind: "character",
  name: "Wren",
  role: "other",
  allowForIntimate: true,
  imageId,
  source: "generated",
});

/** The place's anchor, behind the people the way the queue orders it. */
const placeRef = (imageId: string): SceneVisualReference => ({
  kind: "location",
  name: "the study",
  role: "location",
  allowForIntimate: true,
  imageId,
  source: "generated",
});

const baseInput = (overrides: Partial<RenderResolvedSceneInput>): RenderResolvedSceneInput => ({
  ...laneProbeCastSceneRender(),
  mode: "multi",
  profile,
  linkage: { ownerId: "user1" },
  logResult: vi.fn(),
  ...overrides,
});

/** The probe scene plus one more reference and its bytes. */
function withExtraReference(extra: SceneVisualReference, bytes: string): Partial<RenderResolvedSceneInput> {
  const scene = laneProbeCastSceneRender();
  return {
    references: [...scene.references, extra],
    referenceBuffers: new Map([...scene.referenceBuffers, [extra.imageId ?? "", Buffer.from(bytes)]]),
  };
}

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
        identityProvenance: [record("canonical_identity", LANE_PROBE_IMAGE_ID)],
        failedPrecondition: "identity references unavailable for Ilsa",
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
        ...withExtraReference(strangerRef("imgC"), "c"),
        identityProvenance: [record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID), record("canonical_identity", "imgC")],
      }),
    );
    const meta = pipelineCalls[0]?.asset.meta;
    expect(meta?.identityReferences).toEqual([record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID)]);
    expect(updateCalls).toHaveLength(0); // primary rung won — the reserve-time record stands
  });

  it("a fallback to the single-reference rung rewrites the row to what that rung actually sent", async () => {
    // multi_edit fails outright (non-transient), the edit rung succeeds sending
    // only the primary anchor — whose provenance is not pack-sourced here.
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([
      { meta: { model: `replicate/${MODEL_SLUG}`, identityReferences: [record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID)] } },
    ]);

    await renderResolvedScene(
      baseInput({ identityProvenance: [record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID)] }),
    );
    // Reserved against the multi_edit plan: the second anchor was going to travel.
    expect(pipelineCalls[0]?.asset.meta?.identityReferences).toEqual([record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID)]);
    // The surviving edit rung sent the primary anchor alone, so the correction removes the claim.
    const corrected = updateCalls[0];
    expect(corrected).toBeDefined();
    const correctedMeta = corrected?.meta as Record<string, unknown>;
    expect("identityReferences" in correctedMeta).toBe(false);
  });

  it("an exhausted chain still records the LAST rung's attempt on the failed row", async () => {
    // The failure the row's error text describes is the last rung's — its
    // prediction id is what an operator traces, so the failed row keeps it.
    const attempt = (predictionId: string): ResolvedImageAttempt => ({
      modelId: "mdl-2511",
      modelSlug: MODEL_SLUG,
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

    await renderResolvedScene(baseInput({}));
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
   * It is also this file's end-to-end multi-subject scene (#256): a cast of two,
   * each realized from their own committed cut, folded into one digest and
   * compiled into one prompt. A seam that could only carry the focal would fail
   * here rather than silently describing one woman for a payload carrying two
   * faces.
   */
  it("a fallback correction replaces the reserve-time program provenance with the winning rung's", async () => {
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([
      {
        meta: {
          model: `replicate/${MODEL_SLUG}`,
          [IMAGE_PROMPT_PROGRAM_META_KEY]: { stale: true },
        },
      },
    ]);

    await renderResolvedScene(baseInput({}));

    // Reserved beside the primary (multi_edit) rung's compiled prompt.
    const reservedPrompt = pipelineCalls[0]?.asset.prompt as string;
    expect(
      parseImagePromptProgramProvenance(pipelineCalls[0]?.asset.meta?.[IMAGE_PROMPT_PROGRAM_META_KEY]),
    ).not.toBeNull();
    // Both people are in the one prompt — the whole cast compiled, not the focal.
    expect(reservedPrompt).toContain(LANE_PROBE_NAME);
    expect(reservedPrompt).toContain(LANE_PROBE_SECOND_NAME);

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
    rowQueue.push([{ meta: { model: `replicate/${MODEL_SLUG}` } }]);

    await renderResolvedScene(
      baseInput({
        identityProvenance: [
          record("canonical_identity", LANE_PROBE_IMAGE_ID),
          record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID),
        ],
      }),
    );
    const correctedMeta = updateCalls[0]?.meta as Record<string, unknown>;
    expect(correctedMeta.identityReferences).toEqual([record("canonical_identity", LANE_PROBE_IMAGE_ID)]);
  });
});

/**
 * The one-reference-path invariant at the lane's transport seam: the references
 * a rung hands `renderImageIntent` are exactly the slots its compiled prompt
 * numbers — the same images, in the prompt's order, and nothing the prompt does
 * not account for.
 *
 * Falsified against the rung's previous send, which re-derived a list from the
 * lane's own order and left every drop to the transport: offered a place the
 * profile's policy disallows, it handed the intent three references under a
 * prompt that numbered two. The transport then planned the three down to the
 * same two, which is exactly why nothing noticed — the agreement was a
 * coincidence of two call sites reducing the same list. The rung now sends the
 * program's own planned list, and this pins the payload as a property of the
 * prompt rather than of that coincidence.
 */
describe("renderResolvedScene reference payload", () => {
  it("sends the multi rung exactly the slots its prompt numbers, in the prompt's order", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    await renderResolvedScene(
      baseInput({
        // Capacity for all three, so only the policy can leave one out.
        profile: sceneProfile(3),
        ...withExtraReference(placeRef("img-place"), "place"),
      }),
    );

    const prompt = pipelineCalls[0]?.asset.prompt as string;
    const numbered = [...prompt.matchAll(/Image (\d+) shows ([A-Za-z]+)/g)].map((match) => [Number(match[1]), match[2]]);
    expect(numbered).toEqual([
      [1, LANE_PROBE_NAME],
      [2, LANE_PROBE_SECOND_NAME],
    ]);

    const sent = mockIntent.mock.calls[0]?.[0].references ?? [];
    expect(sent.map((reference) => reference.sourceImageId)).toEqual([LANE_PROBE_IMAGE_ID, LANE_PROBE_SECOND_IMAGE_ID]);
    expect(sent.map((reference) => reference.role)).toEqual(["identity", "identity"]);
  });
});
