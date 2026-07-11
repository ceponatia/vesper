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
    bodyLocationId: "lips",
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
    bodyLocationId: "lips",
    aliases: ["lip shape"],
  },
  {
    id: "lips.piercings",
    label: "Lip piercings",
    kind: "presentation",
    category: "lips",
    valueType: "enum",
    description: "Piercing arrangement; the jewelry itself is wardrobe (jewelry items with a lip ring/stud subtype).",
    mutability: "mutable",
    allowedValues: ["none", "labret", "vertical_labret", "medusa", "single_side", "snake_bites", "spider_bites"],
    bodyLocationId: "lips",
    aliases: ["lip piercing", "labret", "snake bites"],
  },
]);
