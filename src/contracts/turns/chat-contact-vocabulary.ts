import { z } from "zod";
import { hasChatEvidenceNegation } from "@/lib/chat-input-evidence";
import type { ContactAreaBand, ContactMotionBand, ContactPressureBand } from "../affordances/contact/types";

/**
 * THE ONE SHARED CHAT-CONTACT VOCABULARY
 * (romantic-contact-affordances.spec.actor-control.md §"Closed decision schema":
 * "extract the current private `CONTACT_TARGET_LOCATION`, `chatContactGestures`,
 * and `GESTURE_CONTACT` data into one pure shared chat-contact vocabulary").
 *
 * Everything here used to live as private data inside
 * `src/server/engine/chat-contact-adapter.ts`, which was fine while the
 * player-line detector was the only consumer. The NPC actor-control work adds
 * three more: the reply-scene classifier's closed decision schema
 * (`npc-scene-decision.ts`), the evidence congruence verifiers
 * (`npc-scene-evidence.ts`), and — at wiring time — the NPC contact adapter.
 * Four consumers reading four copies of a gesture list is how a location id the
 * schema accepts stops being one the detector can produce, so the data moved
 * HERE (pure contracts, importable by every leg) and the adapter now imports
 * it. The move is behavior-preserving: same members, same tables, same regexes.
 *
 * The sentence-eligibility gates ride along for the same reason. The evidence
 * admission gates must "reuse the shared veto machinery … rather than inventing
 * a divergent list", and `src/contracts` cannot import a server module — so the
 * shared machinery lives here and the server adapter re-exports
 * `contactSentenceEligible` for the frozen ending floor
 * (`chat-contact-reply.ts`), whose veto set is therefore UNCHANGED.
 */

// ---------------------------------------------------------------------------
// Sentence gates (moved verbatim from chat-contact-adapter.ts)
// ---------------------------------------------------------------------------

/** Sentence boundaries: terminal punctuation, or a line break. */
export const CHAT_CONTACT_SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/u;

/**
 * Typographic quotes → straight, BEFORE span parsing. Model prose regularly
 * dialogues in curly quotes, and the span parser only treats straight `"` as
 * speech — unnormalized, a curly-quoted "Don't pull away" would read as
 * narration. Pinned to the private `normalizeQuotes` in the frozen
 * `chat-contact-reply.ts`: both replace one character with one character, so a
 * normalized string keeps every offset of the raw one.
 */
export function normalizeTypographicQuotes(text: string): string {
  return text.replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

/**
 * Markers that put a whole sentence out of reach.
 *
 * Wider and blunter than the premise detector's positional rules on purpose: a
 * missed touch costs a turn of silence, and a committed one the player did not
 * make is a durable row claiming a contact that never happened.
 */
export const CHAT_CONTACT_CONDITIONAL_RE =
  /\b(?:if|would|could|should|might|may|maybe|perhaps|imagine|suppose|pretend|wish|almost|nearly|want to|wanted to|going to|about to|tr(?:y|ies|ied|ying) to|as if|as though|like a|like the)\b/iu;

/**
 * Romantic and intimate framing — vetoed WHOLE-SENTENCE (owner ruling: a
 * genuinely affectionate proof, never a romantic case relabeled to commit).
 *
 * A sentence that kisses and also rests a hand on a shoulder is not an
 * affectionate touch with decoration; it is a beat whose framing this proof has
 * no permission owner for, and the honest answer is to commit nothing.
 */
export const CHAT_CONTACT_ROMANTIC_VERB_RE =
  /\b(?:kiss\w*|caress\w*|strok\w*|nuzzl\w*|cuddl\w*|snuggl\w*|embrac\w*|hugs?|hugg\w*|straddl\w*|grind\w*|undress\w*|strip\w*|lick\w*|tast\w*|suck\w*|nibbl\w*|bit(?:e|es|ing)|moan\w*|arous\w*|seduc\w*|fondl\w*|grop\w*|cups?|cupp\w*|trac(?:e|es|ed|ing)|glid\w*|fingertips?)\b/iu;
export const CHAT_CONTACT_ROMANTIC_TARGET_RE =
  /\b(?:lips?|mouth|tongue|thighs?|chest|breasts?|nipples?|cleavage|waist|hips?|belly|stomach|navel|neck|throat|nape|jaw|chin|cheeks?|ears?|earlobes?|buttocks?|butt|ass|arse|rear|groin|crotch|pussy|cunt|vulva|clit\w*|penis|cock|dick|naked|nude|bare skin|small of)\b/iu;

/**
 * Restraint, pinning, and force. `trapped` mobility has no producer in the scene
 * owner, so a scenario that would need one is refused at the door rather than
 * resolved against a model that cannot express it.
 */
export const CHAT_CONTACT_RESTRAINT_RE =
  /\b(?:pin\w*|trap\w*|restrain\w*|held down|hold\w* down|grabs?|grabb\w*|grips?|gripp\w*|yank\w*|shov(?:e|es|ed|ing)|push\w*|pull\w*|forc(?:e|es|ed|ing)|wrestl\w*|tackl\w*|drag\w*|hold\w* still|struggl\w*)\b/iu;

/**
 * The gates EVERY detector shares: a question, a hedge, a denial, or romantic
 * framing is a sentence this proof reads as nothing at all.
 *
 * Three consumers: the player-line detectors (`chat-contact-adapter.ts`), the
 * frozen reply-side NPC ending floor (`chat-contact-reply.ts`, via the
 * adapter's re-export — its veto set is unchanged by the move here), and the
 * NPC reply-scene assertion gate (`npc-scene-evidence.ts`), which layers its
 * own third-person vetoes ON TOP rather than altering these.
 */
export function contactSentenceEligible(sentence: string): boolean {
  if (sentence.includes("?")) return false;
  if (CHAT_CONTACT_CONDITIONAL_RE.test(sentence)) return false;
  // Negation is judged by the shared chat-evidence primitive — ONE negation
  // judge for the whole lane (the complete auxiliary-contraction family,
  // apostrophe-normalized), not a second regex that could drift from it.
  if (hasChatEvidenceNegation(sentence)) return false;
  if (CHAT_CONTACT_ROMANTIC_VERB_RE.test(sentence)) return false;
  if (CHAT_CONTACT_ROMANTIC_TARGET_RE.test(sentence)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

/** How the hand meets the surface. Three gestures, and each one states its own pressure. */
export const chatContactGestures = ["rest", "pat", "squeeze"] as const;
export const chatContactGestureSchema = z.enum(chatContactGestures);
export type ChatContactGesture = z.infer<typeof chatContactGestureSchema>;

/** The acting surface for every act the chat contact lane detects or proposes. */
export const CHAT_CONTACT_SOURCE_LOCATION = "hands";

/**
 * What each gesture states about the contact it makes.
 *
 * Pressure is stated because the VERB states it: "rest a hand" is a description
 * of light contact, not a guess at one. Area is deliberately absent — nobody
 * said how much of the hand — and the contact core is built to leave an unstated
 * band unknown rather than defaulting it to the lightest thing that could be true.
 */
export const CHAT_GESTURE_CONTACT: Readonly<
  Record<
    ChatContactGesture,
    { readonly pressure: ContactPressureBand; readonly motion?: ContactMotionBand; readonly area?: ContactAreaBand }
  >
> = {
  rest: { pressure: "light" },
  pat: { pressure: "light", motion: "tapping" },
  squeeze: { pressure: "moderate" },
};

// ---------------------------------------------------------------------------
// Affectionate target locations
// ---------------------------------------------------------------------------

/**
 * The target lexicon: written noun → body-registry location id.
 *
 * An ALLOW-list, and everything romantic is simply absent from it rather than
 * being filtered afterwards. These are the surfaces an ordinary affectionate
 * hand lands on, and every id is one `bodyLocationRegistry` already carries — a
 * parallel anatomy is exactly what the contact core refuses to own.
 *
 * Kept as a private literal so the canonical-id union can be DERIVED from the
 * map values (the exported map is widened for arbitrary-noun lookups).
 */
const chatContactTargetLocationEntries = {
  shoulder: "shoulders",
  shoulders: "shoulders",
  "upper arm": "upper_arms",
  arm: "arms",
  arms: "arms",
  forearm: "forearms",
  forearms: "forearms",
  hand: "hands",
  hands: "hands",
  "upper back": "back",
  back: "back",
  head: "head",
  hair: "hair",
} as const;

/**
 * The canonical location-id union — derived from the target map's VALUES, so a
 * new noun row that maps to a new registry id widens this type in the same
 * edit. The classifier schema and the congruence verifier both speak in these
 * ids; a model-authored body-part string is never one.
 */
export type ChatAffectionateTargetLocationId =
  (typeof chatContactTargetLocationEntries)[keyof typeof chatContactTargetLocationEntries];

/** Written noun → canonical location id, widened for arbitrary-noun lookups. */
export const CHAT_CONTACT_TARGET_LOCATION: Readonly<Record<string, ChatAffectionateTargetLocationId>> =
  chatContactTargetLocationEntries;

/**
 * The distinct canonical ids, as a tuple `z.enum` can close over.
 *
 * Spelled out rather than computed (a zod enum needs a literal tuple), with the
 * `satisfies` pinning every member to the derived union — and the colocated
 * test pins set-equality with the map values, so the two cannot drift apart.
 */
export const chatAffectionateTargetLocationIds = [
  "shoulders",
  "upper_arms",
  "arms",
  "forearms",
  "hands",
  "back",
  "head",
  "hair",
] as const satisfies readonly ChatAffectionateTargetLocationId[];

export const chatAffectionateTargetLocationIdSchema = z.enum(chatAffectionateTargetLocationIds);

/** The canonical id a written noun names, or `undefined` for a noun off the allow-list. */
export function chatAffectionateTargetLocationOf(noun: string): ChatAffectionateTargetLocationId | undefined {
  return CHAT_CONTACT_TARGET_LOCATION[noun.trim().toLowerCase()];
}

/**
 * The written-noun alternation for target regexes, derived from the map keys —
 * longest first (then lexicographic, for determinism), so "upper back" is never
 * read as "back" and "shoulders" is preferred over "shoulder". Derived rather
 * than hand-maintained: a new noun row joins every consumer's regex in the same
 * edit, which is the entire point of a single vocabulary.
 */
export const chatContactTargetNounAlternation: string = Object.keys(chatContactTargetLocationEntries)
  .sort((left, right) => right.length - left.length || (left < right ? -1 : 1))
  .map((noun) => noun.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  .join("|");
