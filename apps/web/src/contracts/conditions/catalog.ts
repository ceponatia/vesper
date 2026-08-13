import { normalizeConditionLabel, type ConditionEffect } from "./condition";

/**
 * Known condition label → its structured effects (character-chat-state-narration.spec.md §2).
 * Conditions are created across the app with `attributeEffects: []`; this catalog lets a
 * recognised label arrive with real attribute overlays attached (the chat lane seeds from
 * it when an action/pulse/author creates a condition), mirroring the label→senseEffects
 * pattern in `contracts/perception/darkness.ts`. Keys are normalised labels (lowercased,
 * trimmed). Only **mutable** attributes belong here — `conditionAttributeOverlays` drops any
 * effect that targets an inherent attribute, so a bad entry degrades, never corrupts.
 *
 * Deliberately small: the headline state cues (drunk, low hygiene) are *meter*-driven
 * (§3/§4), not condition-driven. This catalog covers explicit narrative conditions whose
 * physical signature wants to ride into the attribute set. Extend by adding a row.
 */
export interface CatalogCondition {
  attributeEffects: ConditionEffect[];
  /** Default narrator hint when the creator supplied none. */
  promptHint?: string;
}

export const CONDITION_CATALOG: Readonly<Record<string, CatalogCondition>> = {
  disheveled: {
    attributeEffects: [{ attributeId: "presentation.grooming", value: "unkempt" }],
    promptHint: "Disheveled: clothes rumpled, hair mussed, put-together edges gone soft.",
  },
  unkempt: {
    attributeEffects: [{ attributeId: "presentation.grooming", value: "unkempt" }],
    promptHint: "Unkempt: grooming has slipped — nothing is quite in place.",
  },
  unwashed: {
    attributeEffects: [{ attributeId: "presentation.grooming", value: "careless" }],
    promptHint: "Unwashed: sour and warm at close range, hair gone lank.",
  },
};

/** The catalog entry for a label (case/space-insensitive), or undefined if unrecognised. */
export function catalogConditionForLabel(label: string): CatalogCondition | undefined {
  return CONDITION_CATALOG[normalizeConditionLabel(label)];
}
