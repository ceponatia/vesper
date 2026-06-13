import { defineAttributeGroup } from "../types";

export const browsGroup = defineAttributeGroup("brows", [
  {
    id: "brows.shape",
    label: "Brow shape",
    kind: "physical",
    category: "brows",
    valueType: "enum",
    description: "Eyebrow shape.",
    mutability: "inherent",
    allowedValues: ["straight", "softly_arched", "arched", "high_arch", "angled", "rounded", "flat"],
    bodyLocationId: "face",
    aliases: ["eyebrows", "brow shape"],
  },
  {
    id: "brows.thickness",
    label: "Brow thickness",
    kind: "physical",
    category: "brows",
    valueType: "enum",
    description: "Eyebrow density; grooming can change it.",
    mutability: "mutable",
    allowedValues: ["sparse", "thin", "medium", "full", "thick", "bushy"],
    bodyLocationId: "face",
    aliases: ["brow thickness", "bushy brows"],
  },
]);
