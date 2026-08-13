import { describe, expect, it } from "vitest";
import { affordanceSubjectId, buildNpcSceneDigest, type NpcSceneDigest } from "@/contracts";
import { expectFenced } from "@/server/test-support";
import {
  buildChatNpcSceneDecisionPrompt,
  CHAT_NPC_SCENE_DECISION_SYSTEM,
} from "./chat-npc-scene-decision";

/**
 * The reply-scene classifier prompt (actor-control delivery step 3). Two
 * properties matter beyond ordinary rendering:
 *
 * - the CLOSED schema is described in the system prompt itself (the per-digest
 *   ref schemas are `z.custom` closures no rendered JSON Schema can express,
 *   so the prompt is the model's only account of the shape), and
 * - the user prompt speaks ONLY in digest-local refs — no database subject or
 *   contact id may ever reach the model, which is pinned here by building a
 *   digest from known ids and asserting their absence.
 */

const WREN = affordanceSubjectId("subject-wren-3f9a");
const VAELITH = affordanceSubjectId("subject-vaelith-77b2");
const PLAYER = affordanceSubjectId("player-subject-c41d");

function sampleDigest(): NpcSceneDigest {
  return buildNpcSceneDigest({
    playerSubjectId: PLAYER,
    roster: [
      { subjectId: WREN, name: "Wren", aliases: ["Wrennie"], presence: "present" },
      { subjectId: VAELITH, name: "Vaelith", aliases: [], presence: "away" },
    ],
    contacts: [
      {
        contactId: "contact-durable-8d21",
        actorSubjectId: WREN,
        actionKind: "affectionate",
        sourceSubjectId: WREN,
        sourceLocationId: "hands",
        targetSubjectId: PLAYER,
        targetLocationId: "shoulders",
      },
    ],
    proximity: [{ aSubjectId: WREN, bSubjectId: PLAYER, band: "close" }],
  }).digest;
}

describe("CHAT_NPC_SCENE_DECISION_SYSTEM", () => {
  it("describes the closed output schema: version 1, two nullable slots, verbatim evidence", () => {
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toContain('"version": 1');
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toContain('"movement"');
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toContain('"contact"');
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toMatch(/VERBATIM quote/);
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toMatch(/At most ONE movement and ONE contact/);
  });

  it("names propose-nothing as the expected common answer and forbids end proposals", () => {
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toMatch(/PROPOSING NOTHING is the expected, common answer/);
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toMatch(/Never propose an ending/);
  });

  it("derives the gesture and target-location vocabularies from the shared chat-contact vocabulary", () => {
    // The shared lists, not restatements: a vocabulary edit must reach this
    // prompt in the same change (chat-contact-vocabulary.ts is the one source).
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toContain("rest | pat | squeeze");
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toContain("shoulders");
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toContain("forearms");
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toContain("hair");
  });

  it("keeps completed-action discipline in the rules (intent/hedge/negation propose nothing)", () => {
    expect(CHAT_NPC_SCENE_DECISION_SYSTEM).toMatch(/Completed actions only/);
  });
});

describe("buildChatNpcSceneDecisionPrompt", () => {
  it("renders the digest by local refs — roster, presence, contacts, proximity — and fences the reply", () => {
    const prompt = buildChatNpcSceneDecisionPrompt({
      digest: sampleDigest(),
      reply: "Wren crosses the room and stops right beside you.",
    });
    expect(prompt).toContain('- npc_0: "Wren" (aliases: Wrennie) — present');
    expect(prompt).toContain('- npc_1: "Vaelith" — away');
    expect(prompt).toContain("- contact_0: npc_0's hands on player's shoulders (affectionate, started by npc_0)");
    // Canonical pair orientation: the player ranks first.
    expect(prompt).toContain("- player <-> npc_0: close");
    expectFenced(prompt, "assistant reply");
    expect(prompt).toContain("Wren crosses the room");
  });

  it("leaks NO database ids into the prompt text — refs are the only identity the model sees", () => {
    const prompt = buildChatNpcSceneDecisionPrompt({
      digest: sampleDigest(),
      reply: "She smiles.",
    });
    expect(prompt).not.toContain("subject-wren-3f9a");
    expect(prompt).not.toContain("subject-vaelith-77b2");
    expect(prompt).not.toContain("player-subject-c41d");
    expect(prompt).not.toContain("contact-durable-8d21");
  });

  it("stays coherent on an empty scene (no roster, no contacts, no proximity)", () => {
    const digest = buildNpcSceneDigest({
      playerSubjectId: PLAYER,
      roster: [],
      contacts: [],
      proximity: [],
    }).digest;
    const prompt = buildChatNpcSceneDecisionPrompt({ digest, reply: "The rain keeps falling." });
    expect(prompt).toContain("- (no non-player characters)");
    expect(prompt).toContain("Active contacts:\n- (none)");
    expect(prompt).toContain("Current proximity:\n- (none established)");
  });
});
