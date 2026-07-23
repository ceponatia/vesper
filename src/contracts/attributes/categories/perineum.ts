import { defineAttributeGroup } from "../types";

/**
 * Perineum — the short bridge of skin between the genitals and the anus.
 * UNIVERSAL anatomy (present on every realized body), NOT a body-config toggle,
 * so it is a top-level category like `anus` / `buttocks`. Moderation-sensitive:
 * its category is in INTIMATE_ATTRIBUTE_CATEGORIES (withheld from chat/images by
 * the same exposure gating as the anus). Bound to the universal `perineum` body
 * location (locations/intimate.ts), covered by any garment over `pelvis`.
 *
 * Image reveal is intentionally UNSET (same placeholder as the anus group —
 * front-only renders today; owner ruling 2026-07-23).
 */
export const perineumGroup = defineAttributeGroup("perineum", [
  {
    id: "perineum.texture",
    label: "Perineum texture",
    kind: "physical",
    category: "perineum",
    valueType: "enum",
    description: "Surface feel of the perineal skin between the genitals and anus.",
    mutability: "inherent",
    allowedValues: ["smooth", "soft", "velvety", "delicate", "ridged"],
    bodyLocationId: "perineum",
    aliases: ["perineum", "taint"],
    promptHints: ["Surfaces only at the intimate exposure/touch tier."],
  },
  {
    id: "perineum.sensitivity",
    label: "Perineum sensitivity",
    kind: "physical",
    category: "perineum",
    valueType: "enum",
    description: "Baseline responsiveness to touch — a tendency, not live arousal.",
    mutability: "mutable",
    allowedValues: ["numb", "low", "average", "high", "extremely_sensitive"],
    bodyLocationId: "perineum",
  },
  {
    id: "perineum.hair",
    label: "Perineum hair",
    kind: "physical",
    category: "perineum",
    valueType: "enum",
    description: "Hair over the perineum — natural growth or grooming.",
    mutability: "mutable",
    allowedValues: ["none", "smooth", "trimmed", "sparse", "light", "moderate", "thick", "dense"],
    bodyLocationId: "perineum",
  },
]);
