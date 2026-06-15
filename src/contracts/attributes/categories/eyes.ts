import { defineAttributeGroup } from "../types";

export const eyesGroup = defineAttributeGroup("eyes", [
  {
    id: "eyes.color",
    label: "Eye color",
    kind: "physical",
    category: "eyes",
    valueType: "enum",
    description: "Iris color.",
    mutability: "inherent",
    allowedValues: [
      "brown", "dark_brown", "hazel", "amber", "green", "emerald",
      "blue", "ice_blue", "gray", "gray_green", "violet", "heterochromatic",
    ],
    bodyLocationId: "eyes",
    aliases: ["eye color", "eye colour"],
    coreVisual: true,
  },
  {
    id: "eyes.shape",
    label: "Eye shape",
    kind: "physical",
    category: "eyes",
    valueType: "enum",
    description: "Eye shape and set.",
    mutability: "inherent",
    allowedValues: [
      "almond", "round", "hooded", "monolid", "upturned",
      "downturned", "deep_set", "wide_set", "close_set", "narrow",
    ],
    bodyLocationId: "eyes",
    aliases: ["eye shape"],
  },
]);
