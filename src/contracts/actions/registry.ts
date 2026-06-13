import { z } from "zod";

/**
 * Action-duration registry (docs/developer-notes/time-and-travel-spec.phase3.md):
 * common multi-minute activities pass authored game time in one turn instead
 * of an LLM estimate. Vocabulary is data — extend by editing this file, never
 * by migration.
 */

export const proximityTierSchema = z.enum(["distant", "apart", "near", "close", "contact", "entwined"]);
export type ProximityTier = z.infer<typeof proximityTierSchema>;

export const actionMeterEffectSchema = z
  .object({
    meterId: z.string().min(1),
    /** Signed adjustment, applied after the action's time passes. */
    delta: z.number().min(-1).max(1).optional(),
    /** Absolute value the meter is set to (wins over delta when both present). */
    set: z.number().min(0).max(1).optional(),
  })
  .refine((e) => e.delta !== undefined || e.set !== undefined, { message: "meter effect needs delta or set" });

export const actionDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Game minutes the action takes. The turn clock advances max(this, estimate). */
  minutes: z.number().int().min(1),
  /** Phrases that identify the action in player input / activity text. Matched whole-word, longest-first. */
  aliases: z.array(z.string().min(1)).readonly().default([]),
  meterEffects: z.array(actionMeterEffectSchema).readonly().default([]),
  /** Reserved for proximity gating (proximity-spec); unused until that ships. */
  requiredTier: proximityTierSchema.optional(),
});

export type ActionDefinition = z.infer<typeof actionDefinitionSchema>;
export type ActionMeterEffect = z.infer<typeof actionMeterEffectSchema>;

export const actionDefinitions: readonly ActionDefinition[] = [
  {
    id: "shower",
    label: "Shower",
    minutes: 20,
    aliases: ["shower", "showers", "showering", "take a shower", "takes a shower", "wash up", "washes up"],
    meterEffects: [{ meterId: "hygiene", set: 0.95 }],
  },
  {
    id: "bathe",
    label: "Bathe",
    minutes: 40,
    aliases: ["bath", "bathe", "bathes", "bathing", "take a bath", "takes a bath", "soak in the tub"],
    meterEffects: [
      { meterId: "hygiene", set: 0.95 },
      { meterId: "stress", delta: -0.1 },
    ],
  },
  {
    id: "nap",
    label: "Nap",
    minutes: 90,
    aliases: ["nap", "naps", "napping", "take a nap", "takes a nap", "doze off", "dozes off", "lie down for a while"],
    meterEffects: [{ meterId: "energy", delta: 0.3 }],
  },
  {
    id: "meal",
    label: "Meal",
    minutes: 30,
    aliases: [
      "eat breakfast", "eat lunch", "eat dinner", "eats breakfast", "eats lunch", "eats dinner",
      "have breakfast", "have lunch", "have dinner", "has breakfast", "has lunch", "has dinner",
      "cook dinner", "cooks dinner", "make dinner", "makes dinner", "eat a meal", "eats a meal",
    ],
    meterEffects: [],
  },
  {
    id: "snack",
    label: "Snack",
    minutes: 10,
    aliases: ["snack", "snacks", "grab a bite", "grabs a bite", "have a snack", "has a snack"],
    meterEffects: [],
  },
  {
    id: "workout",
    label: "Workout",
    minutes: 45,
    aliases: ["work out", "works out", "working out", "exercise", "exercises", "go for a run", "goes for a run", "lift weights", "lifts weights"],
    meterEffects: [
      { meterId: "energy", delta: -0.15 },
      { meterId: "hygiene", delta: -0.2 },
      { meterId: "stress", delta: -0.15 },
    ],
  },
  {
    id: "groom",
    label: "Groom",
    minutes: 15,
    aliases: ["get ready", "gets ready", "do my makeup", "does her makeup", "does his makeup", "brush my hair", "brushes her hair", "brushes his hair", "shave", "shaves", "freshen up", "freshens up"],
    meterEffects: [],
  },
];

export function actionById(id: string): ActionDefinition | undefined {
  return actionDefinitions.find((a) => a.id === id);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Aliases across all definitions, longest first so "take a bath" beats "bath". */
const aliasIndex: ReadonlyArray<{ alias: string; re: RegExp; def: ActionDefinition }> = actionDefinitions
  .flatMap((def) => def.aliases.map((alias) => ({ alias, re: new RegExp(`\\b${escapeRe(alias)}\\b`, "i"), def })))
  .sort((a, b) => b.alias.length - a.alias.length);

/** Strip double-quoted spans so dialogue never matches ("I said I'd shower later"). */
function stripQuoted(text: string): string {
  return text.replace(/"[^"]*"/g, " ");
}

/**
 * Match registered actions in free text (player input or activity strings).
 * Whole-word, case-insensitive, longest alias wins per definition; each
 * definition matches at most once. Returns matches in input order.
 */
export function matchActions(text: string): ActionDefinition[] {
  const haystack = stripQuoted(text);
  const found: Array<{ index: number; def: ActionDefinition }> = [];
  const seen = new Set<string>();
  for (const entry of aliasIndex) {
    if (seen.has(entry.def.id)) continue;
    const m = entry.re.exec(haystack);
    if (m) {
      seen.add(entry.def.id);
      found.push({ index: m.index, def: entry.def });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.def);
}
