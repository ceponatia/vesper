import { describe, expect, it } from "vitest";
import { buildChatArchivistPrompt, CHAT_ARCHIVIST_SYSTEM } from "./chat-archivist";

describe("CHAT_ARCHIVIST_SYSTEM", () => {
  it("declares thirteen fields and carries a worked example for each rare field", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toContain("thirteen fields");
    // The attributeChanges micro-example (C6 — the haircut) so the proposer stops under-firing.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"attributeId":"hair.length"');
    // Both examples carry every field, so the model sees the full shape.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"openLoops":[]');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"attributeChanges":[]');
  });

  it("declares the voice/consistency/trait fields (character-fidelity slices 8-10) with a full-shape example", () => {
    // Fields 11-13 are declared with their rare-firing discipline.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"voiceExemplar": ONE short line/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"characterSlip": a SHORT corrective note ONLY when the reply broke character/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"traitShifts": RARE, direction-only nudges/);
    // The first worked example (Prague) now showcases all three so the model sees the full shape.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"voiceExemplar":"Prague in spring');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"characterSlip":""');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"traitShifts":[]');
  });

  it("renders the voice reference + developable-traits blocks only when armed (slices 7+9, 10)", () => {
    // 1-on-1 with no voice/trait arming ⇒ neither block renders.
    const bare = buildChatArchivistPrompt({
      characterName: "Mara",
      playerName: "Brian",
      exchange: { player: "hi", assistant: "hello" },
    });
    expect(bare).not.toContain("Character voice reference");
    expect(bare).not.toContain("Developable traits");
    // Armed ⇒ both render, the voice reference fenced (author-written), traits by exact id + band.
    const armed = buildChatArchivistPrompt({
      characterName: "Mara",
      playerName: "Brian",
      exchange: { player: "hi", assistant: "hello" },
      voiceReference: {
        petPhrases: ["no promises"],
        cadence: "clipped and dry",
        neverSays: ["babe"],
        registerRule: "Mara is 15; keep her diction age-true.",
      },
      developableTraits: [{ id: "temperament.warmth", label: "Warmth", band: "cold" }],
    });
    expect(armed).toContain("Character voice reference (for fields 11-12");
    expect(armed).toContain("Pet phrases: no promises");
    expect(armed).toContain("Cadence: clipped and dry");
    expect(armed).toContain("Never says: babe");
    expect(armed).toContain("Age/register: Mara is 15");
    expect(armed).toContain("Developable traits (for field 13 — use these exact ids):");
    expect(armed).toContain("- temperament.warmth (currently cold)");
  });

  it("declares the supporting-cast field with its exclusions (chat-supporting-cast.plan.md)", () => {
    // Named recurring people only — never walk-ons, the main characters, or the player.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"cast": recurring NAMED side characters/);
    expect(CHAT_ARCHIVIST_SYSTEM).toContain("never one-scene walk-ons");
    // The worked example (Abby) shows the full shape.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"cast":[{"name":"Abby"');
    // The known-cast list renders only once someone exists, fenced.
    const bare = buildChatArchivistPrompt({
      characterName: "Mara",
      playerName: "Brian",
      exchange: { player: "hi", assistant: "hello" },
    });
    expect(bare).not.toContain("Supporting cast so far");
    const known = buildChatArchivistPrompt({
      characterName: "Mara",
      playerName: "Brian",
      exchange: { player: "hi", assistant: "hello" },
      supportingCast: [{ name: "Abby", relation: "the player's coworker" }],
    });
    expect(known).toContain("Supporting cast so far");
    expect(known).toContain("- Abby — the player's coworker");
  });

  it("teaches the storyteller-narration label (narrator-mode input)", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toContain("STORYTELLER NARRATION");
    expect(CHAT_ARCHIVIST_SYSTEM).toContain("never record the player as having said or done what it merely narrates");
  });

  it("declares the roster-gated presence field (multi-character-chat.plan.md slice 3)", () => {
    // Only armed by a Roster line; only real transitions, never inferred from silence.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"presence": ONLY when a "Roster" line/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/never infer one from silence/);
    // The 1-on-1 prompt renders no Roster line; a real roster does, with live presence.
    const solo = buildChatArchivistPrompt({
      characterName: "Mara",
      playerName: "Brian",
      exchange: { player: "hi", assistant: "hello" },
    });
    expect(solo).not.toContain("Roster");
    const group = buildChatArchivistPrompt({
      characterName: "Mara",
      playerName: "Brian",
      exchange: { player: "hi", assistant: "hello" },
      roster: [
        { name: "Mara", presence: "present" },
        { name: "Vera", presence: "away" },
      ],
    });
    expect(group).toContain("Roster (for field 9 — match names exactly): Mara (present), Vera (away)");
  });

  it("declares the optional outfit field with a worked example (chat-scene-fidelity slice 1)", () => {
    // Full-replacement semantics, change-gated, undressing included, player excluded.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"outfit": what the character is WEARING, only when this exchange CHANGED it/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/a full replacement, never a delta/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/Undressing counts/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/Never record the player's clothing/);
    // The dressed-for-dinner example shows the populated shape; the others show the {} no-op.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"outfit":{"description":"a black wrap dress and low heels, hair pinned up","exposed":false}');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"outfit":{}');
  });

  it("declares the optional scene field and carries a worked scene example (chat scene memory)", () => {
    // The scene field is described and gated to only established/changed settings.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"scene":/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/chat locations are imagined by the narrator/i);
    // A populated example shows current place + time of day + a durable detail + a connection.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"current":"kitchen"');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"details":["blue-tiled counter"');
    // Non-scene exchanges emit an empty object.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"scene":{}');
  });

  it("instructs full-list-each-time open loops (spec §6.2)", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/re-emit the full list/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/drop any this exchange resolved/i);
  });

  it("asserts the state-agent exemption: reads narration + interiority, not just what the character perceives (player-input-perception.plan.md slice 3)", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/read the player's entire message/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/narration and inner thoughts/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/not only what the character could perceive/i);
  });

  it("teaches the fact channel: perceived vs private, and skip OOC (player-input-perception.plan.md slice 6)", () => {
    // The facts field lists the channel key, the rule defines the vocabulary, and OOC is dropped.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"channel" one of perceived\|private/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/quoted speech or a visible action/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/unspoken inner thoughts/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/double parentheses.*record no facts/is);
    // Both worked examples carry an explicit channel so the model sees the full shape.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"channel":"perceived"');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"channel":"private"');
  });
});

describe("buildChatArchivistPrompt", () => {
  const base = {
    characterName: "Mara",
    playerName: "Theo",
    exchange: { player: "Tell me about your sister.", assistant: "[Mara] \"Later. I promise.\"" },
  };

  it("fences the exchange and renders prior open loops for carry-forward", () => {
    const prompt = buildChatArchivistPrompt({ ...base, openLoops: ["tell Theo about her sister"] });
    expect(prompt).toContain("Currently open loops:");
    expect(prompt).toContain("- tell Theo about her sister");
    expect(prompt).toContain("Tell me about your sister.");
  });

  it("renders '(none)' when no loops are open (prompt shape stays stable)", () => {
    const prompt = buildChatArchivistPrompt(base);
    expect(prompt).toContain("Currently open loops:\n(none)");
  });

  it("adds a parser-derived channel hint when the player marks a private thought (slice 6)", () => {
    const prompt = buildChatArchivistPrompt({
      ...base,
      exchange: { player: '"Hey." *God, I hope she says yes.*', assistant: base.exchange.assistant },
    });
    expect(prompt).toContain("Channel notes (the player used notation this message):");
    expect(prompt).toMatch(/private thought/i);
    expect(prompt).toContain('"channel":"private"');
  });

  it("adds an OOC hint that forbids storing facts from a ((direction)) span (slice 6)", () => {
    const prompt = buildChatArchivistPrompt({
      ...base,
      exchange: { player: "((skip ahead to the next morning))", assistant: base.exchange.assistant },
    });
    expect(prompt).toMatch(/double-parenthesized.*record NO fact/is);
  });

  it("omits the channel hint entirely when the player used no thought/OOC notation (the common case)", () => {
    const prompt = buildChatArchivistPrompt({
      ...base,
      exchange: { player: '"Tell me about your sister." I lean in.', assistant: base.exchange.assistant },
    });
    expect(prompt).not.toContain("Channel notes");
  });
});
