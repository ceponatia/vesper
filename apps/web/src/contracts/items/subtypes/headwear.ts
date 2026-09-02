import type { ClothingSubtype } from "./types";

/**
 * Headwear subtypes (category `headwear`). Coverage stays hair-anchored like
 * the category template — a hat does not cover the face; a full-face veil or
 * mask is an authoring edit away (add `face` in the coverage tree).
 *
 * `hairOcclusion` is the type's DEFAULT hair-occlusion band
 * (docs/contracts/items/README.md §Hair occlusion): `none` rests in or on the
 * hair, `partial` hides some of it, `full` encloses it. It is separate from
 * coverage — a headscarf and a cap both cover `hair`; only the band tells them
 * apart — and an item may override it (a headscarf worn with the fringe out is
 * `partial`; a fully enclosing helmet is `full`).
 */
export const headwearSubtypes: readonly ClothingSubtype[] = [
  { id: "hat", label: "Hat", coverage: ["hair"], hairOcclusion: "partial" },
  { id: "cap", label: "Cap", coverage: ["hair"], hairOcclusion: "partial" },
  { id: "beanie", label: "Beanie", coverage: ["hair", "ears"], hairOcclusion: "partial" },
  { id: "hood", label: "Hood", coverage: ["hair", "ears"], hairOcclusion: "partial" },
  { id: "bandana", label: "Bandana", coverage: ["hair"], hairOcclusion: "partial" },
  { id: "headband", label: "Headband", coverage: ["hair"], hairOcclusion: "none" },
  { id: "hairpin", label: "Hairpin", coverage: ["hair"], hairOcclusion: "none" },
  { id: "ribbon", label: "Ribbon", coverage: ["hair"], hairOcclusion: "none" },
  { id: "tiara", label: "Tiara", coverage: ["hair"], hairOcclusion: "none" },
  { id: "crown", label: "Crown", coverage: ["hair"], hairOcclusion: "none" },
  { id: "veil", label: "Veil", coverage: ["hair"], hairOcclusion: "none" },
  { id: "visor", label: "Visor", coverage: ["hair"], hairOcclusion: "none" },
  { id: "headscarf", label: "Headscarf", coverage: ["hair", "ears"], hairOcclusion: "full" },
  { id: "hijab", label: "Hijab", coverage: ["hair", "ears", "neck"], hairOcclusion: "full" },
  { id: "turban", label: "Turban", coverage: ["hair", "ears"], hairOcclusion: "full" },
  { id: "wimple", label: "Wimple", coverage: ["hair", "ears", "neck"], hairOcclusion: "full" },
  { id: "snood", label: "Snood", coverage: ["hair"], hairOcclusion: "full" },
  { id: "swim_cap", label: "Swim cap", coverage: ["hair", "ears"], hairOcclusion: "full" },
  // Generic protective helmet: a fully enclosing one is an item override away.
  { id: "helmet", label: "Helmet", coverage: ["head"], hairOcclusion: "partial" },
];
