import { describe, expect, it } from "vitest";
import { humanoidBodyLocations } from "../body/locations";
import { coverageAncestors, expandCoverage, toggleCoverage } from "./coverage";

// toggleCoverage returns a *set* of body-location ids; the tree-walk order is an
// implementation detail, so compare order-agnostically (sort both sides).
const sameSet = (a: readonly string[], b: readonly string[]) =>
  expect([...a].sort()).toEqual([...b].sort());

/**
 * Expected sets are DERIVED from the raw body-location rows below — an
 * independent walk of the `parentId` pointers that never touches `coverage.ts`
 * or the registry's own `expand`. Broken expansion logic therefore still fails
 * every assertion here, while ADDING a body location is a pure vocabulary
 * change that needs no edit to this file.
 */
const childrenOf = (id: string) => humanoidBodyLocations.filter((loc) => loc.parentId === id);

/** `rootId` plus every descendant, walked straight off the parent pointers. */
function subtreeIds(rootId: string): string[] {
  return [rootId, ...childrenOf(rootId).flatMap((child) => subtreeIds(child.id))];
}

/** The parent chain of `id`, nearest first — the oracle `coverageAncestors` is checked against. */
function ancestorIds(id: string): string[] {
  const chain: string[] = [];
  let current = humanoidBodyLocations.find((loc) => loc.id === id)?.parentId;
  while (current !== undefined) {
    chain.push(current);
    current = humanoidBodyLocations.find((loc) => loc.id === current)?.parentId;
  }
  return chain;
}

/** Coverage is a wardrobe-slot concept: only these ids may ever be STORED. */
const isSlot = (id: string) => (humanoidBodyLocations.find((loc) => loc.id === id)?.coverageRelevant ?? true) === true;
const slots = (ids: readonly string[]) => ids.filter(isSlot);
const coverageSlots = humanoidBodyLocations.filter((loc) => isSlot(loc.id));

/**
 * What a carve-out must leave: the root's slot subtree, minus each carved id's
 * own subtree, minus the ancestor ids that would re-imply it through `expand`.
 */
function expectedCarveOut(root: string, ...carved: readonly string[]): string[] {
  const removed = new Set(carved.flatMap((id) => [...subtreeIds(id), ...ancestorIds(id)]));
  return slots(subtreeIds(root)).filter((id) => !removed.has(id));
}

describe("toggleCoverage (select-all cascade with carve-outs)", () => {
  it("checking ANY location explodes to itself plus all its slot descendants", () => {
    for (const location of coverageSlots) {
      sameSet(toggleCoverage([], location.id), slots(subtreeIds(location.id)));
    }
  });

  it("pinned smoke anchor: pelvis groups hips, groin and buttocks — and no intimate anatomy", () => {
    // One hand-written truth on purpose: without it, a bug in THIS file's
    // derivation helpers could make every derived assertion above agree with a
    // broken tree walk. Update deliberately if the pelvis vocabulary grows.
    sameSet(toggleCoverage([], "pelvis"), ["pelvis", "hips", "groin", "buttocks"]);
  });

  it("never stores a non-slot location (the intimate + feature sub-trees)", () => {
    for (const location of humanoidBodyLocations.filter((loc) => !isSlot(loc.id))) {
      expect(toggleCoverage([], location.id), location.id).toEqual([]);
    }
  });

  it("cascades to grandchildren, not just direct children", () => {
    const arms = toggleCoverage([], "arms");
    expect(arms).toContain("fingers"); // arms → hands → fingers, two levels down
    sameSet(arms, slots(subtreeIds("arms")));
  });

  it("unchecking a child keeps the exploded siblings and drops the parent id", () => {
    const torso = toggleCoverage([], "torso");
    sameSet(toggleCoverage(torso, "chest"), expectedCarveOut("torso", "chest"));
  });

  it("ski mask: minimal head coverage minus eyes keeps hair, ears, nose and lips", () => {
    // a minimal ["head"] (forge output / legacy data) explodes on first toggle
    const result = toggleCoverage(["head"], "eyes");
    sameSet(result, expectedCarveOut("head", "eyes"));
    // face itself drops with eyes (an ancestor id would re-imply them), but its
    // remaining parts — nose, lips — stay covered, as a real ski mask covers them.
    expect(result).toEqual(expect.arrayContaining(["nose", "lips"]));
    expect(result).not.toContain("eyes");
    expect(result).not.toContain("face");
  });

  it("strapped sandal: feet minus toes and top-of-foot keeps sole and heel", () => {
    // Footwear covers the whole foot; carving toes out first gives a peep-toe...
    const peepToe = toggleCoverage(["feet"], "toes");
    sameSet(peepToe, expectedCarveOut("feet", "toes"));
    // ...then dropping the instep leaves the sole+heel a sandal strap holds.
    const sandal = toggleCoverage(peepToe, "top_of_foot");
    sameSet(sandal, expectedCarveOut("feet", "toes", "top_of_foot"));
    expect(sandal).toEqual(expect.arrayContaining(["sole", "heel"]));
  });

  it("re-checking a carved-out child restores just that subtree", () => {
    const skiMask = toggleCoverage(["head"], "eyes");
    sameSet(toggleCoverage(skiMask, "eyes"), [...expectedCarveOut("head", "eyes"), ...slots(subtreeIds("eyes"))]);
  });

  it("checking a child never drags its ancestors in (glasses cover eyes, not face)", () => {
    const glasses = toggleCoverage([], "eyes");
    expect(glasses).toEqual(["eyes"]);
    for (const ancestor of ancestorIds("eyes")) {
      expect(expandCoverage(glasses).has(ancestor), ancestor).toBe(false);
    }
  });

  it("toggling a leaf on and off round-trips", () => {
    const on = toggleCoverage([], "wrists");
    expect(on).toEqual(["wrists"]);
    expect(toggleCoverage(on, "wrists")).toEqual([]);
  });

  it("preserves ids the registry does not know", () => {
    const result = toggleCoverage(["custom_tail_slot"], "neck");
    sameSet(result, [...slots(subtreeIds("neck")), "custom_tail_slot"]);
  });

  it("exploded and minimal inputs evaluate to the same effective set, for every slot", () => {
    for (const location of coverageSlots) {
      expect(expandCoverage([location.id]), location.id).toEqual(
        expandCoverage(toggleCoverage([], location.id)),
      );
    }
  });
});

describe("coverageAncestors", () => {
  it("walks the parent chain nearest-first, for every registered location", () => {
    for (const location of humanoidBodyLocations) {
      expect(coverageAncestors(location.id), location.id).toEqual(ancestorIds(location.id));
    }
  });

  it("pinned smoke anchor: eyes → face → head, fingers → hands → arms", () => {
    // Hand-written truth guarding this file's own `ancestorIds` oracle; these are
    // also the exact chains the ski-mask and glasses carve-outs above turn on.
    expect(coverageAncestors("eyes")).toEqual(["face", "head"]);
    expect(coverageAncestors("fingers")).toEqual(["hands", "arms"]);
  });

  it("is empty for roots and unknown ids", () => {
    expect(coverageAncestors("torso")).toEqual([]);
    expect(coverageAncestors("custom_tail_slot")).toEqual([]);
  });
});
