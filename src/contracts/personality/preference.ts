import { z } from "zod";

/**
 * A character's bespoke like/dislike (docs/developer-notes/personality-and-state.spec.md
 * §6). `target` is an interaction concept id OR a family id; resolution matches a
 * classified socialAct against it (direct concept beats family). `intensity` is the
 * base magnitude (1–10) the response curve scales; `hint` overrides the concept's
 * default narrator flavour. Leaf fields are `.catch`ed so one bad value degrades the
 * entry instead of rejecting the whole `preferences` array.
 */
export const preferenceValenceSchema = z.enum(["like", "dislike"]);
export type PreferenceValence = z.infer<typeof preferenceValenceSchema>;

export const preferenceSchema = z.object({
  /** An interaction concept id or a family id. */
  target: z.string().min(1),
  valence: preferenceValenceSchema.catch("dislike"),
  /** Base magnitude, 1–10. The affinity-aware curve scales this. */
  intensity: z.number().min(1).max(10).catch(5),
  /** Per-character override of the concept's default narrator flavour. */
  hint: z.string().optional(),
});

export type Preference = z.infer<typeof preferenceSchema>;
