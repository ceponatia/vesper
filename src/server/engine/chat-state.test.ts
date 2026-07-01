import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { initialMeters } from "@/contracts/meters/registry";
import { stageForValue, stageMidpoint } from "@/contracts/relationships/stages";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import type { ChatPulse } from "@/contracts/turns/chat-pulse";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { characterProfileSchema, emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import { CHAT_AROUSAL_INTIMATE, CHAT_RESET_MINUTES, CHAT_TICK_MINUTES } from "./constants";
import {
  applyChatAction,
  applyChatAttributeOverlays,
  applyChatPulse,
  chatStateSnapshot,
  driftChatState,
  runChatPulse,
  seedChatState,
  type ChatState,
} from "./chat-state";

// These run with AI_FAKE=1 (src/test/setup.ts): demo mode short-circuits the
// pulse LLM, so runChatPulse exercises the drift-only degrade path.

function profile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return { ...emptyCharacterProfile(), ...overrides };
}

const ago = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

describe("seedChatState", () => {
  it("seeds rested meters, neutral affinity, and an empty premise for a default profile", () => {
    const state = seedChatState(profile());
    expect(state.meters).toEqual(initialMeters());
    expect(state.affinity).toBe(0);
    expect(state.premise).toBe("");
    expect(state.mindNote).toBe(""); // never seeded — purely dynamic
    expect(state.lastInteractionAt).toBeNull();
  });

  it("seeds affinity from the authored playerRelationship stage via stageMidpoint", () => {
    const warm = seedChatState(profile({ playerRelationship: { stage: "warm", note: "" } }));
    expect(warm.affinity).toBe(stageMidpoint("warm"));
    expect(warm.affinity).toBeGreaterThan(0);
  });

  it("stranger / absent stage seeds affinity 0 (today's behavior unchanged)", () => {
    expect(seedChatState(profile({ playerRelationship: { stage: "stranger", note: "" } })).affinity).toBe(0);
  });

  it("self-heals a malformed authored stage to stranger ⇒ affinity 0", () => {
    const parsed = characterProfileSchema.parse({ playerRelationship: { stage: "not-a-stage" } });
    expect(seedChatState(parsed).affinity).toBe(0);
  });

  it("pre-fills the premise from playerRelationship.note, and an explicit premise overrides it", () => {
    expect(seedChatState(profile({ playerRelationship: { stage: "stranger", note: "her bodyguard" } })).premise).toBe(
      "her bodyguard",
    );
    expect(seedChatState(profile({ playerRelationship: { stage: "stranger", note: "ignored" } }), "tonight she leaves").premise).toBe(
      "tonight she leaves",
    );
  });
});

describe("driftChatState", () => {
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(profile()), ...overrides });

  it("within-visit tick advances the clock and decays meters toward their baseline", () => {
    const drifted = driftChatState(base(), new Date(), profile(), { advance: true });
    expect(drifted.clockMinutes).toBe(CHAT_TICK_MINUTES);
    expect(drifted.meters.hygiene).toBeLessThan(0.9); // drifts toward the grime pole
    expect(drifted.meters.energy).toBeLessThan(0.9);
  });

  it("between-visit recovery lerps meters toward rested by elapsed/CHAT_RESET_MINUTES", () => {
    const tired = base({ meters: { ...initialMeters(), hygiene: 0.2, energy: 0.2 }, lastInteractionAt: ago(CHAT_RESET_MINUTES / 2) });
    const drifted = driftChatState(tired, new Date(), profile(), { advance: false });
    // f = 0.5 ⇒ halfway from 0.2 back to the rested 0.9.
    expect(drifted.meters.hygiene).toBeCloseTo(0.55, 2);
    expect(drifted.meters.energy).toBeCloseTo(0.55, 2);
  });

  it("a full gap recovers to rested and never overshoots (cap at f=1)", () => {
    const tired = base({ meters: { ...initialMeters(), hygiene: 0.1 }, lastInteractionAt: ago(CHAT_RESET_MINUTES * 5) });
    const drifted = driftChatState(tired, new Date(), profile(), { advance: false });
    expect(drifted.meters.hygiene).toBeCloseTo(0.9, 5); // exactly rested, not beyond
  });

  it("never decays affinity (no between-visit decay — spec §10)", () => {
    const warm = base({ affinity: 57, lastInteractionAt: ago(CHAT_RESET_MINUTES * 10) });
    expect(driftChatState(warm, new Date(), profile(), { advance: false }).affinity).toBe(57);
    expect(driftChatState(warm, new Date(), profile(), { advance: true }).affinity).toBe(57);
  });

  it("expires conditions past the clock during the within-visit tick", () => {
    const condition: ActiveCondition = { id: "tipsy", label: "Tipsy", startedAtMinutes: 0, durationMinutes: 2, attributeEffects: [] };
    const withCondition = base({ conditions: [condition] });
    // Tick advances the clock past started + duration (2) ⇒ expired.
    expect(driftChatState(withCondition, new Date(), profile(), { advance: true }).conditions).toHaveLength(0);
    // A read (no advance) keeps the chat clock still ⇒ the condition survives.
    expect(driftChatState(withCondition, new Date(), profile(), { advance: false }).conditions).toHaveLength(1);
  });
});

describe("applyChatPulse (the deterministic §6 curve)", () => {
  const likeProfile = profile({ preferences: [{ target: "compliment", valence: "like", intensity: 5 }] });
  const dislikeProfile = profile({ preferences: [{ target: "insult", valence: "dislike", intensity: 5 }] });
  const state = (): ChatState => seedChatState(profile());
  const pulse = (concept: string | null, mindNote = "thinking"): ChatPulse => ({
    playerAct: concept ? { concept } : null,
    mindNote,
  });

  it("a liked act raises affinity (clamped) and lifts mood, and records the trace", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("compliment"), likeProfile, "Mara");
    expect(trace.concept).toBe("compliment");
    expect(trace.valence).toBe("like");
    expect(trace.affinityDelta).toBeGreaterThan(0);
    expect(next.affinity).toBe(trace.affinityDelta);
    expect(next.meters.mood).toBeGreaterThan(0.5);
    expect(next.mindNote).toBe("thinking");
    expect(trace.changed).toContain("affinity");
  });

  it("a disliked act lowers affinity and mood", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("insult"), dislikeProfile, "Mara");
    expect(trace.valence).toBe("dislike");
    expect(trace.affinityDelta).toBeLessThan(0);
    expect(next.affinity).toBeLessThan(0);
    expect(next.meters.mood).toBeLessThan(0.5);
  });

  it("clamps the affinity move to ±AFFINITY_DELTA_CLAMP", () => {
    const intense = profile({ preferences: [{ target: "insult", valence: "dislike", intensity: 10 }] });
    const { trace } = applyChatPulse(state(), pulse("insult"), intense, "Mara");
    expect(trace.affinityDelta).toBeGreaterThanOrEqual(-5);
  });

  it("an unrecognised act moves nothing but still refreshes the mindNote", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("compliment", "warmer now"), profile(), "Mara");
    expect(trace.valence).toBeNull();
    expect(trace.affinityDelta).toBe(0);
    expect(next.affinity).toBe(0);
    expect(next.mindNote).toBe("warmer now");
    expect(trace.changed).toEqual(["mindNote"]);
  });

  it("a null act leaves state untouched except the mindNote", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse(null, "still musing"), likeProfile, "Mara");
    expect(trace.concept).toBeNull();
    expect(next.affinity).toBe(0);
    expect(next.mindNote).toBe("still musing");
  });

  it("an empty mindNote keeps the prior note", () => {
    const prior: ChatState = { ...state(), mindNote: "kept" };
    expect(applyChatPulse(prior, pulse(null, ""), profile(), "Mara").state.mindNote).toBe("kept");
  });

  it("raises arousal on an intimate act (proposition), full amount", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("proposition"), profile(), "Mara");
    expect(trace.arousalDelta).toBeCloseTo(CHAT_AROUSAL_INTIMATE, 5);
    expect(next.meters.arousal).toBeCloseTo(CHAT_AROUSAL_INTIMATE, 5);
    expect(trace.changed).toContain("arousal");
  });

  it("raises arousal half as much for a courtship act (flirt)", () => {
    const { trace } = applyChatPulse(state(), pulse("flirt"), profile(), "Mara");
    expect(trace.arousalDelta).toBeCloseTo(CHAT_AROUSAL_INTIMATE / 2, 5);
  });

  it("does not raise arousal when the intimate act is disliked", () => {
    const prude = profile({ preferences: [{ target: "proposition", valence: "dislike", intensity: 6 }] });
    const { state: next, trace } = applyChatPulse(state(), pulse("proposition"), prude, "Mara");
    expect(trace.arousalDelta).toBe(0);
    expect(next.meters.arousal).toBe(0);
  });

  it("resolves a reaction against the chat's ACTIVE social cards (character-chat-scenario.plan.md)", () => {
    const taboo: SocialReactionCard = {
      id: "no-crit",
      label: "Criticism is taboo here",
      description: "",
      kind: "taboo",
      triggers: ["criticize"],
      severity: 60,
      reactionOverrides: [],
    };
    const withCard: ChatState = { ...state(), activeSocialCards: [taboo] };
    const { trace } = applyChatPulse(withCard, pulse("criticize"), profile(), "Mara");
    expect(trace.concept).toBe("criticize");
    expect(trace.valence).toBe("dislike");
    expect(trace.affinityDelta).toBeLessThan(0);
  });

  it("no active card on the concept ⇒ no card reaction (the active set is authoritative)", () => {
    const { trace } = applyChatPulse(state(), pulse("criticize"), profile(), "Mara");
    expect(trace.valence).toBeNull();
    expect(trace.affinityDelta).toBe(0);
  });
});

describe("applyChatAction (test-bed chips)", () => {
  const state = (): ChatState => seedChatState(profile());

  it("offer a drink raises intoxication", () => {
    expect(applyChatAction(state(), "drink").meters.intoxication).toBeCloseTo(0.3, 5);
  });

  it("freshen up restores hygiene", () => {
    const tired = { ...state(), meters: { ...initialMeters(), hygiene: 0.2 } };
    expect(applyChatAction(tired, "freshen").meters.hygiene).toBeCloseTo(0.95, 5);
  });

  it("take a breather lifts energy and lowers stress", () => {
    const drained = { ...state(), meters: { ...initialMeters(), energy: 0.4, stress: 0.5 } };
    const next = applyChatAction(drained, "rest");
    expect(next.meters.energy).toBeCloseTo(0.6, 5);
    expect(next.meters.stress).toBeCloseTo(0.3, 5);
  });

  it("heat things up raises arousal and adds a self-expiring flushed condition", () => {
    const next = applyChatAction(state(), "fluster");
    expect(next.meters.arousal).toBeCloseTo(0.25, 5);
    const flushed = next.conditions.find((c) => c.id === "flushed");
    expect(flushed).toBeDefined();
    expect(flushed?.durationMinutes).toBeGreaterThan(0);
  });

  it("re-applying a condition chip refreshes rather than duplicates it", () => {
    const once = applyChatAction(state(), "fluster");
    const twice = applyChatAction(once, "fluster");
    expect(twice.conditions.filter((c) => c.id === "flushed")).toHaveLength(1);
  });
});

describe("runChatPulse (demo ⇒ drift-only degrade)", () => {
  it("degrades to drift-only state AND emits the chat_state.pulse.degraded diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const input: ChatState = { ...seedChatState(profile()), affinity: 12, mindNote: "before" };
    const { state, degraded } = await runChatPulse({
      state: input,
      profile: profile(),
      characterName: "Mara",
      playerName: "Theo",
      exchange: { player: "hi", assistant: "[Mara] \"hi\"" },
      sink,
    });
    expect(degraded).toBe(true);
    expect(state.affinity).toBe(12); // unchanged — drift-only
    expect(state.mindNote).toBe("before");
    expect(state.lastPulseTrace.degraded).toBe(true);
    expect(sink.items.some((d) => d.code === "chat_state.pulse.degraded")).toBe(true);
  });
});

describe("stageForValue chip mapping (the strip's stage label)", () => {
  it("maps a warm affinity to the warm stage", () => {
    expect(stageForValue(seedChatState(profile({ playerRelationship: { stage: "warm", note: "" } })).affinity).id).toBe("warm");
  });
});

describe("chatStateSnapshot — mood chip (mood.spec §4)", () => {
  const withMeters = (over: Record<string, number>): ChatState => ({
    ...seedChatState(profile()),
    meters: { ...initialMeters(), ...over },
  });

  it("carries a derived emotion label + bounded intensity", () => {
    const snap = chatStateSnapshot(seedChatState(profile()));
    expect(snap.emotion.label).toBeTruthy();
    expect(snap.emotion.intensity).toBeGreaterThanOrEqual(0);
    expect(snap.emotion.intensity).toBeLessThanOrEqual(1);
  });

  it("dominance tilts a low, calm mood from sad toward angry", () => {
    const low = withMeters({ mood: 0.2, stress: 0.2 });
    expect(chatStateSnapshot(low, { dominance: 0 }).emotion.label).toBe("sad");
    expect(chatStateSnapshot(low, { dominance: 80 }).emotion.label).toBe("angry");
  });

  it("intimateContext gates the aroused label at high arousal (chat passes it on)", () => {
    const hot = withMeters({ mood: 0.6, arousal: 0.8 });
    expect(chatStateSnapshot(hot, { intimateContext: false }).emotion.label).not.toBe("aroused");
    expect(chatStateSnapshot(hot, { intimateContext: true }).emotion.label).toBe("aroused");
  });

  it("persisted defaults true and is honored when set false (fresh-chat seed preview)", () => {
    expect(chatStateSnapshot(seedChatState(profile())).persisted).toBe(true);
    expect(chatStateSnapshot(seedChatState(profile()), { persisted: false }).persisted).toBe(false);
  });
});

describe("applyChatAttributeOverlays (mutable-attribute evolution — spec §3)", () => {
  it("adds a mutable narrative overlay (a dye job)", () => {
    const sink = new DiagnosticCollector();
    const out = applyChatAttributeOverlays([], [{ participantName: "Mara", attributeId: "hair.color", value: "auburn" }], sink);
    expect(out).toContainEqual(expect.objectContaining({ id: "hair.color", value: "auburn", source: "narrative" }));
    expect(sink.items).toHaveLength(0);
  });

  it("rejects an inherent attribute change with a diagnostic (the guard)", () => {
    const sink = new DiagnosticCollector();
    const out = applyChatAttributeOverlays([], [{ participantName: "Mara", attributeId: "eyes.color", value: "violet" }], sink);
    expect(out).toHaveLength(0);
    expect(sink.items.some((d) => d.code === "chat_state.attribute.inherent_change_rejected")).toBe(true);
  });

  it("drops an unknown attribute id with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const out = applyChatAttributeOverlays([], [{ participantName: "Mara", attributeId: "nonsense.attr", value: "x" }], sink);
    expect(out).toHaveLength(0);
    expect(sink.items.some((d) => d.code === "chat_state.attribute.unknown")).toBe(true);
  });

  it("dedupes by attribute id (last write wins), preserving other overlays", () => {
    const first = applyChatAttributeOverlays([], [{ participantName: "Mara", attributeId: "hair.color", value: "auburn" }]);
    const second = applyChatAttributeOverlays(first, [{ participantName: "Mara", attributeId: "hair.color", value: "silver" }]);
    expect(second.filter((o) => o.id === "hair.color")).toHaveLength(1);
    expect(second.find((o) => o.id === "hair.color")?.value).toBe("silver");
  });
});
