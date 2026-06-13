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
  it("stays under the ~600-token budget (≈4 chars/token)", () => {
    for (const [name, text] of Object.entries(SYSTEMS)) {
      expect(text.length, name).toBeLessThan(2600);
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
    expect(SIMULANT_SYSTEM).toContain("remove + place");
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

  it("spells out the threadSignals shape: touch carries id + title, resolve is ids only", () => {
    expect(DIRECTOR_SYSTEM).toContain("touch = listed threads advanced this turn (give each thread's listed id plus its title)");
    expect(DIRECTOR_SYSTEM).toContain("propose = new threads to open sparingly ({title, summary})");
    expect(DIRECTOR_SYSTEM).toContain("resolve = listed ids of threads that concluded");
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
          status: "open",
          source: "anchor",
          openedAtTurn: 1,
          lastTouchedTurn: 3,
          touchCount: 2,
        },
      ],
      turnNumber: 5,
      presentNames: ["Maya"],
    });
    expect(text).toContain("Turn number: 5");
    expect(text).toContain("- [th_brother] Maya's missing brother (open; last touched turn 3) — Unanswered letters.");
    expect(text).toContain("- Scene: Tea in the kitchen.");
    expect(text).toContain("- Story so far: Two days at the inn.");
    expect(text).toContain("- Exposure: appearance ambient, scent none, touch none");
  });
});
