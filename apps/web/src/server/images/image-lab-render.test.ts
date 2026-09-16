import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";
import type { ReplicateClient, ReplicateImageResult } from "@vesper/image-replicate";

/**
 * PROTECTS: the lab's "direct" probe (`runRealLabRender`, reached through
 * `labRenderer()`) is a SECOND, independent call site of the
 * `referencePreparationTarget` -> `prepareRenderReferences` pair that #626
 * fixed — the other being `renderWithModel` (`models.test.ts`). Before the
 * fix, every provider shared one hardcoded webp target, so a clean webp
 * reference reached Civitai byte-identical: accepted at every checkpoint
 * that could refuse it (upload, `whatif` preflight, workflow schedule), then
 * failed the render job silently with a full refund.
 *
 * `reference-preparation.test.ts` proves the shared function is correct in
 * isolation; `models.test.ts` proves ONE wrapper wires it correctly. Neither
 * would catch this wrapper's own wiring reverting to a hardcoded target,
 * because it is a separate call site. These exercise `labRenderer()`'s real
 * "direct" arm with a Civitai-slugged model and a real image buffer, with
 * only the transport (`replicateClient`) mocked — the same pattern
 * `models.test.ts` uses for `renderWithModel`.
 */

vi.mock("../ai", () => ({ replicateClient: vi.fn() }));

import { replicateClient } from "../ai";
import { labRenderer, type ImageLabRenderRequest } from "./image-lab-render";

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

/** A Civitai-classified slug — the fact `referencePreparationTarget` keys the
 * required jpeg reference format on. The direct arm forwards `aspect` and
 * `versionId` untouched, so neither needs to be a real negotiated value. */
function civitaiModel(): ImageModel {
  return imageModelSchema.parse({
    id: "civitai-klein-1",
    slug: CIVITAI_FLUX2_KLEIN4B_SLUG,
    label: "Civitai Klein Fixture",
    canGenerate: true,
    canEdit: true,
  });
}

function directRequest(references: Buffer[]): ImageLabRenderRequest {
  return {
    mode: "direct",
    model: civitaiModel(),
    prompt: "a portrait",
    references,
    controlInput: {},
    aspect: null,
    versionId: "v1",
  };
}

beforeEach(() => {
  runModel.mockReset();
  runModel.mockResolvedValue({ ok: true, image: Buffer.from("img") } satisfies ReplicateImageResult);
  vi.mocked(replicateClient).mockReturnValue(client);
});

describe("the lab's direct probe and Civitai's required reference format", () => {
  it("converts a clean webp reference to jpeg for a Civitai model, instead of shipping it unchanged", async () => {
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .webp()
      .toBuffer();
    await labRenderer()(directRequest([webp]));
    const sent = runModel.mock.calls.at(-1)?.[1]?.references;
    // Before #626 this would be the SAME webp object, passed straight through
    // by this arm's own hardcoded target — exactly the byte-identical
    // reference Civitai accepted and then silently failed on. It must now be
    // re-encoded to jpeg.
    expect(sent?.[0]?.mediaType).toBe("image/jpeg");
    expect(sent?.[0]?.bytes).not.toBe(webp);
  });

  it("fails the probe rather than shipping an unreadable reference to Civitai", async () => {
    await expect(labRenderer()(directRequest([Buffer.from("not an image")]))).rejects.toThrow(
      /could not be encoded to jpeg/,
    );
    // The transport must never see the request: for this provider, a paid
    // render lost to an unreadable reference is worse than refusing it before
    // submission (docs/resilience.md's degrade trade reverses here).
    expect(runModel).not.toHaveBeenCalled();
  });
});
