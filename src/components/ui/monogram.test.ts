import { describe, expect, it } from "vitest";
import { firstInitialOf, hueOf, initialsOf } from "./monogram";

describe("initialsOf", () => {
  it("uses first and last word initials", () => {
    expect(initialsOf("Maya Quayle")).toBe("MQ");
    expect(initialsOf("maya")).toBe("M");
    expect(initialsOf("Maya  del  Rio")).toBe("MR");
  });

  it("degrades on empty or whitespace names", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("firstInitialOf", () => {
  it("uses only the first letter", () => {
    expect(firstInitialOf("Maya Quayle")).toBe("M");
    expect(firstInitialOf("maya")).toBe("M");
  });

  it("degrades on empty or whitespace names", () => {
    expect(firstInitialOf("")).toBe("?");
    expect(firstInitialOf("   ")).toBe("?");
  });
});

describe("hueOf", () => {
  it("is deterministic and in range", () => {
    expect(hueOf("Maya")).toBe(hueOf("Maya"));
    for (const name of ["", "Maya", "Harborfall", "🦊"]) {
      const hue = hueOf(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
