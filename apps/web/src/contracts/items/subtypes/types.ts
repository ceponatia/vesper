/**
 * Clothing subtypes (docs/contracts/items/README.md §Clothing subtypes):
 * per-category vocabularies for accessory clothing — jewelry, headwear, eyewear — reusing
 * the `definition.subtype` field objects already carry. One data file per
 * category in this folder so extending a vocabulary is a one-file edit.
 *
 * UNLIKE clothing categories (authoring templates that never enter gameplay
 * prompts), subtype labels ARE prompt-bearing: image prompts and the
 * narrator's wardrobe block lead with them ("nose ring — thin gold hoop"),
 * because a bare jewelry name gives the image model too little to place the
 * piece (face-jewelry plan).
 */
import type { HairOcclusion } from "../hair-occlusion";

export interface ClothingSubtype {
  id: string;
  label: string;
  /**
   * Coverage template applied when the subtype is picked in an editor — the
   * same pre-fill-then-edit semantics as category templates. Absent = leave
   * coverage untouched (a brooch pins to clothing, not to a body location).
   */
  coverage?: readonly string[];
  /**
   * Headwear only: the default HAIR OCCLUSION band for this type — how much of
   * the wearer's hair it hides (`../hair-occlusion.ts`). An item's own
   * `hairOcclusion` overrides it; absent on both ⇒ `none`.
   */
  hairOcclusion?: HairOcclusion;
}
