import { describe, expect, it } from "vitest";
import { lifeStageForAge } from "@/contracts/world/life-stage";
import type { MicroExemplar, VoiceAnchors } from "@/contracts/world/profile";
import {
  attributionTagRule,
  buildLifeStageSection,
  cameraViewpointRule,
  CONTENT_FRAMING,
  CONTENT_FRAMING_MINOR_PRIMARY,
  ENSEMBLE_MINOR_CAST_LINE,
  intimateCraftBlock,
  messageNotationBlock,
  narratorCameraRule,
  naturalDialogueRule,
  noRefusalRule,
  PHYSICAL_STATE_LAW_RULE,
  PROPORTIONALITY_RULE,
  readingPlayerMessageBlock,
  shapingBlock,
  TOPIC_DISCIPLINE_RULE,
} from "./charter";
import { buildBioSection, buildMicroExemplarsSection, buildVoiceAnchorsSection, excerpt } from "./profile-sections";

/**
 * Focused unit coverage for the shared narrator charter. The full
 * BYTE-IDENTITY gate for the legacy lane lives in
 * `character-chat.test.ts` (these units are exercised end-to-end there); this file is a
 * cheap sanity check that each unit renders the right craft law for the right params and
 * is deterministic — the guarantees the successor-lane slice will rely on.
 */

describe("charter — content framing", () => {
  it("selects the adult frame vs the minor frame by their distinct content", () => {
    // The adult frame licenses explicit content in scope; the minor frame rules it out.
    expect(CONTENT_FRAMING).toMatch(/adult interactive fiction/i);
    expect(CONTENT_FRAMING).toMatch(/fully in scope/);
    expect(CONTENT_FRAMING_MINOR_PRIMARY).toContain("This character is a minor");
    expect(CONTENT_FRAMING_MINOR_PRIMARY).toMatch(/strictly out of scope/);
    // The two are genuinely different frames — the lane picks one by the authored age.
    expect(CONTENT_FRAMING).not.toBe(CONTENT_FRAMING_MINOR_PRIMARY);
    expect(CONTENT_FRAMING_MINOR_PRIMARY).not.toMatch(/fully in scope/);
  });

  it("carries the ensemble minor-cast fence line", () => {
    expect(ENSEMBLE_MINOR_CAST_LINE).toMatch(/are minors/);
    expect(ENSEMBLE_MINOR_CAST_LINE).toMatch(/never include or reference them/);
  });
});

describe("charter — life stage", () => {
  it("renders the binding register block for a band that carries rules", () => {
    const teen = buildLifeStageSection(lifeStageForAge("15"));
    expect(teen).toContain("Life stage (you are a teenager");
    expect(teen).toMatch(/overrides any conflicting style elsewhere/);
  });

  it("renders nothing for an undefined stage or a stage with no register rules", () => {
    expect(buildLifeStageSection(undefined)).toBe("");
    // A young adult carries no register rules ⇒ no block.
    expect(buildLifeStageSection(lifeStageForAge("29"))).toBe("");
  });
});

describe("charter — camera & agency", () => {
  it("addresses a named player in the second person and fixes the third-person camera", () => {
    const rule = cameraViewpointRule({ characterName: "Mara", playerName: "Theo" });
    expect(rule).toMatch(/narrate in the third person/);
    expect(rule).toContain("You are talking with Theo");
    expect(rule).toMatch(/never as "I"\/"me"/);
    expect(rule).toMatch(/only place first-person.*inside Mara's own quoted dialogue/i);
    expect(rule).not.toContain("Address the user directly");
    // No leading "2." — the caller owns the numbering.
    expect(rule.startsWith("Keep one fixed viewpoint")).toBe(true);
  });

  it("falls back to the faceless 'the user' phrasing with no player name", () => {
    const rule = cameraViewpointRule({ characterName: "Mara" });
    expect(rule).toContain('Address the user directly as "you"');
    expect(rule).toContain("The user's message is what they just said and did");
  });

  it("puts the story camera behind the player and fences off their agency (rule 4)", () => {
    const rule = narratorCameraRule({ characterName: "Mara", player: "Theo" });
    expect(rule).toContain("the story's camera sits behind Theo's eyes");
    expect(rule).toMatch(/never their deliberate actions, speech, or decisions/);
    expect(rule).toContain("those are Theo's alone to declare");
    expect(rule).toMatch(/NEVER narrate Theo doing things on your turn/);
  });

  it("teaches the perception partition with its worked mind-reading example", () => {
    const block = readingPlayerMessageBlock({ characterName: "Mara", player: "Theo" });
    expect(block).toContain("Reading the player's message (what Mara can actually perceive):");
    expect(block).toMatch(/Quoted text is speech: Mara hears exactly the words/);
    expect(block).toContain("talk to a dork like me");
    expect(block).toMatch(/mind-reading and forbidden/);
  });
});

describe("charter — attribution & notation", () => {
  it("states the mechanical [Name] tag contract", () => {
    const rule = attributionTagRule({ characterName: "Mara", player: "Theo" });
    expect(rule).toContain("[Mara]");
    expect(rule).toMatch(/attributes Mara's dialogue automatically ONLY when a line is nothing but the quote/);
    expect(rule).toContain("bracketed tags belong to Mara alone");
    expect(rule).toMatch(/never a bare quoted paragraph/);
  });

  it("scopes brackets to the line-opening tag — never around a name inside quoted speech (owner report 2026-08-02)", () => {
    const rule = attributionTagRule({ characterName: "Mara", player: "Theo" });
    expect(rule).toMatch(/Square brackets have exactly ONE use/);
    expect(rule).toContain('NEVER "It\'s good to see you, [Theo]."');
  });

  it("renders the notation legend for a named player, with the sigil grammar", () => {
    const block = messageNotationBlock({ characterName: "Mara", player: "Theo", playerName: "Theo" });
    expect(block).toContain("Message notation Theo may use");
    expect(block).toContain("*Theo: like this*");
    expect(block).toMatch(/reverse of the usual role-play habit where \*asterisks mean actions\*/);
    expect(block).toMatch(/write Mara's sent message on its own line as \*Mara: her words here\*/);
  });

  it("falls back to a 'Name' placeholder in the faceless variant", () => {
    const block = messageNotationBlock({ characterName: "Mara", player: "the user", playerName: undefined });
    expect(block).toContain("Message notation the user may use");
    expect(block).toContain("*Name: like this*");
  });
});

describe("charter — craft", () => {
  it("carries the static proportionality / topic / physical-state laws", () => {
    expect(PROPORTIONALITY_RULE).toMatch(/^React in proportion/);
    expect(PROPORTIONALITY_RULE).toContain("affection is earned, not automatic");
    expect(TOPIC_DISCIPLINE_RULE).toMatch(/^Stay in your own voice and the current topic/);
    expect(PHYSICAL_STATE_LAW_RULE).toMatch(/is behavioral law/);
  });

  it("routes a refusal and natural dialogue through the character", () => {
    expect(noRefusalRule({ characterName: "Mara" })).toMatch(/play it as Mara's own in-world choice/);
    expect(naturalDialogueRule({ characterName: "Mara" })).toMatch(/^Dialogue is speech, not prose/);
    expect(naturalDialogueRule({ characterName: "Mara" })).toContain("Keep Mara's rhythm distinct");
  });

  it("shapes each reply: resolve-then-one-move, worked example, per-shape length, freshness", () => {
    const block = shapingBlock({ characterName: "Mara", player: "Theo", shape: "concise_immersive", dominance: 0 });
    expect(block).toContain("Shaping each reply (how much to give, and how to land it):");
    expect(block).toContain("Resolve, then one move.");
    expect(block).toMatch(/AT MOST ONE forward move/);
    expect(block).toContain("What did they say when you told them?");
    // concise_immersive carries the ~3-paragraph length story…
    expect(block).toContain("about three paragraphs");
    expect(block).toContain("Freshness:");
    // …neutral dominance appends no forward-move clause.
    expect(block).not.toContain("You lead by temperament");
    expect(block).not.toContain("You defer by temperament");
  });

  it("swaps the length story per shape and appends the dominance-keyed forward-move clause", () => {
    const aggressive = shapingBlock({ characterName: "Mara", player: "Theo", shape: "aggressive_concise", dominance: 0 });
    expect(aggressive).toContain("Length follows the beat");
    expect(aggressive).not.toContain("about three paragraphs");

    const dominant = shapingBlock({ characterName: "Mara", player: "Theo", shape: "concise_immersive", dominance: 80 });
    expect(dominant).toContain("You lead by temperament");
    const submissive = shapingBlock({ characterName: "Mara", player: "Theo", shape: "concise_immersive", dominance: -80 });
    expect(submissive).toContain("You defer by temperament");
  });

  it("renders the intimate-craft block grounded in both bodies", () => {
    const block = intimateCraftBlock({ characterName: "Mara", player: "Theo" });
    expect(block).toContain("When a scene turns intimate:");
    expect(block).toContain("Hold escalation to the player's pace");
    expect(block).toContain("The sensation lands in Theo's body as much as Mara's");
    expect(block).toMatch(/No check-in refrain/);
  });
});

describe("charter — determinism", () => {
  it("renders a unit identically for the same params (pure, snapshot-safe)", () => {
    const a = cameraViewpointRule({ characterName: "Mara", playerName: "Theo" });
    const b = cameraViewpointRule({ characterName: "Mara", playerName: "Theo" });
    expect(a).toBe(b);

    const s1 = shapingBlock({ characterName: "Mara", player: "Theo", shape: "concise_immersive", dominance: 40 });
    const s2 = shapingBlock({ characterName: "Mara", player: "Theo", shape: "concise_immersive", dominance: 40 });
    expect(s1).toBe(s2);
  });
});

describe("profile-sections", () => {
  it("builds the fenced Background block, or nothing for an empty bio", () => {
    const section = buildBioSection("A harbor-town glassblower with salt in her hair.");
    expect(section).toContain("Background:");
    expect(section).toContain("A harbor-town glassblower with salt in her hair.");
    expect(buildBioSection("   ")).toBe("");
  });

  it("excerpts long text with an ellipsis and collapses whitespace", () => {
    expect(excerpt("a  b\n\tc", 100)).toBe("a b c");
    const long = "x".repeat(700);
    const cut = excerpt(long, 600);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThan(long.length);
  });

  it("renders authored voice anchors, or nothing when none are set", () => {
    const anchors: VoiceAnchors = { petPhrases: ["no promises"], cadence: "clipped and dry", neverSays: ["babe"] };
    const section = buildVoiceAnchorsSection(anchors);
    expect(section).toContain("Turns of phrase you actually use: no promises.");
    expect(section).toContain("Rhythm and cadence: clipped and dry.");
    expect(section).toContain("You never say (off-limits for you): babe.");
    expect(buildVoiceAnchorsSection({ petPhrases: [], cadence: "", neverSays: [] })).toBe("");
  });

  it("renders micro-exemplars as situation → line few-shots, skipping empty rows", () => {
    const rows: MicroExemplar[] = [
      { situation: "pushed to talk about her past", line: "She just looks at you until you change the subject." },
      { situation: "", line: "" },
    ];
    const section = buildMicroExemplarsSection(rows);
    expect(section).toContain("pushed to talk about her past → She just looks at you");
    expect(buildMicroExemplarsSection([{ situation: "", line: "  " }])).toBe("");
  });
});
