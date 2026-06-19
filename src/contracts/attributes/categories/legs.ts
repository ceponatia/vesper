import { defineAttributeGroup } from "../types";
import { HAIR_DENSITY } from "../shared-values";

export const legsGroup = defineAttributeGroup("legs", [
  {
    id: "legs.build",
    label: "Leg build",
    kind: "physical",
    category: "legs",
    valueType: "enum",
    description: "Leg build and definition.",
    mutability: "mutable",
    allowedValues: ["slender", "lithe", "soft", "shapely", "toned", "athletic", "muscular", "sturdy", "heavy"],
    bodyLocationId: "legs",
    aliases: ["legs", "leg build"],
    imageReveal: "shape",
  },
  {
    id: "legs.length",
    label: "Leg length",
    kind: "physical",
    category: "legs",
    valueType: "enum",
    description: "Leg length relative to the torso.",
    mutability: "inherent",
    allowedValues: ["short", "proportionate", "long", "very_long"],
    bodyLocationId: "legs",
    aliases: ["leg length", "long legs"],
    imageReveal: "shape",
  },
  {
    id: "legs.hair",
    label: "Leg hair",
    kind: "physical",
    category: "legs",
    valueType: "enum",
    description: "Leg hair density; grooming can change it.",
    mutability: "mutable",
    allowedValues: [...HAIR_DENSITY],
    bodyLocationId: "legs",
    aliases: ["leg hair"],
    // Skin-level — only visible with bare legs (no bottoms/hosiery covering them).
    imageReveal: "skin",
  },
]);
