import {
  CHAT_CONTACT_RESTRAINT_RE,
  CHAT_CONTACT_SOURCE_LOCATION,
  chatAffectionateTargetLocationOf,
  chatContactTargetNounAlternation,
  chatRomanticTargetLocationOf,
  chatRomanticTargetNounAlternation,
  romanticContactSentenceEligible,
  type AffordanceSubjectId,
  type ChatContactGesture,
  type ChatRomanticContactGesture,
  type ContactEventRef,
} from "@/contracts";
import {
  NAME_PHRASE,
  contactCommitSentenceEligible,
  contactSentences,
  endingSentences,
  resolveContactTarget,
  resolveNamePhrasePrefix,
  type ChatContactDetectionInput,
} from "./input-evidence";
import {
  CHAT_CONTACT_PLAYER_SUBJECT,
  chatContactActionId,
  type ChatContactAct,
  type ChatContactActGesture,
  type ChatContactActShape,
} from "./identity";

/**
 * The target lexicon (written noun → body-registry location id) and its
 * longest-first regex alternation moved to the shared vocabulary
 * (`chatAffectionateTargetLocationOf` / `chatContactTargetNounAlternation`),
 * so the classifier schema and the evidence verifiers can never accept a
 * surface this detector cannot produce.
 */
/**
 * Whose body the sentence named. The possessive is the anchor that makes the
 * multi-word branch safe here: the owner must END at `'s` and the body noun must
 * follow it immediately, so "Sabrina Vale's arm" parses as one possessor.
 *
 * This site has no longest-prefix fallback — the phrase ends where the sentence
 * says it does — so it leans entirely on the resolver failing closed. It does:
 * "my wife Sabrina's shoulder" captures the whole possessor, matches no roster
 * name and no unique first name, and produces nothing. Refusing a touch that was
 * arguably fine is the safe direction; resolving a possessor's last word would
 * be this layer picking a body out of a phrase that named somebody else.
 */
const CONTACT_OWNER = `your|her|his|their|[\\p{L}][\\p{L}\\p{N}'’-]*(?:\\s+[\\p{L}][\\p{L}\\p{N}'’-]+){0,2}['’]s`;

/** "I rest my hand on your shoulder" — the hand is the object, the body part the destination. */
const CONTACT_PLACE_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(rest|rests|rested|resting|place|places|placed|placing|put|puts|putting` +
    `|lay|lays|laid|laying|set|sets|setting|settle|settles|settled|settling)\\s+` +
    `(?:my|a|one|the)\\s+(?:hand|hands|palm)\\s+(?:on|onto|against|over|to)\\s+` +
    `(${CONTACT_OWNER})\\s+(${chatContactTargetNounAlternation})\\b`,
  "iu",
);

/** "I pat your head" / "I squeeze your hand" — the body part is the direct object. */
const CONTACT_DIRECT_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(pat|pats|patted|patting|squeeze|squeezes|squeezed|squeezing)\\s+` +
    `(${CONTACT_OWNER})\\s+(${chatContactTargetNounAlternation})\\b`,
  "iu",
);

function gestureOf(verb: string): ChatContactGesture {
  const stem = verb.toLowerCase();
  if (stem.startsWith("pat")) return "pat";
  if (stem.startsWith("squeez")) return "squeeze";
  return "rest";
}

/**
 * The player's affectionate touch this turn, or `null`.
 *
 * The source surface is always `hands`: the lexicon only matches a hand or a
 * palm, and the finer question of which fingers is one nobody stated. First
 * eligible sentence wins, for the reason the approach detector's does — two
 * contacts in one message is a beat this proof does not model.
 */
export function detectChatAffectionateTouch(
  input: ChatContactDetectionInput & { readonly eventRef: ContactEventRef },
): ChatContactAct | null {
  for (const sentence of contactSentences(input)) {
    const act = affectionateActInSentence(sentence, input);
    if (act !== null) return act;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Romantic touch — the narrow player-authored producer
// (the first-romantic-action boundary is owned by the permission module)
// ---------------------------------------------------------------------------

/**
 * "I caress her arm" / "I stroke your hair" / "I cup her hands".
 *
 * ONE form, the direct-object one, and deliberately no `place` twin. The
 * affectionate lexicon needs both because "I rest my hand on your shoulder"
 * and "I pat your head" are both ordinary; a romantic caress is stated
 * directly, and every extra admitted shape is another sentence this proof has
 * to be sure it read correctly. The acting surface is `hands` by the same law
 * as the affectionate detector — the verbs name a hand's action, and which
 * fingers is a question nobody answered.
 *
 * The target alternation is the SAME non-intimate lexicon the affectionate
 * detector uses. The permission spec's boundary is "non-intimate target loci
 * already supported by the chat contact vocabulary", so the first romantic
 * proof adds no body area at all: what changes is the framing and the
 * permission scope it therefore needs, never the reachable anatomy.
 */
/**
 * Closed leading adverbs and trailing adjuncts — the only words allowed to sit
 * beside the act inside an admitted sentence.
 *
 * Both lists are short because both are the price of the anchoring below: every
 * word admitted here is a word that no longer has to be proven harmless by a
 * deny-list. `in mine` earns its place by making "I cup your hands in mine" —
 * the most natural phrasing of the gesture — an admitted act rather than a
 * near-miss.
 */
const ROMANTIC_LEADING_ADVERB = "gently|softly|slowly|lightly|carefully|tenderly|quietly";
const ROMANTIC_TRAILING_ADJUNCT =
  "in mine|in my hands?|with my hand|with my palm|gently|softly|slowly|lightly|tenderly|once|twice|briefly|again|for a moment";

/**
 * ANCHORED TO THE WHOLE SENTENCE, and that is the guard.
 *
 * The affectionate patterns float: they look for their shape anywhere in the
 * sentence, and the words around it are policed by shared vetoes. The romantic
 * producer cannot borrow that design, because the content it must exclude —
 * every way English can express sex, restraint, undressing, and anatomy — is an
 * open set, and an earlier deny-list attempt at exactly this leaked 75 of 86
 * adversarial probes while refusing ordinary lines like "I caress your arm
 * until you smile".
 *
 * So an admitted romantic sentence must be the act and nothing else: `^`, an
 * optional closed adverb, the closed verb family, the owner, an allow-listed
 * locus, optional closed adjuncts, terminal punctuation, `$`. `I caress your
 * arm and chain you to the bed` is refused because of the trailing clause, with
 * no opinion about chains — which is what makes the boundary hold against
 * wording nobody enumerated.
 *
 * The cost is deliberate and one-directional: ordinary romantic prose that
 * carries a second clause commits nothing. That is a refusal where a commit was
 * arguably fine, never a commit where a refusal was required, and the first
 * proof is the right place to pay it.
 *
 * Capture-group contract is unchanged — 1 verb, 2 owner, 3 noun — so it shares
 * `playerContactActFrom` with the affectionate patterns.
 */
const ROMANTIC_DIRECT_RE = new RegExp(
  `^\\s*i\\s+(?:(?:${ROMANTIC_LEADING_ADVERB})\\s+){0,2}` +
    `(caress|caresses|caressed|caressing` +
    `|stroke|strokes|stroked|stroking|cup|cups|cupped|cupping)\\s+` +
    `(${CONTACT_OWNER})\\s+(${chatRomanticTargetNounAlternation})\\b` +
    `(?:\\s+(?:${ROMANTIC_TRAILING_ADJUNCT}))*\\s*[.!]?\\s*$`,
  "iu",
);

function romanticGestureOf(verb: string): ChatRomanticContactGesture {
  const stem = verb.toLowerCase();
  if (stem.startsWith("caress")) return "caress";
  if (stem.startsWith("cup")) return "cup";
  return "stroke";
}

/**
 * The romantic commit gate: the romantic sentence rules PLUS the same restraint
 * veto the affectionate commit path applies. Restraint is orthogonal to
 * framing — `trapped` mobility has no producer in the scene owner either way.
 */
function romanticCommitSentenceEligible(sentence: string): boolean {
  return romanticContactSentenceEligible(sentence) && !CHAT_CONTACT_RESTRAINT_RE.test(sentence);
}

/**
 * The player's romantic touch this turn, or `null`.
 *
 * Everything the affectionate detector fails closed on, this fails closed on
 * too — the shared span parser, the shared owner resolver (a pronoun in a group
 * of two is silence, not a guess), the shared non-intimate locus allow-list.
 * What differs is exactly two things, which is the whole point: the admitted
 * verb family, and `actionKind: "romantic"`, which is what finally gives the
 * directional permission owner an attempt to answer.
 *
 * It never degrades to `affectionate`. A romantic line the permission owner
 * refuses is a refused romantic action, not a milder one that happened anyway.
 */
export function detectChatRomanticTouch(
  input: ChatContactDetectionInput & { readonly eventRef: ContactEventRef },
): ChatContactAct | null {
  for (const sentence of contactSentences(input, romanticCommitSentenceEligible)) {
    const act = romanticActInSentence(sentence, input);
    if (act !== null) return act;
  }
  return null;
}

/**
 * One act from one matched sentence, for either kind.
 *
 * Every contact regex in this lane shares one capture-group contract — 1 is the
 * verb, 2 the owner token, 3 the target noun — so the only things that vary
 * between the two producers are the pattern that matched, the kind, and which
 * verb table reads group 1. Everything after the match is identical by law, not
 * by coincidence: both kinds resolve the owner through the same roster rules
 * (an ambiguous pronoun is silence), both land on the same non-intimate locus
 * allow-list, and both mint the same deterministic action id, so a retake
 * reproduces either one.
 */
function playerContactActFrom(
  match: RegExpExecArray | null,
  input: ChatContactDetectionInput & { readonly eventRef: ContactEventRef },
  actionKind: ChatContactAct["actionKind"],
  gestureFor: (verb: string) => ChatContactActGesture,
  locusOf: (noun: string) => string | undefined,
): ChatContactAct | null {
  if (match === null) return null;
  const target = resolveContactTarget(match[2] ?? "", input.characters);
  if (target === null) return null;
  const locationId = locusOf(match[3] ?? "");
  if (locationId === undefined) return null;
  const shape: ChatContactActShape = {
    actorSubject: CHAT_CONTACT_PLAYER_SUBJECT,
    targetSubject: target.subjectId,
    targetLocationId: locationId,
  };
  return {
    ...shape,
    actionId: chatContactActionId(input.eventRef, shape),
    sourceLocationId: CHAT_CONTACT_SOURCE_LOCATION,
    actionKind,
    gesture: gestureFor(match[1] ?? ""),
  };
}

function romanticActInSentence(
  sentence: string,
  input: ChatContactDetectionInput & { readonly eventRef: ContactEventRef },
): ChatContactAct | null {
  return playerContactActFrom(
    ROMANTIC_DIRECT_RE.exec(sentence),
    input,
    "romantic",
    romanticGestureOf,
    chatRomanticTargetLocationOf,
  );
}

function affectionateActInSentence(
  sentence: string,
  input: ChatContactDetectionInput & { readonly eventRef: ContactEventRef },
): ChatContactAct | null {
  return playerContactActFrom(
    CONTACT_PLACE_RE.exec(sentence) ?? CONTACT_DIRECT_RE.exec(sentence),
    input,
    "affectionate",
    gestureOf,
    chatAffectionateTargetLocationOf,
  );
}

/**
 * THE ONE PLAYER CONTACT PRODUCER — the single act this turn, of whichever kind
 * the player actually wrote.
 *
 * One scan, not two passes, because "first eligible sentence wins" is the law
 * both detectors already documented and two sequential passes would quietly
 * break it: a romantic second sentence would outrank an affectionate first one
 * purely because the romantic pass ran first. The scan walks the message in
 * written order and asks each sentence the romantic question before the
 * affectionate one — an ordering that only decides ties WITHIN one sentence,
 * where it cannot matter, since the two gates are mutually exclusive by
 * construction (the affectionate gate vetoes every admitted romantic verb).
 *
 * The two gates are applied PER SENTENCE rather than filtering the message
 * once, so a sentence that fails the romantic gate is still offered to the
 * affectionate one and vice versa. That is not a fallback: a sentence carrying
 * romantic framing is vetoed WHOLE by `contactSentenceEligible`, so a rejected
 * romantic line can never re-enter as an affectionate act. What it preserves is
 * the existing behavior of an ordinary affectionate message, byte for byte.
 */
export function detectChatContactAct(
  input: ChatContactDetectionInput & {
    readonly eventRef: ContactEventRef;
    /**
     * Whether a permission owner is available to answer a romantic attempt.
     *
     * DEFAULT FALSE, and the default is the whole point. A romantic act nobody
     * can authorize is not a quieter romantic act — it is an act this lane must
     * not author at all, because producing one still COSTS the turn its single
     * act slot. With no owner wired, a romantic sentence would win the slot,
     * resolve `permission_unresolved`, and take a later affectionate sentence's
     * committed contact down with it: the player writes two things, the second
     * of which used to land, and now neither does.
     *
     * So the romantic producer is gated on the owner's PRESENCE, which is what
     * makes `CHAT_ROMANTIC_PERMISSION=off` byte-identical to the lane before
     * this producer existed, rather than merely silent.
     */
    readonly romanticEnabled?: boolean;
  },
): ChatContactAct | null {
  // No eligibility filter here: `contactSentences` still refuses narrator input
  // and non-narration spans, but the two commit gates differ per kind and are
  // applied to each sentence below.
  for (const sentence of contactSentences(input, () => true)) {
    if (input.romanticEnabled === true && romanticCommitSentenceEligible(sentence)) {
      const romantic = romanticActInSentence(sentence, input);
      if (romantic !== null) return romantic;
    }
    if (contactCommitSentenceEligible(sentence)) {
      const affectionate = affectionateActInSentence(sentence, input);
      if (affectionate !== null) return affectionate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Release — the player taking their own hand back
// ---------------------------------------------------------------------------

/** The player ending contact. `targetSubject: null` ⇒ every hand they have on somebody. */
export interface ChatContactRelease {
  /** Whose contacts this ends, when the sentence named one. */
  readonly targetSubject: AffordanceSubjectId | null;
}

const RELEASE_HAND = "(?:my|the)\\s+(?:hand|hands|palm)";
/** Verbs that need a direction word after the hand: "pull my hand BACK". */
const RELEASE_MOVED_VERBS =
  "pull|pulls|pulled|pulling|draw|draws|drew|drawing|take|takes|took|taking|move|moves|moved|moving";
/** Verbs that already mean "off it" on their own: "I withdraw my hand". */
const RELEASE_LIFTED_VERBS =
  "lift|lifts|lifted|lifting|remove|removes|removed|removing|withdraw|withdraws|withdrew|withdrawing" +
  "|drop|drops|dropped|dropping";

const RELEASE_RES: readonly RegExp[] = [
  new RegExp(
    `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:${RELEASE_MOVED_VERBS})\\s+${RELEASE_HAND}\\s+(?:back|away|off)\\b`,
    "iu",
  ),
  // The lookahead is what keeps "I drop my hand onto your shoulder" out: those
  // verbs mean "off it" only when no destination follows, and a placement read as
  // a release would end a contact the sentence was busy making.
  new RegExp(
    `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:${RELEASE_LIFTED_VERBS})\\s+${RELEASE_HAND}\\b(?!\\s+(?:on|onto|against|over)\\b)`,
    "iu",
  ),
  new RegExp(`\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:let|lets|letting)\\s+go\\b`, "iu"),
];

/** "…of her hand", "…from Wren's shoulder", "…off the railing" — who or what was let go of. */
const RELEASE_OF_RE = new RegExp(`\\b(?:of|from|off(?:\\s+of)?)\\s+(?:the\\s+)?(${NAME_PHRASE})\\b`, "iu");

/**
 * The player's release this turn, or `null`.
 *
 * A NAMED target narrows the ends to that person; an unnamed one ("I pull my
 * hand back") ends every contact the player's hand is making. A target that is
 * named but does NOT resolve — "I let go of the railing", or an ambiguous "her"
 * in a group — produces no release at all rather than falling back to ending
 * everything: the sentence said which thing it let go of, and this layer is not
 * entitled to substitute a different one.
 */
export function detectChatContactRelease(input: ChatContactDetectionInput): ChatContactRelease | null {
  for (const sentence of endingSentences(input)) {
    if (!RELEASE_RES.some((pattern) => pattern.test(sentence))) continue;
    const owner = RELEASE_OF_RE.exec(sentence);
    if (owner === null) return { targetSubject: null };
    const resolved = resolveNamePhrasePrefix(owner[1] ?? "", false, input.characters);
    if (resolved === null) continue;
    return { targetSubject: resolved.member.subjectId };
  }
  return null;
}