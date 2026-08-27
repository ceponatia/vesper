import { z } from "zod";

export const meterThresholdSchema = z.object({
  below: z.number().optional(),
  above: z.number().optional(),
  promptHint: z.string().min(1),
  /** Short chip label for UI strips ("tipsy", "on edge") — part of the band vocabulary, so a registry edit moves the UI with it. */
  pipLabel: z.string().optional(),
});

export const meterDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  initial: z.number().min(0).max(1),
  /** Signed drift per game hour; clamped to [0,1] after application. */
  perHour: z.number(),
  /**
   * Resting target the meter drifts toward.
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
 * collapse into `hygiene` + conditions.
 */
export const meterDefinitions: readonly MeterDefinition[] = [
  {
    id: "hygiene",
    label: "Hygiene",
    description: "Freshness from 1 (just bathed) to 0 (badly unwashed). Bathing restores it via the simulant.",
    initial: 0.9,
    perHour: -0.04,
    thresholds: [
      { below: 0.55, promptHint: "Noticeably lived-in at close range: faint sweat and warm skin.", pipLabel: "lived-in" },
      { below: 0.3, promptHint: "Clearly unwashed: damp fabric, sour sweat, hair gone lank.", pipLabel: "unwashed" },
    ],
  },
  {
    id: "energy",
    label: "Energy",
    description: "Wakefulness from 1 (rested) to 0 (exhausted). Sleep restores it via the simulant.",
    initial: 0.9,
    perHour: -0.05,
    thresholds: [
      { below: 0.45, promptHint: "Tired: slower replies, longer blinks, small stretches and yawns.", pipLabel: "tired" },
      { below: 0.2, promptHint: "Exhausted: drifting attention, heavy eyes, leaning on furniture.", pipLabel: "exhausted" },
    ],
  },
  {
    id: "stress",
    label: "Stress",
    description: "Tension from 0 (calm) to 1 (overwhelmed). Decays toward calm.",
    initial: 0.15,
    perHour: -0.03,
    thresholds: [
      { above: 0.6, promptHint: "On edge: clipped sentences, restless hands, quick glances.", pipLabel: "on edge" },
      { above: 0.85, promptHint: "Near a breaking point: shaky voice, gaze that won't settle.", pipLabel: "near breaking" },
    ],
  },
  {
    id: "arousal",
    label: "Arousal",
    description: "Physical arousal from 0 to 1. Decays toward baseline.",
    initial: 0,
    perHour: -0.1,
    thresholds: [
      { above: 0.55, promptHint: "Visibly affected: flushed skin, shallow breath, lingering eye contact.", pipLabel: "flushed" },
    ],
  },
  {
    id: "intoxication",
    label: "Intoxication",
    description: "Impairment from 0 (sober) to 1. Decays as the body processes it.",
    initial: 0,
    perHour: -0.12,
    thresholds: [
      { above: 0.35, promptHint: "Tipsy: looser posture, warmer laughter, slightly imprecise gestures.", pipLabel: "tipsy" },
      { above: 0.7, promptHint: "Drunk: slurred edges on words, unsteady balance, poor judgement.", pipLabel: "drunk" },
    ],
  },
  {
    // Emotional valence: 0 = low/down, 0.5 = even,
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
 * Mood valence band cuts. Mood deliberately has NO registry thresholds (it surfaces
 * via the derived descriptor, not raw hints), so these are its shared band bounds —
 * used by `deriveMoodDescriptor` and the chat strip's mood pip alike.
 */
export const MOOD_BRIGHT_MIN = 0.65;
export const MOOD_LOW_MAX = 0.35;

/**
 * A derived mood phrase: blends valence (`mood`)
 * with activation (`energy`) and tension (`stress`) — mood is a *read* over state,
 * not a second source of truth. "" when there's no `mood` meter or nothing notable
 * (an even, unstressed keel), so it adds no noise.
 */
export function deriveMoodDescriptor(meters: Record<string, number>): string {
  const mood = meters.mood;
  if (mood === undefined) return "";
  const stress = meters.stress ?? 0;
  const energy = meters.energy ?? 1;
  if (mood <= MOOD_LOW_MAX) {
    if (stress >= 0.6) return "low and on edge";
    if (energy <= 0.4) return "low and listless";
    return "subdued and withdrawn";
  }
  if (mood >= MOOD_BRIGHT_MIN) {
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

/**
 * A graded meter cue: the single **deepest**
 * crossed threshold for one meter, as a stable `band` key + the `hint` prose + an
 * `intensity` (0–1, how far past the crossed bound the value sits, for "slightly tipsy" →
 * "badly drunk" scaling). Unlike `crossedThresholdHints` (every crossed hint as flat text),
 * this yields ONE band per meter whose key the chat anti-repetition gate diffs across
 * turns. The band vocabulary stays in `meterDefinitions` (a new band is a threshold edit,
 * not code). Returns null when no threshold is crossed.
 */
export interface MeterCue {
  meterId: string;
  /** Stable change-detection key for the crossed band, e.g. `"intoxication:0.7"`. */
  band: string;
  hint: string;
  /** Short chip label for the crossed band, when the threshold defines one. */
  pipLabel?: string;
  /** 0–1: depth past the crossed bound (0 = just over the line, 1 = at the pole). */
  intensity: number;
}

export function meterStateCue(
  meterId: string,
  value: number,
  definitions: readonly MeterDefinition[] = meterDefinitions,
): MeterCue | null {
  const def = definitions.find((m) => m.id === meterId);
  if (!def) return null;
  // The most-severe crossed band is the threshold whose bound is *closest* to the current
  // value (smallest gap) — the one most recently crossed going deeper. True for both
  // below-meters (lower bound = worse) and above-meters (higher bound = worse).
  let chosen: { bound: number; dir: "below" | "above"; hint: string; pipLabel?: string; gap: number } | null = null;
  for (const t of def.thresholds) {
    let bound: number | undefined;
    let dir: "below" | "above" | undefined;
    if (t.below !== undefined && value < t.below) {
      bound = t.below;
      dir = "below";
    } else if (t.above !== undefined && value > t.above) {
      bound = t.above;
      dir = "above";
    }
    if (bound === undefined || dir === undefined) continue;
    const gap = Math.abs(value - bound);
    if (!chosen || gap < chosen.gap) chosen = { bound, dir, hint: t.promptHint, pipLabel: t.pipLabel, gap };
  }
  if (!chosen) return null;
  const intensity =
    chosen.dir === "below"
      ? (chosen.bound - value) / Math.max(chosen.bound, 1e-6)
      : (value - chosen.bound) / Math.max(1 - chosen.bound, 1e-6);
  return {
    meterId,
    band: `${meterId}:${chosen.bound}`,
    hint: chosen.hint,
    pipLabel: chosen.pipLabel,
    intensity: Math.min(1, Math.max(0, intensity)),
  };
}

/** The anti-repetition split. */
export interface StateCueSplit {
  /** The single cue to mark as a fresh "just shifted" beat this turn (band changed), or null. */
  foreground: MeterCue | null;
  /** Cues whose band is unchanged from last turn — carried as standing coloring, not restated. */
  standing: MeterCue[];
  /** Current band per meter, to persist as next turn's `prevBands` (`surfaced_cues`). */
  nextBands: Record<string, string>;
}

/**
 * Split the current meter cues into one **foreground** "just changed" cue and the
 * **standing** cues, given the bands surfaced last turn (`prevBands`). A cue is foreground
 * when its band differs from `prevBands` (newly crossed or deepened); to protect the concise
 * profile (D7) at most ONE foreground cue is kept — the most intense — and the rest fall back
 * to standing coloring. `nextBands` is the current band per meter, persisted as next turn's
 * `prevBands` so an unchanged state never re-fires a beat. Pure; empty meters ⇒ empty split.
 */
export function splitStateCues(
  meters: Record<string, number>,
  prevBands: Readonly<Record<string, string>> = {},
  definitions: readonly MeterDefinition[] = meterDefinitions,
): StateCueSplit {
  const cues: MeterCue[] = [];
  const nextBands: Record<string, string> = {};
  for (const def of definitions) {
    const value = meters[def.id];
    if (value === undefined) continue;
    const cue = meterStateCue(def.id, value, definitions);
    if (!cue) continue;
    cues.push(cue);
    nextBands[def.id] = cue.band;
  }
  const changed = cues.filter((c) => prevBands[c.meterId] !== c.band).sort((a, b) => b.intensity - a.intensity);
  const foreground = changed[0] ?? null;
  const standing = cues.filter((c) => c !== foreground);
  return { foreground, standing, nextBands };
}
