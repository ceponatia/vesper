import { defineAttributeGroup } from "../../types";
import {
  INTIMATE_SCENT_BASE,
  INTIMATE_SCENT_GUIDANCE,
  INTIMATE_TASTE_BASE,
  INTIMATE_TASTE_GUIDANCE,
} from "../../shared-values";

/**
 * Vulva — intimate region, gated by the body-config group "vulva" (which also
 * realizes the internal vagina + the labia/clitoris/vestibule sub-locations).
 * Clinical values; prose promptHints. Surfaces only at the intimate exposure tier.
 */
export const vulvaGroup = defineAttributeGroup("vulva", [
  // === Core Shape & Structure ===
  {
    id: "vulva.shape",
    label: "Vulva shape",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description:
      "Overall silhouette and presentation of the vulva when legs are together or slightly parted.",
    mutability: "inherent",
    allowedValues: [
      "neat_slit",
      "puffy",
      "protruding",
      "compact",
      "full",
      "high_set",
      "low_set",
    ],
    bodyLocationId: "vulva",
    aliases: ["vulva", "pussy"],
    promptHints: [
      "Used for clothed or partially clothed descriptions. Only describe visible contours.",
    ],
  },
  {
    id: "vulva.mons",
    label: "Mons pubis",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "Fullness, roundness, and prominence of the pubic mound.",
    mutability: "inherent",
    allowedValues: [
      "flat",
      "soft",
      "plump",
      "prominent",
      "rounded",
      "high",
      "low",
    ],
    bodyLocationId: "mons",
  },

  // === Labia ===
  {
    id: "vulva.labia_majora",
    label: "Labia majora",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "Fullness, separation, and tone of the outer lips.",
    mutability: "inherent",
    allowedValues: [
      "thin",
      "full",
      "puffy",
      "firm",
      "soft",
      "asymmetric",
      "sagging",
    ],
    bodyLocationId: "labia_majora",
  },
  {
    id: "vulva.labia_minora",
    label: "Labia minora",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "Visibility, size, and presentation of the inner lips.",
    mutability: "inherent",
    allowedValues: [
      "hidden",
      "tucked",
      "even",
      "protruding",
      "ruffled",
      "long",
      "asymmetric",
      "thick",
    ],
    bodyLocationId: "labia_minora",
    aliases: ["inner lips", "labia"],
    promptHints: [
      "Anatomical detail surfaces only at the intimate exposure tier.",
    ],
  },
  {
    id: "vulva.labia_color",
    label: "Labia color",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "Natural pigmentation of the labia (both majora and minora).",
    mutability: "inherent",
    allowedValues: [
      "pale_pink",
      "soft_pink",
      "rose",
      "deep_pink",
      "mauve",
      "brown",
      "dark_brown",
      "purplish",
    ],
    bodyLocationId: "vulva",
  },

  // === Clitoris ===
  {
    id: "vulva.clitoris",
    label: "Clitoris",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "Prominence and size of the clitoris when not aroused.",
    mutability: "inherent",
    allowedValues: ["subtle", "average", "prominent", "large"],
    bodyLocationId: "clitoris",
    aliases: ["clit"],
  },
  {
    id: "vulva.clitoral_hood",
    label: "Clitoral hood",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "How the clitoral hood presents and its coverage.",
    mutability: "inherent",
    allowedValues: [
      "tight",
      "hooded",
      "retracted",
      "thick",
      "thin",
      "prominent",
    ],
    bodyLocationId: "clitoris",
  },

  // === Pubic Hair ===
  {
    id: "vulva.pubic_hair_density",
    label: "Pubic hair density",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "Amount of pubic hair present.",
    mutability: "mutable",
    allowedValues: ["none", "sparse", "light", "moderate", "thick", "dense"],
    bodyLocationId: "mons",
  },
  {
    id: "vulva.pubic_hair_style",
    label: "Pubic hair style",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "How the pubic hair is naturally grown or maintained.",
    mutability: "mutable",
    allowedValues: [
      "natural",
      "trimmed",
      "triangle",
      "landing_strip",
      "stubble",
      "smooth",
      "patchy",
    ],
    bodyLocationId: "mons",
  },

  // === Texture & Feel ===
  {
    id: "vulva.texture",
    label: "Vulva texture",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description: "Surface feel of the vulva when touched.",
    mutability: "inherent",
    allowedValues: [
      "smooth",
      "soft",
      "velvety",
      "silky",
      "slightly_textured",
      "plump",
    ],
    bodyLocationId: "vulva",
    promptHints: [
      "Primarily used during intimate physical contact descriptions.",
    ],
  },

  // === Mutable / Arousal States ===
  {
    id: "vulva.swelling",
    label: "Vulva swelling",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description:
      "How much the vulva visibly swells and puffs when aroused — a response tendency, not live state (current arousal rides the arousal meter).",
    mutability: "mutable",
    allowedValues: ["none", "slight", "moderate", "heavy", "engorged"],
    bodyLocationId: "vulva",
    promptHints: [
      "Only surfaces when arousal is high or during close examination.",
    ],
  },
  {
    id: "vulva.wetness",
    label: "Natural wetness",
    kind: "physical",
    category: "vulva",
    valueType: "enum",
    description:
      "How wet she gets when aroused — the natural lubrication response, not live state (current arousal rides the arousal meter).",
    mutability: "mutable",
    allowedValues: ["dry", "dewy", "slick", "glistening", "dripping", "creamy"],
    bodyLocationId: "vulva",
    promptHints: ["Rendered only at intimate exposure or touch tier."],
  },

  // === Sensory ===
  {
    id: "vulva.scent",
    label: "Vulva scent",
    kind: "sensory",
    category: "vulva",
    valueType: "enum",
    description: "Intimate scent; shifts with hygiene, cycle, and arousal.",
    mutability: "mutable",
    allowedValues: [...INTIMATE_SCENT_BASE, "sweet"],
    bodyLocationId: "vulva",
    promptHints: [
      "Surfaces only at close/intimate range when scent is earned.",
    ],
    narratorGuidance: { ...INTIMATE_SCENT_GUIDANCE, sweet: "an unexpectedly sweet, honeyed note" },
  },
  {
    id: "vulva.taste",
    label: "Vulva taste",
    kind: "sensory",
    category: "vulva",
    valueType: "enum",
    description: "Taste when orally stimulated.",
    mutability: "mutable",
    allowedValues: [...INTIMATE_TASTE_BASE, "sweet"],
    bodyLocationId: "vulva",
    promptHints: ["Only surfaces at the intimate taste tier (oral contact)."],
    narratorGuidance: { ...INTIMATE_TASTE_GUIDANCE, sweet: "distinctly sweet — a honeyed taste" },
  },
]);
