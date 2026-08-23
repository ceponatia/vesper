import type { SdModelFamily, SdRecipe } from "./sd-recipes";

/**
 * The seeded Stable Diffusion recipes.
 *
 * **These are the plan's §7 trial STARTING POINTS, not tuned defaults.** Nothing
 * below has been graded against anything yet; the numbers are where Stage 3's
 * controlled matrix begins, and the plan is explicit that "only one variable
 * should move at a time" while it runs. Whichever cell wins becomes revision 2
 * of the recipe it belongs to. Reading a value here as an endorsement is the one
 * mistake this file can cause, which is why both entries are revision 1 and say
 * so in their own description.
 *
 * The pair is deliberately minimal, and the gap between them is the only
 * variable Stage 3 opens first: identity. `sdxl/base-portrait` is the control —
 * vanilla SDXL, no identity conditioning, no LoRA — and `sdxl/identity-portrait`
 * is the same sampler configuration with the two identity layers switched on.
 * Any quality difference between them is therefore attributable, which a third
 * recipe differing in four ways at once would destroy.
 *
 * Declared as typed literals rather than parsed at module load, on purpose: the
 * compiler proves the SHAPE, and `sd-recipe-registry.test.ts` proves every entry
 * still satisfies the schema's value rules and cross-field refinement. Parsing
 * here would make that test assert its own setup.
 */
export const sdRecipes: readonly SdRecipe[] = [
  {
    id: "sdxl/base-portrait",
    family: "sdxl",
    revision: 1,
    description:
      "Vanilla SDXL portrait, no identity conditioning — the control arm of the Stage 3 identity matrix. Trial starting point, not a tuned default.",
    // Base SDXL, deliberately. §6 requires a vanilla control in the first
    // checkpoint evaluation, and it also refuses to lock Vesper to a community
    // checkpoint before licensing and hosted-product use are explicitly
    // reviewed — so the realistic checkpoint that will be compared against this
    // one is not named anywhere in this package yet.
    checkpoint: "stabilityai/stable-diffusion-xl-base-1.0",
    sampler: "dpmpp_2m",
    scheduler: "karras",
    steps: 35,
    cfg: 5,
    width: 832,
    height: 1216,
  },
  {
    id: "sdxl/identity-portrait",
    family: "sdxl",
    revision: 1,
    description:
      "Base portrait settings plus both identity layers: a character LoRA and PuLID-style runtime conditioning. Trial starting point, not a tuned default.",
    checkpoint: "stabilityai/stable-diffusion-xl-base-1.0",
    sampler: "dpmpp_2m",
    scheduler: "karras",
    steps: 35,
    cfg: 5,
    width: 832,
    height: 1216,
    // Mid-band on both, per §8's "neither should automatically be run at maximum
    // strength": 0.80 is the middle PuLID weight of the three Stage 3 tests
    // (0.65 / 0.80 / 0.95), and 0.8 is the centre of §7's 0.7–0.9 LoRA band.
    identityWeight: 0.8,
    loraScale: 0.8,
    // No ControlNet, and this is a rule rather than an omission: Stage 3 says
    // "do not add ControlNet until this stage has a clear winner", because a
    // depth or pose map introduced alongside identity makes neither result
    // attributable.
  },
];

/** The recipe with this exact id, or nothing. Ids are unique across families. */
export function sdRecipeById(id: string): SdRecipe | undefined {
  return sdRecipes.find((recipe) => recipe.id === id);
}

/**
 * Every recipe, or every recipe of one family.
 *
 * The family filter exists because §6 keeps SDXL and SD3.5 on separate internal
 * workflows: a caller offering recipes for a registered SDXL deployment must not
 * be able to hand it an `sd35/*` name that the deployment has no nodes for.
 */
export function listSdRecipes(family?: SdModelFamily): readonly SdRecipe[] {
  if (family === undefined) return sdRecipes;
  return sdRecipes.filter((recipe) => recipe.family === family);
}
