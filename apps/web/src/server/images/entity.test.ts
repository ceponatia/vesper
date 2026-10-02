import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn() };
});
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>();
  return { ...actual, runImagePipeline: vi.fn() };
});
vi.mock("./model-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-profiles")>();
  return { ...actual, resolveImageProfileForTask: vi.fn() };
});
vi.mock("./render-intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-intent")>();
  return { ...actual, renderImageIntent: vi.fn() };
});
vi.mock("./entity-prompt-program", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./entity-prompt-program")>();
  return { ...actual, buildEntityPromptProgram: vi.fn() };
});

import { isDemoMode } from "../ai";
import { ImageProduceError, runImagePipeline } from "./assets";
import type { ImageRow } from "./asset-storage";
import { generateEntityImage } from "./entity";
import { buildEntityPromptProgram } from "./entity-prompt-program";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderImageIntent } from "./render-intent";
import { resolvedImageProfileFixture } from "@/server/test-support";

beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * PROTECTS (#686): a failed entity (item/location) render keeps this lane's
 * ruled THROW shape and still hands the pipeline its attempt record, so the
 * failed row records `meta.render` exactly as a failed variant row does. The
 * bad implementation this kills throws a plain `Error`: the row then keeps no
 * attempt record, and the ids a Civitai transport records before its download
 * outlive a failure that already proved the output unrecoverable — a false
 * recovery offer that `images.recoverable` would still show. That the
 * pipeline merges a thrown `ImageProduceError`'s meta into the row at all is
 * `assets.int.test.ts`'s claim; this one is that `generateEntityImage` is one
 * of the callers that actually throws it, with the real attempt attached.
 */
describe("generateEntityImage — the thrown attempt record (#686)", () => {
  const bound = resolvedImageProfileFixture({ slug: "civitai/qwen-image-2.1", task: "item", key: "item-standard", operation: "generate" });

  function prime(): void {
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveImageProfileForTask).mockResolvedValue(bound);
    vi.mocked(buildEntityPromptProgram).mockResolvedValue({
      name: "Brass Compass",
      prompt: "a brass compass on a wooden desk",
      negativePrompt: null,
      meta: {},
    });
    vi.mocked(runImagePipeline).mockImplementation(async (opts) => {
      if ((opts.failedPrecondition ?? null) !== null) return { imageId: "img-1", status: "failed" };
      const produced = await opts.produce({ id: "img-1" } as unknown as ImageRow);
      return { imageId: "img-1", status: produced.ok ? "ready" : "failed" };
    });
  }

  it.each([
    ["a definite failure, naming no undelivered output", "Civitai output download failed (civitai_output_too_large; retry=never)", {}],
    [
      "an undelivered output, naming it",
      "Civitai output download failed (civitai_output_undelivered; retry=reconcile)",
      { undeliveredOutputId: "blob-1" },
    ],
  ] as const)("a failed render throws its attempt record with it: %s", async (_label, error, undelivered) => {
    prime();
    const attempt = { modelSlug: "civitai/qwen-image-2.1", predictionId: "wf-1", ...undelivered, shape: null };
    vi.mocked(renderImageIntent).mockResolvedValue(
      { ok: false, error, predictionId: "wf-1", attempt } as unknown as Awaited<ReturnType<typeof renderImageIntent>>,
    );
    let thrown: unknown;
    vi.mocked(runImagePipeline).mockImplementation(async (opts) => {
      try {
        await opts.produce({ id: "img-1" } as unknown as ImageRow);
      } catch (caught) {
        thrown = caught;
      }
      return { imageId: "img-1", status: "failed" };
    });

    await generateEntityImage({ entityKind: "item", entityId: "itm-1", userId: "u-1" });

    expect(thrown).toBeInstanceOf(ImageProduceError);
    if (!(thrown instanceof ImageProduceError)) throw new Error("expected an ImageProduceError");
    expect(thrown.message).toBe(error);
    expect(thrown.meta).toEqual({ render: attempt });
  });
});
