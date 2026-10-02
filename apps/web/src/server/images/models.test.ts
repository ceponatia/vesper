import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { chooseCropPlacement, imageModelSchema } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG, CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import type { ReplicateClient, ReplicateImageResult } from "@vesper/image-replicate";

/**
 * `renderWithModel`'s own decision: dimension negotiation. The choosing rules
 * are `chooseDimensions`' and are tested in `@vesper/image-core`; what belongs
 * to this wrapper is which inputs it hands them — the lane's target ratio plus
 * the plan's dimension facts when a caller compiled one, and nothing else when
 * it did not. The transport is mocked so each case reads the exact aspect value
 * that would have been sent.
 */

vi.mock("../ai", () => ({ replicateClient: vi.fn(), imageModelSentShape: vi.fn() }));
vi.mock("../db", () => ({ db: vi.fn(), imageModels: {} }));

import { imageModelSentShape, replicateClient } from "../ai";
import { cropToTargetAspect, renderWithModel } from "./models";

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

/** Same shape as `wan()`, but a Civitai-classified slug — the fact
 * `referencePreparationTarget` (and so `renderWithModel`) keys the required
 * jpeg reference format on. */
function civitaiModel() {
  return imageModelSchema.parse({
    id: "civitai-klein-1",
    slug: CIVITAI_FLUX2_KLEIN4B_SLUG,
    label: "Civitai Klein Fixture",
    canGenerate: true,
    canEdit: true,
    aspectMode: "size",
    supportedAspects: ["768*1024", "1536*2048", "3072*4096"],
  });
}

/**
 * The real seeded row's slug and offered shapes (drizzle/0151) — the one
 * model `imageModelEditSizesFromReference` names today. `CIVITAI_QWEN_IMAGE_21_SLUG`
 * comes from `@vesper/image-models` rather than a literal copy, so a drift
 * between that constant and image-core's own hardcoded slug set would show up
 * here as these cases suddenly behaving like an ordinary aspect_ratio model.
 */
function civitaiQwen21Model() {
  return imageModelSchema.parse({
    id: "civitai-qwen21-1",
    slug: CIVITAI_QWEN_IMAGE_21_SLUG,
    label: "Qwen Image 2.1 (Civitai) Fixture",
    canGenerate: true,
    canEdit: true,
    aspectMode: "aspect_ratio",
    supportedAspects: ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"],
  });
}

/** A model with no usable shape at all — every render through it always
 * negotiates `expectedAspect: null`, which forces `renderWithModel` to attempt
 * a crop regardless of `needsCrop`. That is what lets these fixtures force the
 * crop path with a REAL image, rather than only exercising it when the crop
 * happens to fail on undecodable stub bytes. */
function noAspectModel() {
  return imageModelSchema.parse({
    id: "no-aspect-1",
    slug: "vesper-test/no-aspect",
    label: "No Aspect Fixture",
    canGenerate: true,
    canEdit: true,
    aspectMode: "aspect_ratio",
    supportedAspects: [],
  });
}

async function solidImage(width: number, height: number, background: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

async function pixelAt(buffer: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const index = (y * info.width + x) * info.channels;
  return { r: data[index] ?? 0, g: data[index + 1] ?? 0, b: data[index + 2] ?? 0 };
}

beforeEach(() => {
  runModel.mockReset();
  runModel.mockResolvedValue({ ok: true, image: Buffer.from("img") } satisfies ReplicateImageResult);
  vi.mocked(replicateClient).mockReturnValue(client);
  vi.mocked(imageModelSentShape).mockImplementation(({ model, aspect }) => ({
    field: aspect === null ? null : model.aspectMode,
    value: aspect,
  }));
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
    // No crop attempt means no pre-crop reading either — `providerSize` stays
    // null rather than lying about a decode this path never performs.
    expect(result.shape?.providerSize).toBeNull();
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

  it("reports the provider-dispatched shape rather than the registry's normalized aspect", async () => {
    vi.mocked(imageModelSentShape).mockReturnValueOnce({
      field: "image_size",
      value: { width: 1536, height: 2048 },
    });

    const result = await renderWithModel({
      model: wan(),
      prompt: "a portrait",
      dimensionFacts: { operation: "generate", resolution: "2K", mappedCustomSize: null },
    });

    expect(result.shape).toMatchObject({
      field: "image_size",
      value: { width: 1536, height: 2048 },
    });
  });

  /**
   * PROTECTS: the wiring this wrapper added for #660 — `referenceCount:
   * references?.length ?? 0` handed to `imageModelSentShape` — not the Civitai
   * Qwen Image 2.1 field mapping itself, which `civitai-qwen21-runtime.test.ts`
   * ("reports a create's size and an edit's pixel budget as the sent shape")
   * and `replicate-runtime.test.ts` ("previews a Qwen Image 2.1 create by size
   * and an edit by pixel budget") already prove against the real function with
   * that lane's own model row. `imageModelSentShape` is mocked in this file, so
   * what is provable here is only that this wrapper computes the count from the
   * PREPARED references (never the raw input length) and passes it through
   * unchanged into `result.shape`. Before this field existed, a lane whose sent
   * shape depends on whether the render is a create or an edit (Qwen Image 2.1
   * sends a size to one and a pixel budget to the other) had no way to tell
   * them apart here, and a stored run would have recorded whichever shape the
   * mock happened to return regardless of what was actually sent.
   */
  it("passes the prepared reference count to imageModelSentShape, so an edit's shape can differ from a create's", async () => {
    vi.mocked(imageModelSentShape).mockImplementation(({ referenceCount }) =>
      referenceCount !== undefined && referenceCount > 0
        ? { field: "resolution", value: 1024 }
        : { field: "width,height", value: "1024x1024" },
    );

    const created = await renderWithModel({ model: wan(), prompt: "a portrait" });
    expect(created.shape).toMatchObject({ field: "width,height", value: "1024x1024" });
    expect(imageModelSentShape).toHaveBeenLastCalledWith(expect.objectContaining({ referenceCount: 0 }));

    const edited = await renderWithModel({
      model: wan(),
      prompt: "change the jacket",
      references: [Buffer.from("a"), Buffer.from("b")],
    });
    expect(edited.shape).toMatchObject({ field: "resolution", value: 1024 });
    expect(imageModelSentShape).toHaveBeenLastCalledWith(expect.objectContaining({ referenceCount: 2 }));
  });
});

/**
 * PROTECTS: #663/#664 — a production edit on Civitai Qwen Image 2.1 used to be
 * refused outright (`civitaiQwen21Workflow`: "sizes an edit from its
 * reference; clear the output shape or remove the references") whenever a
 * caller named a non-null target ratio with at least one reference, which is
 * every reference-view, portrait-variant and chat-scene render. The fix is in
 * `chooseDimensions` (`@vesper/image-core`), not here — this wrapper only has
 * to hand it the reference count, and these cases are what prove the whole
 * seam together: no aspect reaches the transport, the shape mode still reads
 * `target_ratio`, and a real image gets cropped toward it.
 */
describe("renderWithModel and an edit sized from its own reference (Civitai Qwen Image 2.1)", () => {
  it("sends no aspect and crops the decoded output toward the default 3:4 target", async () => {
    vi.mocked(imageModelSentShape).mockImplementation(({ referenceCount }) =>
      referenceCount !== undefined && referenceCount > 0
        ? { field: "resolution", value: 1024 }
        : { field: "width,height", value: "768x1024" },
    );
    const image = await solidImage(1200, 1200, { r: 10, g: 20, b: 30 });
    runModel.mockResolvedValue({ ok: true, image });
    // A Civitai model's reference must decode — an undecodable buffer rejects
    // the render outright rather than degrading (`renderWithModel and
    // Civitai's required reference format` below), which is not this case.
    const reference = await solidImage(8, 8, { r: 1, g: 2, b: 3 });

    const result = await renderWithModel({
      model: civitaiQwen21Model(),
      prompt: "change the jacket",
      references: [reference],
    });

    expect(result.ok).toBe(true);
    // Never reaches the transport — the lane's own refusal (#663/#664) is now
    // structurally unreachable from this path.
    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).toBeNull();
    expect(result.outputDimensions).toEqual({ width: 900, height: 1200 });
    expect(result.shape).toMatchObject({
      mode: "target_ratio",
      // What `imageModelSentShape` says actually reached the provider — the
      // edit's resolution budget, never the create's size.
      field: "resolution",
      value: 1024,
      expectedAspect: null,
      cropTarget: 3 / 4,
    });
    expect(result.shape?.crop).toMatchObject({ targetRatio: 3 / 4 });
    // The provider's OWN size before the local crop — proves a crop was
    // actually attempted, not skipped.
    expect(result.shape?.providerSize).toEqual({ width: 1200, height: 1200 });
  });

  it("still sends an exact create size and crops nothing with zero references", async () => {
    vi.mocked(imageModelSentShape).mockImplementation(({ referenceCount }) =>
      referenceCount !== undefined && referenceCount > 0
        ? { field: "resolution", value: 1024 }
        : { field: "width,height", value: "768x1024" },
    );

    const result = await renderWithModel({ model: civitaiQwen21Model(), prompt: "a portrait" });

    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).toBe("3:4");
    expect(imageModelSentShape).toHaveBeenLastCalledWith(expect.objectContaining({ referenceCount: 0 }));
    expect(result.shape).toMatchObject({ mode: "target_ratio", cropTarget: null });
  });

  it("stays fully native on a raw (null) target ratio even while editing", async () => {
    const reference = await solidImage(8, 8, { r: 1, g: 2, b: 3 });
    const result = await renderWithModel({
      model: civitaiQwen21Model(),
      prompt: "change the jacket",
      references: [reference],
      targetRatio: null,
    });
    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).toBeNull();
    expect(result.shape).toMatchObject({ mode: "provider_default", cropTarget: null });
  });

  it("leaves a different model's edit negotiation untouched", async () => {
    // Klein is also a Civitai model with references, but it is not in
    // `imageModelEditSizesFromReference`'s set — it must keep asking for a
    // shape exactly as it always has.
    const reference = await solidImage(8, 8, { r: 1, g: 2, b: 3 });
    await renderWithModel({
      model: civitaiModel(),
      prompt: "change the jacket",
      references: [reference],
    });
    expect(runModel.mock.calls.at(-1)?.[1]?.aspect).not.toBeNull();
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

/**
 * PROTECTS (#682): the one line that makes `recoverCivitaiOutput` reachable at
 * all — a transport result naming an undelivered output's blob id must reach
 * this wrapper's own result, exactly as `predictionId` already does beside it.
 * Nothing below this wrapper (`render-intent.test.ts`,
 * `reference-view-build.test.ts`) exercises this merge: each mocks
 * `renderWithModel` itself, so a dropped spread here would leave every failed
 * render's attempt without the blob id and make its paid output unrecoverable,
 * with nothing in CI to say so.
 */
describe("renderWithModel and a Civitai output that could not be downloaded (#682)", () => {
  it("passes the undelivered output id through on a failed render, absence included", async () => {
    runModel.mockResolvedValue({
      ok: false,
      error: "Civitai output download failed (civitai_output_undelivered; retry=reconcile)",
      predictionId: "pred-undelivered",
      undeliveredOutputId: "blob-undelivered",
    });
    const undelivered = await renderWithModel({ model: wan(), prompt: "a portrait" });
    expect(undelivered).toMatchObject({ ok: false, predictionId: "pred-undelivered", undeliveredOutputId: "blob-undelivered" });

    runModel.mockResolvedValue({ ok: false, error: "the provider refused this render", predictionId: "pred-ordinary" });
    const ordinary = await renderWithModel({ model: wan(), prompt: "a portrait" });
    expect("undeliveredOutputId" in ordinary).toBe(false);
  });
});

/**
 * PROTECTS: the wiring between this wrapper and `referencePreparationTarget`
 * (#626) — not the target-selection logic itself, which
 * `reference-preparation.test.ts` owns in isolation. Before the fix, every
 * provider shared one hardcoded webp target, so a clean webp reference
 * reached Civitai byte-identical: accepted at every checkpoint that could
 * refuse it (upload, `whatif` preflight, workflow schedule), then failed the
 * render job silently with a full refund. A test that only calls
 * `referencePreparationTarget` directly would not catch this wrapper reverting
 * to a hardcoded target; these exercise `renderWithModel` itself with a
 * Civitai-slugged model and a real image buffer.
 */
describe("renderWithModel and Civitai's required reference format", () => {
  it("converts a clean webp reference to jpeg for a Civitai model, instead of shipping it unchanged", async () => {
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .webp()
      .toBuffer();
    await renderWithModel({
      model: civitaiModel(),
      prompt: "a portrait",
      references: [webp],
      referenceRoles: ["identity"],
    });
    const sent = runModel.mock.calls.at(-1)?.[1]?.references;
    // Before #626 this would be the SAME webp object, passed straight through —
    // exactly the byte-identical reference Civitai accepted and then silently
    // failed on. It must now be re-encoded to jpeg.
    expect(sent?.[0]?.mediaType).toBe("image/jpeg");
    expect(sent?.[0]?.bytes).not.toBe(webp);
  });

  it("fails the render rather than shipping an unreadable reference to Civitai", async () => {
    await expect(
      renderWithModel({
        model: civitaiModel(),
        prompt: "a portrait",
        references: [Buffer.from("not an image")],
        referenceRoles: ["identity"],
      }),
    ).rejects.toThrow(/could not be encoded to jpeg/);
    // The transport must never see the request: for this provider, a paid
    // render lost to an unreadable reference is worse than refusing it before
    // submission (docs/resilience.md's degrade trade reverses here).
    expect(runModel).not.toHaveBeenCalled();
  });
});

/**
 * PROTECTS: this wrapper hands the transport the model row AS STORED.
 *
 * The defect it kills: `withReviewedImageQuality`, the slug-keyed overlay that
 * used to run here and merge Vesper's reviewed corrections into `extraInput` on
 * the way out. With a reviewed setting arriving from two owners, a task profile
 * that carried none of them still rendered correctly — so the profile was not
 * load-bearing and nothing could tell the two apart (#244). The profile is the
 * one owner now (`reviewed-profile-parity.test.ts` reads the settings back off
 * the final payload), and this wrapper is the other place the rewrite lived.
 */
describe("renderWithModel and Vesper's reviewed settings", () => {
  it("sends a reviewed model's row untouched, rewriting nothing by slug", async () => {
    const reviewed = imageModelSchema.parse({
      id: "qwen-edit-1",
      // A slug the reviewed table names. Pinned, because the retired overlay
      // matched on the base provider path either way — a bare slug here would
      // not tell a restored overlay from an absent one.
      slug: "qwen/qwen-image-edit-2511:abc123",
      label: "Qwen Image Edit 2511 Fixture",
      canGenerate: false,
      canEdit: true,
      aspectMode: "aspect_ratio",
      supportedAspects: ["3:4"],
      // The provider's own speed preset, which this model's reviewed ruling
      // turns off — as the profile's `fastMode` control, never here. The overlay
      // rewrote exactly this key.
      extraInput: { go_fast: true, output_quality: 95 },
    });

    await renderWithModel({ model: reviewed, prompt: "change the coat" });

    expect(runModel.mock.calls.at(-1)?.[0]?.extraInput).toEqual({ go_fast: true, output_quality: 95 });
  });
});

describe("cropToTargetAspect", () => {
  it("returns the buffer unchanged when the ratio already matches", async () => {
    const image = await solidImage(900, 1200, { r: 10, g: 20, b: 30 });
    const placement = chooseCropPlacement({ outputWidth: 900, outputHeight: 1200, targetRatio: 3 / 4, focal: null });
    const result = await cropToTargetAspect(image, 3 / 4, placement);
    expect(result).toBe(image);
  });

  it("centers a too-wide trim", async () => {
    const image = await solidImage(1600, 800, { r: 200, g: 0, b: 0 });
    const placement = chooseCropPlacement({ outputWidth: 1600, outputHeight: 800, targetRatio: 3 / 4, focal: null });
    const cropped = await cropToTargetAspect(image, 3 / 4, placement);
    const meta = await sharp(cropped).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(800);
  });

  it("top-anchors a too-tall trim for a subject-bearing task", async () => {
    // Red on top, blue on the bottom half. A top-anchored crop keeps original
    // row 600 (still red); a centered crop would have landed on row 866 (blue).
    const top = await solidImage(800, 800, { r: 255, g: 0, b: 0 });
    const bottom = await solidImage(800, 800, { r: 0, g: 0, b: 255 });
    const image = await sharp({ create: { width: 800, height: 1600, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([
        { input: top, left: 0, top: 0 },
        { input: bottom, left: 0, top: 800 },
      ])
      .png()
      .toBuffer();
    const placement = chooseCropPlacement({ task: "portrait", outputWidth: 800, outputHeight: 1600, targetRatio: 3 / 4, focal: null });
    const cropped = await cropToTargetAspect(image, 3 / 4, placement);
    const meta = await sharp(cropped).metadata();
    expect(meta.height).toBe(1067);
    expect(await pixelAt(cropped, 10, 600)).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("centers a too-tall trim for a non-subject task", async () => {
    // Same fixture as above, `task: "item"` instead: row 600 of the crop must
    // now be blue (original row 866), proving the anchor actually moved.
    const top = await solidImage(800, 800, { r: 255, g: 0, b: 0 });
    const bottom = await solidImage(800, 800, { r: 0, g: 0, b: 255 });
    const image = await sharp({ create: { width: 800, height: 1600, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([
        { input: top, left: 0, top: 0 },
        { input: bottom, left: 0, top: 800 },
      ])
      .png()
      .toBuffer();
    const placement = chooseCropPlacement({ task: "item", outputWidth: 800, outputHeight: 1600, targetRatio: 3 / 4, focal: null });
    const cropped = await cropToTargetAspect(image, 3 / 4, placement);
    expect(await pixelAt(cropped, 10, 600)).toEqual({ r: 0, g: 0, b: 255 });
  });

  it("shifts the crop window to keep an off-centre focal box in frame", async () => {
    const background = await solidImage(1000, 1000, { r: 10, g: 20, b: 30 });
    const marker = await solidImage(100, 100, { r: 250, g: 250, b: 0 });
    const image = await sharp(background)
      .composite([{ input: marker, left: 800, top: 400 }])
      .png()
      .toBuffer();
    const placement = chooseCropPlacement({
      outputWidth: 1000,
      outputHeight: 1000,
      targetRatio: 3 / 4,
      focal: { left: 800, top: 400, width: 100, height: 100 },
    });
    const cropped = await cropToTargetAspect(image, 3 / 4, placement);
    // The marker's original span [800, 900) lands at [550, 650) in the 750-wide crop.
    expect(await pixelAt(cropped, 600, 450)).toEqual({ r: 250, g: 250, b: 0 });
    expect(await pixelAt(cropped, 50, 450)).toEqual({ r: 10, g: 20, b: 30 });
  });
});

describe("renderWithModel crop placement", () => {
  it("anchors a too-tall crop to the top for a subject-bearing task and records the crop", async () => {
    const image = await solidImage(800, 1600, { r: 10, g: 20, b: 30 });
    runModel.mockResolvedValue({ ok: true, image });
    const result = await renderWithModel({ model: noAspectModel(), prompt: "a portrait", targetRatio: 3 / 4, task: "portrait" });
    expect(result.ok).toBe(true);
    expect(result.outputDimensions).toEqual({ width: 800, height: 1067 });
    expect(result.shape?.cropTarget).toBe(3 / 4);
    expect(result.shape?.crop).toMatchObject({
      targetRatio: 3 / 4,
      placement: "top",
      focalSource: "none",
      rect: { left: 0, top: 0, width: 800, height: 1067 },
    });
    // The PRE-crop size — 1600 tall, not the 1067 the crop actually kept.
    // `outputDimensions` above already proves the post-crop size; this proves
    // the wrapper also kept the one number that lets a caller compute what
    // the crop removed.
    expect(result.shape?.providerSize).toEqual({ width: 800, height: 1600 });
  });

  it("centers a too-tall crop for a non-subject task", async () => {
    const image = await solidImage(800, 1600, { r: 10, g: 20, b: 30 });
    runModel.mockResolvedValue({ ok: true, image });
    const result = await renderWithModel({ model: noAspectModel(), prompt: "an item", targetRatio: 3 / 4, task: "item" });
    expect(result.shape?.crop).toMatchObject({ placement: "center" });
  });

  it("shifts the crop to a supplied focal box and records where it came from", async () => {
    const image = await solidImage(1000, 1000, { r: 10, g: 20, b: 30 });
    runModel.mockResolvedValue({ ok: true, image });
    const result = await renderWithModel({
      model: noAspectModel(),
      prompt: "a portrait",
      targetRatio: 3 / 4,
      focal: { left: 800, top: 400, width: 100, height: 100 },
    });
    expect(result.shape?.crop).toMatchObject({
      placement: "focal",
      focalSource: "detector",
      rect: { left: 250, top: 0, width: 750, height: 1000 },
    });
  });

  it("records no crop at all when the returned shape already matches the target", async () => {
    const image = await solidImage(900, 1200, { r: 10, g: 20, b: 30 });
    runModel.mockResolvedValue({ ok: true, image });
    const result = await renderWithModel({ model: noAspectModel(), prompt: "a portrait", targetRatio: 3 / 4, task: "portrait" });
    expect(result.shape?.cropTarget).toBeNull();
    expect(result.shape?.crop).toBeNull();
    // A read was taken (the wrapper had to check whether cropping was
    // needed), but nothing was cropped, so `providerSize` is populated —
    // exercised here for the case `evaluateCropLoss` will read as
    // "crop == null, so skip regardless of providerSize".
    expect(result.shape?.providerSize).toEqual({ width: 900, height: 1200 });
  });
});
