import { defineAttributeGroup } from "../types";

export const chestGroup = defineAttributeGroup("chest", [
  {
    id: "chest.size",
    label: "Chest",
    kind: "physical",
    category: "chest",
    valueType: "enum",
    description: "Chest or bust as it visibly reads, any gender.",
    mutability: "inherent",
    allowedValues: ["flat", "slight", "modest", "average", "full", "very_full", "broad", "barrel"],
    bodyLocationId: "chest",
    aliases: ["chest", "bust"],
    promptHints: ["Describe the chest only as far as wardrobe exposure and the exposure mask allow."],
  },
  {
    id: "chest.hair",
    label: "Chest hair",
    kind: "physical",
    category: "chest",
    valueType: "enum",
    description: "Chest hair density; grooming can change it.",
    mutability: "mutable",
    allowedValues: ["none", "sparse", "light", "moderate", "thick"],
    bodyLocationId: "chest",
    aliases: ["chest hair"],
  },
]);
