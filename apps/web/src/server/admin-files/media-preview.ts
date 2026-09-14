/**
 * How the preview route shapes a response: the `Range` window it will honour,
 * and the inline `Content-Disposition` it sends.
 *
 * Both are pure, so `media-preview.test.ts` drives every boundary case directly
 * and the route stays a thin shell over `getAdminFileDownload`. Which files may
 * be previewed at all is a separate question, answered by `@/lib/media-preview`
 * because the page has to ask it too.
 */

/**
 * One resolved `Range` request against a known size.
 *
 * - `whole`: serve the entire file with `200`. This covers both "no range asked
 *   for" and the deliberate degrade for a header this route will not honour.
 * - `bounded`: serve `206`; `start` and `end` are inclusive byte offsets
 *   already clamped inside the file.
 * - `unsatisfiable`: answer `416`, whose `Content-Range` names only the size.
 */
export type MediaRange =
  | { readonly kind: "whole" }
  | { readonly kind: "bounded"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const WHOLE: MediaRange = { kind: "whole" };
const UNSATISFIABLE: MediaRange = { kind: "unsatisfiable" };

const BYTES_UNIT = /^bytes=/i;
const DIGITS = /^\d+$/;

/** A byte position, or `null` when the text is not one this route will trust. */
function bytePosition(text: string): number | null {
  if (!DIGITS.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parse a single `bytes=` range against the size taken from the already-open
 * descriptor. Pure arithmetic over that one size is what keeps a 206 inside the
 * file it describes: the window is clamped here, and the route hands the same
 * two numbers to `Content-Length`, `Content-Range` and the bounded read.
 *
 * A header this route will not honour degrades to the whole file rather than
 * erroring — an unknown range unit, a malformed specifier, an inverted one
 * (RFC 9110 permits ignoring an invalid ranges-specifier), and a multi-range
 * request, which no media element sends and which would otherwise require a
 * `multipart/byteranges` body. Only a syntactically valid range lying outside
 * the file is unsatisfiable; that includes every range against a zero-byte
 * file, which has no byte to return.
 */
export function parseMediaRange(headerValue: string | null, size: number): MediaRange {
  if (headerValue === null) return WHOLE;
  const header = headerValue.trim();
  if (!BYTES_UNIT.test(header)) return WHOLE;

  const spec = header.slice("bytes=".length).trim();
  if (spec.includes(",")) return WHOLE;

  const dash = spec.indexOf("-");
  if (dash === -1 || spec.indexOf("-", dash + 1) !== -1) return WHOLE;
  const firstText = spec.slice(0, dash).trim();
  const lastText = spec.slice(dash + 1).trim();

  if (firstText.length === 0) {
    // Suffix form: the last N bytes. A representation shorter than N is served
    // whole; a zero-length suffix overlaps nothing and cannot be satisfied.
    const suffix = bytePosition(lastText);
    if (suffix === null) return WHOLE;
    if (suffix === 0 || size === 0) return UNSATISFIABLE;
    return { kind: "bounded", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = bytePosition(firstText);
  if (start === null) return WHOLE;

  if (lastText.length === 0) {
    // Open-ended form: `start` through the last byte. A `<video>` opens with
    // `bytes=0-`, so this is the common case rather than an edge one.
    if (start >= size) return UNSATISFIABLE;
    return { kind: "bounded", start, end: size - 1 };
  }

  const last = bytePosition(lastText);
  if (last === null || last < start) return WHOLE;
  if (start >= size) return UNSATISFIABLE;
  return { kind: "bounded", start, end: Math.min(last, size - 1) };
}

/**
 * `Content-Disposition` for an inline preview: a sanitized ASCII `filename` for
 * old parsers plus the RFC 5987 `filename*` carrying the real name — the same
 * two-form encoding the download route uses, so a "Save as…" from a player and
 * an explicit Download land the same file name.
 *
 * Deliberately a separate builder from the download route's rather than one
 * shared helper taking the disposition as an argument: that route's
 * `attachment` is the inert-download guarantee, and a shared helper would put a
 * single edit between that guarantee and this one.
 */
export function inlineDispositionHeader(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "download";
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
