import { describe, expect, it } from "vitest";
import { chatCueInviteLine, detectChatCue, type ChatCueHint } from "./chat-intent";

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
