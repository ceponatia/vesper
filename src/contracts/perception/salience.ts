import { z } from "zod";

/**
 * Salience (presence-and-perception-spec.phase3.md §Attention × salience,
 * decision 14). How noticeable an action is, on two independent channels.
 * Default is **obvious** + **quiet** — a normal, plainly-visible interaction.
 * Stealth must be declared, and a stealth marker only lowers salience when a
 * concealment target exists ("quietly" to a lover is tone, the same words with
 * her unaware mother present is a sneak — see `concealedSalience`).
 */
export const visualSalienceSchema = z.enum(["obvious", "subtle"]);
export type VisualSalience = z.infer<typeof visualSalienceSchema>;

export const audibleSalienceSchema = z.enum(["loud", "quiet", "silent"]);
export type AudibleSalience = z.infer<typeof audibleSalienceSchema>;

export const salienceSchema = z.object({
  visual: visualSalienceSchema.catch("obvious").default("obvious"),
  audible: audibleSalienceSchema.catch("quiet").default("quiet"),
});
export type Salience = z.infer<typeof salienceSchema>;

export function defaultSalience(): Salience {
  return { visual: "obvious", audible: "quiet" };
}

/** Salience of a deliberately concealed action (visually subtle, audibly hushed). */
export function concealedSalience(): Salience {
  return { visual: "subtle", audible: "quiet" };
}

/**
 * Stealth markers in player input. Detecting one is necessary but NOT sufficient
 * to conceal: the engine also requires a concealment target (an unaware present
 * character to hide from). Whole-word matched by the caller.
 */
export const STEALTH_MARKERS = [
  "quietly", "silently", "secretly", "discreetly", "stealthily", "sneak", "sneaks",
  "without her noticing", "without him noticing", "without them noticing",
  "without being seen", "behind her back", "behind his back", "out of sight",
  "when no one is looking", "while she isn't looking", "while he isn't looking",
  "under the table", "on the sly",
] as const;

export function hasStealthMarker(text: string): boolean {
  const t = text.toLowerCase();
  return STEALTH_MARKERS.some((m) => t.includes(m));
}
