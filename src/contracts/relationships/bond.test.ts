import { describe, expect, it } from "vitest";
import { classifyBond } from "./bond";

describe("classifyBond", () => {
  it.each([
    "her brother lives at the lighthouse",
    "his sister runs the bar",
    "a doting parent to the player",
    "her partner of ten years",
    "the player's spouse",
    "an old friend from the harbor days",
    "a coworker on the night shift",
    "her colleague at the customs house",
    "his wife",
    "her husband",
    "they are childhood friends",
    "the player's mentor",
    "her roommate",
    "a nosy neighbor",
    "his sworn enemy",
    "her ex",
  ])("classifies mutual-knowledge kinds: %s", (text) => {
    expect(classifyBond(text)).toBe("mutual");
  });

  it.each([
    "they have never met",
    "this is their first meeting",
    "their first encounter happens tonight",
    "meets the player for the first time",
    "they are strangers",
    "a stranger to her",
    "she hasn't met the player",
    "they don't know each other",
  ])("classifies first-meeting phrasing: %s", (text) => {
    expect(classifyBond(text)).toBe("first-meeting");
  });

  it.each(["keeps the lighthouse and watches the tide", "", "a wary night clerk"])(
    "falls back to indeterminate: %s",
    (text) => {
      expect(classifyBond(text)).toBe("indeterminate");
    },
  );

  it("first-meeting phrasing beats mutual keywords", () => {
    expect(classifyBond("her brother, though they have never met")).toBe("first-meeting");
  });

  it("matches case-insensitively and through plurals", () => {
    expect(classifyBond("Her BROTHER")).toBe("mutual");
    expect(classifyBond("they are coworkers")).toBe("mutual");
  });

  it("matches whole terms only", () => {
    // "godmother" must not fire "mother"; "befriended" must not fire "friend"
    expect(classifyBond("the godmother befriended the town")).toBe("indeterminate");
  });
});
