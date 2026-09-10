import { defineAttributeGroup } from "../types";

export const faceGroup = defineAttributeGroup("face", [
  {
    id: "face.shape",
    label: "Face shape",
    kind: "physical",
    category: "face",
    valueType: "enum",
    description: "Overall face shape.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: [
      "oval", "round", "square", "heart", "diamond",
      "oblong", "triangular", "angular", "soft_rounded", "chiseled",
    ],
    bodyLocationId: "face",
    aliases: ["face shape"],
    imageAppearance: {
      class: "core",
      referenceFreeRequired: true,
      phrase: {
        group: "face",
        role: "adjective",
        // Every member is a shape word, and three of them are shape NOUNS: a face
        // is heart-shaped, not "a heart face".
        fragmentByValue: {
          oval: "oval",
          round: "round",
          square: "square",
          heart: "heart-shaped",
          diamond: "diamond-shaped",
          oblong: "oblong",
          triangular: "triangular",
          angular: "angular",
          soft_rounded: "softly rounded",
          chiseled: "chiseled",
        },
      },
    },
  },
  {
    id: "face.freckles",
    label: "Freckles",
    kind: "physical",
    category: "face",
    valueType: "enum",
    description: "Facial freckling density.",
    mutability: "inherent",
    allowedValues: ["none", "faint", "light_dusting", "scattered", "prominent", "heavy"],
    bodyLocationId: "face",
    aliases: ["freckles", "freckled"],
    imageAppearance: {
      class: "reinforcement",
      maximumFraming: "portrait",
      phrase: {
        group: "face",
        role: "with",
        fragmentByValue: {
          faint: "a faint dusting of freckles",
          light_dusting: "a light dusting of freckles",
          scattered: "scattered freckles",
          prominent: "prominent freckles",
          heavy: "heavy freckling",
        },
      },
    },
  },
  {
    id: "face.expression_default",
    label: "Default expression",
    kind: "presentation",
    category: "face",
    valueType: "enum",
    description: "Resting expression when nothing in particular is happening.",
    mutability: "mutable",
    allowedValues: [
      "neutral", "soft", "warm", "guarded", "stern",
      "wry", "melancholy", "bright", "serene", "brooding",
    ],
    bodyLocationId: "face",
    aliases: ["resting expression", "default expression"],
    imageAppearance: {
      class: "fallback",
      maximumFraming: "waist_up",
      phrase: { group: "face", role: "with", fragment: "a {value} resting expression" },
    },
    promptHints: ["Treat the default expression as a baseline the scene's mood moves away from, not a mask."],
  },
]);
