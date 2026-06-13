import { describe, expect, it } from "vitest";
import {
  characterCreateSchema,
  characterPatchSchema,
  emptyItemExtras,
  invalidCoverageIds,
  itemCreateSchema,
  itemPatchSchema,
  locationPatchSchema,
} from "./schemas";
import { worldCreateSchema, worldItemInputSchema, worldLocationInputSchema } from "./worlds";

describe("character body schemas", () => {
  it("create defaults profile and tags", () => {
    const parsed = characterCreateSchema.parse({ name: "  Maya " });
    expect(parsed.name).toBe("Maya");
    expect(parsed.profile.bio).toBe("");
    expect(parsed.profile.attributes).toEqual([]);
    expect(parsed.tags).toEqual([]);
  });

  it("patch accepts a partial profile and rejects wrong types", () => {
    expect(characterPatchSchema.safeParse({ profile: { bio: "new bio" } }).success).toBe(true);
    expect(characterPatchSchema.safeParse({ profile: { bio: 5 } }).success).toBe(false);
    expect(characterPatchSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("item body schemas", () => {
  it("create fills definition extras defaults", () => {
    const parsed = itemCreateSchema.parse({ name: "Coat", kind: "clothing" });
    expect(parsed.definition).toEqual(emptyItemExtras());
    expect(parsed.definition.opacity).toBe("opaque");
  });

  it("patch definition is partial", () => {
    const parsed = itemPatchSchema.parse({ definition: { layer: 3 } });
    expect(parsed.definition).toEqual({ layer: 3 });
    expect(itemPatchSchema.safeParse({ definition: { layer: 7 } }).success).toBe(false);
  });

  it("invalidCoverageIds flags unknown body locations only", () => {
    expect(invalidCoverageIds(["head", "neck"])).toEqual([]);
    expect(invalidCoverageIds(["head", "left_flipper"])).toEqual(["left_flipper"]);
  });
});

describe("location body schemas", () => {
  it("patch tolerates empty object (no-op)", () => {
    expect(locationPatchSchema.parse({})).toEqual({});
  });
});

describe("world input schemas", () => {
  it("location input requires a name or a locationId", () => {
    expect(worldLocationInputSchema.safeParse({ name: "Harbor" }).success).toBe(true);
    expect(worldLocationInputSchema.safeParse({ locationId: "loc1" }).success).toBe(true);
    expect(worldLocationInputSchema.safeParse({}).success).toBe(false);
  });

  it("item input requires an itemId or a definition", () => {
    expect(worldItemInputSchema.safeParse({ itemId: "i1" }).success).toBe(true);
    expect(
      worldItemInputSchema.safeParse({ definition: { kind: "object", name: "Lantern" } }).success,
    ).toBe(true);
    expect(worldItemInputSchema.safeParse({ worn: true }).success).toBe(false);
  });

  it("create body defaults nested families and catches bad enums in lore chunks", () => {
    const parsed = worldCreateSchema.parse({
      name: "Tidewater",
      loreChunks: [{ title: "The Flood", tier: "nonsense", visibility: "secret" }],
    });
    expect(parsed.locations).toEqual([]);
    expect(parsed.loreChunks[0]?.tier).toBe("scene");
    expect(parsed.loreChunks[0]?.visibility).toBe("secret");
    expect(parsed.style.directives).toEqual([]);
  });
});
