import { describe, expect, it } from "vitest";
import { emptyBrief } from "@/contracts/state/brief";
import {
  ARCHIVIST_SYSTEM,
  CONTINUITY_SYSTEM,
  DIRECTOR_SYSTEM,
  SIMULANT_SYSTEM,
  buildArchivistPrompt,
  buildContinuityPrompt,
  buildDirectorPrompt,
  buildSimulantPrompt,
} from "./agents";

const SYSTEMS = {
  SIMULANT_SYSTEM,
  ARCHIVIST_SYSTEM,
  CONTINUITY_SYSTEM,
  DIRECTOR_SYSTEM,
};

describe("agent system prompts", () => {
  it("stays within each agent's prompt budget (≈4 chars/token)", () => {
    // Archivist hugs ~600 tokens (2600). The simulant earns a touch more (~700)
    // for the item-event remove-destination convention (kept-in-hand vs floor vs
    // container — followups.phase4.md §8). The director carries the richest
    // contract — seven fields, four thread signals, the stageMovement channel
    // (phase-4 npc-movement), the thread-lifecycle rules, and four worked
    // examples — so it gets a larger ceiling (~1.5k tokens). Continuity earns a
    // little extra over the base for the comms-location-contradiction clause
    // (npc-movement-spec) — see docs/story-threads.md, docs/perception.md.
    const budget = (name: string): number =>
      ({ DIRECTOR_SYSTEM: 6200, CONTINUITY_SYSTEM: 2900, SIMULANT_SYSTEM: 2800 })[name] ?? 2600;
    for (const [name, text] of Object.entries(SYSTEMS)) {
      expect(text.length, name).toBeLessThan(budget(name));
    }
  });

  it("each carries the shared safety rules and two worked examples", () => {
    for (const [name, text] of Object.entries(SYSTEMS)) {
      expect(text, name).toMatch(/exactly as written|exactly as listed/i);
      expect(text, name).toMatch(/never invent/i);
      expect(text, name).toMatch(/quoted|hypothetical/i);
      expect(text, name).toContain("Example A");
      expect(text, name).toContain("Example B");
    }
  });

  it("worked examples sketch the agent's own schema fields", () => {
    expect(SIMULANT_SYSTEM).toContain('"minutesAdvanced"');
    expect(SIMULANT_SYSTEM).toContain('"movements"');
    // Completed undress/dress acts must be reported even in gradual, lyrical
    // prose — the hijab miss (followups.phase2.md #19).
    expect(SIMULANT_SYSTEM).toContain("Completed wardrobe changes matter most");
    // A removed garment routes to its destination, not always the hand (followups.phase4.md §8).
    expect(SIMULANT_SYSTEM).toContain("remove + locationName");
    expect(ARCHIVIST_SYSTEM).toContain('"episodeSummary"');
    expect(ARCHIVIST_SYSTEM).toContain('"supersedeHints"');
    expect(CONTINUITY_SYSTEM).toContain('"violations"');
    expect(CONTINUITY_SYSTEM).toContain('"normBreaches"');
    // Invented player dialogue is flagged as a violation (followups.phase2.md #5),
    // but restating the player's own input never is (#21 — the tea false positive).
    expect(CONTINUITY_SYSTEM).toContain("Invented player dialogue IS a violation");
    expect(CONTINUITY_SYSTEM).toContain("Restating the player's typed words, actions, or sensations is never invention");
    // Presence enforcement: an enacted absent character is a major violation.
    expect(CONTINUITY_SYSTEM).toContain("An absent character acting IS a violation");
    expect(CONTINUITY_SYSTEM).toContain('listed Elsewhere in the "Who is where" lines');
    expect(CONTINUITY_SYSTEM).toContain("no narrated physical arrival");
    expect(CONTINUITY_SYSTEM).toContain('canonical: "listed elsewhere this turn" (or "no narrated arrival")');
    expect(CONTINUITY_SYSTEM).toContain("quoted from past speech is not acting");
    expect(DIRECTOR_SYSTEM).toContain('"threadSignals"');
    expect(DIRECTOR_SYSTEM).toContain('"memoryQueries"');
  });

  it("simulant teaches salience tagging, the obvious default, and comms events", () => {
    expect(SIMULANT_SYSTEM).toContain("salience");
    expect(SIMULANT_SYSTEM).toMatch(/default obvious/i);
    expect(SIMULANT_SYSTEM).toContain("subtle");
    expect(SIMULANT_SYSTEM).toContain("commsEvents");
    // Example A demonstrates a concealed (subtle) act, a normal (obvious) one, and a comms open.
    expect(SIMULANT_SYSTEM).toContain('"visual":"subtle"');
    expect(SIMULANT_SYSTEM).toContain('"visual":"obvious"');
    expect(SIMULANT_SYSTEM).toContain('"op":"open","kind":"call"');
  });

  it("continuity teaches the two new presence/perception violation kinds", () => {
    expect(CONTINUITY_SYSTEM).toContain("narrated_absent_character");
    expect(CONTINUITY_SYSTEM).toContain("reacted_to_unperceived_event");
    // A comms-present character speaking is explicitly allowed.
    expect(CONTINUITY_SYSTEM).toMatch(/comms-present character speaking/i);
  });

  it("spells out the four threadSignals: touch keep-warm, develop logs a beat, propose is typed, resolve is ids", () => {
    expect(DIRECTOR_SYSTEM).toContain("touch = a listed thread is still live but nothing major happened");
    expect(DIRECTOR_SYSTEM).toContain("develop = a MAJOR beat advanced a listed thread");
    expect(DIRECTOR_SYSTEM).toContain("propose = open a genuinely new thread");
    expect(DIRECTOR_SYSTEM).toContain("kind: investigation|ongoing");
    expect(DIRECTOR_SYSTEM).toContain("resolve = listed ids of investigations now finished");
  });

  it("teaches the director to resolve a finished thread rather than re-touch it (the stale-thread loop fix)", () => {
    // A finished need left "open" rides every future context and gets re-raised
    // as if new — the Council Chamber Wi-Fi bug. Resolve must win over touch.
    expect(DIRECTOR_SYSTEM).toContain("Resolve an investigation the moment its need is met");
    expect(DIRECTOR_SYSTEM).toContain("mundane completion counts");
    expect(DIRECTOR_SYSTEM).toContain("Never keep touching/developing a finished thread");
  });

  it("teaches one-subject-one-thread consolidation via develop (the duplicate-threads fix)", () => {
    // Captain Thorne spawned three near-identical threads; develop must win over
    // a near-duplicate propose. Rule 5 + Example C carry the lesson.
    expect(DIRECTOR_SYSTEM).toContain("One subject, one thread");
    expect(DIRECTOR_SYSTEM).toContain("never open a near-duplicate");
    expect(DIRECTOR_SYSTEM).toContain('"develop":[{"id":"th_thorne"');
  });
});

describe("buildSimulantPrompt", () => {
  const input = {
    playerInput: "I follow Maya to the garden.",
    narration: "You trail her through the back door into the garden.",
    author: "player" as const,
    participants: [
      { displayName: "Brian", isUser: true, locationName: "Kitchen", activity: "idle", meters: { hygiene: 0.8 } },
      { displayName: "Maya", isUser: false, locationName: "Kitchen", activity: "cooking", meters: { hygiene: 0.9 } },
    ],
    locations: [
      { name: "Kitchen", exits: ["Garden"] },
      { name: "Garden", exits: ["Kitchen"] },
    ],
    items: [{ name: "lantern", placement: "in Kitchen" }],
    meterIds: ["hygiene", "energy"],
  };

  it("renders the physical state slice and the turn", () => {
    const text = buildSimulantPrompt(input);
    expect(text).toContain("- Brian (player) — at Kitchen; activity: idle; meters: hygiene 0.80");
    expect(text).toContain("- Kitchen → Garden");
    expect(text).toContain("- lantern — in Kitchen");
    expect(text).toContain("Meter ids: hygiene, energy");
    expect(text).toContain("Player input:\nI follow Maya to the garden.");
    expect(text).toContain("Narration:\nYou trail her");
  });

  it("prepends the end-state directive in reconcile mode", () => {
    const text = buildSimulantPrompt({ ...input, endState: true });
    expect(text.startsWith("END-STATE MODE")).toBe(true);
    expect(text).toContain("do not advance time");
  });

  it("appends a character's trait bands so deltas read in-character (personality §7)", () => {
    const text = buildSimulantPrompt({
      ...input,
      participants: [
        { displayName: "Maya", isUser: false, locationName: "Kitchen", activity: "cooking", meters: {}, traitBands: ["Warmth: cold", "Guardedness: guarded"] },
      ],
    });
    expect(text).toContain("disposition: Warmth: cold, Guardedness: guarded");
  });
});

describe("buildArchivistPrompt", () => {
  it("lists known entity names and active supersede candidates", () => {
    const text = buildArchivistPrompt({
      playerInput: "input",
      narration: "narration",
      author: "player",
      characterNames: ["Maya", "Rhett"],
      locationNames: ["Kitchen"],
      itemNames: ["lantern"],
      activeFacts: [{ subjectName: "Maya", text: "Maya trusts Rhett completely." }],
    });
    expect(text).toContain("Characters: Maya, Rhett");
    expect(text).toContain("Locations: Kitchen");
    expect(text).toContain("Items: lantern");
    expect(text).toContain("- [Maya] Maya trusts Rhett completely.");
    expect(text).toContain("quote oldFactText exactly");
  });
});

describe("buildContinuityPrompt", () => {
  it("carries canonical facts, the presence roster, and world norms", () => {
    const text = buildContinuityPrompt({
      playerInput: "input",
      narration: "narration",
      author: "player",
      canonicalFactsBlock: "## Canonical character facts\n- Maya — appears mid twenties.",
      presenceRoster: "## Who is where (authoritative presence roster this turn)\nPresent: Maya\nElsewhere: Fatima (Attic)",
      norms: [{ rule: "public nudity is scandalous", severity: "outrage", consequence: "witnesses gasp" }],
      presentNames: ["Maya"],
    });
    expect(text).toContain("Present characters: Maya");
    expect(text).toContain("## Who is where");
    expect(text).toContain("Present: Maya");
    expect(text).toContain("Elsewhere: Fatima (Attic)");
    expect(text).toContain("Maya — appears mid twenties.");
    expect(text).toContain('"public nudity is scandalous" (severity: outrage; consequence: witnesses gasp)');
  });

  it("degrades gracefully with no canon, no roster, and no norms", () => {
    const text = buildContinuityPrompt({
      playerInput: "input",
      narration: "narration",
      author: "player",
      canonicalFactsBlock: "",
      presenceRoster: "",
      norms: [],
      presentNames: [],
    });
    expect(text).toContain("Canonical character facts: none recorded.");
    expect(text).toContain("World norms:\n- none");
    expect(text).not.toContain("Who is where");
    // awarenessBlocks defaults to "" → no awareness heading.
    expect(text).not.toContain("Awareness (who can perceive what)");
  });

  it("renders the awareness block under a heading when provided", () => {
    const text = buildContinuityPrompt({
      playerInput: "input",
      narration: "narration",
      author: "player",
      canonicalFactsBlock: "",
      presenceRoster: "",
      norms: [],
      presentNames: ["Maya"],
      awarenessBlocks: "Maya: absorbed in cooking, back to the door (cannot see behind her).",
    });
    expect(text).toContain("Awareness (who can perceive what):");
    expect(text).toContain("Maya: absorbed in cooking, back to the door (cannot see behind her).");
  });

  it("omits the awareness heading when awarenessBlocks is empty", () => {
    const text = buildContinuityPrompt({
      playerInput: "input",
      narration: "narration",
      author: "player",
      canonicalFactsBlock: "",
      presenceRoster: "",
      norms: [],
      presentNames: ["Maya"],
      awarenessBlocks: "",
    });
    expect(text).not.toContain("Awareness (who can perceive what)");
  });
});

describe("buildDirectorPrompt", () => {
  it("lists threads by id and the prior brief", () => {
    const text = buildDirectorPrompt({
      playerInput: "input",
      narration: "narration",
      author: "player",
      priorBrief: { ...emptyBrief(), sceneSummary: "Tea in the kitchen.", storySoFar: "Two days at the inn." },
      threads: [
        {
          id: "th_brother",
          title: "Maya's missing brother",
          summary: "Unanswered letters.",
          kind: "investigation",
          status: "open",
          source: "anchor",
          question: "Where did Maya's brother go?",
          closeConditions: [],
          developments: [
            { turn: 2, text: "Found an unanswered letter.", kind: "evidence" },
            { turn: 3, text: "Maya deflected the question.", kind: "statement" },
          ],
          openedAtTurn: 1,
          lastTouchedTurn: 3,
          touchCount: 2,
        },
      ],
      turnNumber: 5,
      presentNames: ["Maya"],
      absentNpcs: [{ name: "Rhett", locationName: "The Docks" }],
      locationNames: ["The Kitchen", "The Docks", "Apartment Hallway"],
      stagedIntents: [],
    });
    expect(text).toContain("Turn number: 5");
    expect(text).toContain("Absent characters (off-screen — where they are now): Rhett (The Docks)");
    expect(text).toContain("Locations you can send someone to: The Kitchen, The Docks, Apartment Hallway");
    expect(text).toContain(
      "- [th_brother] Maya's missing brother (investigation, open; opened turn 1, last touched turn 3, touched 2×, 2 developments) — Unanswered letters.",
    );
    expect(text).toContain("- Scene: Tea in the kitchen.");
    expect(text).toContain("- Story so far: Two days at the inn.");
    expect(text).toContain("- Exposure: appearance ambient, scent none, touch none");
  });
});
