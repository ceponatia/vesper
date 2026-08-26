import { z } from "zod";

/**
 * `EmotionLabel` — the single app-wide discrete-emotion vocabulary. Mood **owns**
 * it; the avatar cue, a UI mood chip, and any future consumer import this enum so
 * everyone agrees on one set.
 *
 * Locked at 11 (decision 2026-06-24): 10 ungated + `aroused`, which is gated on an
 * intimate *context* (not wardrobe undress) and driven by the `arousal` meter. The
 * projection (`deriveEmotionLabel`) is the only producer; it is total — an odd input
 * degrades to `neutral`, never throws.
 */
export const emotionLabelEnum = z.enum([
  "neutral",
  "happy",
  "affectionate",
  "playful",
  "flustered",
  "concerned",
  "sad",
  "angry",
  "afraid",
  "surprised",
  "aroused",
]);

export type EmotionLabel = z.infer<typeof emotionLabelEnum>;

/** The 11 labels in declaration order (avatar manifest keying, tests, UI). */
export const EMOTION_LABELS = emotionLabelEnum.options;

/**
 * Parse-boundary schema (resilience.md): an unknown label degrades to `neutral`
 * instead of rejecting. Use this when reading a label off a trust boundary (JSONB,
 * the turn stream); use `emotionLabelEnum` for an authored, in-process value.
 */
export const emotionLabelSchema = emotionLabelEnum.catch("neutral");
