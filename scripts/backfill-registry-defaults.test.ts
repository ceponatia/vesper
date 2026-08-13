import { describe, expect, it } from "vitest";
import { registryDefaultSourceId } from "@/contracts";
import { planProfileBackfill } from "./backfill-registry-defaults";

const FOOT_FACTS = ["feet.arch", "feet.nails", "feet.size", "feet.toes"];

function addedIds(raw: unknown): string[] {
  return planProfileBackfill(raw)
    .added.map((value) => value.id)
    .sort();
}

describe("planProfileBackfill", () => {
  it("fills every missing foot fact on an empty profile, with backfill provenance", () => {
    const { next, added } = planProfileBackfill({ attributes: [] });
    expect(added.map((value) => value.id).sort()).toEqual(FOOT_FACTS);
    for (const value of added) {
      expect(value.source).toBe("creation");
      expect(value.sourceId).toBe(registryDefaultSourceId("feet"));
    }
    expect((next as { attributes: unknown[] }).attributes).toHaveLength(4);
  });

  it("seeds a NULL persona profile as an attributes-only blob", () => {
    const { next, added } = planProfileBackfill(null);
    expect(added).toHaveLength(4);
    expect(Object.keys(next as object)).toEqual(["attributes"]);
  });

  it("preserves authored values — a custom arch survives and only the gaps fill", () => {
    const authored = { id: "feet.arch", value: "high", source: "manual", note: "authored" };
    const { next, added } = planProfileBackfill({ attributes: [authored], bio: "kept" });
    expect(added.map((value) => value.id).sort()).toEqual(["feet.nails", "feet.size", "feet.toes"]);
    const result = next as { attributes: unknown[]; bio: string };
    expect(result.attributes[0]).toBe(authored);
    expect(result.bio).toBe("kept");
  });

  it("lets a malformed entry both survive verbatim and block its default", () => {
    const malformed = { id: "feet.nails", value: { nested: "garbage" }, extra: true };
    const { next, added } = planProfileBackfill({ attributes: [malformed] });
    expect(added.map((value) => value.id)).not.toContain("feet.nails");
    expect((next as { attributes: unknown[] }).attributes[0]).toBe(malformed);
  });

  it("is idempotent — a filled profile plans zero additions and is returned untouched", () => {
    const first = planProfileBackfill({ attributes: [] });
    const second = planProfileBackfill(first.next);
    expect(second.added).toEqual([]);
    expect(second.next).toBe(first.next);
  });

  it("leaves a profile with a non-array attributes key completely alone", () => {
    const corrupt = { attributes: "not-a-list" };
    const { next, added } = planProfileBackfill(corrupt);
    expect(added).toEqual([]);
    expect(next).toBe(corrupt);
  });

  it("threads the row's own body-config into applicability", () => {
    // Foot facts are universal on the humanoid plan, so a normal body fills all
    // four whatever its species fields say — including unknown ones, which
    // degrade to the default body rather than skipping the row.
    expect(addedIds({ attributes: [], speciesId: "elf", intimateRegions: ["vulva"] })).toEqual(FOOT_FACTS);
    expect(addedIds({ attributes: [], speciesId: "unknown_species" })).toEqual(FOOT_FACTS);
  });
});
