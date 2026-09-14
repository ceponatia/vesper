/**
 * Which stored files may be served with a real content type.
 *
 * Pure and client-importable on purpose: the Files page decides whether a row
 * opens in the lightbox or downloads, and the preview route decides what
 * `Content-Type` to send. Those two decisions must name the same extensions, so
 * they read one list rather than two that can drift apart.
 *
 * Admin Files serves every byte as an inert `application/octet-stream`
 * attachment, which is the guarantee that an uploaded file cannot become an
 * application artifact. The preview route
 * (`apps/web/src/app/api/admin/self/files/preview/route.ts`) is the single place
 * that trades the inert type for a real one, so this allowlist is a security
 * boundary rather than a convenience table: it is matched on the final extension
 * of the name the server resolved, never sniffed from the bytes and never taken
 * from a client-supplied type, and `X-Content-Type-Options: nosniff` rides every
 * response from that route so a file named `x.png` whose bytes are HTML can
 * never be reinterpreted as a document in Vesper's origin.
 */

export type MediaPreviewKind = "image" | "video" | "audio";

export interface MediaPreviewType {
  /** The exact `Content-Type` the preview route sends for this extension. */
  contentType: string;
  /** Which element plays it: `<img>`, `<video controls>`, `<audio controls>`. */
  kind: MediaPreviewKind;
}

/**
 * Lowercase ASCII extension -> served type.
 *
 * `svg` is deliberately absent and must stay absent: an SVG is a document that
 * can carry script, so navigating to one served as `image/svg+xml` would
 * execute it in Vesper's origin. `pdf`, `html` and every text-like type are
 * absent for the same reason. `mkv`, `avi`, `mov` and HEVC are absent for a
 * different one — no browser decodes them dependably, and an inline player
 * showing an empty frame is worse than the download that already works.
 */
const MEDIA_PREVIEW_TYPES = new Map<string, MediaPreviewType>([
  ["png", { contentType: "image/png", kind: "image" }],
  ["jpg", { contentType: "image/jpeg", kind: "image" }],
  ["jpeg", { contentType: "image/jpeg", kind: "image" }],
  ["webp", { contentType: "image/webp", kind: "image" }],
  ["gif", { contentType: "image/gif", kind: "image" }],
  ["avif", { contentType: "image/avif", kind: "image" }],
  ["mp4", { contentType: "video/mp4", kind: "video" }],
  ["webm", { contentType: "video/webm", kind: "video" }],
  ["ogv", { contentType: "video/ogg", kind: "video" }],
  ["mp3", { contentType: "audio/mpeg", kind: "audio" }],
  ["m4a", { contentType: "audio/mp4", kind: "audio" }],
  ["aac", { contentType: "audio/aac", kind: "audio" }],
  ["ogg", { contentType: "audio/ogg", kind: "audio" }],
  ["oga", { contentType: "audio/ogg", kind: "audio" }],
  ["wav", { contentType: "audio/wav", kind: "audio" }],
  ["flac", { contentType: "audio/flac", kind: "audio" }],
]);

/**
 * Every previewable extension, sorted. The page reads this to decide whether a
 * row opens in the lightbox or downloads, which is the same question the
 * preview route answers when it chooses a content type.
 */
export const MEDIA_PREVIEW_EXTENSIONS: readonly string[] = [...MEDIA_PREVIEW_TYPES.keys()].sort();

const ASCII_EXTENSION = /^[A-Za-z0-9]+$/;

/**
 * The served type for a file name, or `null` when it is not previewable.
 *
 * Only the final extension decides, so `report.html.png` is an image and
 * `avatar.png.html` is not. The raw extension must be ASCII alphanumeric
 * *before* it is lowercased: Unicode case folding maps characters such as the
 * Kelvin sign onto ASCII letters, and an allowlist that folded first could be
 * entered by a name that is not the extension it appears to be. A leading dot
 * is a hidden file rather than a bare extension, so `.png` is not previewable.
 */
export function mediaPreviewType(name: string): MediaPreviewType | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1);
  if (!ASCII_EXTENSION.test(extension)) return null;
  return MEDIA_PREVIEW_TYPES.get(extension.toLowerCase()) ?? null;
}
