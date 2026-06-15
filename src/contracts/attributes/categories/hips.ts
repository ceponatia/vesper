import { defineAttributeGroup } from "../types";

export const hipsGroup = defineAttributeGroup("hips", [
  {
    id: "hips.width",
    label: "Hips",
    kind: "physical",
    category: "hips",
    valueType: "enum",
    description: "Hip breadth relative to waist and shoulders.",
    mutability: "inherent",
    allowedValues: ["narrow", "slim", "average", "rounded", "wide", "very_wide"],
    bodyLocationId: "hips",
    aliases: ["hips", "hip width", "wide hips"],
  },
]);
