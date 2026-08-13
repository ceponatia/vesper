/**
 * Bond classifier (phase-2-plan T1, ruled 2026-06-12): a deterministic keyword
 * pass over a cast member's concept/bio text that decides how the NPC's
 * `perceived` edge toward the player seeds at spawn. Mutual-knowledge kinds
 * (family, partners, friends, coworkers, …) mean the player plausibly knows
 * the relationship too, so `perceived` mirrors the feeling midpoint; explicit
 * first-meeting phrasing means the NPC can have no read on the player yet (no
 * row); anything else is indeterminate and mirrors the midpoint — the safe
 * default. The richer LLM read of narrative history is the forge rider's job
 * (phase-2-plan T12). Pure keyword tables; tune by editing this file.
 */

export type BondClass = "mutual" | "first-meeting" | "indeterminate";

/**
 * Phrases asserting the characters have not met. Checked first — "her brother,
 * though they have never met" is a first meeting, not a mutual bond.
 */
export const FIRST_MEETING_PHRASES: readonly string[] = [
  "never met",
  "first meeting",
  "first encounter",
  "for the first time",
  "haven't met",
  "have not met",
  "hasn't met",
  "has not met",
  "yet to meet",
  "don't know each other",
  "do not know each other",
  "strangers",
  "a stranger",
];

/** Named relationship kinds both sides would know about. Plurals match automatically. */
export const MUTUAL_BOND_KEYWORDS: readonly string[] = [
  // family
  "family",
  "sibling",
  "brother",
  "sister",
  "twin",
  "parent",
  "mother",
  "father",
  "mom",
  "dad",
  "son",
  "daughter",
  "cousin",
  "aunt",
  "uncle",
  "nephew",
  "niece",
  "grandmother",
  "grandfather",
  "grandparent",
  "grandma",
  "grandpa",
  // partners
  "partner",
  "spouse",
  "husband",
  "wife",
  "fiancé",
  "fiancée",
  "fiance",
  "fiancee",
  "boyfriend",
  "girlfriend",
  "lover",
  "married",
  "sweetheart",
  "ex",
  // friends & social
  "friend",
  "friendship",
  "roommate",
  "housemate",
  "flatmate",
  "neighbor",
  "neighbour",
  "rival",
  "enemy",
  "nemesis",
  // work
  "coworker",
  "co-worker",
  "colleague",
  "workmate",
  "teammate",
  "classmate",
  "schoolmate",
  "crewmate",
  "boss",
  "employer",
  "employee",
  "mentor",
  "apprentice",
];

/**
 * Whole-term match: no letter may touch either end of the term, so "mother"
 * never fires inside "godmother", but multi-word phrases and hyphenated terms
 * match as written. An optional plural suffix is allowed ("coworkers").
 */
function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\p{L})${escaped}(?:e?s)?(?!\\p{L})`, "iu");
}

const firstMeetingPatterns = FIRST_MEETING_PHRASES.map(termPattern);
const mutualPatterns = MUTUAL_BOND_KEYWORDS.map(termPattern);

/** Classify the player bond described by a cast member's concept/bio text. */
export function classifyBond(text: string): BondClass {
  if (firstMeetingPatterns.some((p) => p.test(text))) return "first-meeting";
  if (mutualPatterns.some((p) => p.test(text))) return "mutual";
  return "indeterminate";
}
