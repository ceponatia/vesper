import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageModelSchema } from "@vesper/image-core";
import type { ReplicateClient, ReplicateImageResult } from "@vesper/image-replicate";

/**
 * `renderWithModel`'s own decision: dimension negotiation. The choosing rules
 * are `chooseDimensions`' and are tested in `@vesper/image-core`; what belongs
 * to this wrapper is which inputs it hands them — the lane's target ratio plus
 * the plan's dimension facts when a caller compiled one, and nothing else when
 * it did not. The transport is mocked so each case reads the exact aspect value
 * that would have been sent.
 */

vi.mock("../ai", () => ({ replicateClient: vi.fn() }));
vi.mock("../db", () => ({ db: vi.fn(), imageModels: {} }));

import { replicateClient } from "../ai";
import { renderWithModel } from "./models";

const runModel = vi.fn<ReplicateClient["runRegistryImageModel"]>();

const client: ReplicateClient = {
  configured: true,
  safetyCheckerDisabled: false,
  runRegistryImageModel: runModel,
  runReplicatePreprocessor: async () => {
    throw new Error("unused in this suite");
  },
  probeReplicateModel: async () => {
    throw new Error("unused in this suite");
  },
};

/** Wan's real menu: a size-mode model whose enum entries are the sizes. */
function wan() {
  return imageModelSchema.parse({
    id: "wan-1",
    slug: "vesper-test/wan",
    label: "Wan Fixture",
    canGenerate: true,
    canEdit: true,
    aspectMode: "size",
    supportedAspects: ["768*1024", "1536*2048", "3072*4096"],
  });
}

beforeEach(() => {
  runModel.mockReset();
  runModel.mockResolvedValue({ ok: true, image: Buffer.from("img") } satisfies ReplicateImageResult);
  vi.mocked(replicateClient).mockReturnValue(client);
});

describe("renderWithModel dimension negotiation", () => {
  it("negotiates the size enum from the plan's dimension facts", async () => {
    const result = await renderWithModel({
      model: wan(),
      prompt: "a portrait",
      dimensionFacts: { operation: "generate", resolution: "2K", mappedCustomSize: null },
    });
    expect(result.ok).toBe(true);
    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).toBe("1536*2048");
  });

  it("keeps the pure chooseAspect shape when no facts are passed", async () => {
    // The trial, the lab, and every direct caller land here: absent facts must
    // stay byte-identical to the pre-negotiation payload.
    await renderWithModel({ model: wan(), prompt: "a portrait" });
    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).toBe("3072*4096");
  });

  it("sends no shape at all and crops nothing when the caller asks for the model's own", async () => {
    // The raw-bench arm. `undefined` still means Vesper's 3:4 (the case above);
    // only an explicit `null` means "the model decides". Falsified against the
    // pre-policy wrapper, where every Generator run picked the 3:4 bucket the
    // admin never chose and centre-cropped the answer to reach it.
    const result = await renderWithModel({ model: wan(), prompt: "a portrait", targetRatio: null });
    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).toBeNull();
    expect(result.shape).toMatchObject({ mode: "provider_default", field: null, value: null, cropTarget: null });
    // The undecodable stub bytes would have failed a crop loudly; the point is
    // that no crop is attempted at all.
    expect(result.image).toEqual(Buffer.from("img"));
  });

  it("still maps an explicitly chosen shape through the version's own enum", async () => {
    // An explicit pick is not the native mode: it resolves to the member the
    // operator named, through the same one shape mapper — 1:1 here, not the
    // 3:4 that an unset target would have chosen.
    const ratioModel = imageModelSchema.parse({
      id: "sdxl-1",
      slug: "vesper-test/sdxl",
      label: "SDXL Fixture",
      canGenerate: true,
      canEdit: false,
      aspectMode: "aspect_ratio",
      supportedAspects: ["1:1", "3:4", "16:9"],
    });
    await renderWithModel({ model: ratioModel, prompt: "an item", targetRatio: 1 });
    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).toBe("1:1");
    await renderWithModel({ model: ratioModel, prompt: "an item" });
    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).toBe("3:4");
  });
});

describe("renderWithModel reference roles and sent count", () => {
  it("labels each prepared reference with the caller's role, falling back to 'reference'", async () => {
    // The buffers here are not decodable, so preparation degrades to the
    // original bytes — the ROLE must survive that path too.
    await renderWithModel({
      model: wan(),
      prompt: "a scene",
      references: [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")],
      referenceRoles: ["identity", "location"],
    });
    const sent = runModel.mock.calls.at(-1)?.[1]?.references;
    expect(sent?.map((reference) => reference.role)).toEqual(["identity", "location", "reference"]);
  });

  it("passes the transport's sent-reference count through, absence included", async () => {
    runModel.mockResolvedValue({ ok: true, image: Buffer.from("img"), sentReferenceCount: 1 });
    const counted = await renderWithModel({ model: wan(), prompt: "p", references: [Buffer.from("a")] });
    expect(counted.sentReferenceCount).toBe(1);

    runModel.mockResolvedValue({ ok: true, image: Buffer.from("img") });
    const uncounted = await renderWithModel({ model: wan(), prompt: "p" });
    expect("sentReferenceCount" in uncounted).toBe(false);
  });
});
