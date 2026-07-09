import { describe, expect, it } from "vitest";
import {
  buildChatReplyGates,
  chatCueInviteLine,
  detectChatCue,
  detectSceneMovement,
  detectSensoryFocus,
  isCheckInReply,
  replyEndsInQuestion,
  type ChatCueHint,
} from "./chat-intent";

const cue = (overrides: Partial<ChatCueHint> = {}): ChatCueHint => ({
  proximity: false,
  touch: false,
  intimate: false,
  attention: false,
  ...overrides,
});

describe("detectChatCue", () => {
  it("flags proximity when the player draws close", () => {
    expect(detectChatCue("She leans in close to you.").proximity).toBe(true);
    expect(detectChatCue("You step closer.").proximity).toBe(true);
  });

  it("flags touch on physical contact", () => {
    expect(detectChatCue("You take her hand.").touch).toBe(true);
    expect(detectChatCue("You brush against her shoulder.").touch).toBe(true);
  });

  it("flags intimate beats", () => {
    expect(detectChatCue("You kiss her.").intimate).toBe(true);
    expect(detectChatCue("You taste the salt on her skin.").intimate).toBe(true);
  });

  it("flags attention when the player looks the character over or compliments appearance", () => {
    expect(detectChatCue("I lean back and look her up and down.").attention).toBe(true);
    expect(detectChatCue("I can't stop staring at her.").attention).toBe(true);
    expect(detectChatCue("That dress looks amazing on you.").attention).toBe(true);
    expect(detectChatCue("I love your hair today.").attention).toBe(true);
    expect(detectChatCue("My eyes linger on the slit of her dress.").attention).toBe(true);
  });

  it("does not flag attention for impersonal looking or non-appearance compliments", () => {
    expect(detectChatCue("I glance at the clock on the wall.").attention).toBe(false);
    expect(detectChatCue("I admire your honesty.").attention).toBe(false);
    expect(detectChatCue("I look at the menu for a while.").attention).toBe(false);
  });

  it("flags nothing for ordinary distant conversation", () => {
    expect(detectChatCue("What did you do today?")).toEqual(cue());
    expect(detectChatCue("")).toEqual(cue());
  });
});

describe("chatCueInviteLine", () => {
  it("returns the most-charged invite (intimate > touch > proximity > attention)", () => {
    expect(chatCueInviteLine(cue({ proximity: true, touch: true, intimate: true, attention: true }), "Mara")).toContain(
      "turning intimate",
    );
    expect(chatCueInviteLine(cue({ proximity: true, touch: true, attention: true }), "Mara")).toContain("made contact");
    expect(chatCueInviteLine(cue({ proximity: true, attention: true }), "Mara")).toContain("drawn close");
    expect(chatCueInviteLine(cue({ attention: true }), "Mara")).toContain("attention is on Mara's appearance");
  });

  it("words the attention invite as one player-eye visual detail, never an inventory", () => {
    const line = chatCueInviteLine(cue({ attention: true }), "Mara");
    expect(line).toContain("seen from the player's eye");
    expect(line).toContain("never a head-to-toe description");
  });

  it("returns '' when nothing is invited", () => {
    expect(chatCueInviteLine(cue(), "Mara")).toBe("");
  });
});

describe("detectSceneMovement (chat scene memory)", () => {
  it("captures a destination after a movement verb + preposition + article", () => {
    expect(detectSceneMovement("I follow her to the kitchen.")).toBe("kitchen");
    expect(detectSceneMovement("Let's move to the living room.")).toBe("living room");
    expect(detectSceneMovement("She leads you into the back garden.")).toBe("back garden");
  });

  it("captures adverbial destinations (outside / upstairs)", () => {
    expect(detectSceneMovement("We head outside.")).toBe("outside");
    expect(detectSceneMovement("Come on, let's go upstairs.")).toBe("upstairs");
  });

  it("does not misfire on non-movement 'to' phrases", () => {
    expect(detectSceneMovement("I want to talk about your day.")).toBeNull();
    expect(detectSceneMovement("Listen to the radio with me.")).toBeNull();
    expect(detectSceneMovement("What did you do today?")).toBeNull();
    expect(detectSceneMovement("")).toBeNull();
  });
});

describe("detectSensoryFocus (scope guard)", () => {
  it("detects a sense verb aimed at a body region / garment", () => {
    expect(detectSensoryFocus("I breathe in the scent of her hair.")).toEqual({ sense: "smell", target: "hair", intimate: false });
    expect(detectSensoryFocus("I run my fingers along your collarbone.")).toEqual({ sense: "touch", target: "collarbone", intimate: false });
    expect(detectSensoryFocus("I take in the lines of her dress.")).toEqual({ sense: "study", target: "dress", intimate: false });
    expect(detectSensoryFocus("I taste the salt on your neck.")).toEqual({ sense: "taste", target: "neck", intimate: false });
  });

  it("flags an intimate target", () => {
    const hit = detectSensoryFocus("I cup her breasts.");
    expect(hit).toEqual({ sense: "touch", target: "breasts", intimate: true });
  });

  it("returns null without a target noun (sense×TARGET only — 'I feel nervous' never fires)", () => {
    expect(detectSensoryFocus("I feel nervous about tomorrow.")).toBeNull();
    expect(detectSensoryFocus("She smells wonderful.")).toBeNull();
    expect(detectSensoryFocus("What are you thinking about?")).toBeNull();
    expect(detectSensoryFocus("")).toBeNull();
  });
});

describe("replyEndsInQuestion (deliverable D — hook cadence)", () => {
  it("fires when the last dialogue line ends in a question, including tag questions", () => {
    expect(replyEndsInQuestion('She smiles. "How have you been?"')).toBe(true);
    expect(replyEndsInQuestion('"You came back, didn\'t you?"')).toBe(true);
  });

  it("does not fire when a mid-reply question is followed by narration (the reply moves past it)", () => {
    expect(replyEndsInQuestion('"Where were you?" She turns back to the window, not waiting.')).toBe(false);
  });

  it("does not fire when the reply ends on a statement or an action", () => {
    expect(replyEndsInQuestion('"It\'s good to see you." She leans against the doorframe.')).toBe(false);
    expect(replyEndsInQuestion("She just nods, saying nothing.")).toBe(false);
  });

  it("treats a texted comms line as a dialogue line", () => {
    expect(replyEndsInQuestion("*Mara: you free tonight?*")).toBe(true);
    expect(replyEndsInQuestion("*Mara: on my way.*")).toBe(false);
  });
});

describe("isCheckInReply (deliverable D — intimate check-in)", () => {
  it("matches the check-in solicitation patterns", () => {
    expect(isCheckInReply('"Am I doing this right?" she breathes.')).toBe(true);
    expect(isCheckInReply('"Does that feel good?"')).toBe(true);
    expect(isCheckInReply('"Is this okay?"')).toBe(true);
    expect(isCheckInReply('"Do you like that?"')).toBe(true);
  });

  it("does not match ordinary intimate dialogue", () => {
    expect(isCheckInReply('"God, you feel incredible," she whispers.')).toBe(false);
    expect(isCheckInReply("She arches into you without a word.")).toBe(false);
  });
});

describe("buildChatReplyGates (deliverable D)", () => {
  const q1 = '"How was your day?"';
  const q2 = '"What did you get up to?"';
  const statement = '"Good to see you." She sits.';

  it("fires the hook-cadence note only when the last TWO replies both end in questions", () => {
    const both = buildChatReplyGates({ recentReplies: [statement, q1, q2], intimate: false, name: "Mara" });
    expect(both).toContain("ended in questions");
    const one = buildChatReplyGates({ recentReplies: [q1, statement], intimate: false, name: "Mara" });
    expect(one).toBe("");
  });

  it("fires the check-in gate only during an intimate beat when the previous reply solicited a check-in", () => {
    const prev = '"Does that feel good?"';
    const intimate = buildChatReplyGates({ recentReplies: [prev], intimate: true, name: "Mara" });
    expect(intimate).toContain("No check-in questions this turn");
    expect(intimate).toContain("Mara's experience");
    // Same reply, non-intimate beat ⇒ no check-in gate.
    expect(buildChatReplyGates({ recentReplies: [prev], intimate: false, name: "Mara" })).toBe("");
  });

  it("returns '' when neither gate fires", () => {
    expect(buildChatReplyGates({ recentReplies: [statement], intimate: true, name: "Mara" })).toBe("");
    expect(buildChatReplyGates({ recentReplies: [], intimate: true, name: "Mara" })).toBe("");
  });
});
