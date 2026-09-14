import { describe, expect, it } from "vitest";
import type { AdminFileEntry } from "@/lib/client/api";
import {
  ADMIN_FILES_DRAG_TYPE,
  breadcrumbSegments,
  dragSourcePaths,
  hasFolder,
  isAllSelected,
  isBlockedDestination,
  isBlockedDragDestination,
  isPathWithin,
  isSelectionPartial,
  joinPath,
  parentPathFor,
  parseDragPayload,
  toggleAllSelection,
  toggleSelected,
  visibleSelection,
} from "./files-page-selection";

function entry(params: { path: string; kind: "file" | "folder" }): AdminFileEntry {
  return {
    path: params.path,
    kind: params.kind,
    name: params.path.split("/").pop() ?? params.path,
    size: params.kind === "folder" ? null : 0,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("ADMIN_FILES_DRAG_TYPE", () => {
  it("is a custom, non-empty MIME-shaped type distinct from any browser-native one", () => {
    expect(ADMIN_FILES_DRAG_TYPE.length).toBeGreaterThan(0);
    expect(ADMIN_FILES_DRAG_TYPE).not.toBe("Files");
    expect(ADMIN_FILES_DRAG_TYPE).not.toBe("text/plain");
  });
});

describe("isPathWithin", () => {
  it("is true for the ancestor itself and for a nested descendant", () => {
    expect(isPathWithin("a", "a")).toBe(true);
    expect(isPathWithin("a/b", "a")).toBe(true);
    expect(isPathWithin("a/b/c", "a")).toBe(true);
  });

  it("is false for a sibling that merely shares a name prefix", () => {
    expect(isPathWithin("ab", "a")).toBe(false);
    expect(isPathWithin("a-b", "a")).toBe(false);
  });

  it("is false for an unrelated path", () => {
    expect(isPathWithin("b", "a")).toBe(false);
  });
});

describe("parentPathFor", () => {
  it("returns the Files root for a root-level entry", () => {
    expect(parentPathFor("photo.png")).toBe("");
  });

  it("drops exactly the last segment", () => {
    expect(parentPathFor("a/b/c")).toBe("a/b");
  });

  // The Files root's own parent is the case the page computes on every render
  // there — `parentPath` feeds "Up one folder" and "Move to parent" — and the
  // one the two-segment examples above never reach. It stays the root rather
  // than climbing out of it or growing a stray separator.
  it("keeps the Files root as its own parent", () => {
    expect(parentPathFor("")).toBe("");
  });
});

describe("joinPath", () => {
  it("joins a bare segment onto an empty base", () => {
    expect(joinPath("", "sub")).toBe("sub");
  });

  it("slash-joins onto a non-empty base", () => {
    expect(joinPath("a", "b")).toBe("a/b");
  });

  // The upload path joins the current folder onto `parentPathFor(relativePath)`,
  // which is `""` for every top-level entry of a dropped selection. Returning
  // `"sub/"` there put a trailing separator on the wire and the server refused
  // it, so uploading into any folder below the root failed outright.
  it("returns the base unchanged when the segment is empty", () => {
    expect(joinPath("sub", "")).toBe("sub");
    expect(joinPath("a/b", "")).toBe("a/b");
    expect(joinPath("", "")).toBe("");
  });
});

describe("breadcrumbSegments", () => {
  it("is empty at the Files root", () => {
    expect(breadcrumbSegments("")).toEqual([]);
  });

  it("names each ancestor with its own cumulative path", () => {
    expect(breadcrumbSegments("a/b/c")).toEqual([
      { name: "a", path: "a" },
      { name: "b", path: "a/b" },
      { name: "c", path: "a/b/c" },
    ]);
  });
});

describe("toggleSelected", () => {
  it("adds an absent path and never mutates the input set", () => {
    const before = new Set<string>();
    const after = toggleSelected(before, "a");
    expect(before.has("a")).toBe(false);
    expect(after.has("a")).toBe(true);
  });

  it("removes a present path", () => {
    expect(toggleSelected(new Set(["a", "b"]), "a").has("a")).toBe(false);
  });
});

describe("visibleSelection / isAllSelected / isSelectionPartial", () => {
  const fileA = entry({ path: "a", kind: "file" });
  const fileB = entry({ path: "b", kind: "file" });
  const folderC = entry({ path: "c", kind: "folder" });
  const entries = [fileA, fileB, folderC];

  it("reads the selection back through the entries on screen, dropping a stale path", () => {
    const selected = new Set(["a", "gone"]);
    expect(visibleSelection(entries, selected)).toEqual([fileA]);
  });

  it("is not all-selected and not partial with nothing ticked", () => {
    expect(isAllSelected(entries, new Set())).toBe(false);
    expect(isSelectionPartial(entries, new Set())).toBe(false);
  });

  it("is partial with some but not all ticked", () => {
    expect(isSelectionPartial(entries, new Set(["a"]))).toBe(true);
    expect(isAllSelected(entries, new Set(["a"]))).toBe(false);
  });

  it("is all-selected once every visible row is ticked, and no longer partial", () => {
    const selected = new Set(entries.map((e) => e.path));
    expect(isAllSelected(entries, selected)).toBe(true);
    expect(isSelectionPartial(entries, selected)).toBe(false);
  });

  it("is never all-selected against an empty entry list", () => {
    expect(isAllSelected([], new Set())).toBe(false);
  });
});

describe("toggleAllSelection", () => {
  const entries = [entry({ path: "a", kind: "file" }), entry({ path: "b", kind: "folder" })];

  it("selects every entry from none selected", () => {
    expect([...toggleAllSelection(entries, new Set())].sort()).toEqual(["a", "b"]);
  });

  it("clears the selection once everything is already selected", () => {
    expect(toggleAllSelection(entries, new Set(["a", "b"])).size).toBe(0);
  });

  it("selects everything from a partial selection, rather than clearing it", () => {
    expect([...toggleAllSelection(entries, new Set(["a"]))].sort()).toEqual(["a", "b"]);
  });
});

describe("hasFolder", () => {
  it("is false for an all-file list", () => {
    expect(hasFolder([entry({ path: "a", kind: "file" }), entry({ path: "b", kind: "file" })])).toBe(false);
  });

  it("is true once any entry is a folder", () => {
    expect(hasFolder([entry({ path: "a", kind: "file" }), entry({ path: "b", kind: "folder" })])).toBe(true);
  });
});

describe("dragSourcePaths", () => {
  it("acts on the whole selection when the dragged row is part of it", () => {
    expect(dragSourcePaths(new Set(["a", "b"]), "a").sort()).toEqual(["a", "b"]);
  });

  it("acts on only the dragged row when it is not selected, even with an unrelated selection active", () => {
    expect(dragSourcePaths(new Set(["a", "b"]), "c")).toEqual(["c"]);
  });

  it("acts on just the row when nothing at all is selected", () => {
    expect(dragSourcePaths(new Set(), "a")).toEqual(["a"]);
  });
});

describe("isBlockedDragDestination", () => {
  it("blocks a drag that carries nothing", () => {
    expect(isBlockedDragDestination("box", [])).toBe(true);
  });

  it("defers to isBlockedDestination when the drag carries paths", () => {
    expect(isBlockedDragDestination("a/b", ["a"])).toBe(true);
    expect(isBlockedDragDestination("box", ["loose.txt"])).toBe(false);
  });
});

describe("isBlockedDestination", () => {
  it("blocks the exact source path", () => {
    expect(isBlockedDestination("a", ["a"])).toBe(true);
  });

  it("blocks a descendant of a source folder", () => {
    expect(isBlockedDestination("a/b", ["a"])).toBe(true);
  });

  // Dropping a selection back where it already lives asks for nothing, and the
  // server can only answer `already_in_destination` — an error toast for a
  // no-op gesture.
  it("blocks a destination every source already sits in", () => {
    expect(isBlockedDestination("", ["a.txt", "b.txt"])).toBe(true);
    expect(isBlockedDestination("box", ["box/a.txt"])).toBe(true);
  });

  it("allows a destination only some sources already sit in", () => {
    expect(isBlockedDestination("box", ["box/a.txt", "loose.txt"])).toBe(false);
  });

  it("allows an unrelated folder, including a same-prefix sibling", () => {
    expect(isBlockedDestination("b", ["a"])).toBe(false);
    expect(isBlockedDestination("a-2", ["a"])).toBe(false);
  });

  it("never blocks the Files root, since a non-empty source path cannot equal or contain it", () => {
    expect(isBlockedDestination("", ["a", "a/b"])).toBe(false);
  });

  // `every` is vacuously true over an empty list, and here that reads the right
  // way round: with nothing dragged there is no move to offer, so every
  // destination is blocked rather than every destination being offered. The
  // page guards the empty case before it asks, so this is the answer no caller
  // should ever need — and exactly the one a refactor could invert unnoticed.
  it("blocks every destination when there is nothing to move", () => {
    expect(isBlockedDestination("box", [])).toBe(true);
    expect(isBlockedDestination("", [])).toBe(true);
  });
});

describe("parseDragPayload", () => {
  it("round-trips the page's own array-of-paths payload", () => {
    expect(parseDragPayload(JSON.stringify(["a", "a/b"]))).toEqual(["a", "a/b"]);
  });

  it("degrades to an empty array for malformed JSON, instead of throwing", () => {
    expect(parseDragPayload("not json")).toEqual([]);
  });

  it("degrades to an empty array for well-formed JSON of the wrong shape", () => {
    expect(parseDragPayload(JSON.stringify({ not: "an array" }))).toEqual([]);
    expect(parseDragPayload(JSON.stringify([1, 2, 3]))).toEqual([]);
    expect(parseDragPayload(JSON.stringify(["a", 2]))).toEqual([]);
  });

  it("degrades to an empty array for the empty string a missing type reads as", () => {
    expect(parseDragPayload("")).toEqual([]);
  });
});
