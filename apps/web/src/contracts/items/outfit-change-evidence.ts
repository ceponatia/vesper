import { garmentIdentitiesIn } from "./garment-nouns";

/**
 * Does a quoted clause ACTUALLY assert that someone's clothes moved?
 *
 * This is the middle third of the chat lane's whole-look evidence gate
 * (`outfitChangeEvidenceValidated` in `server/engine/chat-state/outfit-evidence.ts`, owner
 * ruling 2026-08-01). That gate first asks whether the archivist's
 * `changeEvidence` is VERBATIM from the exchange; this module asks what the
 * quoted words SAY; the gate then asks WHOSE clothes moved, reading the
 * asserting sentence this module returns. Only all three together may let a
 * free-text description wipe a modelled wardrobe.
 *
 * Word-pattern matching alone was the first cut and it validated non-events: a
 * negation ("she doesn't take off her jacket"), a plan ("plans to take off her
 * jacket"), a command ("«take off your jacket,» she says"), an incomplete
 * ("almost takes off"), or an idiom whose object is not a garment at all ("takes
 * off for work", "sheds light on the problem", "kicks off the meeting", "puts on
 * a brave face"). Each of those wipes a dressed body's modelled wardrobe on a
 * beat where nothing was taken off.
 *
 * The answer is three checks over ONE sentence, in this order:
 *
 * 1. **A signal fires** — a row of the table below matched (the wardrobe verbs).
 * 2. **Nothing vetoes the sentence** — it is not negated, modal, conditional, a
 *    question, a command, a refusal, incomplete, hypothetical or habitual, and
 *    the signal is not inside a quoted line of dialogue.
 * 3. **A garment is named in the object window** — the ~8 tokens following the
 *    signal's head verb, never crossing a clause or sentence boundary. This is
 *    what separates "takes off her jacket" from "takes off for work" with no
 *    vocabulary of idioms at all.
 *
 * PRECISION-BIASED, in the same direction as the garment registry: an uncertain
 * quote rejects, and a rejection KEEPS the modelled wardrobe — the safe failure.
 * A missed real change costs one turn of stale prose; a false accept silently
 * de-models a dressed body.
 */

/** Why a quote failed to assert a wardrobe change — diagnostic detail, never a user-facing string. */
export type OutfitChangeRejection =
  | "no_signal"
  | "no_garment_object"
  | "negated"
  | "modal"
  | "conditional"
  | "question"
  | "command"
  | "quoted"
  | "refusal"
  | "incomplete"
  | "hypothetical"
  | "habitual";

/**
 * The verdict: an assertion, or the most informative reason it is not one.
 *
 * An acceptance carries the ONE sentence that asserted — the caller's attribution
 * half (`outfitChangeEvidenceValidated`'s owner scoping) must read exactly the
 * clause that claimed a change, not the whole quote, or a multi-sentence quote
 * narrating two bodies would attribute on a name from the wrong sentence.
 */
export type OutfitChangeVerdict =
  | { readonly asserted: true; readonly sentence: string }
  | { readonly asserted: false; readonly reason: OutfitChangeRejection };

/**
 * What a matched row claims:
 * - `action` — someone MOVED a garment ("pulls on", "takes off", "swaps … for").
 * - `state` — the standing look is ASSERTED to have changed ("now wearing", "no
 *   longer wearing", "undresses"). Same object requirement: "now wearing a
 *   scowl" and "undresses her with his eyes" are not wardrobe facts.
 * - `change_verb` — the ambiguous chang* family, which needs its clothing
 *   context ADJACENT ("changed into …", "changed out of the work clothes") so
 *   "the weather changed and we ran into the barn" cannot borrow a far-off word.
 */
type OutfitSignalKind = "action" | "state" | "change_verb";

interface OutfitChangeSignal {
  /** Stable id — the table's edit surface and what a future diagnostic would name. */
  readonly id: string;
  readonly pattern: RegExp;
  readonly kind: OutfitSignalKind;
  /**
   * The one row that asserts a change while naming no garment: stripping naked
   * IS the wardrobe fact. Every other row must put a garment in its window.
   */
  readonly garmentFree?: boolean;
}

/**
 * The wardrobe-verb table. Word-boundary anchored, and where the verb is
 * ambiguous alone it carries the particle or article that makes it a wardrobe
 * action: "ties A/THE/ON …" so styling ("the apron ties loose at the waist")
 * never matches, "don A/THE …" so "don't" never matches.
 *
 * Registry rules (CLAUDE.md): a new verb is a data edit HERE, never new logic.
 * A verb missing from the table keeps the modelled wardrobe, which is the safe
 * failure — so err toward leaving one out.
 */
const OUTFIT_CHANGE_SIGNALS: readonly OutfitChangeSignal[] = [
  // Into / out of a garment.
  { id: "slip_into_out", kind: "action", pattern: /\b(?:slip|slips|slipped|slipping)\s+(?:into|out of)\b/ },
  {
    id: "zip_into_out",
    kind: "action",
    pattern:
      /\b(?:zip|zips|zipped|zipping)\s+(?:herself|himself|themselves|myself|yourself|you|me|her|him|them)?\s*(?:into|out of)\b/,
  },
  { id: "step_into", kind: "action", pattern: /\b(?:step|steps|stepped|stepping)\s+into\b/ },
  {
    id: "wriggle_into_out",
    kind: "action",
    pattern: /\b(?:wriggle|wriggles|wriggled|wriggling|wiggle|wiggles|wiggled|wiggling)\s+(?:into|out of)\b/,
  },
  { id: "shrug_into_out", kind: "action", pattern: /\b(?:shrug|shrugs|shrugged|shrugging)\s+(?:into|out of|on|off)\b/ },
  {
    id: "tug_into_out",
    kind: "action",
    pattern: /\b(?:tug|tugs|tugged|tugging)\s+(?:you|me|him|her|them)?\s*(?:into|out of|on|off)\b/,
  },
  // On / off.
  { id: "put_on", kind: "action", pattern: /\b(?:put|puts|putting)\s+on\b/ },
  { id: "pull_on_off", kind: "action", pattern: /\b(?:pull|pulls|pulled|pulling)\s+(?:on|off)\b/ },
  { id: "yank_on_off", kind: "action", pattern: /\b(?:yank|yanks|yanked|yanking)\s+(?:on|off)\b/ },
  { id: "throw_on", kind: "action", pattern: /\b(?:throw|throws|threw|throwing)\s+on\b/ },
  { id: "take_off", kind: "action", pattern: /\b(?:take|takes|took|taking)\s+off\b/ },
  /**
   * The SPLIT particle — "she takes her jacket off" is the same act as "takes
   * off her jacket", and the contiguous row above cannot see it. The object sits
   * BETWEEN verb and particle, which the shared object window (measured from the
   * head verb) already covers.
   */
  { id: "take_off_split", kind: "action", pattern: /\b(?:take|takes|took|taking)\s+(?:\w+\s+){1,4}?off\b/ },
  { id: "kick_off", kind: "action", pattern: /\b(?:kick|kicks|kicked|kicking)\s+off\b/ },
  { id: "strip_off_out", kind: "action", pattern: /\b(?:strip|strips|stripped|stripping)\s+(?:off|out of)\b/ },
  { id: "peel_off_out", kind: "action", pattern: /\b(?:peel|peels|peeled|peeling)\s+(?:off|out of)\b/ },
  // Swapped one garment for another — either side may name the garment, which is
  // why the object window reaches past the `for` complement.
  {
    id: "swap_trade_for",
    kind: "action",
    pattern: /\b(?:swap|swaps|swapped|swapping|trade|trades|traded|trading)\s+(?:\S+\s+){0,6}for\b/,
  },
  // Shed / don / doff — inherently wardrobe verbs, except bare "don" (vs "don't").
  { id: "shed", kind: "action", pattern: /\b(?:shed|sheds|shedding)\b/ },
  { id: "don_doff", kind: "action", pattern: /\b(?:dons|donned|donning|doff|doffs|doffed|doffing)\b/ },
  { id: "don_article", kind: "action", pattern: /\bdon\s+(?:a|an|the|her|his|their|your|my)\b/ },
  // Tying a garment ON (never "the apron ties loose at the waist").
  { id: "tie_on", kind: "action", pattern: /\b(?:tie|ties|tied|tying)\s+(?:a|an|the|on|it|her|his|their|your|my)\b/ },
  // Undressed / dressed in / the standing-look assertions.
  { id: "undress", kind: "state", pattern: /\b(?:undress|undresses|undressed|undressing)\b/ },
  { id: "dressed_in", kind: "state", pattern: /\b(?:dressed|dresses|dressing)\s+in\b/ },
  { id: "now_wearing", kind: "state", pattern: /\bnow\s+wearing\b/ },
  { id: "no_longer_wearing", kind: "state", pattern: /\bno\s+longer\s+wearing\b/ },
  { id: "back_in", kind: "state", pattern: /\bback\s+in\s+(?:a|an|the|her|his|their|your|my)\b/ },
  { id: "come_back_in", kind: "state", pattern: /\b(?:come|comes|came)\s+back\s+(?:down\s+)?in\b/ },
  // The one garment-free assertion: nothing left to name.
  { id: "strip_bare", kind: "state", garmentFree: true, pattern: /\bstrip(?:s|ped|ping)?\s+(?:naked|bare)\b/ },
  // Tier B: the ambiguous chang* family (context checked adjacently below).
  { id: "change_verb", kind: "change_verb", pattern: /\bchang(?:e|es|ed|ing)\b/ },
];

/** Tokens of object window after a signal's head verb — enough for "swaps X for Y". */
const OBJECT_WINDOW_TOKENS = 8;
/** Tokens of clothing context after a bare chang*, which must be much tighter. */
const CHANGE_CONTEXT_TOKENS = 4;

/** chang* with its clothing context ADJACENT — at most one token between verb and particle. */
const CHANGE_ADJACENT_CONTEXT = /\bchang(?:e|es|ed|ing)\s+(?:\w+\s+)?(?:into|out\s+of)\b/;
/** Clothing nouns that make a bare chang* about clothes (garment identities are checked separately). */
const CHANGE_CLOTHING_NOUNS = /\b(?:clothes|clothing|outfits?|uniform|costume|wardrobe)\b/;
/** Collective clothing words the garment registry deliberately has no identity for. */
const COLLECTIVE_CLOTHING = /\b(?:clothes|clothing)\b/;
/** A copula before "dressed in" makes it the STANDING look, not a change ("she is dressed in a tee"). */
const COPULA_BEFORE = /\b(?:is|was|are|were|stays|remains|still)\s*$/;

// ---------------------------------------------------------------------------
// Veto predicates — each one small, named, and over the WHOLE sentence.
// ---------------------------------------------------------------------------

/**
 * Negation. The `no longer` carve-out is mandatory: "no longer wearing the
 * apron" is one of the strongest change assertions there is, and a bare `\bno\b`
 * would veto it.
 */
function isNegated(sentence: string): boolean {
  return /\bno(?!\s+longer)\b|\b(?:not|never|nor|neither|nothing|nobody|without)\b|n't\b/.test(sentence);
}

/** Refused / declined — an intent that explicitly did NOT happen. */
function isRefusal(sentence: string): boolean {
  return /\b(?:refus|declin)\w*\b/.test(sentence);
}

/** Hypothetical framing by conjunction — the act is conditioned, not done. */
function isConditional(sentence: string): boolean {
  return /\b(?:if|unless|whether)\b/.test(sentence);
}

/** A question asks about the act; it never reports one. */
function isQuestion(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (/\?\s*$/.test(trimmed)) return true;
  return /^(?:do|does|did|should|could|would|will|can|is|are|was|were)\s+(?:i|you|he|she|it|we|they|him|her|them)\b/.test(
    trimmed,
  );
}

/** Modality and intent — "might", "is about to", "plans to", "thinks about". */
function isModal(sentence: string): boolean {
  if (/\b(?:might|may|could|would|should|will|shall|must|can)\b|'ll\b/.test(sentence)) return true;
  if (/\babout\s+to\b|\bgoing\s+to\b/.test(sentence)) return true;
  if (
    /\b(?:wants?|wanted|plans?|planned|intends?|intended|means?|meant|hopes?|hoped|tries|tried|needs?|needed|offers?|offered|threatens?|threatened)\s+to\b/.test(
      sentence,
    )
  ) {
    return true;
  }
  return /\bthinks?\s+about\b|\bthinking\s+about\b|\bdreams?\s+of\b|\bdreaming\s+of\b/.test(sentence);
}

/**
 * BASE-form imperative only, and only as the sentence's first token: "take off
 * your jacket" is an order, while "yanks on a paint-streaked tank top" is a
 * report. Leading quotes and dashes are stripped first — dialogue is punctuated.
 */
const IMPERATIVE_HEADS: ReadonlySet<string> = new Set([
  "take",
  "put",
  "pull",
  "kick",
  "strip",
  "peel",
  "slip",
  "step",
  "shed",
  "don",
  "doff",
  "swap",
  "trade",
  "change",
  "zip",
  "tie",
  "throw",
  "yank",
  "tug",
  "shrug",
  "wriggle",
]);

function isImperative(sentence: string): boolean {
  const head = /^[\s"'*_\-–—]*([a-z']+)/.exec(sentence)?.[1];
  return head !== undefined && IMPERATIVE_HEADS.has(head);
}

/** A command reported in prose — "she tells him to take off his jacket". */
function isReportedCommand(sentence: string): boolean {
  return /\b(?:tell|tells|told|ask|asks|asked|order|orders|ordered|urge|urges|urged|beg|begs|begged|command|commands|commanded)\s+(?:\w+\s+){0,3}to\b/.test(
    sentence,
  );
}

/** Started but not finished — "almost takes off", "starts to take off". */
function isIncomplete(sentence: string): boolean {
  return /\b(?:almost|nearly|halfway)\b|\b(?:start|starts|started|begin|begins|began|reach|reaches|reached|move|moves|moved)\s+to\b/.test(
    sentence,
  );
}

/** Imagined rather than narrated — "imagine her slipping into…", "in the dream…". */
function isHypothetical(sentence: string): boolean {
  return /\b(?:imagine|imagines|imagining|picture|pictures|picturing|suppose|supposes|supposing|dream|dreams|dreamt|dreamed|dreaming)\b|\bin\s+the\s+dream\b/.test(
    sentence,
  );
}

/** A habit is not this exchange's event — "every morning", "used to", "always". */
function isHabitual(sentence: string): boolean {
  return /\bevery\s+(?:morning|day|night|evening|week|time)\b|\bused\s+to\b|\balways\b/.test(sentence);
}

/** Ordered so the FIRST hit is the most informative thing to say about the sentence. */
const SENTENCE_VETOES: readonly { readonly reason: OutfitChangeRejection; readonly applies: (s: string) => boolean }[] =
  [
    { reason: "negated", applies: isNegated },
    { reason: "refusal", applies: isRefusal },
    { reason: "conditional", applies: isConditional },
    { reason: "question", applies: isQuestion },
    { reason: "command", applies: (s) => isImperative(s) || isReportedCommand(s) },
    { reason: "modal", applies: isModal },
    { reason: "incomplete", applies: isIncomplete },
    { reason: "hypothetical", applies: isHypothetical },
    { reason: "habitual", applies: isHabitual },
  ];

function vetoFor(sentence: string): OutfitChangeRejection | null {
  for (const veto of SENTENCE_VETOES) {
    if (veto.applies(sentence)) return veto.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sentence / window mechanics
// ---------------------------------------------------------------------------

/**
 * Split on SENTENCE boundaries only — never on "and" or a comma. "I peel off the
 * cotton shirt and pull on a red evening dress." is one sentence, and a clause
 * split would read its second half as an imperative and veto a real change.
 * Terminators stay attached (the question veto reads them).
 */
function sentencesOf(quote: string): string[] {
  return [...quote.matchAll(/[^.!?;\n]+[.!?;]*/g)]
    .map((match) => match[0].trim())
    .filter((sentence) => sentence.length > 0);
}

/** Character spans of double-quoted dialogue in a sentence. */
function quotedSpans(sentence: string): readonly (readonly [number, number])[] {
  return [...sentence.matchAll(/"[^"]*"/g)].map((match) => [match.index, match.index + match[0].length] as const);
}

/**
 * POSITIONAL: only a signal INSIDE quoted dialogue is quoted speech. A trailing
 * fragment after the verb — `pulls on a black silk blouse — "it's the good one"`
 * — reports a real change and must not be vetoed.
 */
function insideQuotedSpan(spans: readonly (readonly [number, number])[], at: number): boolean {
  return spans.some(([start, end]) => at >= start && at < end);
}

/** Up to `tokens` words of `text`, stopping at the first clause boundary. */
function windowOf(text: string, tokens: number): string {
  const clause = text.split(/[,;:.!?]/, 1)[0] ?? "";
  return clause.trim().split(/\s+/).slice(0, tokens).join(" ");
}

/**
 * The object window: what follows the signal's HEAD VERB, so both the split
 * particle ("takes her jacket off") and the swap complement ("swaps her heels
 * for flats" / "swap it for a black silk shirt") are covered by one rule. It
 * stops at a clause boundary and, because every sentence is evaluated alone,
 * can never reach across a sentence boundary.
 */
function objectWindow(sentence: string, match: RegExpExecArray, tokens: number): string {
  const matched = match[0];
  const headEnd = /\s/.exec(matched)?.index ?? matched.length;
  return windowOf(sentence.slice(match.index + headEnd), tokens);
}

/**
 * Does this window name a garment? The registry decides, plus the two collective
 * words it deliberately holds no identity for. "into"/"out of" never count —
 * they are the verb's particle, not its object.
 */
function namesGarment(window: string): boolean {
  return garmentIdentitiesIn(window).size > 0 || COLLECTIVE_CLOTHING.test(window);
}

/** A bare chang* is about clothes only with ADJACENT context or a garment right beside it. */
function changeIsAboutClothes(sentence: string, match: RegExpExecArray): boolean {
  if (CHANGE_ADJACENT_CONTEXT.test(sentence.slice(match.index))) return true;
  const context = objectWindow(sentence, match, CHANGE_CONTEXT_TOKENS);
  return garmentIdentitiesIn(context).size > 0 || CHANGE_CLOTHING_NOUNS.test(context);
}

/** Rejection informativeness: a veto says the most, "no signal at all" the least. */
const REJECTION_RANK: Readonly<Record<OutfitChangeRejection, number>> = {
  no_signal: 0,
  no_garment_object: 1,
  negated: 2,
  modal: 2,
  conditional: 2,
  question: 2,
  command: 2,
  quoted: 2,
  refusal: 2,
  incomplete: 2,
  hypothetical: 2,
  habitual: 2,
};

/** Keep whichever rejection says more about the sentence. */
function moreInformative(
  current: OutfitChangeRejection | null,
  candidate: OutfitChangeRejection,
): OutfitChangeRejection {
  if (current === null) return candidate;
  return REJECTION_RANK[candidate] > REJECTION_RANK[current] ? candidate : current;
}

/** Null when no signal fired in this sentence at all (the caller's weakest reason). */
function evaluateSentence(sentence: string): OutfitChangeVerdict | null {
  const spans = quotedSpans(sentence);
  let reason: OutfitChangeRejection | null = null;
  for (const signal of OUTFIT_CHANGE_SIGNALS) {
    const match = signal.pattern.exec(sentence);
    if (!match) continue;
    // "she IS dressed in a tee" describes the look she already had on.
    if (signal.id === "dressed_in" && COPULA_BEFORE.test(sentence.slice(0, match.index))) continue;
    if (insideQuotedSpan(spans, match.index)) {
      reason = moreInformative(reason, "quoted");
      continue;
    }
    const veto = vetoFor(sentence);
    if (veto !== null) {
      reason = moreInformative(reason, veto);
      continue;
    }
    if (signal.kind === "change_verb") {
      if (changeIsAboutClothes(sentence, match)) return { asserted: true, sentence };
      reason = moreInformative(reason, "no_garment_object");
      continue;
    }
    if (signal.garmentFree === true || namesGarment(objectWindow(sentence, match, OBJECT_WINDOW_TOKENS))) {
      return { asserted: true, sentence };
    }
    reason = moreInformative(reason, "no_garment_object");
  }
  return reason === null ? null : { asserted: false, reason };
}

/**
 * Does this quote CLAIM the clothes moved?
 *
 * The quote must already be normalized — lowercased, whitespace-collapsed, curly
 * quotes straightened — which is the caller's job (`normalizeEvidenceText`), so
 * this module never disagrees with the grounding check about what the text is.
 *
 * The FIRST sentence that fully asserts wins ("she doesn't hesitate. she takes
 * off her jacket." is a change) and is handed back on the verdict — the caller's
 * owner-attribution half reads that sentence and nothing else; otherwise the most
 * informative rejection across every sentence is returned.
 */
export function classifyOutfitChangeQuote(quote: string): OutfitChangeVerdict {
  let reason: OutfitChangeRejection = "no_signal";
  for (const sentence of sentencesOf(quote)) {
    const verdict = evaluateSentence(sentence);
    if (verdict === null) continue;
    if (verdict.asserted) return verdict;
    if (REJECTION_RANK[verdict.reason] > REJECTION_RANK[reason]) reason = verdict.reason;
  }
  return { asserted: false, reason };
}
