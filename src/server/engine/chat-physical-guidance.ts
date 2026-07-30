import {
  affordanceEvidence,
  affordanceSubjectId,
  buildConstraintCandidates,
  compileNarratorPhysicalGuidance,
  emptyNarratorPhysicalGuidance,
  guidanceFingerprint,
  guidanceUnorderedPart,
  hairArrangementClaimCode,
  hairCauseClaimCode,
  hairClaimMappings,
  hairClaimMatches,
  hairCommittedRestraint,
  hairWetnessBandRank,
  hairWetnessClaimCode,
  hairWetnessClaimScale,
  HAIR_COVERED_GATE,
  HAIR_DOMAIN_ID,
  HAIR_LOCATION_ID,
  type AffordanceEvidence,
  type AffordanceEvidenceKind,
  type AffordancePerceptionView,
  type AffordanceRead,
  type DiagnosticSink,
  type HairClaimArea,
  type HairClaimMatch,
  type NarratorPhysicalGuidance,
  type PhysicalNarrationConstraint,
  type PhysicalPremiseCorrection,
} from "@/contracts";
import { parseMessageSpans, type MessageSpanKind } from "@/lib/message-spans";
import type { ChatCommittedHairState } from "./chat-affordances";

/**
 * The CHAT LANE's narrator-physical-guidance adapter
 * (narrator-physical-guidance.plan.md slice 2; as-built detail in
 * narrator-physical-guidance.spec.md §"Slice 2").
 *
 * Two jobs, both deterministic and both pure:
 *
 * 1. **Premise detection** — decide whether this turn's player message asserts a
 *    physical claim that committed state contradicts or cannot support. No model
 *    call and no claim-extraction leg: the input-mode parse the lane already runs,
 *    plus the hair domain's own phrase lexicon.
 * 2. **Compilation** — hand this cut's domain constraints and the turn's corrections
 *    to the lane-neutral compiler, which gates, orders, and budgets them.
 *
 * ## Conservative by construction
 *
 * Every rule below is written so the DEFAULT is silence and a correction has to be
 * earned. That is not politeness: a false correction is worse than none, because the
 * narrator then fences off something that is actually true and the player watches
 * their own scene get contradicted. Roughly in order of how much each rule discards:
 *
 * - storyteller narration is never a premise (plan §Architecture 3 — an authoritative
 *   state change has no pre-narrator commit seam yet, so it is excluded outright);
 * - only ordinary speech and unmarked narration are eligible spans; thought, OOC,
 *   comms, written, and styled spans are not assertions about this body;
 * - a sentence must name whose hair it is, and a third-person pronoun counts only
 *   when nobody else in the sentence could own it;
 * - a question, a hypothetical, a simile, or a negation before the phrase silences
 *   that sentence;
 * - a degree claim must be at least two bands from the committed one;
 * - `unsupported` requires the owner to be genuinely unreadable. An owner that
 *   answered "I cannot say which" (an unidentified style, an unrecorded cause) yields
 *   silence — it is not evidence that the player is wrong.
 *
 * ## Why nothing is persisted
 *
 * Every input is either the committed cut or this turn's message text, and a retake
 * restores both through the rollback anchors that already exist (plan §"State and
 * retakes"). The same take therefore reproduces the same corrections and the same
 * fingerprints for free; a `physical_guidance` state row would only add a way for the
 * stored answer and the recomputed one to disagree.
 */

// ---------------------------------------------------------------------------
// Input authority
// ---------------------------------------------------------------------------

/**
 * Which span kinds carry an ordinary physical assertion, and which correction source
 * each becomes (plan §Architecture 3's table).
 *
 * Exhaustive over `MessageSpanKind` on purpose: a new channel has to be classified
 * here deliberately rather than inheriting eligibility by default.
 */
function spanSource(kind: MessageSpanKind): PhysicalPremiseCorrection["source"] | null {
  switch (kind) {
    case "speech":
      return "player_dialogue";
    case "narration":
      return "ordinary_player_narration";
    // A thought is not perceived and writes no state; OOC is direction to the
    // storyteller rather than evidence; comms and written text are about elsewhere;
    // styled is emphasis with no semantics.
    case "thought":
    case "ooc":
    case "comms":
    case "written":
    case "styled":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Text gates
// ---------------------------------------------------------------------------

/** Sentence boundaries: terminal punctuation (kept, so `?` stays visible) or a line break. */
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/u;

/** A phrase to look for, and whether it may begin inside a word (`n't`). */
interface TextMarker {
  readonly text: string;
  readonly suffix?: boolean;
}

/**
 * Markers that put a whole sentence out of reach. A hypothetical, a wish, or a simile
 * is not an assertion about the committed world, and `as if` / `like a` are the two
 * simile openers that most often carry a physical image. Erring wide here costs only
 * silence.
 */
const HYPOTHETICAL_MARKERS: readonly TextMarker[] = [
  { text: "if" },
  { text: "would" },
  { text: "could" },
  { text: "should" },
  { text: "might" },
  { text: "maybe" },
  { text: "perhaps" },
  { text: "imagine" },
  { text: "suppose" },
  { text: "pretend" },
  { text: "wish" },
  { text: "as though" },
  { text: "like a" },
  { text: "like the" },
];

/**
 * Markers that flip a claim when they PRECEDE it. Position is the whole rule: "your
 * hair is not loose" denies the claim, while "not that it matters, your hair is
 * loose" asserts it.
 */
const NEGATION_MARKERS: readonly TextMarker[] = [
  { text: "not" },
  { text: "n't", suffix: true },
  { text: "no longer" },
  { text: "never" },
  { text: "hardly" },
  { text: "barely" },
  { text: "stopped" },
  { text: "instead of" },
  { text: "rather than" },
];

/** Letters and digits bound a word; everything else is a boundary. */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9]/u.test(character);
}

/** First word-boundary occurrence of a marker, or `-1`. */
function markerIndex(text: string, marker: TextMarker): number {
  let from = 0;
  for (;;) {
    const index = text.indexOf(marker.text, from);
    if (index < 0) return -1;
    const startOk = marker.suffix === true || !isWordCharacter(text[index - 1]);
    if (startOk && !isWordCharacter(text[index + marker.text.length])) return index;
    from = index + 1;
  }
}

/**
 * Lowercase, with curly apostrophes folded to straight ones so `isn’t` and `isn't`
 * read alike. Length-preserving, so an index into this string still points at the
 * same character of the original — which is what lets the negation guard compare
 * against the lexicon matcher's index.
 */
function normalized(sentence: string): string {
  return sentence.toLowerCase().replace(/[‘’ʼ]/gu, "'");
}

/** True when the sentence carries any hypothetical or simile marker, anywhere in it. */
function isHypothetical(sentence: string): boolean {
  return HYPOTHETICAL_MARKERS.some((marker) => markerIndex(sentence, marker) >= 0);
}

/** True when a negation marker sits before `index`. */
function isNegatedBefore(sentence: string, index: number): boolean {
  return NEGATION_MARKERS.some((marker) => {
    const at = markerIndex(sentence, marker);
    return at >= 0 && at < index;
  });
}

/** Word tokens, apostrophes and hyphens kept (so `Wren's` stays one token). */
const WORD_TOKENS = /[A-Za-z][A-Za-z'’-]*/gu;

/**
 * How many words may sit between a possessive and `hair`.
 *
 * "your loose hair" and "your soaking wet auburn hair" are both ordinary English and
 * both are the claims this layer exists to check, so the window has to admit a few
 * adjectives. Four is enough for every phrasing the lexicon can match and short enough
 * that it cannot reach across a clause boundary into someone else's possessive.
 */
const POSSESSIVE_WINDOW = 4;

/** Determiners that mean the hair is NOT the subject's — a found one ends the search. */
const FOREIGN_POSSESSIVES: readonly string[] = ["my", "our", "its", "a", "an", "the", "this", "that", "some"];

/** Determiners that mean the subject, but only when nobody else could own them. */
const AMBIGUOUS_POSSESSIVES: readonly string[] = ["her", "his", "their", "its"];

/**
 * Whether this sentence is about the SUBJECT's hair.
 *
 * Walked backwards from the word `hair` over a short window of preceding words, so a
 * modifier between the possessive and the noun ("your loose hair") does not hide the
 * reference. The FIRST determiner found decides, and finding the wrong one ends the
 * search rather than continuing to look for a better answer.
 *
 * Accepted: second person (`your` — in this lane "you" is the character the message is
 * addressed to) and the possessive (`Wren's`). A third-person pronoun (`her`) counts
 * only when the sentence names nobody else who could own it, because a supporting-cast
 * member in the same sentence makes the referent ambiguous and ambiguity is silence.
 *
 * NOT accepted: `my hair`, and no determiner at all. The player's own hair is a
 * different body, and every fence this layer builds is about one subject.
 */
function referencesSubjectHair(sentence: string, characterName: string, playerName: string): boolean {
  const tokens = [...normalized(sentence).matchAll(WORD_TOKENS)].map((match) => match[0]);
  const name = characterName.trim().toLowerCase();
  const owners = name.length === 0 ? ["your"] : ["your", `${name}'s`, `${name}s`];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "hair") continue;
    for (let back = index - 1; back >= 0 && index - back <= POSSESSIVE_WINDOW; back -= 1) {
      const token = tokens[back];
      if (token === undefined) continue;
      if (owners.includes(token)) return true;
      if (AMBIGUOUS_POSSESSIVES.includes(token)) {
        if (!namesAnotherPerson(sentence, characterName, playerName)) return true;
        break;
      }
      if (FOREIGN_POSSESSIVES.includes(token)) break;
    }
  }
  return false;
}

/**
 * Words that can open a sentence without being a name.
 *
 * Grammar capitalises the first word, so the capitalisation test cannot tell "Mira
 * brushes her hair" from "The rain soaked her hair" without knowing which openers are
 * ordinary English. This list is deliberately small and deliberately incomplete: a word
 * that is missing from it reads as a name, which makes the sentence ambiguous, which
 * produces SILENCE. Every gap therefore costs a correction that would have been made,
 * never a correction that should not have been.
 */
const SENTENCE_OPENERS: ReadonlySet<string> = new Set([
  "a", "after", "all", "an", "and", "another", "any", "as", "at", "before", "both", "but", "by", "during", "each",
  "even", "every", "for", "from", "he", "her", "here", "hers", "his", "how", "i", "in", "into", "it", "its", "just",
  "last", "later", "mine", "my", "next", "no", "not", "now", "of", "on", "once", "one", "or", "our", "ours", "out",
  "over", "she", "since", "so", "some", "still", "that", "the", "their", "theirs", "then", "there", "these", "they",
  "this", "those", "through", "to", "under", "until", "up", "we", "what", "when", "where", "while", "who", "why",
  "with", "without", "you", "your", "yours",
]);

/**
 * True when the sentence contains a capitalised word that is neither the character nor
 * the player — the cheap deterministic test for "someone else could own that pronoun".
 *
 * `I` never owns hair in a third-person form, and a sentence-initial word is exempt
 * only when it is a recognised opener (see `SENTENCE_OPENERS`) — otherwise a
 * supporting-cast member who happens to be the grammatical subject would be invisible,
 * which is exactly the ambiguity this test exists to catch.
 */
function namesAnotherPerson(sentence: string, characterName: string, playerName: string): boolean {
  const known = new Set(
    [characterName, playerName]
      .flatMap((value) => value.trim().split(/\s+/u))
      .map((token) => token.toLowerCase())
      .filter(Boolean),
  );
  const tokens = sentence.match(WORD_TOKENS) ?? [];
  return tokens.some((token, position) => {
    const first = token[0];
    if (first === undefined || first !== first.toUpperCase() || token === "I") return false;
    const lower = token.toLowerCase();
    if (position === 0 && SENTENCE_OPENERS.has(lower)) return false;
    return !known.has(lower);
  });
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * How far a degree claim must be from the committed band to count as a contradiction.
 *
 * The four bands are a coarse cut of a continuous, lazily-dried level, so ONE step is
 * inside the honest error of the read — hair a minute either side of the `wet`
 * boundary is fairly called either thing, and fencing that would spend the feature's
 * credibility on rounding. Two steps cannot be rounding: "drenched" against damp
 * hair, or "dry" against soaked hair, describes a different head of hair.
 *
 * Applied symmetrically, which is a deliberate widening of "only overstatements are
 * fenced" (recorded in the spec's degree law). Understatement is normally left alone
 * because "wet" for soaked hair is merely less specific — and that reason runs out at
 * two bands, which is exactly where the `dry` claim lives: asserting dryness against a
 * committed soaking is a negation, not an understatement.
 */
const DEGREE_CONTRADICTION_DISTANCE = 2;

interface AreaVerdict {
  readonly verdict: PhysicalPremiseCorrection["verdict"];
  readonly truthCodes: readonly string[];
  readonly evidence: readonly AffordanceEvidence[];
}

/** An owner this lane could not read at all — the one thing that licenses `unsupported`. */
function unsupportedOn(kind: AffordanceEvidenceKind, ref: string): AreaVerdict {
  return { verdict: "unsupported", truthCodes: [], evidence: [affordanceEvidence(kind, ref, "unavailable")] };
}

/** The degree area: compare on the ordered scale, at a distance of two or more. */
function degreeVerdict(match: HairClaimMatch, committed: ChatCommittedHairState): AreaVerdict | null {
  if (!committed.available.wetness) return unsupportedOn("state", "body_surface.hair");
  if (committed.wetnessBand === null) return null;
  const claimed = hairWetnessClaimScale.indexOf(match.code);
  if (claimed < 0) return null;
  if (Math.abs(claimed - hairWetnessBandRank(committed.wetnessBand)) < DEGREE_CONTRADICTION_DISTANCE) return null;
  return {
    verdict: "contradicted",
    truthCodes: [hairWetnessClaimCode(committed.wetnessBand)],
    evidence: [affordanceEvidence("state", "body_surface.hair", committed.wetnessBand)],
  };
}

/**
 * The provenance area. Wetness owns the cause, so an unreadable surface row makes a
 * cause claim unsupported; a readable one with no single committed cause is silence,
 * because "we did not record why" is not evidence that the player is wrong.
 */
function causeVerdict(match: HairClaimMatch, committed: ChatCommittedHairState): AreaVerdict | null {
  if (!committed.available.wetness) return unsupportedOn("state", "body_surface.hair");
  if (committed.wetnessCause === null) return null;
  const truth = hairCauseClaimCode(committed.wetnessCause);
  if (truth === match.code) return null;
  return {
    verdict: "contradicted",
    truthCodes: [truth],
    evidence: [affordanceEvidence("event", "hair.wetting", committed.wetnessCause)],
  };
}

/** The arrangement area. An unidentified committed style contradicts nothing. */
function arrangementVerdict(match: HairClaimMatch, committed: ChatCommittedHairState): AreaVerdict | null {
  if (!committed.available.arrangement) return unsupportedOn("attribute", "hair.arrangement");
  if (committed.arrangement === null) return null;
  const truth = hairArrangementClaimCode(committed.arrangement);
  if (truth === null || truth === match.code) return null;
  return {
    verdict: "contradicted",
    truthCodes: [truth],
    evidence: [affordanceEvidence("attribute", "hair.arrangement", committed.arrangement)],
  };
}

/**
 * The motion area: free-flowing hair is contradicted by anything holding the bulk
 * still, which is the question `hair.bulk_restraint` already answers — so the answer
 * is read off this cut's own constraint rather than re-derived. Nothing holding it is
 * silence, because then the claim is simply true.
 */
function motionVerdict(restraint: RestraintFact | null): AreaVerdict | null {
  if (restraint === null) return null;
  return {
    verdict: "contradicted",
    truthCodes: restraint.truthCodes,
    evidence: [affordanceEvidence("state", "hair.bulk_restraint", restraint.code)],
  };
}

/** The coverage area. Only the `uncovered` claim exists, and coverage answers it. */
function coverageVerdict(committed: ChatCommittedHairState): AreaVerdict | null {
  if (!committed.available.coverage) return unsupportedOn("coverage", HAIR_LOCATION_ID);
  if (committed.coveredFraction === null || committed.coveredFraction < HAIR_COVERED_GATE) return null;
  return {
    verdict: "contradicted",
    // Coverage licenses no positive hair claim (`claims.ts`): the fence carries the
    // whole instruction, and what is on her head belongs to the garment lane.
    truthCodes: [],
    evidence: [affordanceEvidence("coverage", HAIR_LOCATION_ID, String(committed.coveredFraction))],
  };
}

/** What is holding the bulk still on this cut, with the truth it licenses. */
interface RestraintFact {
  readonly code: string;
  readonly truthCodes: readonly string[];
}

/**
 * The restraint on this cut, preferring the domain's own resolution.
 *
 * Taken from the read so a fence and a constraint candidate can never disagree. With
 * no read — a suppressed domain still knows the hair is braided — it falls back to
 * what committed presentation alone can say, which is deliberately narrower (it
 * cannot see water load) and therefore fences less, never more.
 */
function restraintOf(read: AffordanceRead | null, committed: ChatCommittedHairState): RestraintFact | null {
  const arrangementCode = committed.arrangement === null ? null : hairArrangementClaimCode(committed.arrangement);
  const truthCodes = arrangementCode === null ? [] : [arrangementCode];
  const resolved = read?.constraints.find((constraint) => constraint.locationId === HAIR_LOCATION_ID);
  if (resolved !== undefined) return { code: resolved.code, truthCodes };
  if (committed.arrangement === null) return null;
  const code = hairCommittedRestraint({
    arrangement: committed.arrangement,
    coveredFraction: committed.coveredFraction,
  });
  return code === null ? null : { code, truthCodes };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface ChatPremiseDetectionInput {
  /** The current player message, raw. Never mutated, never promoted to state. */
  readonly message: string;
  readonly playerName: string;
  readonly characterName: string;
  /** Storyteller-authoritative narration: excluded from premise checking entirely. */
  readonly narratorInput: boolean;
  readonly committed: ChatCommittedHairState;
  /** This cut's affordance read, for the restraint the motion area compares against. */
  readonly read?: AffordanceRead | null;
  readonly sink?: DiagnosticSink;
}

/**
 * The premise corrections this turn's message earns — at most one per claim area, and
 * the first eligible sentence wins an area.
 *
 * Pure and total: any message, any state, no throw. An empty array is the expected
 * result for the overwhelming majority of turns.
 */
export function detectHairPremises(input: ChatPremiseDetectionInput): readonly PhysicalPremiseCorrection[] {
  // Authority first, before any parsing: an authored state change must never be
  // answered with a correction (plan §Boundaries).
  if (input.narratorInput) return [];
  const message = input.message.trim();
  if (message.length === 0) return [];

  const restraint = restraintOf(input.read ?? null, input.committed);
  const byArea = new Map<HairClaimArea, PhysicalPremiseCorrection>();

  for (const span of parseMessageSpans(message, { playerName: input.playerName, knownNames: [input.characterName] })) {
    const source = spanSource(span.kind);
    if (source === null) continue;
    for (const sentence of span.text.split(SENTENCE_SPLIT)) {
      if (sentence.includes("?")) continue;
      const lower = normalized(sentence);
      if (isHypothetical(lower)) continue;
      if (!referencesSubjectHair(sentence, input.characterName, input.playerName)) continue;

      for (const match of hairClaimMatches(sentence)) {
        if (byArea.has(match.area) || isNegatedBefore(lower, match.index)) continue;
        const verdict = verdictFor(match, input.committed, restraint);
        if (verdict === null) continue;
        byArea.set(match.area, correction({ match, source, ...verdict }));
      }
    }
  }

  return [...byArea.values()];
}

/** One area's law, dispatched. Exhaustive over `HairClaimArea`. */
function verdictFor(
  match: HairClaimMatch,
  committed: ChatCommittedHairState,
  restraint: RestraintFact | null,
): AreaVerdict | null {
  switch (match.area) {
    case "wetness_degree":
      return degreeVerdict(match, committed);
    case "wetness_cause":
      return causeVerdict(match, committed);
    case "arrangement":
      return arrangementVerdict(match, committed);
    case "motion":
      return motionVerdict(restraint);
    case "coverage":
      return coverageVerdict(committed);
  }
}

/**
 * Build one correction. The id is derived from the cut and the claim — never from a
 * counter or a clock — so a retake of the same message over the same state produces
 * the identical id AND the identical fingerprint.
 */
function correction(input: {
  readonly match: HairClaimMatch;
  readonly source: PhysicalPremiseCorrection["source"];
  readonly verdict: PhysicalPremiseCorrection["verdict"];
  readonly truthCodes: readonly string[];
  readonly evidence: readonly AffordanceEvidence[];
}): PhysicalPremiseCorrection {
  const id = `${HAIR_DOMAIN_ID}:${input.match.area}:${input.match.code}:${input.verdict}`;
  return {
    id,
    source: input.source,
    claimCode: input.match.code,
    verdict: input.verdict,
    truthCodes: [...input.truthCodes],
    // A correction exists only to shape narration, so it is never resolver-only — and
    // never positive-detail either. The renderer voices no truth clause for one, which
    // is what lets a hidden cause stay hidden while the claim is still fenced.
    disclosure: "consistency_only",
    evidence: [...input.evidence],
    fingerprint: guidanceFingerprint([
      "correction",
      id,
      input.match.code,
      input.verdict,
      input.source,
      "consistency_only",
      guidanceUnorderedPart(input.truthCodes),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface ChatPhysicalGuidanceInput extends ChatPremiseDetectionInput {
  /** This cut's affordance read; `null` ⇒ no constraints, though corrections still run. */
  readonly read: AffordanceRead | null;
  /** The observer view the read was filtered through — the perception half of the law. */
  readonly perception: AffordancePerceptionView | null;
  /** The chat-lane character id whose body this guidance is about. */
  readonly subjectId: string;
}

/**
 * The compile with its intermediates kept — what the read-only inspector needs.
 *
 * The interesting failure sits BETWEEN the candidates and the guidance: a fence that
 * existed and lost a budget, or was withheld by the disclosure gate, is invisible from
 * the result alone, and that is the case a developer is usually chasing. Production
 * throws the candidates away (`buildChatPhysicalGuidance`) and the preview renders
 * them, from one implementation — the same discipline the affordance domains' `trace`
 * follows, and for the same reason: a debug view that recomputed would explain a
 * compile that never happened.
 */
export interface ChatPhysicalGuidanceStages {
  readonly candidateConstraints: readonly PhysicalNarrationConstraint[];
  readonly candidateCorrections: readonly PhysicalPremiseCorrection[];
  readonly guidance: NarratorPhysicalGuidance;
}

/**
 * Compile this turn's narrator physical guidance: constraints from the committed cut,
 * corrections from the current message, gated and budgeted by the shared compiler.
 *
 * The two halves degrade independently, which is why they compile together rather
 * than in one pass: no read (or no perception view) still leaves the premise check
 * running, and a message that asserts nothing still leaves the fences standing. When
 * neither half has anything, the result is the shared empty value with NO diagnostics
 * — a nothing-to-say turn must not be distinguishable from a feature-off one.
 */
export function buildChatPhysicalGuidanceStages(input: ChatPhysicalGuidanceInput): ChatPhysicalGuidanceStages {
  const candidateConstraints =
    input.read === null || input.perception === null
      ? []
      : buildConstraintCandidates({
          subjectId: affordanceSubjectId(input.subjectId),
          domainId: HAIR_DOMAIN_ID,
          constraints: input.read.constraints,
          mappings: hairClaimMappings({
            arrangement: input.committed.arrangement,
            wetnessBand: input.committed.wetnessBand,
          }),
          perception: input.perception,
          evidence: input.read.evidence,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        });

  const candidateCorrections = detectHairPremises(input);
  if (candidateConstraints.length === 0 && candidateCorrections.length === 0) {
    return { candidateConstraints, candidateCorrections, guidance: emptyNarratorPhysicalGuidance() };
  }

  return {
    candidateConstraints,
    candidateCorrections,
    guidance: compileNarratorPhysicalGuidance({
      constraints: candidateConstraints,
      corrections: candidateCorrections,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    }),
  };
}

/** The production entry point: the compiled guidance, intermediates discarded. */
export function buildChatPhysicalGuidance(input: ChatPhysicalGuidanceInput): NarratorPhysicalGuidance {
  return buildChatPhysicalGuidanceStages(input).guidance;
}
