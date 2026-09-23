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

/**
 * The two `meta.source` literals `storeReusableImageReference`
 * (`server/images/upload.ts`) writes on a `generator_output` row minted
 * OUTSIDE a run: a direct Generator upload, and a Files import. A run's own
 * output row never carries either value — this is the entire authorization
 * boundary between "the bench's own upload shelf" (issue #635) and "a render a
 * run produced", since both share the same `kind`.
 */
export const imageGeneratorUploadSourceSchema = z.enum(["generator_upload", "admin_files_import"]);
export type ImageGeneratorUploadSource = z.infer<typeof imageGeneratorUploadSourceSchema>;

/**
 * One reference/control image the admin uploaded directly to the Generator
 * bench — never a run's own output — as the uploads panel reads it: ids and
 * metadata only, no bytes. The owner reads the pixels through the ordinary
 * owner-scoped image file route, exactly like every other hidden Generator
 * asset.
 */
export const imageGeneratorUploadSchema = z.object({
  imageId: z.string().min(1),
  createdAt: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  source: imageGeneratorUploadSourceSchema,
  /** Display only — absent when no file name was recorded for this upload. */
  originalName: z.string().min(1).max(255).optional(),
});
export type ImageGeneratorUpload = z.infer<typeof imageGeneratorUploadSchema>;
