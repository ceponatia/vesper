import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateImageLoraForRender,
  type ImageLoraRenderBinding,
  type ImageModel,
  imageLoraSchema,
  imageModelProfileSchema,
  imageModelSchema,
  pinnedImageModelVersion,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import { DiagnosticCollector } from "@/contracts/diagnostics";

/**
 * THE INTIMATE ROUTE'S OWN DECISIONS (#663/#664): which model and which anatomy
 * weights a nude-by-design render takes, for every lane that makes one.
 *
 * The full matrix lives here, once. The lanes (`scene-lora.test.ts`,
 * `character-scene-lora.test.ts`, `variants.test.ts`,
 * `reference-view-build.test.ts`) prove only their connection to it.
 *
 * Two collaborators are mocked because they are IO and are tested where they
 * live — the model registry read and the library resolution. The policy lookup
 * is wrapped rather than replaced: every case reads the REAL reviewed table
 * except the two that need a listed model naming a curated row, which no model
 * does today.
 */

vi.mock("./models", () => ({ loadImageModels: vi.fn() }));
vi.mock("./image-loras", () => ({ resolveImageLoraForRender: vi.fn() }));
vi.mock("@/contracts/images/intimate-scene-lora", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contracts/images/intimate-scene-lora")>();
  return { ...actual, intimateRoutePolicyFor: vi.fn(actual.intimateRoutePolicyFor) };
});

import {
  INTIMATE_ROUTE_POLICIES,
  INTIMATE_SCENE_LORA_ID,
  INTIMATE_SCENE_LORA_MODEL_SLUG,
  intimateRoutePolicyFor,
} from "@/contracts/images/intimate-scene-lora";
import { resolveImageLoraForRender } from "./image-loras";
import { loadImageModels } from "./models";
import { INTIMATE_ROUTE_NO_ANATOMY_LORA_CODE, resolveIntimateRoute } from "./nsfw-lora";

const mockModels = vi.mocked(loadImageModels);
const mockResolveLora = vi.mocked(resolveImageLoraForRender);
const mockPolicy = vi.mocked(intimateRoutePolicyFor);

const PROBED_2511 = "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729";

/** The hosted checkpoint's Civitai model-version id — 0151's `probed_version_id`. */
const QWEN21_VERSION = "3352534";

/** A curated 2.1 anatomy row no deployment has yet: what a future policy entry would name. */
const QWEN21_LORA_ID = "imglorqwen21anatomyfixt";

/** The intimate model's REGISTERED row, carrying the two probed LoRA controls. */
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
    probedVersionId: PROBED_2511,
    advancedCapabilities: {
      controls: {
        loraWeights: { field: "lora_weights", type: "string" },
        loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
      },
    },
  });
}

/**
 * The Civitai Qwen Image 2.1 row as migration 0151 seeds it, with the owner's
 * reviewed ratings — the fields the route and the LoRA evaluator read.
 */
function qwen21Model(slug = CIVITAI_QWEN_IMAGE_21_SLUG): ImageModel {
  return imageModelSchema.parse({
    id: "imgmdlcivqwen21aaaaaaaa",
    slug,
    label: "Qwen Image 2.1 (Civitai)",
    canGenerate: true,
    canEdit: true,
    editKind: "multi_reference_compose",
    identityPreservation: "strong",
    referenceField: "images",
    referenceArity: "array",
    maxReferences: 10,
    probedVersionId: QWEN21_VERSION,
    advancedCapabilities: {
      controls: {
        loraWeights: { field: "civitai_lora_version", type: "string" },
        loraScale: { field: "civitai_lora_strength", type: "number", minimum: 0, maximum: 4 },
      },
    },
  });
}

/** A lane's resolved profile on `model` — the object the route is handed. */
function resolvedOn(model: ImageModel, task: "variant" | "scene" = "variant"): ResolvedImageProfile {
  return {
    model,
    profile: imageModelProfileSchema.parse({
      id: `imgprf${task}fixtureaaaa`,
      imageModelId: model.id,
      key: `${task}-standard`,
      label: `${task} standard`,
      task,
      operation: "edit",
      promptStrategy: "instruction_edit",
    }),
  };
}

/** A model the policy table does not list, beside the intimate model. */
function seedreamModel(): ImageModel {
  return imageModelSchema.parse({
    id: "imgmdlseedream45aaaaaaaa",
    slug: "bytedance/seedream-4.5",
    label: "Seedream 4.5",
    canGenerate: true,
    canEdit: true,
    editKind: "multi_reference_compose",
    identityPreservation: "strong",
    referenceField: "image_input",
    referenceArity: "array",
    maxReferences: 10,
  });
}

const BINDING_2511: ImageLoraRenderBinding = {
  id: INTIMATE_SCENE_LORA_ID,
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locator: "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor",
  scale: 1,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
};

const BINDING_QWEN21: ImageLoraRenderBinding = {
  id: QWEN21_LORA_ID,
  label: "Qwen 2.1 anatomy fixture",
  locator: "https://civitai.com/api/download/models/4400001",
  scale: 0.8,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
};

let savedToken: string | undefined;

beforeEach(() => {
  // Cleared, not reset: a reset would strip the policy wrapper's delegation to
  // the real table, and every case but two reads that table. Those two set a
  // one-shot answer, so nothing they set outlives them.
  vi.clearAllMocks();
  savedToken = process.env.CIVITAI_API_TOKEN;
  process.env.CIVITAI_API_TOKEN = "civitai-test-token-value";
  mockModels.mockResolvedValue([intimateModel()]);
  mockResolveLora.mockResolvedValue({ ok: true, binding: BINDING_2511 });
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.CIVITAI_API_TOKEN;
  else process.env.CIVITAI_API_TOKEN = savedToken;
});

describe("the reviewed intimate-route policy", () => {
  it("lists Civitai Qwen Image 2.1 alone, rendering on itself with no curated LoRA (owner ruling 2026-10-01)", () => {
    // An allowlist of models whose nude work skips the intimate model, so its
    // exact content is the contract. Keyed by the provider package's own slug
    // constant: a misspelt key would quietly send every 2.1 render back onto
    // 2511 and nothing else would notice.
    expect(INTIMATE_ROUTE_POLICIES).toEqual({
      [CIVITAI_QWEN_IMAGE_21_SLUG]: { anatomyLora: "optional", anatomyLoraId: null },
    });
  });

  it("finds a pinned spelling of a listed model, and nothing for an unlisted one", () => {
    expect(intimateRoutePolicyFor(`${CIVITAI_QWEN_IMAGE_21_SLUG}:${QWEN21_VERSION}`)).toEqual({
      anatomyLora: "optional",
      anatomyLoraId: null,
    });
    expect(intimateRoutePolicyFor(INTIMATE_SCENE_LORA_MODEL_SLUG)).toBeNull();
  });
});

describe("a model the policy does not list takes the intimate-model pairing, unchanged", () => {
  it("pairs the lane's profile with the registered 2511 row and its anatomy LoRA", async () => {
    const sink = new DiagnosticCollector();
    const profile = resolvedOn(seedreamModel());
    const route = await resolveIntimateRoute(profile, sink);

    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.profile.model.slug).toBe(INTIMATE_SCENE_LORA_MODEL_SLUG);
    expect(route.profile.profile).toBe(profile.profile);
    expect(route.binding).toEqual(BINDING_2511);
    expect(route.provenance).toEqual({ lora: INTIMATE_SCENE_LORA_ID, reason: "anatomy_lora" });
    expect(mockResolveLora).toHaveBeenCalledWith(
      { id: INTIMATE_SCENE_LORA_ID },
      {
        model: expect.objectContaining({ id: "imgmdlqwen2511aaaaaaaaaa" }),
        versionId: PROBED_2511,
        execution: { kind: "production", task: "variant" },
      },
      sink,
    );
    // The pairing reports nothing of its own: each lane words its own answer.
    expect(sink.items).toEqual([]);
  });

  it("hands back the pairing's own refusal, leg and all, so each lane degrades or fails as before", async () => {
    mockModels.mockResolvedValue([]);
    const sink = new DiagnosticCollector();
    const route = await resolveIntimateRoute(resolvedOn(seedreamModel()), sink);

    expect(route).toEqual({
      ok: false,
      leg: "model",
      message: `no registered image model matches ${INTIMATE_SCENE_LORA_MODEL_SLUG}`,
    });
    expect(mockResolveLora).not.toHaveBeenCalled();
    expect(sink.items).toEqual([]);
  });
});

describe("a listed `optional` model renders on its own resolved profile", () => {
  it("renders without a LoRA when none is curated, says so once, and reads nothing", async () => {
    const sink = new DiagnosticCollector();
    const profile = resolvedOn(qwen21Model(), "scene");
    const route = await resolveIntimateRoute(profile, sink);

    expect(route.ok).toBe(true);
    if (!route.ok) return;
    // The lane's own object: no registry read, no intimate model paired in.
    expect(route.profile).toBe(profile);
    expect(route.binding).toBeNull();
    expect(route.provenance).toEqual({ lora: null, reason: "no_anatomy_lora_curated" });
    expect(mockModels).not.toHaveBeenCalled();
    expect(mockResolveLora).not.toHaveBeenCalled();
    expect(sink.items).toHaveLength(1);
    expect(sink.items[0]).toMatchObject({
      severity: "info",
      code: INTIMATE_ROUTE_NO_ANATOMY_LORA_CODE,
      context: { slug: CIVITAI_QWEN_IMAGE_21_SLUG, task: "scene", reason: "no_anatomy_lora_curated" },
    });
  });

  it("pairs the curated row the policy names, resolved against the model's own pinned version — LoRA-ready", async () => {
    // The one case the real table cannot reach: a listed model naming a row.
    mockPolicy.mockReturnValueOnce({ anatomyLora: "optional", anatomyLoraId: QWEN21_LORA_ID });
    mockResolveLora.mockResolvedValue({ ok: true, binding: BINDING_QWEN21 });
    const sink = new DiagnosticCollector();
    const profile = resolvedOn(qwen21Model());
    const route = await resolveIntimateRoute(profile, sink);

    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.profile).toBe(profile);
    expect(route.binding).toEqual(BINDING_QWEN21);
    expect(route.provenance).toEqual({ lora: QWEN21_LORA_ID, reason: "anatomy_lora" });
    // The same library leg the pairing takes, asked of the RESOLVED model: the
    // version a curated row's `compatibleVersionIds` is judged against is the
    // hosted checkpoint the lane will run.
    expect(mockResolveLora).toHaveBeenCalledWith(
      { id: QWEN21_LORA_ID },
      { model: profile.model, versionId: QWEN21_VERSION, execution: { kind: "production", task: "variant" } },
      sink,
    );
    expect(mockModels).not.toHaveBeenCalled();
    expect(sink.items.some((item) => item.code === INTIMATE_ROUTE_NO_ANATOMY_LORA_CODE)).toBe(false);
  });

  it.each([
    {
      leg: "library_row",
      arrange: () => {
        mockResolveLora.mockResolvedValue({
          ok: false,
          code: "image_lora.unreachable_configuration",
          message: `no usable LoRA library entry ${QWEN21_LORA_ID}`,
        });
      },
    },
    {
      leg: "credential",
      arrange: () => {
        mockResolveLora.mockResolvedValue({ ok: true, binding: BINDING_QWEN21 });
        delete process.env.CIVITAI_API_TOKEN;
      },
    },
  ])("renders without the named row when its $leg leg misses, and says which", async ({ leg, arrange }) => {
    // The one case the real table cannot reach: a listed model naming a row.
    mockPolicy.mockReturnValueOnce({ anatomyLora: "optional", anatomyLoraId: QWEN21_LORA_ID });
    arrange();
    const sink = new DiagnosticCollector();
    const profile = resolvedOn(qwen21Model());
    const route = await resolveIntimateRoute(profile, sink);

    // Never a refusal: the reviewed route renders bare of weights instead.
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.profile).toBe(profile);
    expect(route.binding).toBeNull();
    expect(route.provenance).toEqual({ lora: null, reason: "anatomy_lora_unavailable" });
    const reported = sink.items.find((item) => item.code === INTIMATE_ROUTE_NO_ANATOMY_LORA_CODE);
    expect(reported?.severity).toBe("info");
    expect(reported?.context).toMatchObject({ lora: QWEN21_LORA_ID, leg, reason: "anatomy_lora_unavailable" });
  });

  it("would resolve a curated 2.1 row for real: the pinned version the route asks about is the one a row is curated for", () => {
    // Unmocked library evaluation over the 0151 row's own LoRA bindings — the
    // mechanical half of "LoRA-ready". A Civitai row stores the model-version id
    // and resolves to its download address, which the transport turns into the
    // workflow's AIR entry after the family gate.
    const model = qwen21Model();
    const row = imageLoraSchema.parse({
      id: QWEN21_LORA_ID,
      label: "Qwen 2.1 anatomy fixture",
      locatorType: "civitai_model_version",
      locator: "4400001",
      compatibleModelSlugs: [CIVITAI_QWEN_IMAGE_21_SLUG],
      compatibleVersionIds: [QWEN21_VERSION],
      defaultScale: 0.8,
      minimumScale: 0.5,
      maximumScale: 1,
      allowedTasks: ["variant", "scene"],
    });
    const evaluated = evaluateImageLoraForRender({
      lora: row,
      modelSlug: model.slug,
      versionId: pinnedImageModelVersion(model),
      context: { kind: "production", task: "scene" },
      bindings: model.advancedCapabilities.controls,
    });
    expect(evaluated.ok).toBe(true);
    expect(evaluated.ok && evaluated.binding.locator).toBe("https://civitai.com/api/download/models/4400001");
    expect(evaluated.ok && evaluated.binding.scale).toBe(0.8);
  });
});
