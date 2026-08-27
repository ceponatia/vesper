import { z } from "zod";
import { traitCategorySchema } from "./category-ids";

/**
 * Atomic personality traits: a numeric scalar with registry-defined bands — the
 * affinity pattern applied per trait. **Store the number, surface the band label,
 * compute from the number.** A separate registry from attributes (it must never
 * leak to an image prompt) but built on the same shared spine (`contracts/registry`),
 * so traits inherit base/creation/manual overlay precedence for free.
 */

/** A declarative link from a trait to a state it shapes. v1 metadata; the
 *  social-reaction `traitScale` math lives in `modulation.ts` — this records
 *  intent and gives the meter/mood coupling a data hook. */
export const traitModulationSchema = z.object({
  /** "affinity" or "meter:<id>" (e.g. "meter:arousal", "meter:mood"). */
  target: z.string().min(1),
  aspect: z.enum(["gain", "baseline", "recovery", "reactivity"]),
  note: z.string().optional(),
});
export type TraitModulation = z.infer<typeof traitModulationSchema>;

/** A band over the axis: covers values up to `max` (ascending; like meter thresholds). */
export const traitBandSchema = z.object({
  max: z.number(),
  label: z.string().min(1),
  promptHint: z.string().default(""),
});
export type TraitBand = z.infer<typeof traitBandSchema>;

/** A scored member-term: the word a user/forge might type, mapped to a position on the axis. */
export const traitLexiconEntrySchema = z.object({
  term: z.string().min(1),
  value: z.number(),
});
export type TraitLexiconEntry = z.infer<typeof traitLexiconEntrySchema>;

export const personalityTraitDefinitionSchema = z.object({
  /** `<category>.<snake_case>`, e.g. "temperament.warmth". */
  id: z.string().min(1),
  category: traitCategorySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  /** bipolar spans −100..100 (e.g. cold↔warm); unipolar spans 0..100. */
  axis: z.enum(["bipolar", "unipolar"]),
  /** Resting value at creation (the forge may override). */
  default: z.number(),
  /** Ascending by `max`; the last band must cover the axis maximum. */
  bands: z.array(traitBandSchema).min(1),
  /** `core` never drifts; `developable` allows a slow arc (the drift rule is deferred). */
  mutability: z.enum(["core", "developable"]),
  /** Marks the fenced, exposure-gated subset (redundant with the `intimate` category,
   *  which is the canonical fence). Optional so non-intimate defs omit it. */
  intimate: z.boolean().optional(),
  /** Phrasing guidance, deduped like attribute hints. */
  promptHints: z.array(z.string().min(1)).readonly().optional(),
  /** Declarative state-dynamics links; v1 metadata. */
  modulates: z.array(traitModulationSchema).readonly().optional(),
  /** Scored member-terms for forge expansion + free-text authoring. */
  lexicon: z.array(traitLexiconEntrySchema).readonly().default([]),
});
export type PersonalityTraitDefinition = z.infer<typeof personalityTraitDefinitionSchema>;

/** Inclusive value range for an axis. */
export function axisRange(axis: PersonalityTraitDefinition["axis"]): { min: number; max: number } {
  return axis === "bipolar" ? { min: -100, max: 100 } : { min: 0, max: 100 };
}
