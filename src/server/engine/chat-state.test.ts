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
  applyTimeSkipToScenario,
  chatStateSnapshot,
  driftChatState,
  resolveSeededOutfit,
  runChatPulse,
  seedChatScenario,
  seedChatState,
  seededOutfitMarker,
  settleEnsembleMember,
  type ChatScenario,
  type ChatState,
} from "./chat-state";

// These run with AI_FAKE=1 (src/test/setup.ts): demo mode short-circuits the
// pulse LLM, so runChatPulse exercises the drift-only degrade path.

function profile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return { ...emptyCharacterProfile(), ...overrides };
}

describe("seedChatState", () => {
  it("seeds rested meters, neutral affinity, and a blank mind for a default profile", () => {
    const state = seedChatState(profile());
    expect(state.meters).toEqual(initialMeters());
    expect(state.regard).toBe(0);
    expect(state.mindNote).toBe(""); // never seeded — purely dynamic
    expect(state.relationshipHistory).toEqual([]);
    expect(state.milestones).toEqual([]);
    expect(state.presence).toBe("present");
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
});

describe("seedChatScenario (the chat-wide half — followups rulings 8-9)", () => {
  it("seeds an empty premise, a zeroed clock, and empty skip/scene fields for a default profile", () => {
    const scenario = seedChatScenario(profile());
    expect(scenario.premise).toBe("");
    expect(scenario.pendingSkipNote).toBe("");
    expect(scenario.skipHistory).toEqual([]);
    expect(scenario.clockMinutes).toBe(0);
    expect(scenario.sceneAuto).toBe("off");
    expect(scenario.sceneModel).toBe("reference");
    // Chat scene memory starts empty and rides the snapshot (and the FK-cascade reset).
    expect(scenario.sceneMemory).toEqual({ places: [] });
    expect(chatStateSnapshot(seedChatState(profile()), scenario).sceneMemory).toEqual({ places: [] });
  });

  it("pre-fills the premise from playerRelationship.note, and an explicit premise overrides it", () => {
    const withNote = characterProfileSchema.parse({ playerRelationship: { stage: "stranger", note: "her bodyguard" } });
    expect(seedChatScenario(withNote).premise).toBe("her bodyguard");
    expect(seedChatScenario(withNote, "tonight she leaves").premise).toBe("tonight she leaves");
  });

  it("seeds the setting-wide house rules from the PRIMARY's own cards (ruling 9)", () => {
    const card: SocialReactionCard = {
      id: "no-crit",
      label: "Criticism is taboo here",
      description: "",
      kind: "taboo",
      triggers: ["criticize"],
      severity: 60,
      reactionOverrides: [],
    };
    expect(seedChatScenario(profile()).activeSocialCards).toEqual([]);
    expect(seedChatScenario(profile({ socialCards: [card] })).activeSocialCards).toEqual([card]);
  });
});

describe("driftChatState (D8 — in-game time only, clock on the shared scenario)", () => {
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(profile()), ...overrides });

  it("within-visit tick decays meters toward their baseline (the clock lives on the scenario)", () => {
    const drifted = driftChatState(base(), profile(), { advance: true, clockMinutes: CHAT_TICK_MINUTES });
    expect(drifted.meters.hygiene).toBeLessThan(0.9); // drifts toward the grime pole
    expect(drifted.meters.energy).toBeLessThan(0.9);
  });

  it("a read without advance is a pure pass-through — no wall-clock recovery exists (D8)", () => {
    const tired = base({ meters: { ...initialMeters(), hygiene: 0.2, energy: 0.2 } });
    // However long the player was away, nothing moves: no second clock.
    expect(driftChatState(tired, profile(), { advance: false, clockMinutes: 0 })).toBe(tired);
    expect(driftChatState(tired, profile(), { clockMinutes: 0 })).toBe(tired);
  });

  it("never decays affinity (no between-visit decay — spec §10)", () => {
    const warm = base({ regard: 57 });
    expect(driftChatState(warm, profile(), { advance: false, clockMinutes: 0 }).regard).toBe(57);
    expect(driftChatState(warm, profile(), { advance: true, clockMinutes: CHAT_TICK_MINUTES }).regard).toBe(57);
  });

  it("expires conditions past the SHARED clock — even for a frozen (no-advance) member", () => {
    const condition: ActiveCondition = { id: "tipsy", label: "Tipsy", startedAtMinutes: 0, durationMinutes: 2, attributeEffects: [] };
    const withCondition = base({ conditions: [condition] });
    // The ticked clock is past started + duration (2) ⇒ expired.
    expect(driftChatState(withCondition, profile(), { advance: true, clockMinutes: CHAT_TICK_MINUTES }).conditions).toHaveLength(0);
    // Away members share the ONE story timeline (ruling 8): only meter decay is
    // skipped — their conditions still expire against the shared clock.
    expect(driftChatState(withCondition, profile(), { advance: false, clockMinutes: CHAT_TICK_MINUTES }).conditions).toHaveLength(0);
    // A read with the clock still at 0 keeps the condition running.
    expect(driftChatState(withCondition, profile(), { advance: false, clockMinutes: 0 }).conditions).toHaveLength(1);
  });
});

describe("time skips (spec §8.1 — flavor-only v1, D14; split across scenario + member halves)", () => {
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(profile()), ...overrides });
  const scen = (overrides: Partial<ChatScenario> = {}): ChatScenario => ({ ...seedChatScenario(profile()), ...overrides });
  const now = new Date("2026-07-02T12:00:00Z");
  const neutralBand = regardBandForValue(0).id;

  it("advances the scenario clock by the amount's minutes and stamps a one-shot skip note", () => {
    const skipped = applyTimeSkipToScenario(scen(), "overnight", neutralBand, now);
    expect(skipped.clockMinutes).toBe(CHAT_SKIP_MINUTES.overnight);
    expect(skipped.pendingSkipNote).toContain("next morning");
    expect(skipped.pendingSkipNote).toMatch(/once/);
  });

  it("meters do NOT change (D14 — narrative flavor, never a flat recovery rule)", () => {
    const tired = base({ meters: { ...initialMeters(), hygiene: 0.2, energy: 0.1, intoxication: 0.8 } });
    const skipped = applyTimeSkip(tired, "days", CHAT_SKIP_MINUTES.days);
    expect(skipped.meters).toEqual(tired.meters);
    expect(skipped.regard).toBe(tired.regard);
  });

  it("lets already-running timed conditions expire through the existing clock-keyed filter", () => {
    const tipsy: ActiveCondition = { id: "tipsy", label: "Tipsy", startedAtMinutes: 0, durationMinutes: 90, attributeEffects: [] };
    const open: ActiveCondition = { id: "vow", label: "A promise", startedAtMinutes: 0, attributeEffects: [] };
    const skipped = applyTimeSkip(base({ conditions: [tipsy, open] }), "overnight", CHAT_SKIP_MINUTES.overnight);
    expect(skipped.conditions.map((c) => c.id)).toEqual(["vow"]); // timed expired; open-ended survives
  });

  it("records the skip into the scenario's capped history ring (the scaffolded time-effects data)", () => {
    const first = applyTimeSkipToScenario(scen(), "hours", neutralBand, now);
    expect(first.skipHistory).toEqual([{ at: now.toISOString(), clockMinutes: CHAT_SKIP_MINUTES.hours, amount: "hours" }]);
    const full = scen({
      skipHistory: Array.from({ length: SKIP_HISTORY_CAP }, (_, i) => ({ at: "x", clockMinutes: i, amount: "moments" as const })),
    });
    const capped = applyTimeSkipToScenario(full, "moments", neutralBand, now);
    expect(capped.skipHistory).toHaveLength(SKIP_HISTORY_CAP);
    expect(capped.skipHistory.at(-1)?.clockMinutes).toBe(CHAT_SKIP_MINUTES.moments);
  });

  it("words the note by the PRIMARY's band (a lover misses you; a stranger just notes the gap)", () => {
    const strangerNote = applyTimeSkipToScenario(scen(), "days", regardBandForValue(0).id, now).pendingSkipNote;
    const closeNote = applyTimeSkipToScenario(scen(), "days", regardBandForValue(70).id, now).pendingSkipNote;
    const hostileNote = applyTimeSkipToScenario(scen(), "days", regardBandForValue(-80).id, now).pendingSkipNote;
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
    feeling: null,
    sentPhoto: false,
  });

  it("a liked act raises affinity (clamped) and lifts mood, and records the trace", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("compliment"), likeProfile, "Mara", []);
    expect(trace.concept).toBe("compliment");
    expect(trace.valence).toBe("like");
    expect(trace.regardDelta).toBeGreaterThan(0);
    expect(next.regard).toBe(trace.regardDelta);
    expect(next.meters.mood).toBeGreaterThan(0.5);
    expect(next.mindNote).toBe("thinking");
    expect(trace.changed).toContain("regard");
  });

  it("a disliked act lowers affinity and mood", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("insult"), dislikeProfile, "Mara", []);
    expect(trace.valence).toBe("dislike");
    expect(trace.regardDelta).toBeLessThan(0);
    expect(next.regard).toBeLessThan(0);
    expect(next.meters.mood).toBeLessThan(0.5);
  });

  it("clamps the affinity move to ±AFFINITY_DELTA_CLAMP", () => {
    const intense = profile({ preferences: [{ target: "insult", valence: "dislike", intensity: 10 }] });
    const { trace } = applyChatPulse(state(), pulse("insult"), intense, "Mara", []);
    expect(trace.regardDelta).toBeGreaterThanOrEqual(-5);
  });

  it("an unrecognised act moves nothing but still refreshes the mindNote", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("compliment", "warmer now"), profile(), "Mara", []);
    expect(trace.valence).toBeNull();
    expect(trace.regardDelta).toBe(0);
    expect(next.regard).toBe(0);
    expect(next.mindNote).toBe("warmer now");
    expect(trace.changed).toEqual(["mindNote"]);
  });

  it("a null act leaves state untouched except the mindNote", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse(null, "still musing"), likeProfile, "Mara", []);
    expect(trace.concept).toBeNull();
    expect(next.regard).toBe(0);
    expect(next.mindNote).toBe("still musing");
  });

  it("an empty mindNote keeps the prior note", () => {
    const prior: ChatState = { ...state(), mindNote: "kept" };
    expect(applyChatPulse(prior, pulse(null, ""), profile(), "Mara", []).state.mindNote).toBe("kept");
  });

  it("raises arousal on an intimate act (proposition), full amount", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("proposition"), profile(), "Mara", []);
    expect(trace.arousalDelta).toBeCloseTo(CHAT_AROUSAL_INTIMATE, 5);
    expect(next.meters.arousal).toBeCloseTo(CHAT_AROUSAL_INTIMATE, 5);
    expect(trace.changed).toContain("arousal");
  });

  it("raises arousal half as much for a courtship act (flirt)", () => {
    const { trace } = applyChatPulse(state(), pulse("flirt"), profile(), "Mara", []);
    expect(trace.arousalDelta).toBeCloseTo(CHAT_AROUSAL_INTIMATE / 2, 5);
  });

  it("does not raise arousal when the intimate act is disliked", () => {
    const prude = profile({ preferences: [{ target: "proposition", valence: "dislike", intensity: 6 }] });
    const { state: next, trace } = applyChatPulse(state(), pulse("proposition"), prude, "Mara", []);
    expect(trace.arousalDelta).toBe(0);
    expect(next.meters.arousal).toBe(0);
  });

  it("resolves a reaction against the SCENARIO's setting-wide cards (followups ruling 9)", () => {
    const taboo: SocialReactionCard = {
      id: "no-crit",
      label: "Criticism is taboo here",
      description: "",
      kind: "taboo",
      triggers: ["criticize"],
      severity: 60,
      reactionOverrides: [],
    };
    const { trace } = applyChatPulse(state(), pulse("criticize"), profile(), "Mara", [taboo]);
    expect(trace.concept).toBe("criticize");
    expect(trace.valence).toBe("dislike");
    expect(trace.regardDelta).toBeLessThan(0);
  });

  it("no active card on the concept ⇒ no card reaction (the active set is authoritative)", () => {
    const { trace } = applyChatPulse(state(), pulse("criticize"), profile(), "Mara", []);
    expect(trace.valence).toBeNull();
    expect(trace.regardDelta).toBe(0);
  });
});

describe("applyChatAction (test-bed chips)", () => {
  const state = (): ChatState => seedChatState(profile());

  it("offer a drink raises intoxication", () => {
    expect(applyChatAction(state(), "drink", 0).meters.intoxication).toBeCloseTo(0.3, 5);
  });

  it("freshen up restores hygiene", () => {
    const tired = { ...state(), meters: { ...initialMeters(), hygiene: 0.2 } };
    expect(applyChatAction(tired, "freshen", 0).meters.hygiene).toBeCloseTo(0.95, 5);
  });

  it("take a breather lifts energy and lowers stress", () => {
    const drained = { ...state(), meters: { ...initialMeters(), energy: 0.4, stress: 0.5 } };
    const next = applyChatAction(drained, "rest", 0);
    expect(next.meters.energy).toBeCloseTo(0.6, 5);
    expect(next.meters.stress).toBeCloseTo(0.3, 5);
  });

  it("heat things up raises arousal and adds a self-expiring flushed condition stamped at the shared clock", () => {
    const next = applyChatAction(state(), "fluster", 120);
    expect(next.meters.arousal).toBeCloseTo(0.25, 5);
    const flushed = next.conditions.find((c) => c.id === "flushed");
    expect(flushed).toBeDefined();
    expect(flushed?.startedAtMinutes).toBe(120);
    expect(flushed?.durationMinutes).toBeGreaterThan(0);
  });

  it("re-applying a condition chip refreshes rather than duplicates it", () => {
    const once = applyChatAction(state(), "fluster", 0);
    const twice = applyChatAction(once, "fluster", 0);
    expect(twice.conditions.filter((c) => c.id === "flushed")).toHaveLength(1);
  });
});

describe("settleEnsembleMember (followups rulings 10-11)", () => {
  const now = new Date("2026-07-12T12:00:00Z");
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(profile()), ...overrides });
  const settle = (args: Partial<Parameters<typeof settleEnsembleMember>[0]> & { state: ChatState }) =>
    settleEnsembleMember({
      preRegard: args.state.regard,
      pulsed: false,
      personal: null,
      characterName: "Vera",
      assistantMessageId: "msg-1",
      now,
      clockMinutes: 30,
      ...args,
    });

  it("a pulsed member records the arc baseline sample + first_exchange milestone (ruling 11)", () => {
    const next = settle({ state: base(), pulsed: true });
    expect(next.relationshipHistory).toHaveLength(1);
    expect(next.relationshipHistory[0]).toMatchObject({ clockMinutes: 30, regard: 0 });
    expect(next.milestones.map((m) => m.kind)).toEqual(["first_exchange"]);
  });

  it("a regard move samples the arc and a big delta mints a strong_reaction milestone", () => {
    const moved = settle({
      state: base({
        regard: 5,
        relationshipHistory: [{ at: "x", clockMinutes: 0, regard: 0, band: "neutral", familiarity: 0 }],
        lastPulseTrace: { ...seedChatState(profile()).lastPulseTrace, regardDelta: 5, concept: "compliment" },
      }),
      preRegard: 0,
      pulsed: true,
    });
    expect(moved.relationshipHistory).toHaveLength(2);
    expect(moved.milestones.map((m) => m.kind)).toContain("strong_reaction");
  });

  it("an unpulsed member gets no sample and no milestones", () => {
    const next = settle({ state: base(), pulsed: false });
    expect(next.relationshipHistory).toEqual([]);
    expect(next.milestones).toEqual([]);
  });

  it("folds the personal pass: loops replace in full, an outfit proposal replaces the tracked look (ruling 10)", () => {
    const next = settle({
      state: base({ openLoops: ["old promise"], outfit: "a sundress", outfitExposed: false }),
      personal: {
        openLoops: ["show the player her studio"],
        attributeChanges: [],
        outfit: { description: "a paint-streaked tank top", exposed: false },
        driveUpdates: [],
      },
    });
    expect(next.openLoops).toEqual(["show the player her studio"]);
    expect(next.outfit).toBe("a paint-streaked tank top");
  });

  it("a null personal pass (absent/degraded) keeps the member's prior personal fields", () => {
    const prior = base({ openLoops: ["old promise"], outfit: "a sundress" });
    const next = settle({ state: prior, personal: null });
    expect(next.openLoops).toEqual(["old promise"]);
    expect(next.outfit).toBe("a sundress");
  });

  it("a revealed secret drive mints the secret_shared milestone", () => {
    const withDrive = base({
      drives: [{ want: "leave this town", why: "", secrecy: "secret", revealed: false, resolved: false, progress: "" }],
    });
    const next = settle({
      state: withDrive,
      personal: {
        openLoops: [],
        attributeChanges: [],
        outfit: { description: "", exposed: false },
        driveUpdates: [{ want: "leave this town", progress: "", revealed: true, resolved: false }],
      },
    });
    expect(next.milestones.map((m) => m.kind)).toContain("secret_shared");
    expect(next.drives[0]?.revealed).toBe(true);
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
      activeSocialCards: [],
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
  const scenario = (): ChatScenario => seedChatScenario(profile());
  const withMeters = (over: Record<string, number>): ChatState => ({
    ...seedChatState(profile()),
    meters: { ...initialMeters(), ...over },
  });

  it("carries a derived emotion label + bounded intensity", () => {
    const snap = chatStateSnapshot(seedChatState(profile()), scenario());
    expect(snap.emotion.label).toBeTruthy();
    expect(snap.emotion.intensity).toBeGreaterThanOrEqual(0);
    expect(snap.emotion.intensity).toBeLessThanOrEqual(1);
  });

  it("dominance tilts a low, calm mood from sad toward angry", () => {
    const low = withMeters({ mood: 0.2, stress: 0.2 });
    expect(chatStateSnapshot(low, scenario(), { dominance: 0 }).emotion.label).toBe("sad");
    expect(chatStateSnapshot(low, scenario(), { dominance: 80 }).emotion.label).toBe("angry");
  });

  it("intimateContext gates the aroused label at high arousal (chat passes it on)", () => {
    const hot = withMeters({ mood: 0.6, arousal: 0.8 });
    expect(chatStateSnapshot(hot, scenario(), { intimateContext: false }).emotion.label).not.toBe("aroused");
    expect(chatStateSnapshot(hot, scenario(), { intimateContext: true }).emotion.label).toBe("aroused");
  });

  it("persisted defaults true and is honored when set false (fresh-chat seed preview)", () => {
    expect(chatStateSnapshot(seedChatState(profile()), scenario()).persisted).toBe(true);
    expect(chatStateSnapshot(seedChatState(profile()), scenario(), { persisted: false }).persisted).toBe(false);
  });

  it("merges the scenario's chat-wide fields into the back-compat snapshot shape", () => {
    const snap = chatStateSnapshot(
      seedChatState(profile()),
      { ...scenario(), premise: "the night before she moves away", clockMinutes: 45, sceneAuto: "milestones" },
    );
    expect(snap.premise).toBe("the night before she moves away");
    expect(snap.clockMinutes).toBe(45);
    expect(snap.sceneAuto).toBe("milestones");
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

describe("emotional weather wiring (emotional-weather.plan.md)", () => {
  const likeProfile = profile({ preferences: [{ target: "compliment", valence: "like", intensity: 5 }] });
  const pulseWith = (overrides: Partial<ChatPulse>): ChatPulse => ({
    playerAct: null,
    mindNote: "",
    feeling: null,
    sentPhoto: false,
    ...overrides,
  });

  it("applies a pulse feeling proposal with curve-derived intensity and records the trace", () => {
    const { state: next, trace } = applyChatPulse(
      seedChatState(profile()),
      pulseWith({ feeling: { label: "sad", cause: "the broken promise" } }),
      profile(),
      "Mara",
      [],
    );
    expect(next.feeling.current?.label).toBe("sad");
    expect(next.feeling.current?.cause).toBe("the broken promise");
    expect(next.feeling.current?.intensity).toBeCloseTo(0.35); // no mechanical move ⇒ moderate
    expect(trace.feeling).toBe("sad");
    expect(trace.changed).toContain("feeling");
  });

  it("a 'neutral' proposal clears the standing feeling", () => {
    const standing = { ...seedChatState(profile()), feeling: { current: { label: "sad" as const, intensity: 0.8, cause: "x" }, bruise: null } };
    const { state: next } = applyChatPulse(standing, pulseWith({ feeling: { label: "neutral", cause: "" } }), profile(), "Mara", []);
    expect(next.feeling.current).toBeNull();
  });

  it("an accepted apologize halves a live bruise", () => {
    const bruised = { ...seedChatState(profile()), feeling: { current: null, bruise: { remaining: 10 } } };
    const { state: next, trace } = applyChatPulse(bruised, pulseWith({ playerAct: { concept: "apologize" } }), profile(), "Mara", []);
    expect(next.feeling.bruise?.remaining).toBe(5);
    expect(trace.changed).toContain("bruise");
  });

  it("a bruise halves positive gains and the trace records the scale", () => {
    const bruised = { ...seedChatState(profile()), feeling: { current: null, bruise: { remaining: 10 } } };
    const clean = applyChatPulse(seedChatState(profile()), pulseWith({ playerAct: { concept: "compliment" } }), likeProfile, "Mara", []);
    const damped = applyChatPulse(bruised, pulseWith({ playerAct: { concept: "compliment" } }), likeProfile, "Mara", []);
    expect(clean.trace.regardDelta).toBeGreaterThan(0);
    expect(damped.trace.regardDelta).toBeLessThanOrEqual(Math.ceil(clean.trace.regardDelta / 2));
    expect(damped.trace.regardScale).toBeLessThan(1);
  });

  it("drift decays the feeling per exchange; a days skip clears it", () => {
    const felt = {
      ...seedChatState(profile()),
      feeling: { current: { label: "angry" as const, intensity: 0.9, cause: "the lie" }, bruise: { remaining: 4 } },
    };
    const drifted = driftChatState(felt, profile(), { advance: true, clockMinutes: CHAT_TICK_MINUTES });
    expect(drifted.feeling.current?.intensity).toBeCloseTo(0.75);
    expect(drifted.feeling.bruise?.remaining).toBe(3);
    const skipped = applyTimeSkip(felt, "days", CHAT_SKIP_MINUTES.days);
    expect(skipped.feeling.current).toBeNull();
    expect(skipped.feeling.bruise).toBeNull();
    // A "moments" skip barely dents it — emotional time is slower than beat time.
    const moments = applyTimeSkip(felt, "moments", CHAT_SKIP_MINUTES.moments);
    expect(moments.feeling.current?.intensity).toBeCloseTo(0.75);
  });

  it("seeds empty weather and rides the snapshot", () => {
    const state = seedChatState(profile());
    expect(state.feeling).toEqual({ current: null, bruise: null });
    expect(chatStateSnapshot(state, seedChatScenario(profile())).feeling).toEqual({ current: null, bruise: null });
  });
});
