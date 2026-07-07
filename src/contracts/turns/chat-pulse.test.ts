import { describe, expect, it } from "vitest";
import {
  CHAT_ACTIONS,
  chatActionIdSchema,
  chatPulseSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  chatPulseTraceSchema,
  degradedChatPulse,
  emptyChatPulseTrace,
} from "./chat-pulse";

describe("chatPulseSchema (parsed-empty IS the degraded fallback)", () => {
  it("an empty object parses to the degraded pulse", () => {
    expect(chatPulseSchema.parse({})).toEqual(degradedChatPulse());
  });

  it("keeps a valid classified act + note", () => {
    const parsed = chatPulseSchema.parse({ playerAct: { concept: "compliment" }, mindNote: "warmer now" });
    expect(parsed.playerAct).toEqual({ concept: "compliment" });
    expect(parsed.mindNote).toBe("warmer now");
  });

  it("self-heals a malformed playerAct to null rather than rejecting the object", () => {
    expect(chatPulseSchema.parse({ playerAct: { concept: "" }, mindNote: "x" }).playerAct).toBeNull();
    expect(chatPulseSchema.parse({ playerAct: "compliment" }).playerAct).toBeNull();
  });

  it("self-heals an over-long mindNote to '' (keep prior) rather than rejecting", () => {
    const parsed = chatPulseSchema.parse({ mindNote: "x".repeat(CHAT_MIND_NOTE_MAX_CHARS + 50) });
    expect(parsed.mindNote).toBe("");
  });
});

describe("chatPulseTraceSchema", () => {
  it("parses an empty trace to safe defaults", () => {
    expect(emptyChatPulseTrace()).toEqual({
      concept: null,
      valence: null,
      regardDelta: 0,
      moodDelta: 0,
      arousalDelta: 0,
      changed: [],
      degraded: false,
    });
  });

  it("tolerates a malformed jsonb blob (every field catches)", () => {
    const parsed = chatPulseTraceSchema.parse({ concept: 5, valence: "??", regardDelta: "nope", changed: "bad" });
    expect(parsed.concept).toBeNull();
    expect(parsed.valence).toBeNull();
    expect(parsed.regardDelta).toBe(0);
    expect(parsed.arousalDelta).toBe(0);
    expect(parsed.changed).toEqual([]);
  });
});

describe("chat action chips", () => {
  it("every CHAT_ACTIONS id validates against chatActionIdSchema", () => {
    for (const action of CHAT_ACTIONS) expect(chatActionIdSchema.safeParse(action.id).success).toBe(true);
  });

  it("rejects an unknown action id", () => {
    expect(chatActionIdSchema.safeParse("nuke").success).toBe(false);
  });
});
