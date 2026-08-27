import type { ConstraintClaimMapping } from "../../guidance";
import { HAIR_LOCATION_ID } from "./frame";
import type { HairWettingEventKind } from "./frame";
import type { HairArrangement } from "./mechanics";
import {
  hairWetnessBands,
  HAIR_BOUND,
  HAIR_COVERED,
  HAIR_PINNED,
  HAIR_WATER_LOADED,
  type HairWetnessBand,
} from "./phenomena/bands";

/**
 * The hair domain's NARRATOR CLAIM lexicon.
 *
 * Physical truth stays domain-owned, and so does the vocabulary for talking about
 * it. The shared guidance compiler treats every claim code as opaque — it carries,
 * orders, budgets and gates them and never parses one — so this file is where a
 * code acquires meaning, in exactly three ways:
 *
 * 1. **Which surface phrases assert it** (`phrases`), for the deterministic premise
 *    detector. Exact lowercase fragments matched on word boundaries — no stemming,
 *    no synonym expansion, no model call. Inflections are enumerated rather than
 *    derived, because a stemmer's near-misses are exactly the ambiguity the plan
 *    says must produce silence.
 * 2. **How a prohibition names it** (`display`), for the lane renderer.
 * 3. **How the committed truth reads as a clause** (`truth`), for the half of a
 *    constraint that only ships when perception licenses it. A code with no honest
 *    positive clause simply has none — the fence still ships, the cause does not.
 *
 * Two further vocabularies live here for the same reason — they are statements about
 * this body part, not about English: `hairReferenceNouns` (what a claim must be
 * attached to before it means anything) and `hairWetnessAnchorPhrases` (what a
 * provenance claim needs before a cause word counts as a wetting).
 *
 * The five areas are the plan's slice-2 list: wetness degree, wetness provenance,
 * arrangement/binding, motion, and coverage. AREA is load-bearing rather than
 * decorative: the detector emits at most one correction per area per turn, and a
 * degree comparison is only meaningful against another member of its own area.
 *
 * ## What is deliberately absent
 *
 * There is no claim code for `arrangement: "other"` and none for "covered". Both
 * are real committed states this domain models, and neither has a claim a narrator
 * could make about it that this release can adjudicate: `other` is a style we
 * cannot identify (it fails closed toward the middle in `mechanics.ts`), so no
 * assertion about it is high-confidence wrong, and "covered" belongs to the garment
 * lane's vocabulary rather than to hair's. A missing code produces silence, which is
 * the designed outcome — never a guess.
 */

// ---------------------------------------------------------------------------
// Areas and codes
// ---------------------------------------------------------------------------

/**
 * The claim areas this release adjudicates. One correction per area per turn, so an
 * area is a budget unit as well as a comparison scope.
 */
export const hairClaimAreas = ["wetness_degree", "wetness_cause", "arrangement", "motion", "coverage"] as const;
export type HairClaimArea = (typeof hairClaimAreas)[number];

/** Degree — the ordered `dry < damp < wet < soaked` scale (`phenomena/bands.ts`). */
export const HAIR_CLAIM_WETNESS_DRY = "hair.wetness.dry";
export const HAIR_CLAIM_WETNESS_DAMP = "hair.wetness.damp";
export const HAIR_CLAIM_WETNESS_WET = "hair.wetness.wet";
export const HAIR_CLAIM_WETNESS_SOAKED = "hair.wetness.soaked";

/** Provenance — one code per committed wetting kind, and each names only itself. */
export const HAIR_CLAIM_CAUSE_RAIN = "hair.cause.rain";
export const HAIR_CLAIM_CAUSE_IMMERSION = "hair.cause.immersion";
export const HAIR_CLAIM_CAUSE_SPLASH = "hair.cause.splash";

/** Arrangement — the styles a narrator can assert; `other` has none by design. */
export const HAIR_CLAIM_ARRANGEMENT_LOOSE = "hair.arrangement.loose";
export const HAIR_CLAIM_ARRANGEMENT_PONYTAIL = "hair.arrangement.ponytail";
export const HAIR_CLAIM_ARRANGEMENT_BRAID = "hair.arrangement.braid";
export const HAIR_CLAIM_ARRANGEMENT_BUN = "hair.arrangement.bun";

/**
 * Motion — the whole style moving freely as a mass. ONE code, not a scale: the
 * trial's contradictions were categorical (bound hair described as streaming),
 * never a matter of degree.
 */
export const HAIR_CLAIM_MOTION_FREE_FLOW = "hair.motion.free_flow";

/** Coverage — the only assertable half; see the header on the absent "covered". */
export const HAIR_CLAIM_COVERAGE_UNCOVERED = "hair.coverage.uncovered";

// ---------------------------------------------------------------------------
// The lexicon
// ---------------------------------------------------------------------------

export interface HairClaimDefinition {
  readonly code: string;
  readonly area: HairClaimArea;
  /** Lowercase, trimmed, word-boundary-matched surface fragments. Unique across codes. */
  readonly phrases: readonly string[];
  /** How a prohibition names the claim ("cascading, streaming, or whipping"). */
  readonly display: string;
  /** The committed-truth clause, when there is an honest one ("it remains secured in a braid"). */
  readonly truth?: string;
}

export const hairClaimLexicon: readonly HairClaimDefinition[] = [
  {
    code: HAIR_CLAIM_WETNESS_DRY,
    area: "wetness_degree",
    phrases: ["dry", "bone dry", "bone-dry"],
    display: "dry",
    truth: "it is dry",
  },
  {
    code: HAIR_CLAIM_WETNESS_DAMP,
    area: "wetness_degree",
    phrases: ["damp", "slightly wet", "barely wet", "a little wet"],
    display: "damp",
    truth: "it is damp",
  },
  {
    code: HAIR_CLAIM_WETNESS_WET,
    area: "wetness_degree",
    phrases: ["wet"],
    display: "wet",
    truth: "it is wet",
  },
  {
    code: HAIR_CLAIM_WETNESS_SOAKED,
    area: "wetness_degree",
    // "dripping wet" and "soaking wet" both contain the `wet` phrase above; the
    // matcher prefers the LONGEST phrase within an area, so the stronger reading wins.
    phrases: [
      "soaked",
      "soaking wet",
      "drenched",
      "dripping",
      "dripping wet",
      "sopping",
      "sodden",
      "saturated",
      "waterlogged",
    ],
    display: "soaked",
    truth: "it is soaked through",
  },
  {
    code: HAIR_CLAIM_CAUSE_RAIN,
    area: "wetness_cause",
    phrases: ["rain", "rained", "raining", "rainfall", "rainstorm", "storm", "downpour", "cloudburst"],
    display: "rain",
  },
  {
    code: HAIR_CLAIM_CAUSE_IMMERSION,
    area: "wetness_cause",
    // A bath, a pool, a hot spring. Nothing here can be read as weather, which is
    // the whole reason provenance is a separate area (`frame.ts` on wetting kinds).
    phrases: [
      "bath",
      "bathed",
      "bathwater",
      "pool",
      "lake",
      "river",
      "dunk",
      "dunked",
      "submerged",
      "swim",
      "swam",
      "swimming",
      "hot spring",
      "onsen",
    ],
    display: "a soaking in water",
  },
  {
    code: HAIR_CLAIM_CAUSE_SPLASH,
    area: "wetness_cause",
    phrases: ["splash", "splashed", "spray", "sprayed", "doused", "poured over"],
    display: "a splash",
  },
  {
    code: HAIR_CLAIM_ARRANGEMENT_LOOSE,
    area: "arrangement",
    // "hair down" carries its own reference word on purpose: bare "down" is far too
    // common ("sat down", "looked down") to read as a hairstyle.
    phrases: ["loose", "unbound", "undone", "unpinned", "unbraided", "untied", "hair down"],
    display: "loose",
    truth: "it is worn loose",
  },
  {
    code: HAIR_CLAIM_ARRANGEMENT_PONYTAIL,
    area: "arrangement",
    phrases: ["ponytail", "pony tail"],
    display: "in a ponytail",
    truth: "it remains tied back in a ponytail",
  },
  {
    code: HAIR_CLAIM_ARRANGEMENT_BRAID,
    area: "arrangement",
    phrases: ["braid", "braids", "braided", "plait", "plaits", "plaited"],
    display: "in a braid",
    truth: "it remains secured in a braid",
  },
  {
    code: HAIR_CLAIM_ARRANGEMENT_BUN,
    area: "arrangement",
    phrases: ["bun", "buns", "topknot", "top knot"],
    display: "in a bun",
    truth: "it remains pinned up in a bun",
  },
  {
    code: HAIR_CLAIM_MOTION_FREE_FLOW,
    area: "motion",
    phrases: [
      "streaming",
      "streamed",
      "whipping",
      "whipped",
      "cascading",
      "cascaded",
      "flowing",
      "flowed",
      "billowing",
      "billowed",
      "fanning out",
      "tumbling loose",
      "spilling loose",
    ],
    display: "cascading, streaming, or whipping",
  },
  {
    code: HAIR_CLAIM_COVERAGE_UNCOVERED,
    area: "coverage",
    phrases: ["uncovered", "bare-headed", "bareheaded", "hatless"],
    display: "uncovered",
  },
];

const CLAIM_BY_CODE: ReadonlyMap<string, HairClaimDefinition> = new Map(
  hairClaimLexicon.map((claim) => [claim.code, claim]),
);

/** One claim definition, or `undefined` for a code this domain does not own. */
export function hairClaim(code: string): HairClaimDefinition | undefined {
  return CLAIM_BY_CODE.get(code);
}

// ---------------------------------------------------------------------------
// Reference and anchor vocabulary
// ---------------------------------------------------------------------------

/**
 * Nouns that NAME this domain's subject matter — what a claim has to be attached to
 * before it says anything about this body part.
 *
 * A claim phrase alone is never enough ("the curtains go streaming"), so the lane's
 * detector binds every claim to a reference noun in the SAME clause. The list is
 * deliberately short and concrete: `hair` plus the style nouns this domain already
 * models as arrangements. It carries only single tokens because the binding test is a
 * possessive walk-back over words ("her braid", "your ponytail"), and it names no
 * adjective — "loose" and "unbound" are claims ABOUT hair, not names for it.
 *
 * Being on this list licenses nothing by itself: a reference still needs an accepted
 * possessive and a claim in the same clause before any correction exists.
 */
export const hairReferenceNouns: readonly string[] = [
  "hair",
  "braid",
  "braids",
  "plait",
  "plaits",
  "ponytail",
  "ponytails",
  "bun",
  "buns",
  "topknot",
];

const HAIR_REFERENCE_NOUNS: ReadonlySet<string> = new Set(hairReferenceNouns);

/** Whether one lowercase word token names this domain's subject matter. */
export function isHairReferenceNoun(token: string): boolean {
  return HAIR_REFERENCE_NOUNS.has(token);
}

/**
 * Phrases that assert WETNESS itself — the anchor a provenance claim needs.
 *
 * Provenance is the one area whose vocabulary is ordinary scenery: a storm, a pool, a
 * river, and a bath all appear constantly in prose that asserts nothing about anyone
 * being wet ("your hair gleams in a pool of light", "a storm is approaching"). A cause
 * word therefore only names the reason for a wetting when the same clause SAYS someone
 * got wet, which is what this list is for.
 *
 * Two sources, one list: the wet half of the degree scale (`dry` is excluded — dryness
 * is the absence this anchor exists to distinguish) and the verbs that put water on a
 * surface. Inflections are enumerated for the same reason the claim phrases are — a
 * stemmer's near-misses are the ambiguity that must produce silence.
 *
 * `doused` deliberately appears here AND as a `splash` cause phrase: it is a verb that
 * asserts the wetting on its own, so it anchors itself. The cause NOUNS never do.
 */
export const hairWetnessAnchorPhrases: readonly string[] = [
  // Degree, wet half only.
  "damp",
  "wet",
  "soaked",
  "soaking wet",
  "drenched",
  "dripping",
  "dripping wet",
  "sopping",
  "sodden",
  "saturated",
  "waterlogged",
  // Verbs that put water on a surface.
  "drench",
  "drenches",
  "drenching",
  "soak",
  "soaks",
  "soaking",
  "douse",
  "douses",
  "doused",
  "dousing",
  "wets",
  "wetted",
  "wetting",
  "dampen",
  "dampens",
  "dampened",
  "drip",
  "drips",
  "dripped",
];

/**
 * Whether this text asserts that something is wet or is being wetted.
 *
 * Matched with the same word-boundary rule as the claim phrases, so a cause claim and
 * its anchor can never disagree about what counts as a word.
 */
export function hairAssertsWetness(text: string): boolean {
  const lower = text.toLowerCase();
  return hairWetnessAnchorPhrases.some((phrase) => findPhrase(lower, phrase) >= 0);
}

// ---------------------------------------------------------------------------
// Committed state → claim code
// ---------------------------------------------------------------------------

const WETNESS_CLAIM_CODE: Readonly<Record<HairWetnessBand, string>> = {
  dry: HAIR_CLAIM_WETNESS_DRY,
  damp: HAIR_CLAIM_WETNESS_DAMP,
  wet: HAIR_CLAIM_WETNESS_WET,
  soaked: HAIR_CLAIM_WETNESS_SOAKED,
};

/** The code for a committed degree band. Total — every band has one. */
export function hairWetnessClaimCode(band: HairWetnessBand): string {
  return WETNESS_CLAIM_CODE[band];
}

const CAUSE_CLAIM_CODE: Readonly<Record<HairWettingEventKind, string>> = {
  rain_exposure: HAIR_CLAIM_CAUSE_RAIN,
  immersion: HAIR_CLAIM_CAUSE_IMMERSION,
  splash: HAIR_CLAIM_CAUSE_SPLASH,
};

/** The code for a committed wetting kind. Each kind names only itself. */
export function hairCauseClaimCode(kind: HairWettingEventKind): string {
  return CAUSE_CLAIM_CODE[kind];
}

const ARRANGEMENT_CLAIM_CODE: Readonly<Record<HairArrangement, string | null>> = {
  loose: HAIR_CLAIM_ARRANGEMENT_LOOSE,
  ponytail: HAIR_CLAIM_ARRANGEMENT_PONYTAIL,
  braid: HAIR_CLAIM_ARRANGEMENT_BRAID,
  bun: HAIR_CLAIM_ARRANGEMENT_BUN,
  // A style we cannot identify supports no assertion either way (see the header).
  other: null,
};

/** The code for a committed arrangement, or `null` when the style is unidentified. */
export function hairArrangementClaimCode(arrangement: HairArrangement): string | null {
  return ARRANGEMENT_CLAIM_CODE[arrangement];
}

/** The ordered degree scale, as claim codes — the comparison the detector walks. */
export const hairWetnessClaimScale: readonly string[] = hairWetnessBands.map(hairWetnessClaimCode);

// ---------------------------------------------------------------------------
// Constraint → claim mapping
// ---------------------------------------------------------------------------

/**
 * What each `hair.bulk_restraint` code means to a narrator, for the current cut.
 *
 * A FUNCTION rather than a table because the truth half depends on live state:
 * `bound` forbids the same two claims whatever style produced it, but the clause it
 * licenses is "it remains secured in a braid" or "…tied back in a ponytail"
 * depending on which one actually holds. Unknown inputs yield a mapping with no
 * truth codes — the prohibition still ships and nothing is guessed — which is the
 * shared layer's fourth law applied one level down.
 *
 * `coveredFraction` is not a parameter: coverage licenses no positive hair clause
 * (there is no "covered" claim code — see the header), so its mapping is
 * state-independent and the fence carries the whole instruction.
 */
export function hairClaimMappings(input: {
  readonly arrangement: HairArrangement | null;
  readonly wetnessBand: HairWetnessBand | null;
}): readonly ConstraintClaimMapping[] {
  const arrangementCode = input.arrangement === null ? null : hairArrangementClaimCode(input.arrangement);
  const arrangementTruth = arrangementCode === null ? [] : [arrangementCode];
  const wetnessTruth = input.wetnessBand === null ? [] : [hairWetnessClaimCode(input.wetnessBand)];

  // Bound and pinned forbid the same pair: a style that has captured the length
  // makes both "loose" and "streaming free" false. They stay two mappings because
  // the domain resolves two distinct codes and a reader of the inspector should see
  // which one held.
  const heldByStyle = [HAIR_CLAIM_ARRANGEMENT_LOOSE, HAIR_CLAIM_MOTION_FREE_FLOW];

  return [
    {
      constraintCode: HAIR_PINNED,
      locationId: HAIR_LOCATION_ID,
      prohibitedClaimCodes: heldByStyle,
      truthClaimCodes: arrangementTruth,
      // Arrangement was the trial's most-contradicted axis, and it is the one a
      // player can see they are wrong about — so it outranks the load fences.
      priority: "high",
    },
    {
      constraintCode: HAIR_BOUND,
      locationId: HAIR_LOCATION_ID,
      prohibitedClaimCodes: heldByStyle,
      truthClaimCodes: arrangementTruth,
      priority: "high",
    },
    {
      constraintCode: HAIR_COVERED,
      locationId: HAIR_LOCATION_ID,
      prohibitedClaimCodes: [HAIR_CLAIM_COVERAGE_UNCOVERED, HAIR_CLAIM_MOTION_FREE_FLOW],
      truthClaimCodes: [],
      priority: "normal",
    },
    {
      constraintCode: HAIR_WATER_LOADED,
      locationId: HAIR_LOCATION_ID,
      // Water load stops the mass moving; it says nothing about how the hair is worn,
      // so it forbids only the motion claim.
      prohibitedClaimCodes: [HAIR_CLAIM_MOTION_FREE_FLOW],
      truthClaimCodes: wetnessTruth,
      priority: "normal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Phrase matching
// ---------------------------------------------------------------------------

/** One phrase of one claim, found in one sentence. */
export interface HairClaimMatch {
  readonly code: string;
  readonly area: HairClaimArea;
  /** The lexicon phrase that matched, exactly as authored. */
  readonly phrase: string;
  /** Where it starts in the lowercased sentence — the negation guard reads this. */
  readonly index: number;
}

/** Letters and digits bound a word; punctuation, whitespace, and hyphens do not. */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9]/u.test(character);
}

/** The first word-boundary occurrence of `phrase` in `text`, or `-1`. */
function findPhrase(text: string, phrase: string): number {
  let from = 0;
  for (;;) {
    const index = text.indexOf(phrase, from);
    if (index < 0) return -1;
    const end = index + phrase.length;
    if (!isWordCharacter(text[index - 1]) && !isWordCharacter(text[end])) return index;
    from = index + 1;
  }
}

/**
 * The claims one sentence asserts — at most one per area.
 *
 * Within an area the LONGEST matched phrase wins ("dripping wet" over "wet",
 * "slightly wet" over "wet"), because a longer phrase is a more specific reading of
 * the same words; an exact length tie breaks on the earlier position, so the result
 * is a pure function of the sentence. Areas are walked in lexicon order, so the
 * output order is stable too.
 *
 * The caller supplies a sentence, not a message: everything about authority,
 * negation, hypotheticals, and whose hair it is happens outside this function. All
 * this answers is "which of my phrases are in these words".
 */
export function hairClaimMatches(sentence: string): readonly HairClaimMatch[] {
  const text = sentence.toLowerCase();
  const best = new Map<HairClaimArea, HairClaimMatch>();
  for (const claim of hairClaimLexicon) {
    for (const phrase of claim.phrases) {
      const index = findPhrase(text, phrase);
      if (index < 0) continue;
      const current = best.get(claim.area);
      const better =
        current === undefined ||
        phrase.length > current.phrase.length ||
        (phrase.length === current.phrase.length && index < current.index);
      if (better) best.set(claim.area, { code: claim.code, area: claim.area, phrase, index });
    }
  }
  return hairClaimAreas.flatMap((area) => {
    const match = best.get(area);
    return match === undefined ? [] : [match];
  });
}
