import { defineAttributeGroup } from "../types";

export const presentationGroup = defineAttributeGroup("presentation", [
  {
    id: "presentation.style",
    label: "Personal style",
    kind: "presentation",
    category: "presentation",
    valueType: "enum",
    description: "Overall dress sense across the wardrobe.",
    mutability: "mutable",
    allowedValues: [
      "practical", "casual", "athletic", "polished", "professional", "elegant",
      "flamboyant", "bohemian", "minimalist", "rugged", "vintage", "edgy",
    ],
    aliases: ["style", "fashion sense", "dress sense"],
    imageAppearance: {
      class: "fallback",
      minimumFraming: "portrait",
      phrase: { group: "other", role: "with", fragment: "a {value} personal style" },
    },
    promptHints: ["Style guides how new outfits are described; the worn items themselves are wardrobe state."],
  },
  {
    id: "presentation.grooming",
    label: "Grooming",
    kind: "presentation",
    category: "presentation",
    valueType: "enum",
    description: "Habitual grooming standard, separate from current hygiene.",
    mutability: "mutable",
    allowedValues: ["unkempt", "careless", "low_maintenance", "neat", "well_groomed", "meticulous", "immaculate"],
    aliases: ["grooming", "well groomed"],
    imageAppearance: {
      class: "fallback",
      minimumFraming: "portrait",
      phrase: {
        group: "other",
        role: "with",
        fragmentByValue: {
          unkempt: "an unkempt look",
          careless: "a careless look",
          low_maintenance: "a low-maintenance look",
          neat: "a neat, groomed look",
          well_groomed: "a well-groomed look",
          meticulous: "a meticulously groomed look",
          immaculate: "an immaculately groomed look",
        },
      },
    },
  },
  {
    id: "presentation.scent_baseline",
    label: "Baseline scent",
    kind: "sensory",
    category: "presentation",
    valueType: "text",
    description: "Signature scent when clean (\"lavender soap and cedar\"); hygiene thresholds layer over it.",
    mutability: "mutable",
    aliases: ["scent", "perfume", "smell"],
    promptHints: ["Surface scent only within the exposure mask's scent range; closeness earns detail."],
  },
]);
