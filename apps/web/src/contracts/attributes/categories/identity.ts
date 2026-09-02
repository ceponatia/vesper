import { defineAttributeGroup } from "../types";

export const identityGroup = defineAttributeGroup("identity", [
  {
    id: "identity.gender",
    label: "Gender",
    kind: "physical",
    category: "identity",
    valueType: "enum",
    // The androgynous / nonbinary presentations are split by sex at birth
    // (…_born_female / …_born_male) so image generation can render the right
    // underlying build — an androgynous presentation reads very differently on a
    // natal-female vs natal-male frame. Pick the variant matching the character's
    // natal sex; female / male presentations imply it. (A structured
    // `identity.natal_sex` scaffold below will take this over later.)
    description:
      "Presented gender. For an androgynous or nonbinary presentation, choose the variant matching the character's sex at birth.",
    mutability: "inherent",
    allowedValues: [
      "female",
      "male",
      "androgynous_born_female",
      "androgynous_born_male",
      "nonbinary_born_female",
      "nonbinary_born_male",
    ],
    aliases: ["gender"],
    identityAnchor: true,
    // coreVisual so the forge always fills it: gender is the seed input for the
    // body-config (activatesGroups below), and a missing gender used to leave a
    // character with no intimate anatomy at all (was audit E1).
    coreVisual: true,
    defaultValue: "female",
    // Creation-time body-config seed (not a lock — the editor stays
    // authoritative). The born-sex variants seed the matching natal anatomy by
    // default (an androgynous-born-female still has natal female anatomy unless
    // the author edits it); a flat-chested or transitioned look is one edit away.
    activatesGroups: {
      female: { intimateRegions: ["vulva", "breasts"] },
      male: { intimateRegions: ["penis", "testicles"] },
      androgynous_born_female: { intimateRegions: ["vulva", "breasts"] },
      androgynous_born_male: { intimateRegions: ["penis", "testicles"] },
      nonbinary_born_female: { intimateRegions: ["vulva", "breasts"] },
      nonbinary_born_male: { intimateRegions: ["penis", "testicles"] },
    },
  },
  {
    id: "identity.natal_sex",
    label: "Natal sex",
    kind: "biological",
    category: "identity",
    valueType: "enum",
    // A structured scaffold for the character's sex at birth, distinct from
    // presented `gender`. Deliberately NOT wired into any generated prompt yet
    // (`excludeFromPrompts`) — the gender `…_born_…` variant carries natal sex
    // into image gen for now. The editor surfaces this only for an androgynous /
    // nonbinary presentation (redundant for plain female / male). Planned
    // expansion: intersex, trans handling, model-facing meaning of each gender,
    // possibly superseding the gender born-variants.
    description:
      "Sex assigned at birth (structured scaffold — not yet used in image or narrator prompts; the gender born-variant steers rendering for now).",
    mutability: "inherent",
    allowedValues: ["female", "male"],
    aliases: ["natal sex", "birth sex", "sex at birth", "assigned sex"],
    excludeFromPrompts: true,
  },
  {
    id: "identity.apparent_age",
    label: "Apparent age",
    kind: "physical",
    category: "identity",
    valueType: "enum",
    description: "Age the character visibly reads as.",
    mutability: "inherent",
    // Ascending by age. The minor bands (infant…teen) exist so background
    // characters — families, kids in a crowd — can populate a world, but they
    // are listed in `autoDefaultExcludes` so an unspecified character never
    // silently defaults to one (the cast skews adult; minors are an explicit
    // authorial/model choice, never a fallback). `eighteen` (owner ruling
    // 2026-07-29) is the youngest band IMAGE prompts can state: "teen" is
    // ambiguous (could read 15–17), so the image vocabulary
    // (`imageAgeBandPhrases`, contracts/images/character-adapter.ts) states
    // explicit adult wording for `eighteen`+ and NO age word at all for the
    // minor bands — those stay narrator-only vocabulary.
    allowedValues: [
      "infant",
      "toddler",
      "young_child",
      "child",
      "tween",
      "teen",
      "eighteen",
      "young_adult",
      "mid_twenties",
      "late_twenties",
      "early_thirties",
      "late_thirties",
      "forties",
      "fifties",
      "sixties_plus",
    ],
    autoDefaultExcludes: ["infant", "toddler", "young_child", "child", "tween", "teen"],
    aliases: ["age", "apparent age"],
    promptHints: ["State apparent age as an impression (\"somewhere in her late thirties\", \"barely school-age\"), never as a number from a file."],
    coreVisual: true,
    defaultValue: "mid_twenties",
    identityAnchor: true,
  },
  {
    id: "identity.heritage",
    label: "Heritage",
    kind: "cultural",
    category: "identity",
    valueType: "text",
    // Free text, not enum: real-world ethnicities and fantasy ancestries can't
    // share a closed list ("Latina", "Igbo", "wood-elf of the northern clans").
    description: "Ethnic or ancestral heritage as the text presents it (\"Latina\", \"Igbo\", \"wood-elf of the northern clans\").",
    mutability: "inherent",
    aliases: ["heritage", "ethnicity", "ancestry"],
    identityAnchor: true,
  },
]);
