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
];

export function meterById(id: string): MeterDefinition | undefined {
  return meterDefinitions.find((m) => m.id === id);
}

export function initialMeters(definitions: readonly MeterDefinition[] = meterDefinitions): Record<string, number> {
  return Object.fromEntries(definitions.map((m) => [m.id, m.initial]));
}

/** Apply per-hour drift for elapsed game minutes, clamped to [0,1]. */
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
    next[def.id] = Math.min(1, Math.max(0, current + def.perHour * hours));
  }
  return next;
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
