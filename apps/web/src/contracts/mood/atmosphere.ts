import { z } from "zod";

/**
 * `AtmosphereLabel` — scene tone, *not* a character's sentiment. A tense room and a
 * calm companion coexist: atmosphere is an **input** to mood (trait-damped), never
 * an override.
 *
 * The avatar spec nominally "owns" this as a cue channel, but mood ships first and is
 * its first consumer, so the enum lives here for now; the avatar imports it from
 * `contracts/mood` when it lands. Keep it renderer-neutral.
 */
export const atmosphereLabelEnum = z.enum([
  "calm",
  "warm",
  "romantic",
  "tense",
  "ominous",
  "melancholy",
  "hopeful",
]);

export type AtmosphereLabel = z.infer<typeof atmosphereLabelEnum>;

export const ATMOSPHERE_LABELS = atmosphereLabelEnum.options;

/** Parse-boundary schema: an unknown tone degrades to `calm` (resilience.md). */
export const atmosphereLabelSchema = atmosphereLabelEnum.catch("calm");
