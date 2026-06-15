import { defineAttributeGroup } from "../../types";

/**
 * Vulva — intimate region, gated by the body-config group "vulva" (which also
 * realizes the internal vagina + the labia/clitoris/vestibule sub-locations).
 * Clinical values; prose promptHints. Surfaces only at the intimate exposure tier.
 */
export const vulvaGroup = defineAttributeGroup("vulva", [
  {
    id: "vulva.labia",
    label: "Labia",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "How the labia present.",
    mutability: "inherent",
    allowedValues: ["tucked", "even", "prominent", "asymmetric"],
    bodyLocationId: "labia_minora",
    aliases: ["labia"],
    promptHints: ["Anatomical detail surfaces only at the intimate exposure tier; render as a single grounded impression."],
  },
  {
    id: "vulva.clitoris",
    label: "Clitoris",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "How prominent the clitoris is.",
    mutability: "inherent",
    allowedValues: ["subtle", "average", "prominent"],
    bodyLocationId: "clitoris",
    aliases: ["clitoris", "clit"],
  },
  {
    id: "vulva.scent",
    label: "Vulva scent",
    kind: "sensory",
    category: "vulva",
    valueType: "enum",
    description: "Intimate scent; shifts with hygiene and arousal. Surfaces only when scent is earned at close/intimate range.",
    mutability: "mutable",
    allowedValues: ["clean", "musky", "salty", "sweet"],
    bodyLocationId: "vulva",
  },
  {
    id: "vulva.taste",
    label: "Vulva taste",
    kind: "sensory",
    category: "vulva",
    valueType: "enum",
    description: "Intimate taste. Surfaces only at the intimate taste tier (oral contact).",
    mutability: "mutable",
    allowedValues: ["clean", "musky", "salty", "tangy", "sweet"],
    bodyLocationId: "vulva",
  },
]);
