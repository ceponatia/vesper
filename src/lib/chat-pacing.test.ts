import { describe, expect, it } from "vitest";
import { REPLY_HOLD_MAX_MS, replyRevealHoldMs } from "./chat-pacing";

describe("replyRevealHoldMs", () => {
  it("warm regard answers at once; the middle hesitates; cold lets it sit", () => {
    expect(replyRevealHoldMs({ regard: 60 })).toBe(0);
    expect(replyRevealHoldMs({ regard: 0 })).toBe(250);
    expect(replyRevealHoldMs({ regard: -40 })).toBe(700);
  });

  it("a standing dark feeling adds hesitation; a bright one trims it; a faint one does nothing", () => {
    expect(replyRevealHoldMs({ regard: 0, feeling: { label: "sad", intensity: 0.8 } })).toBe(750);
    expect(replyRevealHoldMs({ regard: 0, feeling: { label: "playful", intensity: 0.8 } })).toBe(50);
    expect(replyRevealHoldMs({ regard: 60, feeling: { label: "playful", intensity: 0.8 } })).toBe(0); // floor
    expect(replyRevealHoldMs({ regard: 0, feeling: { label: "sad", intensity: 0.2 } })).toBe(250);
  });

  it("caps at the ceiling and degrades to zero without a snapshot", () => {
    expect(replyRevealHoldMs({ regard: -90, feeling: { label: "angry", intensity: 1 } })).toBe(REPLY_HOLD_MAX_MS);
    expect(replyRevealHoldMs(null)).toBe(0);
  });
});
