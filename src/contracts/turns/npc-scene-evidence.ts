import { parseMessageSpansWithOffsets } from "@/lib/message-spans";
import {
  chatAffectionateTargetLocationOf,
  chatContactTargetNounAlternation,
  normalizeTypographicQuotes,
  CHAT_CONTACT_CONDITIONAL_RE,
  CHAT_CONTACT_NEGATION_RE,
  CHAT_CONTACT_RESTRAINT_RE,
  CHAT_CONTACT_ROMANTIC_TARGET_RE,
  CHAT_CONTACT_ROMANTIC_VERB_RE,
  CHAT_CONTACT_SENTENCE_SPLIT,
  CHAT_CONTACT_SOURCE_LOCATION,
  type ChatContactGesture,
} from "./chat-contact-vocabulary";
import {
  NPC_SCENE_PLAYER_REF,
  type NpcApproachCandidate,
  type NpcContactCandidate,
  type NpcContactStartCandidate,
  type NpcContactUpdateCandidate,
  type NpcDepartCandidate,
  type NpcMovementCandidate,
  type NpcRef,
  type NpcSceneDigest,
  type ParticipantRef,
} from "./npc-scene-decision";

/**
 * NPC reply-scene EVIDENCE ADMISSION
 * (romantic-contact-affordances.spec.actor-control.md §"Evidence admission" +
 * §"The fence").
 *
 * Every parsed candidate passes four gates IN ORDER, and a failure drops only
 * that candidate with a bounded reason — no gate repairs, substitutes, or
 * re-proposes anything:
 *
 * 1. **Grounded** — after the same curly-quote normalization the reply-side
 *    floor uses, the evidence quote occurs EXACTLY ONCE across the reply's
 *    narration spans. Dialogue, thought, OOC, comms, and styled spans never
 *    ground physical authority; zero or multiple occurrences fail closed. The
 *    gate returns absolute reply offsets.
 * 2. **Asserted** — the supporting sentence describes a COMPLETED action.
 *    Negation, hedges, modal/conditional/future/intent language, questions,
 *    commands, refusals, and incomplete clauses fail; contact starts/updates
 *    ADDITIONALLY fail on romantic/intimate framing or restraint. The shared
 *    veto regexes come from the chat-contact vocabulary — the same machinery
 *    the player detectors and the frozen ending floor read — plus third-person
 *    hedges the first-person lists cannot carry. The floor's own veto set is
 *    untouched.
 * 3. **Actor-attributed** — the action verb's grammatical subject is the
 *    proposed NPC. A name inside a possessive ("Mara's arm") never counts; a
 *    bare third-person pronoun counts only when exactly one NPC is eligible;
 *    assistant-narration `you`/`your` resolves only to `player`, so it can
 *    never attribute an act to an NPC.
 * 4. **Decision-congruent** — a bounded verifier PROVES every proposed field
 *    against a small CLOSED positive lexicon and returns the exact action
 *    phrase's offsets. Every congruence pattern is ANCHORED on the proposed
 *    actor's own subject tokens, so a quote in which somebody else performs
 *    the movement can never verify this actor's proposal. It answers only
 *    supported / unsupported (naming the failing field) / ambiguous.
 *
 * **The fence:** this module exports NO free-prose extractor. The verifiers
 * receive a proposal and check it; none of them can mint a movement, start, or
 * update the model did not propose, none can substitute a different field, and
 * the export surface is deliberately small so a test can pin that it stays
 * that way. The frozen floor (`chat-contact-reply.ts`) remains the only
 * free-prose extractor in the lane.
 */

// ---------------------------------------------------------------------------
// Outcome vocabulary
// ---------------------------------------------------------------------------

/**
 * The bounded drop reasons — exactly the spec's diagnostics vocabulary (the
 * wiring stage prefixes `npc_scene_decision.` when it records one).
 */
export const npcSceneEvidenceDropReasons = [
  "ref_invalid",
  "evidence_ungrounded",
  "evidence_ambiguous",
  "evidence_unasserted",
  "evidence_misattributed",
  "evidence_incongruent",
] as const;
export type NpcSceneEvidenceDropReason = (typeof npcSceneEvidenceDropReasons)[number];

export interface NpcSceneEvidenceDrop {
  readonly reason: NpcSceneEvidenceDropReason;
  /** `evidence_incongruent` only: the proposed field the quote failed to prove. */
  readonly field?: string;
}

/**
 * An absolute `[start, end)` range in the quote-normalized reply. The
 * normalization replaces one character with one character, so these offsets
 * index the raw persisted reply identically.
 */
export interface NpcSceneReplySpan {
  readonly start: number;
  readonly end: number;
}

export type NpcSceneCandidate = NpcMovementCandidate | NpcContactCandidate;

export type NpcSceneAdmission =
  | { readonly status: "admitted"; readonly quoteSpan: NpcSceneReplySpan; readonly actionSpan: NpcSceneReplySpan }
  | { readonly status: "dropped"; readonly drop: NpcSceneEvidenceDrop };

export interface NpcSceneEvidenceContext {
  /** The COMPLETED assistant reply, exactly as persisted. */
  readonly reply: string;
  readonly digest: NpcSceneDigest;
  /**
   * The post-settle ELIGIBLE actor set — who a bare third-person pronoun may
   * name. Deliberately an input rather than derived from the digest's
   * pre-settle presence: the authoritative presence cut is settlement's, and
   * this pure layer must not guess it.
   */
  readonly eligibleNpcRefs: readonly NpcRef[];
}

// ---------------------------------------------------------------------------
// Narration geometry
// ---------------------------------------------------------------------------

export interface NpcSceneNarrationSentence {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** The shared sentence boundary, global so segment offsets can be walked. Derived from the ONE split the whole lane uses. */
const SENTENCE_BOUNDARY_RE = new RegExp(CHAT_CONTACT_SENTENCE_SPLIT.source, "gu");

interface NarrationRegion {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Every narration span of the normalized reply, with absolute offsets. */
function narrationRegions(reply: string): readonly NarrationRegion[] {
  const normalized = normalizeTypographicQuotes(reply);
  return parseMessageSpansWithOffsets(normalized)
    .filter((span) => span.kind === "narration")
    .map((span) => ({ text: span.text, start: span.start, end: span.end }));
}

/**
 * The reply's narration SENTENCES with absolute offsets — the same spans and
 * the same boundary regex the detectors read by, just offset-preserving. This
 * is geometry, not extraction: it says where narration sentences sit, never
 * what they mean.
 */
export function npcSceneNarrationSentences(reply: string): readonly NpcSceneNarrationSentence[] {
  const sentences: NpcSceneNarrationSentence[] = [];
  for (const region of narrationRegions(reply)) {
    let cursor = 0;
    const segments: { readonly from: number; readonly to: number }[] = [];
    for (const boundary of region.text.matchAll(SENTENCE_BOUNDARY_RE)) {
      const at = boundary.index ?? 0;
      segments.push({ from: cursor, to: at });
      cursor = at + boundary[0].length;
    }
    segments.push({ from: cursor, to: region.text.length });
    for (const segment of segments) {
      const raw = region.text.slice(segment.from, segment.to);
      const text = raw.trim();
      if (text.length === 0) continue;
      const leading = raw.length - raw.trimStart().length;
      const start = region.start + segment.from + leading;
      sentences.push({ text, start, end: start + text.length });
    }
  }
  return sentences;
}

// ---------------------------------------------------------------------------
// Gate 1 — grounded
// ---------------------------------------------------------------------------

interface Grounding {
  readonly quote: string;
  readonly span: NpcSceneReplySpan;
  /** The narration sentences the quote overlaps — what the assertion gate vetoes over. */
  readonly sentences: readonly NpcSceneNarrationSentence[];
}

type GroundingResult =
  | { readonly status: "grounded"; readonly grounding: Grounding }
  | { readonly status: "dropped"; readonly drop: NpcSceneEvidenceDrop };

/**
 * Locate the quote: exactly once, in narration. Zero occurrences is
 * `evidence_ungrounded` (the model paraphrased or invented); two or more is
 * `evidence_ambiguous` (nobody can say WHICH occurrence carries the act).
 * Occurrences inside non-narration spans are invisible here on purpose —
 * dialogue about a touch is not a touch.
 */
export function groundNpcSceneEvidence(reply: string, evidence: string): GroundingResult {
  const quote = normalizeTypographicQuotes(evidence).trim();
  if (quote.length === 0) return { status: "dropped", drop: { reason: "evidence_ungrounded" } };
  const occurrences: number[] = [];
  for (const region of narrationRegions(reply)) {
    let at = region.text.indexOf(quote);
    while (at !== -1) {
      occurrences.push(region.start + at);
      at = region.text.indexOf(quote, at + 1);
    }
  }
  if (occurrences.length === 0) return { status: "dropped", drop: { reason: "evidence_ungrounded" } };
  if (occurrences.length > 1) return { status: "dropped", drop: { reason: "evidence_ambiguous" } };
  const start = occurrences[0] ?? 0;
  const span: NpcSceneReplySpan = { start, end: start + quote.length };
  const sentences = npcSceneNarrationSentences(reply).filter(
    (sentence) => sentence.start < span.end && span.start < sentence.end,
  );
  return { status: "grounded", grounding: { quote, span, sentences } };
}

// ---------------------------------------------------------------------------
// Gate 2 — asserted
// ---------------------------------------------------------------------------

/**
 * Third-person hedge/intent/future language the shared first-person lists
 * cannot carry ("she wants to", "will take", "considers resting", "reaches
 * for"). An EXTENSION of the shared machinery, never a replacement — and the
 * frozen floor's own `REPLY_HEDGE_RE` stays where it is, unchanged.
 */
const NPC_ASSERTION_HEDGE_RE =
  /\b(?:wants?\s+to|wanted\s+to|starts?\s+to|started\s+to|begins?\s+to|began\s+to|seems?\s+to|seemed\s+to|threatens?\s+to|threatened\s+to|makes?\s+to|made\s+to|itch(?:es|ed)?\s+to|will|shall|intends?\s+to|intended\s+to|plans?\s+to|planned\s+to|means?\s+to|meant\s+to|considers?|considered|considering|thinks?\s+about|thought\s+about|moves?\s+to\s+(?:take|pull|touch|rest|place|put|squeeze|pat|reach|close|step|brush)|moved\s+to\s+(?:take|pull|touch|rest|place|put|squeeze|pat|reach|close|step|brush)|reach(?:es|ed)?\s+(?:for|out\s+to)|starts?\s+toward)\b/iu;

/** Refusals: a described refusal is the opposite of a completed act. */
const NPC_ASSERTION_REFUSAL_RE = /\b(?:refus\w*|declin\w*)\b/iu;

/**
 * A narration sentence that OPENS on a bare imperative is a command, not a
 * completed act — a subjectless verb has nobody to attribute. Base forms only,
 * so "Stepping back, she smiles" (participle) and "She steps back" (inflected,
 * subject-first) never trip it.
 */
const NPC_ASSERTION_COMMAND_RE =
  /^\s*(?:please\s+)?(?:step|walk|move|come|go|stay|back|take|put|place|rest|set|lay|squeeze|pat|keep|let|stop)\b/iu;

/** A clause with no terminal punctuation, or trailing ellipsis/dash, is CUT OFF — a partial reply's half-action must never commit. */
function sentenceIsComplete(sentence: string): boolean {
  if (/(?:\.{3}|…)["')\]]*\s*$/u.test(sentence)) return false;
  if (/[—–-]\s*$/u.test(sentence)) return false;
  return /[.!?]["')\]]*\s*$/u.test(sentence);
}

/**
 * The assertion gate, over every narration sentence the quote overlaps —
 * SENTENCES rather than the bare quote, so a sub-clause quote ("takes your
 * hand") can never launder away its own sentence's "doesn't". Contact
 * starts/updates additionally take the romantic-framing and restraint vetoes;
 * movement does not (spec: those two are contact-specific).
 */
function assertionDrop(grounding: Grounding, contactFraming: boolean): NpcSceneEvidenceDrop | null {
  if (grounding.sentences.length === 0) return { reason: "evidence_unasserted" };
  for (const sentence of grounding.sentences) {
    if (sentence.text.includes("?")) return { reason: "evidence_unasserted" };
    if (CHAT_CONTACT_NEGATION_RE.test(sentence.text)) return { reason: "evidence_unasserted" };
    if (CHAT_CONTACT_CONDITIONAL_RE.test(sentence.text)) return { reason: "evidence_unasserted" };
    if (NPC_ASSERTION_HEDGE_RE.test(sentence.text)) return { reason: "evidence_unasserted" };
    if (NPC_ASSERTION_REFUSAL_RE.test(sentence.text)) return { reason: "evidence_unasserted" };
    if (NPC_ASSERTION_COMMAND_RE.test(sentence.text)) return { reason: "evidence_unasserted" };
    if (!sentenceIsComplete(sentence.text)) return { reason: "evidence_unasserted" };
    if (contactFraming) {
      if (CHAT_CONTACT_ROMANTIC_VERB_RE.test(sentence.text)) return { reason: "evidence_unasserted" };
      if (CHAT_CONTACT_ROMANTIC_TARGET_RE.test(sentence.text)) return { reason: "evidence_unasserted" };
      if (CHAT_CONTACT_RESTRAINT_RE.test(sentence.text)) return { reason: "evidence_unasserted" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Participant naming
// ---------------------------------------------------------------------------

function escapeRegex(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The first word of a display name, lowercased — how prose usually names her. */
function firstNameOf(name: string): string {
  return (name.trim().split(/\s+/u)[0] ?? "").toLowerCase();
}

/** Every written token that names one NPC: display name, aliases, first name. Lowercased, deduped. */
function npcNameTokens(digest: NpcSceneDigest, ref: NpcRef): readonly string[] {
  const npc = digest.npcs.find((row) => row.ref === ref);
  if (npc === undefined) return [];
  const tokens = new Set<string>();
  for (const raw of [npc.name, ...npc.aliases, firstNameOf(npc.name)]) {
    const token = raw.trim().toLowerCase();
    if (token.length > 0) tokens.add(token);
  }
  return [...tokens];
}

const THIRD_PERSON_TOKENS: ReadonlySet<string> = new Set(["she", "he", "they", "her", "him", "them", "his", "their"]);

/**
 * Who a written destination/owner token names, against the digest.
 *
 * - `you`/`your` is ALWAYS the player: assistant narration's second person has
 *   exactly one referent.
 * - a name or alias resolves when exactly one NPC answers to it; two answering
 *   is the ensemble ambiguity.
 * - a bare third-person pronoun resolves only when the digest holds exactly
 *   one NPC other than the actor — otherwise it names somebody the sentence
 *   has not identified.
 */
function resolveParticipantToken(
  digest: NpcSceneDigest,
  rawToken: string,
  actorRef: NpcRef,
): ParticipantRef | "ambiguous" | null {
  const token = rawToken.trim().replace(/['’]s$/iu, "").toLowerCase();
  if (token.length === 0) return null;
  if (token === "you" || token === "your") return NPC_SCENE_PLAYER_REF;
  const named = digest.npcs.filter((npc) => npcNameTokens(digest, npc.ref).includes(token));
  if (named.length === 1) return named[0]?.ref ?? null;
  if (named.length > 1) return "ambiguous";
  if (THIRD_PERSON_TOKENS.has(token)) {
    const others = digest.npcs.filter((npc) => npc.ref !== actorRef);
    if (others.length === 1) return others[0]?.ref ?? null;
    return others.length === 0 ? null : "ambiguous";
  }
  return null;
}

/** Up to two filler words between the subject and its verb ("rises and steps away") — the floor's own gap. */
const SUBJECT_GAP = "(?:[\\p{L}'’-]+\\s+){0,2}?";

/**
 * The subject alternation for one proposed actor: their own written names,
 * plus the bare third-person pronouns ONLY when the post-settle scene has
 * exactly one eligible NPC and it is this actor (the ensemble rule). `null`
 * when the actor has no writable name at all — nothing can attribute to them.
 */
function actorSubjectAlternation(context: NpcSceneEvidenceContext, actorRef: NpcRef): string | null {
  const tokens = [...npcNameTokens(context.digest, actorRef)];
  const soleEligible = context.eligibleNpcRefs.length === 1 && context.eligibleNpcRefs[0] === actorRef;
  if (soleEligible) tokens.push("she", "he", "they");
  if (tokens.length === 0) return null;
  return tokens
    .sort((left, right) => right.length - left.length || (left < right ? -1 : 1))
    .map(escapeRegex)
    .join("|");
}

/**
 * `<actor> <gap> <verb-alternation>` — the anchored subject-verb prefix every
 * congruence pattern opens with. The lookbehind is the possessive/word-edge
 * guard (`Mara's` never subjects; `Tamara` never matches `Mara`), and it keeps
 * the match's own offsets starting AT the subject, which is what the action
 * span reports.
 */
function subjectVerbPrefix(subjects: string, verbs: string): string {
  return `(?<=^|[^\\p{L}'’-])(?:${subjects})(?!['’]s)\\s+${SUBJECT_GAP}(?:${verbs})`;
}

// ---------------------------------------------------------------------------
// Gate 3 — actor-attributed
// ---------------------------------------------------------------------------

/** The verb stems each candidate kind may hang its actor on — the SAME closed lexicons gate 4 anchors with. */
const KIND_VERBS: Readonly<Record<"approach" | "depart" | "start" | "update", string>> = {
  approach:
    "steps?|stepped|stepping|walks?|walked|walking|moves?|moved|moving|cross|crosses|crossed|crossing|comes?|came|coming|slides?|slid|sliding|draws?|drew|drawing|leans?|leaned|leaning|edges?|edged|edging|shifts?|shifted|shifting|closes?|closed|closing",
  depart:
    "steps?|stepped|stepping|walks?|walked|walking|backs?|backed|backing|moves?|moved|moving|pulls?|pulled|pulling|draws?|drew|drawing|leans?|leaned|leaning|eases?|eased|easing|cross|crosses|crossed|crossing|puts?|putting|takes?|took|taking",
  start:
    "rests?|rested|resting|places?|placed|placing|puts?|putting|lays?|laid|laying|sets?|setting|settles?|settled|settling|pats?|patted|patting|squeezes?|squeezed|squeezing|takes?|took|taking",
  update:
    "squeezes?|squeezed|squeezing|pats?|patted|patting|stills?|stilled|stilling|relaxes?|relaxed|relaxing|gentles?|gentled|gentling|lets?|letting",
};

/**
 * Is the proposed NPC the grammatical SUBJECT of a kind-appropriate action
 * verb inside the quote? This is the attribution question alone — WHO acted;
 * gate 4 then proves WHAT they did. `you`/`your` never enters the alternation,
 * so second-person narration can only ever attribute to `player`.
 */
function attributionDrop(
  context: NpcSceneEvidenceContext,
  quote: string,
  actorRef: NpcRef,
  kind: keyof typeof KIND_VERBS,
): NpcSceneEvidenceDrop | null {
  const subjects = actorSubjectAlternation(context, actorRef);
  if (subjects === null) return { reason: "evidence_misattributed" };
  const re = new RegExp(`${subjectVerbPrefix(subjects, KIND_VERBS[kind])}\\b`, "iu");
  return re.test(quote) ? null : { reason: "evidence_misattributed" };
}

// ---------------------------------------------------------------------------
// Gate 4 — decision-congruent
// ---------------------------------------------------------------------------

type Verdict =
  | { readonly status: "supported"; readonly actionSpan: NpcSceneReplySpan }
  | { readonly status: "unsupported"; readonly field: string }
  | { readonly status: "ambiguous" };

interface ActionMatch {
  readonly from: number;
  readonly to: number;
}

/**
 * Merge matches that read the SAME clause (overlapping ranges), preferring the
 * longest — "steps away across the room" must be one `distant` movement, not a
 * `near` and a `distant` fighting. DISTINCT clauses stay distinct, which is
 * what makes two action clauses in one quote detectably ambiguous.
 */
function mergeOverlapping<T extends ActionMatch>(matches: readonly T[]): T[] {
  const sorted = [...matches].sort((left, right) => left.from - right.from || right.to - left.to);
  const merged: T[] = [];
  for (const match of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && match.from < last.to) continue;
    merged.push(match);
  }
  return merged;
}

/** A destination token that POSSESSES the next word names a thing, not a person ("her desk", "Wren's side"). */
function destinationIsPossessive(token: string, followedByWord: boolean): boolean {
  if (!followedByWord) return false;
  const lowered = token.trim().toLowerCase();
  return ["your", "her", "his", "their", "its"].includes(lowered) || /['’]s$/u.test(lowered);
}

const PERSON_TOKEN = "([\\p{L}][\\p{L}\\p{N}'’-]*)";

// --- approach ---------------------------------------------------------------

const APPROACH_ADJACENCY =
  "right\\s+next\\s+to|right\\s+beside|right\\s+up\\s+to|right\\s+up\\s+against|flush\\s+against|next\\s+to|beside|alongside|closer\\s+to|close\\s+to|up\\s+to|over\\s+to|towards|toward|to";
/** Only EXPLICIT physical adjacency proves `touching`; ordinary "beside" is `close`. */
const APPROACH_TOUCHING: ReadonlySet<string> = new Set([
  "right next to",
  "right beside",
  "right up to",
  "right up against",
  "flush against",
]);

/**
 * The bounded stretch between the movement verb and its destination. TEMPERED:
 * it may not cross clause punctuation OR another subject (a roster name,
 * `you`/`your`, or a bare subject pronoun), so "Mara steps back as you step
 * closer to Wren" can never let Mara's verb borrow your destination — while a
 * compound predicate of the SAME actor ("crosses the room and steps right
 * beside you") still reads as one movement.
 */
function approachWindow(digest: NpcSceneDigest): string {
  const names = digest.npcs.flatMap((npc) => npcNameTokens(digest, npc.ref)).map(escapeRegex);
  const blockers = ["you", "your", "she", "he", "they", ...names].join("|");
  return `(?:(?!\\b(?:${blockers})\\b)[^.?!;:,]){0,60}?`;
}

/** Independent forward/toward evidence — the ONLY thing that can prove `facing: toward`. */
const FACING_TOWARD_RE = /\b(?:turn(?:s|ed|ing)?\s+(?:to\s+face|towards?)|fac(?:es|ed|ing)|to\s+face)\b/iu;
/** Backing into place moves without turning; it can never prove facing. */
const BACKING_RE = /\b(?:back(?:s|ed|ing)?\s+(?:into|toward|towards|up)|backwards?)\b/iu;

function verifyApproach(
  context: NpcSceneEvidenceContext,
  grounding: Grounding,
  candidate: NpcApproachCandidate,
): Verdict {
  const subjects = actorSubjectAlternation(context, candidate.actorRef);
  if (subjects === null) return { status: "unsupported", field: "actorRef" };
  const re = new RegExp(
    `${subjectVerbPrefix(subjects, KIND_VERBS.approach)}\\b${approachWindow(context.digest)}\\b(${APPROACH_ADJACENCY})\\s+${PERSON_TOKEN}\\b(?=(\\s+[\\p{L}])?)`,
    "giu",
  );
  interface Found extends ActionMatch {
    readonly band: "touching" | "close";
    readonly counterpart: ParticipantRef | "ambiguous";
  }
  const found: Found[] = [];
  for (const match of grounding.quote.matchAll(re)) {
    const token = match[2] ?? "";
    if (destinationIsPossessive(token, (match[3] ?? "").length > 0)) continue;
    const counterpart = resolveParticipantToken(context.digest, token, candidate.actorRef);
    if (counterpart === null) continue;
    const at = match.index ?? 0;
    const adjacency = (match[1] ?? "").toLowerCase().replace(/\s+/gu, " ");
    found.push({
      from: at,
      to: at + match[0].length,
      band: APPROACH_TOUCHING.has(adjacency) ? "touching" : "close",
      counterpart,
    });
  }
  const matches = mergeOverlapping(found);
  const match = matches[0];
  if (match === undefined) return { status: "unsupported", field: "kind" };
  if (matches.length > 1) return { status: "ambiguous" };
  if (match.counterpart === "ambiguous") return { status: "ambiguous" };
  if (match.counterpart !== candidate.counterpartRef) return { status: "unsupported", field: "counterpartRef" };
  if (match.band !== candidate.band) return { status: "unsupported", field: "band" };
  if (candidate.facing === "toward") {
    if (BACKING_RE.test(grounding.quote) || !FACING_TOWARD_RE.test(grounding.quote)) {
      return { status: "unsupported", field: "facing" };
    }
  }
  return {
    status: "supported",
    actionSpan: { start: grounding.span.start + match.from, end: grounding.span.start + match.to },
  };
}

// --- depart -----------------------------------------------------------------

/**
 * The departure shapes, each anchored on the actor. Small repositions open
 * `near`; walking away or crossing the room opens `distant`. The direction
 * word must follow the verb IMMEDIATELY (the player-lane's hand-vs-body
 * ruling): "pulls her hand away" is the floor's withdraw, never a tier-2
 * whole-body departure.
 */
const DEPART_SHAPES: readonly { readonly pattern: string; readonly band: "near" | "distant" }[] = [
  {
    pattern: "(?:steps?|stepped|moves?|moved|walks?|walked|cross|crosses|crossed)\\s+(?:\\w+\\s+)?across\\s+the\\s+room\\b",
    band: "distant",
  },
  { pattern: "cross(?:es|ed)?\\s+the\\s+room\\b", band: "distant" },
  { pattern: "(?:walks?|walked)\\s+(?:away|back|off)\\b", band: "distant" },
  {
    pattern: "(?:steps?|stepped|backs?|backed|moves?|moved|pulls?|pulled|draws?|drew|leans?|leaned|eases?|eased)\\s+(?:away|back|off)\\b",
    band: "near",
  },
  { pattern: "(?:takes?|took)\\s+(?:a|one)\\s+step\\s+back\\b", band: "near" },
  { pattern: "(?:steps?|stepped|moves?|moved)\\s+out\\s+of\\s+reach\\b", band: "near" },
  { pattern: "puts?\\s+(?:some\\s+|a\\s+little\\s+|a\\s+bit\\s+of\\s+)?distance\\s+between\\b", band: "near" },
] as const;

const DEPART_FROM_RE = /\bfrom\s+(?:the\s+)?([\p{L}][\p{L}\p{N}'’-]*)\b(?=(\s+[\p{L}])?)/iu;

/**
 * Who an UNNAMED departure ("she steps back", no `from` clause) can be proven
 * to move away from. The congruence table demands the counterpart field be
 * PROVEN, and a bare movement names nobody — so it is provable only when the
 * scene leaves exactly one candidate:
 *
 * - the actor's live contacts first: a body easing away while a touch is held
 *   is leaving the body it touches (the composite-departure reading), whichever
 *   side of the contact the actor is on. One distinct other participant across
 *   all of them proves the counterpart; two distinct ones prove nothing.
 * - with no live contact, only a roster with exactly one OTHER participant —
 *   the ordinary 1-on-1 chat, where "away" has one possible referent — can
 *   prove it. An ensemble's unnamed departure stays ambiguous, which is the
 *   conservative miss this proof accepts everywhere else.
 */
function departCounterpartDeterminable(
  context: NpcSceneEvidenceContext,
  actorRef: NpcRef,
): ParticipantRef | "ambiguous" {
  const engaged = new Set<ParticipantRef>();
  for (const row of context.digest.contacts) {
    const parties = [row.actorRef, row.sourceRef, row.targetRef];
    if (!parties.includes(actorRef)) continue;
    for (const party of parties) {
      if (party !== actorRef) engaged.add(party);
    }
  }
  const [sole] = [...engaged];
  if (engaged.size === 1 && sole !== undefined) return sole;
  if (engaged.size > 1) return "ambiguous";
  const others: ParticipantRef[] = [
    NPC_SCENE_PLAYER_REF,
    ...context.digest.npcs.map((npc) => npc.ref).filter((ref) => ref !== actorRef),
  ];
  const [only] = others;
  return others.length === 1 && only !== undefined ? only : "ambiguous";
}

/**
 * A `from <X>` clause counts only when it belongs to the matched movement's own
 * clause: nothing but ordinary words may sit between the movement match and the
 * `from` — clause punctuation or another subject token (a roster name,
 * `you`/`your`, or a bare subject pronoun) cuts it off, so "Mara steps back as
 * you pull from Sabrina" can never lend Mara's movement somebody else's origin.
 * The same temper the approach window applies, pointed backwards.
 */
function departFromClause(
  context: NpcSceneEvidenceContext,
  quote: string,
  matchEnd: number,
): RegExpExecArray | null {
  const tail = quote.slice(matchEnd);
  const from = DEPART_FROM_RE.exec(tail);
  if (from === null) return null;
  const between = tail.slice(0, from.index);
  if (/[.?!;:,]/u.test(between)) return null;
  const names = context.digest.npcs.flatMap((npc) => npcNameTokens(context.digest, npc.ref)).map(escapeRegex);
  const blockers = new RegExp(`\\b(?:you|your|she|he|they|${names.join("|")})\\b`, "iu");
  if (blockers.test(between)) return null;
  return from;
}

function verifyDepart(context: NpcSceneEvidenceContext, grounding: Grounding, candidate: NpcDepartCandidate): Verdict {
  const subjects = actorSubjectAlternation(context, candidate.actorRef);
  if (subjects === null) return { status: "unsupported", field: "actorRef" };
  interface Found extends ActionMatch {
    readonly band: "near" | "distant";
  }
  const found: Found[] = [];
  for (const shape of DEPART_SHAPES) {
    const re = new RegExp(`(?<=^|[^\\p{L}'’-])(?:${subjects})(?!['’]s)\\s+${SUBJECT_GAP}${shape.pattern}`, "giu");
    for (const match of grounding.quote.matchAll(re)) {
      const at = match.index ?? 0;
      found.push({ from: at, to: at + match[0].length, band: shape.band });
    }
  }
  const merged = mergeOverlapping(found);
  const match = merged[0];
  if (match === undefined) return { status: "unsupported", field: "kind" };
  if (merged.length > 1) return { status: "ambiguous" };
  const from = departFromClause(context, grounding.quote, match.to);
  if (from !== null) {
    if (destinationIsPossessive(from[1] ?? "", (from[2] ?? "").length > 0)) {
      return { status: "unsupported", field: "counterpartRef" };
    }
    const named = resolveParticipantToken(context.digest, from[1] ?? "", candidate.actorRef);
    if (named === "ambiguous") return { status: "ambiguous" };
    if (named === null || named !== candidate.counterpartRef) {
      return { status: "unsupported", field: "counterpartRef" };
    }
  } else {
    // No origin named: the counterpart field still has to be PROVEN, not
    // presumed — only a uniquely determinable referent admits.
    const determinable = departCounterpartDeterminable(context, candidate.actorRef);
    if (determinable === "ambiguous") return { status: "ambiguous" };
    if (determinable !== candidate.counterpartRef) return { status: "unsupported", field: "counterpartRef" };
  }
  if (match.band !== candidate.band) return { status: "unsupported", field: "band" };
  return {
    status: "supported",
    actionSpan: { start: grounding.span.start + match.from, end: grounding.span.start + match.to },
  };
}

// --- start ------------------------------------------------------------------

const OWNER_TOKEN = "(your|her|his|their|[\\p{L}][\\p{L}\\p{N}'’-]*['’]s)";

/**
 * The contact-creation shapes, anchored on the actor. Completed forms only —
 * "reaches for", "moves to take", "will rest" all died in the assertion gate,
 * and nothing here can revive language that merely CONSIDERS contact.
 *
 * "takes your hand" is included because the spec's own worked example ("She
 * steps closer, then takes your hand.") requires it; it lands as the `rest`
 * gesture, a light hold being the smallest claim the sentence makes.
 */
const START_SHAPES: readonly string[] = [
  `(rests?|rested|resting|places?|placed|placing|puts?|putting|lays?|laid|laying|sets?|setting|settles?|settled|settling)\\s+(?:her|his|their|a|one|the)\\s+(?:hand|hands|palm)\\s+(?:on|onto|against|over|to)\\s+${OWNER_TOKEN}\\s+(${chatContactTargetNounAlternation})\\b`,
  `(pats?|patted|patting|squeezes?|squeezed|squeezing)\\s+${OWNER_TOKEN}\\s+(${chatContactTargetNounAlternation})\\b`,
  `(takes?|took)\\s+${OWNER_TOKEN}\\s+(hands?)\\b`,
] as const;

function contactGestureOf(verb: string): ChatContactGesture {
  const stem = verb.toLowerCase();
  if (stem.startsWith("pat")) return "pat";
  if (stem.startsWith("squeez")) return "squeeze";
  return "rest";
}

interface ContactEvidenceMatch extends ActionMatch {
  readonly gesture: ChatContactGesture;
  readonly owner: ParticipantRef | "ambiguous" | null;
  readonly locationId: string | null;
}

function collectContactMatches(
  context: NpcSceneEvidenceContext,
  grounding: Grounding,
  actorRef: NpcRef,
  subjects: string,
  shapes: readonly string[],
): ContactEvidenceMatch[] {
  const found: ContactEvidenceMatch[] = [];
  for (const shape of shapes) {
    const re = new RegExp(`(?<=^|[^\\p{L}'’-])(?:${subjects})(?!['’]s)\\s+${SUBJECT_GAP}${shape}`, "giu");
    for (const match of grounding.quote.matchAll(re)) {
      const at = match.index ?? 0;
      found.push({
        from: at,
        to: at + match[0].length,
        gesture: contactGestureOf(match[1] ?? ""),
        owner: resolveParticipantToken(context.digest, match[2] ?? "", actorRef),
        locationId: chatAffectionateTargetLocationOf(match[3] ?? "") ?? null,
      });
    }
  }
  return mergeOverlapping(found);
}

function verifyStart(
  context: NpcSceneEvidenceContext,
  grounding: Grounding,
  candidate: NpcContactStartCandidate,
): Verdict {
  const subjects = actorSubjectAlternation(context, candidate.actorRef);
  if (subjects === null) return { status: "unsupported", field: "actorRef" };
  const matches = collectContactMatches(context, grounding, candidate.actorRef, subjects, START_SHAPES);
  const match = matches[0];
  if (match === undefined) return { status: "unsupported", field: "kind" };
  if (matches.length > 1) return { status: "ambiguous" };
  if (match.owner === "ambiguous") return { status: "ambiguous" };
  if (match.owner === null || match.owner !== candidate.targetRef) return { status: "unsupported", field: "targetRef" };
  if (match.gesture !== candidate.gesture) return { status: "unsupported", field: "gesture" };
  if (match.locationId === null || match.locationId !== candidate.targetLocationId) {
    return { status: "unsupported", field: "targetLocationId" };
  }
  return {
    status: "supported",
    actionSpan: { start: grounding.span.start + match.from, end: grounding.span.start + match.to },
  };
}

// --- update -----------------------------------------------------------------

/** Gesture modulation with the touched surface named: "squeezes your hand", "pats her shoulder". */
const UPDATE_SURFACE_SHAPE = `(squeezes?|squeezed|squeezing|pats?|patted|patting)\\s+${OWNER_TOKEN}\\s+(${chatContactTargetNounAlternation})\\b`;
/** Gesture modulation on the actor's OWN hand — resolvable only when the actor has exactly one live contact. */
const UPDATE_OWN_HAND_SHAPE =
  "(stills?|stilled|relaxes?|relaxed|gentles?|gentled)\\s+(?:her|his|their)\\s+(?:hand|palm|grip)\\b|(?:lets?)\\s+(?:her|his|their)\\s+(?:hand|palm)\\s+rest\\b";

function verifyUpdate(
  context: NpcSceneEvidenceContext,
  grounding: Grounding,
  candidate: NpcContactUpdateCandidate,
): Verdict {
  const subjects = actorSubjectAlternation(context, candidate.actorRef);
  if (subjects === null) return { status: "unsupported", field: "actorRef" };
  const surfaceMatches = collectContactMatches(context, grounding, candidate.actorRef, subjects, [
    UPDATE_SURFACE_SHAPE,
  ]);
  const ownHandRe = new RegExp(
    `(?<=^|[^\\p{L}'’-])(?:${subjects})(?!['’]s)\\s+${SUBJECT_GAP}(?:${UPDATE_OWN_HAND_SHAPE})`,
    "giu",
  );
  interface Found extends ContactEvidenceMatch {
    readonly bare: boolean;
  }
  const found: Found[] = surfaceMatches.map((match) => ({ ...match, bare: false }));
  for (const match of grounding.quote.matchAll(ownHandRe)) {
    const at = match.index ?? 0;
    found.push({ from: at, to: at + match[0].length, gesture: "rest", owner: null, locationId: null, bare: true });
  }
  const merged = mergeOverlapping(found);
  const match = merged[0];
  if (match === undefined) return { status: "unsupported", field: "kind" };
  if (merged.length > 1) return { status: "ambiguous" };
  if (match.gesture !== candidate.gesture) return { status: "unsupported", field: "gesture" };
  const actorContacts = context.digest.contacts.filter((row) => row.actorRef === candidate.actorRef);
  if (match.bare) {
    // No surface named: the modulation is provable only when the actor has
    // exactly one live contact for it to be about.
    if (actorContacts.length > 1) return { status: "ambiguous" };
    if (actorContacts[0]?.ref !== candidate.contactRef) return { status: "unsupported", field: "contactRef" };
  } else {
    if (match.owner === "ambiguous") return { status: "ambiguous" };
    const compatible = actorContacts.filter(
      (row) => row.targetRef === match.owner && row.targetLocationId === match.locationId,
    );
    // Two live contacts answering to one written surface is the "quote
    // supporting two contacts" ambiguity; zero, or the wrong one, means the
    // quote does not support the exact contact behind this ref.
    if (compatible.length > 1) return { status: "ambiguous" };
    if (compatible[0]?.ref !== candidate.contactRef) return { status: "unsupported", field: "contactRef" };
  }
  return {
    status: "supported",
    actionSpan: { start: grounding.span.start + match.from, end: grounding.span.start + match.to },
  };
}

// ---------------------------------------------------------------------------
// Gate 0 — refs cohere with the digest
// ---------------------------------------------------------------------------

/** The only action kind tier-2 contact proposals may touch (the adapter's own literal). */
const NPC_SCENE_CONTACT_ACTION_KIND = "affectionate";

function refDrop(digest: NpcSceneDigest, candidate: NpcSceneCandidate): NpcSceneEvidenceDrop | null {
  const npcRefs = new Set<string>(digest.npcs.map((npc) => npc.ref));
  const participantRefs = new Set<string>([NPC_SCENE_PLAYER_REF, ...npcRefs]);
  if (!npcRefs.has(candidate.actorRef)) return { reason: "ref_invalid" };
  switch (candidate.kind) {
    case "approach":
    case "depart":
      if (!participantRefs.has(candidate.counterpartRef)) return { reason: "ref_invalid" };
      if (candidate.counterpartRef === candidate.actorRef) return { reason: "ref_invalid" };
      return null;
    case "start":
      if (!participantRefs.has(candidate.targetRef)) return { reason: "ref_invalid" };
      if (candidate.targetRef === candidate.actorRef) return { reason: "ref_invalid" };
      return null;
    case "update": {
      const contact = digest.contacts.find((row) => row.ref === candidate.contactRef);
      // The ref must denote a contact this candidate could LAWFULLY modulate:
      // the candidate NPC's own affectionate hand contact. Anything else is a
      // reference this schema never granted this actor.
      if (contact === undefined) return { reason: "ref_invalid" };
      if (contact.actorRef !== candidate.actorRef) return { reason: "ref_invalid" };
      if (contact.sourceRef !== candidate.actorRef) return { reason: "ref_invalid" };
      if (contact.sourceLocationId !== CHAT_CONTACT_SOURCE_LOCATION) return { reason: "ref_invalid" };
      if (contact.actionKind !== NPC_SCENE_CONTACT_ACTION_KIND) return { reason: "ref_invalid" };
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// The admission driver
// ---------------------------------------------------------------------------

/**
 * Run one candidate through all four gates, in order. Pure and total: same
 * reply + digest + candidate ⇒ same admission, and every failure is a bounded
 * drop — never an exception, never a repaired candidate.
 */
export function admitNpcSceneCandidate(
  context: NpcSceneEvidenceContext,
  candidate: NpcSceneCandidate,
): NpcSceneAdmission {
  const invalidRef = refDrop(context.digest, candidate);
  if (invalidRef !== null) return { status: "dropped", drop: invalidRef };

  const grounded = groundNpcSceneEvidence(context.reply, candidate.evidence);
  if (grounded.status === "dropped") return grounded;
  const { grounding } = grounded;

  const contactFraming = candidate.kind === "start" || candidate.kind === "update";
  const unasserted = assertionDrop(grounding, contactFraming);
  if (unasserted !== null) return { status: "dropped", drop: unasserted };

  const misattributed = attributionDrop(context, grounding.quote, candidate.actorRef, candidate.kind);
  if (misattributed !== null) return { status: "dropped", drop: misattributed };

  let verdict: Verdict;
  switch (candidate.kind) {
    case "approach":
      verdict = verifyApproach(context, grounding, candidate);
      break;
    case "depart":
      verdict = verifyDepart(context, grounding, candidate);
      break;
    case "start":
      verdict = verifyStart(context, grounding, candidate);
      break;
    case "update":
      verdict = verifyUpdate(context, grounding, candidate);
      break;
  }
  switch (verdict.status) {
    case "supported":
      return { status: "admitted", quoteSpan: grounding.span, actionSpan: verdict.actionSpan };
    case "ambiguous":
      return { status: "dropped", drop: { reason: "evidence_ambiguous" } };
    case "unsupported":
      return { status: "dropped", drop: { reason: "evidence_incongruent", field: verdict.field } };
  }
}
