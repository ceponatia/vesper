import { defineAttributeGroup } from "../types";

export const armsGroup = defineAttributeGroup("arms", [
  {
    id: "arms.build",
    label: "Arm build",
    kind: "physical",
    category: "arms",
    valueType: "enum",
    description: "Arm build and definition.",
    mutability: "mutable",
    allowedValues: ["slender", "wiry", "soft", "toned", "sinewy", "muscular", "heavy"],
    bodyLocationId: "arms",
    aliases: ["arms", "arm build"],
  },
  {
    id: "arms.hair",
    label: "Arm hair",
    kind: "physical",
    category: "arms",
    valueType: "enum",
    description: "Arm hair density.",
    mutability: "mutable",
    allowedValues: ["none", "fine", "light", "moderate", "thick"],
    bodyLocationId: "arms",
    aliases: ["arm hair"],
  },
]);
