import { defineAttributeGroup } from "../types";

export const lipsGroup = defineAttributeGroup("lips", [
  {
    id: "lips.fullness",
    label: "Lip fullness",
    kind: "physical",
    category: "lips",
    valueType: "enum",
    description: "Lip fullness.",
    mutability: "inherent",
    allowedValues: ["thin", "slight", "medium", "full", "very_full", "plush"],
    bodyLocationId: "face",
    aliases: ["lips", "lip fullness"],
  },
  {
    id: "lips.shape",
    label: "Lip shape",
    kind: "physical",
    category: "lips",
    valueType: "enum",
    description: "Lip shape.",
    mutability: "inherent",
    allowedValues: [
      "cupids_bow", "bow_shaped", "wide", "narrow",
      "round", "heavy_bottom", "downturned", "upturned",
    ],
    bodyLocationId: "face",
    aliases: ["lip shape"],
  },
]);
