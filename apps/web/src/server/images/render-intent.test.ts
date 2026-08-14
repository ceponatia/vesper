import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  type ImageRenderIntent,
  type ResolvedImageProfile,
} from "@vesper/image-core";

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

describe("renderAttemptMeta", () => {
  it("wraps an attempt under the render key and vanishes without one", async () => {
    const result = await renderImageIntent(intent({ controls: { seed: 5 } }));
    expect(renderAttemptMeta(result.attempt)).toEqual({ meta: { render: result.attempt } });
    expect(renderAttemptMeta(undefined)).toEqual({});
  });
});
