import { z } from "zod";
import { interactionConceptById } from "./interactions";

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

/**
 * A preference as one narrator-facing phrase (character-fidelity slice 4): the concept
 * (or family) it targets, plus the character's own reaction hint when authored — so the
 * chat prefix can tell the narrator what actually lands well/badly *in the moment*, not
 * just what the post-turn pulse scores. Pure; a family target with no concept humanizes
 * its id ("affection_display" → "affection display").
 */
export function describePreference(pref: Preference): string {
  const subject = interactionConceptById(pref.target)?.label.toLowerCase() ?? pref.target.replace(/_/g, " ");
  const hint = pref.hint?.trim();
  return hint ? `${subject} — ${hint}` : subject;
}
