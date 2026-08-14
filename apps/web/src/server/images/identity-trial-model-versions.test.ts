import { describe, expect, it, vi } from "vitest";
import {
  emptyImageModelAdvancedCapabilities,
  type ImageModel,
  type ImageModelProfile,
  imageModelProfileSchema,
  imageModelSchema,
} from "@vesper/image-core";
import {
  ensureIdentityTrialModelVersions,
  identityTrialModelsNeedingProbe,
  imageModelProbeFields,
  imageModelReprobeFields,
} from "./identity-trial-model-versions";

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
    key: "scene-standard",
    label: "Scene Standard",
    task: "scene",
    operation: "edit",
    promptStrategy: "instruction_edit",
    ...overrides,
  });
}

const successfulProbe = {
  slug: "owner/model-a",
  isOfficial: true,
  label: "Model A",
  versionId: "version-123",
  canGenerate: true,
  canEdit: true,
  referenceField: "image",
  referenceArity: "array" as const,
  maxReferences: 3,
  aspectMode: "aspect_ratio" as const,
  supportedAspects: ["3:4"],
  outputFormat: "webp",
  extraInput: { output_quality: 95 },
  advancedCapabilities: emptyImageModelAdvancedCapabilities(),
};

describe("identityTrialModelsNeedingProbe", () => {
  it("selects only distinct requested models that have no trustworthy pin", () => {
    const models = [
      model(),
      model({ id: "model_b", slug: "owner/model-b:fixed-version", label: "Model B" }),
      model({ id: "model_c", slug: "owner/model-c", label: "Model C", probedVersionId: "probed-version" }),
      model({ id: "model_d", slug: "owner/model-d", label: "Model D" }),
    ];
    const profiles = [
      profile(),
      profile({ id: "profile_a_2", key: "variant-standard" }),
      profile({ id: "profile_b", imageModelId: "model_b" }),
      profile({ id: "profile_c", imageModelId: "model_c" }),
      profile({ id: "profile_d", imageModelId: "model_d" }),
    ];

    expect(
      identityTrialModelsNeedingProbe(
        ["profile_a", "profile_a_2", "profile_b", "profile_c", "unknown_profile"],
        profiles,
        models,
      ).map((entry) => entry.id),
    ).toEqual(["model_a"]);
  });

  it("re-probes a slug/version mismatch instead of pretending either version is authoritative", () => {
    const mismatched = model({ slug: "owner/model-a:slug-version", probedVersionId: "different-version" });
    expect(identityTrialModelsNeedingProbe(["profile_a"], [profile()], [mismatched])).toEqual([mismatched]);
  });
});

describe("ensureIdentityTrialModelVersions", () => {
  it("probes and persists only the selected unpinned model", async () => {
    const persist = vi.fn(async () => undefined);
    const probe = vi.fn(async () => ({ ok: true as const, probe: successfulProbe }));

    const result = await ensureIdentityTrialModelVersions(["profile_a"], undefined, {
      loadModels: async () => [model(), model({ id: "unused", slug: "owner/unused", label: "Unused" })],
      loadProfiles: async () => [profile()],
      probe,
      persist,
    });

    expect(probe).toHaveBeenCalledWith("owner/model-a");
    expect(persist).toHaveBeenCalledWith("model_a", successfulProbe);
    expect(result).toEqual({ probedModelIds: ["model_a"], failures: [] });
  });

  it("returns a failure and does not persist when Replicate cannot provide a version", async () => {
    const persist = vi.fn(async () => undefined);
    const result = await ensureIdentityTrialModelVersions(["profile_a"], undefined, {
      loadModels: async () => [model()],
      loadProfiles: async () => [profile()],
      probe: async () => ({ ok: false as const, error: "Replicate unavailable" }),
      persist,
    });

    expect(persist).not.toHaveBeenCalled();
    expect(result).toEqual({
      probedModelIds: [],
      failures: [{ modelId: "model_a", slug: "owner/model-a", error: "Replicate unavailable" }],
    });
  });
});

describe("imageModelProbeFields", () => {
  it("keeps the create write set limited to probe-owned mechanical fields", () => {
    expect(imageModelProbeFields(successfulProbe)).toEqual({
      canGenerate: true,
      canEdit: true,
      referenceField: "image",
      referenceArity: "array",
      aspectMode: "aspect_ratio",
      supportedAspects: ["3:4"],
      outputFormat: "webp",
      extraInput: { output_quality: 95 },
      // Written with `probedVersionId`, never apart from it: the bindings describe
      // one version's inputs, so a record that kept them while the version moved
      // would point the render path at a field that no longer exists.
      advancedCapabilities: emptyImageModelAdvancedCapabilities(),
      probedVersionId: "version-123",
    });
  });

  it("re-probes everything the create set writes EXCEPT the owner-curated supportedAspects", () => {
    // 0098 hand-prunes Wan's list (the 4096*… sizes break every edit under
    // chooseAspect's largest-exact rule), so a re-probe writing the probe's
    // verbatim menu would silently undo the curation.
    const { supportedAspects, ...expected } = imageModelProbeFields(successfulProbe);
    expect(supportedAspects).toEqual(["3:4"]);
    expect(imageModelReprobeFields(successfulProbe)).toEqual(expected);
  });
});
