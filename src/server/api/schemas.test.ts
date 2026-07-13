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
