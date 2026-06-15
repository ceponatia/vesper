import { defineAttributeGroup } from "../types";

export const earsGroup = defineAttributeGroup("ears", [
  {
    id: "ears.shape",
    label: "Ear shape",
    kind: "physical",
    category: "ears",
    valueType: "enum",
    description: "Ear shape, including non-human points.",
    mutability: "inherent",
    allowedValues: [
      "rounded", "slightly_pointed", "pointed", "long_pointed",
      "small", "large", "protruding", "flat",
    ],
    bodyLocationId: "ears",
    aliases: ["ear shape", "pointed ears"],
  },
  {
    id: "ears.piercings",
    label: "Ear piercings",
    kind: "presentation",
    category: "ears",
    valueType: "enum",
    description: "Piercing arrangement; the jewelry itself is wardrobe.",
    mutability: "mutable",
    allowedValues: ["none", "single_lobe", "double_lobe", "multiple", "cartilage", "industrial", "gauged"],
    bodyLocationId: "ears",
    aliases: ["piercings", "earrings"],
  },
]);
