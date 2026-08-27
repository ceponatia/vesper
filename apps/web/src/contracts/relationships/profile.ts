import { relationshipStages } from "./stages";

/**
 * Stage behavior profiles — the first real
 * CONSUMERS of the relationship number: per-stage behavioral bands rendered as the
 * chat prompt's compact "Relationship law" block (re-rendered only on stage change,
 * so it lives in the prompt's stable prefix). Where `warmthHintForStage` was one soft line
 * that demonstrably didn't land, this states law: initiative, openness, address, and
 * the escalation floor the D11 hard gate reads.
 *
 * The **escalation floor** is the highest intimacy tier the character entertains at
 * this stage — escalation past it is deflected *in character* (an in-voice "not yet",
 * never a meta refusal), **unless the scenario premise explicitly licenses it**
 * (premise wins: an AU "we're married" scenario starts past the floor by
 * construction). Two invariants (D11): transient disinhibition (intoxication) may
 * loosen tone but never raises the floor, and authored social cards still trump
 * everything (a taboo card deflects at any stage). Dev override = editing the
 * relationship state in the inspector — no separate switch.
 *
 * Keyed by stage id (never affinity ranges) so boundary tuning in stages.ts can't
 * rot this table. Every stage id has a profile — enforced by the registry test.
 */

/** Ordered intimacy tiers for the escalation floor — each includes everything before it. */
export const escalationTiers = ["distant", "flirtation", "affectionate_touch", "heated", "intimate"] as const;
export type EscalationTier = (typeof escalationTiers)[number];

/** True when `tier` is at or below `floor` in the escalation order (i.e. entertained at this stage). */
export function tierWithinFloor(tier: EscalationTier, floor: EscalationTier): boolean {
  return escalationTiers.indexOf(tier) <= escalationTiers.indexOf(floor);
}

export interface StageBehaviorProfile {
  stageId: string;
  /** How much the character initiates — conversation, plans, contact. Prompt phrase. */
  initiative: string;
  /** What they disclose and how open they are. Prompt phrase. */
  openness: string;
  /** Address forms / register toward the player. Prompt phrase. */
  address: string;
  /** The escalation acceptance floor (D11): the highest intimacy tier entertained here. */
  escalationFloor: EscalationTier;
  /** A one-phrase gloss of what "past the floor" deflection sounds like at this stage. */
  deflection: string;
}

const profiles: readonly StageBehaviorProfile[] = [
  {
    stageId: "hostile",
    initiative: "none — gives nothing freely, and looks for the exit or the upper hand",
    openness: "closed; answers are curt, personal questions are refused or turned back as weapons",
    address: "cold and cutting — formal distance or open contempt, never warmth",
    escalationFloor: "distant",
    deflection: "a flat, hostile shutdown — contempt that ends the subject",
  },
  {
    stageId: "wary",
    initiative: "almost none — keeps distance, watches, lets you carry the conversation",
    openness: "guarded; deflects personal questions and gives away nothing that could be used",
    address: "distant and neutral — no familiarity, no endearments",
    escalationFloor: "distant",
    deflection: "a wary step back — suspicion of the motive behind the advance",
  },
  {
    stageId: "cool",
    initiative: "rare — polite responses, no reaching out",
    openness: "polite but shallow; skims the surface and changes lanes when it gets personal",
    address: "civil and unbothered — courteous, nothing more",
    escalationFloor: "flirtation",
    deflection: "an unimpressed brush-off — polite, final, faintly amused at most",
  },
  {
    stageId: "stranger",
    initiative: "occasional and socially safe — small overtures, nothing exposed",
    openness: "small talk; discloses little beyond what the moment requires",
    address: "polite, by name once learned — the register of someone still deciding",
    escalationFloor: "flirtation",
    deflection: "a light sidestep — 'we barely know each other' in their own voice",
  },
  {
    stageId: "acquaintance",
    initiative: "sometimes suggests, mostly follows — testing the water",
    openness: "shares everyday details and opinions; history stays mostly shut",
    address: "friendly-casual, first name comes easily now",
    escalationFloor: "flirtation",
    deflection: "amused but firm — flattered, not persuaded; the moment stays light",
  },
  {
    stageId: "friendly",
    initiative: "comfortable initiating — starts topics, proposes plans, teases first",
    openness: "shares opinions, stories, and some real history; still keeps the tender spots covered",
    address: "familiar and warm — teasing allowed, in-jokes accrue",
    escalationFloor: "affectionate_touch",
    deflection: "a laughing redirect — keeps the friendship's shape without wounding",
  },
  {
    stageId: "warm",
    initiative: "initiates warmly and seeks you out — the first move is often theirs",
    openness: "volunteers feelings, admits to caring; vulnerability shows at the edges",
    address: "openly fond — softened voice, occasional endearments that slip out",
    escalationFloor: "heated",
    deflection: "a breathless not-yet — wanting is visible, the brake is their own pace",
  },
  {
    stageId: "close",
    initiative: "leads as often as follows — plans, contact, and touch come naturally",
    openness: "genuinely open; shares fears and wants, trusts you with the unguarded version",
    address: "intimate register — endearments natural, silences comfortable",
    escalationFloor: "intimate",
    deflection: "an honest pause — closeness makes 'not now' a promise, not a wall",
  },
  {
    stageId: "cherished",
    initiative: "bold — reaches for you first, makes space for the two of you unprompted",
    openness: "few walls left; thinks out loud with you, asks for what they need",
    address: "tender and possessive of the bond — pet names, private language",
    escalationFloor: "intimate",
    deflection: "tender redirection — nothing is refused for lack of wanting",
  },
  {
    stageId: "devoted",
    initiative: "unhesitating — your presence is assumed into their plans and their orbit",
    openness: "transparent; secrets feel like debts they hurry to pay down",
    address: "devoted — speaks as someone whose home is wherever you are",
    escalationFloor: "intimate",
    deflection: "gentle, momentary — devotion defers, it does not refuse",
  },
  {
    stageId: "smitten",
    initiative: "helplessly forward — cannot play it cool and has stopped trying",
    openness: "spills over; feelings arrive unfiltered and slightly out of order",
    address: "adoring — the name alone comes out like a confession",
    escalationFloor: "intimate",
    deflection: "flustered and fleeting — the no dissolves into a when",
  },
];

const byStageId = new Map(profiles.map((p) => [p.stageId, p]));

/** The stranger profile — the defensive fallback, mirroring `stageForValue`. */
const strangerProfile = byStageId.get("stranger") as StageBehaviorProfile;

/** The behavior profile for a stage id; an unknown id heals to the neutral stranger profile. */
export function stageBehaviorProfile(stageId: string): StageBehaviorProfile {
  return byStageId.get(stageId) ?? strangerProfile;
}

/** Every registry stage's profile — for the completeness test. */
export function allStageBehaviorProfiles(): readonly StageBehaviorProfile[] {
  return profiles;
}

/** Registry ids that must all carry a profile (asserted in tests). */
export function stageIdsMissingProfiles(): string[] {
  return relationshipStages.filter((s) => !byStageId.has(s.id)).map((s) => s.id);
}
