import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  type ImageLoraRenderBinding,
  imageModelProfileSchema,
  imageModelSchema,
  type ImageRenderIntent,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";

/**
 * The orchestration entry point's OWN decisions: seed resolution — the one
 * place randomness may enter a plan — and the attempt provenance it assembles
 * from the plan plus the provider's echo. The planning rules themselves live in
 * `@vesper/image-core` and are tested there; the transport is mocked here so
 * these cases read exactly what would have been sent.
 */

vi.mock("../ai", () => ({ disableSafetyChecker: vi.fn(() => false) }));
vi.mock("./image-loras", () => ({ resolveImageLoraForRender: vi.fn() }));
vi.mock("./models", () => ({ renderWithModel: vi.fn() }));

import { renderWithModel, type RenderWithModelInput, type RenderWithModelResult } from "./models";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";

const mockRender = vi.mocked(renderWithModel);

const SEED_MAX = 2 ** 31 - 1;

function resolved(over: {
  seedBinding?: { minimum?: number; maximum?: number } | null;
  seedPolicy?: "random" | "reuse_source" | "caller";
} = {}): ResolvedImageProfile {
  const binding = over.seedBinding === null ? {} : {
    seed: { field: "seed", type: "integer", ...(over.seedBinding ?? { minimum: 0, maximum: SEED_MAX }) },
  };
  return {
    model: imageModelSchema.parse({
      id: "mdl-1",
      slug: "vesper-test/render-intent",
      label: "Render Intent Fixture",
      canGenerate: true,
      canEdit: true,
      referenceField: "image",
      referenceArity: "array",
      maxReferences: 4,
      supportedAspects: ["3:4"],
      advancedCapabilities: { controls: binding, knownInputFields: ["seed"] },
    }),
    profile: imageModelProfileSchema.parse({
      id: "prf-1",
      imageModelId: "mdl-1",
      key: "render-intent-fixture",
      label: "Render Intent Fixture",
      task: "variant",
      operation: "edit",
      promptStrategy: "instruction_edit",
      controlDefaults: { seedPolicy: over.seedPolicy ?? "random" },
    }),
  };
}

function intent(over: Partial<ImageRenderIntent> = {}): ImageRenderIntent {
  return {
    profile: resolved(),
    prompt: "change the outfit",
    references: [{ role: "identity", buffer: Buffer.from("ref") }],
    target: { aspectRatio: 3 / 4 },
    ...over,
  };
}

function sentControlInput(): Record<string, unknown> {
  const call = mockRender.mock.calls.at(-1)?.[0] as RenderWithModelInput | undefined;
  return call?.controlInput ?? {};
}

/**
 * Real, small, `sharp`-decodable buffers for the advisory evaluators to
 * measure — a mocked buffer like `Buffer.from("img")` cannot decode, which is
 * exactly the "unmeasured" case this suite also exercises deliberately.
 */
async function solidGrayPng(size: number, value: number): Promise<Buffer> {
  const data = Buffer.alloc(size * size, value);
  return sharp(data, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer();
}

async function checkerboardPng(size: number): Promise<Buffer> {
  const data = Buffer.alloc(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) data[y * size + x] = (x + y) % 2 === 0 ? 255 : 0;
  }
  return sharp(data, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer();
}

beforeEach(() => {
  mockRender.mockReset();
  mockRender.mockResolvedValue({
    ok: true,
    image: Buffer.from("img"),
    predictionId: "pred-1",
    executedVersionId: "v-exec",
  } satisfies RenderWithModelResult);
});

describe("seed resolution", () => {
  it("an explicit seed always wins and maps through the binding", async () => {
    const result = await renderImageIntent(intent({ controls: { seed: 123 } }));
    expect(result.ok).toBe(true);
    expect(sentControlInput()).toEqual({ seed: 123 });
    expect(result.attempt?.seed).toBe(123);
    expect(result.attempt?.appliedControls).toEqual({ seed: 123 });
  });

  it("a random-policy profile draws a seed inside the binding's declared range", async () => {
    const result = await renderImageIntent(intent({ profile: resolved({ seedBinding: { minimum: 10, maximum: 20 } }) }));
    const sent = sentControlInput().seed;
    expect(typeof sent).toBe("number");
    expect(Number.isInteger(sent)).toBe(true);
    expect(sent).toBeGreaterThanOrEqual(10);
    expect(sent).toBeLessThanOrEqual(20);
    // The generated value is the recorded value — that identity is the whole
    // reproducibility win over the provider rolling its own.
    expect(result.attempt?.seed).toBe(sent);
    expect(result.attempt?.appliedControls).toEqual({ seed: sent });
  });

  it("generates nothing when the version declares no seed binding", async () => {
    const result = await renderImageIntent(intent({ profile: resolved({ seedBinding: null }) }));
    expect(sentControlInput()).toEqual({});
    expect(result.attempt?.seed).toBeNull();
    expect(result.attempt?.droppedControls).toEqual([]);
  });

  it("keeps an explicit seed visible as a drop when no binding exists", async () => {
    const result = await renderImageIntent(
      intent({ profile: resolved({ seedBinding: null }), controls: { seed: 123 } }),
    );
    expect(sentControlInput()).toEqual({});
    // The resolved value is preserved even though it never went — the drop
    // beside it says why not.
    expect(result.attempt?.seed).toBe(123);
    expect(result.attempt?.appliedControls).toEqual({});
    expect(result.attempt?.droppedControls).toEqual([{ control: "seed", reason: "no_binding" }]);
  });

  it("resolves nothing for a non-random policy and records the unmet policy", async () => {
    const result = await renderImageIntent(intent({ profile: resolved({ seedPolicy: "reuse_source" }) }));
    expect(sentControlInput()).toEqual({});
    expect(result.attempt?.seed).toBeNull();
    expect(result.attempt?.droppedControls).toEqual([{ control: "seedPolicy", reason: "no_seed_transport" }]);
  });

  it("draws nothing for an explicitly pinned render", async () => {
    // The active row's probed seed binding describes the ACTIVE version, not
    // the pin — a number drawn from it would be validated against a range the
    // pinned version never declared.
    const result = await renderImageIntent(intent({ versionId: "v-pinned" }));
    expect(sentControlInput()).toEqual({});
    expect(result.attempt?.seed).toBeNull();
  });

  it("still honours an explicit seed verbatim on a pinned render", async () => {
    const result = await renderImageIntent(intent({ versionId: "v-pinned", controls: { seed: 123 } }));
    expect(sentControlInput()).toEqual({ seed: 123 });
    expect(result.attempt?.seed).toBe(123);
  });
});

describe("attempt provenance", () => {
  it("assembles the full record on success", async () => {
    const result = await renderImageIntent(intent({ controls: { seed: 5 } }));
    expect(result.attempt).toEqual({
      modelId: "mdl-1",
      modelSlug: "vesper-test/render-intent",
      profileId: "prf-1",
      task: "variant",
      promptStrategy: "instruction_edit",
      requestedVersionId: null,
      seed: 5,
      appliedControls: { seed: 5 },
      droppedControls: [],
      sentReferenceRoles: ["identity"],
      predictionId: "pred-1",
      executedVersionId: "v-exec",
      // The mocked transport in this suite never returns a `shape` outcome —
      // real renders always do (`renderWithModel`'s own tests own that shape).
      shape: null,
    });
  });

  it("records \"raw\" as the target source for the Generator's deliberate no-shape mode", async () => {
    // The layer beside `models.test.ts`'s own "sends no shape at all and crops
    // nothing" case (acceptance 5): that test proves `renderWithModel` never
    // buckets or crops a native request; this one proves the reason travels
    // all the way to `meta.render.shape.targetSource` as "raw".
    mockRender.mockResolvedValue({
      ok: true,
      image: Buffer.from("img"),
      predictionId: "pred-1",
      executedVersionId: "v-exec",
      shape: { mode: "provider_default", providerSize: null, field: null, value: null, expectedAspect: null, cropTarget: null, crop: null },
    } satisfies RenderWithModelResult);
    const result = await renderImageIntent(intent({ target: { aspectRatio: null } }));
    expect(result.attempt?.shape?.requestedAspect).toBeNull();
    expect(result.attempt?.shape?.targetSource).toBe("raw");
    const call = mockRender.mock.calls.at(-1)?.[0] as RenderWithModelInput | undefined;
    expect(call?.targetRatio).toBeNull();
  });

  it("builds the shape record from the plan's target resolution and the transport's own echo", async () => {
    mockRender.mockResolvedValue({
      ok: true,
      image: Buffer.from("img"),
      predictionId: "pred-1",
      executedVersionId: "v-exec",
      outputDimensions: { width: 768, height: 1024 },
      shape: {
        mode: "target_ratio",
        providerSize: null,
        field: "aspect_ratio",
        value: "3:4",
        expectedAspect: 3 / 4,
        cropTarget: null,
        crop: null,
      },
    } satisfies RenderWithModelResult);
    const result = await renderImageIntent(intent());
    expect(result.attempt?.shape).toEqual({
      mode: "target_ratio",
      requestedAspect: 3 / 4,
      targetSource: "lane",
      sentField: "aspect_ratio",
      sentValue: "3:4",
      expectedAspect: 3 / 4,
      returned: { width: 768, height: 1024 },
      providerSize: null,
      crop: null,
    });
  });

  it("is present on failure too, carrying the failed prediction's id", async () => {
    mockRender.mockResolvedValue({ ok: false, error: "provider exploded", predictionId: "pred-9" });
    const result = await renderImageIntent(intent({ controls: { seed: 5 } }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("provider exploded");
    expect(result.attempt?.predictionId).toBe("pred-9");
    expect(result.attempt?.executedVersionId).toBeNull();
    expect(result.attempt?.seed).toBe(5);
  });

  it("carries a controlled caller's version pin as the requested version", async () => {
    const result = await renderImageIntent(intent({ versionId: "v-pinned" }));
    expect(result.attempt?.requestedVersionId).toBe("v-pinned");
  });

  it("falls back to the slug's OWN version pin when the intent carries none (issue #248 codex review round 2, thread 1)", async () => {
    // No caller ever sets `intent.versionId` on the production portrait lane.
    // A model whose SLUG pins a version (`owner/name:version`) records that
    // pin as what was requested, because `replicatePredictionTarget` reads
    // that exact slug and routes to `/predictions` with it — the wire truly
    // did ask for it, unprompted by the intent.
    const pinnedSlugProfile = resolved();
    pinnedSlugProfile.model = { ...pinnedSlugProfile.model, slug: "vesper-test/render-intent:v-slug-pin" };
    const result = await renderImageIntent(intent({ profile: pinnedSlugProfile }));
    expect(result.attempt?.requestedVersionId).toBe("v-slug-pin");
  });

  it("never records the merely PROBED version — a bare slug with no :version suffix reaches the floating-latest endpoint regardless (issue #248 codex review round 2, thread 1)", async () => {
    // The bug this closes: recording `pinnedImageModelVersion` (probed OR
    // slug) as `requestedVersionId` claimed a bare-slug model pinned the
    // version its capabilities were PROBED against, even though
    // `replicatePredictionTarget` never sends it — that request reaches
    // `/models/<owner>/<name>/predictions` and follows whatever Replicate
    // currently calls `latest_version`.
    const probedUnpinnedProfile = resolved();
    probedUnpinnedProfile.model = { ...probedUnpinnedProfile.model, probedVersionId: "v-probed-only" };
    const result = await renderImageIntent(intent({ profile: probedUnpinnedProfile }));
    expect(result.attempt?.requestedVersionId).toBeNull();
  });

  it("records null when the intent carries no pin and the slug pins nothing for this model", async () => {
    const result = await renderImageIntent(intent());
    expect(result.attempt?.requestedVersionId).toBeNull();
  });

  it("is absent when the render was refused before a plan existed", async () => {
    // A required role the intent cannot supply refuses pre-plan — there is no
    // attempt to describe, and nothing must pretend otherwise.
    const profile = resolved();
    profile.profile.referencePolicy.requiredRoles = ["identity"];
    const result = await renderImageIntent(intent({ profile, references: [] }));
    expect(result.ok).toBe(false);
    expect(result.attempt).toBeUndefined();
    expect(mockRender).not.toHaveBeenCalled();
  });
});

describe("dimension facts", () => {
  it("hands the plan's dimension facts to renderWithModel", async () => {
    // The compile step resolves them where the merged controls live; this entry
    // point only threads them, so the transport wrapper can negotiate the shape.
    await renderImageIntent(intent());
    const call = mockRender.mock.calls.at(-1)?.[0] as RenderWithModelInput | undefined;
    expect(call?.dimensionFacts).toEqual({ operation: "edit", mappedCustomSize: null });
  });
});

describe("sent-reference provenance", () => {
  it("hands the plan's roles to renderWithModel beside its buffers", async () => {
    // Index-parallel with `references`, so the transport's trim diagnostics can
    // name what was kept and what was given up.
    await renderImageIntent(intent());
    const call = mockRender.mock.calls.at(-1)?.[0] as RenderWithModelInput | undefined;
    expect(call?.referenceRoles).toEqual(["identity"]);
    expect(call?.references).toHaveLength(1);
  });

  it("truncates the attempt's sent roles to what the transport says it sent", async () => {
    // The data_url byte budget can trim the plan's tail AFTER planning; the
    // stored attempt must not claim the trimmed reference went.
    mockRender.mockResolvedValue({ ok: true, image: Buffer.from("img"), sentReferenceCount: 0 });
    const result = await renderImageIntent(intent());
    expect(result.attempt?.sentReferenceRoles).toEqual([]);
  });

  it("keeps the plan's roles when the transport reports no count", async () => {
    // Absence means "the transport never said" — an injected renderer, an older
    // result shape — and the plan's list is the only honest answer available.
    const result = await renderImageIntent(intent());
    expect(result.attempt?.sentReferenceRoles).toEqual(["identity"]);
  });
});

describe("LoRA credential completion", () => {
  /**
   * The seam that makes a stored PUBLIC locator into a fetchable one. The credential
   * may exist in exactly one place in a render — the provider payload — and
   * these cases assert both halves of that: it arrives there, and it arrives
   * nowhere else.
   */
  const TOKEN = "civitai-test-token-value";

  const binding: ImageLoraRenderBinding = {
    id: "imglorqwennsfwallinclv20",
    label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
    locator: "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor",
    scale: 1,
    promptPrefix: null,
    promptSuffix: null,
    triggerWords: [],
  };

  /** A version that declares both LoRA bindings, like the registered 2511 row. */
  function loraProfile(): ResolvedImageProfile {
    const base = resolved({ seedBinding: null });
    return {
      ...base,
      model: imageModelSchema.parse({
        ...base.model,
        advancedCapabilities: {
          controls: {
            loraWeights: { field: "lora_weights", type: "string" },
            loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
          },
          knownInputFields: ["lora_weights", "lora_scale"],
        },
      }),
    };
  }

  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.CIVITAI_API_TOKEN;
    process.env.CIVITAI_API_TOKEN = TOKEN;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CIVITAI_API_TOKEN;
    else process.env.CIVITAI_API_TOKEN = saved;
  });

  it("sends the tokened weights URL and records neither the token nor the locator", async () => {
    const result = await renderImageIntent(intent({ profile: loraProfile(), resolvedLora: binding }));
    const sent = sentControlInput();
    expect(sent.lora_scale).toBe(1);
    expect(String(sent.lora_weights)).toContain(`token=${TOKEN}`);
    expect(String(sent.lora_weights)).toContain("format=SafeTensor");
    // `appliedControls` is what a caller STORES and reports: id and scale only.
    expect(result.attempt?.appliedControls).toEqual({ lora: { id: binding.id, scale: 1 } });
    expect(JSON.stringify(result.attempt)).not.toContain(TOKEN);
    // The caller's own binding is untouched, so the row it came from stays clean.
    expect(binding.locator).not.toContain(TOKEN);
  });

  it("sends the stored locator unchanged when the deployment has no token", async () => {
    delete process.env.CIVITAI_API_TOKEN;
    await renderImageIntent(intent({ profile: loraProfile(), resolvedLora: binding }));
    expect(sentControlInput().lora_weights).toBe(binding.locator);
  });

  it("leaves a non-Civitai locator alone", async () => {
    const slug = { ...binding, locator: "owner/some-lora" };
    await renderImageIntent(intent({ profile: loraProfile(), resolvedLora: slug }));
    expect(sentControlInput().lora_weights).toBe("owner/some-lora");
  });
});

describe("renderAttemptMeta", () => {
  it("wraps an attempt under the render key and vanishes without one — a one-argument call stays valid", async () => {
    const result = await renderImageIntent(intent({ controls: { seed: 5 } }));
    expect(renderAttemptMeta(result.attempt)).toEqual({ meta: { render: result.attempt } });
    expect(renderAttemptMeta(undefined)).toEqual({});
  });

  it("lands the second argument as meta.advisories when the caller threads it, and omits the key when the caller does not", async () => {
    mockRender.mockResolvedValue({
      ok: true,
      image: await solidGrayPng(8, 128),
      predictionId: "pred-1",
      executedVersionId: "v-exec",
    } satisfies RenderWithModelResult);
    const result = await renderImageIntent(intent({ controls: { seed: 5 } }));
    expect(result.advisories).toHaveLength(1);
    // Explicit threading (#249 correction round 1): a caller that has
    // `result.advisories` and passes it gets the sibling key...
    expect(renderAttemptMeta(result.attempt, result.advisories)).toEqual({
      meta: { render: result.attempt, advisories: result.advisories },
    });
    // ...and a caller that does not pass it (an older call site, or one that
    // deliberately ignores advisories) gets exactly the pre-advisories shape,
    // even though this same attempt DID measure some.
    expect(renderAttemptMeta(result.attempt)).toEqual({ meta: { render: result.attempt } });
  });
});

describe("render advisories (#249)", () => {
  it("attaches a blank_output advisory when the returned image decodes to a flat fill", async () => {
    mockRender.mockResolvedValue({
      ok: true,
      image: await solidGrayPng(8, 128),
      predictionId: "pred-1",
      executedVersionId: "v-exec",
    } satisfies RenderWithModelResult);
    const result = await renderImageIntent(intent());
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories?.[0]?.code).toBe("blank_output");
  });

  it("attaches nothing on a sharp, high-contrast render", async () => {
    mockRender.mockResolvedValue({
      ok: true,
      image: await checkerboardPng(16),
      predictionId: "pred-1",
      executedVersionId: "v-exec",
    } satisfies RenderWithModelResult);
    const result = await renderImageIntent(intent());
    expect(result.advisories).toEqual([]);
  });

  it("degrades with an unmeasured diagnostic when the transport's buffer cannot be decoded, never fails the render", async () => {
    const sink = new DiagnosticCollector();
    mockRender.mockResolvedValue({
      ok: true,
      image: Buffer.from("not an image"),
      predictionId: "pred-1",
      executedVersionId: "v-exec",
    } satisfies RenderWithModelResult);
    const result = await renderImageIntent(intent(), sink);
    expect(result.ok).toBe(true);
    expect(result.advisories).toEqual([]);
    expect(sink.items.some((item) => item.code === "images.advisory.unmeasured")).toBe(true);
  });

  it("is never a gate: a render carrying every advisory this suite can trigger still returns ok:true and the image", async () => {
    mockRender.mockResolvedValue({
      ok: true,
      image: await solidGrayPng(8, 128),
      predictionId: "pred-1",
      executedVersionId: "v-exec",
      shape: {
        mode: "target_ratio",
        providerSize: null,
        field: "aspect_ratio",
        value: "3:4",
        expectedAspect: 1,
        cropTarget: 3 / 4,
        crop: {
          targetRatio: 3 / 4,
          placement: "center",
          rect: { left: 0, top: 0, width: 100, height: 100 },
          focalSource: "none",
        },
      },
    } satisfies RenderWithModelResult);
    const result = await renderImageIntent(intent());
    expect(result.ok).toBe(true);
    expect(result.image).toBeInstanceOf(Buffer);
    const codes = (result.advisories ?? []).map((advisory) => advisory.code).sort();
    expect(codes).toEqual(["blank_output", "harmful_crop_loss"]);
  });
});
