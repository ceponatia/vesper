import { describe, expect, it } from "vitest";
import {
  characterCreateSchema,
  characterPatchSchema,
  emptyItemExtras,
  invalidCoverageIds,
  itemCreateSchema,
  itemPatchSchema,
  locationPatchSchema,
  personaCreateSchema,
  personaPatchSchema,
  withoutStaleHairOcclusion,
} from "./schemas";

describe("character body schemas", () => {
  it("create defaults profile and tags", () => {
    const parsed = characterCreateSchema.parse({
      creationRequestId: "467c753c-65e9-40f0-8545-0f0311b3f935",
      name: "  Maya ",
    });
    expect(parsed.name).toBe("Maya");
    expect(parsed.creationRequestId).toBe("467c753c-65e9-40f0-8545-0f0311b3f935");
    expect(parsed.profile.bio).toBe("");
    expect(parsed.profile.attributes).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(characterCreateSchema.safeParse({ creationRequestId: "same-draft", name: "Maya" }).success).toBe(false);
  });

  it("patch omission preserves the original creation brief", () => {
    const existing = characterCreateSchema.parse({ name: "Iris", profile: { creationBrief: "Human woman, green eyes, blue suit" } });
    const patch = characterPatchSchema.parse({ profile: { bio: "A harbor master" } });
    expect(patch.profile).not.toHaveProperty("creationBrief");
    expect({ ...existing.profile, ...patch.profile }.creationBrief).toBe("Human woman, green eyes, blue suit");
    expect(characterCreateSchema.parse({ name: "Iris" }).profile.creationBrief).toBe("");
  });

  it("keeps the optional save precondition strict and absent for existing callers", () => {
    expect(characterPatchSchema.parse({})).not.toHaveProperty("expectedUpdatedAt");
    expect(characterPatchSchema.parse({ expectedUpdatedAt: "2026-09-01T12:00:00.123Z" }).expectedUpdatedAt).toBe("2026-09-01T12:00:00.123Z");
    expect(characterPatchSchema.safeParse({ expectedUpdatedAt: "yesterday" }).success).toBe(false);
  });

  it("patch accepts a partial profile and rejects wrong types", () => {
    expect(characterPatchSchema.safeParse({ profile: { bio: "new bio" } }).success).toBe(true);
    expect(characterPatchSchema.safeParse({ profile: { bio: 5 } }).success).toBe(false);
    expect(characterPatchSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("persona body schemas", () => {
  it("create defaults profile and tags, and requires both title and name", () => {
    const parsed = personaCreateSchema.parse({ title: "  Brian, 22 ", name: " Brian " });
    expect(parsed.title).toBe("Brian, 22");
    expect(parsed.name).toBe("Brian");
    expect(parsed.profile.bio).toBe("");
    expect(parsed.profile.speciesId).toBe("human");
    expect(parsed.tags).toEqual([]);
    // Both are load-bearing: title is the unique key, name is what the fiction says.
    expect(personaCreateSchema.safeParse({ name: "Brian" }).success).toBe(false);
    expect(personaCreateSchema.safeParse({ title: "Brian, 22" }).success).toBe(false);
    expect(personaCreateSchema.safeParse({ title: "", name: "Brian" }).success).toBe(false);
  });

  it("create rejects character-only profile fields rather than silently dropping them", () => {
    // The narrow-pick line: a caller posting a personality is confused about what a
    // persona is, and should hear about it (personaProfileSchema is strict-by-parse
    // only for types — the key itself is stripped, so assert the value never lands).
    const parsed = personaCreateSchema.parse({
      title: "Brian, 22",
      name: "Brian",
      profile: { bio: "ok", personality: "warm and evasive" },
    });
    expect(parsed.profile).not.toHaveProperty("personality");
  });

  it("patch keeps a partial profile partial — no default resets on unsent fields", () => {
    // The exact bug partialWithoutDefaults exists to prevent: a PATCH merge
    // (`{...current, ...patch}`) must not reset outfits/attributes to their defaults.
    const parsed = personaPatchSchema.parse({ profile: { bio: "new bio" } });
    expect(parsed.profile).toEqual({ bio: "new bio" });
    expect(parsed.profile).not.toHaveProperty("outfits");
    expect(parsed.profile).not.toHaveProperty("attributes");
    expect(parsed.profile).not.toHaveProperty("speciesId");
  });

  it("patch rejects wrong types and a blank title", () => {
    expect(personaPatchSchema.safeParse({ profile: { bio: 5 } }).success).toBe(false);
    expect(personaPatchSchema.safeParse({ title: "" }).success).toBe(false);
    expect(personaPatchSchema.safeParse({ name: "" }).success).toBe(false);
    expect(personaPatchSchema.safeParse({}).success).toBe(true);
  });
});

describe("item body schemas", () => {
  it("create fills definition extras defaults", () => {
    const parsed = itemCreateSchema.parse({ name: "Lantern", kind: "object" });
    expect(parsed.definition).toEqual(emptyItemExtras());
    expect(parsed.definition.opacity).toBe("opaque");
    expect(parsed.definition.layer).toBeUndefined();
  });

  it("create defaults new clothing to layer 1 · base", () => {
    const parsed = itemCreateSchema.parse({ name: "Coat", kind: "clothing" });
    expect(parsed.definition.layer).toBe(1);
    // An explicit layer wins over the default.
    const bra = itemCreateSchema.parse({ name: "Bra", kind: "clothing", definition: { layer: 0 } });
    expect(bra.definition.layer).toBe(0);
  });

  it("patch definition is partial", () => {
    const parsed = itemPatchSchema.parse({ definition: { layer: 3 } });
    expect(parsed.definition).toEqual({ layer: 3 });
    expect(itemPatchSchema.safeParse({ definition: { layer: 7 } }).success).toBe(false);
  });

  it("patch accepts layer null as an explicit clear, not a 400", () => {
    // The client definition shape represents "unset" as null (autosave sends
    // the full definition); the key survives so the merge unsets the layer.
    const parsed = itemPatchSchema.parse({ definition: { layer: null } });
    expect(parsed.definition !== undefined && "layer" in parsed.definition).toBe(true);
    expect(parsed.definition?.layer).toBeUndefined();
  });

  it("invalidCoverageIds flags unknown body locations only", () => {
    expect(invalidCoverageIds(["head", "neck"])).toEqual([]);
    expect(invalidCoverageIds(["head", "left_flipper"])).toEqual(["left_flipper"]);
  });

  // The headwear hair-occlusion override rides the extras slice: a pick list
  // that omits it strips every save silently, a `null` patch must clear the
  // stored key (the editor's "Use type default"), and a value on a
  // non-headwear category is stale and dropped at the boundary
  // (docs/contracts/items/README.md §Hair occlusion).
  it("stores, clears and drops the hair-occlusion override", () => {
    expect(itemCreateSchema.parse({ name: "Hijab", kind: "clothing", definition: { hairOcclusion: "full" } }).definition.hairOcclusion).toBe("full");
    const cleared = itemPatchSchema.parse({ definition: { hairOcclusion: null } });
    expect(cleared.definition !== undefined && "hairOcclusion" in cleared.definition).toBe(true);
    expect(cleared.definition?.hairOcclusion).toBeUndefined();

    const headwear = { category: "headwear", hairOcclusion: "partial" as const };
    expect(withoutStaleHairOcclusion(headwear)).toEqual(headwear);
    expect(withoutStaleHairOcclusion({ category: "jewelry", hairOcclusion: "partial" as const })).toEqual({ category: "jewelry" });
    expect(withoutStaleHairOcclusion({ hairOcclusion: "full" as const })).toEqual({});
  });
});

describe("location body schemas", () => {
  it("patch tolerates empty object (no-op)", () => {
    expect(locationPatchSchema.parse({})).toEqual({});
  });
});
