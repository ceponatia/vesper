import { describe, expect, it } from "vitest";
import type { AdminFileFailure } from "@/lib/client/api";
import {
  batchUploadLabel,
  conflictMessage,
  deleteConfirmTitle,
  deleteResultToast,
  formatBytes,
  formatDate,
  moveResultToast,
} from "./files-page-copy";

function failure(overrides: Partial<AdminFileFailure> = {}): AdminFileFailure {
  return { path: "a/b.txt", code: "not_found", message: "not found", ...overrides };
}

describe("formatBytes", () => {
  it("names a null size as a folder", () => {
    expect(formatBytes(null)).toBe("Folder");
  });

  it("stays in bytes under 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("scales up through the unit ladder", () => {
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("drops to one decimal once the value reaches double digits", () => {
    expect(formatBytes(12 * 1024)).toBe("12.0 KB");
  });
});

describe("formatDate", () => {
  it("renders a valid ISO timestamp as a locale string", () => {
    expect(formatDate("2026-01-01T00:00:00.000Z").length).toBeGreaterThan(0);
  });

  it("degrades to an empty string for an unparseable value, instead of \"Invalid Date\"", () => {
    expect(formatDate("not a date")).toBe("");
  });
});

describe("deleteConfirmTitle", () => {
  it("states both counts when the selection holds folders and files", () => {
    expect(deleteConfirmTitle({ files: 14, folders: 2, truncated: false })).toBe("Delete 2 folders and 14 files?");
  });

  it("uses singular nouns for a count of one", () => {
    expect(deleteConfirmTitle({ files: 1, folders: 0, truncated: false })).toBe("Delete 1 file?");
    expect(deleteConfirmTitle({ files: 0, folders: 1, truncated: false })).toBe("Delete 1 folder?");
  });

  it("omits the files clause only when folders are present and files are zero", () => {
    expect(deleteConfirmTitle({ files: 0, folders: 3, truncated: false })).toBe("Delete 3 folders?");
  });

  it("still names zero files when nothing at all is a folder (defensive fallback)", () => {
    expect(deleteConfirmTitle({ files: 0, folders: 0, truncated: false })).toBe("Delete 0 files?");
  });

  it("names only the truncated files count, comma-grouped, ignoring any folder count", () => {
    expect(deleteConfirmTitle({ files: 10000, folders: 7, truncated: true })).toBe("Delete 10,000+ files?");
  });
});

describe("deleteResultToast", () => {
  it("reports a clean success with no description", () => {
    expect(deleteResultToast(3, [])).toEqual({ title: "Deleted 3 items", tone: "success" });
  });

  it("uses the singular noun for one", () => {
    expect(deleteResultToast(1, [])).toEqual({ title: "Deleted 1 item", tone: "success" });
  });

  it("reports total failure as an error naming the cause", () => {
    const result = deleteResultToast(0, [failure({ message: "in use" })]);
    expect(result.tone).toBe("error");
    expect(result.title).toBe("Delete failed");
    expect(result.description).toContain("in use");
  });

  it("reports a partial success as an error toast that still states how many succeeded", () => {
    const result = deleteResultToast(2, [failure()]);
    expect(result.tone).toBe("error");
    expect(result.title).toBe("Deleted 2 items");
    expect(result.description).toContain("a/b.txt");
  });

  it("names the first failure and counts the rest, without listing every one", () => {
    const result = deleteResultToast(0, [failure({ path: "a" }), failure({ path: "b" }), failure({ path: "c" })]);
    expect(result.description).toContain("a:");
    expect(result.description).toContain("+2 more");
    expect(result.description).not.toContain("b:");
  });
});

describe("moveResultToast", () => {
  it("reports a clean success", () => {
    expect(moveResultToast(4, [])).toEqual({ title: "Moved 4 items", tone: "success" });
  });

  it("reports total failure naming the collision", () => {
    const result = moveResultToast(0, [failure({ code: "already_exists", message: "already exists" })]);
    expect(result.tone).toBe("error");
    expect(result.title).toBe("Move failed");
    expect(result.description).toContain("already exists");
  });
});

describe("batchUploadLabel", () => {
  it("names the file and its position in the batch", () => {
    expect(batchUploadLabel(7, 41, "photo.png")).toBe("Uploading 7 of 41: photo.png");
  });
});

describe("conflictMessage", () => {
  it("names the colliding relative path", () => {
    expect(conflictMessage("sub/dir/a.txt")).toContain("sub/dir/a.txt");
  });
});
