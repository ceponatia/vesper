import {
  contactEventRef,
  contactParticipantIds,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type ContactEndReason,
  type ContactEventRef,
  type DiagnosticSink,
  type SceneState,
} from "@/contracts";
import { parseMessageSpans } from "@/lib/message-spans";
import { contactSentenceEligible, endCoveredContacts, type ChatContactEnds } from "./chat-contact-adapter";

/**
 * THE REPLY-SIDE NPC CONTACT ENDING — the minimal actor-control deliverable.
 *
 * The trial's third bounded gap: when the NPC's own generated prose plainly ends
 * a contact ("She eases out from beneath your hand"), the projection kept
 * holding it until a PLAYER release, departure, skip, or scene change ended it —
 * so a later guidance line could claim a touch she had already shrugged off.
 * This module reads the COMPLETED assistant reply, after the exchange has
 * settled, and aligns the projection with the one thing the prose explicitly
 * did: end an existing contact.
 *
 * ## What it may do, and everything it may not
 *
 * It may only END contacts, and only contacts involving the one NPC the sentence
 * unambiguously names. It never starts a contact, moves the player, invents
 * proximity or facing, infers a pose, alters clothing, reinterprets a romantic
 * beat, or manufactures an NPC action the prose did not clearly state. It writes
 * no scene fact at all beyond the ended contacts — in particular it does NOT
 * assert a new proximity band for a departure, because no authoritative movement
 * design supports that claim yet; the distance simply stays whatever the scene
 * last said. This is deliberately not a general model-output physical-state
 * extractor, and the allow-list below is the fence that keeps it from becoming
 * one.
 *
 * ## Detection is conservative, whole-sentence, narration-only
 *
 * Ordinary narration sentences of the reply only — quoted dialogue ("Don't pull
 * away"), thoughts, OOC, comms, and styled spans produce nothing, and curly
 * quotes are normalized first so typographic dialogue is excluded the same as
 * straight-quoted. Every sentence then passes the shared contact gates
 * (`contactSentenceEligible`): a negation ("She doesn't pull away"), a hedge or
 * hypothetical ("She might pull away"), a question, or romantic framing vetoes
 * the whole sentence. The restraint veto is deliberately NOT applied, for the
 * player-release precedent's reason: an end starts nothing, and "she pushes your
 * hand away" is a plain way to say one.
 *
 * The subject must resolve: a name or alias always does; a bare pronoun resolves
 * only when exactly one NPC is present, because in an ensemble it names somebody
 * the sentence has not identified. An ambiguous subject is silence.
 *
 * ## Persistence identity (the ordering invariant)
 *
 * The ends are durable rows under a REPLY-SIDE event ref derived from the
 * assistant message id (`chatReplyContactEventRef` — the `contact-reply:`
 * namespace, disjoint from the player leg's `contact:` refs even on beat
 * exchanges where the guard IS the assistant row), guarded by the assistant row
 * itself. That buys, in order: player events and NPC endings cannot collide on
 * (chatId, eventRef, sequence); deleting the reply cascades its ending rows
 * (the guard column's FK); a regenerate prunes them explicitly beside the
 * exchange-guard prune, so a discarded take's endings go with its projection;
 * replaying the identical reply re-derives identical keys and lands nowhere;
 * and a conflicting record under those keys is verified and fails closed —
 * `appendChatContactEventsWithScene` writes the rows and the scene projection
 * in ONE transaction, so the projection advances only with its verified end row.
 *
 * **Ordering invariant (the pipeline's settle):** this producer runs LAST —
 * after `finalizeChatState` has persisted the settled scenario (whose
 * `saveChatScenario` re-writes `character_chats.scene` with the pre-ending
 * projection) and after the ensemble member settle and garment reconcile (whose
 * own `saveChatScenario` re-writes it again from a fresh load). Nothing after
 * this producer writes the scene column, so the NPC-ended projection cannot be
 * overwritten by a settle step that folded the pre-ending scene.
 */

/** One present roster character, as the reply-side detector needs them. */
export interface ChatNpcEndingCharacter {
  readonly subjectId: AffordanceSubjectId;
  readonly name: string;
  readonly aliases: readonly string[];
}

/** The reasons the reply-side producer may record. Ending only — never a start. */
export type ChatNpcEndingReason = Extract<ContactEndReason, "withdrawn" | "separated">;

/** One NPC-authored ending, as detected from the completed reply. */
export interface ChatNpcContactEnding {
  /** The NPC whose prose ended the contact — the only body whose contacts end. */
  readonly subjectId: AffordanceSubjectId;
  /**
   * `withdrawn` for a surface-scale withdrawal (easing out from under the hand,
   * removing the player's hand), `separated` for a stated whole-body departure
   * (stepping or walking away). Ending is the entire claim either way.
   */
  readonly reason: ChatNpcEndingReason;
}

/**
 * The reply-side event ref for one assistant message's NPC endings.
 *
 * The `contact-reply:` namespace is what keeps it disjoint from the player
 * leg's `contact:<guard>` refs in EVERY exchange shape — including an
 * opening/continue beat, where the exchange guard and the assistant row are the
 * same id and a shared namespace would collide the two legs' sequence spaces.
 */
export function chatReplyContactEventRef(assistantMessageId: string): ContactEventRef {
  return contactEventRef(`contact-reply:${assistantMessageId}`);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Sentence boundaries — the same split the player-side detectors read by. */
const REPLY_SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/u;

/**
 * Typographic quotes → straight, BEFORE span parsing. Model prose regularly
 * dialogues in curly quotes, and the span parser only treats straight `"` as
 * speech — unnormalized, a curly-quoted "Don't pull away" would read as
 * narration and reach the detector as if the narrator had stated it.
 */
function normalizeQuotes(text: string): string {
  return text.replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

/** Up to two filler words between the subject and its verb ("rises and steps away"). */
const SUBJECT_GAP = "(?:[\\p{L}'’-]+\\s+){0,2}?";

/**
 * Third-person hedges the shared gate's first-person list does not carry.
 *
 * `contactSentenceEligible` vetoes "want to" and "trying to" because player
 * lines are first-person; NPC prose conjugates — "she wants to pull away",
 * "she starts to pull back" — and an intention is not an act on this side any
 * more than on that one.
 */
const REPLY_HEDGE_RE =
  /\b(?:wants?\s+to|wanted\s+to|starts?\s+to|started\s+to|begins?\s+to|began\s+to|seems?\s+to|seemed\s+to|threatens?\s+to|threatened\s+to|makes?\s+to|made\s+to|moves?\s+to\s+pull|itch(?:es)?\s+to)\b/iu;

/**
 * Surface-scale withdrawal, subjectless — the subject alternation is prepended
 * per roster. Three shapes, each an explicit ending and nothing else:
 *
 * - the body easing back off the touch: "pulls away", "draws back";
 * - easing out from under the hand: "shrugs/eases/slips/twists/ducks out from
 *   under|beneath your hand";
 * - handling the player's hand off: "lifts/removes/takes/pushes/guides/moves/
 *   sets/brushes your hand away|off|aside|down|from …" (one adverb allowed —
 *   "lifts your hand gently away"), plus the bare "removes your hand", whose
 *   verb is the removal.
 */
const WITHDRAW_PATTERNS: readonly string[] = [
  `(?:pulls?|pulled|draws?|drew|eases?|eased|leans?|leaned)\\s+(?:away|back)\\b`,
  `(?:eases?|eased|slips?|slipped|shrugs?|shrugged|twists?|twisted|ducks?|ducked|shifts?|shifted|pulls?|pulled|draws?|drew)\\s+` +
    `(?:\\w+\\s+){0,2}?(?:out|free)\\s+from\\s+(?:under|beneath|below)\\s+(?:your|the)\\s+(?:hand|palm|touch|grip)\\b`,
  `(?:lifts?|lifted|removes?|removed|takes?|took|push(?:es)?|pushed|guides?|guided|moves?|moved|sets?|brush(?:es)?|brushed)\\s+` +
    `your\\s+hand\\s+(?:\\w+\\s+)?(?:away|off|aside|down|from)\\b`,
  `(?:removes?|removed)\\s+your\\s+hand\\b`,
] as const;

/**
 * Whole-body departure, subjectless. Step/walk/back verbs only — the movements
 * whose written meaning is the body going somewhere else. "moves away" rides
 * here too: a body that moved away is separated, not a hand taken back.
 */
const SEPARATE_PATTERNS: readonly string[] = [
  `(?:steps?|stepped|walks?|walked|backs?|backed|moves?|moved)\\s+(?:\\w+\\s+)?(?:away|back|off)\\b`,
  `(?:steps?|stepped|moves?|moved)\\s+out\\s+of\\s+reach\\b`,
] as const;

/** A candidate subject token → the roster member it names, or `null`. */
function resolveEndingSubject(
  token: string,
  characters: readonly ChatNpcEndingCharacter[],
): ChatNpcEndingCharacter | null {
  const lowered = token.trim().toLowerCase();
  if (lowered.length === 0) return null;
  // A bare third-person pronoun resolves only when exactly ONE character is
  // present — in an ensemble it names somebody the sentence has not identified,
  // and picking one would be this layer choosing whose contact ended.
  if (lowered === "she" || lowered === "he" || lowered === "they") {
    const sole = characters.length === 1 ? characters[0] : undefined;
    return sole ?? null;
  }
  const named = characters.filter(
    (member) =>
      member.name.trim().toLowerCase() === lowered ||
      member.aliases.some((alias) => alias.trim().toLowerCase() === lowered) ||
      firstNameOf(member.name) === lowered,
  );
  // Two members answering to one token is the ensemble ambiguity case: silence.
  const sole = named.length === 1 ? named[0] : undefined;
  return sole ?? null;
}

/** The first word of a display name, lowercased — how prose usually names her. */
function firstNameOf(name: string): string {
  return (name.trim().split(/\s+/u)[0] ?? "").toLowerCase();
}

/** `Wren` / `she` / `Sabrina` — every token the subject scan should try. */
function subjectAlternation(characters: readonly ChatNpcEndingCharacter[]): string {
  const tokens = new Set<string>(["she", "he", "they"]);
  for (const member of characters) {
    for (const raw of [member.name, ...member.aliases, firstNameOf(member.name)]) {
      const token = raw.trim();
      if (token.length > 0) tokens.add(token.toLowerCase());
    }
  }
  return [...tokens]
    .sort((left, right) => right.length - left.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
}

/**
 * The ONE NPC-authored ending this reply states, or `null`.
 *
 * First eligible match wins, and one ending is the minimal pass's whole
 * vocabulary — a reply that withdraws twice has still withdrawn. The classifier
 * tries `separated` first only within a sentence's own match order; across the
 * reply, sentence order decides.
 */
/** The per-reason ending regexes for one roster — subject alternation prepended. */
function endingPatterns(characters: readonly ChatNpcEndingCharacter[]): {
  readonly withdrawn: readonly RegExp[];
  readonly separated: readonly RegExp[];
} {
  const subjects = subjectAlternation(characters);
  const compile = (patterns: readonly string[]): readonly RegExp[] =>
    patterns.map((pattern) => new RegExp(`\\b(${subjects})\\s+${SUBJECT_GAP}${pattern}`, "iu"));
  return { withdrawn: compile(WITHDRAW_PATTERNS), separated: compile(SEPARATE_PATTERNS) };
}

/**
 * WHERE one sentence states the given ending: the matched phrase's offsets
 * within that sentence, subject token included, or `null` when the sentence
 * does not state it.
 *
 * The chronology planner orders every action by its exact source phrase, and
 * the floor's result gains source offsets for ordering without its language
 * growing — so this runs the SAME compiled patterns detection runs, on a
 * sentence detection already matched, and reports the match range instead of
 * the verdict. Offsets are relative to
 * the sentence string handed in; quote normalization is one-to-one on length,
 * so they hold against the raw sentence too.
 */
export function chatNpcEndingPhraseInSentence(input: {
  readonly sentence: string;
  readonly characters: readonly ChatNpcEndingCharacter[];
  readonly reason: ChatNpcEndingReason;
}): { readonly from: number; readonly to: number } | null {
  const text = normalizeQuotes(input.sentence);
  const patterns = endingPatterns(input.characters)[input.reason];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    if (resolveEndingSubject(match[1] ?? "", input.characters) === null) continue;
    return { from: match.index, to: match.index + match[0].length };
  }
  return null;
}

export function detectChatNpcContactEnding(input: {
  /** The COMPLETED assistant reply, exactly as persisted. */
  readonly reply: string;
  /** PRESENT roster members only — an away character has no body in the room. */
  readonly characters: readonly ChatNpcEndingCharacter[];
}): ChatNpcContactEnding | null {
  if (input.characters.length === 0) return null;
  const text = normalizeQuotes(input.reply).trim();
  if (text.length === 0) return null;

  const { withdrawn: withdraw, separated: separate } = endingPatterns(input.characters);

  for (const span of parseMessageSpans(text)) {
    // Narration only: dialogue ("Don't pull away"), thoughts, comms, OOC, and
    // styled spans are not the narrator stating that a body moved.
    if (span.kind !== "narration") continue;
    for (const sentence of span.text.split(REPLY_SENTENCE_SPLIT)) {
      if (sentence.trim().length === 0) continue;
      if (!contactSentenceEligible(sentence) || REPLY_HEDGE_RE.test(sentence)) continue;
      // Separation is checked first WITHIN a sentence: "she steps away" also
      // contains no withdraw shape, but a sentence that says both moved a body.
      for (const [patterns, reason] of [
        [separate, "separated"],
        [withdraw, "withdrawn"],
      ] as const) {
        for (const pattern of patterns) {
          const match = pattern.exec(sentence);
          if (match === null) continue;
          const subject = resolveEndingSubject(match[1] ?? "", input.characters);
          if (subject === null) continue;
          return { subjectId: subject.subjectId, reason };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/**
 * Apply one NPC-authored ending to the settled scene: every active contact that
 * NPC participates in ends with the detected reason, and nothing else changes.
 *
 * Ends only — the shared `endCoveredContacts` body, so the core's stale-end law
 * still applies per contact. Zero covered contacts is an ordinary answer
 * (the prose eased away from a touch the projection never held), and the caller
 * writes nothing for it.
 */
export function applyChatNpcContactEnding(input: {
  readonly scene: SceneState;
  readonly ending: ChatNpcContactEnding;
  readonly eventRef: ContactEventRef;
  readonly storyTime: AffordanceStoryTime;
  readonly sink?: DiagnosticSink;
}): ChatContactEnds {
  return endCoveredContacts({
    scene: input.scene,
    reason: input.ending.reason,
    eventRef: input.eventRef,
    storyTime: input.storyTime,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
    covers: (contact) => contactParticipantIds(contact.source, contact.target).includes(input.ending.subjectId),
  });
}
