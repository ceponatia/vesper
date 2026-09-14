import { describe, expect, it } from "vitest";
import type { AdminFileEntry } from "@/lib/client/api";
import { previewKindForEntry } from "./files-page-preview";

function entry(params: { name: string; kind: "file" | "folder" }): AdminFileEntry {
  return {
    path: params.name,
    kind: params.kind,
    name: params.name,
    size: params.kind === "folder" ? null : 0,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("previewKindForEntry", () => {
  it("classifies an image file by extension", () => {
    expect(previewKindForEntry(entry({ name: "sunset.png", kind: "file" }))).toBe("image");
  });

  it("classifies video and audio files by extension", () => {
    expect(previewKindForEntry(entry({ name: "clip.mp4", kind: "file" }))).toBe("video");
    expect(previewKindForEntry(entry({ name: "voice.mp3", kind: "file" }))).toBe("audio");
  });

  it("returns null for a file extension the allowlist does not recognize", () => {
    expect(previewKindForEntry(entry({ name: "notes.txt", kind: "file" }))).toBeNull();
    expect(previewKindForEntry(entry({ name: "diagram.svg", kind: "file" }))).toBeNull();
  });

  it("never treats a folder as previewable, even one named like a media file", () => {
    expect(previewKindForEntry(entry({ name: "movie.mp4", kind: "folder" }))).toBeNull();
  });
});
