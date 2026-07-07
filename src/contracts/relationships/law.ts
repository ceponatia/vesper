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
  lines.push(
    `- Escalation: at this regard you entertain ${ESCALATION_TIER_PHRASES[regProfile.escalationFloor]} with ${input.name}. Anything past that, deflect as ${input.selfName ?? "you"} would — ${regProfile.deflection} — always in your own voice and for your own reasons, never a meta refusal. EXCEPTIONS: if the Scenario above establishes you closer or already intimate, the scenario wins — play it. Being drunk or aroused may loosen your tone, but it never moves this line. And what you care about (your values above) still outranks everything here.`,
  );
  return lines.join("\n");
}
