import { describe, expect, it } from "vitest";
import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import type { ChatDrive } from "@/contracts/personality/drives";
import type { RelationshipRecord } from "@/contracts/relationships/record";
import { attr, drive, expectNumberedRule, expectOrder, maraProfile, promptSection } from "@/server/test-support";
import { deriveChatSensoryAllowance, detectChatCue, detectSensoryFocus } from "../chat-intent";
import {
  buildCharacterChatPromptParts,
  buildCharacterChatSystemPrompt,
  buildChatPromptPartsForRoster,
  buildChatTurnMessage,
  chatCallbackLine,
  chatNotationNote,
  chatSelfieLine,
  ENSEMBLE_QUIET_EXCHANGES,
  ensembleQuietThreshold,
  wrapNarratorInput,
  type CharacterChatPromptInput,
  type EnsembleMemberInput,
} from "./character-chat";

// ---------------------------------------------------------------------------
// The file's default subject: Mara, her seeded sheet, and a blank live state.
// Every wrapper takes the same `over` shape as the builder it fronts, so a case
// that needs one field different states only that field.
// ---------------------------------------------------------------------------

/** The live-state block: three fields repeated verbatim in ~34 cases. */
type ChatPromptState = NonNullable<CharacterChatPromptInput["state"]>;
const chatState = (over: Partial<ChatPromptState> = {}): ChatPromptState => ({
  meters: {},
  regard: 0,
  conditions: [],
  ...over,
});

/** `buildCharacterChatSystemPrompt` over Mara's seeded sheet. */
const systemPrompt = (over: Partial<CharacterChatPromptInput> = {}): string =>
  buildCharacterChatSystemPrompt({ name: "Mara", profile: maraProfile(), ...over });

/** The same defaults through the split prefix/tail builder. */
const promptParts = (over: Partial<CharacterChatPromptInput> = {}): ReturnType<typeof buildCharacterChatPromptParts> =>
  buildCharacterChatPromptParts({ name: "Mara", profile: maraProfile(), ...over });

/** One ensemble roster member — Mara's sheet unless the case supplies another. */
const member = (name: string, over: Partial<EnsembleMemberInput> = {}): EnsembleMemberInput => ({
  name,
  profile: maraProfile(),
  presence: "present",
  quietExchanges: 0,
  ...over,
});

/** The single-character input the roster dispatch is compared against. */
const input = (over: Partial<CharacterChatPromptInput> = {}): CharacterChatPromptInput => ({
  name: "Mara",
  profile: maraProfile(),
  player: { name: "Brian" },
  ...over,
});

describe("buildCharacterChatSystemPrompt", () => {
  it("embodies the named character and surfaces identity, personality, and voice", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("You are Mara");
    // Identity block carries the real age (profile field), not the apparent-age attribute.
    expect(prompt).toContain("You are 29 years old.");
    expect(prompt).not.toContain("late twenties");
    expect(prompt).toContain("Wry, guarded, fiercely loyal");
    expect(prompt).toContain("Low and dry, with a coastal lilt.");
    expect(prompt).toContain("A harbor-town glassblower");
  });

  it("renders resolved attribute values, never raw ids", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("auburn");
    expect(prompt).not.toContain("hair.color");
    expect(prompt).not.toContain("voice.pitch");
  });

  it("includes registry promptHints as deduped phrasing guidance", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("Phrasing guidance:");
  });

  it("surfaces the authored personality sliders as a binding Disposition block", () => {
    const prompt = systemPrompt({
      profile: maraProfile({
        traits: [
          { id: "temperament.warmth", value: -70, source: "creation" },
          { id: "social.guardedness", value: 80, source: "creation" },
          { id: "intimate.libido", value: 80, source: "creation" },
        ],
      }),
    });
    // The everyday sliders surface as bands…
    expect(prompt).toContain("Disposition (your standing temperament");
    expect(prompt).toContain("Warmth: cold");
    expect(prompt).toContain("Guardedness: guarded");
    // …intimate sliders only behind the intimate framing…
    expect(prompt).toContain("When the moment turns intimate");
    expect(prompt).toContain("Libido: high");
    // …and the rule makes them behaviorally binding, not flavor.
    expect(prompt).toContain("behavioral law");
    expect(prompt).toContain("Speak and act your age");
  });

  it("omits the Disposition block when no sliders are authored", () => {
    const prompt = systemPrompt({ profile: maraProfile({ traits: [] }) });
    expect(prompt).not.toContain("Disposition (your standing temperament");
  });

  it("carries the in-character + dialogue-tag rules", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("Stay fully in character as Mara");
    expect(prompt).toContain('[Mara]');
    expect(prompt).toMatch(/never mention being an AI/i);
  });

  it("states the mechanical attribution contract: whole-line quotes auto-attribute, mixed lines tag or split", () => {
    const prompt = systemPrompt();
    // Dialogue still goes in quotes, and the auto-attribution path is stated as mechanical…
    expect(prompt).toMatch(/spoken dialogue always goes in quotes/i);
    expect(prompt).toMatch(/attributes Mara's dialogue automatically ONLY when a line is nothing but the quote/i);
    // …a line mixing speech with a beat must open with the tag (or split into separate lines)…
    expect(prompt).toMatch(/open that line with the \[Mara\] tag/);
    expect(prompt).toMatch(/the quote on its own line, the beat as its own prose line/);
    // …and the old "start EVERY line with the tag" mandate is still gone.
    expect(prompt).not.toContain("Start every line of Mara's spoken dialogue with the tag");
  });

  it("licenses other people to speak in narration prose, reserving bracketed tags for the character", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/Other people in the scene/i);
    // 2026-07-11 tightening (the Amanda report): their lines need in-prose attribution,
    // never a bare quoted paragraph, and a tagged reply must tag every character line.
    expect(prompt).toMatch(/never a bare quoted paragraph/i);
    expect(prompt).toContain("tag every one of Mara's spoken lines");
    expect(prompt).toContain("bracketed tags belong to Mara alone");
  });

  it("forbids advancing the player's story and follows the character when they're apart (owner ruling 2026-07-10)", () => {
    const prompt = systemPrompt({ player: { name: "Theo" } });
    // Rule 4's hard arm: the player's story moves only through their own messages.
    expect(prompt).toContain("Theo's story advances ONLY through their own messages");
    expect(prompt).toMatch(/NEVER narrate Theo doing things on your turn/);
    expect(prompt).toContain("arriving home, checking a phone");
    // Rule 16, the separation arm: the reply follows the character's side of the split.
    expect(prompt).toContain("When Mara and Theo are not in the same place");
    expect(prompt).toContain("your reply follows Mara and ONLY Mara");
    expect(prompt).toMatch(/Never narrate Theo's side of the separation/);
    // Apart, she reaches him only through comms — the texted-reply output grammar.
    expect(prompt).toContain("a text on its own line as *Mara: her words here*");
  });

  it("fixes a third-person viewpoint: character in third person, player as 'you', first person only in quotes", () => {
    const withPlayer = systemPrompt({ player: { name: "Theo" } });
    // Narration is third person for the character…
    expect(withPlayer).toMatch(/narrate in the third person/i);
    expect(withPlayer).not.toContain("Speak in the first person");
    // …the player is always second person, never first/third…
    expect(withPlayer).toMatch(/never as "I"\/"me"/);
    // …and the only first-person license is inside the character's quoted dialogue.
    expect(withPlayer).toMatch(/only place first-person.*may appear is inside Mara's own quoted dialogue/i);
    // The prose example is third-person, not "I lean…".
    expect(withPlayer).toContain("Mara leans against the doorframe");

    // The faceless (no-player) variant keeps the same viewpoint discipline.
    const faceless = systemPrompt();
    expect(faceless).toMatch(/narrate in the third person/i);
    expect(faceless).toMatch(/never as "I"\/"me"/);
  });

  it("grants the mature-content license the sessionless chat otherwise lacks", () => {
    // The session engine licenses explicit content via world directives + exposure
    // rules; the chat carries neither, so the prompt must state the frame itself or
    // safety-aligned narrators refuse and break character. See character-chat.ts.
    const prompt = systemPrompt();
    expect(prompt).toMatch(/adult interactive fiction/i);
    expect(prompt).toMatch(/sexually explicit content (are|is) fully in scope/i);
  });

  it("forbids breaking character to refuse, and routes a 'no' through the character", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/never break character to refuse/i);
    expect(prompt).toMatch(/play it as Mara's own in-world choice/i);
  });

  it("adopts the shape profiles, replacing the fixed paragraph target", () => {
    const prompt = systemPrompt();
    expect(prompt).not.toContain("one or two short paragraphs");
    // The default (concise_immersive) profile drives chat length too.
    expect(prompt).toContain("Write one focused beat per turn");
  });

  it("makes the aggressive_concise shape selectable in chat and distinct", () => {
    const aggressive = systemPrompt({ narrationShape: "aggressive_concise" });
    const concise = systemPrompt({ narrationShape: "concise_immersive" });
    expect(aggressive).toContain("Be brief and tightly scoped");
    expect(aggressive).not.toContain("Write one focused beat per turn");
    expect(aggressive).not.toBe(concise);
  });

  it("carries the proportionate-reaction + stay-in-voice chat rules", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("React in proportion");
    expect(prompt).toContain("affection is earned, not automatic");
    expect(prompt).toContain("Stay in your own voice and the current topic");
  });

  it("introduces no hard length cap in the chat lane for either shape profile", () => {
    const cap = /\d+\s+(characters|tokens|words|lines|sentences|paragraphs)/;
    expect(systemPrompt({ narrationShape: "concise_immersive" })).not.toMatch(cap);
    expect(systemPrompt({ narrationShape: "aggressive_concise" })).not.toMatch(cap);
  });

  it("skips unknown attribute vocabulary instead of leaking it", () => {
    const prompt = systemPrompt({
      profile: maraProfile({ attributes: [attr("identity.gender", "female"), attr("face.nonexistent_trait", "whatever")] }),
    });
    expect(prompt).not.toContain("nonexistent");
    expect(prompt).not.toContain("face.nonexistent_trait");
  });

  it("falls back gracefully for an empty profile", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "", profile: emptyCharacterProfile() });
    expect(prompt).toContain("this character");
    expect(prompt).toContain("How to respond:");
  });

  it("surfaces a prior summary as a continuity-context block, in the volatile tail", () => {
    const recap = "You met at the night market and traded names. Established:\n- The user is Theo.";
    const prompt = systemPrompt({ priorSummary: recap });
    expect(prompt).toContain("Earlier in this conversation");
    expect(prompt).toContain("The user is Theo.");
    // The recap changes as the summary folds, so it rides the volatile tail BELOW the
    // stable rules (spec §9 prompt-cache layout).
    expectOrder(prompt, ["How to respond:", "Earlier in this conversation"]);
  });

  it("omits the recap block entirely when there is no prior summary (prompt unchanged)", () => {
    expect(systemPrompt()).not.toContain(
      "Earlier in this conversation",
    );
    expect(systemPrompt({ priorSummary: "   " })).not.toContain(
      "Earlier in this conversation",
    );
  });

  it("surfaces retrieved RAG memory (facts + episodes) as a recall block (spec §2)", () => {
    const prompt = systemPrompt({
      memory: {
        facts: ["The player's sister is getting married in Prague."],
        episodes: ["They argued about the harbor job, then made up."],
      },
    });
    expect(prompt).toContain("Your memory");
    expect(prompt).toContain("The player's sister is getting married in Prague.");
    expect(prompt).toContain("They argued about the harbor job, then made up.");
    // Recall is per-turn volatile, so it rides the tail below the stable rules (spec §9).
    expectOrder(prompt, ["How to respond:", "Your memory"]);
  });

  it("omits the memory block when nothing was retrieved (prompt unchanged)", () => {
    expect(systemPrompt()).not.toContain("Your memory");
    expect(
      systemPrompt({ memory: { facts: [], episodes: [] } }),
    ).not.toContain("Your memory");
  });

  it("resolves a persisted narrative attribute overlay on top of the authored base (spec §3)", () => {
    // The authored base is `creation`-sourced (hair.color: auburn); a `narrative` overlay
    // outranks it (SOURCE_PRECEDENCE narrative > creation), exactly as the session lane.
    const overlaid = systemPrompt({
      state: {
        meters: {},
        regard: 0,
        conditions: [],
        attributeOverlays: [{ id: "hair.color", value: "silver", source: "narrative" }],
      },
    });
    expect(overlaid).toContain("silver");
    expect(overlaid).not.toContain("auburn");
  });

  it("addresses the player by name and surfaces their persona when a player is given", () => {
    const prompt = systemPrompt({
      player: { name: "Theo", persona: "A traveling cartographer, easy to talk to." },
    });
    expect(prompt).toContain("speaking with Theo");
    expect(prompt).toContain("About Theo (the person you're speaking with)");
    expect(prompt).toContain("A traveling cartographer");
    expect(prompt).toContain("talking with Theo");
    expect(prompt).not.toContain("speaking with the user");
  });

  it("uses the player name without a persona block when no bio is given", () => {
    const prompt = systemPrompt({ player: { name: "Theo" } });
    expect(prompt).toContain("speaking with Theo");
    expect(prompt).not.toContain("the person you're speaking with");
  });

  it("keeps the faceless 'the user' phrasing when no player is given (prompt unchanged)", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("speaking with the user");
    expect(prompt).toContain('Address the user directly as "you"');
  });

  it("is byte-identical when the state block is absent (existing behavior)", () => {
    const withoutState = systemPrompt();
    // An empty state (rested, neutral, no premise) adds nothing notable.
    const withEmptyState = systemPrompt({
      state: chatState(),
    });
    expect(withEmptyState).toBe(withoutState);
    expect(withoutState).not.toContain("Your current state");
    expect(withoutState).not.toContain("Scenario for this chat");
  });

  it("renders mood + mindNote in the Current state block; the regard steer is the composed Relationship block (§7.1)", () => {
    const prompt = systemPrompt({
      state: {
        meters: { mood: 0.8, energy: 0.8, hygiene: 0.9, stress: 0.1 },
        regard: 57, // warm
        familiarity: 42, // acquainted
        conditions: [],
        mindNote: "She's glad he came back.",
      },
    });
    expect(prompt).toContain("Your current state");
    expect(prompt).toContain("bright and playful");
    expect(prompt).toContain("She's glad he came back.");
    // The old one-line warmth hint is superseded by the composed relationship block,
    // which names both axis bands and states the regard-keyed escalation floor.
    expect(prompt).toContain("Relationship with the user");
    expect(prompt).toContain("- Regard (warm): ");
    expect(prompt).toContain("- Familiarity (acquainted): ");
    expect(prompt).toContain("the first move is often yours");
    // State is per-turn volatile, so it rides the tail below the stable rules (spec §9).
    expectOrder(prompt, ["How to respond:", "Your current state"]);
  });

  it("surfaces a crossed meter threshold (drift made visible)", () => {
    const prompt = systemPrompt({
      state: { meters: { ...{ hygiene: 0.2 }, mood: 0.5, energy: 0.9 }, regard: 0, conditions: [] },
    });
    expect(prompt).toMatch(/unwashed/i);
  });

  it("renders the premise as a prominent scenario block, above the response rules; empty ⇒ no block", () => {
    const prompt = systemPrompt({
      state: chatState({ premise: "It's the night before she moves away forever." }),
    });
    expect(prompt).toContain("Scenario for this chat");
    expect(prompt).toContain("the night before she moves away");
    expectOrder(prompt, ["Scenario for this chat", "How to respond:"]);

    const noPremise = systemPrompt({
      state: chatState({ premise: "   " }),
    });
    expect(noPremise).not.toContain("Scenario for this chat");
  });

  it("adds an opening-beat instruction only when opening is set", () => {
    const opening = systemPrompt({ opening: true });
    expect(opening).toMatch(/Opening beat/);
    expect(opening).toMatch(/Begin the conversation yourself/);
    expect(systemPrompt()).not.toContain("Opening beat");
  });

  // --- Opportunistic sensory cues (character-chat-sensory.plan.md) ---

  it("surfaces presentation.scent_baseline as a closeness-gated Sensory cues block, not a flat attribute line", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Sabrina",
      profile: maraProfile({
        attributes: [
          attr("identity.gender", "female"),
          attr("hair.color", "auburn"),
          attr("presentation.scent_baseline", "soft floral perfume"),
        ],
      }),
    });
    expect(prompt).toContain("Sensory cues");
    expect(prompt).toContain("soft floral perfume");
    // The scent value lives only in the cue block — not also as a flat Attributes line.
    expect(prompt.split("soft floral perfume")).toHaveLength(2);
    expectOrder(prompt, ["Sensory cues", "soft floral perfume"]);
    // Ordinary physical attributes still render in Attributes as before.
    expect(prompt).toContain("auburn");
    // The exposure-mask phrasing hint (meaningless without a chat exposure mask) is dropped.
    expect(prompt).not.toContain("exposure mask's scent range");
  });

  it("states the restraint discipline: cues are reference data, spent only through the per-turn allowance", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Sabrina",
      profile: maraProfile({ attributes: [attr("presentation.scent_baseline", "soft floral perfume")] }),
    });
    expect(prompt).toMatch(/use only when the beat earns them/i);
    // The when-it's-earned teaching now defers to the deterministic Sensory-allowance line
    // (narrator-prompt-consolidation slice 4) instead of restating the conditions in prose.
    expect(prompt).toMatch(/only when the current-turn Sensory allowance grants a cue/i);
    expect(prompt).toMatch(/never\s+recited as a label: value/i);
    expect(prompt).toMatch(/never forced into ordinary, distant conversation/i);
    // Never a checklist / mandatory.
    expect(prompt).not.toMatch(/always (mention|include|describe|note)[^.]{0,24}(scent|smell)/i);
  });

  it("keeps voice (audible at distance) and physical attributes in Attributes, never the sensory cues", () => {
    const prompt = systemPrompt({
      profile: maraProfile({
        attributes: [
          attr("hair.color", "auburn"),
          attr("voice.pitch", "low"),
          attr("presentation.scent_baseline", "soft floral perfume"),
        ],
      }),
    });
    // Voice is sensory but perceptible at any distance — it stays a normal attribute line.
    expect(prompt).toContain("pitch: low");
    // Scoped to the cue block itself — "pitch is not here" is only meaningful inside it.
    const cueBlock = promptSection(prompt, "Sensory cues", "\n\n");
    expect(cueBlock).toContain("soft floral perfume");
    expect(cueBlock).not.toContain("pitch");
  });

  it("does not promote intimate scent/taste into ordinary chat sensory cues", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Sabrina",
      profile: maraProfile({
        intimateRegions: ["vulva"],
        attributes: [
          attr("presentation.scent_baseline", "soft floral perfume"),
          attr("vulva.scent", "INTIMATE_SCENT_SENTINEL"),
        ],
      }),
    });
    // The everyday scent still surfaces…
    expect(prompt).toContain("Sensory cues");
    expect(prompt).toContain("soft floral perfume");
    // …but the intimate one reaches the chat nowhere — not the cue block, not the flat list.
    expect(prompt).not.toContain("INTIMATE_SCENT_SENTINEL");
    expect(prompt).not.toMatch(/vulva scent/i);
  });

  it("omits the Sensory cues block entirely when no proximity sense is authored (prompt unchanged)", () => {
    expect(systemPrompt()).not.toContain("Sensory cues");
  });
});

describe('buildCharacterChatSystemPrompt — prompt-side "none" elision', () => {
  it('drops a "none" attribute line — "nose piercings: none" invites the narrator to riff on the piercing', () => {
    const prompt = systemPrompt({
      profile: maraProfile({ attributes: [attr("nose.piercings", "none"), attr("hair.color", "red")] }),
    });
    expect(prompt).toContain("hair color: red");
    expect(prompt).not.toMatch(/nose piercings/i);
    // Control: a real value still renders.
    const pierced = systemPrompt({
      profile: maraProfile({ attributes: [attr("nose.piercings", "septum")] }),
    });
    expect(pierced).toContain("nose piercings: septum");
  });

  it("keeps a flagged none with its gloss — there the absence is the fact (renderNoneInPrompts)", () => {
    const prompt = systemPrompt({
      profile: maraProfile({
        intimateRegions: ["vulva"],
        attributes: [attr("vulva.pubic_hair_density", "none")],
      }),
    });
    expect(prompt).toContain("pubic hair density: none (fully bare — no hair at all)");
  });
});

describe("buildCharacterChatSystemPrompt — player-input perception (player-input-perception.plan.md slice 1)", () => {
  const prompt = systemPrompt({ player: { name: "Theo" } });

  it("teaches the perception partition: quoted = heard, narration = seen, interiority = invisible", () => {
    expect(prompt).toContain("Reading the player's message (what Mara can actually perceive):");
    expect(prompt).toMatch(/Quoted text is speech: Mara hears exactly the words inside the quotes/);
    expect(prompt).toMatch(/Unquoted text is the story's narration/);
    expect(prompt).toMatch(/Inner thoughts, feelings, and self-talk Theo writes into that narration reach no one/);
    expect(prompt).toMatch(/must not answer, echo, or uncannily intuit/);
  });

  it("licenses reacting to visible correlates and wrong guesses (perceptiveness, not telepathy)", () => {
    expect(prompt).toMatch(/notice the visible signs \(a flush, a hesitation\)/);
    expect(prompt).toMatch(/even guess wrong/);
  });

  it("degrades gracefully: a casual unquoted message is still speech, never silence", () => {
    expect(prompt).toMatch(/no quotes at all that reads as plain conversation is simply spoken aloud/);
    expect(prompt).toMatch(/never treat a casual unquoted message as silence/);
  });

  it("carries the worked mind-reading example with the correct read spelled out", () => {
    expect(prompt).toContain("There's no way Mara would want to talk to a dork like me.");
    expect(prompt).toMatch(/answering the thought itself \("You're not a dork!"\) is mind-reading and forbidden/);
  });

  it("routes rule 2 and the respond-first rule through what the character heard and saw", () => {
    expect(prompt).toMatch(/react to what Mara could actually hear and see in it/);
    // The respond-first teaching lives in the Shaping block's "Resolve, then one move"
    // bullet, which absorbed the duplicate rule 8 (chat-agent-improvements slice 5).
    expect(prompt).toContain("FIRST answer what Mara just heard and saw");
    expect(prompt).not.toContain("Respond directly to what Mara just heard and saw");
    // The old everything-is-said-at-you framing is gone.
    expect(prompt).not.toContain("said or did to Mara — react to it");
  });

  it("keeps the partition in the faceless (no-player) variant too", () => {
    const faceless = systemPrompt();
    expect(faceless).toContain("Reading the player's message (what Mara can actually perceive):");
    expect(faceless).toMatch(/self-talk the user writes into that narration reach no one/);
  });
});

describe("buildCharacterChatSystemPrompt — message-notation legend (player-input-perception.plan.md slice 4)", () => {
  const prompt = systemPrompt({ player: { name: "Theo" } });

  it("teaches the sigil grammar: quotes, asterisks (thought default), underscores, double parens", () => {
    expect(prompt).toMatch(/Message notation Theo may use/);
    expect(prompt).toMatch(/"Quoted text" is spoken dialogue/);
    expect(prompt).toMatch(/single asterisks\* is Theo's private thought by default/);
    expect(prompt).toMatch(/name and a colon — \*Theo: like this\* — it is a text message/);
    expect(prompt).toMatch(/single underscores_ is only italic emphasis/);
    expect(prompt).toMatch(/\(\(Text in double parentheses\)\) is Theo speaking to you as the storyteller/);
    expect(prompt).toMatch(/A single \( … \) is ordinary prose/);
  });

  it("states the house reversal of the RP 'asterisks = actions' convention", () => {
    expect(prompt).toMatch(/reverse of the usual role-play habit where \*asterisks mean actions\*/);
    expect(prompt).toMatch(/plain unquoted prose is already the action channel/);
    expect(prompt).toMatch(/an asterisk span is thought or a text, never an action/);
  });

  it("defines the comms output grammar the parser round-trips (*Name: her words*)", () => {
    expect(prompt).toMatch(/write Mara's sent message on its own line as \*Mara: her words here\*/);
  });

  it("teaches the narrator's own-output emphasis convention: underscores, never asterisk-emphasis", () => {
    expect(prompt).toMatch(/In your own replies, write emphasis with _underscores_/);
    expect(prompt).toMatch(/never with single asterisks/);
  });

  it("lives in the stable prefix and stays byte-identical across turns (cache-safe)", () => {
    const t1 = promptParts({
      player: { name: "Theo" },
      state: { meters: { mood: 0.9 }, regard: 20, conditions: [] },
    });
    const t2 = promptParts({
      player: { name: "Theo" },
      state: { meters: { mood: 0.1 }, regard: 22, conditions: [], mindNote: "different" },
    });
    expect(t1.prefix).toContain("Message notation Theo may use");
    expect(t1.prefix).toBe(t2.prefix);
  });

  it("falls back to a 'Name' placeholder in the faceless (no-player) variant", () => {
    const faceless = systemPrompt();
    expect(faceless).toMatch(/Message notation the user may use/);
    expect(faceless).toMatch(/\*Name: like this\*/);
  });
});

describe("chatNotationNote — derived-fact tail note (player-input-perception.plan.md slice 4)", () => {
  it("renders a comms note (sender/recipient + co-presence reconciliation) for a *Name: …* message", () => {
    const note = chatNotationNote("*Brian: hey, you up?*", { name: "Sabrina", player: "Brian", knownNames: ["Sabrina"] });
    expect(note).toMatch(/Brian is texting you/);
    expect(note).toMatch(/text message from Brian to you, not words spoken in the room/);
    expect(note).toMatch(/not face-to-face for this beat — the comms frame temporarily overrides any assumed co-presence/);
    // It points back at the output grammar so her reply comes back as a text.
    expect(note).toContain("*Sabrina: …*");
  });

  it("renders a comms note for the explicit `to Name:` form too", () => {
    const note = chatNotationNote("*to Sabrina: on my way*", { name: "Sabrina", player: "Brian", knownNames: ["Sabrina"] });
    expect(note).toMatch(/Brian is texting you/);
  });

  it("renders an OOC note honoring the direction while keeping it unheard", () => {
    const note = chatNotationNote("((skip ahead to the evening))", { name: "Sabrina", player: "Brian" });
    expect(note).toMatch(/double-parenthesized \(\(…\)\) text is Brian speaking to you as the storyteller/);
    expect(note).toMatch(/never have Sabrina \(or anyone in the scene\) hear it or react to it/);
  });

  it("returns '' for a plain message with no comms or OOC spans (the common case)", () => {
    expect(chatNotationNote('"Hey there." I wave.', { name: "Sabrina", player: "Brian" })).toBe("");
    expect(chatNotationNote("I sit down (still catching my breath).", { name: "Sabrina", player: "Brian" })).toBe("");
    expect(chatNotationNote("*I hope she doesn't notice how nervous I am.*", { name: "Sabrina", player: "Brian" })).toBe("");
  });

  it("rides the volatile tail, never the cached prefix", () => {
    const note = chatNotationNote("*Brian: hey*", { name: "Mara", player: "Theo", knownNames: ["Mara"] });
    const withNote = promptParts({
      player: { name: "Theo" },
      notationNote: note,
    });
    const without = promptParts({ player: { name: "Theo" } });
    expect(withNote.prefix).toBe(without.prefix); // derived note never busts the prefix cache
    expect(withNote.tail).toContain("is texting you");
    expect(without.tail).not.toContain("is texting you");
  });
});

describe("buildCharacterChatSystemPrompt — player-POV narration (chat-narrator-pov.plan.md)", () => {
  const withPlayer = systemPrompt({ player: { name: "Theo" } });
  const faceless = systemPrompt();

  it("names the narrator role: the story's camera sits behind the player's eyes", () => {
    expect(withPlayer).toContain("the story's camera sits behind Theo's eyes");
    expect(withPlayer).toContain("You catch the scent of cedar as Mara leans past you.");
    expect(faceless).toContain("the story's camera sits behind the user's eyes");
  });

  it("draws the player-body boundary: involuntary perception + light reflex in; actions, speech, emotions out", () => {
    expect(withPlayer).toMatch(/involuntary perception and the small reflexes it stirs \(a breath that catches, a shiver\)/);
    expect(withPlayer).toMatch(/never their deliberate actions, speech, or decisions/);
    expect(withPlayer).toMatch(/never name their emotions or arousal for them/);
    expect(withPlayer).toContain("those are Theo's alone to declare");
  });

  it("adds the motion-gated visual rule (show, don't inventory) deferring to the allowance", () => {
    expect(withPlayer).toContain("Show, don't inventory");
    expect(withPlayer).toMatch(/one concrete visual detail from Theo's eye/);
    // Attention-driven visual detail moved behind the per-turn Sensory-allowance line
    // (narrator-prompt-consolidation slice 4); the rule keeps only the self-motion arm.
    expect(withPlayer).toMatch(/follows the Sensory allowance line/);
    expect(withPlayer).toMatch(/Never a head-to-toe description, never a detail repeated for an unchanged look/);
  });

  it("reframes Attributes as shared identity + appearance data", () => {
    expect(withPlayer).toContain("Attributes (who you are, and what Theo sees of you");
    expect(faceless).toContain("Attributes (who you are, and what the user sees of you");
  });

  it("words the closeness sensory rule as sensation landing in the player's senses", () => {
    expect(withPlayer).toMatch(/written as it arrives in Theo's senses \(the scent that reaches them, the warmth they feel\)/);
  });

  it("invites showing the outfit when movement or attention makes it noticeable", () => {
    const prompt = systemPrompt({
      state: chatState({ outfit: "a slate-blue dress with a slit up one side" }),
    });
    expect(prompt).toContain("You're wearing a slate-blue dress with a slit up one side.");
    expect(prompt).toMatch(/Let it show: when movement or the player's attention makes it noticeable/);
  });

  it("grounds intimate sensation in the player's body too", () => {
    expect(withPlayer).toContain("The sensation lands in Theo's body as much as Mara's");
    expect(faceless).toContain("The sensation lands in the user's body as much as Mara's");
  });

  it("keeps the restraint discipline: no always-describe mandate anywhere", () => {
    expect(withPlayer).not.toMatch(/always (mention|include|describe|note|add)/i);
    expect(withPlayer).not.toMatch(/every (turn|reply|response)[^.]{0,40}(describe|detail|sensory|visual)/i);
  });
});

describe("buildCharacterChatSystemPrompt — state as a narration system", () => {
  const drunkMeters = { meters: { intoxication: 0.8 }, regard: 0, conditions: [] };

  it("foregrounds a newly-crossed meter band as a one-time 'just shifting' beat", () => {
    const prompt = systemPrompt({ state: drunkMeters });
    expect(prompt).toContain("Right now this is shifting");
    expect(prompt).toContain("Drunk:"); // the intoxication >0.7 threshold hint
  });

  it("does not re-foreground a band already surfaced last turn — it rides as standing coloring", () => {
    const prompt = systemPrompt({
      state: { ...drunkMeters, surfacedCues: { intoxication: "intoxication:0.7" } },
    });
    expect(prompt).not.toContain("Right now this is shifting");
    expect(prompt).toContain("Your current state");
    expect(prompt).toContain("Drunk:"); // still colors, just not re-announced
  });

  it("overlays an active condition's attributeEffects onto the attributes (grooming → unkempt)", () => {
    const prompt = systemPrompt({
      state: {
        meters: {},
        regard: 0,
        conditions: [
          {
            id: "c1",
            label: "disheveled",
            startedAtMinutes: 0,
            attributeEffects: [{ attributeId: "presentation.grooming", value: "unkempt" }],
          },
        ],
      },
    });
    expect(prompt).toContain("unkempt");
  });

  it("never lets a condition rewrite an inherent attribute (eye colour) in the prompt", () => {
    const prompt = systemPrompt({
      profile: maraProfile({ attributes: [attr("eyes.color", "grey")] }),
      state: {
        meters: {},
        regard: 0,
        conditions: [
          { id: "c1", label: "x", startedAtMinutes: 0, attributeEffects: [{ attributeId: "eyes.color", value: "crimson" }] },
        ],
      },
    });
    expect(prompt).toContain("grey");
    expect(prompt).not.toContain("crimson");
  });

  it("surfaces social cards as soft framing without the mechanical severity number", () => {
    const prompt = systemPrompt({
      state: {
        meters: {},
        regard: 0,
        conditions: [],
        activeSocialCards: [
          {
            id: "k1",
            label: "No flirting in public",
            description: "Keep it private.",
            kind: "taboo",
            triggers: [],
            severity: 80,
            reactionOverrides: [],
          },
        ],
      },
    });
    expect(prompt).toContain("What you care about");
    expect(prompt).toContain("No flirting in public");
    expect(prompt).not.toContain("80");
  });

  it("relaxes the disposition when intoxicated (render-time disinhibition only)", () => {
    const traits = [{ id: "social.guardedness", value: 90, source: "creation" as const }];
    const sober = systemPrompt({
      profile: maraProfile({ traits }),
      state: { meters: { intoxication: 0 }, regard: 0, conditions: [] },
    });
    const drunk = systemPrompt({
      profile: maraProfile({ traits }),
      state: { meters: { intoxication: 0.9 }, regard: 0, conditions: [] },
    });
    expect(sober).toContain("Disposition");
    expect(drunk).toContain("Disposition");
    expect(drunk).not.toEqual(sober); // the guardedness band reads lower when drunk
  });
});

describe("buildCharacterChatPromptParts — prompt-cache layout (spec §9)", () => {
  it("keeps the prefix byte-identical across consecutive turns with unchanged authored inputs", () => {
    const turn1 = promptParts({
      priorSummary: "You met at the night market.",
      memory: { facts: ["The player fears heights."], episodes: [] },
      state: {
        meters: { mood: 0.9, intoxication: 0.8 },
        regard: 57,
        conditions: [],
        mindNote: "Glad he came back.",
        premise: "A rainy evening at the glassworks.",
      },
      cueInvite: "He is close enough to touch — a sensory cue may land this turn.",
    });
    const turn2 = promptParts({
      priorSummary: "You met at the night market. Then you argued about the harbor job.",
      memory: { facts: [], episodes: ["They argued about the harbor job."] },
      state: {
        meters: { mood: 0.1, intoxication: 0 },
        regard: 60, // 57 → 60: moved, but still the same "warm" stage band
        conditions: [],
        mindNote: "Stung by the argument.",
        premise: "A rainy evening at the glassworks.",
      },
    });
    expect(turn1.prefix).toBe(turn2.prefix);
    expect(turn1.tail).not.toBe(turn2.tail);
  });

  it("re-renders the prefix only on a band crossing — either axis (the composed block is band-keyed — §7.1/§9)", () => {
    const at = (regard: number, familiarity = 0) =>
      promptParts({
        state: { meters: {}, regard, familiarity, conditions: [] },
      });
    expect(at(50).prefix).toBe(at(64).prefix); // both "warm" — cache holds
    expect(at(50).prefix).not.toBe(at(65).prefix); // warm → close — law block re-renders
    expect(at(65).prefix).toContain("Relationship with the user");
    expect(at(65).prefix).toContain("full intimacy"); // the close-band escalation floor
    // The knowledge axis re-renders the prefix on ITS band crossings too…
    expect(at(50, 30).prefix).toBe(at(50, 54).prefix); // both "acquainted"
    expect(at(50, 54).prefix).not.toBe(at(50, 55).prefix); // acquainted → familiar
  });

  it("renders the authored texture: history line, mask, and the corner note (relationship-model v2)", () => {
    const parts = promptParts({
      player: { name: "Daniel" },
      state: {
        meters: {},
        regard: -25, // cool
        familiarity: 90, // deeply known
        relationship: {
          kind: "estranged childhood friends",
          history: "he left town without a word; you rebuilt alone",
          presented: { lean: "masks_warmth", note: "icily civil" },
          looming: false,
        },
        conditions: [],
      },
    });
    expect(parts.prefix).toContain("Relationship with Daniel");
    expect(parts.prefix).toContain("- History: estranged childhood friends. he left town without a word");
    expect(parts.prefix).toContain("you perform colder toward Daniel than you feel");
    expect(parts.prefix).toContain("Familiarity is not warmth"); // deeply_known × cool corner
    expect(parts.prefix).toContain("deflect as Mara would");
  });

  it("emits the disposition-contrast line only when regard's sign disagrees with the authored warmth lean", () => {
    const curt = maraProfile({ traits: [{ id: "temperament.warmth", value: -60, source: "base" as const }] });
    const at = (p: CharacterProfile, regard: number) =>
      promptParts({
        profile: p,
        state: { meters: {}, regard, conditions: [] },
      }).prefix;
    expect(at(curt, 57)).toContain("one of the few exceptions"); // curt generally, warm to YOU
    expect(at(curt, -25)).not.toContain("one of the few exceptions"); // signs agree — no line
    expect(at(maraProfile(), 57)).not.toContain("one of the few exceptions"); // no authored lean — no line
  });

  it("adds the idiom line at warm+ regard so a cold character keeps their manner (slice 3)", () => {
    const cold = maraProfile({ traits: [{ id: "temperament.warmth", value: -60, source: "base" as const }] });
    const at = (regard: number) =>
      promptParts({ profile: cold, state: { meters: {}, regard, conditions: [] } }).prefix;
    expect(at(60)).toContain("you express it in your OWN manner");
    expect(at(20)).not.toContain("you express it in your OWN manner"); // below warm regard — no idiom
  });

  it("states the D11 gate invariants in the law block: premise wins, disinhibition never moves the line, values outrank", () => {
    const parts = promptParts({
      state: chatState(),
    });
    expect(parts.prefix).toMatch(/the scenario wins/i);
    expect(parts.prefix).toMatch(/never moves this line/i);
    expect(parts.prefix).toMatch(/never a meta refusal/i);
    expect(parts.prefix).toMatch(/outranks everything/i);
  });

  it("renders the pending skip note as a volatile one-turn tail line (spec §8.1)", () => {
    const withSkip = promptParts({
      state: chatState({ skipNote: "The night has passed — it's the next morning. Acknowledge the gap naturally, once." }),
    });
    const without = promptParts({
      state: chatState(),
    });
    expect(withSkip.prefix).toBe(without.prefix); // volatile — never busts the cached prefix
    expect(withSkip.tail).toContain("Time has passed in the story");
    expect(withSkip.tail).toContain("next morning");
    expect(without.tail).not.toContain("Time has passed in the story");
  });

  it("joins prefix + tail into the full system prompt", () => {
    // The SAME argument object through both builders — the identity is the claim.
    const args = { name: "Mara", profile: maraProfile(), priorSummary: "You met at the night market." };
    const parts = buildCharacterChatPromptParts(args);
    expect(parts.tail).not.toBe("");
    expect(buildCharacterChatSystemPrompt(args)).toBe(`${parts.prefix}\n\n${parts.tail}`);
  });

  it("ends the stable prefix with the rules and keeps every volatile in the tail", () => {
    const parts = promptParts({
      priorSummary: "You met at the night market.",
      memory: { facts: ["The player fears heights."], episodes: [] },
      state: { meters: { mood: 0.9 }, regard: 0, conditions: [] },
      opening: true,
    });
    expect(parts.prefix).toContain("How to respond:");
    expect(parts.prefix).not.toContain("Earlier in this conversation");
    expect(parts.prefix).not.toContain("Your memory");
    expect(parts.prefix).not.toContain("Your current state");
    expect(parts.prefix).not.toContain("Opening beat");
    expect(parts.tail).toContain("Earlier in this conversation");
    expect(parts.tail).toContain("Your memory");
    expect(parts.tail).toContain("Your current state");
    expect(parts.tail).toContain("Opening beat");
    expect(parts.tail).not.toContain("How to respond:");
  });

  it("renders the disinhibition shift as a tail override, leaving the prefix Disposition authored", () => {
    // 60 drops to ~19.5 fully drunk — across the guarded→private band boundary (33),
    // so the shift is visible; a shift that stays inside its band renders nothing.
    const traits = [{ id: "social.guardedness", value: 60, source: "creation" as const }];
    const sober = promptParts({
      profile: maraProfile({ traits }),
      state: { meters: { intoxication: 0 }, regard: 0, conditions: [] },
    });
    const drunk = promptParts({
      profile: maraProfile({ traits }),
      state: { meters: { intoxication: 0.9 }, regard: 0, conditions: [] },
    });
    // The authored band stays in the (unchanged) prefix; the shift rides the tail.
    expect(drunk.prefix).toBe(sober.prefix);
    expect(drunk.prefix).toContain("Guardedness: guarded");
    expect(drunk.tail).toContain("loosening you");
    expect(drunk.tail).toContain("Guardedness: private");
    expect(sober.tail).not.toContain("loosening you");
  });

  it("renders condition attribute effects as a tail override, not by rewriting the prefix Attributes", () => {
    const condition = {
      id: "c1",
      label: "disheveled",
      startedAtMinutes: 0,
      attributeEffects: [{ attributeId: "presentation.grooming" as const, value: "unkempt" }],
    };
    const withCondition = promptParts({
      state: { meters: {}, regard: 0, conditions: [condition] },
    });
    const without = promptParts({
      state: chatState(),
    });
    expect(withCondition.prefix).toBe(without.prefix);
    expect(withCondition.prefix).not.toContain("unkempt");
    expect(withCondition.tail).toContain("While your current condition lasts");
    expect(withCondition.tail).toContain("unkempt");
  });

  it("renders open loops as an Unfinished-business state line in the tail (spec §6.2)", () => {
    const withLoops = promptParts({
      state: chatState({ openLoops: ["tell them about her sister", "the unopened letter"] }),
    });
    expect(withLoops.tail).toContain("Unfinished business between you: tell them about her sister; the unopened letter");
    expect(withLoops.tail).toContain("never recite the list");
    const without = promptParts({
      state: chatState({ openLoops: [] }),
    });
    expect(without.prefix).toBe(withLoops.prefix); // loops are volatile — never in the prefix
    expect(without.tail).not.toContain("Unfinished business");
  });

  it("carries the dialogue-craft rule and the intimate-craft block in the stable rules (C3/C4)", () => {
    const parts = promptParts();
    expect(parts.prefix).toContain("Dialogue is speech, not prose");
    expect(parts.prefix).toContain("the truest answer is no words at all");
    expect(parts.prefix).toContain("When a scene turns intimate:");
    expect(parts.prefix).toContain("Hold escalation to the player's pace");
    expect(parts.prefix).toContain("Keep body and clothing continuity");
    expect(parts.prefix).toContain("concrete sensation");
  });
});

describe("buildCharacterChatSystemPrompt — turn grammar (deliverable A)", () => {
  const parts = promptParts({ player: { name: "Theo" } });

  it("carries the 'Resolve, then one move' rule in the stable prefix, forbidding stacked moves", () => {
    expect(parts.prefix).toContain("Shaping each reply");
    expect(parts.prefix).toContain("Resolve, then one move.");
    expect(parts.prefix).toMatch(/AT MOST ONE forward move/);
    expect(parts.prefix).toMatch(/Never stack moves/);
    expect(parts.prefix).toMatch(/only when Mara genuinely wants that answer right now/);
  });

  it("carries the worked example pair — one beat where a question is the move, one where it is filler", () => {
    // The question-is-the-move beat…
    expect(parts.prefix).toContain("What did they say when you told them?");
    expect(parts.prefix).toContain("the question earns its place");
    // …and the action-hook beat where a question would be filler.
    expect(parts.prefix).toMatch(/"Was that okay\?" is filler that kills the beat/);
    expect(parts.prefix).toContain("the move is an action hook instead");
  });

  it("sets the ~3-paragraph baseline shape without introducing a hard numeric cap", () => {
    expect(parts.prefix).toContain("about three paragraphs");
    expect(parts.prefix).toMatch(/Ordinary small talk stays lean/);
    // No digit-based length cap sneaks in with the new rule.
    expect(parts.prefix).not.toMatch(/\d+\s+(characters|tokens|words|lines|sentences|paragraphs)/);
  });

  it("carries the freshness rule — every narrative paragraph must carry something new", () => {
    expect(parts.prefix).toContain("Freshness:");
    expect(parts.prefix).toMatch(/every narrative paragraph must carry something NEW/);
    expect(parts.prefix).toMatch(/Never re-describe an unchanged setting, outfit, or scent/);
  });

  it("adds the intimate-frame exception to the intimate-craft block: sparse dialogue + no check-in refrain", () => {
    expect(parts.prefix).toMatch(/let the words go SPARSE/);
    expect(parts.prefix).toMatch(/No check-in refrain/);
    expect(parts.prefix).toMatch(/does that feel good\?/);
    expect(parts.prefix).toMatch(/At most once in a whole scene/);
  });
});

describe("buildCharacterChatSystemPrompt — response-shape + mood line (deliverable C)", () => {
  it("renders a per-turn response-shape line pinned to the derived mood, in the tail", () => {
    const parts = promptParts({
      player: { name: "Theo" },
      state: { meters: { mood: 0.8, energy: 0.8 }, regard: 0, conditions: [] },
    });
    expect(parts.tail).toContain("Response shape: respond to what Theo just said and did");
    expect(parts.tail).toContain("no unrequested new topics");
    // The mood clause pins the tone to the derived descriptor (bright and playful).
    expect(parts.tail).toContain("Mood: bright and playful");
    // It's a volatile steer — never in the cached prefix.
    expect(parts.prefix).not.toContain("Response shape:");
  });

  it("omits the mood clause when there is no notable mood", () => {
    const parts = promptParts();
    expect(parts.tail).toContain("Response shape: respond to what the user just said and did");
    expect(parts.tail).not.toContain("Mood:");
  });

  it("is suppressed on an opening beat (no player input to respond to)", () => {
    const opening = promptParts({ opening: true });
    expect(opening.tail).not.toContain("Response shape:");
    expect(opening.tail).toContain("Opening beat");
  });
});

describe("buildCharacterChatSystemPrompt — scene memory block (deliverable B)", () => {
  const sceneState = {
    meters: {},
    regard: 0,
    conditions: [],
    sceneMemory: {
      current: "the living room",
      places: [{ name: "the living room", details: ["blue sofa", "tall windows"], connections: ["kitchen through the doorway"] }],
    },
  };

  it("renders the current place, details, and connections", () => {
    const parts = promptParts({ state: sceneState });
    expect(parts.tail).toContain("Scene (the setting established so far");
    expect(parts.tail).toContain("- Here: the living room — blue sofa; tall windows");
    expect(parts.tail).toContain("- Nearby: kitchen through the doorway");
  });

  it("renders the meanwhile note, return license, and rhythm line (chat-offscreen-life)", () => {
    const parts = promptParts({
      state: {
        ...sceneState,
        meanwhileNote: "she heard back about the commission",
        whereabouts: "at her studio, finishing the commission",
        rhythm: "mornings: waiting tables at the Dockside Café",
      },
    });
    expect(parts.tail).toContain("While you were apart, off-screen");
    expect(parts.tail).toContain("she heard back about the commission");
    expect(parts.tail).toContain("You just got back — you were at her studio, finishing the commission.");
    expect(parts.tail).toContain("Your daily rhythm");
    expect(parts.tail).toContain("mornings: waiting tables at the Dockside Café");
    // None set ⇒ none of the lines render (degraded default).
    const bare = promptParts({ state: sceneState });
    expect(bare.tail).not.toContain("While you were apart");
    expect(bare.tail).not.toContain("You just got back");
    expect(bare.tail).not.toContain("Your daily rhythm");
  });

  it("renders the clock-derived story moment as a binding tail line (chat-clock-calendar)", () => {
    const parts = promptParts({
      state: { ...sceneState, storyMoment: "Friday, January 5 — 2:10pm (afternoon)" },
    });
    expect(parts.tail).toContain("Story time: it is Friday, January 5 — 2:10pm (afternoon).");
    // No storyMoment ⇒ no line (degraded default).
    const bare = promptParts({ state: sceneState });
    expect(bare.tail).not.toContain("Story time:");
  });

  it("renders the place's background sketch as a fixed-reference line (chat-scene-fidelity slice 2b)", () => {
    const sketched = {
      meters: {},
      regard: 0,
      conditions: [],
      sceneMemory: {
        current: "the living room",
        places: [
          {
            name: "the living room",
            details: ["blue sofa"],
            connections: [],
            sketch: "A narrow living room under tall windows, morning light on bare brick.",
          },
        ],
      },
    };
    const parts = promptParts({ state: sketched });
    expect(parts.tail).toContain("- Setting (fixed reference): A narrow living room under tall windows");
    // No sketch ⇒ no line (sceneState above has none).
    const plain = promptParts({ state: sceneState });
    expect(plain.tail).not.toContain("Setting (fixed reference)");
  });

  it("directs restraint on an unchanged scene, and re-establishment when it just changed", () => {
    const unchanged = promptParts({ state: sceneState });
    expect(unchanged.tail).toContain("Do not re-establish the setting; at most one fresh accent");
    const changed = promptParts({ state: sceneState, sceneChanged: true });
    expect(changed.tail).toContain("This scene just changed — establish the new setting");
  });

  it("rides the volatile tail (never busts the cached prefix) and renders nothing when empty & unchanged", () => {
    const withScene = promptParts({ state: sceneState });
    const without = promptParts({ state: chatState() });
    expect(withScene.prefix).toBe(without.prefix); // scene memory is volatile — prefix unchanged
    expect(without.tail).not.toContain("Scene (the setting established");
    // Empty memory but the scene just changed (a bare move) still steers re-establishment.
    const changedEmpty = promptParts({
      state: chatState({ sceneMemory: { current: "the porch", places: [{ name: "the porch", details: [], connections: [] }] } }),
      sceneChanged: true,
    });
    expect(changedEmpty.tail).toContain("- Here: the porch");
    expect(changedEmpty.tail).toContain("establish the new setting");
  });
});

describe("buildCharacterChatSystemPrompt — first-exchange scene directive (Fly screenshot, 2026-07-10)", () => {
  it("directs one-time, narration-forward scene establishment on the conversation's first exchange", () => {
    const parts = promptParts({
      player: { name: "Theo" },
      firstExchange: true,
    });
    expect(parts.tail).toContain("First exchange of this conversation: establish the scene once");
    expect(parts.tail).toContain("sight plus one other sense");
    expect(parts.tail).toContain("what Theo's message sets up");
    // Volatile by nature — it must never ride the cached prefix.
    expect(parts.prefix).not.toContain("First exchange of this conversation");
  });

  it("is absent on ordinary turns and defers to the sceneChanged directive when a first-message move fired", () => {
    const ordinary = promptParts();
    expect(ordinary.tail).not.toContain("First exchange of this conversation");
    // A movement in the first message minted a place ⇒ sceneChanged's own directive wins.
    const moved = promptParts({
      state: {
        meters: {},
        regard: 0,
        conditions: [],
        sceneMemory: { current: "the kitchen", places: [{ name: "the kitchen", details: [], connections: [] }] },
      },
      firstExchange: true,
      sceneChanged: true,
    });
    expect(moved.tail).not.toContain("First exchange of this conversation");
    expect(moved.tail).toContain("establish the new setting");
  });

  it("falls back to 'the player' in the faceless variant", () => {
    const faceless = promptParts({ firstExchange: true });
    expect(faceless.tail).toContain("what the player's message sets up");
  });
});

describe("buildCharacterChatSystemPrompt — sensory focus block (scope guard)", () => {
  const scented = maraProfile({
    attributes: [attr("identity.gender", "female"), attr("presentation.scent_baseline", "cedar and warm skin")],
  });

  it("assembles authored scent + hygiene band for a smell/taste beat, in the tail", () => {
    const parts = promptParts({
      profile: scented,
      player: { name: "Theo" },
      state: { meters: { hygiene: 0.2 }, regard: 0, conditions: [] },
      sensoryFocus: { sense: "smell", target: "hair", intimate: false, region: "hair" },
    });
    expect(parts.tail).toContain("Sensory focus candidate — Theo breathing in Mara's hair.");
    expect(parts.tail).toContain("cedar and warm skin");
    expect(parts.tail).toMatch(/unwashed/i); // the low-hygiene band layered over the scent
    expect(parts.tail).toContain("never trade it for a milder");
    expect(parts.prefix).not.toContain("Sensory focus"); // volatile
  });

  it("opens the reply with the sensation itself (sensory-grounding directive)", () => {
    const parts = promptParts({
      profile: scented,
      player: { name: "Theo" },
      state: chatState(),
      sensoryFocus: { sense: "taste", target: "foot", intimate: false, region: "foot" },
    });
    expect(parts.tail).toContain("OPEN your reply with the experience itself");
    expect(parts.tail).toContain("before Mara reacts or the scene moves on");
    expect(parts.tail).toContain("names the CHARACTER of a sensation");
    expect(parts.tail).toContain("Use this block only if the CURRENT player narration explicitly performs that action now");
    expect(parts.tail).toContain("Negated, hypothetical, remembered, spoken, third-party, or storyteller wording");
    expect(parts.tail).toContain("Never add contact or movement beyond what the player wrote");
    // The old taste clause hardcoded "its warmth and salt" — the word steered every foot
    // beat toward "salty" prose whatever the authored scent said (owner report 2026-07-13).
    expect(parts.tail).not.toContain("warmth and salt");
  });

  it("renders the reported negated-perfect message as visual accent only, with no focus premise", () => {
    const message =
      "She isn't afraid of me. I notice the faint glow in her eyes. I haven't even touched her yet.";
    const cue = detectChatCue(message);
    const sensoryFocus = detectSensoryFocus(message, {
      characters: [{ id: "character_mara", name: "Mara", aliases: [] }],
    });
    const parts = promptParts({
      player: { name: "Theo" },
      sensoryAllowance: deriveChatSensoryAllowance({ cue, sensoryFocus }),
      ...(sensoryFocus ? { sensoryFocus } : {}),
    });
    expect(sensoryFocus).toBeNull();
    expect(parts.tail).not.toContain("Sensory focus candidate");
    expect(parts.tail).toContain("Sensory allowance this turn: one visual accent");
    expect(parts.tail).not.toContain("touching Mara's eyes");
  });

  it("surfaces the TARGET REGION's own authored values — a foot beat carries feet.smell, sense-ranked first", () => {
    const footed = maraProfile({
      attributes: [
        attr("identity.gender", "female"),
        attr("presentation.scent_baseline", "cedar and warm skin"),
        attr("feet.smell", "thick_musk"),
        attr("feet.arch", "high"),
      ],
    });
    const parts = promptParts({
      profile: footed,
      player: { name: "Theo" },
      state: chatState(),
      sensoryFocus: { sense: "taste", target: "foot", intimate: false, region: "foot" },
    });
    expect(parts.tail).toContain("Mara's foot scent: thick musk");
    expect(parts.tail).toContain("Mara's foot arch: high");
    // The region's own scent leads the generic perfume line.
    expectOrder(parts.tail, ["foot scent", "cedar and warm skin"]);
  });

  it("renders the authored narrator gloss beside the value (attribute-narrator-guidance)", () => {
    const footed = maraProfile({
      attributes: [attr("identity.gender", "female"), attr("feet.smell", "cheesy")],
    });
    const parts = promptParts({
      profile: footed,
      player: { name: "Theo" },
      state: chatState(),
      sensoryFocus: { sense: "smell", target: "feet", intimate: false, region: "feet" },
    });
    expect(parts.tail).toContain("Mara's foot scent: cheesy (dense fermented funk, like aged cheese");
  });

  it("an authored region scent is the current truth — no contradictory 'clean' default beneath it", () => {
    const footed = maraProfile({
      attributes: [
        attr("identity.gender", "female"),
        attr("presentation.scent_baseline", "cedar and warm skin"),
        attr("feet.smell", "cheesy"),
      ],
    });
    // Unremarkable hygiene (no threshold crossed): the block must NOT assert clean skin.
    const fresh = promptParts({
      profile: footed,
      player: { name: "Theo" },
      state: { meters: { hygiene: 0.9 }, regard: 0, conditions: [] },
      sensoryFocus: { sense: "smell", target: "feet", intimate: false, region: "feet" },
    });
    expect(fresh.tail).not.toContain("clean skin, nothing strong");
    expect(fresh.tail).toContain("an overlay riding above the scent named above");
    // Low hygiene deepens the authored scent rather than replacing it.
    const grimy = promptParts({
      profile: footed,
      player: { name: "Theo" },
      state: { meters: { hygiene: 0.2 }, regard: 0, conditions: [] },
      sensoryFocus: { sense: "smell", target: "feet", intimate: false, region: "feet" },
    });
    expect(grimy.tail).toContain("DEEPENS the authored scent above");
    // Without any authored region scent the grounded default remains (no invention vacuum).
    const bare = promptParts({
      profile: maraProfile({ attributes: [attr("identity.gender", "female")] }),
      player: { name: "Theo" },
      state: chatState(),
      sensoryFocus: { sense: "smell", target: "hair", intimate: false, region: "hair" },
    });
    expect(bare.tail).toContain("clean skin, nothing strong");
  });

  it("drops off-sense region values (a study beat never surfaces scent)", () => {
    const footed = maraProfile({
      attributes: [attr("identity.gender", "female"), attr("feet.smell", "thick_musk"), attr("feet.arch", "high")],
    });
    const parts = promptParts({
      profile: footed,
      player: { name: "Theo" },
      state: chatState({ outfit: "a linen sundress" }),
      sensoryFocus: { sense: "study", target: "foot", intimate: false, region: "foot" },
    });
    expect(parts.tail).toContain("Mara's foot arch: high");
    expect(parts.tail).not.toContain("thick musk");
  });

  it("surfaces an intimate attribute only when the beat targets intimate anatomy the character has", () => {
    const intimateProfile = maraProfile({
      intimateRegions: ["breasts"],
      attributes: [attr("identity.gender", "female"), attr("breasts.size", "full")],
    });
    const earned = promptParts({
      profile: intimateProfile,
      player: { name: "Theo" },
      state: chatState(),
      sensoryFocus: { sense: "touch", target: "breasts", intimate: true, region: "breasts" },
    });
    expect(earned.tail).toContain("Sensory focus candidate — Theo touching Mara's breasts.");
    expect(earned.tail).toMatch(/breast size: full/i);
    // A non-intimate focus never surfaces the intimate attribute.
    const notEarned = promptParts({
      profile: intimateProfile,
      player: { name: "Theo" },
      state: chatState(),
      sensoryFocus: { sense: "study", target: "dress", intimate: false },
    });
    expect(notEarned.tail).not.toMatch(/breast size: full/i);
  });

  it("keeps the intimate join target-matched — a breasts beat never surfaces another region's values", () => {
    const intimateProfile = maraProfile({
      intimateRegions: ["breasts", "vulva"],
      attributes: [attr("identity.gender", "female"), attr("breasts.size", "full"), attr("vulva.scent", "musky")],
    });
    const parts = promptParts({
      profile: intimateProfile,
      player: { name: "Theo" },
      state: chatState(),
      sensoryFocus: { sense: "touch", target: "breasts", intimate: true, region: "breasts" },
    });
    expect(parts.tail).toMatch(/breast size: full/i);
    expect(parts.tail).not.toContain("vulva scent");
  });

  it("a garment target (no region) still grounds on outfit + generic lines", () => {
    const parts = promptParts({
      profile: scented,
      player: { name: "Theo" },
      state: chatState({ outfit: "a linen sundress" }),
      sensoryFocus: { sense: "study", target: "dress", intimate: false },
    });
    expect(parts.tail).toContain("Sensory focus candidate — Theo taking in Mara's dress.");
    expect(parts.tail).toContain("Wearing: a linen sundress");
  });
});

describe("buildCharacterChatSystemPrompt — reply-discipline gate notes (deliverable D)", () => {
  it("passes the pre-computed gate notes through to the volatile tail", () => {
    const note = "Your recent replies ended in questions — end this one differently unless the moment truly demands one.";
    const parts = promptParts({ gateNotes: note });
    expect(parts.tail).toContain(note);
    const without = promptParts();
    expect(without.prefix).toBe(parts.prefix); // gate notes are volatile
    expect(without.tail).not.toContain("ended in questions");
  });
});

describe("buildCharacterChatSystemPrompt — per-turn sensory allowance (narrator-prompt-consolidation slice 4)", () => {
  const base = { name: "Mara", profile: maraProfile(), player: { name: "Theo" } };

  it("renders the binding line per allowance, in the volatile tail", () => {
    const none = buildCharacterChatPromptParts({ ...base, sensoryAllowance: "none" });
    expect(none.tail).toContain("Sensory allowance this turn: none");
    expect(none.tail).toContain("no scent, warmth, texture, or taste detail of Mara");
    expect(none.prefix).not.toContain("Sensory allowance this turn"); // volatile

    const visual = buildCharacterChatPromptParts({ ...base, sensoryAllowance: "visual_accent" });
    expect(visual.tail).toContain("Sensory allowance this turn: one visual accent");
    expect(visual.tail).toContain("Theo's eye is on Mara");

    const close = buildCharacterChatPromptParts({ ...base, sensoryAllowance: "close_range_hook" });
    expect(close.tail).toContain("Sensory allowance this turn: one close-range hook");
    expect(close.tail).toContain("as it reaches Theo's senses");
  });

  it("renders no allowance line for focused_description (the Sensory-focus block is the grant) or when absent", () => {
    const focused = buildCharacterChatPromptParts({
      ...base,
      sensoryAllowance: "focused_description",
      sensoryFocus: { sense: "smell", target: "hair", intimate: false, region: "hair" },
      state: chatState(),
    });
    expect(focused.tail).not.toContain("Sensory allowance this turn");
    expect(focused.tail).toContain("Sensory focus candidate — Theo breathing in Mara's hair.");

    const absent = buildCharacterChatPromptParts(base);
    expect(absent.tail).not.toContain("Sensory allowance this turn");
  });

  it("degrades focused_description to the close-range grant when nothing authored grounds the focus block", () => {
    // A touch beat on a region with no authored values, no outfit/grooming/hygiene/conditions:
    // the focus block renders "" — the allowance must not silently fall to rule 11's default none.
    const parts = buildCharacterChatPromptParts({
      ...base,
      sensoryAllowance: "focused_description",
      sensoryFocus: { sense: "touch", target: "wrist", intimate: false, region: "wrist" },
      state: chatState(),
    });
    expect(parts.tail).not.toContain("Sensory focus candidate —");
    expect(parts.tail).toContain("Sensory allowance this turn: one close-range hook");
  });

  it("the static rules defer to the allowance line rather than restating the conditions", () => {
    const prompt = buildCharacterChatSystemPrompt(base);
    expect(prompt).toMatch(/when a "Sensory allowance" line is present below, it states exactly what may land/i);
    expect(prompt).toContain("When no allowance line is present, default to none.");
  });

  /**
   * Owner ruling 2026-07-28: a current-effect affordance cue is NEW INFORMATION,
   * not static appearance, so the `none` grant's no-appearance instruction must
   * not read as forbidding the cue block the same prompt is offering. The trial
   * dress-rehearsal measured ~79% of cue-bearing exchanges carrying both.
   */
  describe("the current-effect cue carve-out", () => {
    const CARVE_OUT = 'The "Physical detail worth noticing this turn" block above is exempt';
    const withCues = (cues: readonly string[]) =>
      buildCharacterChatPromptParts({
        ...base,
        sensoryAllowance: "none" as const,
        state: chatState({ affordanceCues: [...cues] }),
      });

    it("exempts the cue block when the allowance is none AND cues are present", () => {
      const parts = withCues(["Mara's damp hair has separated into clinging strands"]);
      expect(parts.tail).toContain("Sensory allowance this turn: none");
      expect(parts.tail).toContain(CARVE_OUT);
      // The exemption is bounded — the block's own one-detail limit still binds.
      expect(parts.tail).toContain("its own one-detail limit still applies");
      // And it names the block by the heading the block actually renders.
      expect(parts.tail).toContain("Physical detail worth noticing this turn (weave at most one");
    });

    it("is byte-identical to today when the allowance is none and NO cue was selected", () => {
      const noCues = buildCharacterChatPromptParts({ ...base, sensoryAllowance: "none", state: chatState() });
      const emptyCues = withCues([]);
      const blankCues = withCues(["   "]);
      expect(noCues.tail).not.toContain(CARVE_OUT);
      expect(emptyCues.tail).toBe(noCues.tail);
      expect(blankCues.tail).toBe(noCues.tail);
      expect(emptyCues.prefix).toBe(noCues.prefix);
    });

    it("is byte-identical to today with the flag OFF — no cue block, no carve-out", () => {
      // Flag off means the pipeline passes no `affordanceCues` at all.
      const flagOff = buildCharacterChatPromptParts({ ...base, sensoryAllowance: "none", state: chatState() });
      const before = buildCharacterChatPromptParts({ ...base, sensoryAllowance: "none" });
      expect(flagOff.tail).not.toContain(CARVE_OUT);
      expect(flagOff.tail).not.toContain("Physical detail worth noticing this turn");
      expect(before.tail).not.toContain(CARVE_OUT);
    });

    it("touches no other allowance — a grant already permits the detail", () => {
      for (const allowance of ["visual_accent", "close_range_hook"] as const) {
        const granted = buildCharacterChatPromptParts({
          ...base,
          sensoryAllowance: allowance,
          state: chatState({ affordanceCues: ["Mara's shirt has gone dark with water"] }),
        });
        expect(granted.tail).not.toContain(CARVE_OUT);
      }
    });

    it("stays out of the cache-stable prefix — the reconciliation is per-turn framing", () => {
      const parts = withCues(["Mara's shirt has gone dark with water"]);
      expect(parts.prefix).not.toContain(CARVE_OUT);
    });
  });
});

describe("buildCharacterChatSystemPrompt — per-shape length story (narrator-prompt-consolidation slice 2)", () => {
  it("aggressive_concise carries a beat-scaled length rule with no paragraph floor", () => {
    const prompt = systemPrompt({
      narrationShape: "aggressive_concise",
    });
    expect(prompt).toContain("Length follows the beat");
    expect(prompt).toContain("never add prose to reach a customary length");
    expect(prompt).not.toContain("Baseline shape: about three paragraphs");
  });

  it("concise_immersive keeps the three-paragraph baseline", () => {
    const prompt = systemPrompt({
      narrationShape: "concise_immersive",
    });
    expect(prompt).toContain("Baseline shape: about three paragraphs");
    expect(prompt).not.toContain("Length follows the beat");
  });
});

describe("buildCharacterChatSystemPrompt — incidental people stay scene-consistent (slice 1)", () => {
  it("licenses flavor NPCs only inside the established scene, unnamed and passing", () => {
    const prompt = systemPrompt({ player: { name: "Theo" } });
    expect(prompt).toContain("An INCIDENTAL person must fit the scene already established");
    expect(prompt).toContain("never invent one just to enliven a reply");
    // The supporting-cast carve-out (chat-supporting-cast.plan.md): recurring named
    // people are the licensed exception to the unnamed-and-passing discipline.
    expect(prompt).toContain('Recurring named people listed under "Supporting cast"');
  });
});

describe("buildCharacterChatSystemPrompt — supporting cast (chat-supporting-cast.plan.md)", () => {
  const cast = [
    {
      name: "Abby",
      relation: "Theo's coworker and close friend",
      details: ["covered a shift last week"],
      voice: "dry one-liners",
      whereabouts: "the clinic front desk",
    },
  ];

  it("renders the cast block in the volatile tail with the play license", () => {
    const { prefix, tail } = promptParts({
      player: { name: "Theo" },
      state: chatState({ supportingCast: cast }),
    });
    expect(tail).toContain("Supporting cast (recurring side characters in this story");
    expect(tail).toContain("- Abby — Theo's coworker and close friend · covered a shift last week · voice: dry one-liners · usually: the clinic front desk");
    expect(tail).toContain("you may write their dialogue and small actions");
    expect(tail).toContain("never use one to speak or act FOR Theo");
    // Never a bracketed tag — the render contract is unchanged.
    expect(tail).toContain("never a [bracketed] tag");
    expect(prefix).not.toContain("Supporting cast (recurring side characters");
  });

  it("renders no block when the cast is empty (byte-identical tail)", () => {
    const withEmpty = promptParts({
      player: { name: "Theo" },
      state: chatState({ supportingCast: [] }),
    });
    const without = promptParts({
      player: { name: "Theo" },
      state: chatState(),
    });
    expect(withEmpty.tail).toBe(without.tail);
  });

  it("rule 16 lets cast populate the character's side of a scene cut", () => {
    const prompt = systemPrompt({ player: { name: "Theo" } });
    expect(prompt).toContain("Supporting-cast members who would plausibly be with Mara may appear there");
    // The original guard holds: the player's side stays theirs.
    expect(prompt).toContain("Never narrate Theo's side of the separation");
  });
});

describe("narrator-mode input (chat-supporting-cast.plan.md §Narrator input)", () => {
  it("teaches the story-narration marker in the static notation legend", () => {
    const prompt = systemPrompt({ player: { name: "Theo" } });
    expect(prompt).toContain('A message opening with a bracketed "[Story narration from Theo …]" line');
    expect(prompt).toContain("never answer it as though Theo said or did it");
  });

  it("wrapNarratorInput prefixes the marker the legend describes", () => {
    const wrapped = wrapNarratorInput("Abby waves from the doorway.", "Theo");
    expect(wrapped).toBe(
      "[Story narration from Theo — written as the storyteller, not as Theo speaking or acting]\nAbby waves from the doorway.",
    );
  });

  it("renders the one-turn tail note only when this turn's input is narrator-mode", () => {
    const base = {
      name: "Mara",
      profile: maraProfile(),
      player: { name: "Theo" },
      state: chatState(),
    };
    const off = buildCharacterChatPromptParts(base);
    const on = buildCharacterChatPromptParts({ ...base, narratorInput: true });
    expect(off.tail).not.toContain("STORY NARRATION");
    expect(on.tail).toContain("This turn's message is STORY NARRATION from Theo");
    expect(on.tail).toContain("Do not reply as if Theo said or did any of it");
    // The prefix is untouched — the note is volatile-tail only.
    expect(on.prefix).toBe(off.prefix);
  });
});

describe("buildChatTurnMessage — experimental turn-context layout (slice 5)", () => {
  it("composes turn context + fenced player input as the final user message", () => {
    const parts = promptParts({
      player: { name: "Theo" },
      state: { meters: {}, regard: 10, conditions: [], mindNote: "the unpaid invoice" },
    });
    const message = buildChatTurnMessage(parts.tail, 'She grins. "Long day?"', "Theo");
    expect(message).toContain("## Turn context");
    expect(message).toContain("On your mind: the unpaid invoice");
    expect(message).toContain("## Theo's message (respond to this)");
    expect(message).toContain('She grins. "Long day?"');
    // The player input is fenced (untrusted), like the session lane's.
    expect(message).toMatch(/vsp-untrusted-[0-9a-f]+:player message/);
    // The prefix (identity, rules) is NOT in the turn message — it stays the stable system prompt.
    expect(message).not.toContain("How to respond:");
  });
});

describe("memory callback line (memory-callbacks.plan.md)", () => {
  const state = { meters: {}, regard: 60, conditions: [] };

  it("renders the offered memory in the tail, toned warm at high regard", () => {
    const parts = promptParts({
      player: { name: "Theo" },
      state,
      callback: { summary: "They watched the storm roll in from the pier." },
    });
    expect(parts.tail).toContain('"They watched the storm roll in from the pier."');
    expect(parts.tail).toContain("warm aside");
    // Optional and droppable — the scene in motion outranks the memory.
    expect(parts.tail).toContain("If the scene is moving");
  });

  it("tones plain in the middle bands and pointed when cold", () => {
    const neutral = chatCallbackLine("The pier storm.", 0, "Mara", "Theo");
    expect(neutral).toContain("Mention it only if it fits the beat naturally");
    expect(neutral).not.toContain("warm");
    const cold = chatCallbackLine("The pier storm.", -40, "Mara", "Theo");
    expect(cold).toContain("carries an edge");
    expect(cold).toContain("never warmth Mara doesn't feel");
  });

  it("renders no callback block when absent", () => {
    const parts = promptParts({ player: { name: "Theo" }, state });
    expect(parts.tail).not.toContain("A shared memory");
    expect(parts.tail).not.toContain("You might find yourself remembering");
  });
});

describe("emotional weather in the tail (emotional-weather.plan.md)", () => {
  const meters = { mood: 0.2, stress: 0.2, energy: 0.8 }; // "subdued and withdrawn"
  const feeling = { current: { label: "sad" as const, intensity: 0.8, cause: "the broken promise" }, bruise: null };

  it("composes the persistent feeling with the meter descriptor (ruled: compose, never replace)", () => {
    const parts = promptParts({
      player: { name: "Theo" },
      state: { meters, regard: 10, conditions: [], feeling },
    });
    expect(parts.tail).toContain("You are feeling subdued and withdrawn right now — and deeply sad about the broken promise.");
    // The mood pin carries it too.
    expect(parts.tail).toContain("beneath it, deeply sad about the broken promise");
  });

  it("a fading feeling reads as fading; no feeling leaves the line unchanged", () => {
    const faint = { current: { label: "sad" as const, intensity: 0.25, cause: "the broken promise" }, bruise: null };
    const parts = promptParts({
      state: { meters, regard: 10, conditions: [], feeling: faint },
    });
    expect(parts.tail).toContain("faintly — it's fading — sad");
    const plain = promptParts({
      state: { meters, regard: 10, conditions: [] },
    });
    expect(plain.tail).toContain("You are feeling subdued and withdrawn right now.");
    expect(plain.tail).not.toContain("beneath it");
  });

  it("a feeling with an even-keel meter read still surfaces on its own", () => {
    const parts = promptParts({
      state: { meters: {}, regard: 10, conditions: [], feeling },
    });
    expect(parts.tail).toContain("Underneath everything, deeply sad about the broken promise.");
  });
});

describe("the one-turn note digest (chat-agent-improvements.plan.md slice 4)", () => {
  // A deliberately crowded turn: a binding truth (photos), a gate (the allowance ceiling),
  // a license (the selfie), and the flavor note (a callback) all armed at once.
  const crowded = promptParts({
    player: { name: "Theo" },
    state: { meters: {}, regard: 60, conditions: [] },
    attachments: { descriptions: ["A harbor at dusk."] },
    sensoryAllowance: "visual_accent",
    selfie: "offer",
    callback: { summary: "the night they watched the storm roll in" },
  });

  it("gathers the one-turn directives under one heading that states their authority", () => {
    expect(crowded.tail).toContain("Right now (directives for THIS turn only, most binding first");
    // Exactly one digest heading, however many notes fire.
    expect(crowded.tail.match(/Right now \(directives/g)).toHaveLength(1);
  });

  it("orders them binding → gate → license → flavor", () => {
    // binding → gate → flavor. `expectOrder` names the offending pair on failure and
    // reports an absent needle as "never appears" rather than a bare index comparison.
    expectOrder(crowded.tail, ["Attached photos", "Sensory allowance", "watched the storm roll in"]);
    // …and the grace note lands last, after every directive.
    expectOrder(crowded.tail, ["photo", "watched the storm roll in"]);
  });

  it("renders no heading at all on a turn with no one-turn notes", () => {
    const quiet = promptParts({
      player: { name: "Theo" },
      state: chatState(),
    });
    expect(quiet.tail).not.toContain("Right now (directives");
  });

  it("keeps the notes in the volatile tail — the cached prefix never carries a one-turn note", () => {
    expect(crowded.prefix).not.toContain("Right now (directives");
    expect(crowded.prefix).not.toContain("Attached photos (Theo shared");
  });
});

describe("attached photos (chat-image-input.plan.md)", () => {
  it("renders the fenced attachments block and the static rule 16", () => {
    const parts = promptParts({
      player: { name: "Theo" },
      attachments: { descriptions: ["A golden retriever asleep on a porch swing.", "A harbor at dusk."] },
    });
    expect(parts.tail).toContain("Attached photos (Theo shared these photos with this message — what you see):");
    expect(parts.tail).toContain("1. A golden retriever asleep on a porch swing.");
    expect(parts.tail).toContain("2. A harbor at dusk.");
    // The block is fenced — the descriptions derive from a player-supplied image.
    expect(parts.tail).toMatch(/vsp-untrusted-[0-9a-f]+:attached photos/);
    // The handling rule is static prefix law (owner ruling). Its ORDINAL is deliberately
    // not pinned: this assertion once broke outright when the duplicate rule 8 folded into
    // the Shaping block and every later rule renumbered (17 → 16). What matters is that a
    // numbered rule with this body exists, at whatever number it currently holds.
    expectNumberedRule(parts.prefix, "When Theo's message carries attached photos");
    expect(parts.prefix).toContain("never speak of an \"image\" or \"attachment\"");
  });

  it("no attachments (or blank reads) ⇒ no block", () => {
    expect(promptParts().tail).not.toContain("Attached photos");
    expect(
      promptParts({ attachments: { descriptions: ["  "] } }).tail,
    ).not.toContain("Attached photos");
  });
});

describe("selfie license line (chat-selfies.plan.md)", () => {
  it("a request line makes declining first-class; an offer stays optional and apart-framed", () => {
    const request = chatSelfieLine("request", "Mara", "Theo");
    expect(request).toContain("Theo asked Mara for a photo this turn");
    expect(request).toContain("declining is a real answer");
    const offer = chatSelfieLine("offer", "Mara", "Theo");
    expect(offer).toContain("You are apart and texting");
    expect(offer).toContain("Entirely optional");
    expect(chatSelfieLine(undefined, "Mara", "Theo")).toBe("");
  });

  it("the opener arm is register-conditional — a photo only if the opening lands as a text (chat-initiative slice 5)", () => {
    const opener = chatSelfieLine("opener", "Mara", "Theo");
    expect(opener).toContain("IF your opening lands as a text");
    expect(opener).toContain('"thinking of you"');
    expect(opener).toContain("opening in a shared scene means no photo");
  });

  it("rides the tail only when armed", () => {
    const armed = promptParts({
      player: { name: "Theo" },
      selfie: "request",
    });
    expect(armed.tail).toContain("asked Mara for a photo");
    const plain = promptParts({ player: { name: "Theo" } });
    expect(plain.tail).not.toContain("for a photo");
  });
});

describe("drives block (character-drives.plan.md)", () => {
  /**
   * A SECRET want by default — this block is about the reveal gate, so the
   * withheld case is the one worth defaulting to. Typed as `Partial<ChatDrive>`
   * (the shared fixture's own shape), so an override naming a field the contract
   * does not have is a compile error rather than a silently ignored key.
   */
  const secret = (over: Partial<ChatDrive> = {}): ChatDrive =>
    drive({
      want: "to reopen the gallery under her own name",
      why: "it was her mother's",
      secrecy: "secret",
      ...over,
    });
  const stateWith = (drives: readonly ChatDrive[], familiarity = 0): ChatPromptState =>
    chatState({ familiarity, drives: [...drives] });

  it("a withheld secret carries the scoped lie license; a cleared gate invites the reveal", () => {
    const withheld = promptParts({
      player: { name: "Theo" },
      state: stateWith([secret()], 10),
    });
    expect(withheld.tail).toContain("A SECRET: you want to reopen the gallery");
    expect(withheld.tail).toContain("you may lie outright");
    expect(withheld.tail).toContain("The lying is for THIS secret only");
    const cleared = promptParts({
      player: { name: "Theo" },
      state: stateWith([secret()], 80),
    });
    expect(cleared.tail).toContain("A secret you could finally share");
    expect(cleared.tail).not.toContain("lie outright");
  });

  it("open steers, guarded withholds-until-asked, resolved drops, empty renders nothing", () => {
    const parts = promptParts({
      player: { name: "Theo" },
      state: stateWith([
        secret({ secrecy: "open", want: "to learn the violin" }),
        secret({ secrecy: "guarded", want: "to be taken seriously" }),
        secret({ secrecy: "open", want: "gone", resolved: true }),
      ]),
    });
    expect(parts.tail).toContain("What you want");
    expect(parts.tail).toContain("You want to learn the violin");
    expect(parts.tail).toContain("You don't volunteer this");
    expect(parts.tail).not.toContain("gone");
    const none = promptParts({ state: chatState() });
    expect(none.tail).not.toContain("What you want");
  });
});

describe("ensemble frame (multi-character-chat.plan.md slice 2)", () => {

  it("a roster of one dispatches to the single-character path byte-identically", () => {
    const single = buildCharacterChatPromptParts(input());
    const dispatchNone = buildChatPromptPartsForRoster(input());
    const dispatchOne = buildChatPromptPartsForRoster(input(), [member("Mara")]);
    expect(dispatchNone.prefix).toBe(single.prefix);
    expect(dispatchNone.tail).toBe(single.tail);
    expect(dispatchOne.prefix).toBe(single.prefix);
    expect(dispatchOne.tail).toBe(single.tail);
  });

  it("a real ensemble builds the one-block frame: narrator identity, a sheet per member, tag law, player authority", () => {
    const parts = buildChatPromptPartsForRoster(input(), [member("Mara"), member("Rhett")]);
    const full = `${parts.prefix}\n\n${parts.tail}`;
    expect(parts.prefix).toContain("You are the narrator");
    expect(parts.prefix).toContain("Mara, Rhett");
    expect(parts.prefix).toContain("## Mara");
    expect(parts.prefix).toContain("## Rhett");
    // Universal tag discipline — in a group nothing is auto-attributed.
    expect(parts.prefix).toContain("Tag EVERY spoken character line");
    expect(parts.prefix).toContain("[Mara]");
    // …and brackets go nowhere else — never around a name inside quoted speech
    // (owner report 2026-08-02).
    expect(parts.prefix).toContain("Square brackets have exactly ONE use");
    expect(parts.prefix).toContain('NEVER "Good to see you, [Brian]."');
    // Ruling 3: the player owns himself; the cutaway rule rides with it.
    expect(parts.prefix).toContain("never write Brian's actions, speech, decisions");
    expect(parts.prefix).toContain("the reply is a cutaway");
    // The roster presence line rides the volatile tail.
    expect(full).toContain("In the scene with Brian right now: Mara, Rhett.");
    // No 1-on-1 identity leak.
    expect(full).not.toContain("one-on-one conversation");
  });

  it("compresses a quiet member and drops an away member while someone is present", () => {
    const parts = buildChatPromptPartsForRoster(input(), [
      member("Mara"),
      member("Quinn", { quietExchanges: 5 }),
      member("Vera", { presence: "away" }),
    ]);
    expect(parts.prefix).toContain("## Quinn (quiet just now)");
    // Quiet sheets keep identity but drop the full background fence.
    expect(parts.prefix.split("## Quinn (quiet just now)")[1]).not.toContain("Background:");
    // The away member has no sheet while someone is present (tier 4)…
    expect(parts.prefix).not.toContain("## Vera");
    // …but the tail's roster line still accounts for her.
    expect(parts.tail).toContain("Away, living their own lives: Vera.");
  });

  it("renders cutaway sheets when every member is away", () => {
    const parts = buildChatPromptPartsForRoster(input(), [
      member("Mara", { presence: "away" }),
      member("Vera", { presence: "away" }),
    ]);
    expect(parts.tail).toContain("no one — every character is away");
    expect(parts.prefix).toContain("## Mara (away)");
    expect(parts.prefix).toContain("## Vera (away)");
  });

  it("keeps the ensemble prefix byte-identical across tail-only volatile changes", () => {
    const a = buildChatPromptPartsForRoster(input(), [
      member("Mara", { memory: { facts: ["Brian owns a sailboat"], episodes: [] } }),
      member("Rhett"),
    ]);
    const b = buildChatPromptPartsForRoster(input(), [
      member("Mara", { memory: { facts: ["Brian hates oysters"], episodes: ["The night market"] } }),
      member("Rhett"),
    ]);
    expect(a.prefix).toBe(b.prefix);
    expect(a.tail).not.toBe(b.tail);
    expect(a.tail).toContain("Mara's memory:");
    expect(a.tail).toContain("Brian owns a sailboat");
  });
});

describe("ensemble group perks (followups ruling 12)", () => {

  it("renders the selfie request license naming the addressed member", () => {
    const parts = buildChatPromptPartsForRoster(input(), [member("Mara"), member("Vera")], {
      selfie: { kind: "request", memberName: "Vera" },
    });
    expect(parts.tail).toContain("Brian asked Vera for a photo this turn");
    expect(parts.prefix).not.toContain("asked Vera for a photo"); // one-turn arm — volatile tail only
  });

  it("renders the callback as a third-person aside toned by the member's own regard", () => {
    const warm = buildChatPromptPartsForRoster(input(), [member("Mara"), member("Vera")], {
      callback: { summary: "The night market in the rain.", memberName: "Vera", regard: 60 },
    });
    expect(warm.tail).toContain("A shared memory drifts near Vera this turn");
    expect(warm.tail).toContain("The night market in the rain.");
    expect(warm.tail).toContain("in Vera's own voice");
    const cold = buildChatPromptPartsForRoster(input(), [member("Mara"), member("Vera")], {
      callback: { summary: "The night market in the rain.", memberName: "Vera", regard: -60 },
    });
    expect(cold.tail).toContain("carries an edge");
    expect(cold.tail).toContain("never warmth Vera doesn't feel");
  });

  it("aims the sensory focus block at the studied member's own values", () => {
    const parts = buildChatPromptPartsForRoster(
      input(),
      [
        member("Mara"),
        member("Vera", {
          state: chatState({ outfit: "a paint-streaked tank top" }),
        }),
      ],
      { sensoryFocus: { hint: { sense: "study", target: "hands", intimate: false }, memberName: "Vera" } },
    );
    expect(parts.tail).toContain("Sensory focus candidate — Brian taking in Vera's hands");
    expect(parts.tail).toContain("a paint-streaked tank top");
  });

  it("drops the focus block when the named member is not present", () => {
    const parts = buildChatPromptPartsForRoster(input(), [member("Mara"), member("Vera", { presence: "away" })], {
      sensoryFocus: { hint: { sense: "study", target: "hands", intimate: false }, memberName: "Vera" },
    });
    expect(parts.tail).not.toContain("taking in Vera's hands");
  });

  it("renders per-member transient enactment: a drunk member's loosened bands in the third person", () => {
    const traits = [{ id: "social.guardedness", value: 60, source: "creation" as const }];
    const parts = buildChatPromptPartsForRoster(input(), [
      member("Mara"),
      member("Vera", {
        profile: maraProfile({ traits }),
        state: { meters: { intoxication: 0.9 }, regard: 0, conditions: [] },
      }),
    ]);
    expect(parts.tail).toContain("Vera's state is loosening Vera");
    expect(parts.tail).toContain("Guardedness: private");
    // Sober members add nothing.
    expect(parts.tail).not.toContain("Mara's state is loosening");
  });

  it("renders a member's condition attribute effects as their transient override", () => {
    const condition = {
      id: "c1",
      label: "disheveled",
      startedAtMinutes: 0,
      attributeEffects: [{ attributeId: "presentation.grooming" as const, value: "unkempt" }],
    };
    const parts = buildChatPromptPartsForRoster(input(), [
      member("Mara"),
      member("Vera", { state: { meters: {}, regard: 0, conditions: [condition] } }),
    ]);
    expect(parts.tail).toContain("While Vera's current condition lasts");
    expect(parts.tail).toContain("unkempt");
  });
});

describe("ensemble relationship matrix injection (relationship-model.plan.md slice 6)", () => {
  const record = (over: Partial<RelationshipRecord> = {}): RelationshipRecord => ({
    familiarity: 80,
    regard: -25,
    kind: "estranged childhood friends",
    history: "he left town without a word; she rebuilt alone",
    presented: undefined,
    looming: false,
    ...over,
  });

  it("renders present-pair FULL third-person law blocks in the prefix (followups ruling 6)", () => {
    const parts = buildChatPromptPartsForRoster(input(), [member("Mara"), member("Rhett")], {
      pairs: [{ fromName: "Mara", toName: "Rhett", record: record() }],
    });
    expect(parts.prefix).toContain("How they stand with each other");
    expect(parts.prefix).toContain("Mara → Rhett (estranged childhood friends):");
    expect(parts.prefix).toContain("he left town without a word");
    // The full band semantics ride: knowledge ceiling, feeling, the corner note,
    // and the escalation floor — all third person, never raw scalars.
    expect(parts.prefix).toContain("Familiarity (deeply known):");
    expect(parts.prefix).toContain("reads Rhett at a glance");
    expect(parts.prefix).toContain("Regard (cool): Mara dislikes Rhett");
    expect(parts.prefix).toContain("Familiarity is not warmth");
    expect(parts.prefix).toContain("Mara entertains at most light flirtation, nothing physical with Rhett");
    expect(parts.prefix).not.toContain("-25");
  });

  it("renders tier-3 away lines in the tail under the don't-teleport guard", () => {
    const parts = buildChatPromptPartsForRoster(
      input(),
      [member("Mara"), member("Vera", { presence: "away" })],
      { awayPairs: [{ fromName: "Mara", toName: "Vera", record: record({ kind: "her estranged sister" }) }] },
    );
    expect(parts.tail).toContain("If Vera comes up (they are NOT here):");
    expect(parts.tail).toContain("Mara → Vera: her estranged sister —");
    expect(parts.tail).toContain("never merge Vera into Brian's scene uninvited");
    // Pair law belongs to the prefix; the away line must not leak there.
    expect(parts.prefix).not.toContain("If Vera comes up");
  });

  it("renders the mask lean as performed-vs-felt texture", () => {
    const parts = buildChatPromptPartsForRoster(input(), [member("Mara"), member("Rhett")], {
      pairs: [
        {
          fromName: "Mara",
          toName: "Rhett",
          record: record({ presented: { lean: "masks_dislike", note: "icily civil" } }),
        },
      ],
    });
    expect(parts.prefix).toContain("Outwardly Mara performs warmer toward Rhett than Mara feels");
    expect(parts.prefix).toContain("(reads as: icily civil)");
  });
});

describe("life stage & the minor fence (character-fidelity.plan.md slices 1–2)", () => {
  it("appends the life-stage hint to the identity age line for marked bands", () => {
    const teen = buildCharacterChatSystemPrompt({ name: "Pip", profile: maraProfile({ age: "16" }) });
    expect(teen).toContain("You are 16 years old — a teenager");
    const elder = buildCharacterChatSystemPrompt({ name: "Edda", profile: maraProfile({ age: "72" }) });
    expect(elder).toContain("You are 72 years old — an elder");
    // The unmarked adult default and fantasy ages render exactly as before.
    const adult = systemPrompt({ profile: maraProfile({ age: "29" }) });
    expect(adult).toContain("You are 29 years old.");
    const fantasy = buildCharacterChatSystemPrompt({ name: "Vael", profile: maraProfile({ age: "ancient" }) });
    expect(fantasy).toContain("You are ancient.");
    expect(fantasy).not.toContain("Life stage (you are"); // no register block (rule 7's generic mention remains)
  });

  it("renders the binding register block only for bands that carry rules", () => {
    const teen = buildCharacterChatSystemPrompt({ name: "Pip", profile: maraProfile({ age: "16" }) });
    expect(teen).toContain("Life stage (you are a teenager");
    expect(teen).toContain("Never wise beyond your years");
    // Rule 7 binds to it by heading name.
    expect(teen).toContain('When a "Life stage" block is present above, its rules are binding');
    const adult = systemPrompt({ profile: maraProfile({ age: "29" }) });
    expect(adult).not.toContain("Life stage (you are");
  });

  it("fences every intimate surface for a minor primary", () => {
    const minorInput = {
      name: "Pip",
      profile: maraProfile({
        age: "15",
        traits: [
          { id: "temperament.warmth", value: 50, source: "creation" as const },
          { id: "intimate.libido", value: 60, source: "creation" as const },
          { id: "intimate.inhibition", value: 40, source: "creation" as const },
          { id: "social.guardedness", value: 40, source: "creation" as const },
        ],
      }),
      state: { meters: { intoxication: 0.9 }, regard: 70, familiarity: 60, conditions: [] },
      selfie: "request" as const,
    };
    const prompt = buildCharacterChatSystemPrompt(minorInput);
    // Content framing flips to the romance-out-of-scope frame.
    expect(prompt).toContain("This character is a minor");
    expect(prompt).not.toContain("sexually explicit content are fully in scope");
    // Intimate trait bands never render…
    expect(prompt).not.toContain("When the moment turns intimate");
    expect(prompt).not.toContain("Libido");
    // …nor the intimate-craft rules block, the escalation floor, the loosening
    // block (drunk at 0.9), or the selfie license.
    expect(prompt).not.toContain("When a scene turns intimate");
    expect(prompt).not.toContain("- Escalation:");
    expect(prompt).not.toContain("loosening you");
    expect(prompt).not.toContain("for a photo this turn"); // the selfie request license
    // The everyday disposition still renders — the character keeps their temperament.
    expect(prompt).toContain("Warmth: warm");

    // The same sheet at an adult age keeps all of it (the fence is age-keyed).
    const adult = buildCharacterChatSystemPrompt({ ...minorInput, profile: maraProfile({ ...minorInput.profile, age: "25" }) });
    expect(adult).toContain("When a scene turns intimate");
    expect(adult).toContain("- Escalation:");
    expect(adult).toContain("Everyone taking part in romantic or intimate content is an adult");
  });

  it("keeps the minor prefix byte-stable across turns (cache-safe fence)", () => {
    const at = (regard: number) =>
      buildCharacterChatPromptParts({
        name: "Pip",
        profile: maraProfile({ age: "15" }),
        state: { meters: {}, regard, conditions: [] },
      });
    expect(at(50).prefix).toBe(at(64).prefix); // same band — byte-identical
  });

  it("ensemble: minor members get the cast fence line, the sheet register line, and no selfie license", () => {
    const withMinor = buildChatPromptPartsForRoster(input(), [
      member("Mara"),
      member("Pip", { profile: maraProfile({ age: "12" }) }),
    ]);
    expect(withMinor.prefix).toContain("Some characters in this cast are minors");
    expect(withMinor.prefix).toContain("Pip, 12 years old — a child");
    expect(withMinor.prefix).toContain("Life stage (binding): Pip speaks and thinks like a real child");
    // An all-adult cast renders no fence line.
    const adults = buildChatPromptPartsForRoster(input(), [member("Mara"), member("Rhett")]);
    expect(adults.prefix).not.toContain("Some characters in this cast are minors");
    // The selfie license never fires when the addressed member is the minor…
    const selfieMinor = buildChatPromptPartsForRoster(
      input(),
      [member("Mara"), member("Pip", { profile: maraProfile({ age: "12" }) })],
      { selfie: { kind: "request", memberName: "Pip" } },
    );
    expect(selfieMinor.tail).not.toContain("asked Pip for a photo");
    // …but an adult member's license is untouched by a minor elsewhere in the cast.
    const selfieAdult = buildChatPromptPartsForRoster(
      input(),
      [member("Mara"), member("Pip", { profile: maraProfile({ age: "12" }) })],
      { selfie: { kind: "request", memberName: "Mara" } },
    );
    expect(selfieAdult.tail).toContain("Brian asked Mara for a photo this turn");
  });
});

describe("character-fidelity slices 4–6 (preferences, sliders, micro-exemplars)", () => {
  it("renders the preferences block in the stable prefix; empty ⇒ no block (slice 4)", () => {
    const withPrefs = promptParts({
      profile: maraProfile({
        preferences: [
          { target: "compliment", valence: "dislike", intensity: 6, hint: "flattery makes her wary" },
          { target: "confide", valence: "like", intensity: 5 },
        ],
      }),
    });
    expect(withPrefs.prefix).toContain("What lands well and badly with you");
    expect(withPrefs.prefix).toContain("Lands badly: compliment — flattery makes her wary");
    expect(withPrefs.prefix).toContain("Lands well: confiding");
    // Stable-prefix, not the volatile tail.
    expect(withPrefs.tail).not.toContain("What lands well and badly with you");
    expect(promptParts().prefix).not.toContain(
      "What lands well and badly",
    );
  });

  it("fences intimate-concept preferences out for a minor (slice 4 × the minor fence)", () => {
    const prefs = [{ target: "proposition", valence: "like" as const, intensity: 6 }];
    expect(
      promptParts({ profile: maraProfile({ preferences: prefs }) }).prefix,
    ).toContain("proposition");
    expect(
      buildCharacterChatPromptParts({ name: "Pip", profile: maraProfile({ age: "12", preferences: prefs }) }).prefix,
    ).not.toContain("What lands well and badly");
  });

  it("renders the micro-exemplar few-shots in the prefix; empty ⇒ no block (slice 6)", () => {
    const withExemplars = promptParts({
      profile: maraProfile({
        microExemplars: [{ situation: "pushed to talk about her past", line: '"That\'s a long story, and you haven\'t earned it."' }],
      }),
    });
    expect(withExemplars.prefix).toContain("How you actually answer a charged moment");
    expect(withExemplars.prefix).toContain("pushed to talk about her past → ");
    expect(promptParts().prefix).not.toContain(
      "How you actually answer a charged moment",
    );
  });

  it("dominance owns the forward move; mid dominance adds nothing (slice 5)", () => {
    const rules = (value: number) =>
      promptParts({
        profile: maraProfile({ traits: [{ id: "social.dominance", value, source: "creation" as const }] }),
      }).prefix;
    expect(rules(70)).toContain("You lead by temperament");
    expect(rules(-70)).toContain("You defer by temperament");
    expect(rules(0)).not.toContain("by temperament");
  });

  it("confidence colors the drive-reveal posture; mid adds nothing (slice 5)", () => {
    const drives = [{ want: "to reopen the gallery", why: "", secrecy: "open" as const, progress: "", revealed: false, resolved: false }];
    const tail = (value: number) =>
      promptParts({
        profile: maraProfile({ traits: [{ id: "temperament.confidence", value, source: "creation" as const }] }),
        state: chatState({ drives }),
      }).tail;
    expect(tail(70)).toContain("You state what you want plainly");
    expect(tail(-70)).toContain("Wanting makes you hesitant");
    expect(tail(0)).not.toContain("You state what you want plainly");
    expect(tail(0)).not.toContain("Wanting makes you hesitant");
  });

  it("ensembleQuietThreshold scales tolerance with extraversion (slice 5)", () => {
    expect(ensembleQuietThreshold(0)).toBe(ENSEMBLE_QUIET_EXCHANGES);
    expect(ensembleQuietThreshold(-70)).toBe(ENSEMBLE_QUIET_EXCHANGES - 1);
    expect(ensembleQuietThreshold(70)).toBe(ENSEMBLE_QUIET_EXCHANGES + 2);
  });

  it("an extravert holds their full ensemble sheet longer than a mid member (slice 5)", () => {
    const roster: EnsembleMemberInput[] = [
      {
        name: "Ivy",
        profile: maraProfile({ traits: [{ id: "social.extraversion", value: 70, source: "creation" }] }),
        presence: "present",
        quietExchanges: ENSEMBLE_QUIET_EXCHANGES + 1, // 4: past the mid threshold, under the extravert's
      },
      {
        name: "Quinn",
        profile: maraProfile({ traits: [{ id: "social.extraversion", value: 0, source: "creation" }] }),
        presence: "present",
        quietExchanges: ENSEMBLE_QUIET_EXCHANGES + 1,
      },
    ];
    const prefix = buildChatPromptPartsForRoster({ name: "Ivy", profile: maraProfile() }, roster).prefix;
    expect(prefix).not.toContain("## Ivy (quiet just now)"); // extravert stays full
    expect(prefix).toContain("## Quinn (quiet just now)"); // mid member compresses
  });
});

describe("character-fidelity voice + evolution blocks (slices 7-10)", () => {
  const anchors = { petPhrases: ["no promises", "be serious"], cadence: "clipped and dry; trails off when she deflects", neverSays: ["babe"] };

  it("renders voice anchors in the stable prefix AND a one-line re-anchor near generation (slice 7)", () => {
    const parts = promptParts({ profile: maraProfile({ voiceAnchors: anchors }) });
    // Prefix carries the concrete anchors…
    expect(parts.prefix).toContain("Your voice, concretely");
    expect(parts.prefix).toContain("no promises; be serious");
    expect(parts.prefix).toContain("clipped and dry; trails off when she deflects");
    expect(parts.prefix).toContain("babe");
    // …and the volatile tail carries the compact re-anchor beside the mood pin.
    expect(parts.tail).toContain("Voice check: sound like yourself this turn");
    expect(parts.tail).toContain("never babe");
  });

  it("omits both voice-anchor blocks when nothing is authored (prompt unchanged)", () => {
    const parts = promptParts();
    expect(parts.prefix).not.toContain("Your voice, concretely");
    expect(parts.tail).not.toContain("Voice check:");
  });

  it("renders the 'How you sound' voice-exemplar ring from state, past the summary horizon (slice 8)", () => {
    const prompt = systemPrompt({
      state: {
        meters: {},
        regard: 0,
        conditions: [],
        voiceExemplars: [
          { line: "Prague in spring — of course it is.", atClockMinutes: 30 },
          { line: "No promises.", atClockMinutes: 60 },
        ],
      },
    });
    expect(prompt).toContain("How you sound");
    expect(prompt).toContain("- Prague in spring — of course it is.");
    expect(prompt).toContain("- No promises.");
  });

  it("omits the voice ring when it is empty (prompt unchanged)", () => {
    const prompt = systemPrompt({
      state: chatState({ voiceExemplars: [] }),
    });
    expect(prompt).not.toContain("How you sound");
  });

  it("renders a one-turn character-consistency corrective from a slip note, and degrades to no line when absent (slice 9)", () => {
    const corrected = systemPrompt({
      state: chatState({ slipNote: "spoke like a therapist, not a teen — loosen the diction" }),
    });
    expect(corrected).toContain("Voice correction");
    expect(corrected).toContain("loosen the diction");
    // Absent / empty slip ⇒ no corrective line (the degraded default).
    const held = systemPrompt({
      state: chatState({ slipNote: "" }),
    });
    expect(held).not.toContain("Voice correction");
  });

  it("folds a persisted narrative trait overlay into the Disposition bands (slice 10)", () => {
    // Authored warmth is cold (creation-sourced); a narrative overlay (precedence > creation)
    // bends the evolved resting disposition so the Disposition block reads the arc, not the base.
    const evolved = systemPrompt({
      profile: maraProfile({ traits: [{ id: "temperament.warmth", value: -70, source: "creation" }] }),
      state: {
        meters: {},
        regard: 0,
        conditions: [],
        traitOverlays: [{ id: "temperament.warmth", value: 70, source: "narrative", note: "narrative arc" }],
      },
    });
    expect(evolved).toContain("Warmth: warm");
    expect(evolved).not.toContain("Warmth: cold");
  });
});

/**
 * The chat-lane intimate gate (contracts/turns/chat-intimacy.ts) — the port of the
 * session lane's exposure gate that intimacy-notes.plan.md recorded as a leftover.
 * Before it, `profile.intimacy` and the species archetype were authored, forge-drafted
 * and editable but never reached this lane at all.
 */
describe("the intimate disposition gate", () => {
  const lover = maraProfile({ intimacy: "Slow to start, and merciless once she is." });
  const closed = { meters: { arousal: 0.1 }, regard: 20, conditions: [], outfitExposed: false };
  const open = { meters: { arousal: 0.8 }, regard: 20, conditions: [], outfitExposed: false };

  it("emits nothing below the gate — zero tokens, not text the model is told to ignore", () => {
    const { prefix, tail } = promptParts({
      profile: lover,
      player: { name: "Theo", intimacy: "Wants to be taken care of." },
      state: closed,
    });
    expect(`${prefix}\n${tail}`).not.toContain("Slow to start");
    expect(`${prefix}\n${tail}`).not.toContain("taken care of");
    expect(`${prefix}\n${tail}`).not.toContain("Intimate disposition");
  });

  it("surfaces both notes once the scene earns it", () => {
    const { tail } = promptParts({
      profile: lover,
      player: { name: "Theo", intimacy: "Wants to be taken care of." },
      state: open,
    });
    expect(tail).toContain("Intimate disposition");
    expect(tail).toContain("How you are as a lover");
    expect(tail).toContain("Slow to start");
    expect(tail).toContain("What Theo responds to");
    expect(tail).toContain("taken care of");
  });

  it("opens on either party's coverage, not only arousal", () => {
    const byHer = promptParts({
      profile: lover,
      player: { name: "Theo" },
      state: { ...closed, outfitExposed: true },
    });
    expect(byHer.tail).toContain("Slow to start");

    const byHim = promptParts({
      profile: lover,
      player: { name: "Theo", exposed: true },
      state: closed,
    });
    expect(byHim.tail).toContain("Slow to start");
  });

  // character-fidelity slice 2: an authored minor surfaces no intimate text at all,
  // whatever the gate says — and that fence covers the player's note too, since the
  // block is about the two of them together.
  it("stays shut for an authored minor even with the gate wide open", () => {
    const { tail } = promptParts({
      profile: maraProfile({ age: "15", intimacy: "should never render" }),
      player: { name: "Theo", intimacy: "also should never render", exposed: true },
      state: { ...open, outfitExposed: true },
    });
    expect(tail).not.toContain("should never render");
    expect(tail).not.toContain("Intimate disposition");
  });

  it("renders the species archetype merged with the character's own note", () => {
    const { tail } = buildCharacterChatPromptParts({
      name: "Lys",
      profile: maraProfile({ speciesId: "succubus", intimacy: "Her own authored line." }),
      player: { name: "Theo" },
      state: open,
    });
    // The archetype is APPENDED with the character's own — both contribute (owner ruling
    // 2026-07-13), archetype first. This is the whole trio finally reaching the chat lane.
    expect(tail).toContain("Feeds on intimacy itself");
    expect(tail).toContain("Her own authored line.");
    expectOrder(tail, ["Feeds on intimacy itself", "Her own authored line."]);
  });

  it("renders a bare species archetype for a character with no note of their own", () => {
    const { tail } = buildCharacterChatPromptParts({
      name: "Lys",
      profile: maraProfile({ speciesId: "succubus" }),
      player: { name: "Theo" },
      state: open,
    });
    expect(tail).toContain("Feeds on intimacy itself");
  });

  it("a human with no authored note contributes nothing, however open the gate", () => {
    const { tail } = promptParts({
      profile: maraProfile({ speciesId: "human" }),
      player: { name: "Theo", intimacy: "Wants to be taken care of." },
      state: open,
    });
    // The player's note still stands on its own — the block isn't all-or-nothing.
    expect(tail).toContain("What Theo responds to");
    expect(tail).not.toContain("How you are as a lover");
  });

  it("emits nothing when the gate is open but nobody authored a note", () => {
    const { tail } = promptParts({
      player: { name: "Theo" },
      state: open,
    });
    expect(tail).not.toContain("Intimate disposition");
  });

  // The §9 cache layout: the gate flips with state, so its block MUST be volatile. If it
  // rode the prefix, every arousal tick past the threshold would bust the cached prompt.
  it("keeps the prefix byte-identical across a gate flip (cache-safe)", () => {
    const shut = promptParts({
      profile: lover,
      player: { name: "Theo", intimacy: "Wants to be taken care of.", wearing: "a coat" },
      state: closed,
    });
    const opened = promptParts({
      profile: lover,
      player: { name: "Theo", intimacy: "Wants to be taken care of.", wearing: "nothing at all", exposed: true },
      state: open,
    });
    expect(shut.prefix).toBe(opened.prefix);
    expect(shut.tail).not.toBe(opened.tail);
  });
});

describe("the intimate disposition gate (ensemble)", () => {
  /** This block's player states an intimacy preference — the gate is what reads it. */
  const wanting = (): CharacterChatPromptInput =>
    input({ player: { name: "Brian", intimacy: "Wants to be taken care of." } });

  const closed = { meters: { arousal: 0.1 }, regard: 0, conditions: [], outfitExposed: false };
  const open = { meters: { arousal: 0.9 }, regard: 0, conditions: [], outfitExposed: false };

  // The reason the gate is per-member and not per-scene: one couple in the room must not
  // hand every present character an intimate disposition.
  it("opens only for the member the scene actually turned intimate with", () => {
    const { tail } = buildChatPromptPartsForRoster(wanting(), [
      member("Mara", { profile: maraProfile({ intimacy: "Mara's note." }), state: open }),
      member("Sayed", { profile: maraProfile({ intimacy: "Sayed's note." }), state: closed }),
    ]);
    expect(tail).toContain("How Mara is as a lover");
    expect(tail).toContain("Mara's note.");
    expect(tail).not.toContain("Sayed's note.");
  });

  it("renders the player's note ONCE however many members qualified", () => {
    const { tail } = buildChatPromptPartsForRoster(wanting(), [
      member("Mara", { profile: maraProfile({ intimacy: "Mara's note." }), state: open }),
      member("Sayed", { profile: maraProfile({ intimacy: "Sayed's note." }), state: open }),
    ]);
    expect(tail).toContain("Mara's note.");
    expect(tail).toContain("Sayed's note.");
    expect(tail.split("What Brian responds to").length - 1).toBe(1);
  });

  it("stays shut for everyone when no member's scene is intimate", () => {
    const { tail } = buildChatPromptPartsForRoster(wanting(), [
      member("Mara", { profile: maraProfile({ intimacy: "Mara's note." }), state: closed }),
      member("Sayed", { profile: maraProfile({ intimacy: "Sayed's note." }), state: closed }),
    ]);
    expect(tail).not.toContain("Intimate disposition");
    expect(tail).not.toContain("taken care of");
  });

  it("an away member never contributes, even with their own gate open", () => {
    const { tail } = buildChatPromptPartsForRoster(wanting(), [
      member("Mara", { profile: maraProfile({ intimacy: "Mara's note." }), state: closed }),
      member("Sayed", { presence: "away", profile: maraProfile({ intimacy: "Sayed's note." }), state: open }),
    ]);
    expect(tail).not.toContain("Sayed's note.");
  });

  it("minor-fences per member — the adult's note still stands", () => {
    const { tail } = buildChatPromptPartsForRoster(wanting(), [
      member("Mara", { profile: maraProfile({ intimacy: "Mara's note." }), state: open }),
      member("Kit", { profile: maraProfile({ age: "15", intimacy: "never renders" }), state: open }),
    ]);
    expect(tail).toContain("Mara's note.");
    expect(tail).not.toContain("never renders");
  });
});
