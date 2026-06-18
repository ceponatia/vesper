import { defineAttributeGroup } from "../types";

export const feetGroup = defineAttributeGroup("feet", [
  {
    id: "feet.size",
    label: "Foot size",
    kind: "physical",
    category: "feet",
    valueType: "enum",
    description: "Foot size and proportion.",
    mutability: "inherent",
    allowedValues: ["small", "narrow", "average", "long", "broad", "large"],
    bodyLocationId: "feet",
    aliases: ["feet", "foot size"],
    imageReveal: "shape",
  },
  {
    id: "feet.arch",
    label: "Foot arch",
    kind: "physical",
    category: "feet",
    valueType: "enum",
    description: "Arch profile of the foot.",
    mutability: "inherent",
    allowedValues: ["flat", "low", "average", "high"],
    bodyLocationId: "feet",
    aliases: ["arches", "foot arch"],
    // Skin-level — only visible with bare feet (no footwear).
    imageReveal: "skin",
  },
  {
    id: "feet.nails",
    label: "Toenails",
    kind: "presentation",
    category: "feet",
    valueType: "enum",
    description: "Toenail upkeep.",
    mutability: "mutable",
    allowedValues: [
      "neglected",
      "trimmed",
      "neat",
      "pedicured",
      "painted",
      "chipped",
    ],
    bodyLocationId: "toes",
    aliases: ["toenails", "pedicure"],
    imageReveal: "skin",
    promptHints: [
      "Toenails are only worth a mention when the feet are bare and in view.",
    ],
  },
  {
    // This is placeholder for testing.
    // Eventually need an evolving scent schema which is based on
    // current hygiene.
    id: "feet.smell",
    label: "Foot scent",
    kind: "presentation",
    category: "feet",
    valueType: "enum",
    description: "Starting foot scent.",
    mutability: "mutable",
    allowedValues: [
      "cheesy",
      "vinegary",
      "pungent",
      "ripe",
      "freshly washed",
      "neutral",
    ],
    bodyLocationId: "feet",
    aliases: ["feet", "foot", "sole", "heel"],
    promptHints: [
      "Foot scent is only worth a mention when the feet are bare and near the player's face.",
    ],
  },
  {
    id: "feet.toes",
    label: "Toe length",
    kind: "physical",
    category: "feet",
    valueType: "enum",
    description: "Overall length of toes.",
    mutability: "inherent",
    allowedValues: ["tiny", "short", "average", "long"],
    bodyLocationId: "feet",
    aliases: ["feet", "foot", "sole", "heel"],
    // Skin-level — only visible with bare feet (no footwear).
    imageReveal: "skin",
    promptHints: [
      "Toe length is only worth a mention when the feet are bare and in view.",
    ],
  },
]);
