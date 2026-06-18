import { z } from "zod";

export const meterThresholdSchema = z.object({
  below: z.number().optional(),
  above: z.number().optional(),
  promptHint: z.string().min(1),
});

export const meterDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  initial: z.number().min(0).max(1),
  /** Signed drift per game hour; clamped to [0,1] after application. */
  perHour: z.number(),
  /**
   * Resting target the meter drifts toward (personality-and-state.spec.md §4).
   * Absent ⇒ today's implied pole (perHour < 0 ⇒ 0, else 1), so old defs are
   * unchanged. Per-character traits shift this at drift time (`personalizeMeters`).
   */
  baseline: z.number().min(0).max(1).optional(),
  /** Rate of approach to `baseline` per hour; absent ⇒ |perHour| (today's speed). */
  recoveryPerHour: z.number().min(0).optional(),
  thresholds: z.array(meterThresholdSchema).readonly().default([]),
});

export type MeterDefinition = z.infer<typeof meterDefinitionSchema>;

/**
 * Starter meters. Worlds may override fields or disable a meter entirely via
 * WorldStyle.meterOverrides (null disables). The old app's hygiene vectors
 * collapse into `hygiene` + conditions; see docs/contracts.md.
 */
export const meterDefinitions: readonly MeterDefinition[] = [
  {
    id: "hygiene",
    label: "Hygiene",
    description: "Freshness from 1 (just bathed) to 0 (badly unwashed). Bathing restores it via the simulant.",
    initial: 0.9,
    perHour: -0.04,
    thresholds: [
      { below: 0.55, promptHint: "Noticeably lived-in at close range: faint sweat and warm skin." },
      { below: 0.3, promptHint: "Clearly unwashed: damp fabric, sour sweat, hair gone lank." },
    ],
  },
  {
    id: "energy",
    label: "Energy",
    description: "Wakefulness from 1 (rested) to 0 (exhausted). Sleep restores it via the simulant.",
    initial: 0.9,
    perHour: -0.05,
    thresholds: [
      { below: 0.45, promptHint: "Tired: slower replies, longer blinks, small stretches and yawns." },
      { below: 0.2, promptHint: "Exhausted: drifting attention, heavy eyes, leaning on furniture." },
    ],
  },
  {
    id: "stress",
    label: "Stress",
    description: "Tension from 0 (calm) to 1 (overwhelmed). Decays toward calm.",
    initial: 0.15,
    perHour: -0.03,
    thresholds: [
      { above: 0.6, promptHint: "On edge: clipped sentences, restless hands, quick glances." },
      { above: 0.85, promptHint: "Near a breaking point: shaky voice, gaze that won't settle." },
    ],
  },
  {
    id: "arousal",
    label: "Arousal",
    description: "Physical arousal from 0 to 1. Decays toward baseline.",
    initial: 0,
    perHour: -0.1,
    thresholds: [
      { above: 0.55, promptHint: "Visibly affected: flushed skin, shallow breath, lingering eye contact." },
    ],
  },
  {
    id: "intoxication",
    label: "Intoxication",
    description: "Impairment from 0 (sober) to 1. Decays as the body processes it.",
    initial: 0,
    perHour: -0.12,
    thresholds: [
      { above: 0.35, promptHint: "Tipsy: looser posture, warmer laughter, slightly imprecise gestures." },
      { above: 0.7, promptHint: "Drunk: slurred edges on words, unsteady balance, poor judgement." },
    ],
  },
  {
    // Emotional valence (personality-and-state.spec.md §4): 0 = low/down, 0.5 = even,
    // 1 = bright. Drifts back to an even keel; trait `optimism` shifts the resting point,
    // and the social-reaction curve nudges it. Surfaced via a *derived* descriptor
    // (deriveMoodDescriptor) blended with stress/energy — not raw threshold hints.
    id: "mood",
    label: "Mood",
    description: "Emotional valence from 0 (low) through 0.5 (even) to 1 (bright). Returns toward an even keel.",
    initial: 0.5,
    perHour: 0,
    baseline: 0.5,
    recoveryPerHour: 0.06,
    thresholds: [],
  },
];

export function meterById(id: string): MeterDefinition | undefined {
  return meterDefinitions.find((m) => m.id === id);
}

export function initialMeters(definitions: readonly MeterDefinition[] = meterDefinitions): Record<string, number> {
  return Object.fromEntries(definitions.map((m) => [m.id, m.initial]));
}

/** The resting target a meter drifts toward — explicit `baseline`, else today's pole. */
export function meterBaselineOf(def: MeterDefinition): number {
  return def.baseline ?? (def.perHour < 0 ? 0 : 1);
}

/**
 * Drift one meter toward its baseline over `hours`, never overshooting the target,
 * clamped to [0,1]. With no `baseline`/`recoveryPerHour` this is exactly the old
 * `current + perHour*hours` pole-seeking (the cap at the pole == not overshooting 0/1).
 */
function driftToward(current: number, def: MeterDefinition, hours: number): number {
  const target = meterBaselineOf(def);
  const rate = def.recoveryPerHour ?? Math.abs(def.perHour);
  const step = rate * hours;
  const moved = current < target ? Math.min(target, current + step) : Math.max(target, current - step);
  return Math.min(1, Math.max(0, moved));
}

/** Apply per-hour drift toward each meter's baseline for elapsed game minutes, clamped to [0,1]. */
export function applyMeterDrift(
  meters: Record<string, number>,
  elapsedMinutes: number,
  definitions: readonly MeterDefinition[] = meterDefinitions,
): Record<string, number> {
  const hours = elapsedMinutes / 60;
  const next = { ...meters };
  for (const def of definitions) {
    const current = next[def.id];
    if (current === undefined) continue;
    next[def.id] = driftToward(current, def, hours);
  }
  return next;
}

/** Neutral mood value (the meter's even keel). */
export const NEUTRAL_MOOD_METER = 0.5;

/**
 * A derived mood phrase (personality-and-state.spec.md §4): blends valence (`mood`)
 * with activation (`energy`) and tension (`stress`) — mood is a *read* over state,
 * not a second source of truth. "" when there's no `mood` meter or nothing notable
 * (an even, unstressed keel), so it adds no noise.
 */
export function deriveMoodDescriptor(meters: Record<string, number>): string {
  const mood = meters.mood;
  if (mood === undefined) return "";
  const stress = meters.stress ?? 0;
  const energy = meters.energy ?? 1;
  if (mood <= 0.35) {
    if (stress >= 0.6) return "low and on edge";
    if (energy <= 0.4) return "low and listless";
    return "subdued and withdrawn";
  }
  if (mood >= 0.65) {
    if (energy >= 0.6) return "bright and playful";
    return "warm and content";
  }
  // Even keel: only worth saying when tension makes it a held composure.
  if (stress >= 0.6) return "outwardly even but tense";
  return "";
}

/** promptHints for thresholds the current values cross. */
export function crossedThresholdHints(
  meters: Record<string, number>,
  definitions: readonly MeterDefinition[] = meterDefinitions,
): string[] {
  const hints: string[] = [];
  for (const def of definitions) {
    const value = meters[def.id];
    if (value === undefined) continue;
    for (const t of def.thresholds) {
      if (t.below !== undefined && value < t.below) hints.push(t.promptHint);
      else if (t.above !== undefined && value > t.above) hints.push(t.promptHint);
    }
  }
  return hints;
}
