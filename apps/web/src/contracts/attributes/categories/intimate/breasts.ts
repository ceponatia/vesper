import { defineAttributeGroup } from "../../types";
import { SYNTHETIC_SENSITIVITY_VALUES, SYNTHETIC_SENSITIVITY_GUIDANCE } from "../../shared-values";

/**
 * Breasts — intimate region, gated by the body-config group "breasts". When the
 * region is on, `breasts.size` is the one silhouette owner and the everyday
 * `chest.size` (chest build) drops out of the realized body. Clinical values;
 * prose promptHints. Surfaces only as far as wardrobe exposure + the exposure
 * mask allow.
 */
export const breastsGroup = defineAttributeGroup("breasts", [
  {
    id: "breasts.size",
    label: "Breast size",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "Breast size as it reads unclothed.",
    mutability: "inherent",
    // Autofill metadata only (the forge's render-consistency fill supplies a
    // size for a body with breasts, as chest build gets without them); it is
    // not image-projection policy — `imageReveal` and the reveal path own that.
    renderVisual: true,
    allowedValues: [
      "flat",
      "nearly_flat",
      "petite",
      "perky_small",
      "small",
      "modest",
      "medium",
      "ample",
      "full",
      "large",
      "very_large",
      "voluminous",
      "heavy",
      "massive",
      "enormous",
    ],
    bodyLocationId: "breasts",
    aliases: ["breast size", "cup size", "bust"],
    imageReveal: "shape",
    imageAppearance: {
      class: "reinforcement",
      minimumFraming: "portrait",
      ordinarySilhouette: true,
    },
    promptHints: [
      "Describe breasts only as far as wardrobe exposure and the exposure mask allow; one impression, not a checklist.",
    ],
  },
  {
    id: "breasts.shape",
    label: "Breast shape",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "The overall shape the breasts present.",
    mutability: "inherent",
    allowedValues: [
      "round",
      "athletic",
      "teardrop",
      "soft",
      "pert",
      "projected",
      "conical",
      "tubular",
      "wide_set",
      "side_set",
      "east_west",
      "close_set",
      "pendulous",
      "bell_shaped",
      "saggy",
      "asymmetric",
    ],
    bodyLocationId: "breasts",
    aliases: ["breast shape"],
    // `skin`, not `shape`: surface shape a covered torso cannot show. A sweater
    // flattens pert into whatever the sweater does, so stating it on a clothed
    // render describes a body the picture does not contain. `breasts.size` is
    // the one silhouette that survives clothing, and it stays the only
    // `ordinarySilhouette` exception (types.ts).
    imageReveal: "skin",
  },
  {
    id: "breasts.augmentation",
    label: "Augmentation",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description:
      "Whether the breasts are natural or surgically augmented, and how obviously it reads.",
    mutability: "mutable",
    allowedValues: [
      "natural",
      "subtly_augmented",
      "obviously_augmented",
      "heavily_augmented",
    ],
    bodyLocationId: "breasts",
    aliases: ["implants", "boob job", "fake breasts", "augmented"],
    // How obviously augmentation READS is a surface fact — scar lines, the
    // upper-pole shape, the way the tissue sits. Clothing hides all of it.
    imageReveal: "skin",
  },
  {
    id: "breasts.fullness",
    label: "Breast fullness",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description:
      "How full and plump the breasts appear, especially from the side or when squeezed.",
    mutability: "mutable",
    allowedValues: [
      "deflated",
      "firm",
      "soft",
      "supple",
      "plump",
      "swollen",
      "overfull",
      "engorged",
      "heavy_with_milk",
    ],
    bodyLocationId: "breasts",
    // The definition says it: "especially from the side or when squeezed" —
    // a bare-torso read, not a silhouette one.
    imageReveal: "skin",
  },
  {
    id: "breasts.nipples",
    label: "Nipples",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "Nipple character and prominence when the chest is bare.",
    mutability: "inherent",
    allowedValues: [
      "small",
      "average",
      "large",
      "thick",
      "puffy",
      "inverted",
      "prominent",
      "long",
      "short",
      "wide",
      "pointed",
      "flat",
    ],
    bodyLocationId: "nipples",
    aliases: ["nipples"],
    imageReveal: "skin",
  },
  {
    id: "breasts.areola",
    label: "Areola",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "Areola size and relief.",
    mutability: "inherent",
    allowedValues: [
      "small",
      "average",
      "large",
      "wide",
      "puffy",
      "prominent",
      "raised",
      "flat",
      "textured",
      "bumpy",
    ],
    bodyLocationId: "nipples",
    aliases: ["areola", "areolas"],
    imageReveal: "skin",
  },
  {
    id: "breasts.areola_color",
    label: "Areola color",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "Natural pigmentation of the areolas and nipples.",
    mutability: "inherent",
    allowedValues: [
      "pale_pink",
      "soft_pink",
      "rose",
      "deep_pink",
      "tan",
      "brown",
      "dark_brown",
      "mauve",
      "dusky",
      "near_black",
      "reddish",
    ],
    bodyLocationId: "nipples",
    aliases: ["areola color", "nipple color"],
    imageReveal: "skin",
  },
  {
    id: "breasts.visible_veins",
    label: "Visible veins",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "Whether veins are visible and pattern-type",
    mutability: "inherent",
    allowedValues: ["none", "faint", "visible", "prominent", "blue_network"],
    bodyLocationId: "breasts",
    aliases: ["breast veins", "boob veins"],
    imageReveal: "skin",
  },
  {
    id: "breasts.sensitivity",
    label: "Breast sensitivity",
    // kind "sensory": non-visual, so it stays out of image prompts and surfaces only
    // under an intimate touch/proximity focus (like scent/taste), never in the generic
    // chat body block.
    kind: "sensory",
    category: "breasts",
    valueType: "enum",
    description: "Baseline responsiveness of the breasts and nipples to touch — a tendency, not live arousal.",
    mutability: "mutable",
    allowedValues: ["numb", "low", "average", "high", "extremely_sensitive", ...SYNTHETIC_SENSITIVITY_VALUES],
    autoDefaultExcludes: [...SYNTHETIC_SENSITIVITY_VALUES],
    narratorGuidance: { ...SYNTHETIC_SENSITIVITY_GUIDANCE },
    bodyLocationId: "breasts",
  },
]);
