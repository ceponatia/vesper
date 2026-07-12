import { describe, expect, it } from "vitest";
import type { Milestone } from "@/contracts/relationships/history";
import {
  appendCallbackEntry,
  callbackRef,
  CHAT_CALLBACK_ECHO_MAX,
  CHAT_CALLBACK_HISTORY_CAP,
  CHAT_CALLBACK_MIN_GAP_MINUTES,
  CHAT_CALLBACK_SUMMARY_MAX_CHARS,
  chatCallbackEligible,
  selectChatCallback,
  type CallbackCandidate,
  type ChatCallbackGateInput,
} from "./chat-callback";

const gate = (overrides: Partial<ChatCallbackGateInput> = {}): ChatCallbackGateInput => ({
  clockMinutes: 500,
  callbackHistory: [],
  firstExchange: false,
  pendingSkipNote: "",
  sceneChanged: false,
  intimateBeat: false,
  hasSensoryFocus: false,
  lastReplyEndsInQuestion: false,
  ...overrides,
});

const candidate = (overrides: Partial<CallbackCandidate> = {}): CallbackCandidate => ({
  id: "ep-1",
  turnNumber: 3,
  summary: "They watched the storm roll in from the porch.",
  sourceMessageId: null,
  similarity: 0.1,
  ...overrides,
});

describe("chatCallbackEligible", () => {
  it("passes on an ordinary lull turn", () => {
    expect(chatCallbackEligible(gate())).toBe(true);
  });

  it("suppresses on every competing one-turn tail block and on charged beats", () => {
    expect(chatCallbackEligible(gate({ firstExchange: true }))).toBe(false);
    expect(chatCallbackEligible(gate({ pendingSkipNote: "The next morning." }))).toBe(false);
    expect(chatCallbackEligible(gate({ sceneChanged: true }))).toBe(false);
    expect(chatCallbackEligible(gate({ intimateBeat: true }))).toBe(false);
    expect(chatCallbackEligible(gate({ hasSensoryFocus: true }))).toBe(false);
    expect(chatCallbackEligible(gate({ lastReplyEndsInQuestion: true }))).toBe(false);
  });

  it("enforces the cadence gap on the chat clock", () => {
    const recent = gate({
      clockMinutes: 500,
      callbackHistory: [{ ref: "e:old", atClockMinutes: 500 - CHAT_CALLBACK_MIN_GAP_MINUTES + 1 }],
    });
    expect(chatCallbackEligible(recent)).toBe(false);
    const farEnough = gate({
      clockMinutes: 500,
      callbackHistory: [{ ref: "e:old", atClockMinutes: 500 - CHAT_CALLBACK_MIN_GAP_MINUTES }],
    });
    expect(chatCallbackEligible(farEnough)).toBe(true);
  });

  it("a time skip re-opens eligibility (the clock jump covers the gap)", () => {
    const afterSkip = gate({
      clockMinutes: 1000, // an "hours" skip just landed
      callbackHistory: [{ ref: "e:old", atClockMinutes: 990 - CHAT_CALLBACK_MIN_GAP_MINUTES }],
    });
    expect(chatCallbackEligible(afterSkip)).toBe(true);
  });
});

describe("selectChatCallback", () => {
  const select = (candidates: CallbackCandidate[], milestones: Milestone[] = [], usedRefs: string[] = []) =>
    selectChatCallback({ candidates, milestones, usedRefs, latestTurn: 30 });

  it("prefers the older episode, all else equal", () => {
    const chosen = select([candidate({ id: "old", turnNumber: 2 }), candidate({ id: "newer", turnNumber: 20 })]);
    expect(chosen?.ref).toBe(callbackRef("old"));
  });

  it("a milestone on the episode's message outranks plain age", () => {
    const milestone: Milestone = { at: "", kind: "player_marked", label: "The pier", messageId: "msg-9" };
    const chosen = select(
      [candidate({ id: "plain", turnNumber: 2 }), candidate({ id: "marked", turnNumber: 18, sourceMessageId: "msg-9" })],
      [milestone],
    );
    expect(chosen?.ref).toBe(callbackRef("marked"));
  });

  it("drops echoes of the current topic and never repeats a used ref", () => {
    expect(select([candidate({ similarity: CHAT_CALLBACK_ECHO_MAX })])).toBeNull();
    expect(select([candidate({ id: "used" })], [], [callbackRef("used")])).toBeNull();
  });

  it("returns null on empty or blank-summary pools", () => {
    expect(select([])).toBeNull();
    expect(select([candidate({ summary: "   " })])).toBeNull();
  });

  it("clamps a runaway summary to one line's worth", () => {
    const long = "a very long memory ".repeat(40);
    const chosen = select([candidate({ summary: long })]);
    expect(chosen?.summary.length).toBeLessThanOrEqual(CHAT_CALLBACK_SUMMARY_MAX_CHARS + 1); // +1 for the ellipsis
    expect(chosen?.summary.endsWith("…")).toBe(true);
  });
});

describe("appendCallbackEntry", () => {
  it("appends and caps the ring, oldest out", () => {
    let ring = [...Array(CHAT_CALLBACK_HISTORY_CAP)].map((_, i) => ({ ref: `e:${i}`, atClockMinutes: i }));
    ring = appendCallbackEntry(ring, { ref: "e:new", atClockMinutes: 999 });
    expect(ring).toHaveLength(CHAT_CALLBACK_HISTORY_CAP);
    expect(ring.at(-1)?.ref).toBe("e:new");
    expect(ring[0]?.ref).toBe("e:1");
  });
});
