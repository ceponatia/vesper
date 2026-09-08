import { defineAttributeGroup } from "../types";

export const waistGroup = defineAttributeGroup("waist", [
  {
    id: "waist.definition",
    label: "Waist",
    kind: "physical",
    category: "waist",
    valueType: "enum",
    description: "Waistline definition; tracks weight over a long story.",
    mutability: "mutable",
    renderVisual: true,
    allowedValues: ["straight", "subtle", "defined", "cinched", "soft", "rounded", "thick"],
    bodyLocationId: "waist",
    aliases: ["waist", "waistline"],
    imageAppearance: { class: "reinforcement", minimumFraming: "full_figure" },
    imageReveal: "shape",
  },
]);
