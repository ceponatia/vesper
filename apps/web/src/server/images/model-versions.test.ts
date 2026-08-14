import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  emptyImageModelAdvancedCapabilities,
  type ImageModel,
  type ImageModelProfile,
  imageModelProfileSchema,
  imageModelSchema,
} from "@vesper/image-core";
import {
  activateCandidateVersion,
  type ImageModelVersionDependencies,
  probeLatestCandidate,
  smokeTestCandidate,
} from "./model-versions";
import type { RenderImageIntentResult } from "./render-intent";

/** A typed render mock, so reading the intent off `mock.calls` needs no cast. */
function renderMock(
  implementation: () => Promise<RenderImageIntentResult>,
): ReturnType<typeof vi.fn<ImageModelVersionDependencies["render"]>> {
  return vi.fn<ImageModelVersionDependencies["render"]>(implementation);
}

/**
 * The version-promotion service's decisions, exercised through its injected IO
 * seams (the `identity-trial-model-versions.test.ts` idiom): which slug gets
 * probed, what refuses before anything is written, and exactly what the one
 * atomic activation update contains. The pure diff/validation tables live in
 * `@vesper/image-core`; live smoke tests are explicit admin actions and are
 * never run here.
 */

function model(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "model_a",
    slug: "owner/model-a",
    label: "Model A",
    canGenerate: true,
    canEdit: true,
    ...overrides,
  });
}

function profile(overrides: Partial<ImageModelProfile> = {}): ImageModelProfile {
  return imageModelProfileSchema.parse({
    id: "profile_a",
    imageModelId: "model_a",
    key: "portrait-standard",
    label: "Portrait Standard",
    task: "portrait",
    operation: "generate",
    promptStrategy: "text_to_image_description",
    ...overrides,
  });
}

function successfulProbe(overrides: Partial<ReturnType<typeof baseProbe>> = {}) {
  return { ...baseProbe(), ...overrides };
}

function baseProbe() {
  return {
    slug: "owner/model-a",
    isOfficial: true,
    label: "Model A",
    versionId: "candidate-v2" as string | null,
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array" as const,
    maxReferences: 3,
    aspectMode: "aspect_ratio" as const,
    supportedAspects: ["3:4"],
    outputFormat: "webp",
    extraInput: {},
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
  };
}

describe("probeLatestCandidate", () => {
  it("refuses an unknown model", async () => {
    const result = await probeLatestCandidate("missing", undefined, { loadModel: async () => null });
    expect(result).toEqual({ ok: false, code: "not_found", message: "image model not found" });
  });

  it("surfaces a probe failure without mutating anything", async () => {
    const result = await probeLatestCandidate("model_a", undefined, {
      loadModel: async () => model(),
      probe: async () => ({ ok: false as const, error: "Replicate unavailable" }),
    });
    expect(result).toEqual({ ok: false, code: "probe_failed", message: "Replicate unavailable" });
  });

  it("probes the BARE path even when the row is pinned, and reports the drift", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, probe: successfulProbe() }));
    const result = await probeLatestCandidate("model_a", undefined, {
      loadModel: async () => model({ slug: "owner/model-a:old-pin", probedVersionId: "old-pin", canEdit: false }),
      loadProfiles: async () => [profile(), profile({ id: "profile_off", enabled: false })],
      probe,
    });

    expect(probe).toHaveBeenCalledWith("owner/model-a");
    if (!result.ok) throw new Error("expected success");
    expect(result.activatable).toBe(true);
    expect(result.latestDiffers).toBe(true);
    // Only the ENABLED profile of this model is judged.
    expect(result.profiles.map((entry) => entry.profileId)).toEqual(["profile_a"]);
    expect(result.diff).toContainEqual({ field: "canEdit", kind: "changed", active: false, candidate: true });
  });

  it("reports no drift when latest IS the pin, and not-activatable when no version id exists", async () => {
    const pinned = await probeLatestCandidate("model_a", undefined, {
      loadModel: async () => model({ slug: "owner/model-a:candidate-v2", probedVersionId: "candidate-v2" }),
      loadProfiles: async () => [],
      probe: async () => ({ ok: true as const, probe: successfulProbe() }),
    });
    if (!pinned.ok) throw new Error("expected success");
    expect(pinned.latestDiffers).toBe(false);

    const versionless = await probeLatestCandidate("model_a", undefined, {
      loadModel: async () => model(),
      loadProfiles: async () => [],
      probe: async () => ({ ok: true as const, probe: successfulProbe({ versionId: null }) }),
    });
    if (!versionless.ok) throw new Error("expected success");
    expect(versionless.activatable).toBe(false);
    expect(versionless.latestDiffers).toBe(false);
  });
});

/** A tiny real image so the smoke path can measure what it renders. */
function renderedImage(): Promise<Buffer> {
  return sharp({ create: { width: 12, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .webp()
    .toBuffer();
}

describe("smokeTestCandidate", () => {
  it("refuses a profile that does not belong to the model", async () => {
    const result = await smokeTestCandidate(
      "model_a",
      { versionId: "candidate-v2", profileId: "profile_other" },
      undefined,
      {
        loadModel: async () => model(),
        loadProfiles: async () => [profile({ id: "profile_other", imageModelId: "model_b" })],
      },
    );
    expect(result).toEqual({ ok: false, code: "profile_not_found", message: "image model profile not found" });
  });

  it("pins the intent to the candidate and sends no reference for a bare generate profile", async () => {
    const render = renderMock(async () => ({
      ok: true,
      image: await renderedImage(),
      predictionId: "pred_1",
      executedVersionId: "candidate-v2",
    }));
    const result = await smokeTestCandidate("model_a", { versionId: "candidate-v2", profileId: "profile_a" }, undefined, {
      loadModel: async () => model(),
      loadProfiles: async () => [profile()],
      render,
    });

    const intent = render.mock.calls[0]?.[0];
    expect(intent?.versionId).toBe("candidate-v2");
    expect(intent?.references).toEqual([]);
    if (!result.ok) throw new Error("expected success");
    expect(result.predictionId).toBe("pred_1");
    expect(result.executedVersionId).toBe("candidate-v2");
    expect(result.width).toBe(12);
    expect(result.height).toBe(16);
    expect(result.imageBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("hands an edit profile one synthetic neutral reference under a role the policy accepts", async () => {
    const render = renderMock(async () => ({ ok: true, image: await renderedImage() }));
    const editProfile = profile({
      id: "profile_edit",
      key: "scene-standard",
      operation: "edit",
      promptStrategy: "instruction_edit",
      referencePolicy: {
        allowedRoles: ["identity", "location"],
        requiredRoles: ["identity"],
        roleOrder: [],
        identityStrategy: "canonical_only",
      },
    });
    const result = await smokeTestCandidate("model_a", { versionId: "candidate-v2", profileId: "profile_edit" }, undefined, {
      loadModel: async () => model(),
      loadProfiles: async () => [editProfile],
      render,
    });

    expect(result.ok).toBe(true);
    const intent = render.mock.calls[0]?.[0];
    expect(intent?.references).toHaveLength(1);
    expect(intent?.references[0]?.role).toBe("identity");
    const meta = await sharp(intent?.references[0]?.buffer ?? Buffer.alloc(0)).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([768, 1024, "webp"]);
  });

  it("synthesizes a reference for a model that cannot generate, even under a generate-shaped policy", async () => {
    const render = renderMock(async () => ({ ok: true, image: await renderedImage() }));
    await smokeTestCandidate("model_a", { versionId: "candidate-v2", profileId: "profile_a" }, undefined, {
      loadModel: async () => model({ canGenerate: false }),
      loadProfiles: async () => [profile({ operation: "edit", promptStrategy: "instruction_edit" })],
      render,
    });
    const intent = render.mock.calls[0]?.[0];
    expect(intent?.references.map((reference) => reference.role)).toEqual(["identity"]);
  });

  it("reports a failed render with its prediction id and duration, persisting nothing", async () => {
    const result = await smokeTestCandidate("model_a", { versionId: "candidate-v2", profileId: "profile_a" }, undefined, {
      loadModel: async () => model(),
      loadProfiles: async () => [profile()],
      render: async () => ({ ok: false, error: "provider refused", predictionId: "pred_9" }),
    });
    expect(result).toMatchObject({ ok: false, code: "smoke_failed", message: "provider refused", predictionId: "pred_9" });
  });
});

describe("activateCandidateVersion", () => {
  it("pins via the exact-version probe and strips the old pin in ONE update", async () => {
    const probe = vi.fn(async (slug: string) =>
      slug === "owner/model-a:candidate-v2"
        ? { ok: true as const, probe: successfulProbe() }
        : { ok: false as const, error: `unexpected probe of ${slug}` },
    );
    const persist = vi.fn(async () => undefined);
    const result = await activateCandidateVersion("model_a", { versionId: "candidate-v2" }, undefined, {
      loadModel: async () => model({ slug: "owner/model-a:old-pin", probedVersionId: "old-pin" }),
      loadProfiles: async () => [profile()],
      probe,
      persist,
    });

    expect(probe).toHaveBeenCalledWith("owner/model-a:candidate-v2");
    expect(persist).toHaveBeenCalledTimes(1);
    const [modelId, update] = persist.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(modelId).toBe("model_a");
    expect(update.slug).toBe("owner/model-a:candidate-v2");
    expect(update.probedVersionId).toBe("candidate-v2");
    expect(update.updatedAt).toBeInstanceOf(Date);
    // The write set is the probe bridge plus slug and updatedAt — the reviewed
    // fields (editKind, identityPreservation, operatorWarning), maxReferences,
    // label, transport, surfaces, and sort are untouchable from here.
    expect(Object.keys(update).sort()).toEqual([
      "advancedCapabilities",
      "aspectMode",
      "canEdit",
      "canGenerate",
      "extraInput",
      "outputFormat",
      "probedVersionId",
      "referenceArity",
      "referenceField",
      "slug",
      "supportedAspects",
      "updatedAt",
    ]);
    expect(result.ok).toBe(true);
  });

  it("falls back to the bare model record when the per-version endpoint fails and latest IS the candidate", async () => {
    // Official models expose no versions list, and their per-version endpoint is
    // unverified — the model record's latest_version schema is the honest source
    // when it names exactly the requested version.
    const probe = vi.fn(async (slug: string) =>
      slug === "owner/model-a"
        ? { ok: true as const, probe: successfulProbe() }
        : { ok: false as const, error: "404 no per-version endpoint" },
    );
    const persist = vi.fn(async () => undefined);
    const result = await activateCandidateVersion("model_a", { versionId: "candidate-v2" }, undefined, {
      loadModel: async () => model(),
      loadProfiles: async () => [],
      probe,
      persist,
    });

    expect(probe.mock.calls.map((call) => call[0])).toEqual(["owner/model-a:candidate-v2", "owner/model-a"]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("refuses when neither probe can name the exact candidate", async () => {
    const persist = vi.fn(async () => undefined);
    const result = await activateCandidateVersion("model_a", { versionId: "candidate-v2" }, undefined, {
      loadModel: async () => model(),
      loadProfiles: async () => [],
      probe: async (slug: string) =>
        slug === "owner/model-a"
          ? { ok: true as const, probe: successfulProbe({ versionId: "some-other-latest" }) }
          : { ok: false as const, error: "404 no per-version endpoint" },
      persist,
    });

    expect(persist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "version_unavailable" });
  });

  it("refuses with the findings when an enabled profile would break, writing nothing", async () => {
    const persist = vi.fn(async () => undefined);
    const result = await activateCandidateVersion("model_a", { versionId: "candidate-v2" }, undefined, {
      loadModel: async () => model(),
      // The edit profile becomes impossible on a candidate that cannot edit.
      loadProfiles: async () => [
        profile({ id: "profile_edit", key: "scene-standard", label: "Scene Standard", task: "scene", operation: "edit", promptStrategy: "instruction_edit" }),
      ],
      probe: async () => ({ ok: true as const, probe: successfulProbe({ canEdit: false }) }),
      persist,
    });

    expect(persist).not.toHaveBeenCalled();
    if (result.ok || result.code !== "activation_blocked") throw new Error("expected activation_blocked");
    expect(result.message).toContain("Scene Standard");
    expect(result.profiles[0]?.findings[0]).toMatchObject({ level: "blocking", code: "operation_impossible" });
  });

  it("activates through warnings, reporting them beside the updated model", async () => {
    const persist = vi.fn(async () => undefined);
    const result = await activateCandidateVersion("model_a", { versionId: "candidate-v2" }, undefined, {
      loadModel: async () => model(),
      // A tuned guidance default with no binding on the candidate: a warning,
      // never a refusal — render-time behavior is the recorded no_binding drop.
      loadProfiles: async () => [
        profile({ controlDefaults: { seedPolicy: "random", guidance: 4.5 } }),
      ],
      probe: async () => ({ ok: true as const, probe: successfulProbe() }),
      persist,
    });

    expect(persist).toHaveBeenCalledTimes(1);
    if (!result.ok) throw new Error("expected success");
    expect(result.profiles[0]?.findings[0]).toMatchObject({ level: "warning", code: "control_binding_missing" });
  });
});
