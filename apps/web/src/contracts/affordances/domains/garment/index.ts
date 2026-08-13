/**
 * The garment affordance domain — the plan's SECOND proving domain, slice 6
 * (body-attribute-affordances.spec.garment-interaction.md).
 *
 * ```text
 * wardrobe material + construction + coverage  →  structural profile
 *                        + current saturation  →  effective mechanics
 *              + asserted contacts, events, focus  →  garment frame
 *                                               →  three phenomena
 *                                               →  the staged coverage read
 * ```
 *
 * It exists to prove the shared foundation is not secretly hair-specific, and it
 * does so by being unlike hair in the two ways that matter: its structure comes
 * from something the character WEARS rather than from the character, and it is
 * plural and regional rather than singular. Neither required the core to learn a
 * domain noun — see `domain.ts` for the two seams that absorbed them.
 *
 * Import direction is one-way: this folder consumes the affordance core, the
 * body-location registry, and the wardrobe's material registry. Nothing in
 * `items/` or `core/` imports back.
 */
export * from "./profile";
export * from "./mechanics";
export * from "./frame";
export * from "./effective-coverage";
export * from "./phenomena";
export * from "./domain";
export * from "./fixtures";
