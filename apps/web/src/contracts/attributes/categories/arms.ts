import { defineAttributeGroup } from "../types";
import { HAIR_DENSITY } from "../shared-values";

export const armsGroup = defineAttributeGroup("arms", [
  {
    id: "arms.build",
    label: "Arm build",
    kind: "physical",
    category: "arms",
    valueType: "enum",
    description: "Arm build and definition.",
    mutability: "mutable",
    renderVisual: true,
    allowedValues: ["slender", "wiry", "soft", "toned", "sinewy", "muscular", "heavy"],
    bodyLocationId: "arms",
    aliases: ["arms", "arm build"],
    imageAppearance: { class: "reinforcement", minimumFraming: "waist_up" },
  },
  {
    id: "arms.hair",
    label: "Arm hair",
    kind: "physical",
    category: "arms",
    valueType: "enum",
    description: "Arm hair density.",
    mutability: "mutable",
    allowedValues: [...HAIR_DENSITY],
    bodyLocationId: "arms",
    aliases: ["arm hair"],
  },
]);
