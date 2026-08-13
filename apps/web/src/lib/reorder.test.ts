import { describe, expect, it } from "vitest";
import { moveItem } from "./reorder";

describe("moveItem", () => {
  const list = ["a", "b", "c", "d"];

  it("moves an element down the list", () => {
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an element up the list", () => {
    expect(moveItem(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves to the ends", () => {
    expect(moveItem(list, 1, 0)).toEqual(["b", "a", "c", "d"]);
    expect(moveItem(list, 1, 3)).toEqual(["a", "c", "d", "b"]);
  });

  it("returns the original array for a no-op move", () => {
    expect(moveItem(list, 2, 2)).toBe(list);
  });

  it("clamps out-of-range indices instead of throwing", () => {
    expect(moveItem(list, -5, 1)).toEqual(["b", "a", "c", "d"]);
    expect(moveItem(list, 1, 99)).toEqual(["a", "c", "d", "b"]);
  });

  it("does not mutate the input", () => {
    moveItem(list, 0, 3);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("handles the empty list", () => {
    expect(moveItem([], 0, 1)).toEqual([]);
  });
});
