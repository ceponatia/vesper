import { describe, expect, it } from "vitest";
import { testPngDataUrl } from "@/server/test-support";
import { decodeDataUrl } from "./upload";

const MAX_DECODED_BYTES = 4 * 1024 * 1024;

/** A real 1×1 PNG rendered by sharp — the smallest genuine raster the decoder can accept. */
const tinyPng = () => testPngDataUrl(1, 1);

describe("decodeDataUrl", () => {
  it("rejects an SVG data URL (no librsvg path) — returns null", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64");
    expect(decodeDataUrl(`data:image/svg+xml;base64,${svg}`)).toBeNull();
  });

  it("rejects non-allow-list raster mimes (e.g. gif, tiff)", () => {
    const payload = Buffer.from("nope").toString("base64");
    expect(decodeDataUrl(`data:image/gif;base64,${payload}`)).toBeNull();
    expect(decodeDataUrl(`data:image/tiff;base64,${payload}`)).toBeNull();
  });

  it("rejects an oversized base64 payload pre-decode, without materializing it", () => {
    // A payload whose *estimated* decoded size exceeds the cap. We never build a
    // real buffer of this size: the string of base64 chars alone is enough for
    // the pre-decode length check to reject it. 'A' is a valid base64 char.
    const overByChars = MAX_DECODED_BYTES * 2; // ~2 chars per byte, comfortably over
    const huge = "A".repeat(overByChars);
    expect(decodeDataUrl(`data:image/png;base64,${huge}`)).toBeNull();
  });

  it("accepts a valid tiny PNG data URL", async () => {
    const decoded = decodeDataUrl(await tinyPng());
    expect(decoded).not.toBeNull();
    expect(decoded?.mime).toBe("image/png");
    expect(decoded?.buffer.byteLength).toBeGreaterThan(0);
    expect(decoded?.buffer.byteLength).toBeLessThan(MAX_DECODED_BYTES);
  });

  it("normalizes the mime to lower case and accepts mixed-case mimes", async () => {
    const png = await tinyPng();
    const mixed = png.replace("data:image/png", "data:image/PNG");
    expect(decodeDataUrl(mixed)?.mime).toBe("image/png");
  });

  it("returns null for non-image / malformed data URLs", () => {
    expect(decodeDataUrl("data:text/plain;base64,aGVsbG8=")).toBeNull();
    expect(decodeDataUrl("not a data url")).toBeNull();
    expect(decodeDataUrl("data:image/png;base64,")).toBeNull();
  });
});
