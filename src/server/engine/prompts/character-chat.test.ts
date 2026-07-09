import { describe, expect, it } from "vitest";
import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import type { AttributeValue } from "@/contracts/attributes/value";
import { buildCharacterChatPromptParts, buildCharacterChatSystemPrompt, chatNotationNote } from "./character-chat";

const attr = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue => ({ id, value, source: "creation" });

function profile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    ...emptyCharacterProfile(),
    bio: "A harbor-town glassblower with salt in her hair.",
    personality: "Wry, guarded, fiercely loyal once you earn it.",
    voice: "Low and dry, with a coastal lilt.",
    age: "29",
    attributes: [
      attr("identity.apparent_age", "late twenties"),
      attr("identity.gender", "female"),
      attr("hair.color", "auburn"),
      attr("voice.pitch", "low"),
      attr("voice.cadence", "measured"),
    ],
    ...overrides,
  };
}

describe("buildCharacterChatSystemPrompt", () => {
  it("embodies the named character and surfaces identity, personality, and voice", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("You are Mara");
    // Identity block carries the real age (profile field), not the apparent-age attribute.
    expect(prompt).toContain("You are 29 years old.");
    expect(prompt).not.toContain("late twenties");
    expect(prompt).toContain("Wry, guarded, fiercely loyal");
    expect(prompt).toContain("Low and dry, with a coastal lilt.");
    expect(prompt).toContain("A harbor-town glassblower");
  });

  it("renders resolved attribute values, never raw ids", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("auburn");
    expect(prompt).not.toContain("hair.color");
    expect(prompt).not.toContain("voice.pitch");
  });

  it("includes registry promptHints as deduped phrasing guidance", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("Phrasing guidance:");
  });

  it("surfaces the authored personality sliders as a binding Disposition block", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile({
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
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile({ traits: [] }) });
    expect(prompt).not.toContain("Disposition (your standing temperament");
  });

  it("carries the in-character + dialogue-tag rules", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("Stay fully in character as Mara");
    expect(prompt).toContain('[Mara]');
    expect(prompt).toMatch(/never mention being an AI/i);
  });

  it("relaxes the dialogue tag to optional (renderer-owned attribution) and keeps dialogue quoted", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    // Dialogue still goes in quotes, but the [Name] tag is now optional in the 1-on-1…
    expect(prompt).toMatch(/spoken dialogue always goes in quotes/i);
    expect(prompt).toMatch(/\[Mara\] tag is optional/i);
    expect(prompt).toMatch(/attributes Mara's dialogue automatically/i);
    // …and the old "start EVERY line with the tag" mandate is gone.
    expect(prompt).not.toContain("Start every line of Mara's spoken dialogue with the tag");
  });

  it("licenses flavor NPCs to speak in narration prose, reserving bracketed tags for the character", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toMatch(/Incidental people in the scene/i);
    expect(prompt).toMatch(/never a \[bracketed\] tag/i);
    expect(prompt).toContain("bracketed tags belong to Mara alone");
  });

  it("fixes a third-person viewpoint: character in third person, player as 'you', first person only in quotes", () => {
    const withPlayer = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), player: { name: "Theo" } });
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
    const faceless = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(faceless).toMatch(/narrate in the third person/i);
    expect(faceless).toMatch(/never as "I"\/"me"/);
  });

  it("grants the mature-content license the sessionless chat otherwise lacks", () => {
    // The session engine licenses explicit content via world directives + exposure
    // rules; the chat carries neither, so the prompt must state the frame itself or
    // safety-aligned narrators refuse and break character. See character-chat.ts.
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toMatch(/adult interactive fiction/i);
    expect(prompt).toMatch(/sexually explicit content (are|is) fully in scope/i);
  });

  it("forbids breaking character to refuse, and routes a 'no' through the character", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toMatch(/never break character to refuse/i);
    expect(prompt).toMatch(/play it as Mara's own in-world choice/i);
  });

  it("adopts the shape profiles, replacing the fixed paragraph target", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).not.toContain("one or two short paragraphs");
    // The default (concise_immersive) profile drives chat length too.
    expect(prompt).toContain("Write one focused beat per turn");
  });

  it("makes the aggressive_concise shape selectable in chat and distinct", () => {
    const aggressive = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), narrationShape: "aggressive_concise" });
    const concise = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), narrationShape: "concise_immersive" });
    expect(aggressive).toContain("Be brief and tightly scoped");
    expect(aggressive).not.toContain("Write one focused beat per turn");
    expect(aggressive).not.toBe(concise);
  });

  it("carries the proportionate-reaction + stay-in-voice chat rules", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("React in proportion");
    expect(prompt).toContain("affection is earned, not automatic");
    expect(prompt).toContain("Stay in your own voice and the current topic");
  });

  it("introduces no hard length cap in the chat lane for either shape profile", () => {
    const cap = /\d+\s+(characters|tokens|words|lines|sentences|paragraphs)/;
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), narrationShape: "concise_immersive" })).not.toMatch(cap);
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), narrationShape: "aggressive_concise" })).not.toMatch(cap);
  });

  it("skips unknown attribute vocabulary instead of leaking it", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile({ attributes: [attr("identity.gender", "female"), attr("face.nonexistent_trait", "whatever")] }),
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
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), priorSummary: recap });
    expect(prompt).toContain("Earlier in this conversation");
    expect(prompt).toContain("The user is Theo.");
    // The recap changes as the summary folds, so it rides the volatile tail BELOW the
    // stable rules (spec §9 prompt-cache layout).
    expect(prompt.indexOf("Earlier in this conversation")).toBeGreaterThan(prompt.indexOf("How to respond:"));
  });

  it("omits the recap block entirely when there is no prior summary (prompt unchanged)", () => {
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() })).not.toContain(
      "Earlier in this conversation",
    );
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), priorSummary: "   " })).not.toContain(
      "Earlier in this conversation",
    );
  });

  it("surfaces retrieved RAG memory (facts + episodes) as a recall block (spec §2)", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      memory: {
        facts: ["The player's sister is getting married in Prague."],
        episodes: ["They argued about the harbor job, then made up."],
      },
    });
    expect(prompt).toContain("Your memory");
    expect(prompt).toContain("The player's sister is getting married in Prague.");
    expect(prompt).toContain("They argued about the harbor job, then made up.");
    // Recall is per-turn volatile, so it rides the tail below the stable rules (spec §9).
    expect(prompt.indexOf("Your memory")).toBeGreaterThan(prompt.indexOf("How to respond:"));
  });

  it("omits the memory block when nothing was retrieved (prompt unchanged)", () => {
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() })).not.toContain("Your memory");
    expect(
      buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), memory: { facts: [], episodes: [] } }),
    ).not.toContain("Your memory");
  });

  it("resolves a persisted narrative attribute overlay on top of the authored base (spec §3)", () => {
    // The authored base is `creation`-sourced (hair.color: auburn); a `narrative` overlay
    // outranks it (SOURCE_PRECEDENCE narrative > creation), exactly as the session lane.
    const overlaid = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
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
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      player: { name: "Theo", persona: "A traveling cartographer, easy to talk to." },
    });
    expect(prompt).toContain("speaking with Theo");
    expect(prompt).toContain("About Theo (the person you're speaking with)");
    expect(prompt).toContain("A traveling cartographer");
    expect(prompt).toContain("talking with Theo");
    expect(prompt).not.toContain("speaking with the user");
  });

  it("uses the player name without a persona block when no bio is given", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), player: { name: "Theo" } });
    expect(prompt).toContain("speaking with Theo");
    expect(prompt).not.toContain("the person you're speaking with");
  });

  it("keeps the faceless 'the user' phrasing when no player is given (prompt unchanged)", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("speaking with the user");
    expect(prompt).toContain('Address the user directly as "you"');
  });

  it("is byte-identical when the state block is absent (existing behavior)", () => {
    const withoutState = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    // An empty state (rested, neutral, no premise) adds nothing notable.
    const withEmptyState = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [] },
    });
    expect(withEmptyState).toBe(withoutState);
    expect(withoutState).not.toContain("Your current state");
    expect(withoutState).not.toContain("Scenario for this chat");
  });

  it("renders mood + mindNote in the Current state block; the regard steer is the composed Relationship block (§7.1)", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
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
    expect(prompt.indexOf("Your current state")).toBeGreaterThan(prompt.indexOf("How to respond:"));
  });

  it("surfaces a crossed meter threshold (drift made visible)", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: { ...{ hygiene: 0.2 }, mood: 0.5, energy: 0.9 }, regard: 0, conditions: [] },
    });
    expect(prompt).toMatch(/unwashed/i);
  });

  it("renders the premise as a prominent scenario block, above the response rules; empty ⇒ no block", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [], premise: "It's the night before she moves away forever." },
    });
    expect(prompt).toContain("Scenario for this chat");
    expect(prompt).toContain("the night before she moves away");
    expect(prompt.indexOf("Scenario for this chat")).toBeLessThan(prompt.indexOf("How to respond:"));

    const noPremise = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [], premise: "   " },
    });
    expect(noPremise).not.toContain("Scenario for this chat");
  });

  it("adds an opening-beat instruction only when opening is set", () => {
    const opening = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), opening: true });
    expect(opening).toMatch(/Opening beat/);
    expect(opening).toMatch(/Begin the conversation yourself/);
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() })).not.toContain("Opening beat");
  });

  // --- Opportunistic sensory cues (character-chat-sensory.plan.md) ---

  it("surfaces presentation.scent_baseline as a closeness-gated Sensory cues block, not a flat attribute line", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Sabrina",
      profile: profile({
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
    expect(prompt.indexOf("Sensory cues")).toBeLessThan(prompt.indexOf("soft floral perfume"));
    // Ordinary physical attributes still render in Attributes as before.
    expect(prompt).toContain("auburn");
    // The exposure-mask phrasing hint (meaningless without a chat exposure mask) is dropped.
    expect(prompt).not.toContain("exposure mask's scent range");
  });

  it("states the restraint discipline: opportunistic, closeness-gated, never listed — and a CHAT rule reinforces it", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Sabrina",
      profile: profile({ attributes: [attr("presentation.scent_baseline", "soft floral perfume")] }),
    });
    expect(prompt).toMatch(/use only when the beat earns them/i);
    expect(prompt).toMatch(/proximity, touch, intimacy, a first impression/i);
    expect(prompt).toMatch(/never recite a label/i);
    expect(prompt).toMatch(/Do not force sensory detail into ordinary, distant conversation/i);
    // Never a checklist / mandatory.
    expect(prompt).not.toMatch(/always (mention|include|describe|note)[^.]{0,24}(scent|smell)/i);
  });

  it("keeps voice (audible at distance) and physical attributes in Attributes, never the sensory cues", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile({
        attributes: [
          attr("hair.color", "auburn"),
          attr("voice.pitch", "low"),
          attr("presentation.scent_baseline", "soft floral perfume"),
        ],
      }),
    });
    // Voice is sensory but perceptible at any distance — it stays a normal attribute line.
    expect(prompt).toContain("pitch: low");
    const sectionStart = prompt.indexOf("Sensory cues");
    const sectionEnd = prompt.indexOf("\n\n", sectionStart);
    const cueBlock = prompt.slice(sectionStart, sectionEnd);
    expect(cueBlock).toContain("soft floral perfume");
    expect(cueBlock).not.toContain("pitch");
  });

  it("does not promote intimate scent/taste into ordinary chat sensory cues", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Sabrina",
      profile: profile({
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
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() })).not.toContain("Sensory cues");
  });
});

describe("buildCharacterChatSystemPrompt — player-input perception (player-input-perception.plan.md slice 1)", () => {
  const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), player: { name: "Theo" } });

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
    expect(prompt).toContain("Respond directly to what Mara just heard and saw");
    // The old everything-is-said-at-you framing is gone.
    expect(prompt).not.toContain("said or did to Mara — react to it");
  });

  it("keeps the partition in the faceless (no-player) variant too", () => {
    const faceless = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(faceless).toContain("Reading the player's message (what Mara can actually perceive):");
    expect(faceless).toMatch(/self-talk the user writes into that narration reach no one/);
  });
});

describe("buildCharacterChatSystemPrompt — message-notation legend (player-input-perception.plan.md slice 4)", () => {
  const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), player: { name: "Theo" } });

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

  it("lives in the stable prefix and stays byte-identical across turns (cache-safe)", () => {
    const t1 = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      player: { name: "Theo" },
      state: { meters: { mood: 0.9 }, regard: 20, conditions: [] },
    });
    const t2 = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      player: { name: "Theo" },
      state: { meters: { mood: 0.1 }, regard: 22, conditions: [], mindNote: "different" },
    });
    expect(t1.prefix).toContain("Message notation Theo may use");
    expect(t1.prefix).toBe(t2.prefix);
  });

  it("falls back to a 'Name' placeholder in the faceless (no-player) variant", () => {
    const faceless = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
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
    const withNote = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      player: { name: "Theo" },
      notationNote: note,
    });
    const without = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), player: { name: "Theo" } });
    expect(withNote.prefix).toBe(without.prefix); // derived note never busts the prefix cache
    expect(withNote.tail).toContain("is texting you");
    expect(without.tail).not.toContain("is texting you");
  });
});

describe("buildCharacterChatSystemPrompt — player-POV narration (chat-narrator-pov.plan.md)", () => {
  const withPlayer = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), player: { name: "Theo" } });
  const faceless = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });

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

  it("adds the attention/motion-gated visual rule (show, don't inventory)", () => {
    expect(withPlayer).toContain("Show, don't inventory");
    expect(withPlayer).toMatch(/give one concrete visual detail from Theo's eye/);
    expect(withPlayer).toContain("Sight carries at any distance.");
    expect(withPlayer).toMatch(/never a head-to-toe description, never repeated for an unchanged look/);
  });

  it("reframes Attributes as shared identity + appearance data", () => {
    expect(withPlayer).toContain("Attributes (who you are, and what Theo sees of you");
    expect(faceless).toContain("Attributes (who you are, and what the user sees of you");
  });

  it("words the closeness sensory rule as sensation landing in the player's senses", () => {
    expect(withPlayer).toMatch(/written as it lands in Theo's senses \(the scent that reaches them, the warmth they feel\)/);
  });

  it("invites showing the outfit when movement or attention makes it noticeable", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [], outfit: "a slate-blue dress with a slit up one side" },
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
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), state: drunkMeters });
    expect(prompt).toContain("Right now this is shifting");
    expect(prompt).toContain("Drunk:"); // the intoxication >0.7 threshold hint
  });

  it("does not re-foreground a band already surfaced last turn — it rides as standing coloring", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { ...drunkMeters, surfacedCues: { intoxication: "intoxication:0.7" } },
    });
    expect(prompt).not.toContain("Right now this is shifting");
    expect(prompt).toContain("Your current state");
    expect(prompt).toContain("Drunk:"); // still colors, just not re-announced
  });

  it("overlays an active condition's attributeEffects onto the attributes (grooming → unkempt)", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
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
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile({ attributes: [attr("eyes.color", "grey")] }),
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
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
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
    const sober = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile({ traits }),
      state: { meters: { intoxication: 0 }, regard: 0, conditions: [] },
    });
    const drunk = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile({ traits }),
      state: { meters: { intoxication: 0.9 }, regard: 0, conditions: [] },
    });
    expect(sober).toContain("Disposition");
    expect(drunk).toContain("Disposition");
    expect(drunk).not.toEqual(sober); // the guardedness band reads lower when drunk
  });
});

describe("buildCharacterChatPromptParts — prompt-cache layout (spec §9)", () => {
  it("keeps the prefix byte-identical across consecutive turns with unchanged authored inputs", () => {
    const turn1 = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
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
    const turn2 = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
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
      buildCharacterChatPromptParts({
        name: "Mara",
        profile: profile(),
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
    const parts = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
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
    const curt = profile({ traits: [{ id: "temperament.warmth", value: -60, source: "base" as const }] });
    const at = (p: ReturnType<typeof profile>, regard: number) =>
      buildCharacterChatPromptParts({
        name: "Mara",
        profile: p,
        state: { meters: {}, regard, conditions: [] },
      }).prefix;
    expect(at(curt, 57)).toContain("one of the few exceptions"); // curt generally, warm to YOU
    expect(at(curt, -25)).not.toContain("one of the few exceptions"); // signs agree — no line
    expect(at(profile(), 57)).not.toContain("one of the few exceptions"); // no authored lean — no line
  });

  it("states the D11 gate invariants in the law block: premise wins, disinhibition never moves the line, values outrank", () => {
    const parts = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [] },
    });
    expect(parts.prefix).toMatch(/the scenario wins/i);
    expect(parts.prefix).toMatch(/never moves this line/i);
    expect(parts.prefix).toMatch(/never a meta refusal/i);
    expect(parts.prefix).toMatch(/outranks everything/i);
  });

  it("renders the pending skip note as a volatile one-turn tail line (spec §8.1)", () => {
    const withSkip = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [], skipNote: "The night has passed — it's the next morning. Acknowledge the gap naturally, once." },
    });
    const without = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [] },
    });
    expect(withSkip.prefix).toBe(without.prefix); // volatile — never busts the cached prefix
    expect(withSkip.tail).toContain("Time has passed in the story");
    expect(withSkip.tail).toContain("next morning");
    expect(without.tail).not.toContain("Time has passed in the story");
  });

  it("joins prefix + tail into the full system prompt", () => {
    const input = { name: "Mara", profile: profile(), priorSummary: "You met at the night market." };
    const parts = buildCharacterChatPromptParts(input);
    expect(parts.tail).not.toBe("");
    expect(buildCharacterChatSystemPrompt(input)).toBe(`${parts.prefix}\n\n${parts.tail}`);
  });

  it("ends the stable prefix with the rules and keeps every volatile in the tail", () => {
    const parts = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
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
    const sober = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile({ traits }),
      state: { meters: { intoxication: 0 }, regard: 0, conditions: [] },
    });
    const drunk = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile({ traits }),
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
    const withCondition = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [condition] },
    });
    const without = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [] },
    });
    expect(withCondition.prefix).toBe(without.prefix);
    expect(withCondition.prefix).not.toContain("unkempt");
    expect(withCondition.tail).toContain("While your current condition lasts");
    expect(withCondition.tail).toContain("unkempt");
  });

  it("renders open loops as an Unfinished-business state line in the tail (spec §6.2)", () => {
    const withLoops = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [], openLoops: ["tell them about her sister", "the unopened letter"] },
    });
    expect(withLoops.tail).toContain("Unfinished business between you: tell them about her sister; the unopened letter");
    expect(withLoops.tail).toContain("never recite the list");
    const without = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [], openLoops: [] },
    });
    expect(without.prefix).toBe(withLoops.prefix); // loops are volatile — never in the prefix
    expect(without.tail).not.toContain("Unfinished business");
  });

  it("carries the dialogue-craft rule and the intimate-craft block in the stable rules (C3/C4)", () => {
    const parts = buildCharacterChatPromptParts({ name: "Mara", profile: profile() });
    expect(parts.prefix).toContain("Dialogue is speech, not prose");
    expect(parts.prefix).toContain("the truest answer is no words at all");
    expect(parts.prefix).toContain("When a scene turns intimate:");
    expect(parts.prefix).toContain("Hold escalation to the player's pace");
    expect(parts.prefix).toContain("Keep body and clothing continuity");
    expect(parts.prefix).toContain("concrete sensation");
  });
});

describe("buildCharacterChatSystemPrompt — turn grammar (deliverable A)", () => {
  const parts = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), player: { name: "Theo" } });

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
    const parts = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
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
    const parts = buildCharacterChatPromptParts({ name: "Mara", profile: profile() });
    expect(parts.tail).toContain("Response shape: respond to what the user just said and did");
    expect(parts.tail).not.toContain("Mood:");
  });

  it("is suppressed on an opening beat (no player input to respond to)", () => {
    const opening = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), opening: true });
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
      timeOfDay: "early evening",
      places: [{ name: "the living room", details: ["blue sofa", "tall windows"], connections: ["kitchen through the doorway"] }],
    },
  };

  it("renders the current place, details, time of day, and connections", () => {
    const parts = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), state: sceneState });
    expect(parts.tail).toContain("Scene (the setting established so far");
    expect(parts.tail).toContain("- Here: the living room — blue sofa; tall windows");
    expect(parts.tail).toContain("- Time of day: early evening");
    expect(parts.tail).toContain("- Nearby: kitchen through the doorway");
  });

  it("directs restraint on an unchanged scene, and re-establishment when it just changed", () => {
    const unchanged = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), state: sceneState });
    expect(unchanged.tail).toContain("Do not re-establish the setting; at most one fresh accent");
    const changed = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), state: sceneState, sceneChanged: true });
    expect(changed.tail).toContain("This scene just changed — establish the new setting");
  });

  it("rides the volatile tail (never busts the cached prefix) and renders nothing when empty & unchanged", () => {
    const withScene = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), state: sceneState });
    const without = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), state: { meters: {}, regard: 0, conditions: [] } });
    expect(withScene.prefix).toBe(without.prefix); // scene memory is volatile — prefix unchanged
    expect(without.tail).not.toContain("Scene (the setting established");
    // Empty memory but the scene just changed (a bare move) still steers re-establishment.
    const changedEmpty = buildCharacterChatPromptParts({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, regard: 0, conditions: [], sceneMemory: { current: "the porch", places: [{ name: "the porch", details: [], connections: [] }] } },
      sceneChanged: true,
    });
    expect(changedEmpty.tail).toContain("- Here: the porch");
    expect(changedEmpty.tail).toContain("establish the new setting");
  });
});

describe("buildCharacterChatSystemPrompt — sensory focus block (scope guard)", () => {
  const scented = profile({
    attributes: [attr("identity.gender", "female"), attr("presentation.scent_baseline", "cedar and warm skin")],
  });

  it("assembles authored scent + hygiene band for a smell/taste beat, in the tail", () => {
    const parts = buildCharacterChatPromptParts({
      name: "Mara",
      profile: scented,
      player: { name: "Theo" },
      state: { meters: { hygiene: 0.2 }, regard: 0, conditions: [] },
      sensoryFocus: { sense: "smell", target: "hair", intimate: false },
    });
    expect(parts.tail).toContain("Sensory focus — Theo is breathing in Mara's hair.");
    expect(parts.tail).toContain("cedar and warm skin");
    expect(parts.tail).toMatch(/unwashed/i); // the low-hygiene band layered over the scent
    expect(parts.tail).toContain("never contradict their theme");
    expect(parts.prefix).not.toContain("Sensory focus"); // volatile
  });

  it("surfaces an intimate attribute only when the beat targets intimate anatomy the character has", () => {
    const intimateProfile = profile({
      intimateRegions: ["breasts"],
      attributes: [attr("identity.gender", "female"), attr("breasts.size", "full")],
    });
    const earned = buildCharacterChatPromptParts({
      name: "Mara",
      profile: intimateProfile,
      player: { name: "Theo" },
      state: { meters: {}, regard: 0, conditions: [] },
      sensoryFocus: { sense: "touch", target: "breasts", intimate: true },
    });
    expect(earned.tail).toContain("Sensory focus — Theo is touching Mara's breasts.");
    // A non-intimate focus never surfaces the intimate attribute.
    const notEarned = buildCharacterChatPromptParts({
      name: "Mara",
      profile: intimateProfile,
      player: { name: "Theo" },
      state: { meters: {}, regard: 0, conditions: [] },
      sensoryFocus: { sense: "study", target: "dress", intimate: false },
    });
    expect(notEarned.tail).not.toMatch(/breasts.*full/i);
  });
});

describe("buildCharacterChatSystemPrompt — reply-discipline gate notes (deliverable D)", () => {
  it("passes the pre-computed gate notes through to the volatile tail", () => {
    const note = "Your recent replies ended in questions — end this one differently unless the moment truly demands one.";
    const parts = buildCharacterChatPromptParts({ name: "Mara", profile: profile(), gateNotes: note });
    expect(parts.tail).toContain(note);
    const without = buildCharacterChatPromptParts({ name: "Mara", profile: profile() });
    expect(without.prefix).toBe(parts.prefix); // gate notes are volatile
    expect(without.tail).not.toContain("ended in questions");
  });
});
