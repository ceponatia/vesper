import { z } from "zod";
import { hasChatEvidenceNegation } from "@/lib/chat-input-evidence";
import type { ContactAreaBand, ContactMotionBand, ContactPressureBand } from "../affordances/contact/types";

/**
 * THE ONE SHARED CHAT-CONTACT VOCABULARY: the `CONTACT_TARGET_LOCATION`,
 * `chatContactGestures`, and `GESTURE_CONTACT` data, in one pure shared place.
 *
 * Player-line detectors (`server/engine/chat-contact/touch.ts`), the reply-scene
 * classifier's closed schema (`npc-scene-decision.ts`), its evidence verifiers
 * (`npc-scene-evidence.ts`), and NPC resolution read this same vocabulary.
 * A location admitted by the schema therefore stays one the detector can produce.
 *
 * Sentence eligibility lives here so contracts never import server modules.
 * Player input evidence and the reply-side ending floor (`chat-contact-reply.ts`)
 * import the same gate directly, preserving their shared veto set.
 */

// ---------------------------------------------------------------------------
// Shared sentence gates
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
 * Three consumers: the player-line detectors (`chat-contact/input-evidence.ts`), the
 * frozen reply-side NPC ending floor (`chat-contact-reply.ts`), and the
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

// ---------------------------------------------------------------------------
// Romantic-permission trigger vocabulary — grant, denial, absence, and
// withdrawal. ADDITIONS only: the regexes above are other consumers' contracts
// and stay untouched.
// ---------------------------------------------------------------------------

/**
 * Permission-SHAPED language: phrasings that grant, deny, or withdraw
 * (`"you can"`, `"go ahead"`, `"not now"`, `"never again"`, `"hands off"`…).
 *
 * This is TRIGGER vocabulary, not authority: it decides whether the romantic
 * permission decision leg spends its one classifier call on a reply, so it is
 * deliberately broad and sloppy — a false fire costs one cheap structured call,
 * a miss just leaves permission absent (the fail-closed direction). Nothing
 * downstream may treat a match as a grant; the structured decision plus the
 * deterministic validator own that (`romantic-permission-decision.ts`).
 */
export const CHAT_ROMANTIC_PERMISSION_CUE_RE =
  /\b(?:you\s+(?:can|may|could|are\s+(?:allowed|welcome))|go\s+ahead|feel\s+free|it'?s\s+(?:okay|alright|all\s+right|fine)|i\s+(?:don'?t|won'?t)\s+mind|i\s+(?:want|would\s+like)\s+you\s+to|permission|permitted|allow(?:s|ed|ing)?|let(?:s|ting)?\s+(?:you|him|her|them|me)|invit(?:e|es|ed|ing)|welcome\s+to|touch\s+me|hold\s+me|not\s+(?:now|tonight|yet|here|again|like\s+th(?:is|at))|no\s+more|never\s+(?:again|touch)|any\s?more|hands\s+off|off\s+(?:of\s+)?me|stop(?:s|ped|ping)?|that'?s\s+enough|enough\s+of\s+that|don'?t\s+(?:touch|hold|ever)|may\s+not|can'?t\s+(?:touch|keep)|refus\w*|forbid\w*|withdraw\w*|revok\w*|take[sn]?\s+(?:it\s+)?back)\b/iu;

/**
 * Neutral touch context the ROMANTIC regexes above cannot carry ("touch",
 * "hold", "hand" — ordinary words the affectionate lane deliberately excludes
 * from its veto vocabulary). The trigger requires one of these — or a
 * `CHAT_CONTACT_ROMANTIC_VERB_RE` / `CHAT_CONTACT_ROMANTIC_TARGET_RE` hit —
 * NEAR a permission cue, so "she stops at the door" alone never fires. Note
 * `\b` keeps `romantic_touch` (an identifier, e.g. chat text aping a developer
 * command) from matching: `_` is a word character, so no boundary precedes
 * "touch" there.
 */
export const CHAT_ROMANTIC_PERMISSION_TOUCH_RE =
  /\b(?:touch(?:es|ed|ing)?|hold(?:s|ing)?|held|hands?|fingers?|palms?|skin|closer?|contact)\b/iu;

// ---------------------------------------------------------------------------
// Romantic contact vocabulary — the narrow player-authored romantic action
// producer. The permission owner owns the first-romantic-action boundary.
// ---------------------------------------------------------------------------

/**
 * THE CLOSED ROMANTIC GESTURE FAMILY.
 *
 * Deliberately a SEPARATE tuple from `chatContactGestures` rather than three
 * more members of it. That list is the NPC reply-scene classifier's closed
 * decision schema (`npc-scene-decision.ts` reads `chatContactGestureSchema`),
 * and widening it would silently hand the NPC lane authority to propose
 * romantic contact — which the actor-control spec explicitly withholds until
 * NPC `start` authority is reviewed. Two tuples, two lanes, one direction of
 * travel.
 *
 * The family is the plan's own exemplar ("a caress/stroke/cup family"). It is
 * closed: a romantic verb outside these three produces no act at all rather
 * than degrading to the nearest member.
 */
export const chatRomanticContactGestures = ["caress", "stroke", "cup"] as const;
export const chatRomanticContactGestureSchema = z.enum(chatRomanticContactGestures);
export type ChatRomanticContactGesture = z.infer<typeof chatRomanticContactGestureSchema>;

/**
 * What each romantic gesture states about the contact it makes.
 *
 * Same law as `CHAT_GESTURE_CONTACT`: pressure is stated because the VERB
 * states it, and an unstated band is left unknown rather than defaulted. A
 * caress and a stroke are both moving contact, so they state `sliding`; a cup
 * states no motion at all, because holding is not moving and nobody said it
 * was.
 */
export const CHAT_ROMANTIC_GESTURE_CONTACT: Readonly<
  Record<
    ChatRomanticContactGesture,
    { readonly pressure: ContactPressureBand; readonly motion?: ContactMotionBand; readonly area?: ContactAreaBand }
  >
> = {
  caress: { pressure: "light", motion: "sliding" },
  stroke: { pressure: "light", motion: "sliding" },
  cup: { pressure: "light" },
};

/**
 * Romantic/intimate framing the ROMANTIC producer still refuses.
 *
 * This is `CHAT_CONTACT_ROMANTIC_VERB_RE` MINUS the three admitted gesture
 * stems (`caress`, `strok`, `cup`), plus the explicitly sexual and
 * clothing-manipulation verbs that regex left to its target half. Written out
 * rather than derived: the original is three other consumers' contract
 * (the affectionate detector, the frozen reply-side ending floor, and the NPC
 * assertion gate) and must not move, and a carve-out computed by subtracting
 * one regex from another is a silent widening waiting to happen.
 *
 * Note what stays vetoed on purpose: `trac(e|ing)`, `glid`, and `fingertips`
 * are romantic in register but outside the closed family, so a line built on
 * them commits nothing rather than being rounded to a caress.
 */
export const CHAT_ROMANTIC_CONTACT_EXCLUDED_VERB_RE =
  /\b(?:kiss\w*|nuzzl\w*|cuddl\w*|snuggl\w*|embrac\w*|hugs?|hugg\w*|straddl\w*|grind\w*|undress\w*|strip\w*|unbutton\w*|unzip\w*|unhook\w*|unclasp\w*|unfasten\w*|lick\w*|tast\w*|suck\w*|nibbl\w*|bit(?:e|es|ing)|moan\w*|arous\w*|seduc\w*|fondl\w*|grop\w*|thrust\w*|penetrat\w*|mount\w*|hump\w*|masturbat\w*|orgasm\w*|climax\w*|fuck\w*|trac(?:e|es|ed|ing)|glid\w*|fingertips?)\b/iu;

/**
 * The ROMANTIC target lexicon: the affectionate map plus the cheek.
 *
 * Owner ruling (2026-08-18): `cup` earns its place in the closed family only if
 * it can reach a cheek, which is what the gesture is actually for. The registry
 * already carries `face` as the coarse canonical surface, so `cheek` maps onto
 * it rather than inventing a `cheek` body location for one verb.
 *
 * This is a SEPARATE map, not three rows added to the shared one. Adding them
 * there would hand the cheek to the affectionate detector and to the NPC
 * classifier's closed schema, neither of which was ruled on — the romantic lane
 * reaches one more surface than the affectionate lane, and that difference has
 * to live somewhere only the romantic lane reads.
 */
const chatRomanticTargetLocationEntries = {
  ...chatContactTargetLocationEntries,
  cheek: "face",
  cheeks: "face",
  face: "face",
} as const;

export type ChatRomanticTargetLocationId =
  (typeof chatRomanticTargetLocationEntries)[keyof typeof chatRomanticTargetLocationEntries];

const CHAT_ROMANTIC_TARGET_LOCATION: Readonly<Record<string, ChatRomanticTargetLocationId>> =
  chatRomanticTargetLocationEntries;

/** The canonical id a written noun names for a romantic act, or `undefined`. */
export function chatRomanticTargetLocationOf(noun: string): ChatRomanticTargetLocationId | undefined {
  return CHAT_ROMANTIC_TARGET_LOCATION[noun.trim().toLowerCase()];
}

/** Longest-first written-noun alternation, derived from the romantic map's keys. */
export const chatRomanticTargetNounAlternation: string = Object.keys(chatRomanticTargetLocationEntries)
  .sort((left, right) => right.length - left.length || (left < right ? -1 : 1))
  .map((noun) => noun.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  .join("|");

/**
 * Target framing the ROMANTIC producer refuses — `CHAT_CONTACT_ROMANTIC_TARGET_RE`
 * MINUS `cheeks?`, and minus nothing else.
 *
 * Owner ruling (2026-08-18): cupping someone's cheek is the most natural use of
 * `cup` in the closed romantic family, so the romantic lane admits the cheek —
 * **and the shared regex above must not lose the word to make that happen.**
 * That regex is read by the affectionate detector and by the frozen reply-side
 * ending floor; taking `cheeks?` out of it would let an affectionate act land on
 * a cheek, which is not what was ruled, and is the kind of side effect this lane
 * has to stop causing.
 *
 * So the carve-out lives here, in a regex only the romantic gate reads, exactly
 * as `CHAT_ROMANTIC_CONTACT_EXCLUDED_VERB_RE` carves out the three admitted
 * verbs. The shared list keeps its exact current meaning for its exact current
 * consumers. Note `face` never appears in either list — it was not romantic
 * framing to begin with; it is simply a surface nothing previously reached.
 */
export const CHAT_ROMANTIC_CONTACT_EXCLUDED_TARGET_RE =
  /\b(?:lips?|mouth|tongue|thighs?|chest|breasts?|nipples?|cleavage|waist|hips?|belly|stomach|navel|neck|throat|nape|jaw|chin|ears?|earlobes?|buttocks?|butt|ass|arse|rear|groin|crotch|pussy|cunt|vulva|clit\w*|penis|cock|dick|naked|nude|bare skin|small of)\b/iu;

/**
 * The romantic producer's sentence gate — a SIBLING of
 * `contactSentenceEligible`, never a replacement for it.
 *
 * Same first three vetoes (a question, a hedge, a denial). Both the verb and
 * the target half are narrowed, each by exactly one carve-out, and each as its
 * OWN regex rather than an edit to the shared one.
 *
 * **These vetoes are a second line, not the boundary.** An earlier revision of
 * this producer tried to keep out-of-scope content out with a long deny-list of
 * forbidden words. An adversarial pass broke it in 75 of 86 attempts — `make
 * love`, `chain you to the bed`, `titty`, `taking off` — while the same list
 * over-fired on ordinary prose (`until`, `lift`, `tie`, `bound`). That is the
 * general shape of the problem: a deny-list over free-form English cannot be
 * finished, and every entry that tightens it also refuses something innocent.
 *
 * The real boundary is therefore structural and lives in the producer's pattern
 * (`ROMANTIC_DIRECT_RE`), which must match the WHOLE sentence. `I caress your
 * arm and <anything>` is refused because of the trailing clause, never because
 * of what is in it — so the unbounded question "what content is forbidden?" is
 * replaced by the bounded one "what shape is an admitted act?". Both halves of
 * the act are then allow-lists: a closed verb family and a closed locus map.
 *
 * What survives here is cheap defense in depth against a future edit that
 * loosens that pattern. Do not add to it in the belief that it is the guard.
 *
 * Restraint is vetoed by the caller's commit gate, exactly as it is for the
 * affectionate detector — `trapped` mobility still has no producer.
 */
export function romanticContactSentenceEligible(sentence: string): boolean {
  if (sentence.includes("?")) return false;
  if (CHAT_CONTACT_CONDITIONAL_RE.test(sentence)) return false;
  if (hasChatEvidenceNegation(sentence)) return false;
  if (CHAT_ROMANTIC_CONTACT_EXCLUDED_VERB_RE.test(sentence)) return false;
  if (CHAT_ROMANTIC_CONTACT_EXCLUDED_TARGET_RE.test(sentence)) return false;
  return true;
}
