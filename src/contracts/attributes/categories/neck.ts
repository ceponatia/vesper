import { defineAttributeGroup } from "../types";

export const neckGroup = defineAttributeGroup("neck", [
  {
    id: "neck.length",
    label: "Neck",
    kind: "physical",
    category: "neck",
    valueType: "enum",
    description: "Neck length and line.",
    mutability: "inherent",
    allowedValues: ["short", "average", "long", "graceful", "thick", "slender"],
    bodyLocationId: "neck",
    aliases: ["neck"],
  },
  {
    id: "neck.throat_prominence",
    label: "Throat prominence",
    kind: "physical",
    category: "neck",
    valueType: "enum",
    description: "How visibly the throat (Adam's apple) shows.",
    mutability: "inherent",
    allowedValues: ["smooth", "subtle", "noticeable", "prominent"],
    bodyLocationId: "neck",
    aliases: ["adam's apple", "throat"],
  },
]);
