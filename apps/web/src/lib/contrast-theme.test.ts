import { describe, expect, it } from "vitest";
import { parseContrastMode } from "./contrast-theme";

describe("parseContrastMode", () => {
  it("returns 'high' only for the exact stored 'high' value", () => {
    expect(parseContrastMode("high")).toBe("high");
  });

  it("falls back to 'default' for anything else (absent, empty, legacy, casing)", () => {
    for (const value of [null, undefined, "", "default", "High", "HIGH", "1", "low", "contrast"]) {
      expect(parseContrastMode(value)).toBe("default");
    }
  });
});
