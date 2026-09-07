import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { initialMeters } from "@/contracts/meters/registry";
import { stageMidpoint } from "@/contracts/relationships/stages";
import { familiarityBandMidpoint, regardBandForValue, regardBandMidpoint } from "@/contracts/relationships/bands";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import type { ChatPersonalNotes } from "@/contracts/turns/chat-archivist";
import type { ChatPulse } from "@/contracts/turns/chat-pulse";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { characterProfileSchema } from "@/contracts/world/profile";
import { makeProfile } from "@/server/test-support";
import { SKIP_HISTORY_CAP } from "@/contracts/turns/chat-skip";
import { CHAT_AROUSAL_INTIMATE, CHAT_SKIP_MINUTES, CHAT_TICK_MINUTES } from "./constants";
import {
  applyChatAction,
  applyChatAttributeOverlays,
  applyChatTraitOverlays,
  applyChatPulse,
  applyOpenerPulse,
  applyTimeSkip,
  applyTimeSkipToScenario,
  chatStateSnapshot,
  driftChatState,
  rhythmOutfitPatch,
  seedChatScenario,
  seedChatState,
  settleEnsembleMember,
  type ChatScenario,
  type ChatState,
} from "./chat-state";
import { matchOutfitPresetInText, outfitChangeEvidenceValidated } from "./chat-state/outfit-evidence";
import { resolveSeededOutfit } from "./chat-state/outfit-fold";
import { runChatPulse } from "./chat-state/pulse-agent";
import { rollbackScenario } from "./chat-state/snapshots";
import { seededOutfitMarker } from "./chat-wardrobe";

// These run with AI_FAKE=1 (src/test/setup.ts): demo mode short-circuits the
// pulse LLM, so runChatPulse exercises the drift-only degrade path.

describe("seedChatState", () => {
  it("seeds rested meters, neutral affinity, and a blank mind for a default profile", () => {
    const state = seedChatState(makeProfile());
    expect(state.meters).toEqual(initialMeters());
    expect(state.regard).toBe(0);
    expect(state.mindNote).toBe(""); // never seeded — purely dynamic
    expect(state.relationshipHistory).toEqual([]);
    expect(state.milestones).toEqual([]);
    expect(state.presence).toBe("present");
  });

  it("seeds the structured worn list + active preset from the default preset", () => {
    // The default preset (outfits[0]) holds library item IDS — the pure seed now writes them
    // straight into the structured `wornItemIds` (no marker hack) + the active preset id; the
    // free-text overlay starts empty.
    const dressedProfile = () =>
      makeProfile({ outfits: [{ id: "everyday", name: "Everyday", items: ["itemid1abc", "itemid2def"] }] });
    const empty = seedChatState(makeProfile());
    expect(empty.wornItemIds).toEqual([]);
    expect(empty.outfitPresetId).toBe("");
    expect(empty.outfit).toBe("");
    const dressed = seedChatState(dressedProfile());
    expect(dressed.wornItemIds).toEqual(["itemid1abc", "itemid2def"]);
    expect(dressed.outfitPresetId).toBe("everyday");
    expect(dressed.outfit).toBe("");
    expect(dressed.outfitExposed).toBe(false);
  });

  it("seededOutfitMarker resolves a NAMED preset; unknown ids degrade to the default", () => {
    const wardrobe = makeProfile({
      outfits: [
        { id: "everyday", name: "Everyday", items: ["itemid1abc"] },
        { id: "work", name: "Work", items: ["itemid9xyz"] },
      ],
    });
    expect(seededOutfitMarker(wardrobe, "work")).toBe("itemid9xyz");
    expect(seededOutfitMarker(wardrobe, "nope")).toBe("itemid1abc");
    expect(seededOutfitMarker(wardrobe)).toBe("itemid1abc");
  });

  it("resolveSeededOutfit is a no-op for author-edited outfit text and for empty outfits", async () => {
    const dressed = makeProfile({ outfits: [{ id: "everyday", name: "Everyday", items: ["itemid1abc"] }] });
    const edited = { ...seedChatState(dressed), outfit: "a linen sundress, nothing else" };
    // Author text ≠ the marker → untouched, and no item lookup happens (db is unmocked here;
    // a lookup would throw, so resolution being reached at all would fail this test).
    expect(await resolveSeededOutfit(edited, "u-1", dressed)).toBe(edited);
    const bare = seedChatState(makeProfile());
    expect(await resolveSeededOutfit(bare, "u-1", makeProfile())).toBe(bare);
  });

  it("matchOutfitPresetInText: exact name or name + outfit word; prose garments never hijack (slice 8.3)", () => {
    const wardrobe = makeProfile({
      outfits: [
        { id: "everyday", name: "Everyday", items: ["itemid1abc"] },
        { id: "work", name: "Work", items: ["itemid9xyz"] },
        { id: "empty", name: "Gala", items: [] },
      ],
    });
    expect(matchOutfitPresetInText(wardrobe, "work")?.id).toBe("work");
    expect(matchOutfitPresetInText(wardrobe, "changes into her work clothes")?.id).toBe("work");
    expect(matchOutfitPresetInText(wardrobe, "her everyday outfit, hair still damp")?.id).toBe("everyday");
    // A garment description that merely CONTAINS a preset word stays free text…
    expect(matchOutfitPresetInText(wardrobe, "heavy work boots and a red sundress")).toBeUndefined();
    // …an empty preset never matches, and neither does unrelated text.
    expect(matchOutfitPresetInText(wardrobe, "gala outfit")).toBeUndefined();
    expect(matchOutfitPresetInText(wardrobe, "a black slip, nothing else")).toBeUndefined();
  });

  it("rhythmOutfitPatch dresses by the schedule row's preset at the skipped-to clock (slice 8.4)", () => {
    const rhythm = makeProfile({
      outfits: [
        { id: "everyday", name: "Everyday", items: ["itemid1abc"] },
        { id: "sleep", name: "Sleep", items: ["itemid9xyz"] },
      ],
      schedule: [
        // 11pm–6am, wraps past midnight, dresses for bed.
        { startMinute: 1380, endMinute: 360, locationName: "home", activity: "sleeping", outfitPresetId: "sleep" },
        // Morning row with NO preset — keeps the current outfit.
        { startMinute: 360, endMinute: 720, locationName: "the café", activity: "waiting tables" },
      ],
    });
    // Minute-of-day is anchor-relative: a midnight anchor keeps
    // this test's raw clock numbers readable as times of day.
    const midnight = { year: 2024, month: 1, day: 1, hour: 0, minute: 0 };
    // 23:30 → the sleep window → the sleep preset's structured worn list.
    expect(rhythmOutfitPatch(rhythm, 1410, midnight)).toEqual({
      wornItemIds: ["itemid9xyz"],
      outfitPresetId: "sleep",
      outfit: "",
      outfitExposed: false,
    });
    // 08:00 → the morning row names no preset → no patch.
    expect(rhythmOutfitPatch(rhythm, 480, midnight)).toEqual({});
    // A skip past midnight lands in the same wrap window on the next day.
    expect(rhythmOutfitPatch(rhythm, 1440 + 60, midnight)).toEqual({
      wornItemIds: ["itemid9xyz"],
      outfitPresetId: "sleep",
      outfit: "",
      outfitExposed: false,
    });
    // The DEFAULT anchor starts the story at 8:00am: clock 1410 is 7:30 the NEXT
    // morning — inside the café row (no preset) — so no patch.
    expect(rhythmOutfitPatch(rhythm, 1410)).toEqual({});
    // Unknown preset id on a row degrades to the DEFAULT preset (id + items).
    const dangling = makeProfile({
      outfits: [{ id: "everyday", name: "Everyday", items: ["itemid1abc"] }],
      schedule: [{ startMinute: 0, endMinute: 1439, locationName: "x", activity: "y", outfitPresetId: "gone" }],
    });
    expect(rhythmOutfitPatch(dangling, 100)).toEqual({
      wornItemIds: ["itemid1abc"],
      outfitPresetId: "everyday",
      outfit: "",
      outfitExposed: false,
    });
  });

  it("applyTimeSkip re-dresses only when given a profile with a rhythm row", () => {
    const rhythm = makeProfile({
      outfits: [{ id: "sleep", name: "Sleep", items: ["itemid9xyz"] }],
      schedule: [{ startMinute: 0, endMinute: 1439, locationName: "home", activity: "resting", outfitPresetId: "sleep" }],
    });
    const state = { ...seedChatState(rhythm), wornItemIds: [], outfit: "a cocktail dress" };
    // No profile ⇒ no re-dress: the free-text overlay is untouched.
    expect(applyTimeSkip(state, "hours", 200).outfit).toBe("a cocktail dress");
    expect(applyTimeSkip(state, "hours", 200).wornItemIds).toEqual([]);
    // With the profile ⇒ the rhythm dresses her structurally + clears the overlay.
    const dressed = applyTimeSkip(state, "hours", 200, rhythm);
    expect(dressed.wornItemIds).toEqual(["itemid9xyz"]);
    expect(dressed.outfit).toBe("");
  });

  it("seeds both axes from the authored playerRelationship record at band midpoints", () => {
    const authored = seedChatState(
      makeProfile({
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
    const scenario = seedChatScenario(makeProfile());
    expect(scenario.premise).toBe("");
    expect(scenario.pendingSkipNote).toBe("");
    expect(scenario.skipHistory).toEqual([]);
    expect(scenario.clockMinutes).toBe(0);
    expect(scenario.sceneAuto).toBe("off");
    expect(scenario.sceneModel).toBe("reference");
    // Chat scene memory starts empty and rides the snapshot (and the FK-cascade reset).
    expect(scenario.sceneMemory).toEqual({ places: [] });
    expect(chatStateSnapshot(seedChatState(makeProfile()), scenario).sceneMemory).toEqual({ places: [] });
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
    expect(seedChatScenario(makeProfile()).activeSocialCards).toEqual([]);
    expect(seedChatScenario(makeProfile({ socialCards: [card] })).activeSocialCards).toEqual([card]);
  });
});

describe("rollbackScenario ('another take' — the supporting cast never rolls back)", () => {
  const abby = { name: "Abby", relation: "the player's coworker", details: [] };

  it("restores the anchor's fields but keeps the LIVE cast — a member added between takes survives the redo", () => {
    // Owner report 2026-07-13: Abby, added via the panel after a reply, vanished
    // when that reply was rerun — the whole-scenario rollback restored a pre-Abby anchor.
    const anchor: ChatScenario = { ...seedChatScenario(makeProfile()), clockMinutes: 96, pendingSkipNote: "dawn" };
    const live: ChatScenario = { ...seedChatScenario(makeProfile()), clockMinutes: 108, supportingCast: [abby] };
    const rolled = rollbackScenario(anchor, live);
    expect(rolled.clockMinutes).toBe(96);
    expect(rolled.pendingSkipNote).toBe("dawn");
    expect(rolled.supportingCast).toEqual([abby]);
  });

  it("live wins even when smaller — an author Remove between takes doesn't resurrect the anchor's entry", () => {
    const anchor: ChatScenario = { ...seedChatScenario(makeProfile()), supportingCast: [abby] };
    const live: ChatScenario = { ...seedChatScenario(makeProfile()), supportingCast: [] };
    expect(rollbackScenario(anchor, live).supportingCast).toEqual([]);
  });

  it("a missing live scenario degrades to the anchor's own cast", () => {
    const anchor: ChatScenario = { ...seedChatScenario(makeProfile()), supportingCast: [abby] };
    expect(rollbackScenario(anchor, null).supportingCast).toEqual([abby]);
  });
});

describe("driftChatState (D8 — in-game time only, clock on the shared scenario)", () => {
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(makeProfile()), ...overrides });

  it("within-visit tick decays meters toward their baseline (the clock lives on the scenario)", () => {
    const drifted = driftChatState(base(), makeProfile(), { advance: true, clockMinutes: CHAT_TICK_MINUTES });
    expect(drifted.meters.hygiene).toBeLessThan(0.9); // drifts toward the grime pole
    expect(drifted.meters.energy).toBeLessThan(0.9);
  });

  it("a read without advance is a pure pass-through — no wall-clock recovery exists (D8)", () => {
    const tired = base({ meters: { ...initialMeters(), hygiene: 0.2, energy: 0.2 } });
    // However long the player was away, nothing moves: no second clock.
    expect(driftChatState(tired, makeProfile(), { advance: false, clockMinutes: 0 })).toBe(tired);
    expect(driftChatState(tired, makeProfile(), { clockMinutes: 0 })).toBe(tired);
  });

  it("never decays affinity (no between-visit decay)", () => {
    const warm = base({ regard: 57 });
    expect(driftChatState(warm, makeProfile(), { advance: false, clockMinutes: 0 }).regard).toBe(57);
    expect(driftChatState(warm, makeProfile(), { advance: true, clockMinutes: CHAT_TICK_MINUTES }).regard).toBe(57);
  });

  it("expires conditions past the SHARED clock — even for a frozen (no-advance) member", () => {
    const condition: ActiveCondition = { id: "tipsy", label: "Tipsy", startedAtMinutes: 0, durationMinutes: 2, attributeEffects: [] };
    const withCondition = base({ conditions: [condition] });
    // A clock past started + duration (2) ⇒ expired.
    expect(driftChatState(withCondition, makeProfile(), { advance: true, clockMinutes: 3 }).conditions).toHaveLength(0);
    // Away members share the ONE story timeline (ruling 8): only meter decay is
    // skipped — their conditions still expire against the shared clock.
    expect(driftChatState(withCondition, makeProfile(), { advance: false, clockMinutes: 3 }).conditions).toHaveLength(0);
    // A read with the clock still at 0 keeps the condition running.
    expect(driftChatState(withCondition, makeProfile(), { advance: false, clockMinutes: 0 }).conditions).toHaveLength(1);
  });
});

describe("time skips (flavor-only v1, D14; split across scenario + member halves)", () => {
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(makeProfile()), ...overrides });
  const scen = (overrides: Partial<ChatScenario> = {}): ChatScenario => ({ ...seedChatScenario(makeProfile()), ...overrides });
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
    // All bands carry the "a life meanwhile" license.
    for (const note of [strangerNote, closeNote, hostileNote]) expect(note).toMatch(/meanwhile/);
  });
});

describe("applyChatPulse (the deterministic reaction curve)", () => {
  const likeProfile = makeProfile({ preferences: [{ target: "compliment", valence: "like", intensity: 5 }] });
  const dislikeProfile = makeProfile({ preferences: [{ target: "insult", valence: "dislike", intensity: 5 }] });
  const state = (): ChatState => seedChatState(makeProfile());
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
    const intense = makeProfile({ preferences: [{ target: "insult", valence: "dislike", intensity: 10 }] });
    const { trace } = applyChatPulse(state(), pulse("insult"), intense, "Mara", []);
    expect(trace.regardDelta).toBeGreaterThanOrEqual(-5);
  });

  it("an unrecognised act moves nothing but still refreshes the mindNote", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("compliment", "warmer now"), makeProfile(), "Mara", []);
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
    expect(applyChatPulse(prior, pulse(null, ""), makeProfile(), "Mara", []).state.mindNote).toBe("kept");
  });

  it("applyOpenerPulse folds only the reads: sentPhoto + mindNote, never the curve", () => {
    const standing: ChatState = {
      ...state(),
      regard: 60,
      mindNote: "prior",
      feeling: {
        current: { label: "sad", cause: "the broken promise", intensity: 0.6 },
        bruise: null,
      },
    };
    const { state: next, trace } = applyOpenerPulse(standing, {
      // Even a (mis)classified act and a "neutral" feeling proposal must not move
      // anything — a reopen opener has no player act.
      playerAct: { concept: "compliment" },
      mindNote: "she's glad she reached out first",
      feeling: { label: "neutral", cause: "" },
      sentPhoto: true,
    });
    expect(trace.sentPhoto).toBe(true);
    expect(trace.concept).toBeNull();
    expect(trace.regardDelta).toBe(0);
    expect(next.regard).toBe(60);
    expect(next.meters).toEqual(standing.meters);
    expect(next.feeling).toEqual(standing.feeling);
    expect(next.mindNote).toBe("she's glad she reached out first");
    expect(trace.changed).toEqual(["mindNote"]);
    // An empty note keeps the prior one and reports no change.
    const quiet = applyOpenerPulse(standing, { playerAct: null, mindNote: "", feeling: null, sentPhoto: false });
    expect(quiet.state.mindNote).toBe("prior");
    expect(quiet.trace.changed).toEqual([]);
  });

  it("raises arousal on an intimate act (proposition), full amount", () => {
    const { state: next, trace } = applyChatPulse(state(), pulse("proposition"), makeProfile(), "Mara", []);
    expect(trace.arousalDelta).toBeCloseTo(CHAT_AROUSAL_INTIMATE, 5);
    expect(next.meters.arousal).toBeCloseTo(CHAT_AROUSAL_INTIMATE, 5);
    expect(trace.changed).toContain("arousal");
  });

  it("raises arousal half as much for a courtship act (flirt)", () => {
    const { trace } = applyChatPulse(state(), pulse("flirt"), makeProfile(), "Mara", []);
    expect(trace.arousalDelta).toBeCloseTo(CHAT_AROUSAL_INTIMATE / 2, 5);
  });

  it("does not raise arousal when the intimate act is disliked", () => {
    const prude = makeProfile({ preferences: [{ target: "proposition", valence: "dislike", intensity: 6 }] });
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
    const { trace } = applyChatPulse(state(), pulse("criticize"), makeProfile(), "Mara", [taboo]);
    expect(trace.concept).toBe("criticize");
    expect(trace.valence).toBe("dislike");
    expect(trace.regardDelta).toBeLessThan(0);
  });

  it("no active card on the concept ⇒ no card reaction (the active set is authoritative)", () => {
    const { trace } = applyChatPulse(state(), pulse("criticize"), makeProfile(), "Mara", []);
    expect(trace.valence).toBeNull();
    expect(trace.regardDelta).toBe(0);
  });
});

describe("applyChatAction (test-bed chips)", () => {
  const state = (): ChatState => seedChatState(makeProfile());

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

  it("the fluster chip's own condition label reads flustered in the mood projection (#331)", () => {
    // Regression: the chip minted "Flushed" while the projection keyed only
    // flustered/bashful, so the tint never fired. Pin the chip-label ↔
    // projection-key agreement through the production read (chatStateSnapshot),
    // so either vocabulary drifting alone fails here.
    const next = applyChatAction(state(), "fluster", 0);
    expect(chatStateSnapshot(next, seedChatScenario(makeProfile())).emotion.label).toBe("flustered");
  });

  it("re-applying a condition chip refreshes rather than duplicates it", () => {
    const once = applyChatAction(state(), "fluster", 0);
    const twice = applyChatAction(once, "fluster", 0);
    expect(twice.conditions.filter((c) => c.id === "flushed")).toHaveLength(1);
  });
});

describe("settleEnsembleMember (followups rulings 10-11)", () => {
  const now = new Date("2026-07-12T12:00:00Z");
  const base = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(makeProfile()), ...overrides });
  /** A member whose wardrobe IS modelled — the only state the restatement gate guards. */
  const dressed = (overrides: Partial<ChatState> = {}): ChatState => ({
    ...seedChatState(makeProfile({ outfits: [{ id: "everyday", name: "Everyday", items: ["itemid1abc", "itemid2def"] }] })),
    ...overrides,
  });
  const notes = (outfit: Partial<ChatPersonalNotes["outfit"]>): ChatPersonalNotes => ({
    openLoops: [],
    attributeChanges: [],
    outfit: { description: "", changeEvidence: "", exposed: false, removed: [], added: [], ...outfit },
    driveUpdates: [],
  });
  /** Authored presets a whole-look description can name — the preset re-seed's precondition. */
  const presets = makeProfile({
    outfits: [
      { id: "everyday", name: "Everyday", items: ["itemid1abc", "itemid2def"] },
      { id: "work", name: "Work", items: ["itemid9xyz"] },
    ],
  });
  const settle = (args: Partial<Parameters<typeof settleEnsembleMember>[0]> & { state: ChatState }) =>
    settleEnsembleMember({
      preRegard: args.state.regard,
      pulsed: false,
      personal: null,
      // Fails the evidence check by default — every replacement below opts in explicitly.
      exchange: { player: "", assistant: "" },
      // Vera alone on stage with the player — the scene these fixtures always described,
      // where a bare "she …" clause can only be hers. Ensemble cases override it.
      evidenceOwner: { names: ["Vera"], isPlayer: false, otherNames: [], presentCharacterCount: 1 },
      profile: presets,
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
        lastPulseTrace: { ...seedChatState(makeProfile()).lastPulseTrace, regardDelta: 5, concept: "compliment" },
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
        ...notes({
          description: "a paint-streaked tank top",
          changeEvidence: "she pulls on a paint-streaked tank top",
        }),
        openLoops: ["show the player her studio"],
      },
      exchange: { player: "you knock", assistant: '[Vera] she pulls on a paint-streaked tank top. "come in"' },
    });
    expect(next.openLoops).toEqual(["show the player her studio"]);
    // A whole-look description clears the structured worn list and lands as free text (v1).
    // The restatement gate is NOT exercised here — `base()` models no worn garments, so the
    // evidence above never has to carry the replacement; the modelled cases are below.
    expect(next.outfit).toBe("a paint-streaked tank top");
    expect(next.wornItemIds).toEqual([]);
  });

  it("a description with no change evidence keeps a MODELLED wardrobe and reports the restatement", () => {
    const sink = new DiagnosticCollector();
    const state = dressed();
    const next = settle({
      state,
      personal: notes({ description: "a white cotton t-shirt and jeans" }),
      exchange: { player: "you sit down", assistant: '[Vera] "long day," she says, sleeves shoved past her elbows' },
      sink,
    });
    expect(next.wornItemIds).toEqual(["itemid1abc", "itemid2def"]);
    expect(next.outfitPresetId).toBe("everyday");
    expect(next.outfit).toBe("");
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(true);
  });

  it("invented evidence — a quote absent from the exchange — fails closed the same way", () => {
    const sink = new DiagnosticCollector();
    const next = settle({
      state: dressed(),
      personal: notes({
        description: "a black silk shirt",
        changeEvidence: "she changes into a black silk shirt",
      }),
      exchange: { player: "you sit down", assistant: '[Vera] "long day," she says' },
      sink,
    });
    expect(next.wornItemIds).toEqual(["itemid1abc", "itemid2def"]);
    expect(next.outfit).toBe("");
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(true);
  });

  /**
   * Grounded quotes that name a wardrobe verb and still assert nothing: a
   * negated habit, an order in dialogue, and an idiom whose object is no
   * garment. Presence in the exchange is not the question — what the words SAY
   * is (contracts/items/outfit-change-evidence.ts).
   */
  const NON_EVENT_EVIDENCE = [
    "she never changes out of the apron",
    '"Change into the silk one," you tell her.',
    "The festival kicks off.",
  ];

  it.each(NON_EVENT_EVIDENCE)("evidence quoting a non-event keeps the modelled wardrobe: %s", (evidence) => {
    const sink = new DiagnosticCollector();
    const next = settle({
      state: dressed(),
      personal: notes({ description: "a flour-dusted apron over a white tee", changeEvidence: evidence }),
      exchange: { player: "you glance over", assistant: `[Vera] ${evidence}` },
      sink,
    });
    expect(next.wornItemIds).toEqual(["itemid1abc", "itemid2def"]);
    expect(next.outfitPresetId).toBe("everyday");
    expect(next.outfit).toBe("");
    expect(next.outfitExposed).toBe(false);
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(true);
  });

  it("…and the same proposal replaces once its quote states the change", () => {
    const sink = new DiagnosticCollector();
    const evidence = "she ties a flour-dusted apron over her clothes";
    const next = settle({
      state: dressed(),
      personal: notes({ description: "a flour-dusted apron over a white tee", changeEvidence: evidence }),
      exchange: { player: "you glance over", assistant: `[Vera] ${evidence}` },
      sink,
    });
    expect(next.wornItemIds).toEqual([]);
    expect(next.outfitPresetId).toBe("");
    expect(next.outfit).toBe("a flour-dusted apron over a white tee");
    expect(next.outfitExposed).toBe(false);
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(false);
  });

  it("validated evidence replaces the modelled wardrobe with the free-text look", () => {
    const sink = new DiagnosticCollector();
    const next = settle({
      state: dressed(),
      personal: notes({
        description: "a black silk shirt",
        changeEvidence: "she changes into a black silk shirt",
      }),
      exchange: { player: "you wait", assistant: '[Vera] she changes into a black silk shirt, still talking' },
      sink,
    });
    expect(next.wornItemIds).toEqual([]);
    expect(next.outfitPresetId).toBe("");
    expect(next.outfit).toBe("a black silk shirt");
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(false);
  });

  /**
   * The audit's third regression (2026-08-01): with all three folds validating against one
   * shared exchange text, a quote of ANOTHER member's genuine change was licence enough to
   * replace this member's whole look. The clause below is in the reply and does assert a
   * change — it is simply Mara's coat, not Vera's.
   */
  it("another member's change clause never moves THIS member's look (the cross-member case)", () => {
    const sink = new DiagnosticCollector();
    const next = settle({
      state: dressed(),
      personal: notes({
        description: "a heavy charcoal coat over her shirt",
        changeEvidence: "Mara pulls on her coat.",
      }),
      exchange: { player: "you look up", assistant: "[Mara] Mara pulls on her coat. [Vera] she stays where she is." },
      evidenceOwner: { names: ["Vera"], isPlayer: false, otherNames: ["Mara", "You"], presentCharacterCount: 2 },
      sink,
    });
    expect(next.wornItemIds).toEqual(["itemid1abc", "itemid2def"]);
    expect(next.outfitPresetId).toBe("everyday");
    expect(next.outfit).toBe("");
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(true);
  });

  it("…and the same scene DOES move it once the clause names this member", () => {
    const sink = new DiagnosticCollector();
    const next = settle({
      state: dressed(),
      personal: notes({
        description: "a heavy charcoal coat over her shirt",
        changeEvidence: "Vera pulls on her coat.",
      }),
      exchange: { player: "you look up", assistant: "[Vera] Vera pulls on her coat. [Mara] she stays where she is." },
      evidenceOwner: { names: ["Vera"], isPlayer: false, otherNames: ["Mara", "You"], presentCharacterCount: 2 },
      sink,
    });
    expect(next.wornItemIds).toEqual([]);
    expect(next.outfitPresetId).toBe("");
    expect(next.outfit).toBe("a heavy charcoal coat over her shirt");
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(false);
  });

  it("a garment delta skips the gate — the description applies, the delta itself does not", () => {
    const sink = new DiagnosticCollector();
    const next = settle({
      state: dressed(),
      personal: notes({ description: "a cardigan over the t-shirt", removed: ["her cardigan"] }),
      exchange: { player: "you glance over", assistant: "[Vera] she shrugs" },
      sink,
    });
    // Deliberate parity with `foldOutfitProposal`, whose description branch also returns
    // before the delta path: a delta only means the proposal is not a restatement, so the
    // whole look replaces (the worn list clears) — folding the delta itself stays the
    // primary's IO-backed job.
    expect(next.wornItemIds).toEqual([]);
    expect(next.outfit).toBe("a cardigan over the t-shirt");
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(false);
  });

  it("an exposure claim replaces without evidence — bared is a real change", () => {
    const next = settle({
      state: dressed(),
      personal: notes({ description: "the shirt hanging open", exposed: true }),
      exchange: { player: "you watch", assistant: "[Vera] she leans back" },
    });
    expect(next.wornItemIds).toEqual([]);
    expect(next.outfit).toBe("the shirt hanging open");
    expect(next.outfitExposed).toBe(true);
  });

  it("a description naming an authored preset re-seeds the structured worn list (primary parity)", () => {
    const next = settle({
      state: base({ outfit: "a sundress" }),
      personal: notes({ description: "changes into her work clothes" }),
    });
    expect(next.wornItemIds).toEqual(["itemid9xyz"]);
    expect(next.outfitPresetId).toBe("work");
    expect(next.outfit).toBe(""); // the prior free-text look is replaced by the structured one
    expect(next.outfitExposed).toBe(false);
  });

  it("the preset rung precedes the evidence gate — an authored look is authoritative", () => {
    const sink = new DiagnosticCollector();
    const next = settle({
      // Modelled worn list + NO change evidence: the combination the gate guards.
      state: dressed(),
      personal: notes({ description: "changes into her work clothes" }),
      exchange: { player: "you sit down", assistant: '[Vera] "long day ahead," she says' },
      sink,
    });
    expect(next.wornItemIds).toEqual(["itemid9xyz"]);
    expect(next.outfitPresetId).toBe("work");
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(false);
  });

  it("prose merely containing a preset word never hijacks — it takes the ordinary gate path", () => {
    const sink = new DiagnosticCollector();
    const kept = settle({
      state: dressed(),
      personal: notes({ description: "heavy work boots and a red sundress" }),
      exchange: { player: "you look her over", assistant: "[Vera] she shifts her weight" },
      sink,
    });
    expect(kept.wornItemIds).toEqual(["itemid1abc", "itemid2def"]);
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(true);
    // …and past the gate it lands as free text, still not the "work" preset.
    const replaced = settle({
      state: dressed(),
      personal: notes({
        description: "heavy work boots and a red sundress",
        changeEvidence: "she pulls on heavy work boots",
      }),
      exchange: { player: "you look her over", assistant: "[Vera] she pulls on heavy work boots" },
    });
    expect(replaced.wornItemIds).toEqual([]);
    expect(replaced.outfitPresetId).toBe("");
    expect(replaced.outfit).toBe("heavy work boots and a red sundress");
  });

  it("an UNMODELLED member takes the description without evidence — nothing structured to protect", () => {
    const sink = new DiagnosticCollector();
    const state = base();
    expect(state.wornItemIds).toEqual([]); // the guard's precondition is absent
    const next = settle({
      state,
      personal: notes({ description: "a white cotton t-shirt and jeans" }),
      exchange: { player: "you sit down", assistant: '[Vera] "long day," she says' },
      sink,
    });
    expect(next.outfit).toBe("a white cotton t-shirt and jeans");
    expect(sink.items.some((d) => d.code === "chat_wardrobe.ensemble_outfit_restatement")).toBe(false);
  });

  it("a null personal pass (absent/degraded) keeps the member's prior personal fields", () => {
    const prior = base({ openLoops: ["old promise"], outfit: "a sundress" });
    const next = settle({ state: prior, personal: null });
    expect(next.openLoops).toEqual(["old promise"]);
    expect(next.outfit).toBe("a sundress");
  });

  it("burns the addressed member's selfie ring when their pulse read a send (ruling 12)", () => {
    const sent = base({
      lastPulseTrace: { ...seedChatState(makeProfile()).lastPulseTrace, sentPhoto: true },
    });
    const next = settle({ state: sent, pulsed: true, selfieRequestTarget: true });
    expect(next.selfieHistory).toEqual([{ kind: "request", atClockMinutes: 30 }]);
    // Not the target ⇒ no burn even when the trace read a send.
    expect(settle({ state: sent, pulsed: true }).selfieHistory).toEqual([]);
  });

  it("a revealed secret drive mints the secret_shared milestone", () => {
    const withDrive = base({
      drives: [{ want: "leave this town", why: "", secrecy: "secret", revealed: false, resolved: false, progress: "" }],
    });
    const next = settle({
      state: withDrive,
      personal: {
        ...notes({}),
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
    const input: ChatState = { ...seedChatState(makeProfile()), regard: 12, mindNote: "before" };
    const { state, degraded } = await runChatPulse({
      state: input,
      profile: makeProfile(),
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

describe("chatStateSnapshot — mood chip", () => {
  const scenario = (): ChatScenario => seedChatScenario(makeProfile());
  const withMeters = (over: Record<string, number>): ChatState => ({
    ...seedChatState(makeProfile()),
    meters: { ...initialMeters(), ...over },
  });

  it("carries a derived emotion label + bounded intensity", () => {
    const snap = chatStateSnapshot(seedChatState(makeProfile()), scenario());
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
    expect(chatStateSnapshot(seedChatState(makeProfile()), scenario()).persisted).toBe(true);
    expect(chatStateSnapshot(seedChatState(makeProfile()), scenario(), { persisted: false }).persisted).toBe(false);
  });

  it("merges the scenario's chat-wide fields into the back-compat snapshot shape", () => {
    const snap = chatStateSnapshot(
      seedChatState(makeProfile()),
      { ...scenario(), premise: "the night before she moves away", clockMinutes: 45, sceneAuto: "milestones" },
    );
    expect(snap.premise).toBe("the night before she moves away");
    expect(snap.clockMinutes).toBe(45);
    expect(snap.sceneAuto).toBe("milestones");
  });
});

describe("applyChatAttributeOverlays (mutable-attribute evolution)", () => {
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

describe("applyChatTraitOverlays (bounded personality evolution)", () => {
  // temperament.warmth / social.guardedness / temperament.confidence are developable;
  // temperament.composure is core; the authored value is the clamp anchor.
  const authored = [{ id: "temperament.warmth", value: 0, source: "creation" as const }];

  it("nudges an authored developable trait a bounded step, as a narrative overlay", () => {
    const out = applyChatTraitOverlays(authored, [], [{ trait: "temperament.warmth", direction: "up" }], { minor: false });
    expect(out).toContainEqual(expect.objectContaining({ id: "temperament.warmth", source: "narrative" }));
    expect(out.find((o) => o.id === "temperament.warmth")?.value).toBe(20); // authored 0 + one TRAIT_OVERLAY_STEP
  });

  it("ratchets the same overlay on a repeat nudge, but never past one band from the authored value", () => {
    // Authored cold (−80, band 0); a long arc of 'up' nudges may reach the reserved band's
    // top (33) at most — never the 'warm' band (two steps away).
    const cold = [{ id: "temperament.warmth", value: -80, source: "creation" as const }];
    let overlays = applyChatTraitOverlays(cold, [], [{ trait: "temperament.warmth", direction: "up" }], { minor: false });
    for (let i = 0; i < 12; i++) {
      overlays = applyChatTraitOverlays(cold, overlays, [{ trait: "temperament.warmth", direction: "up" }], { minor: false });
    }
    const value = overlays.find((o) => o.id === "temperament.warmth")?.value ?? 0;
    expect(value).toBeLessThanOrEqual(33); // clamped one band from authored −80
    expect(value).toBeGreaterThan(-80);
  });

  it("rejects a core (non-developable) trait with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const base = [{ id: "temperament.composure", value: 0, source: "creation" as const }];
    const out = applyChatTraitOverlays(base, [], [{ trait: "temperament.composure", direction: "up" }], { minor: false }, sink);
    expect(out).toHaveLength(0);
    expect(sink.items.some((d) => d.code === "chat_state.trait.core_change_rejected")).toBe(true);
  });

  it("drops an unknown trait id with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const out = applyChatTraitOverlays(authored, [], [{ trait: "nonsense.trait", direction: "up" }], { minor: false }, sink);
    expect(out).toHaveLength(0);
    expect(sink.items.some((d) => d.code === "chat_state.trait.unknown")).toBe(true);
  });

  it("skips a developable trait the author never set (only authored traits evolve)", () => {
    const sink = new DiagnosticCollector();
    const out = applyChatTraitOverlays([], [], [{ trait: "temperament.warmth", direction: "up" }], { minor: false }, sink);
    expect(out).toHaveLength(0);
    expect(sink.items.some((d) => d.code === "chat_state.trait.unauthored_skipped")).toBe(true);
  });

  it("fences an intimate trait shift for a minor with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    // intimate.libido is intimate; even if it were developable, a minor never evolves it.
    const base = [{ id: "intimate.libido", value: 0, source: "creation" as const }];
    const out = applyChatTraitOverlays(base, [], [{ trait: "intimate.libido", direction: "up" }], { minor: true }, sink);
    expect(out).toHaveLength(0);
    expect(sink.items.some((d) => d.code === "chat_state.trait.minor_intimate_rejected")).toBe(true);
  });
});

describe("emotional weather wiring", () => {
  const likeProfile = makeProfile({ preferences: [{ target: "compliment", valence: "like", intensity: 5 }] });
  const pulseWith = (overrides: Partial<ChatPulse>): ChatPulse => ({
    playerAct: null,
    mindNote: "",
    feeling: null,
    sentPhoto: false,
    ...overrides,
  });

  it("applies a pulse feeling proposal with curve-derived intensity and records the trace", () => {
    const { state: next, trace } = applyChatPulse(
      seedChatState(makeProfile()),
      pulseWith({ feeling: { label: "sad", cause: "the broken promise" } }),
      makeProfile(),
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
    const standing = { ...seedChatState(makeProfile()), feeling: { current: { label: "sad" as const, intensity: 0.8, cause: "x" }, bruise: null } };
    const { state: next } = applyChatPulse(standing, pulseWith({ feeling: { label: "neutral", cause: "" } }), makeProfile(), "Mara", []);
    expect(next.feeling.current).toBeNull();
  });

  it("an accepted apologize halves a live bruise", () => {
    const bruised = { ...seedChatState(makeProfile()), feeling: { current: null, bruise: { remaining: 10 } } };
    const { state: next, trace } = applyChatPulse(bruised, pulseWith({ playerAct: { concept: "apologize" } }), makeProfile(), "Mara", []);
    expect(next.feeling.bruise?.remaining).toBe(5);
    expect(trace.changed).toContain("bruise");
  });

  it("a bruise halves positive gains and the trace records the scale", () => {
    const bruised = { ...seedChatState(makeProfile()), feeling: { current: null, bruise: { remaining: 10 } } };
    const clean = applyChatPulse(seedChatState(makeProfile()), pulseWith({ playerAct: { concept: "compliment" } }), likeProfile, "Mara", []);
    const damped = applyChatPulse(bruised, pulseWith({ playerAct: { concept: "compliment" } }), likeProfile, "Mara", []);
    expect(clean.trace.regardDelta).toBeGreaterThan(0);
    expect(damped.trace.regardDelta).toBeLessThanOrEqual(Math.ceil(clean.trace.regardDelta / 2));
    expect(damped.trace.regardScale).toBeLessThan(1);
  });

  it("drift decays the feeling per exchange; a days skip clears it", () => {
    const felt = {
      ...seedChatState(makeProfile()),
      feeling: { current: { label: "angry" as const, intensity: 0.9, cause: "the lie" }, bruise: { remaining: 4 } },
    };
    const drifted = driftChatState(felt, makeProfile(), { advance: true, clockMinutes: CHAT_TICK_MINUTES });
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
    const state = seedChatState(makeProfile());
    expect(state.feeling).toEqual({ current: null, bruise: null });
    expect(chatStateSnapshot(state, seedChatScenario(makeProfile())).feeling).toEqual({ current: null, bruise: null });
  });
});

describe("outfitChangeEvidenceValidated — only the exchange's own words license a wardrobe wipe", () => {
  /** Mara alone with the player: the 1-on-1 scene where a bare "she …" can only be hers. */
  const MARA_SOLO = { names: ["Mara"], isPlayer: false, otherNames: [], presentCharacterCount: 1 } as const;
  /** An exchange whose evidence lives in the reply — the shape most of these fixtures describe. */
  const reply = (assistant: string) => ({ player: "", assistant });

  const exchange = {
    player: "I lean in the doorway while she gets ready.",
    assistant: 'Mara shrugs off the work shirt and pulls on a black silk blouse. "Better?" she says.',
  };

  it("validates a clause copied verbatim out of the exchange", () => {
    expect(
      outfitChangeEvidenceValidated("shrugs off the work shirt and pulls on a black silk blouse", exchange, MARA_SOLO),
    ).toBe(true);
    // Case is not part of the quote — a model that re-capitalizes still quoted it.
    expect(outfitChangeEvidenceValidated("Mara shrugs off the work shirt", exchange, MARA_SOLO)).toBe(true);
  });

  it("validates across whitespace runs and curly quotes — the differences a re-typed quote picks up", () => {
    const curly = reply("She tugs at her collar.\nMara pulls on a black silk blouse — “it’s the good one”, she says.");
    expect(outfitChangeEvidenceValidated("Mara  pulls   on\na black silk blouse", curly, MARA_SOLO)).toBe(true);
    // The needle types the quotes straight where the text has them curly.
    expect(outfitChangeEvidenceValidated('pulls on a black silk blouse — "it\'s the good one"', curly, MARA_SOLO)).toBe(
      true,
    );
  });

  it("rejects empty evidence — a description with no quote is a re-description, not a change", () => {
    expect(outfitChangeEvidenceValidated("", exchange, MARA_SOLO)).toBe(false);
    expect(outfitChangeEvidenceValidated("   ", exchange, MARA_SOLO)).toBe(false);
  });

  it("rejects evidence that is not in the exchange — an invented quote fails closed", () => {
    expect(outfitChangeEvidenceValidated("she changes into a red evening dress", exchange, MARA_SOLO)).toBe(false);
    expect(outfitChangeEvidenceValidated("sleeves shoved past her elbows", exchange, MARA_SOLO)).toBe(false);
    // …and an empty exchange can license nothing.
    expect(outfitChangeEvidenceValidated("pulls on a black silk blouse", reply(""), MARA_SOLO)).toBe(false);
  });

  /**
   * The live-check failure that mandated the second condition (2026-08-01): on the
   * deployed build the extractor proposed a styling paraphrase as the description AND
   * quoted the very sentence it came from as its own evidence. Presence alone passed
   * and the fold wiped the modelled wardrobe — so a quote must also SAY the clothes moved.
   */
  it("rejects a self-quoted styling paraphrase — present in the text, but asserting no change", () => {
    const styling = {
      player: "I walk over to her. Her sleeves are shoved past her elbows, one cuff dusted with flour.",
      assistant: "She glances up.",
    };
    expect(
      outfitChangeEvidenceValidated(
        "Her sleeves are shoved past her elbows, one cuff dusted with flour.",
        styling,
        MARA_SOLO,
      ),
    ).toBe(false);
  });

  it("accepts the clothing-change clauses the archivist can actually quote", () => {
    const swap =
      "Sabrina swaps her cotton work shirt for a black silk shirt before the first customer arrives, rolling the new sleeves to the elbow.";
    expect(outfitChangeEvidenceValidated(swap, reply(swap), MARA_SOLO)).toBe(true);
    const apron = "She ties a flour-dusted apron over her clothes.";
    expect(outfitChangeEvidenceValidated(apron, reply(apron), MARA_SOLO)).toBe(true);
    const wearing = "now wearing a tank top";
    expect(outfitChangeEvidenceValidated(wearing, reply(`She turns, ${wearing} and nothing else.`), MARA_SOLO)).toBe(
      true,
    );
  });

  it("keeps the ambiguous verbs honest: a tie that fastens nothing, a change that isn't clothes", () => {
    // "ties" needs an article or "on" after it — styling prose never qualifies.
    const ties = "the apron ties loose at the waist";
    expect(outfitChangeEvidenceValidated(ties, reply(`She leans back and ${ties}.`), MARA_SOLO)).toBe(false);
    // "chang*" counts only beside clothing context (a garment, "into"/"out of", clothes…).
    const dressed = "she changed into her sundress";
    expect(outfitChangeEvidenceValidated(dressed, reply(`Upstairs ${dressed}.`), MARA_SOLO)).toBe(true);
    const weather = "the weather changed";
    expect(outfitChangeEvidenceValidated(weather, reply(`Overnight ${weather}.`), MARA_SOLO)).toBe(false);
  });

  it("still requires presence — a real change clause the exchange never contained is no evidence", () => {
    expect(outfitChangeEvidenceValidated("she slips into a red evening dress", exchange, MARA_SOLO)).toBe(false);
  });

  /**
   * Condition 3, from the adversarial audit of the presence+assertion gate (2026-08-01):
   * all three settlement sites validated against ONE shared player+assistant text, so a
   * quote of participant A's genuine change ("Mara pulls on her coat.") licensed
   * participant B's whole-look replacement. Every quote below IS in the exchange and DOES
   * assert a change — attribution is the only thing deciding.
   */
  describe("owner scoping — evidence must be about the wardrobe owner", () => {
    /** The player persona, NAMED (never "You") so the pronoun rules, not the name test, decide. */
    const CASS_SOLO = { names: ["Cass"], isPlayer: true, otherNames: ["Mara"], presentCharacterCount: 1 } as const;
    /** Sabrina and Mara both on stage — the scene where a bare pronoun picks no wardrobe. */
    const SABRINA_ENSEMBLE = {
      names: ["Sabrina"],
      isPlayer: false,
      otherNames: ["Mara", "Cass"],
      presentCharacterCount: 2,
    } as const;
    const MARA_ENSEMBLE = {
      names: ["Mara"],
      isPlayer: false,
      otherNames: ["Sabrina", "Cass"],
      presentCharacterCount: 2,
    } as const;
    /** The player in a crowded scene — three characters on stage, none of them the player. */
    const CASS_ENSEMBLE = {
      names: ["Cass"],
      isPlayer: true,
      otherNames: ["Mara", "Sabrina", "Wren"],
      presentCharacterCount: 3,
    } as const;
    /** The mirror of `reply` — an exchange whose evidence lives in the PLAYER's own line. */
    const playerLine = (player: string) => ({ player, assistant: "" });

    it("a bare third-person clause is the sole character's — the 1-on-1 case the scoping must not break", () => {
      const jacket = "She takes off her jacket";
      expect(outfitChangeEvidenceValidated(jacket, reply(`${jacket} and folds it over the chair.`), MARA_SOLO)).toBe(
        true,
      );
    });

    it("the player's first-person clause moves the PLAYER's wardrobe, never the character's (regression 1)", () => {
      const mine = playerLine("I take off my jacket and hang it by the door.");
      expect(outfitChangeEvidenceValidated("I take off my jacket", mine, CASS_SOLO)).toBe(true);
      // The same clause offered for the CHARACTER's fold: it is the player's jacket.
      expect(outfitChangeEvidenceValidated("I take off my jacket", mine, MARA_SOLO)).toBe(false);
    });

    it("the character's third-person clause moves the CHARACTER's wardrobe, never the player's (regression 2)", () => {
      const hers = reply("She slips out of her dress and drapes it over the chair.");
      expect(outfitChangeEvidenceValidated("She slips out of her dress", hers, MARA_SOLO)).toBe(true);
      expect(outfitChangeEvidenceValidated("She slips out of her dress", hers, CASS_SOLO)).toBe(false);
    });

    it("the owner need not be the ACTOR — a named possessive object is their evidence, ensemble included", () => {
      const taken = "Mara pulls off Sabrina's jacket";
      const scene = reply(`${taken} and drops it on the bench.`);
      expect(outfitChangeEvidenceValidated(taken, scene, SABRINA_ENSEMBLE)).toBe(true);
      // …and the named ACTOR passes for her OWN wardrobe off the very same clause. That is
      // the documented bounded compromise, not an oversight: the gate asks whether the
      // owner is named, never who is doing what to whom — deciding that is coreference
      // resolution, which fails unpredictably rather than closed.
      expect(outfitChangeEvidenceValidated(taken, scene, MARA_ENSEMBLE)).toBe(true);
    });

    it("an ensemble fails closed on a bare pronoun and opens only on the owner's name", () => {
      const bare = "she shrugs off her coat";
      expect(outfitChangeEvidenceValidated(bare, reply(`Across the room ${bare}.`), SABRINA_ENSEMBLE)).toBe(false);
      const named = "Sabrina shrugs off her coat";
      expect(outfitChangeEvidenceValidated(named, reply(`${named} and hangs it by the door.`), SABRINA_ENSEMBLE)).toBe(
        true,
      );
    });

    it("one member's clause never moves another member's look (regression 3, at the gate)", () => {
      const maras = "Mara pulls on her coat.";
      expect(outfitChangeEvidenceValidated(maras, reply(maras), MARA_ENSEMBLE)).toBe(true);
      expect(outfitChangeEvidenceValidated(maras, reply(maras), SABRINA_ENSEMBLE)).toBe(false);
      // …and the same the other way round — neither member's name licenses the other's fold.
      const sabrinas = "Sabrina pulls on her coat.";
      expect(outfitChangeEvidenceValidated(sabrinas, reply(sabrinas), SABRINA_ENSEMBLE)).toBe(true);
      expect(outfitChangeEvidenceValidated(sabrinas, reply(sabrinas), MARA_ENSEMBLE)).toBe(false);
    });

    it("the player's own forms stay attributable in a crowded scene — the count gates PRONOUNS, not persons", () => {
      const mine = playerLine("I peel off my jacket before anyone can ask.");
      expect(outfitChangeEvidenceValidated("I peel off my jacket", mine, CASS_ENSEMBLE)).toBe(true);
    });

    it("half discipline: 'I' is the player only in their own line, 'you' only in the reply", () => {
      // First person in the REPLY is the character speaking, not the player.
      const inReply = reply('"I take off my jacket," she says, already halfway out of it.');
      expect(outfitChangeEvidenceValidated("I take off my jacket", inReply, CASS_SOLO)).toBe(false);
      // Second person in the PLAYER's line addresses the character, not the player.
      const addressed = playerLine("You take off your jacket and toss it on the bed.");
      expect(outfitChangeEvidenceValidated("You take off your jacket", addressed, CASS_SOLO)).toBe(false);
      // …and second person in the reply is exactly the player being undressed.
      const undressed = "tugs you out of your shirt";
      expect(outfitChangeEvidenceValidated(undressed, reply(`She ${undressed} before you can answer.`), CASS_SOLO)).toBe(
        true,
      );
    });

    it("markerless clauses stay lenient 1-on-1 — for both bodies — and fail closed in an ensemble", () => {
      const boots = "kicks off the boots";
      const scene = reply(`She stops in the doorway and ${boots}.`);
      expect(outfitChangeEvidenceValidated(boots, scene, MARA_SOLO)).toBe(true);
      // The player's side of the same leniency: a clause marking nobody, with one character
      // on stage, can only be about the two bodies in the room — so either fold may take it.
      // The price of not parsing, and confined to the scene where it costs nothing.
      expect(outfitChangeEvidenceValidated(boots, scene, CASS_SOLO)).toBe(true);
      // A second character on stage and the same clause names nobody at all.
      expect(outfitChangeEvidenceValidated(boots, scene, SABRINA_ENSEMBLE)).toBe(false);
    });

    it("the other-name veto outranks the second-person rule — a mixed clause fails toward the wardrobe", () => {
      // The accepted reply-half clause above with one word in front: the actor is now named,
      // and that name belongs to somebody else on stage. The veto is checked BEFORE the
      // person forms deliberately — a clause naming one participant while marking another is
      // exactly the ambiguity the audit found, and its safe direction is keeping the
      // modelled wardrobe.
      const mixed = "Mara tugs you out of your shirt";
      expect(outfitChangeEvidenceValidated(mixed, reply(`${mixed} before you can answer.`), CASS_SOLO)).toBe(false);
    });
  });

  /**
   * All three conditions compose: grounding proves the words are the exchange's,
   * the classifier (`contracts/items/outfit-change-evidence.ts`) proves the words
   * say the clothes moved, and owner scoping proves whose. A quote that is
   * genuinely in the text still fails when it reports a non-event — which is the
   * whole reason the second condition exists. (Owner is the sole character on
   * stage here, so attribution passes on the third person and only the
   * classification is under test.)
   */
  it("composes grounding with classification — a grounded NON-event is still no evidence", () => {
    const refused = "She doesn't take off her jacket.";
    expect(outfitChangeEvidenceValidated(refused, reply(`He waits by the door. ${refused}`), MARA_SOLO)).toBe(false);
    const ordered = '"Take off your jacket," she says.';
    expect(outfitChangeEvidenceValidated(ordered, reply(`She folds her arms. ${ordered}`), MARA_SOLO)).toBe(false);
    const planned = "She plans to take off her jacket.";
    expect(outfitChangeEvidenceValidated(planned, reply(`He watches. ${planned}`), MARA_SOLO)).toBe(false);
    // …and the same sentence, actually happening, validates.
    const done = "She takes off her jacket.";
    expect(outfitChangeEvidenceValidated(done, reply(`He waits by the door. ${done}`), MARA_SOLO)).toBe(true);
  });

  /**
   * The seam the two lines of work meet at: the classifier hands back the ONE
   * sentence that asserted, and attribution reads exactly that. A quote whose
   * asserting sentence is about somebody else does not become this owner's
   * evidence because a later sentence happens to name them.
   */
  it("attributes on the ASSERTING sentence, not on a name from elsewhere in the quote", () => {
    const quote = "Mara pulls on her coat. Sabrina laughs at the doorway.";
    const scene = reply(quote);
    const sabrina = { names: ["Sabrina"], isPlayer: false, otherNames: ["Mara"], presentCharacterCount: 2 } as const;
    expect(outfitChangeEvidenceValidated(quote, scene, sabrina)).toBe(false);
    // …and it IS Mara's evidence, off the very same quote.
    const mara = { names: ["Mara"], isPlayer: false, otherNames: ["Sabrina"], presentCharacterCount: 2 } as const;
    expect(outfitChangeEvidenceValidated(quote, scene, mara)).toBe(true);
  });
});
