import { familiarityBandForValue, regardBandForValue } from "./bands";
import type { EscalationTier } from "./profile";
import type { PresentedMask } from "./record";

/**
 * The composed relationship law (relationship-model.plan.md §"What the LLM
 * sees"): two band-profile tables (5 familiarity + 10 regard) replace the 11
 * conflated stage profiles — composition happens in prose assembly, so there is
 * no M×N explosion. A sparse combo table covers the special corners. The
 * composition rules this encodes:
 *
 * - **Openness = min(familiarity ceiling, regard willingness)** — the
 *   familiarity line grants what CAN be referenced, the regard line decides what
 *   IS given ("you could finish his sentences, but you won't give him anything").
 * - **Address**: familiarity grants the register; regard decides whether it is
 *   spoken warmly or used as a weapon (the tone line).
 * - **Initiative**: familiarity makes initiating easy; regard makes it wanted.
 * - **Escalation floor is keyed to REGARD** (later regard × attraction), with the
 *   D11 exceptions unchanged: premise wins, disinhibition never raises the
 *   floor, authored values trump everything.
 *
 * Pure prose assembly — the chat prompt builder (slice 3) calls
 * `composeRelationshipLaw`; the sessions lane keeps `profile.ts` until its
 * refactor (plan slice 7).
 */

/** Reader-facing phrase per escalation tier (the D11 floor rendered as law). */
export const ESCALATION_TIER_PHRASES: Record<EscalationTier, string> = {
  distant: "no romantic or physical escalation at all",
  flirtation: "light flirtation, nothing physical",
  affectionate_touch: "warm, affectionate touch",
  heated: "heated kisses and close contact, stopping short of intimacy",
  intimate: "full intimacy",
};

export interface FamiliarityBandProfile {
  bandId: string;
  /** The register familiarity grants — name/nickname rights. Prompt phrase. */
  address: string;
  /** What can be assumed and referenced — the disclosure/knowledge ceiling. Prompt phrase. */
  reference: string;
  /** How well they read the other. Prompt phrase. */
  reading: string;
}

const familiarityProfiles: readonly FamiliarityBandProfile[] = [
  {
    bandId: "strangers",
    address: "no name rights beyond whatever the introduction gave you",
    reference: "you can assume nothing about them — everything must be learned in the scene",
    reading: "their moods are opaque; you read only what anyone could see",
  },
  {
    bandId: "introduced",
    address: "you have their name and use it a little carefully",
    reference: "you know the outline — name, face, the obvious facts; the rest is guesswork",
    reading: "you catch only their loudest signals",
  },
  {
    bandId: "acquainted",
    address: "first names come naturally now",
    reference: "you can reference what they've told you and the time you've shared",
    reading: "you notice their bigger tells",
  },
  {
    bandId: "familiar",
    address: "first names and any nicknames are yours to use",
    reference: "shared history is yours to reference freely — habits, stories, sore spots you've seen",
    reading: "you read their moods with practiced ease",
  },
  {
    bandId: "deeply_known",
    address: "first names and old nicknames are yours; formality between you would be a statement",
    reference: "you could finish their sentences — history, habits, wounds, the whole map is yours to reference",
    reading: "you read them at a glance, even what they try to hide",
  },
];

export interface RegardBandProfile {
  bandId: string;
  /** What they feel — the core stance. Prompt phrase. */
  feeling: string;
  /** The DESIRE to initiate (familiarity supplies the ease). Prompt phrase. */
  initiative: string;
  /** What regard is WILLING to give — the other half of the openness min(). Prompt phrase. */
  willingness: string;
  /** The escalation acceptance floor (D11), keyed to regard. */
  escalationFloor: EscalationTier;
  /** A one-phrase gloss of what past-the-floor deflection sounds like at this regard. */
  deflection: string;
}

const regardProfiles: readonly RegardBandProfile[] = [
  {
    bandId: "hostile",
    feeling: "you want them gone, beaten, or proven wrong",
    initiative: "you initiate only to strike or to end the encounter",
    willingness: "you give them nothing — not answers, not comfort, not the benefit of the doubt",
    escalationFloor: "distant",
    deflection: "a flat, hostile shutdown — contempt that ends the subject",
  },
  {
    bandId: "wary",
    feeling: "you don't trust them and expect the worst",
    initiative: "you don't seek them out — you watch, and let them carry the conversation",
    willingness: "you volunteer nothing that could be used against you",
    escalationFloor: "distant",
    deflection: "a wary step back — suspicion of the motive behind the advance",
  },
  {
    bandId: "cool",
    feeling: "you dislike them — politely; their charm doesn't land on you",
    initiative: "you don't reach out; encounters are endured, not sought",
    willingness: "you give them nothing you don't have to — courtesy is the whole offer",
    escalationFloor: "flirtation",
    deflection: "an unimpressed brush-off — polite, final, faintly amused at most",
  },
  {
    bandId: "neutral",
    feeling: "no real feelings yet either way — they are what they've shown you",
    initiative: "occasional, socially safe overtures — nothing exposed",
    willingness: "you engage as the moment requires and disclose little beyond it",
    escalationFloor: "flirtation",
    deflection: "a light sidestep — 'we barely know where this stands' in their own voice",
  },
  {
    bandId: "friendly",
    feeling: "you like them and enjoy their company",
    initiative: "comfortable initiating — you start topics, propose plans, tease first",
    willingness: "you share opinions and stories freely; the tender spots stay covered",
    escalationFloor: "affectionate_touch",
    deflection: "a laughing redirect — keeps the warmth's shape without wounding",
  },
  {
    bandId: "warm",
    feeling: "you care about them and it shows at the edges",
    initiative: "you seek them out — the first move is often yours",
    willingness: "you volunteer feelings and admit to caring; vulnerability shows at the edges",
    escalationFloor: "heated",
    deflection: "a breathless not-yet — wanting is visible, the brake is your own pace",
  },
  {
    bandId: "close",
    feeling: "they matter to you — one of the people your day bends around",
    initiative: "you lead as often as follow — plans, contact, and touch come naturally",
    willingness: "genuinely open — you share fears and wants and trust them with the unguarded version",
    escalationFloor: "intimate",
    deflection: "an honest pause — closeness makes 'not now' a promise, not a wall",
  },
  {
    bandId: "cherished",
    feeling: "you cherish them — their presence is something you protect",
    initiative: "bold — you reach for them first and make space for the two of you unprompted",
    willingness: "few walls left — you think out loud with them and ask for what you need",
    escalationFloor: "intimate",
    deflection: "tender redirection — nothing is refused for lack of wanting",
  },
  {
    bandId: "devoted",
    feeling: "devoted — where they are is halfway to home",
    initiative: "unhesitating — their presence is assumed into your plans and your orbit",
    willingness: "transparent — secrets feel like debts you hurry to pay down",
    escalationFloor: "intimate",
    deflection: "gentle, momentary — devotion defers, it does not refuse",
  },
  {
    bandId: "smitten",
    feeling: "smitten — you cannot play it cool and have stopped trying",
    initiative: "helplessly forward — the first move escapes you before you decide on it",
    willingness: "spills over — feelings arrive unfiltered and slightly out of order",
    escalationFloor: "intimate",
    deflection: "flustered and fleeting — the no dissolves into a when",
  },
];

const familiarityByBand = new Map(familiarityProfiles.map((p) => [p.bandId, p]));
const regardByBand = new Map(regardProfiles.map((p) => [p.bandId, p]));

const strangersProfile = familiarityByBand.get("strangers") as FamiliarityBandProfile;
const neutralProfile = regardByBand.get("neutral") as RegardBandProfile;

/** The familiarity profile for a band id; an unknown id heals to `strangers`. */
export function familiarityBandProfile(bandId: string): FamiliarityBandProfile {
  return familiarityByBand.get(bandId) ?? strangersProfile;
}

/** The regard profile for a band id; an unknown id heals to `neutral`. */
export function regardBandProfile(bandId: string): RegardBandProfile {
  return regardByBand.get(bandId) ?? neutralProfile;
}

/** Band ids missing a profile — asserted empty by the registry tests. */
export function familiarityBandsMissingProfiles(bandIds: readonly string[]): string[] {
  return bandIds.filter((id) => !familiarityByBand.has(id));
}
export function regardBandsMissingProfiles(bandIds: readonly string[]): string[] {
  return bandIds.filter((id) => !regardByBand.has(id));
}

/**
 * The sparse corner table: one extra law line for (familiarity, regard) combos
 * whose character isn't the sum of the two profiles. Keyed `${fam}|${regard}`;
 * absence means the composed lines carry it.
 */
const comboNotes: Readonly<Record<string, string>> = {
  "familiar|hostile":
    "The intimate enemy: you know exactly where to cut, and you know it will land — using that knowledge costs you something every time.",
  "deeply_known|hostile":
    "The intimate enemy: you know exactly where to cut, and you know it will land — using that knowledge costs you something every time.",
  "familiar|cool":
    "Familiarity is not warmth: you could talk all night and give away nothing — ease without a single opened door.",
  "deeply_known|cool":
    "Familiarity is not warmth: you could finish their sentences, but you won't give them anything that isn't required.",
  "strangers|devoted":
    "You barely know them and it doesn't matter — enormous feeling with almost nothing yet to hang it on.",
  "strangers|smitten":
    "You barely know them and it doesn't matter — enormous feeling with almost nothing yet to hang it on.",
};

export function comboNote(familiarityBandId: string, regardBandId: string): string | undefined {
  return comboNotes[`${familiarityBandId}|${regardBandId}`];
}

/**
 * Region label for the 2D matrix visual (ruled in 2026-07-07): named corners,
 * with a plain "Familiar · Cool" composition everywhere else. UI-only sugar —
 * never rendered into prompts.
 */
const regionLabels: Readonly<Record<string, string>> = {
  "strangers|hostile": "Bad blood on sight",
  "introduced|hostile": "Enemies",
  "familiar|hostile": "Old enemy",
  "deeply_known|hostile": "Old enemy",
  "familiar|cool": "Estranged",
  "deeply_known|cool": "Estranged",
  "strangers|friendly": "Instant chemistry",
  "strangers|warm": "Instant chemistry",
  "strangers|neutral": "Strangers",
  "deeply_known|close": "Inseparable",
  "deeply_known|cherished": "Beloved",
  "deeply_known|devoted": "Beloved",
  "deeply_known|smitten": "Beloved",
};

export function relationshipRegionLabel(familiarity: number, regard: number): string {
  const fam = familiarityBandForValue(familiarity);
  const reg = regardBandForValue(regard);
  return regionLabels[`${fam.id}|${reg.id}`] ?? `${fam.label} · ${reg.label}`;
}

/** Authored warmth lean at or past this reads as a general disposition worth contrasting. */
const CONTRAST_WARMTH_LEAN = 20;

/**
 * The disposition-contrast line (plan §Disposition interplay 3): when regard's
 * sign disagrees with the authored warmth lean, the divergence is stated
 * explicitly — the contrast IS the characterization ("curt with everyone; Mara
 * is the exception") — instead of leaving the trope for the model to infer from
 * two distant blocks. "" when they agree, when regard is neutral, or when no
 * warmth was authored.
 */
export function dispositionContrastLine(input: { name: string; warmth: number; regard: number }): string {
  if (input.warmth <= -CONTRAST_WARMTH_LEAN && input.regard >= 15) {
    return `You are curt and guarded with people in general; ${input.name} is one of the few exceptions — around ${input.name}, the guard drops.`;
  }
  if (input.warmth >= CONTRAST_WARMTH_LEAN && input.regard <= -15) {
    return `You are warm with people in general; ${input.name} is a pointed exception — with ${input.name}, the warmth does not come.`;
  }
  return "";
}

export interface ComposeRelationshipLawInput {
  /** The other party's display name (the edge's target). */
  name: string;
  /** The record holder's own name, for deflection flavor; defaults to "you". */
  selfName?: string;
  /** Familiarity scalar 0..100. */
  familiarity: number;
  /** Regard scalar −100..100. */
  regard: number;
  kind?: string;
  history?: string;
  presented?: PresentedMask;
  /**
   * Drop the escalation-floor bullet entirely (character-fidelity slice 2): set
   * for an authored minor, where the content framing rules romance wholly out of
   * scope — an escalation floor would imply the territory exists to escalate into.
   */
  omitEscalation?: boolean;
}

/** The Outwardly line: how the mask performs, both leans, with optional authored flavor. */
function presentedLine(name: string, presented: PresentedMask): string {
  const flavor = presented.note.trim();
  const base =
    presented.lean === "masks_warmth"
      ? `you perform colder toward ${name} than you feel — the warmth is real and it is hidden, surfacing only when you're caught off guard`
      : `you perform warmer toward ${name} than you feel — the courtesy is a mask, and what you actually feel shows in what you don't say`;
  return flavor ? `Outwardly: ${base}. The performance reads as: ${flavor}.` : `Outwardly: ${base}.`;
}

/**
 * The composed relationship law block (plan §"What the LLM sees"): history →
 * familiarity → regard → mask → combo corner → escalation, each line keyed to
 * its own axis. Re-rendered only on a band change, so it lives in the prompt's
 * stable prefix.
 */
export function composeRelationshipLaw(input: ComposeRelationshipLawInput): string {
  const fam = familiarityBandForValue(input.familiarity);
  const reg = regardBandForValue(input.regard);
  const famProfile = familiarityBandProfile(fam.id);
  const regProfile = regardBandProfile(reg.id);

  const lines: string[] = [
    `Relationship with ${input.name} (this governs your behavior; never recite it):`,
  ];
  const kind = input.kind?.trim();
  const history = input.history?.trim();
  if (kind || history) {
    const label = kind ? `${kind}. ` : "";
    lines.push(`- History: ${label}${history ?? ""}`.trimEnd());
  }
  lines.push(
    `- Familiarity (${fam.label.toLowerCase()}): ${famProfile.address}; ${famProfile.reference}; ${famProfile.reading}.`,
  );
  lines.push(
    `- Regard (${reg.label.toLowerCase()}): ${regProfile.feeling}. Initiative: ${regProfile.initiative}. Openness: ${regProfile.willingness} — within what familiarity above even allows.`,
  );
  if (input.presented) lines.push(`- ${presentedLine(input.name, input.presented)}`);
  const corner = comboNote(fam.id, reg.id);
  if (corner) lines.push(`- ${corner}`);
  if (!input.omitEscalation) {
    lines.push(
      `- Escalation: at this regard you entertain ${ESCALATION_TIER_PHRASES[regProfile.escalationFloor]} with ${input.name}. Anything past that, deflect as ${input.selfName ?? "you"} would — ${regProfile.deflection} — always in your own voice and for your own reasons, never a meta refusal. EXCEPTIONS: if the Scenario above establishes you closer or already intimate, the scenario wins — play it. Being drunk or aroused may loosen your tone, but it never moves this line. And what you care about (your values above) still outranks everything here.`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Third-person pair law (followups ruling 6): the same band semantics rendered
// for an ENSEMBLE narrator, where "you" belongs to the player alone. Name-based
// phrasing (never pronouns), so no gender plumbing; one paragraph-bullet per
// directed edge keeps 12 worst-case edges affordable.
// ---------------------------------------------------------------------------

type PairPhrase = (a: string, b: string) => string;

const familiarityThird: ReadonlyMap<string, PairPhrase> = new Map<string, PairPhrase>([
  [
    "strangers",
    (a, b) =>
      `${a} has no name rights with ${b} beyond whatever an introduction gave, can assume nothing about ${b}, and reads only what anyone could see`,
  ],
  [
    "introduced",
    (a, b) =>
      `${a} has ${b}'s name and uses it a little carefully, knows only the outline of ${b}, and catches only the loudest signals`,
  ],
  [
    "acquainted",
    (a, b) =>
      `first names come naturally; ${a} can reference what ${b} has shared and the time together, and notices ${b}'s bigger tells`,
  ],
  [
    "familiar",
    (a, b) =>
      `first names and nicknames are ${a}'s to use; shared history — habits, stories, sore spots — is ${a}'s to reference freely, and ${a} reads ${b}'s moods with practiced ease`,
  ],
  [
    "deeply_known",
    (a, b) =>
      `${a} could finish ${b}'s sentences — history, habits, wounds, the whole map — and reads ${b} at a glance, even what ${b} tries to hide`,
  ],
]);

const regardThird: ReadonlyMap<string, PairPhrase> = new Map<string, PairPhrase>([
  [
    "hostile",
    (a, b) =>
      `${a} wants ${b} gone, beaten, or proven wrong — initiates only to strike or end the encounter, and gives ${b} nothing: not answers, not comfort, not the benefit of the doubt`,
  ],
  [
    "wary",
    (a, b) =>
      `${a} doesn't trust ${b} and expects the worst — never seeks ${b} out, watches, and volunteers nothing that could be used against ${a}`,
  ],
  [
    "cool",
    (a, b) =>
      `${a} dislikes ${b} — politely; ${b}'s charm doesn't land, encounters are endured rather than sought, and courtesy is the whole offer`,
  ],
  [
    "neutral",
    (a, b) =>
      `${a} has no real feelings about ${b} yet either way — safe, occasional overtures, engaging as the moment requires and disclosing little`,
  ],
  [
    "friendly",
    (a, b) =>
      `${a} likes ${b} and enjoys the company — starts topics, proposes plans, teases first; opinions and stories flow freely while the tender spots stay covered`,
  ],
  [
    "warm",
    (a, b) =>
      `${a} cares about ${b} and it shows at the edges — often the one to reach out, volunteering feelings and admitting to caring`,
  ],
  [
    "close",
    (a, b) =>
      `${b} matters to ${a} — one of the people ${a}'s day bends around; plans, contact, and touch come naturally, and ${a} trusts ${b} with the unguarded version`,
  ],
  [
    "cherished",
    (a, b) => `${a} cherishes ${b} and protects ${b}'s presence in ${a}'s life — bold in reaching out, with few walls left`,
  ],
  [
    "devoted",
    (a, b) =>
      `${a} is devoted to ${b} — where ${b} is feels halfway to home; ${b} is assumed into ${a}'s plans, and secrets feel like debts`,
  ],
  [
    "smitten",
    (a, b) =>
      `${a} is smitten with ${b} and cannot play it cool — the first move escapes ${a} before deciding on it, feelings arriving unfiltered`,
  ],
]);

const intimateEnemyThird: PairPhrase = (a, b) =>
  `The intimate enemy: ${a} knows exactly where to cut ${b}, and knows it will land — using that knowledge costs ${a} something every time.`;
const strangerDevotionThird: PairPhrase = (a, b) =>
  `${a} barely knows ${b} and it doesn't matter — enormous feeling with almost nothing yet to hang it on.`;

const comboThird: ReadonlyMap<string, PairPhrase> = new Map<string, PairPhrase>([
  ["familiar|hostile", intimateEnemyThird],
  ["deeply_known|hostile", intimateEnemyThird],
  [
    "familiar|cool",
    (a, b) =>
      `Familiarity is not warmth: ${a} could talk with ${b} all night and give away nothing — ease without a single opened door.`,
  ],
  [
    "deeply_known|cool",
    (a, b) => `Familiarity is not warmth: ${a} could finish ${b}'s sentences, but won't give ${b} anything that isn't required.`,
  ],
  ["strangers|devoted", strangerDevotionThird],
  ["strangers|smitten", strangerDevotionThird],
]);

export interface ComposePairLawInput {
  fromName: string;
  toName: string;
  familiarity: number;
  regard: number;
  kind?: string;
  history?: string;
  presented?: PresentedMask;
}

/**
 * One directed edge of the pair law, third person (followups ruling 6): the
 * full band semantics — knowledge ceiling, feeling/initiative/openness, mask,
 * corner note, escalation floor — as a single paragraph-bullet. Used for the
 * ensemble's present-pair section; the second-person block above stays the
 * player edge's.
 */
export function composePairRelationshipLaw(input: ComposePairLawInput): string {
  const a = input.fromName.trim() || "This character";
  const b = input.toName.trim() || "the other";
  const fam = familiarityBandForValue(input.familiarity);
  const reg = regardBandForValue(input.regard);
  const kind = input.kind?.trim();
  const history = input.history?.trim();
  const mask =
    input.presented?.lean === "masks_warmth"
      ? `Outwardly ${a} performs colder toward ${b} than ${a} feels — the warmth is real and hidden, surfacing only when caught off guard${input.presented.note.trim() ? ` (reads as: ${input.presented.note.trim()})` : ""}.`
      : input.presented?.lean === "masks_dislike"
        ? `Outwardly ${a} performs warmer toward ${b} than ${a} feels — the courtesy is a mask, and what ${a} actually feels shows in what ${a} doesn't say${input.presented.note.trim() ? ` (reads as: ${input.presented.note.trim()})` : ""}.`
        : "";
  const corner = comboThird.get(`${fam.id}|${reg.id}`);
  const famPhrase = familiarityThird.get(fam.id) ?? familiarityThird.get("strangers");
  const regPhrase = regardThird.get(reg.id) ?? regardThird.get("neutral");
  const parts = [
    `${a} → ${b}${kind ? ` (${kind})` : ""}:`,
    history ? `${history}.` : "",
    `Familiarity (${fam.label.toLowerCase()}): ${famPhrase?.(a, b) ?? ""}.`,
    `Regard (${reg.label.toLowerCase()}): ${regPhrase?.(a, b) ?? ""}.`,
    mask,
    corner ? corner(a, b) : "",
    `Between them, ${a} entertains at most ${ESCALATION_TIER_PHRASES[regardBandProfile(reg.id).escalationFloor]} with ${b}; past that ${a} deflects in ${a}'s own voice — unless the Scenario establishes them closer, which wins.`,
  ].filter(Boolean);
  return parts.join(" ");
}
