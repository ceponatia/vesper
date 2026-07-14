import { describe, expect, it } from "vitest";
import {
  chatArchivistSchema,
  chatCharacterNotesSchema,
  chatContinuitySchema,
  chatMemoryScribeSchema,
  chatPersonalNotesSchema,
  mergeChatExtractions,
} from "@/contracts/turns/chat-archivist";
import {
  buildChatExtractorPrompt,
  buildChatExtractorSystem,
  type ChatExtractorContext,
  type ChatExtractorLegId,
} from "./chat-extractors";

/**
 * The extraction field library (chat-agent-improvements.plan.md slice 1a) and the three
 * specialist legs composed from it (slice 1b). The properties worth locking are the ones
 * the hand-written monolith kept breaking: every field the sheet numbers is a field the
 * schema accepts, every example shows every armed key, unarmed fields disappear entirely,
 * and the personal pass is the SAME modules rather than a second copy of the wording.
 */

const ctx = (overrides: Partial<ChatExtractorContext> = {}): ChatExtractorContext => ({
  characterName: "Mara",
  playerName: "Theo",
  exchange: { player: "How was your day?", assistant: "Mara shrugs. \"Long. Yours?\"" },
  ...overrides,
});

/** The JSON objects a leg's system prompt teaches by example. */
function examplesIn(system: string): Record<string, unknown>[] {
  return [...system.matchAll(/^\{.*\}$/gm)].map((m) => JSON.parse(m[0]) as Record<string, unknown>);
}

/** The keys a leg's numbered instruction list actually names. */
function instructedKeys(system: string): string[] {
  return [...system.matchAll(/^\d+\. "(\w+)":/gm)].map((m) => m[1] ?? "");
}

const LEG_SCHEMAS: Record<ChatExtractorLegId, { keyof: () => string[] }> = {
  memory: { keyof: () => Object.keys(chatMemoryScribeSchema.shape) },
  continuity: { keyof: () => Object.keys(chatContinuitySchema.shape) },
  character: { keyof: () => Object.keys(chatCharacterNotesSchema.shape) },
  personal: { keyof: () => Object.keys(chatPersonalNotesSchema.shape) },
};

describe("the extractor legs are composed from the field library", () => {
  // Fully armed: every conditional field (presence / drives / trait shifts) has its data.
  const armed = ctx({
    roster: [
      { name: "Mara", presence: "present" },
      { name: "Nyx", presence: "away" },
    ],
    drives: [{ want: "finish the commission", secrecy: "open", revealed: false }],
    developableTraits: [{ id: "social.guardedness", label: "Guardedness", band: "guarded" }],
    supportingCast: [{ name: "Abby", relation: "the player's coworker" }],
    voiceReference: { petPhrases: ["don't make it a thing"], cadence: "dry, clipped" },
  });

  it.each<ChatExtractorLegId>(["memory", "continuity", "character", "personal"])(
    "%s: every instructed field is a schema field, and vice versa",
    (legId) => {
      const instructed = instructedKeys(buildChatExtractorSystem(legId, armed));
      // The `outfit` field's instruction spans several lines; it still leads with its key.
      expect(instructed.sort()).toEqual(LEG_SCHEMAS[legId].keyof().sort());
    },
  );

  it.each<ChatExtractorLegId>(["memory", "continuity", "character", "personal"])(
    "%s: every worked example carries every armed key (they can no longer drift apart)",
    (legId) => {
      const system = buildChatExtractorSystem(legId, armed);
      const keys = LEG_SCHEMAS[legId].keyof().sort();
      const examples = examplesIn(system);
      expect(examples.length).toBeGreaterThan(1);
      for (const example of examples) {
        expect(Object.keys(example).sort()).toEqual(keys);
        // And every example parses as its leg's own output.
        expect(() => chatArchivistSchema.parse(example)).not.toThrow();
      }
    },
  );

  it.each<ChatExtractorLegId>(["memory", "continuity", "character", "personal"])(
    "%s: closes with the empty-output example — the single most common reply",
    (legId) => {
      const examples = examplesIn(buildChatExtractorSystem(legId, armed));
      const last = examples.at(-1) ?? {};
      const nonEmpty = Object.entries(last).filter(
        ([key, value]) =>
          key !== "episodeSummary" && (Array.isArray(value) ? value.length > 0 : typeof value === "object" ? Object.keys(value ?? {}).length > 0 : Boolean(value)),
      );
      expect(nonEmpty).toEqual([]);
    },
  );

  it("the three shared legs partition the aggregate exactly — no field lost, none extracted twice", () => {
    const legKeys = [
      ...Object.keys(chatMemoryScribeSchema.shape),
      ...Object.keys(chatContinuitySchema.shape),
      ...Object.keys(chatCharacterNotesSchema.shape),
    ];
    expect(new Set(legKeys).size).toBe(legKeys.length); // no overlap
    expect(legKeys.sort()).toEqual(Object.keys(chatArchivistSchema.shape).sort()); // no gap
  });
});

describe("unarmed fields disappear from the sheet entirely", () => {
  it("a 1-on-1 never sees the ensemble-only presence field", () => {
    const solo = buildChatExtractorSystem("continuity", ctx());
    expect(solo).not.toContain('"presence"');
    expect(solo).not.toContain("Roster");

    const group = buildChatExtractorSystem(
      "continuity",
      ctx({ roster: [{ name: "Mara", presence: "present" }, { name: "Nyx", presence: "present" }] }),
    );
    expect(group).toContain('"presence"');
  });

  it("a character with no drives / no developable traits sees neither instruction", () => {
    const bare = buildChatExtractorSystem("character", ctx());
    expect(bare).not.toContain('"driveUpdates"');
    expect(bare).not.toContain('"traitShifts"');
    // …but always the reads that need no data.
    expect(bare).toContain('"openLoops"');
    expect(bare).toContain('"voiceExemplar"');
    expect(bare).toContain('"characterSlip"');
  });

  it("numbering is contiguous whatever is armed", () => {
    const bare = buildChatExtractorSystem("character", ctx());
    expect(bare).toContain("Produce a single JSON object with these 3 fields:");
    expect(instructedKeys(bare)).toEqual(["openLoops", "voiceExemplar", "characterSlip"]);
  });
});

describe("the user message carries each armed field's context block, fenced", () => {
  it("fences the exchange and renders only the blocks the armed fields need", () => {
    const prompt = buildChatExtractorPrompt("character", ctx({ openLoops: ["hear how the toast goes"] }));
    expect(prompt).toContain("Character: Mara");
    expect(prompt).toContain("Currently open loops:");
    expect(prompt).toMatch(/vsp-untrusted-[0-9a-f]+:open loops/);
    expect(prompt).toMatch(/vsp-untrusted-[0-9a-f]+:latest exchange/);
    // No drives armed ⇒ no drives block (the field isn't on the sheet either).
    expect(prompt).not.toContain("Current drives");
  });

  it("the memory scribe reads the recap's ledger so a pronoun-heavy beat files a NAMED fact", () => {
    const prompt = buildChatExtractorPrompt(
      "memory",
      ctx({ priorSummary: "Established:\n- Mara's sister is named Iris." }),
    );
    expect(prompt).toContain("The story so far");
    expect(prompt).toContain("NEVER extract facts from this");
    expect(prompt).toMatch(/vsp-untrusted-[0-9a-f]+:story so far/);
    // Scribe-only: the other legs judge the exchange itself.
    expect(buildChatExtractorPrompt("continuity", ctx({ priorSummary: "Established:\n- x" }))).not.toContain(
      "The story so far",
    );
  });

  it("only the fact-filing leg carries the notation channel hint", () => {
    const withThought = ctx({ exchange: { player: "*she'll never say yes* Hey.", assistant: "\"Hey.\"" } });
    expect(buildChatExtractorPrompt("memory", withThought)).toContain("Channel notes");
    expect(buildChatExtractorPrompt("continuity", withThought)).not.toContain("Channel notes");
  });

  it("the personal pass labels the reply as the whole scene's, and owns only its character", () => {
    const system = buildChatExtractorSystem("personal", ctx());
    const prompt = buildChatExtractorPrompt("personal", ctx());
    expect(system).toContain("Several characters share the scene");
    expect(system).toContain("Track ONLY Mara");
    expect(prompt).toContain("Your character: Mara");
    expect(prompt).toContain("Scene reply:");
  });
});

describe("mergeChatExtractions", () => {
  it("merges the three legs into the aggregate every fold consumes", () => {
    const merged = mergeChatExtractions({
      memory: chatMemoryScribeSchema.parse({ episodeSummary: "They talked.", memoryQueries: ["the toast"] }),
      continuity: chatContinuitySchema.parse({ outfit: { removed: ["her cardigan"] } }),
      character: chatCharacterNotesSchema.parse({ openLoops: ["hear how the toast goes"] }),
    });
    expect(merged.episodeSummary).toBe("They talked.");
    expect(merged.memoryQueries).toEqual(["the toast"]);
    expect(merged.outfit.removed).toEqual(["her cardigan"]);
    expect(merged.openLoops).toEqual(["hear how the toast goes"]);
    // Untouched fields take the degraded defaults.
    expect(merged.facts).toEqual([]);
    expect(merged.traitShifts).toEqual([]);
  });

  it("one failed leg costs only its own fields — the whole point of the split", () => {
    const merged = mergeChatExtractions({
      memory: null, // the scribe timed out
      continuity: chatContinuitySchema.parse({ scene: { current: "kitchen" } }),
      character: chatCharacterNotesSchema.parse({ voiceExemplar: "Long. Yours?" }),
    });
    expect(merged.episodeSummary).toBe("");
    expect(merged.facts).toEqual([]);
    expect(merged.scene.current).toBe("kitchen");
    expect(merged.voiceExemplar).toBe("Long. Yours?");
  });
});
