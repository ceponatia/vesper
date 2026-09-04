import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageModelProfileSchema, imageModelSchema, type ResolvedImageProfile } from "@vesper/image-core";
import { laneProbeCastSceneRender } from "@/server/test-support";

/**
 * What the scene renderer DOES with a caller-resolved LoRA: it rides every rung
 * of the attempt chain, and the row records which weights drew the picture.
 *
 * The transport is mocked at `renderImageIntent`, so each case reads the intent
 * that would have been sent. The row's `meta` is read off the reserve call, which
 * is where the model and the shot are already written.
 *
 * Every case renders a real two-person scene over a compiled program — the
 * intimate model's slug is bound for the scene task — because a rung that
 * compiles no program is dropped from the chain and never reaches the intent at
 * all.
 */

vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn(() => false), classifyImageFailure: vi.fn(() => "other") };
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

import { db } from "../db";
import { runImagePipeline, type ImagePipelineOptions, type ImageRow } from "./assets";
import { renderImageIntent } from "./render-intent";
import { renderResolvedScene, type RenderResolvedSceneInput } from "./scene";

const mockPipeline = vi.mocked(runImagePipeline);
const mockIntent = vi.mocked(renderImageIntent);

const pipelineCalls: ImagePipelineOptions[] = [];

const binding = {
  id: "imglorqwennsfwallinclv20",
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locator: "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor",
  scale: 1,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
};

/** The intimate model paired with the lane's scene profile — what the route hands back. */
const intimateProfile: ResolvedImageProfile = {
  model: imageModelSchema.parse({
    id: "imgmdlqwen2511aaaaaaaaaa",
    slug: "qwen/qwen-image-edit-2511",
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
  }),
  profile: imageModelProfileSchema.parse({
    id: "imgprfqwen2511sceneaaaaa",
    imageModelId: "imgmdlqwen2511aaaaaaaaaa",
    key: "scene-standard",
    label: "Scene Standard",
    task: "scene",
    operation: "edit",
    promptStrategy: "instruction_edit",
  }),
};

function input(overrides: Partial<RenderResolvedSceneInput> = {}): RenderResolvedSceneInput {
  return {
    ...laneProbeCastSceneRender(),
    mode: "multi",
    profile: intimateProfile,
    linkage: { ownerId: "usr-1" },
    logResult: vi.fn(),
    ...overrides,
  };
}

/** The same request with the route's binding on it — what an intimate staged render sends. */
function loraInput(overrides: Partial<RenderResolvedSceneInput> = {}): RenderResolvedSceneInput {
  return { ...input(overrides), resolvedLora: binding };
}

beforeEach(() => {
  vi.resetAllMocks();
  pipelineCalls.length = 0;
  vi.mocked(db).mockImplementation(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([]),
      insert: () => chain,
      values: () => Promise.resolve([]),
      update: () => chain,
      set: () => ({ where: () => Promise.resolve([]) }),
    };
    return chain as unknown as ReturnType<typeof db>;
  });
  mockPipeline.mockImplementation(async (opts) => {
    pipelineCalls.push(opts);
    const produced = await opts.produce({ id: "img1" } as unknown as ImageRow);
    return { imageId: "img1", status: produced.ok ? "ready" : "failed" };
  });
  mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
});

describe("a scene render carrying a resolved LoRA", () => {
  it("hands the binding to the provider intent", async () => {
    await renderResolvedScene(loraInput());
    expect(mockIntent.mock.calls[0]?.[0].resolvedLora).toEqual(binding);
    expect(mockIntent.mock.calls[0]?.[0].profile.model.slug).toBe("qwen/qwen-image-edit-2511");
  });

  it("keeps it on the fallback rung — the chain is one model's ladder", async () => {
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    await renderResolvedScene(loraInput());
    expect(mockIntent).toHaveBeenCalledTimes(2);
    expect(mockIntent.mock.calls[1]?.[0].resolvedLora).toEqual(binding);
  });

  it("records the model and the LoRA id on the row, and never the locator", async () => {
    await renderResolvedScene(loraInput());
    const meta = pipelineCalls[0]?.asset.meta;
    // `modelFor` writes `replicate/<the row's own slug>`, and the intimate
    // model's registry slug carries no `:version` pin.
    expect(meta?.model).toBe("replicate/qwen/qwen-image-edit-2511");
    expect(meta?.lora).toBe("imglorqwennsfwallinclv20");
    expect(JSON.stringify(meta)).not.toContain("civitai.com");
  });
});

describe("a scene render without one", () => {
  it("sends an intent with no LoRA key at all", async () => {
    await renderResolvedScene(input());
    const intent = mockIntent.mock.calls[0]?.[0];
    expect(intent && "resolvedLora" in intent).toBe(false);
  });

  it("writes no lora key on the row", async () => {
    await renderResolvedScene(input());
    const meta = pipelineCalls[0]?.asset.meta;
    expect(meta && "lora" in meta).toBe(false);
  });
});
