import { describe, expect, it } from "vitest";
import {
  MEDIA_PREVIEW_EXTENSIONS,
  mediaPreviewType,
  type MediaPreviewKind,
} from "./media-preview";

/**
 * The allowlist is pinned literally, sorted, rather than derived from the
 * module. It is the security boundary that lets Files serve user-supplied bytes
 * with a real content type instead of an inert attachment, so adding an
 * extension has to be a visible edit in two places, and `svg` — a document that
 * can carry script — must never appear in either.
 */
const ALLOWED: ReadonlyArray<{ extension: string; contentType: string; kind: MediaPreviewKind }> = [
  { extension: "aac", contentType: "audio/aac", kind: "audio" },
  { extension: "avif", contentType: "image/avif", kind: "image" },
  { extension: "flac", contentType: "audio/flac", kind: "audio" },
  { extension: "gif", contentType: "image/gif", kind: "image" },
  { extension: "jpeg", contentType: "image/jpeg", kind: "image" },
  { extension: "jpg", contentType: "image/jpeg", kind: "image" },
  { extension: "m4a", contentType: "audio/mp4", kind: "audio" },
  { extension: "mp3", contentType: "audio/mpeg", kind: "audio" },
  { extension: "mp4", contentType: "video/mp4", kind: "video" },
  { extension: "oga", contentType: "audio/ogg", kind: "audio" },
  { extension: "ogg", contentType: "audio/ogg", kind: "audio" },
  { extension: "ogv", contentType: "video/ogg", kind: "video" },
  { extension: "png", contentType: "image/png", kind: "image" },
  { extension: "wav", contentType: "audio/wav", kind: "audio" },
  { extension: "webm", contentType: "video/webm", kind: "video" },
  { extension: "webp", contentType: "image/webp", kind: "image" },
];

describe("mediaPreviewType", () => {
  it("publishes exactly the pinned allowlist", () => {
    expect(MEDIA_PREVIEW_EXTENSIONS).toEqual(ALLOWED.map(({ extension }) => extension));
  });

  it.each(ALLOWED)("serves .$extension as $contentType", ({ extension, contentType, kind }) => {
    expect(mediaPreviewType(`holiday.${extension}`)).toEqual({ contentType, kind });
  });

  it.each(ALLOWED)("matches .$extension whatever its case", ({ extension, contentType, kind }) => {
    expect(mediaPreviewType(`holiday.${extension.toUpperCase()}`)).toEqual({ contentType, kind });
  });

  it("refuses svg, because an SVG is a document that can carry script", () => {
    expect(mediaPreviewType("logo.svg")).toBeNull();
    expect(mediaPreviewType("logo.SVG")).toBeNull();
    expect(MEDIA_PREVIEW_EXTENSIONS).not.toContain("svg");
  });

  it.each(["notes.txt", "page.html", "app.js", "report.pdf", "clip.mkv", "clip.mov", "clip.avi", "photo.heic"])(
    "refuses %s",
    (name) => {
      expect(mediaPreviewType(name)).toBeNull();
    },
  );

  it("decides on the final extension and nothing before it", () => {
    // The direction that matters: a name ending in a document extension is
    // never previewable, whatever precedes it.
    expect(mediaPreviewType("avatar.png.html")).toBeNull();
    expect(mediaPreviewType("report.html.png")).toEqual({ contentType: "image/png", kind: "image" });
  });

  it("needs a real extension, not a bare name or a hidden file", () => {
    expect(mediaPreviewType("png")).toBeNull();
    expect(mediaPreviewType("holiday.")).toBeNull();
    expect(mediaPreviewType(".png")).toBeNull();
    expect(mediaPreviewType("")).toBeNull();
  });

  it("requires a plain ASCII extension before any case folding", () => {
    // U+212A KELVIN SIGN lower-cases to ASCII "k", and a fullwidth letter does
    // not fold to ASCII at all. Requiring ASCII on the raw extension keeps both
    // out of the lookup, so this holds if an allowlisted extension ever
    // contains a foldable letter.
    expect(mediaPreviewType("clip.m\u212Av")).toBeNull();
    expect(mediaPreviewType("photo.\uFF50ng")).toBeNull();
    expect(mediaPreviewType("photo.png\u00A0")).toBeNull();
    expect(mediaPreviewType("photo.png ")).toBeNull();
  });
});
