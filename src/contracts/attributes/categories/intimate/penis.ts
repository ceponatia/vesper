import { defineAttributeGroup } from "../../types";
import { INTIMATE_SCENT_BASE, INTIMATE_SCENT_GUIDANCE } from "../../shared-values";

/**
 * Penis — intimate region, gated by the body-config group "penis". These describe
 * the resting anatomy; live state (flaccid/erect) is the `arousal` meter +
 * conditions, not an attribute (Decision 2). Clinical values; prose promptHints.
 */
export const penisGroup = defineAttributeGroup("penis", [
  {
    id: "penis.size",
    label: "Penis size",
    kind: "physical",
    category: "penis",
    valueType: "enum",
    description: "General size as it reads at rest.",
    mutability: "inherent",
    allowedValues: ["small", "average", "large"],
    bodyLocationId: "penis",
    aliases: ["penis size", "cock size"],
    promptHints: ["Describes resting anatomy; current arousal state comes from the arousal meter, not here. Surfaces only at the intimate exposure tier."],
  },
  {
    id: "penis.girth",
    label: "Penis girth",
    kind: "physical",
    category: "penis",
    valueType: "enum",
    description: "How thick the penis is.",
    mutability: "inherent",
    allowedValues: ["slim", "average", "thick"],
    bodyLocationId: "penis",
    aliases: ["girth"],
  },
  {
    id: "penis.circumcised",
    label: "Circumcised",
    kind: "physical",
    category: "penis",
    valueType: "flag",
    description: "Whether the penis is circumcised.",
    mutability: "inherent",
    bodyLocationId: "penis",
    aliases: ["circumcised"],
  },
  {
    id: "penis.scent",
    label: "Genital scent",
    kind: "sensory",
    category: "penis",
    valueType: "enum",
    description: "Intimate scent; shifts with hygiene and arousal. Surfaces only when scent is earned at close/intimate range.",
    mutability: "mutable",
    allowedValues: [...INTIMATE_SCENT_BASE],
    bodyLocationId: "penis",
    narratorGuidance: INTIMATE_SCENT_GUIDANCE,
  },
]);
