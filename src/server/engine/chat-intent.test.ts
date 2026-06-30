import { describe, expect, it } from "vitest";
import { chatCueInviteLine, detectChatCue } from "./chat-intent";

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

  it("flags nothing for ordinary distant conversation", () => {
    expect(detectChatCue("What did you do today?")).toEqual({ proximity: false, touch: false, intimate: false });
    expect(detectChatCue("")).toEqual({ proximity: false, touch: false, intimate: false });
  });
});

describe("chatCueInviteLine", () => {
  it("returns the most-charged invite (intimate > touch > proximity)", () => {
    expect(chatCueInviteLine({ proximity: true, touch: true, intimate: true }, "Mara")).toContain("turning intimate");
    expect(chatCueInviteLine({ proximity: true, touch: true, intimate: false }, "Mara")).toContain("made contact");
    expect(chatCueInviteLine({ proximity: true, touch: false, intimate: false }, "Mara")).toContain("drawn close");
  });

  it("returns '' when nothing is invited", () => {
    expect(chatCueInviteLine({ proximity: false, touch: false, intimate: false }, "Mara")).toBe("");
  });
});
