import { CHAT_CONTACT_RESTRAINT_RE, contactSentenceEligible, type AffordanceSubjectId } from "@/contracts";
import type { ChatContactMaterialSource } from "./material";
import { chatEvidenceSentences } from "@/lib/chat-input-evidence";

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** One PRESENT roster character, as the detectors and the material adapter need them. */
export interface ChatContactRosterMember {
  readonly subjectId: AffordanceSubjectId;
  readonly name: string;
  readonly aliases: readonly string[];
  /**
   * Whether this conversation can say what lies between a hand and this body,
   * from `chatContactMaterialSource`. REQUIRED, and deliberately not defaulted:
   * a roster assembled without it would answer "bare skin" for every character
   * the wardrobe never enumerated, which is the one answer this lane may not
   * invent (see `chatContactMaterialSource`).
   */
  readonly material: ChatContactMaterialSource;
}

// ---------------------------------------------------------------------------
// Text gates
// ---------------------------------------------------------------------------

/**
 * Sentence spans come from `lib/chat-input-evidence.ts`; eligibility gates come
 * from `contracts/turns/chat-contact-vocabulary.ts`, shared with NPC reply-scene
 * evidence. This module composes them only for player-line detection.
 */

/**
 * The shared gates PLUS the restraint veto — the gate for anything that starts
 * or sustains a contact.
 *
 * The restraint list exists because `trapped` mobility has no producer,
 * so a contact framed as force is refused rather than resolved against a model
 * that cannot hold it. That argument is about contacts this lane would CREATE,
 * which is why the release scan below does not use this gate: see
 * `endingSentences`.
 */
export function contactCommitSentenceEligible(sentence: string): boolean {
  return contactSentenceEligible(sentence) && !CHAT_CONTACT_RESTRAINT_RE.test(sentence);
}

export interface ChatContactDetectionInput {
  /** The player's raw line this turn. */
  readonly message: string;
  /** Storyteller narration: excluded entirely — it is not the player's body. */
  readonly narratorInput: boolean;
  /** PRESENT roster members only. */
  readonly characters: readonly ChatContactRosterMember[];
}

/**
 * The sentences a detector may read.
 *
 * Ordinary player NARRATION only — narrower than the premise detector's span
 * rule, and for a different reason. A correction judges a CLAIM, and a claim can
 * be spoken; an act has to be performed. "I'll come over and sit with you" is a
 * plan the character may respond to, not a body that moved, so speech, thought,
 * OOC, comms, written, and styled spans all produce nothing here.
 *
 * Storyteller narration is excluded at the door by `narratorInput`: it is
 * authored story events, not the player's own body, and treating it as one would
 * be exactly the narrator-gains-physical-authority failure the scene owner
 * exists to prevent.
 */
export function contactSentences(
  input: ChatContactDetectionInput,
  eligible: (sentence: string) => boolean = contactCommitSentenceEligible,
): readonly string[] {
  if (input.narratorInput) return [];
  const message = input.message.trim();
  if (message.length === 0) return [];
  const sentences: string[] = [];
  for (const { text } of chatEvidenceSentences(message, ["narration"])) {
    if (eligible(text)) sentences.push(text);
  }
  return sentences;
}

/**
 * The sentences an END may be read from: every shared gate, minus restraint.
 *
 * The restraint veto refuses sentences whose framing this lane cannot
 * MODEL, and it is right to refuse to START a contact on one. An end starts
 * nothing — it removes a row — and the word it would veto on is usually the end
 * itself: "I pull my hand back" and "I pull away" are the plainest ways in
 * English to say these two things, and dropping them would leave durable
 * contacts the player explicitly ended. A stale contact that outlives the hand
 * is worse than an end this proof read from a forceful-sounding sentence, so the
 * veto is lifted for the ends and nowhere else. Nothing forceful can sneak a
 * contact in through this door: the lexicons below only match the player's own
 * hand leaving or their own body moving off, and their only power is to end.
 */
export function endingSentences(input: ChatContactDetectionInput): readonly string[] {
  return contactSentences(input, contactSentenceEligible);
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/** Owner tokens that name somebody only the roster can disambiguate. */
const PRONOUN_OWNERS: ReadonlySet<string> = new Set(["you", "your", "her", "him", "his", "them", "their", "theirs"]);

/**
 * One written name phrase, comparable — case-folded, internal whitespace
 * collapsed, one trailing possessive removed — or `null` for a phrase this
 * layer must not read as a name at all.
 *
 * The INTERNAL-possessive refusal is the load-bearing part. "Sabrina's sister"
 * names a third party the roster does not contain, and a first-name rule that
 * looked at its leading word would answer "Sabrina" — touching a body the
 * sentence explicitly did not name. Any word but the last carrying `'s`
 * therefore makes the whole phrase unreadable rather than merely unmatched.
 */
function normalizedNamePhrase(written: string): string | null {
  const trimmed = written.trim().replace(/['’]s$/iu, "");
  if (trimmed.length === 0) return null;
  const words = trimmed.split(/\s+/u);
  if (words.some((word) => /['’]s$/iu.test(word))) return null;
  return words.map((word) => word.toLowerCase()).join(" ");
}

/** The leading word of a roster name — "Sabrina" of "Sabrina Vale". */
function firstNameOf(written: string): string {
  const normalized = normalizedNamePhrase(written);
  return normalized === null ? "" : (normalized.split(" ")[0] ?? "");
}

/**
 * Who a written owner phrase names, or `null`.
 *
 * Three ways to land, tried in that order, and the order is the whole design:
 *
 * 1. **The full name or an authored alias**, matched as a PHRASE. A roster name
 *    is routinely two words, and the capture that feeds this resolves the whole
 *    of it, so "Sabrina Vale's arm" names Sabrina Vale.
 * 2. **A unique first name.** Players write "Sabrina", not "Sabrina Vale", and
 *    before this the sentence produced nothing at all. It resolves only when
 *    exactly ONE present character answers to that leading word: two Sabrinas in
 *    the room make it silence, by the same law that makes an ambiguous pronoun
 *    silence. Uniqueness is asked of the PRESENT roster, so a character who
 *    walked out cannot make a first name ambiguous for the people still there.
 * 3. **A pronoun** — `you`, `your`, `her`, `him`, `their` — ONLY when exactly one
 *    character is present, because in a group it names somebody the sentence has
 *    not identified, and picking one would be this layer choosing who got touched.
 *
 * An exact name outranks a first name so that a character literally named
 * "Vale" is never lost to somebody else's surname, and a first name that
 * resolves ambiguously stops there rather than falling through to the pronoun
 * rule — "Sabrina" is not a pronoun, and treating an ambiguous name as one
 * would hand a two-character room to whoever the roster happened to list.
 */
export function resolveContactTarget(
  owner: string,
  characters: readonly ChatContactRosterMember[],
): ChatContactRosterMember | null {
  const phrase = normalizedNamePhrase(owner);
  if (phrase === null) return null;
  const named = characters.find(
    (member) =>
      normalizedNamePhrase(member.name) === phrase ||
      member.aliases.some((alias) => normalizedNamePhrase(alias) === phrase),
  );
  if (named !== undefined) return named;
  // First names come from the roster NAME and never from an alias, and a pronoun
  // never reaches this pass at all. Both exclusions are the same guard against
  // the same mistake: an alias is free authored text, so its leading word is as
  // likely to be a descriptor's article as a person's given name.
  //
  // "her ladyship" would otherwise donate "her", and a pronoun resolving here
  // would skip the sole-character rule below entirely — turning a two-character
  // room, where a pronoun is silence by law, into a guess that commits a durable
  // touch on a body the sentence never identified. "the redhead" and "my love"
  // donate "the" and "my", which ordinary movement prose writes constantly, so
  // "I walk over to the window" would resolve as walking over to her.
  //
  // The cost is that a multi-word ALIAS can no longer be reached by its first
  // word alone; the whole alias still matches exactly, above. That is a refusal
  // where a commit was arguably fine, which is the direction this lane pays in.
  const byFirstName = PRONOUN_OWNERS.has(phrase)
    ? []
    : characters.filter((member) => firstNameOf(member.name) === phrase);
  if (byFirstName.length > 0) return byFirstName.length === 1 ? (byFirstName[0] ?? null) : null;
  if (!PRONOUN_OWNERS.has(phrase)) return null;
  const sole = characters.length === 1 ? characters[0] : undefined;
  return sole ?? null;
}

/**
 * A written name as a CAPTURE fragment: one word, plus up to two more words of
 * two letters or more.
 *
 * Every owner capture in this lane used to be a single word, which left a
 * two-word roster name unreachable by ANY phrasing — "Sabrina Vale's arm"
 * matched nothing, and neither did "Sabrina Vale" as a destination. This is the
 * smallest widening that reaches them.
 *
 * **The continuations are deliberately NOT restricted to capitals**, and the
 * reason is worth stating because the opposite looks obviously right. Every
 * pattern this fragment is spliced into carries the `i` flag, and under case
 * folding `\p{Lu}` matches lowercase letters too — so a capitalised-continuation
 * rule would not have constrained anything. Worse, it would not have been
 * inert: `\p{Lu}` matches only letters that HAVE a case mapping, so it silently
 * excludes every caseless script, and a character named さくら or 中村 would have
 * been unreachable in exactly the way this fragment exists to fix.
 *
 * What actually keeps the capture from swallowing the sentence is the RESOLVER,
 * not the pattern: `resolveNamePhrasePrefix` takes the longest leading run that
 * names somebody, so "I walk over to Wren and sit down" captures three words and
 * resolves one. The two-letter minimum stays because it is the one thing the
 * resolver cannot do — "I walk over to Wren I think" would otherwise capture the
 * pronoun as part of the name, and `i` folding makes that no harder to write
 * than to read.
 */
export const NAME_PHRASE = "[\\p{L}][\\p{L}\\p{N}'’-]*(?:\\s+[\\p{L}][\\p{L}\\p{N}'’-]+){0,2}";

/** A resolved destination, with the words it actually spent. */
interface ResolvedNamePhrase {
  readonly member: ChatContactRosterMember;
  /** The written words this used — what the possessive guard must inspect. */
  readonly consumed: string;
  /** Whether an ordinary word followed those, captured or not. */
  readonly followedByWord: boolean;
}

/**
 * The LONGEST leading run of a captured phrase that names somebody, or `null`.
 *
 * The fragment above is deliberately greedy, and greed alone would LOSE targets
 * that resolve today: "I walk over to Wren Vaelith" captures two names, and a
 * resolver that only ever asked about the whole capture would answer nothing
 * where the one-word capture used to answer Wren. Trying the full phrase first
 * and then shortening lets "Sabrina Vale" resolve as a person while leaving
 * every one-word case exactly as it was — so this can only resolve MORE than
 * the capture it replaces, never differently.
 *
 * `followedByWord` is reported against the words actually spent rather than the
 * whole capture, because the possessive guard's question is about what follows
 * the NAME: in "I walk over to Wren Vaelith" the name is one word, and another
 * word does follow it.
 */
export function resolveNamePhrasePrefix(
  phrase: string,
  trailingWord: boolean,
  characters: readonly ChatContactRosterMember[],
): ResolvedNamePhrase | null {
  const words = phrase.trim().split(/\s+/u).filter((word) => word.length > 0);
  for (let take = words.length; take > 0; take -= 1) {
    const consumed = words.slice(0, take).join(" ");
    const member = resolveContactTarget(consumed, characters);
    if (member !== null) return { member, consumed, followedByWord: take < words.length || trailingWord };
  }
  return null;
}