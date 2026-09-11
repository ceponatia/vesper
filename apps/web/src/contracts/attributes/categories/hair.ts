import { defineAttributeGroup } from "../types";

export const hairGroup = defineAttributeGroup("hair", [
  {
    id: "hair.color",
    label: "Hair color",
    kind: "physical",
    category: "hair",
    valueType: "enum",
    description: "Base hair color.",
    mutability: "mutable",
    allowedValues: [
      "black",
      "dark_brown",
      "brown",
      "light_brown",
      "auburn",
      "red",
      "strawberry_blonde",
      "blonde",
      "platinum",
      "gray",
      "white",
      // Dye jobs — vivid, unnatural colors only achievable by dyeing (the
      // natural range above already covers brown→blonde recoloring). `dyed_vivid`
      // stays the generic catch-all for split-dye / rainbow / unspecified.
      "dyed_pink",
      "dyed_red",
      "dyed_orange",
      "dyed_yellow",
      "dyed_green",
      "dyed_teal",
      "dyed_blue",
      "dyed_purple",
      // Naturally otherworldly hair (fae, demonkin) — distinct from a dye job.
      // The vivid ones are not auto-defaulted onto a human.
      "silver",
      "rose_gold",
      "deep_violet",
      "midnight_blue",
    ],
    // A dye job is valid to pick but never an automatic default, same as the
    // otherworldly palette — no one is auto-assigned dyed hair.
    autoDefaultExcludes: [
      "dyed_pink",
      "dyed_red",
      "dyed_orange",
      "dyed_yellow",
      "dyed_green",
      "dyed_teal",
      "dyed_blue",
      "dyed_purple",
      "dyed_vivid",
      "rose_gold",
      "deep_violet",
      "midnight_blue",
    ],
    bodyLocationId: "hair",
    aliases: [
      "hair color",
      "ginger",
      "redhead",
      "blonde",
      "brunette",
      "dyed hair",
    ],
    imageAppearance: {
      class: "core",
      referenceFreeRequired: true,
      // "dark-brown hair" — a two-word colour in front of its noun hyphenates.
      // Order 1: colour is the adjective English puts closest to the noun, so
      // "healthy dark-brown hair" rather than the claim order's "dark-brown
      // healthy hair".
      phrase: { group: "hair", role: "adjective", fragment: "{compound}", order: 1 },
    },
    coreVisual: true,
    defaultValue: "brown",
  },
  {
    id: "hair.length",
    label: "Hair length",
    kind: "physical",
    category: "hair",
    valueType: "enum",
    description: "Overall hair length.",
    mutability: "mutable",
    renderVisual: true,
    allowedValues: [
      "shaved",
      "buzzed",
      "short",
      "chin_length",
      "shoulder_length",
      "mid_back",
      "waist_length",
      "feet_length",
    ],
    bodyLocationId: "hair",
    aliases: ["hair length"],
    imageAppearance: {
      class: "core",
      referenceFreeRequired: true,
      phrase: {
        group: "hair",
        role: "trailer",
        // Order 1, behind the arrangement's 0: a trailer follows the noun, so
        // the lower number lands first and the head reads "hair worn loose to
        // mid-back" rather than "hair to mid-back worn loose".
        order: 1,
        // The vocabulary runs from a shaved scalp to hair at the feet, so no single
        // template words it: "hair to shaved" is not English. Each member states
        // where the length ends, or how the hair was cut when there is no length
        // to reach for.
        fragmentByValue: {
          shaved: "shaved to the scalp",
          buzzed: "buzzed short",
          short: "cut short",
          chin_length: "to the chin",
          shoulder_length: "to the shoulders",
          mid_back: "to mid-back",
          waist_length: "to the waist",
          feet_length: "to the feet",
        },
      },
    },
  },
  {
    id: "hair.texture",
    label: "Hair texture",
    kind: "physical",
    category: "hair",
    valueType: "enum",
    description: "Natural curl pattern.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: ["straight", "wavy", "curly", "coily", "kinky"],
    bodyLocationId: "hair",
    aliases: ["hair texture"],
    imageAppearance: {
      class: "core",
      phrase: { group: "hair", role: "adjective", fragment: "{value}" },
    },
  },
  {
    id: "hair.density",
    label: "Hair density",
    kind: "physical",
    category: "hair",
    valueType: "enum",
    // Scalp-hair BULK — how much hair there is, independent of how thick each
    // strand is (`hair.strand_thickness`). Deliberately NOT the shared
    // `HAIR_DENSITY` list in shared-values.ts: that is *body* hair on arms and
    // legs, whose vocabulary starts at "none" — a different axis entirely.
    description: "Overall scalp-hair density — how much hair there is in total.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: ["sparse", "medium", "dense"],
    bodyLocationId: "hair",
    aliases: ["hair density"],
    imageAppearance: { class: "reinforcement", maximumFraming: "portrait" },
  },
  {
    id: "hair.strand_thickness",
    label: "Strand thickness",
    kind: "physical",
    category: "hair",
    valueType: "enum",
    description: "Thickness of individual strands (fine to wiry-thick).",
    mutability: "inherent",
    allowedValues: ["fine", "medium", "thick"],
    bodyLocationId: "hair",
    // No "fine hair" / "thick hair" aliases on purpose: colloquially those mean
    // DENSITY, so an ambiguous mention must not resolve to this axis.
    aliases: ["strand thickness"],
    imageAppearance: { class: "fine", maximumFraming: "close_up" },
  },
  {
    id: "hair.condition",
    label: "Hair condition",
    kind: "physical",
    category: "hair",
    valueType: "enum",
    // Strand SURFACE only — the curl pattern is `hair.texture`, bulk is
    // `hair.density`, per-strand mass is `hair.strand_thickness`. Mutable
    // because damage, care, age, and health change it over time (a fried dye
    // job turns hair straw-like).
    description: "Strand surface condition — affects sheen, friction, and how hair holds water.",
    mutability: "mutable",
    allowedValues: ["silky", "smooth", "healthy", "dry", "frizzy", "brittle", "straw_like"],
    bodyLocationId: "hair",
    aliases: ["hair condition"],
    imageAppearance: {
      class: "fine",
      maximumFraming: "portrait",
      phrase: { group: "hair", role: "adjective", fragment: "{compound}" },
    },
  },
  {
    id: "hair.arrangement",
    label: "Hair arrangement",
    kind: "presentation",
    category: "hair",
    valueType: "enum",
    // The STRUCTURED half of styling: what the hair is physically doing right
    // now (bound, pinned, hanging free), which is what hair affordances read.
    // The vocabulary is pinned by the hair affordance domain — do not extend
    // it; descriptive detail belongs in the free-text `hair.style`.
    description:
      "Structured arrangement of the hair right now — drives what the hair can physically do. Free-text styling detail stays in hair.style.",
    mutability: "mutable",
    allowedValues: ["loose", "ponytail", "braid", "bun", "other"],
    bodyLocationId: "hair",
    aliases: ["hair arrangement"],
    imageAppearance: {
      class: "fallback",
      phrase: {
        group: "hair",
        role: "trailer",
        // "other" means "read the styling text" (hair.style holds it), so it has
        // no phrase of its own and keeps the label form rather than inventing one.
        fragmentByValue: {
          loose: "worn loose",
          ponytail: "in a ponytail",
          braid: "in a braid",
          bun: "in a bun",
        },
      },
    },
    defaultValue: "loose",
    narratorGuidance: {
      loose: "hanging free — nothing binding or pinning it",
      ponytail: "gathered and tied back at a single point",
      braid: "plaited — one or more braids holding the length together",
      bun: "coiled and pinned close against the head",
      other: "deliberately arranged some other way — read the styling text",
    },
  },
  {
    id: "hair.style",
    label: "Hair style",
    kind: "presentation",
    category: "hair",
    valueType: "text",
    // Free display text only. The structured state mechanics read lives in
    // `hair.arrangement`; this describes the look around it.
    description: 'Current styling as free display text ("loose braid over one shoulder"); the structured state lives in hair.arrangement.',
    mutability: "mutable",
    bodyLocationId: "hair",
    aliases: ["hairstyle", "hair style"],
    imageAppearance: { class: "fallback" },
  },
]);
