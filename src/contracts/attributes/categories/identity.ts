import { defineAttributeGroup } from "../types";

export const identityGroup = defineAttributeGroup("identity", [
  {
    id: "identity.gender",
    label: "Gender",
    kind: "physical",
    category: "identity",
    valueType: "enum",
    description: "Presented gender.",
    mutability: "inherent",
    allowedValues: ["female", "male", "androgynous", "nonbinary"],
    aliases: ["gender"],
    identityAnchor: true,
    // coreVisual so the forge always fills it: gender is the seed input for the
    // body-config (activatesGroups below), and a missing gender used to leave a
    // character with no intimate anatomy at all (was audit E1).
    coreVisual: true,
    // Creation-time body-config seed (not a lock — the editor stays
    // authoritative). androgynous / nonbinary seed nothing; the author chooses.
    activatesGroups: {
      female: { intimateRegions: ["vulva", "breasts"] },
      male: { intimateRegions: ["penis", "testicles"] },
    },
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
    // authorial/model choice, never a fallback).
    allowedValues: [
      "infant",
      "toddler",
      "young_child",
      "child",
      "tween",
      "teen",
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
