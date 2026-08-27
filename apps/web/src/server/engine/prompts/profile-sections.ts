import { describePreference, type Preference } from "@/contracts/personality/preference";
import { conceptIdsInFamily, interactionConceptById } from "@/contracts/personality/interactions";
import { hasVoiceAnchors, type MicroExemplar, type VoiceAnchors } from "@/contracts/world/profile";
import { fenceUntrusted } from "./untrusted";

/**
 * Authored-`CharacterProfile` section builders.
 *
 * These render the parts of the prompt that are driven PURELY by a character's saved
 * profile — bio, voice anchors, micro exemplars, likes/dislikes — with no dependence on
 * chat state, presence, or the turn. Extracted from `character-chat.ts` so the successor
 * (simulated-world) narrator can surface the same authored canon from the SAME builders
 * (the `/worlds` front door creates successor chats from a library character, so their
 * `CharacterProfile` is available to it too). Single source ⇒ the two lanes can't drift,
 * and jscpd stays quiet because it's reuse, not copy. Pure, no IO — snapshot-testable
 * like the rest of `prompts/`.
 */

/** How much of a character's authored bio the Background block carries. */
export const BIO_EXCERPT_CHARS = 600;

/** Collapse whitespace and cap `text` at `max` chars with an ellipsis (shared helper). */
export function excerpt(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}

/**
 * The "Background" block: the authored `bio`, excerpted to `BIO_EXCERPT_CHARS` and fenced
 * (author-written ⇒ untrusted, so an "ignore your rules" line smuggled into a bio reads as
 * in-world background, never authority). "" when no bio is authored.
 */
export function buildBioSection(bio: string): string {
  return bio.trim() ? `Background:\n${fenceUntrusted("background", excerpt(bio, BIO_EXCERPT_CHARS))}` : "";
}

/** True when a preference targets intimate content — an intimate concept, or a family whose concepts all are. */
export function isIntimatePreference(pref: Preference): boolean {
  const concept = interactionConceptById(pref.target);
  if (concept) return concept.intimate;
  const familyIds = conceptIdsInFamily(pref.target);
  return familyIds.length > 0 && familyIds.every((id) => interactionConceptById(id)?.intimate === true);
}

/**
 * The "What lands well and badly" block: the authored
 * `profile.preferences` rendered as narrator-facing law so a like/dislike shapes the
 * REPLY in the same exchange — not just the post-turn affinity pulse (the old gap: a
 * "dislikes compliments" character accepted the compliment and only the number stung).
 * Stable (authored) ⇒ the cached prefix. Intimate-concept preferences are fenced out for a
 * minor. Fenced (the hint text is author-written). "" when nothing lands either way.
 */
export function buildPreferencesSection(preferences: readonly Preference[], player: string, minor: boolean): string {
  const visible = preferences.filter((p) => !(minor && isIntimatePreference(p)));
  const likes = visible.filter((p) => p.valence === "like");
  const dislikes = visible.filter((p) => p.valence === "dislike");
  if (!likes.length && !dislikes.length) return "";
  const lines = [
    ...likes.map((p) => `- Lands well: ${describePreference(p)}.`),
    ...dislikes.map((p) => `- Lands badly: ${describePreference(p)}.`),
  ];
  return (
    `What lands well and badly with you (how specific things ${player} says and does actually sit with you — ` +
    `let it color your reply IN the moment, not only how you feel afterward; a thing you dislike lands as friction ` +
    `you show, never recite):\n${fenceUntrusted("preferences", lines.join("\n"))}`
  );
}

/**
 * The micro-exemplar block: 2–3 forge/redraft-drafted worked
 * examples — a charged situation paired with how THIS character answers it — rendered as
 * few-shots so voice + disposition + age anchor near generation, not only in the abstract
 * sliders. Stable (authored) ⇒ the cached prefix. Fenced (author-written). "" when none carry a
 * line. Distinct from the dynamic in-chat voice ring; these are the authored baseline.
 */
export function buildMicroExemplarsSection(exemplars: readonly MicroExemplar[]): string {
  const rows = exemplars.filter((e) => e.line.trim());
  if (!rows.length) return "";
  const lines = rows.map((e) => {
    const cue = e.situation.trim();
    return `- ${cue ? `${cue} → ` : ""}${e.line.trim()}`;
  });
  return (
    `How you actually answer a charged moment (worked examples of your voice and manner — match the STYLE and rhythm, ` +
    `never quote these back verbatim):\n${fenceUntrusted("voice examples", lines.join("\n"))}`
  );
}

/**
 * The structured voice-anchors block: pet phrases, a
 * rhythm/cadence note, and a never-says list rendered as concrete near-generation levers
 * for a consistent voice. Stable (authored) ⇒ the cached prefix, paired with a one-line tail
 * re-anchor (`buildVoiceReanchorLine`) beside the mood pin so voice sits near generation.
 * Fenced (author-written). "" when nothing is authored.
 */
export function buildVoiceAnchorsSection(anchors: VoiceAnchors): string {
  if (!hasVoiceAnchors(anchors)) return "";
  const lines: string[] = [];
  if (anchors.petPhrases.length) lines.push(`- Turns of phrase you actually use: ${anchors.petPhrases.join("; ")}.`);
  if (anchors.cadence.trim()) lines.push(`- Rhythm and cadence: ${anchors.cadence.trim()}.`);
  if (anchors.neverSays.length) lines.push(`- You never say (off-limits for you): ${anchors.neverSays.join("; ")}.`);
  return `Your voice, concretely (the sound of you — let it shape word choice and rhythm; never recite this):\n${fenceUntrusted("voice anchors", lines.join("\n"))}`;
}
