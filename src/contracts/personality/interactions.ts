import { z } from "zod";

/**
 * Interaction concepts (docs/developer-notes/personality-and-state.spec.md §6):
 * the shared, controlled vocabulary the intake agent classifies a player's social
 * act into, and that both bespoke preferences and (later) social-reaction cards
 * point at. One stable classification target; one key space for the two
 * disposition layers. Adding a concept is a one-file data edit + the registry test.
 *
 * `verb` is the past-tense phrase the pre-narration reaction line uses ("Brian
 * complimented Sabrina"). `family` lets a preference target a whole cluster.
 * `intimate` concepts are fenced + exposure-gated where they surface.
 */
export const interactionConceptSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  /** Cluster a preference may target wholesale (e.g. "affection_display"). */
  family: z.string().optional(),
  /** Past-tense phrase for the reaction line: "complimented", "offered a gift to". */
  verb: z.string().min(1),
  /** Phrasing examples that steer the intake classifier (NOT regex triggers). */
  triggers: z.array(z.string()).readonly().default([]),
  /** Fallback narrator flavour when a preference sets no `hint`; "" is fine. */
  defaultHint: z.string().default(""),
  /** Fenced + exposure-gated like intimate attributes where it surfaces. */
  intimate: z.boolean().default(false),
});

export type InteractionConcept = z.infer<typeof interactionConceptSchema>;

/**
 * Starter vocabulary (~13). Grouped loosely by `family`. Conservative on purpose —
 * grow it as preferences and (later) taboo/social-rule cards require, including
 * non-interpersonal concepts (e.g. `public_exposure`) when the card plan lands.
 */
export const interactionConcepts: readonly InteractionConcept[] = [
  {
    id: "compliment",
    label: "Compliment",
    description: "Praise, flattery, or admiration directed at them.",
    family: "affection_display",
    verb: "complimented",
    triggers: ["you look beautiful", "that was brilliant", "I admire how you handled that"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "gift",
    label: "Gift",
    description: "Offering a present, treat, or unprompted favour.",
    family: "affection_display",
    verb: "offered a gift to",
    triggers: ["I brought you this", "a little something for you", "holds out a small box"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "physical_affection",
    label: "Physical affection",
    description: "A hug, hand-hold, or other affectionate, non-sexual touch.",
    family: "affection_display",
    verb: "showed affection to",
    triggers: ["pulls her into a hug", "takes his hand", "ruffles her hair"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "flirt",
    label: "Flirtation",
    description: "A playful romantic or suggestive advance.",
    family: "courtship",
    verb: "flirted with",
    triggers: ["winks at her", "leans in with a slow grin", "'come here often?'"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "tease",
    label: "Teasing",
    description: "Playful ribbing or provocation.",
    family: "teasing",
    verb: "teased",
    triggers: ["smirks 'is that so?'", "pokes fun at her", "mocks her gently"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "reassure",
    label: "Reassurance",
    description: "Comfort, support, or calming after distress.",
    family: "support",
    verb: "reassured",
    triggers: ["it's going to be okay", "I'm here for you", "you did nothing wrong"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "confide",
    label: "Confiding",
    description: "Sharing something personal or vulnerable with them.",
    family: "support",
    verb: "confided in",
    triggers: ["I've never told anyone this", "can I tell you something", "I trust you with this"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "insult",
    label: "Insult",
    description: "A direct insult, put-down, or demeaning remark.",
    family: "aggression",
    verb: "insulted",
    triggers: ["you're pathetic", "calls her stupid", "sneers something cruel"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "criticize",
    label: "Criticism",
    description: "Disapproval or fault-finding of their choices or actions.",
    family: "aggression",
    verb: "criticized",
    triggers: ["that was a mistake", "you should have known better", "I don't like how you handled that"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "boundary_push",
    label: "Boundary push",
    description: "Pressing past a stated comfort, limit, or refusal.",
    family: "transgression",
    verb: "pushed a boundary with",
    triggers: ["keeps pressing after a no", "'just this once'", "ignores her hesitation"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "jealousy_trigger",
    label: "Jealousy trigger",
    description: "Flirting with or favouring someone else in their presence.",
    family: "transgression",
    verb: "stirred jealousy in",
    triggers: ["flirts with another in front of her", "praises her rival", "leaves with someone else"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "public_display",
    label: "Public display",
    description: "Conspicuous affection or attention in front of others.",
    family: "courtship",
    verb: "made a public display toward",
    triggers: ["kisses her in the crowded room", "announces his feelings to the table", "loud praise in company"],
    defaultHint: "",
    intimate: false,
  },
  {
    id: "proposition",
    label: "Proposition",
    description: "A direct sexual or intimate advance.",
    family: "intimate",
    verb: "propositioned",
    triggers: ["'come to bed'", "slides a hand up her thigh", "whispers a frank invitation"],
    defaultHint: "",
    intimate: true,
  },
];

const conceptById = new Map(interactionConcepts.map((c) => [c.id, c]));

export function interactionConceptById(id: string): InteractionConcept | undefined {
  return conceptById.get(id);
}

export function interactionConceptIds(): string[] {
  return interactionConcepts.map((c) => c.id);
}

/** Concept ids belonging to a family (for family-targeted preferences). */
export function conceptIdsInFamily(family: string): string[] {
  return interactionConcepts.filter((c) => c.family === family).map((c) => c.id);
}

/** Distinct family ids, in first-seen order. */
export function interactionFamilies(): string[] {
  const seen = new Set<string>();
  for (const c of interactionConcepts) if (c.family) seen.add(c.family);
  return [...seen];
}
