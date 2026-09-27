import { z } from "zod";
import { FIXED_POINT_ONE, linearDriftStep, proportionalDecayStep } from "@/lib/fixed-point";

/**
 * How a meter moves with elapsed STORY time. Both laws are closed-form steps of
 * the shared fixed-point kernel (`@/lib/fixed-point`) — the one the successor's
 * body substrate integrates with — so the chat lane grows no formula of its own:
 * - `linear` (the default when absent): a constant-rate approach toward the
 *   resting target at `recoveryPerHour ?? |perHour|` per story hour, stopping
 *   at it;
 * - `proportional`: an exponential approach toward the resting target — the
 *   distance left halves every `halfLifeHours` story hours.
 */
export const meterDriftLawSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linear") }),
  z.object({ kind: z.literal("proportional"), halfLifeHours: z.number().positive() }),
]);
export type MeterDriftLaw = z.infer<typeof meterDriftLawSchema>;

/**
 * What a meter's band vocabulary (its thresholds, chips, image effects, and the
 * mood phrase's reading of it) is evaluated against — the stored value is only
 * where drift and sources act. `readChatMeters` (`./reads.ts`) is the one path
 * that turns stored meters into these read values:
 * - `stored` (the default when absent): the stored value itself;
 * - `circadian_balance`: the stored value is a RESERVE, read as reserve minus
 *   the character's circadian sleep pressure (simulation-core's signed energy
 *   read, −1…1), carried onto the 0–1 band scale as (read + 1) / 2 — so 0.5 is
 *   a read of zero, the character's own bedtime on a normal day.
 */
export const meterReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stored") }),
  z.object({ kind: z.literal("circadian_balance") }),
]);
export type MeterRead = z.infer<typeof meterReadSchema>;

export const meterThresholdSchema = z.object({
  below: z.number().optional(),
  above: z.number().optional(),
  promptHint: z.string().min(1),
  /** Short chip label for UI strips ("tipsy", "on edge") — part of the band vocabulary, so a registry edit moves the UI with it. */
  pipLabel: z.string().optional(),
  /**
   * The paintable effects an image may state for this band — absent means the
   * band is silent in images. Declared ONLY on the owner-ruled deepest bands
   * (issue #427): each string is a literal current-state clause an image
   * prompt may carry, never a raw meter number or a narrator-only word. The
   * owner's flush/blush ruling applies here specifically — no phrase in this
   * array may use that word or a synonym, whatever `promptHint` says.
   */
  visibleEffects: z.array(z.string().min(1)).readonly().optional(),
});

export const meterDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  initial: z.number().min(0).max(1),
  /**
   * Signed linear drift per STORY hour; its sign also names the default resting
   * pole. A `proportional` meter states its target as `baseline` and leaves this 0.
   */
  perHour: z.number(),
  /**
   * Resting target the meter drifts toward.
   * Absent ⇒ the implied pole (perHour < 0 ⇒ 0, else 1). Per-character traits
   * shift this at drift time (`personalizeMeters`).
   */
  baseline: z.number().min(0).max(1).optional(),
  /** Linear rate of approach to `baseline` per story hour; absent ⇒ |perHour|. */
  recoveryPerHour: z.number().min(0).optional(),
  /** The elapsed-time drift law; absent ⇒ `linear`. */
  law: meterDriftLawSchema.optional(),
  /** What the thresholds below are evaluated against; absent ⇒ `stored`. */
  read: meterReadSchema.optional(),
  thresholds: z.array(meterThresholdSchema).readonly().default([]),
});

export type MeterDefinition = z.infer<typeof meterDefinitionSchema>;

/**
 * Hygiene's real-life-timing derivation (owner ruling 2026-09-27, #303 review;
 * see the `hygiene` definition below and docs/contracts/meters.md). Named
 * constants so the numbers on the definition ARE the derivation, not a
 * decimal a reader has to take on faith.
 */
const HYGIENE_WASHED = 0.95;
const HYGIENE_UNWASHED_THRESHOLD = 0.3;
const HYGIENE_HOURS_WASHED_TO_UNWASHED = 72;
const HYGIENE_PER_HOUR = -(HYGIENE_WASHED - HYGIENE_UNWASHED_THRESHOLD) / HYGIENE_HOURS_WASHED_TO_UNWASHED;
/** ≈ HYGIENE_WASHED + 10 × HYGIENE_PER_HOUR ≈ 0.8597, rounded — crosses at ≈9.97h, inside the owner's 8–12h window. */
const HYGIENE_ODOR_THRESHOLD = 0.86;

/**
 * Starter meters. Worlds may override fields or disable a meter entirely via
 * WorldStyle.meterOverrides (null disables). The old app's hygiene vectors
 * collapse into `hygiene` + conditions.
 *
 * Every rate is per STORY hour on the chat's shared clock, and — HYGIENE ALONE
 * EXCEPTED (see its own derivation below, owner ruling 2026-09-27) — each law
 * and value matches the successor's body registry (`bodyMeterRegistryV1` in
 * `@vesper/simulation-core`), which ported this economy to story time: the
 * same meter drifts the same way in both lanes. From the 0.9 rested seed that
 * means tired after about eleven waking hours and exhausted after about a day;
 * a flushed 0.8 cools below the flushed band in about 75 minutes.
 */
export const meterDefinitions: readonly MeterDefinition[] = [
  {
    id: "hygiene",
    label: "Hygiene",
    description: "Freshness from 1 (just bathed) to 0 (badly unwashed). Bathing restores it via the simulant.",
    initial: 0.9,
    // Real-life timing (owner ruling 2026-09-27, #303 review) — DIVERGES from
    // `@vesper/simulation-core`'s own (faster) hygiene rate on purpose; that
    // package is untouched. Washed to HYGIENE_WASHED (0.95 — the "freshen" chip
    // and the daily-rhythm wash both set this), a noticeable-but-mild odor
    // shows at ~10 story hours (not filthy yet), and the unwashed/filthy band
    // only after ~3 story days (72h) — one linear rate anchored to both:
    // (0.95 − 0.3) / 72 ≈ 0.00903/hour. At that rate the 10-hour mark sits at
    // 0.95 − 10 × 0.00903 ≈ 0.86 (inside the owner's stated 8–12h window); the
    // unwashed floor (0.3, unchanged from before this ruling) lands at exactly
    // 72h by construction. A character on the DEFAULT daily wash (once per
    // sleep cycle, `routineLandings`) reads mildly lived-in by evening and
    // never approaches unwashed — still realistic, never filthy between washes.
    perHour: HYGIENE_PER_HOUR,
    thresholds: [
      {
        below: HYGIENE_ODOR_THRESHOLD,
        promptHint: "Noticeably lived-in at close range: faint sweat and warm skin.",
        pipLabel: "lived-in",
      },
      {
        below: HYGIENE_UNWASHED_THRESHOLD,
        promptHint: "Clearly unwashed: damp fabric, sour sweat, hair gone lank.",
        pipLabel: "unwashed",
        visibleEffects: ["lank, greasy hair", "grimy skin"],
      },
    ],
  },
  {
    id: "energy",
    label: "Energy",
    description: "The energy reserve from 1 (fully rested) to 0 (spent). Sleep restores it; how tired it feels reads it against the character's own sleep pressure.",
    initial: 0.9,
    // A reserve that drains in proportion to what is left: time constant 16
    // story hours (half-life 16·ln2 ≈ 11.1 h, the successor's 39 925 s). Sleep
    // holds it and credits +0.09 per story hour up to 0.95 (chat-state/time.ts).
    perHour: 0,
    baseline: 0,
    law: { kind: "proportional", halfLifeHours: 16 * Math.LN2 },
    // The bands read the reserve against the character's own sleep pressure, on
    // the 0–1 band scale: tired below 0.5 is a negative read (simulation-core's
    // `dragging` and worse), exhausted below 0.3 is a read under −0.4 (`wrecked`
    // and `collapsing` — the successor's visible exhaustion).
    read: { kind: "circadian_balance" },
    thresholds: [
      { below: 0.5, promptHint: "Tired: slower replies, longer blinks, small stretches and yawns.", pipLabel: "tired" },
      {
        below: 0.3,
        promptHint: "Exhausted: drifting attention, heavy eyes, leaning on furniture.",
        pipLabel: "exhausted",
        visibleEffects: ["heavy-lidded eyes", "dark circles under the eyes"],
      },
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
    perHour: -0.2,
    thresholds: [
      {
        above: 0.55,
        promptHint: "Visibly affected: flushed skin, shallow breath, lingering eye contact.",
        pipLabel: "flushed",
        visibleEffects: ["parted lips"],
      },
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
      {
        above: 0.7,
        promptHint: "Drunk: slurred edges on words, unsteady balance, poor judgement.",
        pipLabel: "drunk",
        visibleEffects: ["glassy, unfocused eyes"],
      },
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
 * The documented precision of ONE drift step. The shared kernel works in whole
 * 1/`FIXED_POINT_ONE` units, so a step lands within this of its exact law (the
 * floor of a linear move; the floor and the deterministic exp2 rounding of a
 * proportional one). An interval integrated in n steps therefore agrees with
 * the same interval in one step to within n × this.
 */
export const METER_DRIFT_STEP_PRECISION = 2 / FIXED_POINT_ONE;

const SECONDS_PER_HOUR = 3_600;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/** A 0–1 meter value in the shared kernel's fixed-point units. */
const toFixedPoint = (value: number): number => Math.round(clampUnit(value) * FIXED_POINT_ONE);

/**
 * One meter's closed-form step over `elapsedSeconds` of story time, through the
 * shared kernel. A step that moves less than one kernel unit leaves the value
 * exactly as it was, so float noise never churns a settled meter.
 */
function driftStep(current: number, def: MeterDefinition, elapsedSeconds: number): number {
  const value = toFixedPoint(current);
  const target = toFixedPoint(meterBaselineOf(def));
  const law: MeterDriftLaw = def.law ?? { kind: "linear" };
  const next =
    law.kind === "proportional"
      ? proportionalDecayStep({
          value,
          target,
          halfLife: Math.round(law.halfLifeHours * SECONDS_PER_HOUR),
          elapsed: elapsedSeconds,
        })
      : linearDriftStep({
          value,
          target,
          ratePerHourFixedPoint: Math.round((def.recoveryPerHour ?? Math.abs(def.perHour)) * FIXED_POINT_ONE),
          elapsedSeconds,
        });
  return next === value ? clampUnit(current) : next / FIXED_POINT_ONE;
}

/**
 * Integrate each meter's drift law across `elapsedMinutes` of story time in ONE
 * closed-form step (see `METER_DRIFT_STEP_PRECISION`), toward its baseline,
 * never overshooting it, clamped to [0,1]. Zero or negative elapsed time moves
 * nothing. Pure; returns a new record.
 */
export function applyMeterDrift(
  meters: Record<string, number>,
  elapsedMinutes: number,
  definitions: readonly MeterDefinition[] = meterDefinitions,
): Record<string, number> {
  const next = { ...meters };
  const elapsedSeconds = Math.round(elapsedMinutes * 60);
  if (!(elapsedSeconds > 0)) return next;
  for (const def of definitions) {
    const current = next[def.id];
    if (current === undefined) continue;
    next[def.id] = driftStep(current, def, elapsedSeconds);
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
  /** The crossed threshold's paintable image effects, copied verbatim; absent when the band is silent in images. */
  visibleEffects?: readonly string[];
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
  let chosen: {
    bound: number;
    dir: "below" | "above";
    hint: string;
    pipLabel?: string;
    visibleEffects?: readonly string[];
    gap: number;
  } | null = null;
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
    if (!chosen || gap < chosen.gap)
      chosen = { bound, dir, hint: t.promptHint, pipLabel: t.pipLabel, visibleEffects: t.visibleEffects, gap };
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
    ...(chosen.visibleEffects === undefined ? {} : { visibleEffects: chosen.visibleEffects }),
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
