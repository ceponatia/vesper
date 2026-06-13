import { describe, expect, it } from "vitest";
import { countSpawnMajors, MAJOR_TIER_SOFT_CAP, spawnTier } from "./cast-tiers";

describe("spawnTier", () => {
  it("bumps default-tier (minor) companions to major", () => {
    expect(spawnTier("companion", "minor")).toBe("major");
  });

  it("keeps an explicitly tiered-down (extra) companion as extra", () => {
    expect(spawnTier("companion", "extra")).toBe("extra");
  });

  it("never changes npc tiers", () => {
    expect(spawnTier("npc", "major")).toBe("major");
    expect(spawnTier("npc", "minor")).toBe("minor");
    expect(spawnTier("npc", "extra")).toBe("extra");
  });
});

describe("countSpawnMajors", () => {
  it("counts authored majors plus companion bumps, once each", () => {
    expect(
      countSpawnMajors([
        { role: "npc", tier: "major" },
        { role: "companion", tier: "minor" }, // bumps to major
        { role: "companion", tier: "major" }, // already major — not double-counted
        { role: "companion", tier: "extra" }, // explicit tier-down stays extra
        { role: "npc", tier: "minor" },
        { role: "npc", tier: "extra" },
      ]),
    ).toBe(3);
  });

  it("counts an empty cast as zero", () => {
    expect(countSpawnMajors([])).toBe(0);
  });

  it("the soft cap is the documented value (defaults doc, decision 46)", () => {
    expect(MAJOR_TIER_SOFT_CAP).toBe(6);
  });
});
