import { defineAttributeGroup } from "../types";

export const shouldersGroup = defineAttributeGroup("shoulders", [
  {
    id: "shoulders.width",
    label: "Shoulder width",
    kind: "physical",
    category: "shoulders",
    valueType: "enum",
    description: "Shoulder breadth relative to frame.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: ["narrow", "slight", "average", "broad", "very_broad"],
    bodyLocationId: "shoulders",
    aliases: ["shoulder width", "broad shoulders"],
  },
  {
    id: "shoulders.slope",
    label: "Shoulder slope",
    kind: "physical",
    category: "shoulders",
    valueType: "enum",
    description: "Shoulder line.",
    mutability: "inherent",
    allowedValues: ["square", "gently_sloped", "sloped", "rounded"],
    bodyLocationId: "shoulders",
    aliases: ["shoulder slope"],
  },
]);
