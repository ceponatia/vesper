import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";
import { testPngBuffer } from "@/server/test-support";
import { shapeProviderOutput } from "./provider-output-shape";

/**
 * **A recovered output is stored in the shape its render would have stored**
 * (#682). The decision is the render's own (`renderWithModel`): no crop for a
 * request that named no ratio, none for an expected shape that already
 * matched, and otherwise a crop of the decoded image toward the ratio —
 * top-anchored for a too-tall subject render, centred for a too-wide one.
 * Each case kills one way a recovered view would differ from the render that
 * should have landed.
 */
describe("shapeProviderOutput", () => {
  const size = async (buffer: Buffer) => {
    const { width, height } = await sharp(buffer).metadata();
    return { width, height };
  };

  it("never crops a request that named no ratio", async () => {
    const original = await testPngBuffer(900, 1000);
    const shaped = await shapeProviderOutput(original, { targetRatio: null, expectedAspect: null, task: "variant" });
    expect(shaped).toEqual({ image: original, crop: null, providerSize: null, returned: { width: 900, height: 1000 } });
  });

  it("trusts an expected shape that already matched the ratio, as the render does", async () => {
    const original = await testPngBuffer(900, 1000);
    const shaped = await shapeProviderOutput(original, { targetRatio: 3 / 4, expectedAspect: 3 / 4, task: "variant" });
    expect(shaped.image).toBe(original);
    expect(shaped.crop).toBeNull();
  });

  it("crops a too-wide output to the ratio from the centre", async () => {
    const shaped = await shapeProviderOutput(await testPngBuffer(900, 1000), { targetRatio: 3 / 4, expectedAspect: null, task: "variant" });
    expect(await size(shaped.image)).toEqual({ width: 750, height: 1000 });
    expect(shaped).toMatchObject({
      crop: { targetRatio: 3 / 4, placement: "center", rect: { left: 75, top: 0, width: 750, height: 1000 }, focalSource: "none" },
      providerSize: { width: 900, height: 1000 },
      returned: { width: 750, height: 1000 },
    });
  });

  it("anchors a too-tall subject render's crop to the top, where the head is", async () => {
    const shaped = await shapeProviderOutput(await testPngBuffer(600, 1200), { targetRatio: 3 / 4, expectedAspect: 1 / 2, task: "variant" });
    expect(await size(shaped.image)).toEqual({ width: 600, height: 800 });
    expect(shaped.crop).toMatchObject({ placement: "top", rect: { left: 0, top: 0, width: 600, height: 800 } });
  });

  it("records no crop for an output already at the ratio", async () => {
    const original = await testPngBuffer(600, 800);
    const shaped = await shapeProviderOutput(original, { targetRatio: 3 / 4, expectedAspect: null, task: "variant" });
    expect(shaped).toEqual({ image: original, crop: null, providerSize: { width: 600, height: 800 }, returned: { width: 600, height: 800 } });
  });

  it("keeps bytes it cannot decode uncropped, and says so", async () => {
    const original = Buffer.from("not an image");
    const sink = new DiagnosticCollector();
    const shaped = await shapeProviderOutput(original, { targetRatio: 3 / 4, expectedAspect: null, task: "variant" }, sink);
    expect(shaped).toEqual({ image: original, crop: null, providerSize: null, returned: null });
    expectDiagnostic(sink, "image_model.crop_failed");
  });
});
