import { describe, expect, it } from "vitest";
import {
  chatArchivistSchema,
  chatCharacterNotesSchema,
  chatContinuitySchema,
  chatMemoryScribeSchema,
  chatMemoryTraceSchema,
  chatPersonalNotesSchema,
  CHAT_ARCHIVIST_MAX_FACTS,
  CHAT_ARCHIVIST_MAX_OPEN_LOOPS,
  CHAT_ARCHIVIST_MAX_QUERIES,
  CHAT_ARCHIVIST_MAX_TRAIT_SHIFTS,
  degradedChatArchivist,
  degradedChatPersonalNotes,
  emptyChatMemoryTrace,
  mergeChatExtractions,
} from "./chat-archivist";

describe("chatArchivistSchema (parsed-empty IS the degraded fallback)", () => {
  it("parses {} to the degraded default", () => {
    expect(chatArchivistSchema.parse({})).toEqual(degradedChatArchivist());
  });

  it("keeps a well-formed extraction", () => {
    const parsed = chatArchivistSchema.parse({
      episodeSummary: "They talked about Prague.",
      facts: [{ subjectName: "the player", subjectKind: "player", text: "The player's sister marries in Prague." }],
      memoryQueries: ["the sister's wedding"],
      attributeChanges: [{ participantName: "Mara", attributeId: "hair.length", value: "short" }],
    });
    expect(parsed.episodeSummary).toBe("They talked about Prague.");
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.memoryQueries).toEqual(["the sister's wedding"]);
    expect(parsed.attributeChanges).toHaveLength(1);
  });

  it("caps facts and queries, and drops a bad leaf without rejecting the object", () => {
    const parsed = chatArchivistSchema.parse({
      episodeSummary: 42, // wrong type ⇒ caught to ""
      facts: Array.from({ length: CHAT_ARCHIVIST_MAX_FACTS + 3 }, (_, i) => ({
        subjectName: `s${i}`,
        text: `fact ${i}`,
      })),
      memoryQueries: Array.from({ length: CHAT_ARCHIVIST_MAX_QUERIES + 2 }, (_, i) => `q${i}`),
    });
    expect(parsed.episodeSummary).toBe("");
    expect(parsed.facts).toHaveLength(CHAT_ARCHIVIST_MAX_FACTS);
    expect(parsed.memoryQueries).toHaveLength(CHAT_ARCHIVIST_MAX_QUERIES);
  });

  it("keeps, caps, and cleans openLoops (spec §6.2 — full-list-each-time)", () => {
    const parsed = chatArchivistSchema.parse({
      openLoops: Array.from({ length: CHAT_ARCHIVIST_MAX_OPEN_LOOPS + 2 }, (_, i) => ` loop ${i} `),
    });
    expect(parsed.openLoops).toHaveLength(CHAT_ARCHIVIST_MAX_OPEN_LOOPS);
    expect(parsed.openLoops[0]).toBe("loop 0");
    // A malformed list degrades to [] without rejecting the object.
    expect(chatArchivistSchema.parse({ openLoops: "not-a-list" }).openLoops).toEqual([]);
    expect(degradedChatArchivist().openLoops).toEqual([]);
  });

  it("parses the outfit proposal (chat-wardrobe-parity): whole swap + garment deltas, never rejected", () => {
    const changed = chatArchivistSchema.parse({
      outfit: {
        description: "  a black wrap dress and heels ",
        changeEvidence: "she comes back down in a black wrap dress",
        exposed: false,
      },
    });
    expect(changed.outfit).toEqual({
      description: "a black wrap dress and heels",
      changeEvidence: "she comes back down in a black wrap dress",
      exposed: false,
      removed: [],
      added: [],
    });
    // {} is the no-change no-op (the common case in the prompt's examples).
    expect(chatArchivistSchema.parse({ outfit: {} }).outfit).toEqual({ description: "", changeEvidence: "", exposed: false, removed: [], added: [] });
    // A whole-look description with NO change evidence still parses — the FOLD is what
    // refuses to replace a modelled wardrobe on it (owner ruling 2026-08-01), not the schema.
    expect(chatArchivistSchema.parse({ outfit: { description: "a soft cotton shirt" } }).outfit.changeEvidence).toBe("");
    expect(chatArchivistSchema.parse({ outfit: { changeEvidence: 42 } }).outfit.changeEvidence).toBe("");
    // Garment-level deltas (rung 2): individual pieces off/on, whitespace-trimmed, capped.
    const delta = chatArchivistSchema.parse({ outfit: { removed: [" her jacket "], added: ["a wool cardigan"] } });
    expect(delta.outfit).toEqual({ description: "", changeEvidence: "", exposed: false, removed: ["her jacket"], added: ["a wool cardigan"] });
    // Long descriptions pass through whole — outfits are uncapped (owner ruling 2026-07-12).
    const long = chatArchivistSchema.parse({ outfit: { description: "x".repeat(1000), exposed: true } });
    expect(long.outfit.description.length).toBe(1000);
    expect(long.outfit.exposed).toBe(true);
    // A malformed proposal degrades to the no-op without rejecting the object.
    expect(chatArchivistSchema.parse({ outfit: "naked" }).outfit).toEqual({ description: "", changeEvidence: "", exposed: false, removed: [], added: [] });
  });

  it("parses the supporting-cast proposal (chat-supporting-cast.plan.md): lenient, [] on garbage", () => {
    const parsed = chatArchivistSchema.parse({
      cast: [{ name: "Abby", relation: "the player's coworker", details: ["covered a shift"] }],
    });
    expect(parsed.cast).toEqual([{ name: "Abby", relation: "the player's coworker", details: ["covered a shift"] }]);
    // Absent / malformed ⇒ [] — the merge no-op, never a rejected object.
    expect(chatArchivistSchema.parse({}).cast).toEqual([]);
    expect(chatArchivistSchema.parse({ cast: "Abby" }).cast).toEqual([]);
    expect(degradedChatArchivist().cast).toEqual([]);
  });

  it("parses the voice/consistency/trait fields (slices 8-10), degrading each to empty", () => {
    const parsed = chatArchivistSchema.parse({
      voiceExemplar: "Tell me you at least practiced the toast.",
      characterSlip: "spoke like a therapist, not a teen — loosen the diction",
      traitShifts: [{ trait: "temperament.warmth", direction: "up" }],
    });
    expect(parsed.voiceExemplar).toBe("Tell me you at least practiced the toast.");
    expect(parsed.characterSlip).toBe("spoke like a therapist, not a teen — loosen the diction");
    expect(parsed.traitShifts).toEqual([{ trait: "temperament.warmth", direction: "up" }]);
    // Absent ⇒ empty (the common case); degraded fallback carries them empty too.
    expect(chatArchivistSchema.parse({}).voiceExemplar).toBe("");
    expect(chatArchivistSchema.parse({}).characterSlip).toBe("");
    expect(chatArchivistSchema.parse({}).traitShifts).toEqual([]);
    expect(degradedChatArchivist().voiceExemplar).toBe("");
    expect(degradedChatArchivist().characterSlip).toBe("");
    expect(degradedChatArchivist().traitShifts).toEqual([]);
    // Malformed values degrade rather than rejecting the object.
    expect(chatArchivistSchema.parse({ voiceExemplar: 42, characterSlip: {}, traitShifts: "nope" })).toMatchObject({
      voiceExemplar: "",
      characterSlip: "",
      traitShifts: [],
    });
    // Trait shifts are capped.
    const many = chatArchivistSchema.parse({
      traitShifts: Array.from({ length: CHAT_ARCHIVIST_MAX_TRAIT_SHIFTS + 3 }, () => ({ trait: "social.guardedness", direction: "down" })),
    });
    expect(many.traitShifts).toHaveLength(CHAT_ARCHIVIST_MAX_TRAIT_SHIFTS);
  });
});

describe("the extraction legs (chat-agent-improvements slice 1b)", () => {
  it("each leg's degraded parse equals the aggregate's, field for field", () => {
    const whole = degradedChatArchivist();
    const scribe = chatMemoryScribeSchema.parse({});
    const continuity = chatContinuitySchema.parse({});
    const character = chatCharacterNotesSchema.parse({});
    // The legs are `pick`s of the aggregate, so the caps/defaults have ONE source.
    expect(scribe).toEqual({ episodeSummary: whole.episodeSummary, facts: whole.facts, memoryQueries: whole.memoryQueries });
    expect(continuity).toEqual({
      scene: whole.scene,
      environment: whole.environment,
      surfaceWetness: whole.surfaceWetness,
      surfaceDeposits: whole.surfaceDeposits,
      garmentOperations: whole.garmentOperations,
      outfit: whole.outfit,
      playerOutfit: whole.playerOutfit,
      attributeChanges: whole.attributeChanges,
      presence: whole.presence,
      cast: whole.cast,
    });
    expect(character).toEqual({
      openLoops: whole.openLoops,
      plans: whole.plans,
      driveUpdates: whole.driveUpdates,
      voiceExemplar: whole.voiceExemplar,
      characterSlip: whole.characterSlip,
      traitShifts: whole.traitShifts,
    });
  });

  /**
   * The player's wardrobe is chat-wide, so it belongs to the SHARED continuity leg only.
   * The personal pass runs once per present ensemble member — if it carried playerOutfit,
   * three members would each propose changes to the one player's clothes and the last
   * fold would win at random (persona-library.plan.md slice 8).
   */
  it("keeps playerOutfit out of the per-member personal pass", () => {
    expect(chatPersonalNotesSchema.parse({})).not.toHaveProperty("playerOutfit");
    expect(chatContinuitySchema.parse({})).toHaveProperty("playerOutfit");
  });

  it("mergeChatExtractions reassembles the aggregate; an absent leg contributes empties, never nulls", () => {
    const merged = mergeChatExtractions({
      memory: chatMemoryScribeSchema.parse({ episodeSummary: "They talked." }),
      continuity: null,
      character: null,
    });
    expect(merged).toEqual({ ...degradedChatArchivist(), episodeSummary: "They talked." });
    // Every-leg-null is still a complete, parseable aggregate (the folds never see undefined).
    expect(mergeChatExtractions({ memory: null, continuity: null, character: null })).toEqual(degradedChatArchivist());
  });

  it("the personal pass is a pick of the same four fields (not a second copy of them)", () => {
    expect(chatPersonalNotesSchema.parse({})).toEqual(degradedChatPersonalNotes());
    expect(Object.keys(chatPersonalNotesSchema.shape).sort()).toEqual(
      ["attributeChanges", "driveUpdates", "openLoops", "outfit"].sort(),
    );
    // Same caps as the aggregate, because they ARE the aggregate's fields.
    const capped = chatPersonalNotesSchema.parse({
      openLoops: ["a", "b", "c", "d", "e"],
    });
    expect(capped.openLoops).toHaveLength(CHAT_ARCHIVIST_MAX_OPEN_LOOPS);
  });
});

describe("chatMemoryTraceSchema", () => {
  it("parses {} to a clean empty trace", () => {
    expect(chatMemoryTraceSchema.parse({})).toEqual(emptyChatMemoryTrace());
    expect(emptyChatMemoryTrace().degraded).toBe(false);
    expect(emptyChatMemoryTrace().factsAdded).toBe(0);
  });

  it("carries the character-slip corrective (slice 9), degrading a malformed value to '' (no note)", () => {
    expect(chatMemoryTraceSchema.parse({ characterSlip: "too formal for her age" }).characterSlip).toBe("too formal for her age");
    // Absent / malformed ⇒ "" ⇒ no corrective tail note next turn.
    expect(emptyChatMemoryTrace().characterSlip).toBe("");
    expect(chatMemoryTraceSchema.parse({ characterSlip: 42 }).characterSlip).toBe("");
  });
});
