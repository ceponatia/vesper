import { describe, expect, it } from "vitest";
import { isMachineTag, visibleTags } from "./tags";

describe("machine bookkeeping tags", () => {
  it("recognizes suggested and seed:* regardless of case/whitespace", () => {
    expect(isMachineTag("suggested")).toBe(true);
    expect(isMachineTag(" Suggested ")).toBe(true);
    expect(isMachineTag("seed:tsukikage")).toBe(true);
    expect(isMachineTag("SEED:anything")).toBe(true);
    expect(isMachineTag("harbor")).toBe(false);
    expect(isMachineTag("seedling")).toBe(false); // prefix must be "seed:", not "seed"
  });

  it("visibleTags strips machine tags and keeps order", () => {
    expect(visibleTags(["harbor", "suggested", "stoic", "seed:x"])).toEqual(["harbor", "stoic"]);
    expect(visibleTags([])).toEqual([]);
  });
});
