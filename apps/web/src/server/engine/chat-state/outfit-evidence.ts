import {
  type CharacterProfile,
  type OutfitPreset,
  outfitPresetByName,
  classifyOutfitChangeQuote,
} from "@/contracts";

/**
 * Match an archivist outfit description against the authored preset names.
 * Conservative on purpose: a preset matches only
 * when the text IS its name ("work") or names it with an outfit word ("changes
 * into her work clothes", "her date night outfit") — a bare name inside prose
 * ("work boots" naming no outfit word... does match "work clothes"-style
 * phrasing only) can't hijack an unrelated garment description. Longest name
 * wins; empty presets never match.
 */
export function matchOutfitPresetInText(
  profile: Pick<CharacterProfile, "outfits">,
  text: string,
): OutfitPreset | undefined {
  const haystack = text.trim().toLowerCase();
  if (!haystack) return undefined;
  const exact = outfitPresetByName(profile, text);
  if (exact && exact.items.length > 0) return exact;
  const candidates = profile.outfits
    .filter((p) => p.name.trim().length >= 3 && p.items.length > 0)
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const preset of candidates) {
    const name = preset.name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9])${name}\\s+(?:clothes|outfit|look|attire|uniform|wear|set)(?:$|[^a-z0-9])`);
    if (pattern.test(haystack)) return preset;
  }
  return undefined;
}

/**
 * Light normalization for the change-evidence check: case, whitespace runs and
 * curly quotes/apostrophes are all things a model re-types differently while
 * still quoting the exchange verbatim. Everything else — wording, punctuation,
 * order — must match, which is the whole point of a VERBATIM quote.
 */
function normalizeEvidenceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The two halves of the exchange a whole-look `changeEvidence` may quote — kept separate because first/second person attribute differently per half. */
export interface OutfitEvidenceExchange {
  player: string;
  assistant: string;
}

/** The wardrobe owner the evidence must be about, plus the scene shape that decides pronoun ambiguity. */
export interface OutfitEvidenceOwner {
  /** Display name + authored aliases referring to the owner (for the player: the persona/account name). */
  names: readonly string[];
  /** True when the owner is the player persona (first/second-person forms can attribute). */
  isPlayer: boolean;
  /** Names of every OTHER scene participant — other present characters, plus the player's name when the owner is a character. */
  otherNames: readonly string[];
  /** Characters present in the scene, the owner included when the owner is a character. >1 ⇒ bare pronouns are ambiguous and fail closed. */
  presentCharacterCount: number;
}

/** Word-boundary name match on already-normalized text — the shape `mentionsCharacter` uses, kept local so this pure gate owns no cross-module dependency. */
function textNamesAnyOf(text: string, names: readonly string[]): boolean {
  return names
    .map((name) => name.trim())
    .filter((name) => name.length > 1)
    .some((needle) =>
      new RegExp(`(?:^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^\\p{L}\\p{N}]|$)`, "iu").test(
        text,
      ),
    );
}

/** Person forms in a normalized (lowercased) sentence — the only grammar this gate reads. */
const EVIDENCE_FIRST_PERSON = /\b(?:i|me|my|mine|myself)\b/;
const EVIDENCE_SECOND_PERSON = /\b(?:you|your|yours|yourself)\b/;
const EVIDENCE_THIRD_PERSON = /\b(?:she|he|they|her|hers|him|his|their|theirs|herself|himself|themselves)\b/;

/**
 * Is this change clause about the WARDROBE OWNER's clothes (condition 3)?
 *
 * Runs against the ONE sentence `classifyOutfitChangeQuote` said asserts the
 * change, not the whole quote — a multi-sentence quote can narrate two bodies,
 * and only the asserting sentence says whose clothes moved.
 *
 * Bounded attribution, deliberately NOT coreference resolution: a name settles
 * it outright, person forms settle it only where the half they appear in makes
 * them unambiguous, and an ensemble scene fails closed on bare pronouns.
 */
function evidenceAttributesToOwner(args: {
  sentence: string;
  owner: OutfitEvidenceOwner;
  inPlayer: boolean;
  inAssistant: boolean;
}): boolean {
  const { sentence, owner, inPlayer, inAssistant } = args;
  // A named owner wins wherever the name sits in the clause, including the
  // possessive object ("Mara pulls off Sabrina's jacket" IS Sabrina's change) — the
  // owner need not be the actor.
  if (textNamesAnyOf(sentence, owner.names)) return true;
  // …and a clause that names only somebody ELSE is that participant's evidence, not this one's.
  if (textNamesAnyOf(sentence, owner.otherNames)) return false;

  const first = EVIDENCE_FIRST_PERSON.test(sentence);
  const second = EVIDENCE_SECOND_PERSON.test(sentence);
  const third = EVIDENCE_THIRD_PERSON.test(sentence);
  const solo = owner.presentCharacterCount <= 1;

  if (owner.isPlayer) {
    // "I take off my jacket" is the player only in the player's own line; "she
    // tugs you out of your shirt" is the player only in the reply. The wrong
    // half flips the referent (first person in the reply is the character
    // speaking), so it does not attribute.
    if (first && inPlayer) return true;
    if (second && inAssistant) return true;
    return solo && !first && !second && !third;
  }
  // Character owner. Bare pronouns are only unambiguous while one character is on
  // stage; with a second body present, only the name licenses the replacement.
  if (!solo) return false;
  if (third) return true;
  if (first && inAssistant) return true;
  if (second && inPlayer) return true;
  // A markerless clause ("kicks off the boots") in a two-body scene: the character
  // is the only wardrobe the reply can be moving.
  return !first && !second;
}

/**
 * Did the archivist's whole-look outfit proposal come with REAL evidence that
 * the outfit changed during this exchange, TO THIS OWNER (owner ruling,
 * 2026-08-01)?
 *
 * THREE conditions, and each of the last two was bought the hard way. The quote must
 *
 * 1. **be in the exchange** — non-empty and present under `normalizeEvidenceText`
 *    in one half or (spanning them) in the joined text; and
 * 2. **assert a change** — say that the clothes moved, per
 *    `classifyOutfitChangeQuote` (`contracts/items/outfit-change-evidence.ts`),
 *    which owns the whole reading: the wardrobe-verb table, the non-event vetoes
 *    (negation, modality, questions, commands, incompletes, hypotheticals…) and
 *    the garment-object window that tells "takes off her jacket" from "takes off
 *    for work". Its rejection reason is diagnostic detail this gate does not
 *    surface — the fold's message text is the same whichever way a quote failed;
 *    its ACCEPTANCE hands back the one sentence that asserted, which is the text
 *    condition 3 reads; and
 * 3. **attribute to the wardrobe owner** — `evidenceAttributesToOwner`, run on
 *    that asserting sentence.
 *
 * Presence alone was the first cut of this gate, and the live check on the
 * deployed build (2026-08-01) proved it trivially satisfiable: a fresh chat's
 * player line read "I walk over to her. Her sleeves are shoved past her elbows,
 * one cuff dusted with flour." — a pure styling paraphrase — and the extractor
 * proposed that very sentence as BOTH the description and its own
 * `changeEvidence`. The quote was genuinely in the text, so the gate passed and
 * the fold wiped the modelled wardrobe. Extracted descriptions are almost always
 * lifted from the prose, so a self-quote always "validates"; only asking what the
 * quoted clause SAYS separates "she slips out of the work clothes" from "her
 * sleeves are shoved past her elbows".
 *
 * Condition 3 came from the adversarial audit of that fix (2026-08-01): all three
 * call sites validated against ONE shared exchange text, so a quote of participant
 * A's genuine change ("Mara pulls on her coat.") licensed participant B's whole-look
 * replacement — the extractor's member-scoped prompting was the only thing standing
 * between an ensemble and a cross-wiped wardrobe, and prompting is not a gate.
 *
 * The scoping is BOUNDED — a name test plus person forms read against the half they
 * appear in — never coreference resolution, which no regex can do and which would
 * fail unpredictably rather than closed. Canonically: "She takes off her jacket"
 * attributes to the sole character on stage; "I take off my jacket" attributes to the
 * player in the PLAYER's half; "Mara pulls off Sabrina's jacket" is valid evidence for
 * SABRINA (the owner is named, actor or not). Two deliberate acceptances make the
 * boundedness honest — the named ACTOR passes for their own wardrobe as readily as
 * the named object does, and a compound like "she tugs you out of your shirt"
 * passes for a solo CHARACTER owner on its third-person marker. Both are the price of
 * not parsing; ensemble scenes, where the confusion actually costs a wardrobe, still
 * fail closed without the owner's name.
 *
 * This is the one gate that lets a free-text `description` replace a modelled
 * wardrobe (alongside the character fold's exposure claim and an authored-preset
 * match), and it replaces the old garment-noun predicate outright. A noun list
 * could never decide it: "a black silk shirt" over a worn "soft cotton shirt"
 * shares its head noun and IS a change; "her white cotton t-shirt" over a worn
 * "white cotton tee" is a different word for the SAME garment; "a paint-streaked
 * tank top" names a compound no unigram registry holds.
 */
export function outfitChangeEvidenceValidated(
  evidence: string,
  exchange: OutfitEvidenceExchange,
  owner: OutfitEvidenceOwner,
): boolean {
  const quote = normalizeEvidenceText(evidence);
  if (!quote) return false;
  // Which half the quote came from is what makes "I"/"you" attributable, so
  // grounding resolves the half first. A quote spanning both halves is still
  // grounded, but carries no half attribution — person forms in it cannot decide.
  const inPlayer = normalizeEvidenceText(exchange.player).includes(quote);
  const inAssistant = normalizeEvidenceText(exchange.assistant).includes(quote);
  if (!inPlayer && !inAssistant && !normalizeEvidenceText(`${exchange.player}\n${exchange.assistant}`).includes(quote)) {
    return false;
  }
  const verdict = classifyOutfitChangeQuote(quote);
  if (!verdict.asserted) return false;
  // Attribution reads the ASSERTING sentence the classifier hands back, never the
  // whole quote: "Mara pulls on her coat. Sabrina laughs." must not attribute to
  // Sabrina on a name that sits outside the clause claiming a change.
  return evidenceAttributesToOwner({ sentence: verdict.sentence, owner, inPlayer, inAssistant });
}