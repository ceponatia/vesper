import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts";
import { worldDraftLocationSchema, worldDraftSchema, type WorldDraftLocation } from "./drafts";
import type { LibraryLookup } from "./library";
import {
  castSectionSchema,
  demoWorldItemsSection,
  forgeWorld,
  forgeWorldSection,
  fuzzyResolveName,
  groundCastRelationships,
  groundItemPlacements,
  matchCastSuggestions,
  validateLocationGraph,
} from "./world-forge";

const noLibrary: LibraryLookup = async () => [];

function loc(name: string, links: string[] = []): WorldDraftLocation {
  return worldDraftLocationSchema.parse({ name, links });
}

describe("validateLocationGraph", () => {
  it("leaves a valid connected graph untouched", () => {
    const sink = new DiagnosticCollector();
    const locations = [loc("Quay", ["Tavern"]), loc("Tavern", ["Quay"])];
    const result = validateLocationGraph(locations, sink);
    expect(result).toEqual(locations);
    expect(sink.items).toEqual([]);
  });

  it("drops duplicate names (case-insensitive) with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = validateLocationGraph([loc("Quay"), loc("quay"), loc("Tavern", ["Quay"])], sink);
    expect(result.map((l) => l.name)).toEqual(["Quay", "Tavern"]);
    expect(sink.items.some((d) => d.code === "forge.world.locations.duplicate_name")).toBe(true);
  });

  it("drops orphan links with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = validateLocationGraph([loc("Quay", ["Atlantis", "Tavern"]), loc("Tavern", ["Quay"])], sink);
    expect(result[0]?.links).toEqual(["Tavern"]);
    expect(sink.items.some((d) => d.code === "forge.world.locations.orphan_link")).toBe(true);
  });

  it("drops self-links with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = validateLocationGraph([loc("Quay", ["Quay", "Tavern"]), loc("Tavern", ["Quay"])], sink);
    expect(result[0]?.links).toEqual(["Tavern"]);
    expect(sink.items.some((d) => d.code === "forge.world.locations.self_link")).toBe(true);
  });

  it("repairs a disconnected graph and records the diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = validateLocationGraph(
      [loc("Quay", ["Tavern"]), loc("Tavern", ["Quay"]), loc("Lighthouse"), loc("Cave", ["Grotto"]), loc("Grotto", ["Cave"])],
      sink,
    );
    expect(sink.items.filter((d) => d.code === "forge.world.locations.disconnected")).toHaveLength(2);
    // Re-validating the repaired graph finds nothing further to fix.
    const recheck = new DiagnosticCollector();
    const again = validateLocationGraph(result, recheck);
    expect(again).toEqual(result);
    expect(recheck.items).toEqual([]);
  });

  it("resolves link casing to the canonical location name", () => {
    const result = validateLocationGraph([loc("Quay", ["the tavern"]), loc("The Tavern", ["QUAY"])]);
    expect(result[0]?.links).toEqual(["The Tavern"]);
    expect(result[1]?.links).toEqual(["Quay"]);
  });

  it("rescues near-miss links and suggests the closest name when it cannot", () => {
    const sink = new DiagnosticCollector();
    // punctuation/containment slips resolve; a genuine miss gets a hint
    const result = validateLocationGraph(
      [loc("Netmaker's Row", ["Old Lighthouse Point", "South Farmlands"]), loc("The Old Lighthouse Point", ["Netmakers Row"])],
      sink,
    );
    expect(result[0]?.links).toEqual(["The Old Lighthouse Point"]);
    expect(result[1]?.links).toEqual(["Netmaker's Row"]);
    const orphan = sink.items.find((d) => d.code === "forge.world.locations.orphan_link");
    expect(orphan?.message).toContain('"South Farmlands"');
    expect(sink.items.some((d) => d.code === "forge.world.locations.link_fuzzy_resolved")).toBe(true);
  });
});

describe("fuzzyResolveName", () => {
  const names = ["Dr. Elias Thorne", "Maren Voss", "Harbor Quay"];

  it("matches exactly, case-insensitively", () => {
    expect(fuzzyResolveName("maren voss", names).match).toBe("Maren Voss");
  });

  it("matches through punctuation and containment", () => {
    expect(fuzzyResolveName("Dr Elias Thorne", names).match).toBe("Dr. Elias Thorne");
    expect(fuzzyResolveName("Elias Thorne", names).match).toBe("Dr. Elias Thorne");
    expect(fuzzyResolveName("the harbor quay", names).match).toBe("Harbor Quay");
  });

  it("refuses ambiguous containment", () => {
    const ambiguous = fuzzyResolveName("Quay", ["Harbor Quay", "Old Quay"]);
    expect(ambiguous.match).toBeUndefined();
  });

  it("offers the closest name for a genuine miss", () => {
    const miss = fuzzyResolveName("West Farmlands", ["North Farmlands", "Harbor Quay"]);
    expect(miss.match).toBeUndefined();
    expect(miss.closest).toBe("North Farmlands");
  });

  it("returns nothing for empty or unrelated input", () => {
    expect(fuzzyResolveName("", names)).toEqual({});
    expect(fuzzyResolveName("Zzz", names)).toEqual({});
  });
});

describe("matchCastSuggestions", () => {
  const suggestions = [
    { name: "Maren Voss", conceptNote: "harbor-master", role: "companion" as const, tier: "major" as const, relationships: [] },
    { name: "Tobben Crale", conceptNote: "clerk", role: "npc" as const, tier: "minor" as const, relationships: [] },
  ];

  it("attaches existingCharacterId on a case-insensitive library match", async () => {
    const lookup: LibraryLookup = async () => [{ id: "char_1", name: "maren voss" }];
    const matched = await matchCastSuggestions(suggestions, "user_1", lookup);
    expect(matched[0]?.existingCharacterId).toBe("char_1");
    expect(matched[1]?.existingCharacterId).toBeUndefined();
  });

  it("degrades to all-stubs with a diagnostic when the lookup fails", async () => {
    const sink = new DiagnosticCollector();
    const lookup: LibraryLookup = async () => {
      throw new Error("connection refused");
    };
    const matched = await matchCastSuggestions(suggestions, "user_1", lookup, sink);
    expect(matched.every((s) => s.existingCharacterId === undefined)).toBe(true);
    expect(sink.items.some((d) => d.code === "forge.world.cast.library_lookup_failed")).toBe(true);
  });

  it("dedupes suggestions by name", async () => {
    const matched = await matchCastSuggestions(
      [...suggestions, { name: "maren voss", conceptNote: "dup", role: "npc", tier: "minor" as const, relationships: [] }],
      "u",
      noLibrary,
    );
    expect(matched).toHaveLength(2);
  });
});

describe("groundCastRelationships", () => {
  function suggestion(name: string, relationships: Array<{ toward: string; stage: string }> = []) {
    return { name, conceptNote: "", role: "npc" as const, tier: "minor" as const, relationships };
  }

  it("resolves toward case-insensitively to the canonical suggestion name", () => {
    const sink = new DiagnosticCollector();
    const grounded = groundCastRelationships(
      [suggestion("Maren Voss", [{ toward: "tobben crale", stage: "wary" }]), suggestion("Tobben Crale")],
      sink,
    );
    expect(grounded[0]?.relationships).toEqual([{ toward: "Tobben Crale", stage: "wary" }]);
    expect(sink.items.filter((d) => d.severity !== "info")).toEqual([]);
  });

  it("resolves near-miss names through the same fuzz as location links", () => {
    const sink = new DiagnosticCollector();
    const grounded = groundCastRelationships(
      [suggestion("Issa Reed", [{ toward: "Elias Thorne", stage: "close" }]), suggestion("Dr. Elias Thorne")],
      sink,
    );
    expect(grounded[0]?.relationships).toEqual([{ toward: "Dr. Elias Thorne", stage: "close" }]);
    expect(sink.items.some((d) => d.code === "forge.world.cast.toward_fuzzy_resolved")).toBe(true);
  });

  it('keeps the literal "player" target in any casing', () => {
    const grounded = groundCastRelationships([suggestion("Maren Voss", [{ toward: "Player", stage: "friendly" }])]);
    expect(grounded[0]?.relationships).toEqual([{ toward: "player", stage: "friendly" }]);
  });

  it("drops unresolved targets with a warn diagnostic and a closest-name hint", () => {
    const sink = new DiagnosticCollector();
    const grounded = groundCastRelationships(
      [
        suggestion("Maren Voss", [
          { toward: "Tobben Vrale", stage: "close" },
          { toward: "Atlantis", stage: "devoted" },
        ]),
        suggestion("Tobben Crale"),
      ],
      sink,
    );
    expect(grounded[0]?.relationships).toEqual([]);
    const drops = sink.items.filter((d) => d.code === "forge.world.cast.unresolved_toward" && d.severity === "warn");
    expect(drops).toHaveLength(2);
    expect(drops[0]?.message).toContain('did you mean "Tobben Crale"');
  });

  it("drops self-targeted entries as unresolved", () => {
    const sink = new DiagnosticCollector();
    const grounded = groundCastRelationships(
      [suggestion("Maren Voss", [{ toward: "Maren Voss", stage: "devoted" }]), suggestion("Tobben Crale")],
      sink,
    );
    expect(grounded[0]?.relationships).toEqual([]);
    expect(sink.items.some((d) => d.code === "forge.world.cast.unresolved_toward")).toBe(true);
  });

  it("dedupes entries that resolve to the same target, keeping the first", () => {
    const sink = new DiagnosticCollector();
    const grounded = groundCastRelationships(
      [
        suggestion("Maren Voss", [
          { toward: "Tobben Crale", stage: "close" },
          { toward: "tobben crale", stage: "wary" },
        ]),
        suggestion("Tobben Crale"),
      ],
      sink,
    );
    expect(grounded[0]?.relationships).toEqual([{ toward: "Tobben Crale", stage: "close" }]);
    expect(sink.items.some((d) => d.code === "forge.world.cast.duplicate_relationship")).toBe(true);
  });
});

describe("cast section schema (suggested relationship entries)", () => {
  it("accepts entries and defaults missing relationships to []", () => {
    const section = castSectionSchema.parse({
      suggestions: [
        { name: "A", relationships: [{ toward: "B", stage: "close" }] },
        { name: "B" },
      ],
    });
    expect(section.suggestions[0]?.relationships).toEqual([{ toward: "B", stage: "close" }]);
    expect(section.suggestions[1]?.relationships).toEqual([]);
  });

  it('self-heals unknown stage ids to "stranger" via the contract schema catch', () => {
    const section = castSectionSchema.parse({
      suggestions: [{ name: "A", relationships: [{ toward: "B", stage: "best-friends-forever" }] }],
    });
    expect(section.suggestions[0]?.relationships[0]?.stage).toBe("stranger");
  });

  it("declines an entry with no toward", () => {
    const result = castSectionSchema.safeParse({
      suggestions: [{ name: "A", relationships: [{ stage: "close" }] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("groundItemPlacements", () => {
  const locations = ["Harbor Quay", "Customs House"];
  const cast = ["Maren Voss"];

  it("resolves names case-insensitively to canonical forms", () => {
    const placements = groundItemPlacements(
      { placements: [{ itemName: "Ledger", kind: "object", description: "", coverage: [], tags: [], locationName: "customs house", worn: false }] },
      locations,
      cast,
    );
    expect(placements[0]?.locationName).toBe("Customs House");
  });

  it("clears unresolved location references with a diagnostic, keeping the item", () => {
    const sink = new DiagnosticCollector();
    const placements = groundItemPlacements(
      { placements: [{ itemName: "Ledger", kind: "object", description: "", coverage: [], tags: [], locationName: "Atlantis", worn: false }] },
      locations,
      cast,
      sink,
    );
    expect(placements).toHaveLength(1);
    expect(placements[0]?.locationName).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.world.items.unresolved_location")).toBe(true);
  });

  it("clears unresolved cast references with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const placements = groundItemPlacements(
      { placements: [{ itemName: "Spyglass", kind: "object", description: "", coverage: [], tags: [], castName: "Nobody", worn: false }] },
      locations,
      cast,
      sink,
    );
    expect(placements[0]?.castName).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.world.items.unresolved_cast")).toBe(true);
  });

  it("only clothing on a cast member can be worn", () => {
    const placements = groundItemPlacements(
      {
        placements: [
          { itemName: "Spyglass", kind: "object", description: "", coverage: [], tags: [], castName: "Maren Voss", worn: true },
          { itemName: "Coat", kind: "clothing", description: "", coverage: ["torso"], layer: 3, tags: [], castName: "Maren Voss", worn: true },
          { itemName: "Hat", kind: "clothing", description: "", coverage: ["head"], layer: 2, tags: [], locationName: "Harbor Quay", worn: true },
        ],
      },
      locations,
      cast,
    );
    expect(placements.map((p) => p.worn)).toEqual([false, true, false]);
  });

  it("prefers the cast member when both placements are set", () => {
    const sink = new DiagnosticCollector();
    const placements = groundItemPlacements(
      {
        placements: [
          { itemName: "Coat", kind: "clothing", description: "", coverage: [], layer: 3, tags: [], locationName: "Harbor Quay", castName: "Maren Voss", worn: false },
        ],
      },
      locations,
      cast,
      sink,
    );
    expect(placements[0]?.castName).toBe("Maren Voss");
    expect(placements[0]?.locationName).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.world.items.ambiguous_placement")).toBe(true);
  });

  it("drops unknown clothing coverage with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const placements = groundItemPlacements(
      {
        placements: [
          { itemName: "Coat", kind: "clothing", description: "", coverage: ["torso", "tail_fin"], layer: 3, tags: [], castName: "Maren Voss", worn: true },
        ],
      },
      locations,
      cast,
      sink,
    );
    expect(placements[0]?.definition.coverage).toEqual(["torso"]);
    expect(sink.items.some((d) => d.code === "forge.world.items.invalid_coverage")).toBe(true);
  });

  it("drops an item that fails definition validation with a diagnostic instead of throwing", () => {
    const sink = new DiagnosticCollector();
    const placements = groundItemPlacements(
      {
        placements: [
          // An out-of-vocabulary kind slips past the section type but fails itemDefinitionSchema.
          { itemName: "Cursed blade", kind: "weapon" as never, description: "", coverage: [], tags: [], worn: false },
          { itemName: "Ledger", kind: "object", description: "", coverage: [], tags: [], locationName: "Customs House", worn: false },
        ],
      },
      locations,
      cast,
      sink,
    );
    expect(placements).toHaveLength(1);
    expect(placements[0]?.itemName).toBe("Ledger");
    expect(sink.items.some((d) => d.code === "forge.world.items.invalid_item" && d.severity === "warn")).toBe(true);
  });
});

describe("demo-mode forge (AI_FAKE=1 in test setup)", () => {
  it("is deterministic: same input, identical draft", async () => {
    const input = { prompt: "a fog-bound smuggling port", userId: "user_1", findCharacters: noLibrary };
    const a = await forgeWorld(input);
    const b = await forgeWorld(input);
    expect(a).toEqual(b);
  });

  it("produces a schema-valid, fully cross-referenced draft", async () => {
    const sink = new DiagnosticCollector();
    const draft = await forgeWorld({ prompt: "a fog-bound smuggling port", userId: "user_1", sink, findCharacters: noLibrary });
    expect(worldDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.name.length).toBeGreaterThan(0);
    expect(draft.locations.length).toBeGreaterThanOrEqual(4);
    expect(draft.castSuggestions.length).toBeGreaterThan(0);
    expect(draft.itemPlacements.length).toBeGreaterThan(0);

    // The demo draft is internally consistent: no grounding warnings.
    expect(sink.items.filter((d) => d.severity !== "info")).toEqual([]);

    // Graph already valid: re-validation changes nothing.
    const recheck = new DiagnosticCollector();
    expect(validateLocationGraph(draft.locations, recheck)).toEqual(draft.locations);
    expect(recheck.items).toEqual([]);

    // Placement references resolve against the draft itself.
    const locationNames = new Set(draft.locations.map((l) => l.name));
    const castNames = new Set(draft.castSuggestions.map((c) => c.name));
    for (const placement of draft.itemPlacements) {
      if (placement.locationName) expect(locationNames.has(placement.locationName)).toBe(true);
      if (placement.castName) expect(castNames.has(placement.castName)).toBe(true);
    }

    // Suggested relationships survive grounding and reference cast or player.
    expect(draft.castSuggestions.some((c) => c.relationships.length > 0)).toBe(true);
    for (const cast of draft.castSuggestions) {
      for (const rel of cast.relationships) {
        expect(rel.toward === "player" || castNames.has(rel.toward)).toBe(true);
      }
    }
  });

  it("includes 2-3 secret lore chunks wired to unlock tags", async () => {
    const draft = await forgeWorld({ prompt: "a fog-bound smuggling port", userId: "user_1", findCharacters: noLibrary });
    const secrets = draft.loreChunks.filter((c) => c.visibility === "secret");
    expect(secrets.length).toBeGreaterThanOrEqual(2);
    expect(secrets.length).toBeLessThanOrEqual(3);
    expect(secrets.every((s) => s.unlockTags.length > 0)).toBe(true);
    expect(draft.loreChunks.length).toBeGreaterThanOrEqual(8);
  });

  it("cast suggestions match the library through the same path", async () => {
    const lookup: LibraryLookup = async () => [{ id: "char_42", name: "Maren Voss" }];
    const draft = await forgeWorld({ prompt: "a port", userId: "user_1", findCharacters: lookup });
    const maren = draft.castSuggestions.find((c) => c.name === "Maren Voss");
    expect(maren?.existingCharacterId).toBe("char_42");
  });

  it("items section regenerated alone resolves against the provided draft", async () => {
    const base = await forgeWorld({ prompt: "a port", userId: "user_1", findCharacters: noLibrary });
    const patch = await forgeWorldSection("items", { prompt: "a port", userId: "user_1", draft: base, findCharacters: noLibrary });
    expect(patch.itemPlacements?.length).toBe(demoWorldItemsSection().placements.length);
    expect(patch.itemPlacements?.some((p) => p.castName === "Maren Voss")).toBe(true);
  });

  it("items section without draft context leaves placements unreferenced with diagnostics", async () => {
    const sink = new DiagnosticCollector();
    const patch = await forgeWorldSection("items", { prompt: "a port", userId: "user_1", sink, findCharacters: noLibrary });
    expect(patch.itemPlacements?.every((p) => p.locationName === undefined && p.castName === undefined)).toBe(true);
    expect(sink.items.some((d) => d.code === "forge.world.items.unresolved_location")).toBe(true);
  });
});

describe("auto-generate counts (UX-audit §1b)", () => {
  it("locationCount 0 skips location generation (an empty map to import into)", async () => {
    const patch = await forgeWorldSection("locations", { prompt: "a port", userId: "user_1", locationCount: 0, findCharacters: noLibrary });
    expect(patch.locations).toEqual([]);
    expect(patch.playerStartLocationName).toBeUndefined();
  });

  it("characterCount 0 skips cast generation", async () => {
    const patch = await forgeWorldSection("cast", { prompt: "a port", userId: "user_1", characterCount: 0, findCharacters: noLibrary });
    expect(patch.castSuggestions).toEqual([]);
  });

  it("forgeWorld with both counts 0 yields a location/cast-free draft that is still schema-valid", async () => {
    const draft = await forgeWorld({ prompt: "a port", userId: "user_1", locationCount: 0, characterCount: 0, findCharacters: noLibrary });
    expect(draft.locations).toEqual([]);
    expect(draft.castSuggestions).toEqual([]);
    expect(worldDraftSchema.safeParse(draft).success).toBe(true);
  });
});
