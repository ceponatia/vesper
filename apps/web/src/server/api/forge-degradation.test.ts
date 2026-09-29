import { describe, expect, it } from "vitest";
import { diag } from "@/contracts";
import { isDegradedForgeResult } from "./forge-degradation";

// Defect killed: a first Forge whose legs fell back to hand-written demo
// content being applied to a blank character without review (#657).
describe("isDegradedForgeResult", () => {
  it("accepts a clean forge, including a repaired leg and ordinary grounding drops", () => {
    expect(isDegradedForgeResult([])).toBe(false);
    expect(isDegradedForgeResult([
      diag("info", "forge.character.profile.repaired", "structured output needed one repair round-trip"),
      diag("warn", "forge.character.outfit.unknown_reuse", "drafted as a new garment"),
      diag("warn", "forge.character.attributes.invalid_value", "dropped attribute"),
      diag("info", "forge.character.attributes.unconstrained_default", "seeded pick"),
    ])).toBe(false);
  });

  // The literal codes server/ai records for each way a leg can lose its model output.
  it.each([
    ["info", "forge.character.profile.degraded"],
    ["warn", "forge.character.outfit.timeout"],
    ["warn", "forge.character.attributes.parse_failed"],
    ["warn", "forge.character.profile.api_error"],
  ] as const)("flags a %s %s line", (severity, code) => {
    expect(isDegradedForgeResult([diag(severity, code, "fallback")])).toBe(true);
  });

  it("flags any error, whatever its code", () => {
    expect(isDegradedForgeResult([diag("error", "forge.character.unexpected", "failed")])).toBe(true);
  });
});
