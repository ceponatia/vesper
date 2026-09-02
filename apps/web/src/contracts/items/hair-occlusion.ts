import { z } from "zod";

/**
 * HAIR OCCLUSION — how much of a wearer's hair their worn headwear hides
 * (docs/contracts/items/README.md §Hair occlusion).
 *
 * A band, not a coverage read. Ordinary wardrobe coverage says WHICH body
 * locations a garment reaches and is per-location boolean-ish; it cannot tell
 * a cap (hair mostly visible) from a hijab (no hair visible), because both
 * cover `hair`. This band is that missing signal, resolved once per subject
 * and CARRIED with the wardrobe data every consumer already reads — image
 * prompts, narrator prompts and the hair-affordance read all take the resolved
 * value and apply their own consequence; none of them re-derives it from item
 * rows or garment names.
 *
 * It never changes what a garment covers, what it occludes, or how it layers.
 *
 * This module is a LEAF: the band and the pure resolver only. The per-item
 * rule (subtype default + item override) is `hairOcclusionForItem` in
 * `subtypes/index.ts`, beside the registry it reads.
 */

/** Weakest → strongest. `partial` and `none` are DISTINCT even where a consumer treats them alike. */
export const hairOcclusionBands = ["none", "partial", "full"] as const;
export const hairOcclusionSchema = z.enum(hairOcclusionBands);
export type HairOcclusion = z.infer<typeof hairOcclusionSchema>;

/**
 * The resolved band for a missing or unknown value. Bad data resolves toward
 * SHOWING hair, so a corrupt row can never silently erase a character's
 * appearance from a prompt.
 */
export const HAIR_OCCLUSION_NONE: HairOcclusion = "none";

const HAIR_OCCLUSION_RANK: Readonly<Record<HairOcclusion, number>> = { none: 0, partial: 1, full: 2 };

/** The band `value` names, or `undefined` for anything that is not one — the trust-boundary read. */
export function hairOcclusionOf(value: unknown): HairOcclusion | undefined {
  const parsed = hairOcclusionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Strongest wins: `full` over `partial` over `none`. */
export function strongerHairOcclusion(left: HairOcclusion, right: HairOcclusion): HairOcclusion {
  return HAIR_OCCLUSION_RANK[right] > HAIR_OCCLUSION_RANK[left] ? right : left;
}

/**
 * One piece of a subject's wardrobe as the resolver sees it: whether it is
 * currently WORN, and the band it carries (already resolved per item —
 * `hairOcclusionForItem`). A piece with no band contributes `none`.
 */
export interface HairOcclusionPiece {
  readonly worn: boolean;
  readonly hairOcclusion?: HairOcclusion | undefined;
}

/**
 * The subject's resolved band over their wardrobe pieces.
 *
 * - Only WORN pieces count. Held, stored and scene-placed items hide nothing.
 * - Several worn pieces: the strongest band wins.
 * - A missing band is `none`; nothing worn is `none`.
 *
 * PURE and order-independent.
 */
export function resolveHairOcclusion(pieces: readonly HairOcclusionPiece[]): HairOcclusion {
  let resolved: HairOcclusion = HAIR_OCCLUSION_NONE;
  for (const piece of pieces) {
    if (!piece.worn) continue;
    resolved = strongerHairOcclusion(resolved, piece.hairOcclusion ?? HAIR_OCCLUSION_NONE);
  }
  return resolved;
}
