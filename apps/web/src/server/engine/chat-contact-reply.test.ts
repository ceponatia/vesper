import { describe, expect, it } from "vitest";
import {
  activeContactsOf,
  adapterSupported,
  affordanceSubjectId,
  emptyEffectiveCoverageRead,
  emptySceneState,
  sceneEventRef,
  withSceneContacts,
  type AffordanceSubjectId,
  type SceneState,
} from "@/contracts";
import { chatContactEventRef, CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import { planChatContactTurn } from "./chat-contact-adapter";
import { seededChatScene } from "./chat-contact/scene";
import type { ChatContactRosterMember } from "./chat-contact/input-evidence";
import {
  applyChatNpcContactEnding,
  chatReplyContactEventRef,
  detectChatNpcContactEnding,
  type ChatNpcEndingCharacter,
} from "./chat-contact-reply";

/**
 * The reply-side NPC contact ending — the PURE half.
 *
 * Organised like the adapter's own suite: the vetoes first, because every one of
 * them stops a durable end row for a contact the prose did not clearly break —
 * an invented NPC action is the exact failure the actor-control law exists to
 * prevent, from the other direction. Then the allow-list, subject resolution,
 * the fold, and identity. The durable half (rows, retake prune, the settle
 * ordering) is the integration suite's.
 */

const WREN = affordanceSubjectId("character_wren");
const VAEL = affordanceSubjectId("character_vaelith");

const npc = (subjectId: AffordanceSubjectId, name: string, aliases: readonly string[] = []): ChatNpcEndingCharacter => ({
  subjectId,
  name,
  aliases,
});

const SOLO: readonly ChatNpcEndingCharacter[] = [npc(WREN, "Wren Vale")];
const PAIR: readonly ChatNpcEndingCharacter[] = [npc(WREN, "Wren Vale"), npc(VAEL, "Vaelith")];

function detect(reply: string, characters: readonly ChatNpcEndingCharacter[] = SOLO) {
  return detectChatNpcContactEnding({ reply, characters });
}

describe("the vetoes — a sentence that does not clearly end a contact ends nothing", () => {
  it.each([
    ["a negation", "She doesn't pull away."],
    ["a longer negation", "She never pulls away from your hand."],
    ["a hedge", "She might pull away."],
    ["an intention", "She wants to pull away."],
    ["a hypothetical", "If she pulls away, the moment breaks."],
    ["a question", "Does she pull away?"],
    ["mere discomfort", "Her shoulders tense under your palm, her breath unsteady."],
    ["an unrelated movement", "She reaches for the teapot and refills your cup."],
    ["an unrelated emotional beat", "She laughs, shaking her head at the story."],
  ])("%s produces no ending", (_label, reply) => {
    expect(detect(reply)).toBeNull();
  });

  it("quoted dialogue is a voice, not a body — straight or curly quotes", () => {
    expect(detect('"Don\'t pull away," she murmurs.')).toBeNull();
    expect(detect("“Don’t pull away,” she murmurs.")).toBeNull();
    // A quoted command with no negation either: dialogue never moves a body.
    expect(detect('"Step away from the window," she says.')).toBeNull();
  });

  it("romantic framing vetoes the whole sentence — an ending is never a reinterpretation", () => {
    expect(detect("She pulls away and kisses your cheek.")).toBeNull();
  });

  it("an empty reply and an empty roster produce nothing", () => {
    expect(detect("")).toBeNull();
    expect(detect("She pulls away.", [])).toBeNull();
  });
});

describe("the allow-list — conservative explicit endings", () => {
  it.each([
    ["She eases out from beneath your hand.", "withdrawn"],
    ["She shrugs out from under your hand.", "withdrawn"],
    ["She slips free from under your palm.", "withdrawn"],
    ["She pulls away.", "withdrawn"],
    ["She draws back, folding her arms.", "withdrawn"],
    ["She gently lifts your hand away.", "withdrawn"],
    ["She removes your hand.", "withdrawn"],
    ["She takes your hand off her shoulder gently.", "withdrawn"],
    ["She steps away.", "separated"],
    ["She rises and steps back.", "separated"],
    ["She turns and walks away toward the window.", "separated"],
    ["She moves away from the counter.", "separated"],
    ["She steps out of reach.", "separated"],
  ])("%s → %s", (reply, reason) => {
    expect(detect(reply)).toEqual({ subjectId: WREN, reason });
  });

  it("resolves through surrounding prose, first eligible sentence winning", () => {
    const ending = detect(
      "The kettle clicks off somewhere behind her. She holds your gaze a moment longer. " +
        "Then she eases out from beneath your hand and turns toward the stove.",
    );
    expect(ending).toEqual({ subjectId: WREN, reason: "withdrawn" });
  });
});

describe("subject resolution — one body, unambiguously", () => {
  it("a pronoun resolves to the sole NPC in a 1-on-1", () => {
    expect(detect("She pulls away.")?.subjectId).toBe(WREN);
  });

  it("an ambiguous ensemble pronoun produces NO ending", () => {
    expect(detect("She pulls away.", PAIR)).toBeNull();
  });

  it("a named ensemble subject resolves — full name, first name, or alias", () => {
    expect(detect("Wren Vale steps away.", PAIR)?.subjectId).toBe(WREN);
    expect(detect("Wren steps away.", PAIR)?.subjectId).toBe(WREN);
    expect(detect("Vaelith eases out from beneath your hand.", PAIR)?.subjectId).toBe(VAEL);
  });

  it("a token two members answer to is ambiguity, not a first-match win", () => {
    const twins = [npc(WREN, "Mira Vale"), npc(VAEL, "Mira Thorn")];
    expect(detect("Mira steps away.", twins)).toBeNull();
  });
});

describe("the fold — ends only, and only that NPC's contacts", () => {
  const REPLY_REF = chatReplyContactEventRef("msg_reply_1");
  const AT = 240;

  /** A scene holding one committed player-hand touch on `target`. */
  function touching(target: AffordanceSubjectId, roster: readonly ChatContactRosterMember[]): SceneState {
    const eventRef = chatContactEventRef("msg_exchange_1");
    const seeded = seededChatScene(emptySceneState(), {
      player: CHAT_CONTACT_PLAYER_SUBJECT,
      characters: roster.map((entry) => entry.subjectId),
      ref: sceneEventRef(eventRef),
      storyTime: AT,
    });
    const name = roster.find((entry) => entry.subjectId === target)?.name ?? "Wren";
    const planned = planChatContactTurn({
      scene: seeded,
      message: `I walk over to ${name}. I rest my hand on ${name}'s shoulder.`,
      narratorInput: false,
      characters: roster,
      eventRef,
      storyTime: AT,
    });
    if (planned.commit?.status !== "committed") throw new Error("fixture: the touch must commit");
    return withSceneContacts(planned.scene, planned.commit.state);
  }

  const rosterMember = (subjectId: AffordanceSubjectId, name: string): ChatContactRosterMember => ({
    subjectId,
    name,
    aliases: [],
    material: adapterSupported(emptyEffectiveCoverageRead()),
  });

  it("ends the active contact with the detected reason, as a durable commit", () => {
    const scene = touching(WREN, [rosterMember(WREN, "Wren")]);
    const ended = applyChatNpcContactEnding({
      scene,
      ending: { subjectId: WREN, reason: "withdrawn" },
      eventRef: REPLY_REF,
      storyTime: AT + 1,
    });
    expect(ended.commits).toHaveLength(1);
    expect(ended.commits[0]?.kind).toBe("contact_ended");
    expect(ended.commits[0]?.reason).toBe("withdrawn");
    expect(activeContactsOf(ended.scene.contacts)).toEqual([]);
  });

  it("ends ONLY contacts involving that NPC — another member's touch survives", () => {
    const roster = [rosterMember(WREN, "Wren"), rosterMember(VAEL, "Vaelith")];
    const scene = touching(WREN, roster);
    const ended = applyChatNpcContactEnding({
      scene,
      ending: { subjectId: VAEL, reason: "separated" },
      eventRef: REPLY_REF,
      storyTime: AT + 1,
    });
    // Vaelith has no contact to end; Wren's stays exactly where it was.
    expect(ended.commits).toEqual([]);
    expect(activeContactsOf(ended.scene.contacts)).toHaveLength(1);
  });

  it("ends nothing on an empty scene — an ordinary answer, not a caller bug", () => {
    const ended = applyChatNpcContactEnding({
      scene: emptySceneState(),
      ending: { subjectId: WREN, reason: "withdrawn" },
      eventRef: REPLY_REF,
      storyTime: AT,
    });
    expect(ended.commits).toEqual([]);
  });

  it("asserts no proximity, no facing, no movement — ending is the entire claim", () => {
    const scene = touching(WREN, [rosterMember(WREN, "Wren")]);
    const ended = applyChatNpcContactEnding({
      scene,
      ending: { subjectId: WREN, reason: "separated" },
      eventRef: REPLY_REF,
      storyTime: AT + 1,
    });
    // Everything except the contact store is untouched — same participants, same
    // facts, same support surfaces.
    expect({ ...ended.scene, contacts: scene.contacts }).toEqual(scene);
  });
});

describe("identity — the reply-side ref is its own namespace", () => {
  it("never collides with the player leg's ref, even when the guard IS the assistant row", () => {
    // Beat exchanges key the player leg on the assistant row id; the reply-side
    // namespace keeps the two legs' (eventRef, sequence) spaces disjoint anyway.
    const id = "msg_beat_1";
    expect(chatReplyContactEventRef(id)).not.toBe(chatContactEventRef(id));
  });

  it("is deterministic per assistant message", () => {
    expect(chatReplyContactEventRef("m1")).toBe(chatReplyContactEventRef("m1"));
    expect(chatReplyContactEventRef("m1")).not.toBe(chatReplyContactEventRef("m2"));
  });
});
