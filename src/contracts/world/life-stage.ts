/**
 * Life-stage bands derived from the free-text `profile.age`
 * (docs/developer-notes/character-fidelity.plan.md slices 1–2). The narrator gets
 * "You are 15 years old." and a generic speak-your-age rule, which models resolve
 * to their adult-competent default register — children and teens end up sounding
 * like therapists. These bands turn a numeric age into the same shape the trait
 * registry uses: a `promptHint` phrase for the identity/canonical-facts line, and
 * binding `registerRules` for the stages whose register genuinely constrains
 * prose (child/teen/elder today). The registry is the contract — adding or
 * re-ranging a band is a data edit here, never a migration.
 *
 * Parsing is deliberately conservative, mirroring `formatAge`: a bare numeral
 * ("15" — the shape the editor hint suggests for humans), or a numeral in the
 * tightly whitelisted "years" spellings ("17 years", "17 years old" — owner
 * instruction 2026-07-30, pre-slice-3 eligibility follow-ups). Blank, word
 * phrases ("ancient", "seventeen"), other units, and numbers past the human
 * scale (> {@link LIFE_STAGE_MAX_HUMAN_YEARS} — "312 years" included) map to
 * nothing — fantasy ages are species-scaled, and forcing a 312-year-old elf
 * into a human elder register would be wrong. No band ⇒ every consumer renders
 * exactly what it does today.
 */

export interface LifeStageBand {
  /** Stable id (kept string-typed for forward-compatible band additions). */
  id: string;
  /** Reader-facing label used inside register-rule headings ("a teenager"). */
  label: string;
  /** Inclusive year range this band covers. */
  min: number;
  max: number;
  /**
   * One-phrase register hint appended to the age line in the chat identity block
   * and the session canonical-facts line. "" for the unmarked default (adult) —
   * the age line then renders exactly as before.
   */
  promptHint: string;
  /**
   * Binding enactment rules rendered as a dedicated "Life stage" block, written
   * in the second person for the 1-on-1 chat lane. Only stages whose register
   * genuinely constrains prose carry any; an empty list renders no block.
   */
  registerRules: readonly string[];
  /**
   * The register compressed to ONE third-person line for surfaces that narrate
   * the character by name (ensemble member sheets). `{name}` is replaced by the
   * display name via `lifeStageThirdPersonLine`. "" when the stage carries no
   * register rules.
   */
  thirdPersonRule: string;
  /**
   * Below adulthood — fences every intimate prompt surface (intimate disposition
   * bands, disinhibition, intimate-craft rules, selfie license, the relationship
   * escalation line) and flips the content framing to romance-out-of-scope.
   */
  minor: boolean;
}

/** Bare numbers past this are fantasy-scaled (species-dependent) — no band. */
export const LIFE_STAGE_MAX_HUMAN_YEARS = 120;

export const LIFE_STAGES: readonly LifeStageBand[] = [
  {
    id: "child",
    label: "a child",
    min: 0,
    max: 12,
    minor: true,
    promptHint: "a child, with a child's vocabulary, concerns, and understanding of the world",
    registerRules: [
      "Speak like a real child: short, concrete sentences; simple words; feelings stated plainly or shown in behavior (sulking, bouncing, going quiet) rather than articulated.",
      "Your knowledge stops at a child's world — school, family, games, friends. Adult topics (money, work, romance, politics) get a child's read: confusion, boredom, a literal-minded question, or a change of subject. Never offer insight or advice beyond your years.",
      "No composed, therapeutic, or reflective language: a child does not analyze feelings, weigh nuance, or comfort adults with wisdom. Impatience, wonder, and bluntness are your registers.",
    ],
    thirdPersonRule:
      "{name} speaks and thinks like a real child — short concrete sentences, big plainly-shown feelings, a child's knowledge of the world; never insight, advice, or composure beyond {name}'s years.",
  },
  {
    id: "teen",
    label: "a teenager",
    min: 13,
    max: 17,
    minor: true,
    promptHint: "a teenager — teen diction and preoccupations, life experience bounded by school years",
    registerRules: [
      "Sound like an actual teenager: casual current diction, absolutes and exaggeration, self-consciousness about how you come across, deflection with humor or an eye-roll when something cuts close.",
      "Your life experience is school-sized: friends, family, classes, first jobs, what's online. You hold opinions past your experience and it shows. Adult troubles get a teenager's read — never a counselor's.",
      "Never wise beyond your years: no measured life advice, no serene emotional insight, no world-weariness. When a moment is genuinely heavy, awkwardness, deflection, or overwhelmed silence is truer than eloquence.",
    ],
    thirdPersonRule:
      "{name} speaks and thinks like an actual teenager — casual current diction, school-sized life experience, deflection when things cut close; never wise or composed beyond {name}'s years.",
  },
  {
    id: "young_adult",
    label: "a young adult",
    min: 18,
    max: 25,
    minor: false,
    promptHint: "a young adult — early-adult footing, edges still forming, current references",
    registerRules: [],
    thirdPersonRule: "",
  },
  {
    id: "adult",
    label: "an adult",
    min: 26,
    max: 39,
    minor: false,
    // The unmarked default: the age line renders exactly as before.
    promptHint: "",
    registerRules: [],
    thirdPersonRule: "",
  },
  {
    id: "middle_aged",
    label: "middle-aged",
    min: 40,
    max: 64,
    minor: false,
    promptHint: "middle-aged — settled diction, references a generation back, less need to impress",
    registerRules: [],
    thirdPersonRule: "",
  },
  {
    id: "elder",
    label: "an elder",
    min: 65,
    max: LIFE_STAGE_MAX_HUMAN_YEARS,
    minor: false,
    promptHint: "an elder — an older voice, unhurried, era-anchored references, economy over performance",
    registerRules: [
      "Speak from a long life: an unhurried rhythm, fewer words doing more, references anchored a generation or two back. You have seen most conversational gambits before, and gentle amusement or plain directness comes easier than performance.",
    ],
    thirdPersonRule:
      "{name} speaks from a long life — unhurried, fewer words doing more, references anchored a generation or two back.",
  },
];

/**
 * The numeral inside a tightly whitelisted age spelling, or undefined.
 *
 * The whitelist is exactly: the numeral alone, or the numeral followed by
 * "year"/"years", optionally "old" — "17", "17 years", "17 years old". Nothing
 * looser: word numbers ("seventeen"), other units, and surrounding prose stay
 * unrecognized, because every widening of this parser widens what the minor
 * fence and the eligibility resolver treat as a known number.
 */
export function numericAgeText(age: string): string | undefined {
  const match = /^(-?\d+(?:\.\d+)?)(?:\s+years?(?:\s+old)?)?$/iu.exec(age.trim());
  return match?.[1];
}

/**
 * Resolve a free-text age to its life-stage band. Only a whitelisted numeral
 * spelling within the human scale maps ("15", "15 years", "15 years old");
 * everything else (blank, "ancient", "312 years", "500") is undefined — the
 * degraded default is today's behavior exactly.
 */
export function lifeStageForAge(age: string): LifeStageBand | undefined {
  const numeral = numericAgeText(age);
  // Bands stay integer, non-negative, human-scale — "17.5" and "-5" are the
  // eligibility resolver's stricter business, not a register band.
  if (numeral === undefined || !/^\d+$/.test(numeral)) return undefined;
  const years = Number.parseInt(numeral, 10);
  if (years > LIFE_STAGE_MAX_HUMAN_YEARS) return undefined;
  return LIFE_STAGES.find((band) => years >= band.min && years <= band.max);
}

/** Whether the authored age reads as a minor (fences every intimate prompt surface). */
export function isMinorAge(age: string): boolean {
  return lifeStageForAge(age)?.minor ?? false;
}

/**
 * The register as one third-person line for by-name surfaces (ensemble member
 * sheets, session casts). "" when the stage carries no register rules.
 */
export function lifeStageThirdPersonLine(stage: LifeStageBand | undefined, name: string): string {
  if (!stage?.thirdPersonRule) return "";
  return stage.thirdPersonRule.replaceAll("{name}", name);
}
