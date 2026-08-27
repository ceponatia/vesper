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
  garmentOperationProposalListSchema,
  garmentOperationProposalSchema,
  type GarmentHandleTable,
} from "@/contracts";
import {
  buildChatExtractorPrompt,
  buildChatExtractorSystem,
  type ChatExtractorContext,
  type ChatExtractorLegId,
} from "./chat-extractors";

/**
 * The extraction field library and the three
 * specialist legs composed from it. The properties worth locking are the ones
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

/**
 * The wardrobe grammars are MUTUALLY EXCLUSIVE (clothing-state-graph slice 5):
 * with handles in scope the sheet carries `garmentOperations`, without them the
 * legacy `outfit`/`playerOutfit` pair. So a leg's expected key set is its schema's
 * minus whichever grammar this context disarms.
 */
function armedKeys(legId: ChatExtractorLegId, context: ChatExtractorContext): string[] {
  const grounded = (context.garmentHandles?.entries.length ?? 0) > 0;
  const disarmed = grounded ? ["outfit", "playerOutfit"] : ["garmentOperations"];
  return LEG_SCHEMAS[legId]
    .keyof()
    .filter((key) => !disarmed.includes(key))
    .sort();
}

/**
 * The (leg, wardrobe lane) pairs both sheet-shape properties are checked over.
 * Both properties must see BOTH lanes, so the matrix lives here once rather than
 * being retyped per `it.each` — a lane added to one and not the other is exactly
 * the gap this file exists to close.
 */
/**
 * Every operation kind the proposal contract accepts, in schema order — read off
 * the discriminated union itself so the sheet's bullet list can never drift from
 * what the parser will take.
 */
const PROPOSAL_OPS: string[] = garmentOperationProposalSchema.options.map((option) => option.shape.op.value);

const LANE_CASES: [ChatExtractorLegId, "legacy" | "grounded"][] = [
  ["memory", "legacy"],
  ["continuity", "legacy"],
  ["continuity", "grounded"],
  ["character", "legacy"],
  ["personal", "legacy"],
];

/** A minimal in-scope handle table — the switch that arms the grounded lane. */
const HANDLES: GarmentHandleTable = {
  entries: [
    {
      handle: "mara.shirt",
      garmentId: "g1",
      name: "cotton shirt",
      where: "worn by Mara",
      locusKind: "worn",
      partHandles: ["root", "front_panel", "sleeve_left", "sleeve_right", "hem"],
      partIds: ["root", "front_panel", "sleeve_left", "sleeve_right", "hem", "collar"],
    },
  ],
  actors: [{ handle: "mara", actorId: "c:mara", label: "Mara" }],
  trimmed: false,
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

  // Both wardrobe lanes, so neither grammar can rot: `grounded` has handles in
  // scope (the operations field arms), `armed` has none (the legacy pair arms).
  const grounded = ctx({ ...armed, garmentHandles: HANDLES });

  it.each(LANE_CASES)("%s (%s wardrobe lane): every instructed field is an armed schema field, and vice versa", (legId, lane) => {
    const context = lane === "grounded" ? grounded : armed;
    const instructed = instructedKeys(buildChatExtractorSystem(legId, context));
    // The `outfit` field's instruction spans several lines; it still leads with its key.
    expect(instructed.sort()).toEqual(armedKeys(legId, context));
  });

  it.each(LANE_CASES)("%s (%s wardrobe lane): every worked example carries every armed key", (legId, lane) => {
    const context = lane === "grounded" ? grounded : armed;
    const system = buildChatExtractorSystem(legId, context);
    const keys = armedKeys(legId, context);
    const examples = examplesIn(system);
    expect(examples.length).toBeGreaterThan(1);
    for (const example of examples) {
      expect(Object.keys(example).sort()).toEqual(keys);
      // And every example parses as its leg's own output.
      expect(() => chatArchivistSchema.parse(example)).not.toThrow();
    }
  });

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

  /**
   * The grounded wardrobe lane (clothing-state-graph slice 5). The sheet must
   * never carry both grammars: the handle table is what decides, and the same
   * switch is what `garmentMutationLane` reads on the way back in.
   */
  it("handles in scope REPLACE the free-text outfit grammar with typed operations", () => {
    const legacy = buildChatExtractorSystem("continuity", ctx());
    expect(legacy).toContain('"outfit"');
    expect(legacy).toContain('"playerOutfit"');
    expect(legacy).not.toContain('"garmentOperations"');

    const grounded = buildChatExtractorSystem("continuity", ctx({ garmentHandles: HANDLES }));
    expect(grounded).toContain('"garmentOperations"');
    expect(grounded).not.toContain('"outfit"');
    expect(grounded).not.toContain('"playerOutfit"');
    // The vocabulary is rendered from the registries, so a contract edit reaches the
    // sheet — and this list is the CONTRACT's own, not a retyped copy: a proposal kind
    // added to the discriminated union fails here until the sheet teaches it.
    for (const op of PROPOSAL_OPS) {
      expect(grounded).toContain(`"op":"${op}"`);
    }
    expect(PROPOSAL_OPS.length).toBeGreaterThan(0);
    expect(grounded).toContain("slight | moderate | substantial | extreme");
  });

  it("the handle table reaches the user message, fenced, with its actor handles", () => {
    const prompt = buildChatExtractorPrompt("continuity", ctx({ garmentHandles: HANDLES }));
    expect(prompt).toContain("Garments in scene");
    expect(prompt).toContain("mara.shirt — cotton shirt, worn by Mara; parts: root front_panel");
    expect(prompt).toContain("Actor handles: mara = Mara");
    expect(prompt).toMatch(/vsp-untrusted-[0-9a-f]+:garment handles/);
    // No handles ⇒ no block at all (the field isn't on the sheet either).
    expect(buildChatExtractorPrompt("continuity", ctx())).not.toContain("Garments in scene");
  });

  it("the worked garment examples survive the proposal schema — a sheet cannot teach an invalid shape", () => {
    const system = buildChatExtractorSystem("continuity", ctx({ garmentHandles: HANDLES }));
    const withOps = examplesIn(system).filter(
      (ex) => Array.isArray(ex.garmentOperations) && ex.garmentOperations.length > 0,
    );
    expect(withOps.length).toBeGreaterThan(0);
    for (const example of withOps) {
      const proposals = example.garmentOperations as unknown[];
      expect(garmentOperationProposalListSchema.parse(proposals)).toHaveLength(proposals.length);
    }
  });

  it("numbering is contiguous whatever is armed", () => {
    const bare = buildChatExtractorSystem("character", ctx());
    const instructed = instructedKeys(bare);
    // The leg's own schema fields, in schema order, minus the two this context
    // disarms (no drives, no developable traits) — derived, so a new unconditional
    // field on the schema updates the expectation instead of breaking it.
    expect(instructed).toEqual(
      Object.keys(chatCharacterNotesSchema.shape).filter((key) => !["driveUpdates", "traitShifts"].includes(key)),
    );
    // …and the header's count is that list's length, so the sentence cannot go stale.
    expect(bare).toContain(`Produce a single JSON object with these ${instructed.length} fields:`);
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
