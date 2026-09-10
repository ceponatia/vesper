import { defineAttributeGroup } from "../types";

export const noseGroup = defineAttributeGroup("nose", [
  {
    id: "nose.shape",
    label: "Nose shape",
    kind: "physical",
    category: "nose",
    valueType: "enum",
    description: "Nose shape in profile and from the front.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: [
      "button", "straight", "upturned", "snub", "aquiline",
      "roman", "hooked", "broad", "narrow", "pointed", "crooked",
    ],
    // A crooked nose is the recognizable-features spec's canonical attribute
    // example (appearance-features/attribute-recognition.ts) — authorable, but
    // never an automatic fill: an unspecified character's nose is not broken.
    autoDefaultExcludes: ["crooked"],
    bodyLocationId: "nose",
    aliases: ["nose", "nose shape"],
    imageAppearance: {
      class: "reinforcement",
      maximumFraming: "portrait",
      phrase: { group: "face", role: "with", fragment: "a {value} nose" },
    },
  },
  {
    id: "nose.size",
    label: "Nose size",
    kind: "physical",
    category: "nose",
    valueType: "enum",
    description: "How prominently the nose reads in the face.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: ["petite", "small", "medium", "prominent", "large"],
    bodyLocationId: "nose",
    aliases: ["nose size"],
    imageAppearance: {
      class: "reinforcement",
      maximumFraming: "portrait",
      phrase: { group: "face", role: "with", fragment: "a {value} nose" },
    },
  },
  {
    id: "nose.piercings",
    label: "Nose piercings",
    kind: "presentation",
    category: "nose",
    valueType: "enum",
    description: "Piercing arrangement; the jewelry itself is wardrobe (jewelry items with a nose ring/stud subtype).",
    mutability: "mutable",
    allowedValues: ["none", "nostril", "double_nostril", "high_nostril", "septum", "bridge"],
    bodyLocationId: "nose",
    aliases: ["nose piercing", "septum", "nose ring"],
    imageAppearance: {
      class: "fine",
      maximumFraming: "close_up",
      phrase: {
        group: "face",
        role: "with",
        fragmentByValue: {
          nostril: "a nostril piercing",
          double_nostril: "piercings in both nostrils",
          high_nostril: "a high nostril piercing",
          septum: "a septum piercing",
          bridge: "a bridge piercing",
        },
      },
    },
  },
]);
