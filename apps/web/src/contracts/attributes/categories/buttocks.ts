import { defineAttributeGroup } from "../types";

/**
 * Buttocks — universal silhouette anatomy, present on every realized body like
 * `hips` / `waist` (NOT a per-character body-config toggle). Size and shape read
 * *through* clothing (`imageReveal: "shape"`) and a scene render re-invents them
 * per image when unset, so they carry `renderVisual`. Bound to the everyday
 * `buttocks` body location (contracts/body/locations everyday.ts).
 *
 * Buttocks is NOT a moderation-intimate category (unlike the universal `anus` /
 * `perineum`, which now have their own categories): its silhouette is everyday
 * body detail. The rear skin-detail fields added here (cheek_separation, dimples,
 * texture, hair) leave `imageReveal` unset — they read from behind, and every
 * render today is a front view, so they surface in prose but not (yet) in image
 * prompts.
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
    allowedValues: [
      "flat",
      "small",
      "modest",
      "average",
      "rounded",
      "full",
      "plump",
      "large",
      "very_large",
      "massive",
    ],
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
    allowedValues: [
      "flat",
      "round",
      "heart_shaped",
      "bubble",
      "square",
      "pear",
      "athletic",
      "teardrop",
      "wide",
      "projected",
      "shelf",
      "sagging",
    ],
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
    allowedValues: ["jiggly", "soft", "plush", "supple", "firm", "toned", "muscular", "taut", "hard"],
    bodyLocationId: "buttocks",
    imageReveal: "shape",
  },
  {
    id: "buttocks.cheek_separation",
    label: "Cheek separation",
    kind: "physical",
    category: "buttocks",
    valueType: "enum",
    description: "How pronounced the cleft between the cheeks is.",
    mutability: "inherent",
    allowedValues: ["tight", "close", "average", "deep", "wide", "pronounced"],
    bodyLocationId: "buttocks",
  },
  {
    id: "buttocks.dimples",
    label: "Dimples",
    kind: "physical",
    category: "buttocks",
    valueType: "enum",
    description: "Dimples of Venus / sacral dimples at the base of the back.",
    mutability: "inherent",
    allowedValues: ["none", "faint", "visible", "deep", "prominent"],
    bodyLocationId: "buttocks",
  },
  {
    id: "buttocks.texture",
    label: "Buttocks texture",
    kind: "physical",
    category: "buttocks",
    valueType: "enum",
    description: "Skin texture over the buttocks; shifts with weight and tone.",
    mutability: "mutable",
    allowedValues: ["smooth", "soft", "velvety", "firm", "dimpled", "cellulite", "marked"],
    bodyLocationId: "buttocks",
  },
  {
    id: "buttocks.hair",
    label: "Buttocks hair",
    kind: "physical",
    category: "buttocks",
    valueType: "enum",
    description: "Hair over the buttocks and down the cleft — natural growth or grooming.",
    mutability: "mutable",
    allowedValues: ["none", "smooth", "trimmed", "sparse", "light", "moderate", "thick", "dense"],
    bodyLocationId: "buttocks",
  },
  {
    id: "buttocks.sensitivity",
    label: "Buttocks sensitivity",
    kind: "physical",
    category: "buttocks",
    valueType: "enum",
    description: "Baseline responsiveness to touch and impact — a tendency, not live arousal.",
    mutability: "mutable",
    allowedValues: ["numb", "low", "average", "high", "extremely_sensitive"],
    bodyLocationId: "buttocks",
  },
]);
