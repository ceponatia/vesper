import type { ClothingSubtype } from "./types";

/**
 * Eyewear subtypes (category `eyewear`). Coverage marks the eyes as the
 * anchor location; the occlusion engine treats coverage as concealment, which
 * only a blindfold truly does — but eyes carry no exposure-gated attributes,
 * so the simplification costs nothing (mirrors the existing category
 * template).
 */
export const eyewearSubtypes: readonly ClothingSubtype[] = [
  { id: "glasses", label: "Glasses", coverage: ["eyes"] },
  { id: "sunglasses", label: "Sunglasses", coverage: ["eyes"] },
  { id: "monocle", label: "Monocle", coverage: ["eyes"] },
  { id: "goggles", label: "Goggles", coverage: ["eyes"] },
  { id: "eyepatch", label: "Eyepatch", coverage: ["eyes"] },
  { id: "blindfold", label: "Blindfold", coverage: ["eyes"] },
  { id: "masquerade_mask", label: "Masquerade mask", coverage: ["eyes", "nose"] },
];
