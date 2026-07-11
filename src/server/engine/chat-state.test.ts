import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { initialMeters } from "@/contracts/meters/registry";
import { stageMidpoint } from "@/contracts/relationships/stages";
import { familiarityBandMidpoint, regardBandForValue, regardBandMidpoint } from "@/contracts/relationships/bands";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import type { ChatPulse } from "@/contracts/turns/chat-pulse";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { characterProfileSchema, emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import { SKIP_HISTORY_CAP } from "@/contracts/turns/chat-skip";
import { CHAT_AROUSAL_INTIMATE, CHAT_SKIP_MINUTES, CHAT_TICK_MINUTES } from "./constants";
import {
  applyChatAction,
  applyChatAttributeOverlays,
  applyChatPulse,
  applyTimeSkip,
  chatStateSnapshot,
  driftChatState,
  resolveSeededOutfit,
  runChatPulse,
  seedChatState,
  seededOutfitMarker,
  type ChatState,
} from "./chat-state";

// These run with AI_FAKE=1 (src/test/setup.ts): demo mode short-circuits the
// pulse LLM, so runChatPulse exercises the drift-only degrade path.

function profile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return { ...emptyCharacterProfile(), ...overrides };
}

describe("seedChatState", () => {
  it("seeds rested meters, neutral affinity, and an empty premise for a default profile", () => {
    const state = seedChatState(profile());
    expect(state.meters).toEqual(initialMeters());
    expect(state.regard).toBe(0);
    expect(state.premise).toBe("");
    expect(state.mindNote).toBe(""); // never seeded — purely dynamic
    expect(state.pendingSkipNote).toBe("");
    expect(state.skipHistory).toEqual([]);
    expect(state.relationshipHistory).toEqual([]);
    expect(state.milestones).toEqual([]);
    // Chat scene memory starts empty and rides the snapshot (and the FK-cascade reset).
    expect(state.sceneMemory).toEqual({ places: [] });
    expect(chatStateSnapshot(state).sceneMemory).toEqual({ places: [] });
  });

  it("seeds the outfit MARKER from the character form's defaultOutfit ids; blank when none authored", () => {
    // defaultOutfit holds library item IDS — the pure seed writes them as the
    // marker resolveSeededOutfit later swaps for the readable garment phrase
    // (owner report 2026-07-11: the raw ids used to reach the narrator).
    expect(seedChatState(profile()).outfit).toBe("");
    const dressed = seedChatState(profile({ defaultOutfit: ["itemid1abc", "itemid2def"] }));
    expect(dressed.outfit).toBe(seededOutfitMarker(profile({ defaultOutfit: ["itemid1abc", "itemid2def"] })));
    expect(dressed.outfit).toBe("itemid1abc, itemid2def");
    expect(dressed.outfitExposed).toBe(false);
  });

  it("resolveSeededOutfit is a no-op for author-edited outfit text and for empty outfits", async () => {
    const dressed = profile({ defaultOutfit: ["itemid1abc"] });
    const edited = { ...seedChatState(dressed), outfit: "a linen sundress, nothing else" };
    // Author text ≠ the marker → untouched, and no item lookup happens (db is unmocked here;
    // a lookup would throw, so resolution being reached at all would fail this test).
    expect(await resolveSeededOutfit(edited, "u-1", dressed)).toBe(edited);
    const bare = seedChatState(profile());
    expect(await resolveSeededOutfit(bare, "u-1", profile())).toBe(bare);
  });

  it("seeds both axes from the authored playerRelationship record at band midpoints", () => {
    const authored = seedChatState(
      profile({
        playerRelationship: {
          familiarity: "deeply_known",
          regard: "cool",
          kind: "estranged childhood friends",
          history: "he left town without a word",
          presented: { lean: "masks_warmth", note: "" },
          looming: false,
          note: "",
        },
      }),
    );
    expect(authored.regard).toBe(regardBandMidpoint("cool"));
    expect(authored.familiarity).toBe(familiarityBandMidpoint("deeply_known"));
    expect(authored.relationship.kind).toBe("estranged childhood friends");
    expect(authored.relationship.presented?.lean).toBe("masks_warmth");
    expect(authored.familiaritySceneGain).toBe(0);
  });

  it("heals the legacy {stage, note} shape through the schema (stage → both bands)", () => {
    const parsed = characterProfileSchema.parse({ playerRelationship: { stage: "warm", note: "" } });
    const warm = seedChatState(parsed);
    expect(warm.regard).toBe(stageMidpoint("warm")); // the regard scalar is the same axis
    expect(warm.familiarity).toBe(familiarityBandMidpoint("acquainted")); // warm implied some knowledge
  });

  it("self-heals a malformed authored stage to strangers/neutral ⇒ zeroed axes", () => {
    const parsed = characterProfileSchema.parse({ playerRelationship: { stage: "not-a-stage" } });
    expect(seedChatState(parsed).regard).toBe(0);
    expect(seedChatState(parsed).familiarity).toBe(familiarityBandMidpoint("strangers"));
  });

  it("pre-fills the premise from playerRelationship.note, and an explicit premise overrides it", () => {
    const withNote = characterProfileSchema.parse({ playerRelationship: { stage: "stranger", note: "her bodyguard" } });
    expect(seedChatState(withNote).premise).toBe("her bodyguard");
    expect(seedChatState(withNote, "tonight she leaves").premise).toBe("tonight she leaves");
  });
});

describe("driftChatState (D8 — in-game time only)", () => {
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(profile()), ...overrides });

  it("within-visit tick advances the clock and decays meters toward their baseline", () => {
    const drifted = driftChatState(base(), profile(), { advance: true });
    expect(drifted.clockMinutes).toBe(CHAT_TICK_MINUTES);
    expect(drifted.meters.hygiene).toBeLessThan(0.9); // drifts toward the grime pole
    expect(drifted.meters.energy).toBeLessThan(0.9);
  });

  it("a read without advance is a pure pass-through — no wall-clock recovery exists (D8)", () => {
    const tired = base({ meters: { ...initialMeters(), hygiene: 0.2, energy: 0.2 } });
    // However long the player was away, nothing moves: no second clock.
    expect(driftChatState(tired, profile(), { advance: false })).toEqual(tired);
    expect(driftChatState(tired, profile(), {})).toEqual(tired);
  });

  it("never decays affinity (no between-visit decay — spec §10)", () => {
    const warm = base({ regard: 57 });
    expect(driftChatState(warm, profile(), { advance: false }).regard).toBe(57);
    expect(driftChatState(warm, profile(), { advance: true }).regard).toBe(57);
  });

  it("expires conditions past the clock during the within-visit tick", () => {
    const condition: ActiveCondition = { id: "tipsy", label: "Tipsy", startedAtMinutes: 0, durationMinutes: 2, attributeEffects: [] };
    const withCondition = base({ conditions: [condition] });
    // Tick advances the clock past started + duration (2) ⇒ expired.
    expect(driftChatState(withCondition, profile(), { advance: true }).conditions).toHaveLength(0);
    // A read (no advance) keeps the chat clock still ⇒ the condition survives.
    expect(driftChatState(withCondition, profile(), { advance: false }).conditions).toHaveLength(1);
  });
});

describe("applyTimeSkip (spec §8.1 — flavor-only v1, D14)", () => {
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(profile()), ...overrides });
  const now = new Date("2026-07-02T12:00:00Z");

  it("advances the clock by the amount's minutes and stamps a one-shot skip note", () => {
    const skipped = applyTimeSkip(base(), "overnight", now);
    expect(skipped.clockMinutes).toBe(CHAT_SKIP_MINUTES.overnight);
    expect(skipped.pendingSkipNote).toContain("next morning");
    expect(skipped.pendingSkipNote).toMatch(/once/);
  });

  it("meters do NOT change (D14 — narrative flavor, never a flat recovery rule)", () => {
    const tired = base({ meters: { ...initialMeters(), hygiene: 0.2, energy: 0.1, intoxication: 0.8 } });
    const skipped = applyTimeSkip(tired, "days", now);
    expect(skipped.meters).toEqual(tired.meters);
    expect(skipped.regard).toBe(tired.regard);
  });

  it("lets already-running timed conditions expire through the existing clock-keyed filter", () => {
    const tipsy: ActiveCondition = { id: "tipsy", label: "Tipsy", startedAtMinutes: 0, durationMinutes: 90, attributeEffects: [] };
    const open: ActiveCondition = { id: "vow", label: "A promise", startedAtMinutes: 0, attributeEffects: [] };
    const skipped = applyTimeSkip(base({ conditions: [tipsy, open] }), "overnight", now);
    expect(skipped.conditions.map((c) => c.id)).toEqual(["vow"]); // timed expired; open-ended survives
  });

  it("records the skip into the capped history ring (the scaffolded time-effects data)", () => {
    const first = applyTimeSkip(base(), "hours", now);
    expect(first.skipHistory).toEqual([{ at: now.toISOString(), clockMinutes: CHAT_SKIP_MINUTES.hours, amount: "hours" }]);
    const full = base({
      skipHistory: Array.from({ length: SKIP_HISTORY_CAP }, (_, i) => ({ at: "x", clockMinutes: i, amount: "moments" as const })),
    });
    const capped = applyTimeSkip(full, "moments", now);
    expect(capped.skipHistory).toHaveLength(SKIP_HISTORY_CAP);
    expect(capped.skipHistory.at(-1)?.clockMinutes).toBe(CHAT_SKIP_MINUTES.moments);
  });

  it("words the note by stage band (a lover misses you; a stranger just notes the gap)", () => {
    const strangerNote = applyTimeSkip(base({ regard: 0 }), "days", now).pendingSkipNote;
    const closeNote = applyTimeSkip(base({ regard: 70 }), "days", now).pendingSkipNote;
    const hostileNote = applyTimeSkip(base({ regard: -80 }), "days", now).pendingSkipNote;
    expect(strangerNote).toContain("naturally");
    expect(closeNote).toContain("missed them");
    expect(hostileNote).toContain("curtly");
    // All bands carry the §8.2 "a life meanwhile" license.
    for (const note of [strangerNote, closeNote, hostileNote]) expect(note).toMatch(/meanwhile/);
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
    expect(trace.regardDelta).toBeGreaterThan(0);
    expect(next.regard).toBe(trace.regardDelta);
    expect(next.meters.mood).toBeGreaterThan(0.5);
    expect(next.mindNote).toBe("thinking");
    expect(trace.changed).toContain("regard");
  });

  it("a disliked act lowers affinity and mood", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("insult"), dislikeProfile, "Mara");
    expect(trace.valence).toBe("dislike");
    expect(trace.regardDelta).toBeLessThan(0);
    expect(next.regard).toBeLessThan(0);
    expect(next.meters.mood).toBeLessThan(0.5);
  });

  it("clamps the affinity move to ±AFFINITY_DELTA_CLAMP", () => {
    const intense = profile({ preferences: [{ target: "insult", valence: "dislike", intensity: 10 }] });
    const { trace } = applyChatPulse(state(), pulse("insult"), intense, "Mara");
    expect(trace.regardDelta).toBeGreaterThanOrEqual(-5);
  });

  it("an unrecognised act moves nothing but still refreshes the mindNote", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("compliment", "warmer now"), profile(), "Mara");
    expect(trace.valence).toBeNull();
    expect(trace.regardDelta).toBe(0);
    expect(next.regard).toBe(0);
    expect(next.mindNote).toBe("warmer now");
    expect(trace.changed).toEqual(["mindNote"]);
  });

  it("a null act leaves state untouched except the mindNote", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse(null, "still musing"), likeProfile, "Mara");
    expect(trace.concept).toBeNull();
    expect(next.regard).toBe(0);
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
    expect(trace.regardDelta).toBeLessThan(0);
  });

  it("no active card on the concept ⇒ no card reaction (the active set is authoritative)", () => {
    const { trace } = applyChatPulse(state(), pulse("criticize"), profile(), "Mara");
    expect(trace.valence).toBeNull();
    expect(trace.regardDelta).toBe(0);
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
    const input: ChatState = { ...seedChatState(profile()), regard: 12, mindNote: "before" };
    const { state, degraded } = await runChatPulse({
      state: input,
      profile: profile(),
      characterName: "Mara",
      playerName: "Theo",
      exchange: { player: "hi", assistant: "[Mara] \"hi\"" },
      sink,
    });
    expect(degraded).toBe(true);
    expect(state.regard).toBe(12); // unchanged — drift-only
    expect(state.mindNote).toBe("before");
    expect(state.lastPulseTrace.degraded).toBe(true);
    expect(sink.items.some((d) => d.code === "chat_state.pulse.degraded")).toBe(true);
  });
});

describe("regard band chip mapping (the strip's band label)", () => {
  it("maps a warm regard seed to the warm band", () => {
    const parsed = characterProfileSchema.parse({ playerRelationship: { stage: "warm", note: "" } });
    expect(regardBandForValue(seedChatState(parsed).regard).id).toBe("warm");
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
