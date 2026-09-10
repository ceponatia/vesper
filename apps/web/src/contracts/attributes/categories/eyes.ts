import { defineAttributeGroup } from "../types";

export const eyesGroup = defineAttributeGroup("eyes", [
  {
    id: "eyes.color",
    label: "Eye color",
    kind: "physical",
    category: "eyes",
    valueType: "enum",
    description: "Iris color.",
    mutability: "inherent",
    allowedValues: [
      "brown", "dark_brown", "hazel", "amber", "green", "emerald",
      "blue", "ice_blue", "gray", "gray_green", "violet", "heterochromatic",
      // Supernatural iris colors — selectable / forge-pickable, never auto-defaulted.
      "gold", "red", "crimson", "silver", "white", "solid_black",
    ],
    autoDefaultExcludes: ["gold", "red", "crimson", "silver", "white", "solid_black"],
    bodyLocationId: "eyes",
    aliases: ["eye color", "eye colour"],
    imageAppearance: {
      class: "core",
      referenceFreeRequired: true,
      // Order 1 for the same reason `hair.color` takes it: the colour is the
      // adjective that sits against the noun, beside the shape's and the glow's
      // 0 — "almond-shaped hazel eyes", never "hazel almond-shaped eyes".
      phrase: { group: "eyes", role: "adjective", fragment: "{compound}", order: 1 },
    },
    coreVisual: true,
    defaultValue: "brown",
  },
  {
    id: "eyes.pupil",
    label: "Pupil shape",
    kind: "physical",
    category: "eyes",
    valueType: "enum",
    description: "Pupil shape; anything but round reads as non-human.",
    mutability: "inherent",
    allowedValues: ["round", "vertical_slit", "horizontal_slit", "goat"],
    bodyLocationId: "eyes",
    aliases: ["pupils", "slit pupils"],
    imageAppearance: {
      class: "reinforcement",
      maximumFraming: "close_up",
      omitValues: ["round"],
      phrase: {
        group: "eyes",
        role: "with",
        fragment: "{compound} pupils",
        fragmentByValue: { goat: "goat-like pupils" },
      },
    },
    promptHints: ["Vertical-slit pupils read demonic/feline, horizontal/goat bestial; round is the human default."],
  },
  {
    id: "eyes.luminosity",
    label: "Eye luminosity",
    kind: "physical",
    category: "eyes",
    valueType: "enum",
    description: "Whether the eyes give off their own light.",
    mutability: "inherent",
    allowedValues: ["none", "faint_glow", "glowing"],
    bodyLocationId: "eyes",
    aliases: ["glowing eyes"],
    imageAppearance: {
      class: "reinforcement",
      maximumFraming: "portrait",
      phrase: {
        group: "eyes",
        role: "adjective",
        fragmentByValue: { faint_glow: "faintly glowing", glowing: "glowing" },
      },
    },
    promptHints: ["A supernatural cue; let it read strongest in low light."],
  },
  {
    id: "eyes.shape",
    label: "Eye shape",
    kind: "physical",
    category: "eyes",
    valueType: "enum",
    description: "Eye shape and set.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: [
      "almond", "round", "hooded", "monolid", "upturned",
      "downturned", "deep_set", "wide_set", "close_set", "narrow",
    ],
    bodyLocationId: "eyes",
    aliases: ["eye shape"],
    imageAppearance: {
      class: "reinforcement",
      maximumFraming: "portrait",
      phrase: {
        group: "eyes",
        role: "adjective",
        fragment: "{compound}",
        fragmentByValue: { almond: "almond-shaped" },
      },
    },
  },
]);
