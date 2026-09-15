import { z } from "zod";

/**
 * Transport ceiling for a local Image Generator reference/control upload.
 *
 * The upload travels as a base64 data URL. This deliberately matches the
 * existing avatar/Image Lab upload ceiling so the browser can reject the same
 * oversized payload the route would reject before decode. `decodeDataUrl`
 * independently enforces its decoded-byte and raster-MIME limits.
 */
export const IMAGE_GENERATOR_UPLOAD_DATA_URL_MAX_CHARS = 3_000_000;

/**
 * A local file converges into the Generator's existing image-id input contract;
 * raw bytes never become part of a run request.
 */
export const imageGeneratorUploadRequestSchema = z.object({
  dataUrl: z
    .string()
    .min(1)
    .max(IMAGE_GENERATOR_UPLOAD_DATA_URL_MAX_CHARS)
    .refine((value) => value.startsWith("data:image/"), "dataUrl must be an image data URL"),
  /** Display/provenance only. Never used to determine MIME or provider routing. */
  fileName: z.string().trim().min(1).max(255).optional(),
});

export type ImageGeneratorUploadRequest = z.infer<typeof imageGeneratorUploadRequestSchema>;
