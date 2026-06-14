import type { BodyLocation } from "./types";

/**
 * Humanoid body-location tree at wardrobe-useful granularity (the original
 * reverie fork). Roots double as the coverage editor's column groups
 * (head · torso · arms · pelvis · legs). `groin`/`buttocks` exist here only so
 * clothing can cover them — explicit intimate anatomy lives in `intimate.ts`
 * and is gated per character.
 *
 * Stored coverage arrays reference ids directly, so reparenting an id is safe
 * for exploded data but changes what a bare parent id implies — prefer adding
 * children over moving them.
 */
export const humanoidEverydayLocations: readonly BodyLocation[] = [
  { id: "head", label: "head", coverageRelevant: true },
  { id: "hair", label: "hair", parentId: "head", coverageRelevant: true },
  { id: "face", label: "face", parentId: "head", coverageRelevant: true },
  { id: "eyes", label: "eyes", parentId: "face", coverageRelevant: true },
  { id: "ears", label: "ears", parentId: "head", coverageRelevant: true },
  { id: "torso", label: "torso", coverageRelevant: true },
  { id: "neck", label: "neck", parentId: "torso", coverageRelevant: true },
  { id: "shoulders", label: "shoulders", parentId: "torso", coverageRelevant: true },
  { id: "chest", label: "chest", parentId: "torso", coverageRelevant: true },
  { id: "back", label: "back", parentId: "torso", coverageRelevant: true },
  { id: "waist", label: "waist", parentId: "torso", coverageRelevant: true },
  { id: "arms", label: "arms", coverageRelevant: true },
  { id: "upper_arms", label: "upper arms", parentId: "arms", coverageRelevant: true },
  { id: "forearms", label: "forearms", parentId: "arms", coverageRelevant: true },
  { id: "wrists", label: "wrists", parentId: "arms", coverageRelevant: true },
  { id: "hands", label: "hands", parentId: "arms", coverageRelevant: true },
  { id: "fingers", label: "fingers", parentId: "hands", coverageRelevant: true },
  { id: "pelvis", label: "pelvis", coverageRelevant: true },
  { id: "hips", label: "hips", parentId: "pelvis", coverageRelevant: true },
  { id: "groin", label: "groin", parentId: "pelvis", coverageRelevant: true },
  { id: "buttocks", label: "buttocks", parentId: "pelvis", coverageRelevant: true },
  { id: "legs", label: "legs", coverageRelevant: true },
  { id: "thighs", label: "thighs", parentId: "legs", coverageRelevant: true },
  { id: "calves", label: "calves", parentId: "legs", coverageRelevant: true },
  { id: "ankles", label: "ankles", parentId: "legs", coverageRelevant: true },
  { id: "feet", label: "feet", parentId: "legs", coverageRelevant: true },
  { id: "toes", label: "toes", parentId: "feet", coverageRelevant: true },
];
