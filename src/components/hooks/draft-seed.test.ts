import { describe, expect, it } from "vitest";
import { decideDraftSeed } from "./draft-seed";

describe("decideDraftSeed", () => {
  it("seeds when the entity's data first arrives", () => {
    expect(decideDraftSeed({ entityId: "a", seededId: null, loadedId: "a" })).toBe("seed");
  });

  it("keeps waiting before any data has loaded", () => {
    expect(decideDraftSeed({ entityId: "a", seededId: null, loadedId: null })).toBe("keep");
  });

  // Regression: a silent refetch (avatar polling, the reload after save) used
  // to re-seed the form whenever `dirty` had been cleared by a completing
  // save, clobbering edits made while the save was in flight.
  it("never re-seeds an already-seeded entity, so refetches cannot clobber edits", () => {
    expect(decideDraftSeed({ entityId: "a", seededId: "a", loadedId: "a" })).toBe("keep");
  });

  // Regression: navigating /items/a → /items/b kept showing a's form (the
  // fetch hook still holds a's data and the dirty flag blocked re-init).
  it("clears the stale draft when navigating to a different entity", () => {
    expect(decideDraftSeed({ entityId: "b", seededId: "a", loadedId: "a" })).toBe("clear");
  });

  it("after the clear, keeps waiting until the new entity's data arrives, then seeds", () => {
    expect(decideDraftSeed({ entityId: "b", seededId: null, loadedId: "a" })).toBe("keep");
    expect(decideDraftSeed({ entityId: "b", seededId: null, loadedId: "b" })).toBe("seed");
  });
});
