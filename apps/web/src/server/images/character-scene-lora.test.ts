import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ImageModel,
  imageModelProfileSchema,
  imageModelSchema,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { sceneStagingById } from "@/contracts/images/scene-staging";
import { emptyCharacterProfile } from "@/contracts/world/profile";

/**
 * The chat lane's half of the intimate-scene LoRA route: which renders leave
 * `renderCharacterSceneImage` carrying a resolved binding, and — just as
 * load-bearing — which leave EXACTLY as they did before this route existed.
 *
 * `renderResolvedScene` is mocked so each case reads the request the lane
 * assembled, which is the thing under test. The route module itself is real; its
 * two IO collaborators (the model registry and the LoRA library) are mocked, so
 * a degradation leg here is the same code path production takes.
 */

vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn(() => false), hasReplicate: vi.fn(() => true), classifyImageFailure: vi.fn() };
});
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("../events", () => ({ logEvent: vi.fn() }));
vi.mock("./asset-deletion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-deletion")>();
  return { ...actual, deleteOwnedImage: vi.fn() };
});
vi.mock("./asset-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-storage")>();
  return { ...actual, imageMeta: vi.fn(), readImageBytes: vi.fn() };
});
vi.mock("./chat-look", () => ({ latestChatLook: vi.fn() }));
vi.mock("./identity-pack-consume", () => ({ identityPackRenderReferences: vi.fn() }));
vi.mock("./model-profiles", () => ({ resolveImageProfileForTask: vi.fn() }));
vi.mock("./scene", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scene")>();
  return { ...actual, composeSceneSpec: vi.fn(), renderResolvedScene: vi.fn() };
});
vi.mock("./models", () => ({ loadImageModels: vi.fn() }));
vi.mock("./image-loras", () => ({ resolveImageLoraForRender: vi.fn() }));
vi.mock("@/server/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logDiagnostics: vi.fn(),
}));

import { logDiagnostics } from "@/server/log";
import { classifyImageFailure } from "../ai";
import { db } from "../db";
import { deleteOwnedImage } from "./asset-deletion";
import { imageMeta } from "./asset-storage";
import { renderCharacterSceneImage, type SceneCastMember } from "./character-scene";
import { latestChatLook } from "./chat-look";
import { resolveImageLoraForRender } from "./image-loras";
import { resolveImageProfileForTask } from "./model-profiles";
import { loadImageModels } from "./models";
import { emptySceneRenderPlan, type SceneRenderPlan } from "./prompts-scene-plan";
import { composeSceneSpec, renderResolvedScene, type RenderResolvedSceneInput } from "./scene";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_MODEL_SLUG } from "./scene-lora";

const mockRender = vi.mocked(renderResolvedScene);
const mockCompose = vi.mocked(composeSceneSpec);
const mockModels = vi.mocked(loadImageModels);
const mockResolveLora = vi.mocked(resolveImageLoraForRender);

const binding = {
  id: INTIMATE_SCENE_LORA_ID,
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locator: "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor",
  scale: 1,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
};

/**
 * The intimate model's REGISTERED row — the same base model the picker offers,
 * but the copy that declares the two LoRA controls the weights resolve against.
 */
function intimateModel(): ImageModel {
  return imageModelSchema.parse({
    id: "imgmdlqwen2511aaaaaaaaaa",
    slug: INTIMATE_SCENE_LORA_MODEL_SLUG,
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    probedVersionId: "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729",
    advancedCapabilities: {
      controls: {
        loraWeights: { field: "lora_weights", type: "string" },
        loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
      },
    },
  });
}

const stockProfile: ResolvedImageProfile = {
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

const member: SceneCastMember = {
  characterId: "chr-mira",
  name: "Mira",
  profile: emptyCharacterProfile(),
  identityImageId: "img-avatar",
  lookKey: "look-1",
};

function plan(stagingId?: string): SceneRenderPlan {
  const base: SceneRenderPlan = {
    ...emptySceneRenderPlan(),
    focal: { name: "Mira", action: "sitting", outfitSummary: "" },
  };
  if (stagingId === undefined) return base;
  const staging = sceneStagingById(stagingId);
  if (!staging) throw new Error(`fixture names a staging the registry does not have: ${stagingId}`);
  return { ...base, staging };
}

async function render(overrides: Parameters<typeof renderCharacterSceneImage>[0] extends infer T ? Partial<T> : never) {
  return await renderCharacterSceneImage({
    characterId: "chr-mira",
    userId: "usr-1",
    cast: [member],
    chatId: "cht-1",
    ...overrides,
  });
}

/** Every diagnostic code the lane replayed into the process log. */
function loggedCodes(): string[] {
  return vi
    .mocked(logDiagnostics)
    .mock.calls.flatMap(([, items]) => items.map((item) => item.code));
}

/** The request the lane handed the renderer on attempt `index`. */
function requestAt(index: number): RenderResolvedSceneInput {
  const call = mockRender.mock.calls[index]?.[0];
  if (!call) throw new Error(`no render attempt at index ${index}`);
  return call;
}

/** Everything about a request except the per-call closure the comparison cannot see. */
function comparable(request: RenderResolvedSceneInput): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...request };
  delete copy.logResult;
  return copy;
}

/** A `db()` whose single-row reads answer from `rows` — the selfie lane's failure check. */
function stubDb(rows: unknown[]): void {
  vi.mocked(db).mockImplementation(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return chain as unknown as ReturnType<typeof db>;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CIVITAI_API_TOKEN = "civitai-test-token-value";
  // No failed row by default: a selfie's first attempt succeeded and nothing retries.
  stubDb([]);
  vi.mocked(resolveImageProfileForTask).mockResolvedValue(stockProfile);
  vi.mocked(latestChatLook).mockResolvedValue({ imageId: "img-look", buffer: Buffer.from("look") });
  mockCompose.mockResolvedValue(plan("lying_beneath_viewer"));
  mockRender.mockResolvedValue("img-scene");
  mockModels.mockResolvedValue([intimateModel()]);
  mockResolveLora.mockResolvedValue({ ok: true, binding });
});

describe("the intimate staged render", () => {
  it("runs on the intimate model, carrying the resolved binding", async () => {
    await render({});
    const request = requestAt(0);
    expect(request.profile?.model.slug).toBe(INTIMATE_SCENE_LORA_MODEL_SLUG);
    // The lane's own profile row rides unchanged — same task, same policy, same
    // strategy; the pairing replaces only the model object, with the registry
    // row that declares the LoRA controls.
    expect(request.profile?.profile).toBe(stockProfile.profile);
    expect(request.profile?.model.advancedCapabilities.controls.loraWeights).toBeDefined();
    expect(request.resolvedLora).toEqual(binding);
    // The queue passes no sink, so the lane replays the route's diagnostics
    // itself — otherwise nothing would record which renders took the LoRA.
    expect(loggedCodes()).toContain("images.scene_render.lora_route");
  });

  it("still renders on the stock model when a leg is missing", async () => {
    // One leg stands for all four: the model row is absent from the registry.
    // The point of the case is the FALLBACK — the request is the stock one, with
    // the lane's own resolved profile and no weights, not a failure.
    mockModels.mockResolvedValue([]);
    await render({});
    const request = requestAt(0);
    expect(request.profile).toBe(stockProfile);
    expect("resolvedLora" in request).toBe(false);
    expect(loggedCodes()).toContain("images.scene_render.lora_unavailable");
  });

  it("degrades identically when the deployment has no Civitai credential", async () => {
    delete process.env.CIVITAI_API_TOKEN;
    await render({});
    expect(requestAt(0).profile).toBe(stockProfile);
    expect("resolvedLora" in requestAt(0)).toBe(false);
    expect(loggedCodes()).toContain("images.scene_render.lora_unavailable");
  });
});

describe("every other render is what it was", () => {
  it("leaves an unstaged scene byte-identical whether or not the LoRA exists", async () => {
    // Rendered TWICE — once with the registered model and the library row
    // present, once with neither — and the two requests must be
    // indistinguishable. That is the pin: the route's machinery may not change a
    // render it does not claim.
    mockCompose.mockResolvedValue(plan());
    await render({});
    const withLibrary = comparable(requestAt(0));

    mockRender.mockClear();
    mockModels.mockResolvedValue([]);
    mockResolveLora.mockResolvedValue({ ok: false, code: "image_lora.unreachable_configuration", message: "gone" });
    await render({});

    expect(comparable(requestAt(0))).toEqual(withLibrary);
    expect("resolvedLora" in requestAt(0)).toBe(false);
    expect(requestAt(0).profile).toBe(stockProfile);
    // Nothing was even asked: an ordinary scene pays no registry read, and
    // reports nothing — a "no LoRA today" line on every scene is noise.
    expect(mockModels).not.toHaveBeenCalled();
    expect(loggedCodes()).toEqual([]);
  });

  it("leaves a NON-intimate staged scene on the stock model", async () => {
    mockCompose.mockResolvedValue(plan("held_from_behind"));
    await render({});
    expect(requestAt(0).profile).toBe(stockProfile);
    expect("resolvedLora" in requestAt(0)).toBe(false);
    expect(mockModels).not.toHaveBeenCalled();
  });

  it("leaves a selfie on the stock model even when its plan is staged", async () => {
    // Selfie framing suppresses the staged sentence, so the weights that draw
    // the act would be riding a prompt that never describes it.
    await render({ flavor: "selfie" });
    expect(requestAt(0).profile).toBe(stockProfile);
    expect("resolvedLora" in requestAt(0)).toBe(false);
  });
});

describe("the content-rejection retry", () => {
  it("renders LoRA-free: its plan has no staging and its rung is not uncensored", async () => {
    // Today the sanitize retry is the selfie lane's alone, so this case drives
    // it there. What it pins is the retry's own facts — a stripped plan and a
    // cleared `allowIntimate` — which is why no rule about the LoRA is needed
    // for the retry to stay off it.
    vi.mocked(imageMeta).mockReturnValue({ error: "flagged as sensitive" });
    vi.mocked(classifyImageFailure).mockReturnValue("content_rejection");
    stubDb([{ status: "failed", meta: { error: "flagged as sensitive" } }]);
    mockRender.mockResolvedValueOnce("img-first").mockResolvedValueOnce("img-second");

    const imageId = await render({ flavor: "selfie" });

    expect(imageId).toBe("img-second");
    expect(deleteOwnedImage).toHaveBeenCalledWith("img-first", "usr-1", { kind: "scene" });
    const retry = requestAt(1);
    expect(retry.plan.staging).toBeUndefined();
    expect(retry.references.every((reference) => reference.allowForIntimate === false)).toBe(true);
    expect("resolvedLora" in retry).toBe(false);
    expect(retry.profile).toBe(stockProfile);
  });
});
