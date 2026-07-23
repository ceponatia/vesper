import { defineAttributeGroup } from "../types";

/**
 * Buttocks — universal silhouette anatomy, present on every realized body like
 * `hips` / `waist` (NOT a per-character body-config toggle). Size and shape read
 * *through* clothing (`imageReveal: "shape"`) and a scene render re-invents them
 * per image when unset, so they carry `renderVisual`. Bound to the everyday
 * `buttocks` body location (contracts/body/locations everyday.ts).
 *
 * The planned **anus** detail field will join this group, bound to the universal
 * `anus` location (locations/intimate.ts) — replacing the present-only note the
 * editor's Pelvis area shows today (components/characters/attribute-picker.tsx).
 */
export const buttocksGroup = defineAttributeGroup("buttocks", [
  {
    id: "buttocks.size",
    label: "Buttocks",
    kind: "physical",
    category: "buttocks",
    valueType: "enum",
    description: "How full the buttocks read in silhouette; tracks weight over a long story.",
    mutability: "mutable",
    renderVisual: true,
    allowedValues: ["flat", "small", "modest", "average", "rounded", "full", "plump", "large"],
    bodyLocationId: "buttocks",
    aliases: ["butt", "ass", "rear", "buttocks", "bottom", "backside", "glutes"],
    imageReveal: "shape",
  },
  {
    id: "buttocks.shape",
    label: "Buttocks shape",
    kind: "physical",
    category: "buttocks",
    valueType: "enum",
    description: "The overall shape the buttocks present.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: ["flat", "round", "heart_shaped", "bubble", "square", "athletic", "teardrop", "wide"],
    bodyLocationId: "buttocks",
    aliases: ["butt shape", "ass shape"],
    imageReveal: "shape",
  },
  {
    id: "buttocks.firmness",
    label: "Buttocks firmness",
    kind: "physical",
    category: "buttocks",
    valueType: "enum",
    description: "How firm or soft the buttocks feel and read.",
    mutability: "mutable",
    allowedValues: ["soft", "supple", "firm", "toned", "taut", "jiggly"],
    bodyLocationId: "buttocks",
    imageReveal: "shape",
  },
]);
