import { describe, expect, it } from "vitest";
import { EMOTION_LABELS } from "@/contracts";
import type { RelationshipSample } from "@/contracts";
import {
  applyFeelingProposal,
  CHAT_BRUISE_EXCHANGES,
  CHAT_FEELING_DECAY_PER_EXCHANGE,
  CHAT_FEELING_FLOOR,
  CHAT_WARMTH_STREAK_CAP,
  decayFeelingState,
  emptyChatFeelingState,
  FEELING_VALENCE,
  halveBruise,
  maybeBruise,
  proposalIntensity,
  scaleRegardDelta,
  warmthStreakMultiplier,
  type ChatFeelingState,
} from "./chat-feeling";

const withFeeling = (label: (typeof EMOTION_LABELS)[number], intensity: number, cause = "the argument"): ChatFeelingState => ({
  current: { label, intensity, cause },
  bruise: null,
});

const sample = (regard: number): RelationshipSample => ({ at: "", clockMinutes: 0, regard, band: "neutral", familiarity: 0 });

describe("FEELING_VALENCE", () => {
  it("is total over the locked 11-label vocabulary", () => {
    for (const label of EMOTION_LABELS) expect([-1, 0, 1]).toContain(FEELING_VALENCE[label]);
    expect(Object.keys(FEELING_VALENCE)).toHaveLength(EMOTION_LABELS.length);
  });
});

describe("proposalIntensity", () => {
  it("lands moderate with no mechanical move and scales with the curve's charge", () => {
    expect(proposalIntensity(0, 5)).toBeCloseTo(0.35);
    expect(proposalIntensity(5, 5)).toBe(1);
    expect(proposalIntensity(-5, 5)).toBe(1);
    expect(proposalIntensity(3, 5)).toBeGreaterThan(proposalIntensity(1, 5));
  });
});

describe("applyFeelingProposal", () => {
  it("sets a feeling on an empty state and 'neutral' clears a standing one", () => {
    const set = applyFeelingProposal(emptyChatFeelingState(), { label: "sad", cause: "the broken promise" }, 0.8);
    expect(set.current).toEqual({ label: "sad", intensity: 0.8, cause: "the broken promise" });
    const cleared = applyFeelingProposal(set, { label: "neutral", cause: "" }, 0.5);
    expect(cleared.current).toBeNull();
  });

  it("same-label refreshes to the higher intensity; a weaker different label never displaces", () => {
    const standing = withFeeling("sad", 0.7);
    const refreshed = applyFeelingProposal(standing, { label: "sad", cause: "" }, 0.4);
    expect(refreshed.current?.intensity).toBe(0.7);
    const kept = applyFeelingProposal(standing, { label: "playful", cause: "a joke" }, 0.4);
    expect(kept.current?.label).toBe("sad");
    const replaced = applyFeelingProposal(standing, { label: "angry", cause: "the lie" }, 0.9);
    expect(replaced.current?.label).toBe("angry");
  });

  it("no proposal keeps the state by reference (identity = unchanged)", () => {
    const standing = withFeeling("happy", 0.5);
    expect(applyFeelingProposal(standing, null, 0.5)).toBe(standing);
  });
});

describe("decayFeelingState", () => {
  it("decays intensity per step, clears below the floor, and ticks the bruise down", () => {
    const state: ChatFeelingState = { current: { label: "sad", intensity: 0.5, cause: "" }, bruise: { remaining: 3 } };
    const once = decayFeelingState(state);
    expect(once.current?.intensity).toBeCloseTo(0.5 - CHAT_FEELING_DECAY_PER_EXCHANGE);
    expect(once.bruise?.remaining).toBe(2);
    const gone = decayFeelingState(state, 3);
    expect(gone.current).toBeNull(); // 0.5 − 0.45 = 0.05 < floor
    expect(gone.bruise).toBeNull();
    expect(CHAT_FEELING_FLOOR).toBeGreaterThan(0.05);
  });

  it("is a no-op (by reference) on an empty state", () => {
    const empty = emptyChatFeelingState();
    expect(decayFeelingState(empty, 5)).toBe(empty);
  });
});

describe("warmthStreakMultiplier", () => {
  it("counts the consecutive rising tail, capped", () => {
    expect(warmthStreakMultiplier([])).toBe(1);
    expect(warmthStreakMultiplier([sample(0), sample(5)])).toBeCloseTo(1.1);
    const sustained = [0, 5, 10, 15, 20, 25, 30, 35].map(sample);
    expect(warmthStreakMultiplier(sustained)).toBe(CHAT_WARMTH_STREAK_CAP);
    // A dip resets the streak.
    expect(warmthStreakMultiplier([sample(0), sample(10), sample(5), sample(8)])).toBeCloseTo(1.1);
  });
});

describe("scaleRegardDelta", () => {
  const neutral = emptyChatFeelingState();

  it("passes an unmodified delta through at scale 1", () => {
    expect(scaleRegardDelta({ delta: 3, feeling: neutral, history: [], deltaClamp: 5 })).toEqual({ delta: 3, scale: 1 });
    expect(scaleRegardDelta({ delta: 0, feeling: neutral, history: [], deltaClamp: 5 })).toEqual({ delta: 0, scale: 1 });
  });

  it("a dark feeling amplifies drops and damps gains (damped ±10%, ruled)", () => {
    const hurt = withFeeling("sad", 1);
    const drop = scaleRegardDelta({ delta: -4, feeling: hurt, history: [], deltaClamp: 5 });
    expect(drop.scale).toBeCloseTo(1.1);
    expect(drop.delta).toBe(-4); // −4.4 rounds back to −4
    const gain = scaleRegardDelta({ delta: 4, feeling: hurt, history: [], deltaClamp: 5 });
    expect(gain.scale).toBeCloseTo(0.9);
  });

  it("a warmth streak compounds gains only, and the clamp still holds", () => {
    const sustained = [0, 5, 10, 15, 20, 25, 30].map(sample);
    const gain = scaleRegardDelta({ delta: 4, feeling: neutral, history: sustained, deltaClamp: 5 });
    expect(gain.delta).toBe(5); // 4 × 1.5 = 6 → clamp 5
    const drop = scaleRegardDelta({ delta: -4, feeling: neutral, history: sustained, deltaClamp: 5 });
    expect(drop.delta).toBe(-4); // streak never touches drops
  });

  it("a bruise halves gains and never scales a nonzero delta to zero", () => {
    const bruised: ChatFeelingState = { current: null, bruise: { remaining: 5 } };
    expect(scaleRegardDelta({ delta: 4, feeling: bruised, history: [], deltaClamp: 5 }).delta).toBe(2);
    expect(scaleRegardDelta({ delta: 1, feeling: bruised, history: [], deltaClamp: 5 }).delta).toBe(1);
  });
});

describe("maybeBruise / halveBruise", () => {
  it("bruises only on a strong drop at high regard", () => {
    const empty = emptyChatFeelingState();
    expect(maybeBruise(60, -4, empty).bruise?.remaining).toBe(CHAT_BRUISE_EXCHANGES);
    expect(maybeBruise(60, -3, empty)).toBe(empty); // not strong enough
    expect(maybeBruise(20, -5, empty)).toBe(empty); // regard not high
    expect(maybeBruise(60, 4, empty)).toBe(empty); // a gain never bruises
  });

  it("an accepted apology halves the remaining life, clearing at zero", () => {
    const bruised: ChatFeelingState = { current: null, bruise: { remaining: CHAT_BRUISE_EXCHANGES } };
    expect(halveBruise(bruised).bruise?.remaining).toBe(5);
    expect(halveBruise({ current: null, bruise: { remaining: 1 } }).bruise).toBeNull();
    const clean = emptyChatFeelingState();
    expect(halveBruise(clean)).toBe(clean);
  });
});
