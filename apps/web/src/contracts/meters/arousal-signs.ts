import {
  AFTERGLOW_DURATION_SECONDS,
  METER_FIXED_POINT_ONE,
  type IntimacyPhase,
  type VisibleBodySign,
} from "@vesper/simulation-core/contracts/bodies";
import { deriveIntimacyRead, deriveVisibleBodySigns, type EnergyRead } from "@vesper/simulation-core/body-reads";
import { conditionKey, type ActiveCondition } from "../conditions/condition";

/**
 * Chat-lane arousal physiology (#301). A thin adapter over the successor's
 * intimacy read (`@vesper/simulation-core/body-reads`) — the chat lane's
 * graded arousal narration (kindled / flushed / wound-tight / cresting,
 * settling into afterglow) shares ONE physiology with the simulation lane
 * instead of growing a second scale. Units convert at the boundary: the chat
 * arousal meter is 0..1; the shared read is fixed-point 0..`METER_FIXED_POINT_ONE`.
 *
 * Perception-gated via `detailTier`, the shared read's own axis (0/1 ⇒
 * nothing perceived, 2 ⇒ plain sight, 3 ⇒ engaged attention) — a caller
 * passes 0 for a witness who cannot perceive the subject at all (not
 * co-present, blocked senses) and 3 for an actively conversing partner. This
 * is the read's only perception axis; a richer tier (darkness, distance) is
 * for #300/#302's shared derived-read path to compute and pass in, not a
 * second gating framework grown here.
 *
 * A deliberately narrow, pure function: takes the raw arousal meter, the
 * standing conditions, and the perception input, returns the read — so #300's
 * `readChatMeters` (the one shared derived-read path every band consumer goes
 * through) can call it directly once it routes arousal signs through, without
 * this module knowing anything about that path's context shape.
 *
 * Deliberately excludes energy-driven signs (`visible_exhaustion` /
 * `visible_fatigue`): those are #300's reserve read to supply. Passing a
 * neutral "steady" energy band means the shared function reports only the
 * arousal-driven signs.
 *
 * No "flush"/"blush" wording anywhere in this module's OWN prose (owner
 * ruling, #427 — see `contracts/meters/registry.ts`'s `visibleEffects` doc).
 * The shared read's internal band id happens to be spelled "flushed"; that
 * key is an identifier, never surfaced verbatim in narration text.
 */

/** Afterglow's duration in story MINUTES — mirrors `AFTERGLOW_DURATION_SECONDS` from
 * `@vesper/simulation-core` exactly (owner ruling 2026-09-27: one shared value). */
export const CHAT_AFTERGLOW_DURATION_MINUTES = AFTERGLOW_DURATION_SECONDS / 60;

/** Convert the chat lane's 0..1 arousal meter to the shared fixed-point scale. */
export function chatArousalFixedPoint(meterValue: number): number {
  const clamped = Math.min(1, Math.max(0, meterValue));
  return Math.round(clamped * METER_FIXED_POINT_ONE);
}

export interface ChatArousalRead {
  /** The graded physiology phase (never perception-gated — it's a fact about the body, not what's seen). */
  phase: IntimacyPhase;
  /** Narrator-facing prose for the phase; "" when quiescent or below `detailTier`'s threshold. */
  hint: string;
  /** Signs a witness at this `detailTier` could perceive; [] below tier 2, quiescent, or no signs apply. */
  visibleSigns: readonly VisibleBodySign[];
}

const PHASE_HINTS: Readonly<Record<Exclude<IntimacyPhase, "quiescent">, string>> = {
  kindled: "A flicker of interest — attention warming, breath just a touch quicker.",
  flushed: "Visibly stirred: warmth rising, breath catching, pulse quickening.",
  wound_tight: "Wound tight with wanting — breath short, focus fixed, barely holding still.",
  cresting: "Right at the edge — trembling with it, every touch a live wire.",
  afterglow: "Loose-limbed and settled, unhurried in the quiet after.",
};

/** A neutral energy read that never crosses an energy-driven sign's band — see the module doc. */
const NEUTRAL_ENERGY_READ: EnergyRead = { signedFixedPoint: 0, band: "steady" };

export interface ChatArousalReadInput {
  /** The chat lane's 0..1 arousal meter. */
  arousalMeter: number;
  /** Standing conditions — an active `afterglow` overrides the graded scale (matches `deriveIntimacyRead`). */
  conditions: readonly ActiveCondition[];
  /** The witness's perceptual access this turn (see the module doc). */
  detailTier: number;
}

/** The chat lane's graded arousal read: physiology phase + perception-gated narration + visible signs. */
export function deriveChatArousalRead(input: ChatArousalReadInput): ChatArousalRead {
  const arousalFixedPoint = chatArousalFixedPoint(input.arousalMeter);
  const afterglowActive = input.conditions.some((c) => conditionKey(c) === "afterglow");
  const phase = deriveIntimacyRead({ arousalFixedPoint, afterglowActive });
  if (input.detailTier < 2) return { phase, hint: "", visibleSigns: [] };
  const hint = phase === "quiescent" ? "" : PHASE_HINTS[phase];
  const visibleSigns = deriveVisibleBodySigns({
    energyRead: NEUTRAL_ENERGY_READ,
    arousalFixedPoint,
    afterglowActive,
    detailTier: input.detailTier,
  });
  return { phase, hint, visibleSigns };
}
