import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { chooseCropPlacement, imageModelSchema } from "@vesper/image-core";
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
