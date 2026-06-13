import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts";
import { parseOr } from "@/lib/parse";
import {
  characterDraftSchema,
  emptyCharacterDraft,
  emptyWorldDraft,
  worldDraftCastSuggestionSchema,
  worldDraftItemPlacementSchema,
  worldDraftLocationSchema,
  worldDraftLoreChunkSchema,
  worldDraftSchema,
} from "./drafts";

describe("draft schemas accept {} (all-default partial drafts)", () => {
  it("characterDraftSchema parses {} into a complete draft", () => {
    const draft = characterDraftSchema.parse({});
    expect(draft.name).toBe("");
    expect(draft.tags).toEqual([]);
    expect(draft.suggestedItems).toEqual([]);
    expect(draft.profile.bodyPlanId).toBe("humanoid");
    expect(draft.profile.attributes).toEqual([]);
    expect(draft.profile.defaultOutfit).toEqual([]);
  });

  it("worldDraftSchema parses {} into a complete draft", () => {
    const draft = worldDraftSchema.parse({});
    expect(draft.name).toBe("");
    expect(draft.description).toBe("");
    expect(draft.locations).toEqual([]);
    expect(draft.loreChunks).toEqual([]);
    expect(draft.castSuggestions).toEqual([]);
    expect(draft.itemPlacements).toEqual([]);
    expect(draft.style.directives).toEqual([]);
    expect(draft.style.norms).toEqual([]);
    expect(draft.lore.synopsis).toBe("");
  });

  it("nested draft element schemas accept {}", () => {
    expect(worldDraftLocationSchema.parse({})).toEqual({ name: "", description: "", ambient: {}, scale: "room", tags: [], links: [] });
    const chunk = worldDraftLoreChunkSchema.parse({});
    expect(chunk.category).toBe("history");
    expect(chunk.tier).toBe("scene");
    expect(chunk.visibility).toBe("public");
    const cast = worldDraftCastSuggestionSchema.parse({});
    expect(cast.role).toBe("npc");
    expect(cast.tier).toBe("minor");
    expect(cast.existingCharacterId).toBeUndefined();
    const placement = worldDraftItemPlacementSchema.parse({});
    expect(placement.definition.kind).toBe("object");
    expect(placement.worn).toBe(false);
  });

  it("bad enum leaves are caught, not fatal", () => {
    const chunk = worldDraftLoreChunkSchema.parse({ title: "x", body: "y", category: "nonsense", tier: 7, visibility: "hidden" });
    expect(chunk.category).toBe("history");
    expect(chunk.tier).toBe("scene");
    expect(chunk.visibility).toBe("public");
  });

  it("empty helpers return independent objects", () => {
    const a = emptyWorldDraft();
    const b = emptyWorldDraft();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.style).not.toBe(b.style);
    expect(emptyCharacterDraft().profile).not.toBe(emptyCharacterDraft().profile);
  });
});

describe("drafts at the parse boundary", () => {
  it("garbage degrades to the empty draft with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const draft = parseOr(worldDraftSchema, 42, emptyWorldDraft(), sink, "test.world_draft");
    expect(draft).toEqual(emptyWorldDraft());
    expect(sink.items.some((d) => d.code === "parse.boundary_failed")).toBe(true);
  });

  it("a partially valid draft keeps what it can", () => {
    const draft = worldDraftSchema.parse({ name: "Greywater Harbor" });
    expect(draft.name).toBe("Greywater Harbor");
    expect(draft.locations).toEqual([]);
  });
});
