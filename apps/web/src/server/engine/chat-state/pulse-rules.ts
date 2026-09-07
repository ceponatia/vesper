import {
  CHAT_MIND_NOTE_MAX_CHARS,
  NEUTRAL_MOOD_METER,
  clampRegard,
  clampValueToBandSteps,
  diag,
  interactionConceptById,
  resolveTraits,
  traitRegistry,
  TRAIT_OVERLAY_MAX_BAND_STEPS,
  TRAIT_OVERLAY_STEP,
  type ActiveCondition,
  type AttributeChange,
  type CharacterProfile,
  type ChatActionId,
  type ChatPulse,
  type ChatPulseTrace,
  type DiagnosticSink,
  type SocialReactionCard,
  type TraitShift,
  type TraitValue,
} from "@/contracts";
import { evaluateActReaction } from "@/contracts/personality/act-reaction";
import { attributeRegistry } from "@/contracts/attributes";
import { attributeValueSchema, overlaySourceMayChange, type AttributeValue } from "@/contracts/attributes/value";
import { catalogConditionForLabel } from "@/contracts/conditions/catalog";
import { parseOrNull } from "@/lib/parse";
import {
  applyFeelingProposal,
  halveBruise,
  maybeBruise,
  proposalIntensity,
  scaleRegardDelta,
} from "../chat-feeling";
import { AFFINITY_DELTA_CLAMP, CHAT_ACTION_CONDITION_MINUTES, CHAT_AROUSAL_INTIMATE } from "../constants";
import type { ChatState } from "./types";

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const clamp01 = (n: number): number => clamp(n, 0, 1);

/**
 * Apply a parsed pulse to a drifted state via the deterministic social-reaction
 * curve (PURE — the testable core). A single-act mirror of merge.ts `planReactionAffinity`:
 * resolve the classified concept against the character's preferences, evaluate it
 * through the affinity/mood/trait-aware curve, sign + clamp the affinity move to
 * ±AFFINITY_DELTA_CLAMP, and nudge mood. An unrecognised / null act ⇒ no
 * affinity/mood move (just the mindNote refresh). Returns the updated state and the
 * last-turn trace.
 */
export function applyChatPulse(
  state: ChatState,
  pulse: ChatPulse,
  profile: CharacterProfile,
  characterName: string,
  activeSocialCards: readonly SocialReactionCard[],
): { state: ChatState; trace: ChatPulseTrace } {
  const next: ChatState = { ...state, meters: { ...state.meters } };
  const concept = pulse.playerAct?.concept ?? null;
  let valence: "like" | "dislike" | null = null;
  let regardDelta = 0;
  let moodDelta = 0;
  let stressDelta = 0;
  let regardScale = 1;
  let feeling = state.feeling;
  const changed: string[] = [];

  if (concept) {
    // The shared social-reaction sequence (contracts/personality/act-reaction.ts —
    // one implementation across both lanes; its `affinity` param IS the regard
    // scalar). World-less chat: the cards active in THIS chat (scenario modal)
    // apply — seeded from the character's own `profile.socialCards`, then
    // author-editable.
    const outcome = evaluateActReaction({
      act: { concept, target: characterName },
      disposition: { tags: profile.tags, preferences: profile.preferences, cards: [...activeSocialCards] },
      affinity: state.regard,
      moodMeter: state.meters.mood ?? NEUTRAL_MOOD_METER,
      traits: profile.traits,
      deltaClamp: AFFINITY_DELTA_CLAMP,
    });
    if (outcome.kind === "reaction") {
      valence = outcome.evaluated.valence;
      regardDelta = outcome.affinityDelta;
      moodDelta = outcome.moodDelta;
    } else if (outcome.kind === "touch") {
      // Welcome/unwelcome touch — session-lane parity restored by the de-fork:
      // an unmatched touch swings mood (+ stress) by affinity-stage welcome-ness.
      moodDelta = outcome.moodDelta;
      stressDelta = outcome.stressDelta;
    }
  }

  // Emotional weather: the standing feeling biases the curve's move (damped,
  // ±10% max — owner ruling), a warmth streak compounds gains (cap ×1.5), and a
  // live bruise halves them.
  if (regardDelta !== 0) {
    const scaled = scaleRegardDelta({
      delta: regardDelta,
      feeling,
      history: state.relationshipHistory,
      deltaClamp: AFFINITY_DELTA_CLAMP,
    });
    regardDelta = scaled.delta;
    regardScale = scaled.scale;
  }

  // An accepted apology halves the bruise's remaining life (owner ruling — the
  // `apologize` concept specifically; `reassure` is comfort, not repair).
  if (concept === "apologize" && valence !== "dislike" && feeling.bruise) {
    feeling = halveBruise(feeling);
    changed.push("bruise");
  }

  // Arousal-from-intimate-acts: an intimate concept raises arousal — full
  // for a flagged-intimate act (a proposition), half for courtship/physical
  // affection — unless the character disliked it.
  const arousalDelta = concept && valence !== "dislike" ? arousalBumpForConcept(concept) : 0;

  if (regardDelta !== 0) {
    // A strong drop landing while regard is high opens (or refreshes) a bruise —
    // read against the PRE-move regard.
    const bruised = maybeBruise(state.regard, regardDelta, feeling);
    if (bruised !== feeling) {
      feeling = bruised;
      changed.push("bruise");
    }
    next.regard = clampRegard(state.regard + regardDelta);
    changed.push("regard");
  }
  if (Math.abs(moodDelta) >= 0.005 && next.meters.mood !== undefined) {
    next.meters.mood = clamp01(next.meters.mood + moodDelta);
    changed.push("mood");
  }
  if (Math.abs(stressDelta) >= 0.005 && next.meters.stress !== undefined) {
    next.meters.stress = clamp01(next.meters.stress + stressDelta);
    changed.push("stress");
  }
  if (arousalDelta >= 0.005 && next.meters.arousal !== undefined) {
    next.meters.arousal = clamp01(next.meters.arousal + arousalDelta);
    changed.push("arousal");
  }
  const note = pulse.mindNote.trim();
  if (note) {
    next.mindNote = note.slice(0, CHAT_MIND_NOTE_MAX_CHARS);
    changed.push("mindNote");
  }

  // Persistent feeling proposal: the pulse names the
  // label + cause; intensity derives from the curve's applied move (the beat's
  // measured charge). "neutral" clears; a weaker different label never displaces.
  const proposed = applyFeelingProposal(feeling, pulse.feeling, proposalIntensity(regardDelta, AFFINITY_DELTA_CLAMP));
  if (proposed !== feeling) {
    feeling = proposed;
    changed.push("feeling");
  }
  next.feeling = feeling;

  const trace: ChatPulseTrace = {
    concept,
    valence,
    regardDelta,
    moodDelta,
    arousalDelta,
    changed,
    feeling: feeling.current?.label ?? null,
    regardScale,
    sentPhoto: pulse.sentPhoto,
    degraded: false,
  };
  next.lastPulseTrace = trace;
  return { state: next, trace };
}

/**
 * The OPENER-scoped pulse fold: a reopen
 * opener has no player act to react to, so the classifier runs only for its
 * reads — `sentPhoto` (did the opener actually attach the photo the license
 * armed?) and the mindNote refresh (her mind is on what she just raised).
 * Everything the curve owns stays untouched: no regard/mood/stress/arousal
 * moves, no feeling proposal (a no-player-act beat must not clear a standing
 * bruise), no concept. PURE.
 */
export function applyOpenerPulse(state: ChatState, pulse: ChatPulse): { state: ChatState; trace: ChatPulseTrace } {
  const changed: string[] = [];
  const next: ChatState = { ...state };
  const note = pulse.mindNote.trim();
  if (note) {
    next.mindNote = note.slice(0, CHAT_MIND_NOTE_MAX_CHARS);
    changed.push("mindNote");
  }
  const trace: ChatPulseTrace = {
    concept: null,
    valence: null,
    regardDelta: 0,
    moodDelta: 0,
    arousalDelta: 0,
    changed,
    feeling: state.feeling.current?.label ?? null,
    regardScale: 1,
    sentPhoto: pulse.sentPhoto,
    degraded: false,
  };
  next.lastPulseTrace = trace;
  return { state: next, trace };
}

/** Cap on attribute overlays applied per exchange — a rare event; bounded like the merge's. */
const MAX_CHAT_ATTRIBUTE_CHANGES = 4;

/**
 * Merge the archivist's proposed attribute changes into the persisted narrative-overlay
 * set. Each change passes the SAME inherent-trait guard the
 * session merge uses (`overlaySourceMayChange(def.mutability, "narrative")`), so eye colour /
 * species / gender can never be rewritten; an unknown or inherent change drops with a diagnostic.
 * Accepted changes become `source:"narrative"` overlays, deduped by attribute id (last write
 * wins). PURE — the testable core; the caller persists the result on the state row, and the
 * prompt builder resolves it on top of the authored base beneath the transient condition overlays.
 */
export function applyChatAttributeOverlays(
  current: readonly AttributeValue[],
  changes: readonly AttributeChange[],
  sink?: DiagnosticSink,
): AttributeValue[] {
  const overlays: AttributeValue[] = [...current];
  for (const change of changes.slice(0, MAX_CHAT_ATTRIBUTE_CHANGES)) {
    const def = attributeRegistry.byId(change.attributeId);
    if (!def) {
      sink?.push(diag("warn", "chat_state.attribute.unknown", `unknown attribute "${change.attributeId}" dropped`));
      continue;
    }
    if (!overlaySourceMayChange(def.mutability, "narrative")) {
      sink?.push(
        diag(
          "warn",
          "chat_state.attribute.inherent_change_rejected",
          `narrative change to inherent attribute "${change.attributeId}" dropped`,
        ),
      );
      continue;
    }
    const overlay = parseOrNull(
      attributeValueSchema,
      { id: change.attributeId, value: change.value, source: "narrative", note: change.note },
      sink,
      "chat_state.attributeChange",
    );
    if (!overlay) continue;
    const idx = overlays.findIndex((o) => o.id === overlay.id);
    if (idx >= 0) overlays[idx] = overlay;
    else overlays.push(overlay);
  }
  return overlays;
}

/**
 * Fold milestone-gated developable-trait nudges into the persisted narrative trait
 * overlays — the trait parallel to
 * `applyChatAttributeOverlays`. Each accepted shift becomes a `source:"narrative"`
 * overlay, clamped to `TRAIT_OVERLAY_MAX_BAND_STEPS` bands from the AUTHORED value so a
 * long arc bends a character a bounded step without ever converting them (the slice-3
 * spirit). Guards, each dropping with a diagnostic: an unknown trait, a `core`
 * (non-developable) trait, an intimate trait for a minor, or a trait the author never set
 * (only authored traits evolve, mirroring the regard-coloring rule). A repeat nudge
 * ratchets the SAME overlay another `TRAIT_OVERLAY_STEP`, capped by the band clamp — a
 * nudge already at the cap is a no-op. PURE; the caller gates the whole call on a landed
 * milestone and persists the result on the state row.
 */
export function applyChatTraitOverlays(
  authored: readonly TraitValue[],
  current: readonly TraitValue[],
  shifts: readonly TraitShift[],
  options: { minor: boolean },
  sink?: DiagnosticSink,
): TraitValue[] {
  const overlays: TraitValue[] = [...current];
  const resolvedAuthored = resolveTraits(authored, []);
  for (const shift of shifts) {
    const id = shift.trait.trim();
    const def = traitRegistry.byId(id);
    if (!def) {
      sink?.push(diag("warn", "chat_state.trait.unknown", `unknown trait "${id}" dropped`));
      continue;
    }
    // Fence intimate traits for a minor FIRST — before the mutability check — so an
    // intimate trait never evolves for a minor whatever its mutability (mirrors the
    // prompt-builder intimate fence).
    if (options.minor && def.intimate) {
      sink?.push(diag("warn", "chat_state.trait.minor_intimate_rejected", `intimate trait shift "${id}" dropped for a minor`));
      continue;
    }
    if (def.mutability !== "developable") {
      sink?.push(diag("warn", "chat_state.trait.core_change_rejected", `narrative shift to non-developable trait "${id}" dropped`));
      continue;
    }
    const authoredEntry = resolvedAuthored.find((t) => t.id === id);
    if (!authoredEntry) {
      sink?.push(diag("info", "chat_state.trait.unauthored_skipped", `trait shift "${id}" skipped — the author set no baseline to evolve from`));
      continue;
    }
    const currentValue = overlays.find((o) => o.id === id)?.value ?? authoredEntry.value;
    const step = shift.direction === "up" ? TRAIT_OVERLAY_STEP : -TRAIT_OVERLAY_STEP;
    const bounded = clampValueToBandSteps(def, authoredEntry.value, currentValue + step, TRAIT_OVERLAY_MAX_BAND_STEPS);
    const value = Math.max(-100, Math.min(100, bounded));
    if (value === currentValue) continue; // already at the band cap — don't churn the overlay
    const overlay: TraitValue = { id, value, source: "narrative", note: "narrative arc" };
    const idx = overlays.findIndex((o) => o.id === id);
    if (idx >= 0) overlays[idx] = overlay;
    else overlays.push(overlay);
  }
  return overlays;
}

/** Arousal bump for an intimate concept: full for a flagged-intimate act, half for courtship / physical affection. */
function arousalBumpForConcept(concept: string): number {
  const def = interactionConceptById(concept);
  if (!def) return 0;
  if (def.intimate) return CHAT_AROUSAL_INTIMATE;
  if (def.family === "courtship" || concept === "physical_affection") return CHAT_AROUSAL_INTIMATE * 0.5;
  return 0;
}

/** Apply a one-click test-bed action chip to the state (slice 4); returns the mutated state (PURE). */
export function applyChatAction(state: ChatState, action: ChatActionId, clockMinutes: number): ChatState {
  const meters = { ...state.meters };
  let conditions = state.conditions;
  const bump = (id: string, delta: number) => {
    meters[id] = clamp01((meters[id] ?? 0) + delta);
  };
  switch (action) {
    case "drink":
      bump("intoxication", 0.3);
      break;
    case "freshen":
      meters.hygiene = 0.95;
      bump("energy", 0.05);
      break;
    case "rest":
      bump("energy", 0.2);
      bump("stress", -0.2);
      break;
    case "fluster":
      bump("arousal", 0.25);
      conditions = upsertCondition(conditions, {
        id: "flushed",
        label: "Flushed",
        startedAtMinutes: clockMinutes,
        durationMinutes: CHAT_ACTION_CONDITION_MINUTES,
        promptHint: "Color high, breath a little quick.",
        attributeEffects: [],
      });
      break;
  }
  return { ...state, meters, conditions };
}

/** Replace a condition with the same id, else append (so re-applying a chip refreshes it). */
function upsertCondition(conditions: readonly ActiveCondition[], next: ActiveCondition): ActiveCondition[] {
  const rest = conditions.filter((c) => c.id !== next.id);
  return [...rest, next];
}

/**
 * Fill a condition's structured effects from the catalog when the author gave
 * none, so a recognised label (e.g. "disheveled") arrives with the
 * attribute overlays that actually shift grooming/scent/hair in the prompt. Author-supplied
 * effects always win; an unrecognised label is left untouched.
 */
export function seedConditionEffects(condition: ActiveCondition): ActiveCondition {
  if (condition.attributeEffects.length > 0) return condition;
  const entry = catalogConditionForLabel(condition.label);
  if (!entry) return condition;
  return { ...condition, attributeEffects: entry.attributeEffects, promptHint: condition.promptHint ?? entry.promptHint };
}

/** Clamp every meter value to [0,1], keeping the registry keys. */
export function clampMeters(meters: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(meters)) out[id] = clamp01(value);
  return out;
}
