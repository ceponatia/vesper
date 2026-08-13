import { defineAttributeGroup } from "../types";
import { SYNTHETIC_SKIN_TEXTURES, SYNTHETIC_SKIN_TEXTURE_GUIDANCE } from "../shared-values";

export const skinGroup = defineAttributeGroup("skin", [
  {
    id: "skin.tone",
    label: "Skin tone",
    kind: "physical",
    category: "skin",
    valueType: "enum",
    description: "Base skin tone.",
    mutability: "inherent",
    allowedValues: [
      "porcelain", "fair", "light", "light_olive", "olive", "tan",
      "golden", "bronze", "light_brown", "brown", "dark_brown", "deep_ebony",
      // Supernatural / non-human tones (demonkin, fae, the drowned, the undead).
      // Selectable in the editor and pickable by the forge when the concept
      // calls for it, but never an *automatic* default for an unspecified
      // (human-by-default) character — see autoDefaultExcludes.
      "ashen", "light_grey", "slate_grey", "blue_grey", "cool_blue",
      "pale_green", "sage_green", "crimson", "dusky_violet", "ghostly_white",
    ],
    autoDefaultExcludes: [
      "ashen", "light_grey", "slate_grey", "blue_grey", "cool_blue",
      "pale_green", "sage_green", "crimson", "dusky_violet", "ghostly_white",
    ],
    aliases: ["skin tone", "skin color", "complexion"],
    coreVisual: true,
    defaultValue: "light",
  },
  {
    id: "skin.undertone",
    label: "Skin undertone",
    kind: "physical",
    category: "skin",
    valueType: "enum",
    description: "Undertone that shows in blush and light.",
    mutability: "inherent",
    allowedValues: ["cool", "neutral", "warm", "rosy", "golden", "olive"],
    aliases: ["undertone"],
  },
  {
    id: "skin.texture",
    label: "Skin texture",
    kind: "physical",
    category: "skin",
    valueType: "enum",
    description: "Overall skin texture at close range.",
    mutability: "mutable",
    allowedValues: ["smooth", "soft", "dewy", "dry", "rough", "weathered", "leathery", ...SYNTHETIC_SKIN_TEXTURES],
    autoDefaultExcludes: [...SYNTHETIC_SKIN_TEXTURES],
    aliases: ["skin texture"],
    // Slice-4 authoring batch (attribute-narrator-guidance.plan.md) — DRAFTS AWAITING
    // OWNER REVIEW. Texture = surface feel only, never tone/color. Sparse: smooth/soft/dry stay bare.
    narratorGuidance: {
      dewy: "fresh and faintly moist, catches the light",
      rough: "coarse to the touch — texture you can feel",
      weathered: "sun- and wind-worn, roughened by exposure",
      leathery: "tough and thick, tanned like worn hide",
      ...SYNTHETIC_SKIN_TEXTURE_GUIDANCE,
    },
  },
  {
    id: "skin.markings",
    label: "Skin markings",
    kind: "physical",
    category: "skin",
    valueType: "enum_list",
    description: "Persistent markings anywhere on the body.",
    mutability: "mutable",
    allowedValues: [
      "tattoos", "scars", "birthmark", "moles", "beauty_mark",
      "vitiligo", "stretch_marks", "sun_spots", "burn_scar", "piercing_marks",
      // Non-human skin surfaces (scaled patches, fae patterning, glow).
      "scales", "natural_patterning", "bioluminescent_markings",
    ],
    aliases: ["markings", "tattoos", "scars", "birthmark"],
    promptHints: ["Mention markings only when exposure allows them to be seen."],
  },
]);
