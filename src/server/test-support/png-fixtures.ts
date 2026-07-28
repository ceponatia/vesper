import sharp from "sharp";

/**
 * Real PNGs for the image pipeline suites. Three copies existed, differing only
 * in dimensions and fill colour — none of which any assertion reads; what the
 * tests check is that the bytes are a decodable raster (so the webp conversion,
 * the data-URL decoder and the cover-crop all have genuine input rather than a
 * hand-written header).
 *
 * Built with sharp rather than a checked-in fixture file so the dimensions can
 * vary per case — the avatar crop test needs a landscape source to prove the 3:4
 * portrait crop actually happened.
 */

/** Small enough to build in microseconds, non-square so an accidental transpose shows up. */
const DEFAULT_WIDTH = 8;
const DEFAULT_HEIGHT = 12;

/** Fill colour is arbitrary but FIXED, so repeated runs produce byte-identical buffers. */
export async function testPngBuffer(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 80 } } })
    .png()
    .toBuffer();
}

/** The same image as a `data:image/png;base64,...` URL — the upload/avatar route input shape. */
export async function testPngDataUrl(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT): Promise<string> {
  const png = await testPngBuffer(width, height);
  return `data:image/png;base64,${png.toString("base64")}`;
}
