import type { ClothingSubtype } from "./types";

/**
 * Headwear subtypes (category `headwear`). Coverage stays hair-anchored like
 * the category template — a hat does not cover the face; a full-face veil or
 * mask is an authoring edit away (add `face` in the coverage tree).
 */
export const headwearSubtypes: readonly ClothingSubtype[] = [
  { id: "hat", label: "Hat", coverage: ["hair"] },
  { id: "cap", label: "Cap", coverage: ["hair"] },
  { id: "beanie", label: "Beanie", coverage: ["hair", "ears"] },
  { id: "hood", label: "Hood", coverage: ["hair", "ears"] },
  { id: "headband", label: "Headband", coverage: ["hair"] },
  { id: "hairpin", label: "Hairpin", coverage: ["hair"] },
  { id: "ribbon", label: "Ribbon", coverage: ["hair"] },
  { id: "tiara", label: "Tiara", coverage: ["hair"] },
  { id: "crown", label: "Crown", coverage: ["hair"] },
  { id: "veil", label: "Veil", coverage: ["hair"] },
  { id: "headscarf", label: "Headscarf", coverage: ["hair", "ears"] },
  { id: "helmet", label: "Helmet", coverage: ["head"] },
];
