import type { SdModelFamily, SdRecipe } from "./sd-recipes";

/**
 * The seeded Stable Diffusion recipes.
 *
 * **These are trial STARTING POINTS, not tuned defaults.** Nothing
 * below has been graded against anything yet; the numbers are where Stage 3's
 * controlled matrix begins, and only one variable
 * should move at a time while it runs. Whichever cell wins becomes revision 2
 * of the recipe it belongs to. Reading a value here as an endorsement is the one
 * mistake this file can cause, which is why every entry is revision 1 and says so
 * in its own description.
 *
 * The set is deliberately minimal, and every entry shares one sampler
 * configuration so that the only variable Stage 3 opens is identity.
 * `sdxl/base-portrait` is the control — vanilla SDXL, no identity conditioning,
 * no LoRA — and the rest switch on one identity layer at a time: a character
 * LoRA (`sdxl/lora-portrait`), runtime conditioning at three strengths, or both
 * (`sdxl/identity-portrait`). Any quality difference between two of them is
 * therefore attributable, which recipes differing in four ways at once would
 * destroy.
 *
 * **Adding an entry here changes the DEPLOYED renderer's vocabulary.**
 * `deployment/recipes.json` is generated from this list and baked into the
 * container image, and the predictor refuses a recipe id it does not carry. A
 * new recipe is therefore not live until `pnpm tsx
 * scripts/generate-sd-deployment-recipes.ts` has run and the deployment has been
 * pushed again (`deployment/README.md`).
 *
 * Declared as typed literals rather than parsed at module load, on purpose: the
 * compiler proves the SHAPE, and `sd-recipe-registry.test.ts` proves every entry
 * still satisfies the schema's value rules and cross-field refinement. Parsing
 * here would make that test assert its own setup.
 *
 * **A revision bump ADDS an entry; it never edits one in place.** The registry
 * may hold several revisions of the same id, and the highest revision is the
 * live one. This is what makes the recipe contract's promise real: Vesper's
 * render provenance persists `{recipe id, revision}`, so an image rendered
 * under revision 1 must still resolve to the frozen values that produced it
 * after revision 2 becomes the one operators are offered. A registry that
 * replaced entries would leave every historical render pointing at settings
 * that no longer exist anywhere but git archaeology.
 */
export const sdRecipes: readonly SdRecipe[] = [
  {
    id: "sdxl/base-portrait",
    family: "sdxl",
    revision: 1,
    description:
      "Vanilla SDXL portrait, no identity conditioning — the control arm of the Stage 3 identity matrix. Trial starting point, not a tuned default.",
    // Base SDXL, deliberately. The first checkpoint evaluation requires a
    // vanilla control, and it also refuses to lock Vesper to a community
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
    // Mid-band on both, because neither should automatically be run at maximum
    // strength: 0.80 is the middle PuLID weight of the three Stage 3 tests
    // (0.65 / 0.80 / 0.95), and 0.8 is the centre of the 0.7–0.9 LoRA band.
    identityWeight: 0.8,
    loraScale: 0.8,
    // No ControlNet, and this is a rule rather than an omission: Stage 3 says
    // "do not add ControlNet until this stage has a clear winner", because a
    // depth or pose map introduced alongside identity makes neither result
    // attributable.
  },
  {
    // Stage 3's LoRA-ONLY arm — the matrix is base SDXL; PuLID only; LoRA only;
    // LoRA + PuLID. It could not be seeded with the other three because no SDXL
    // character LoRA existed until Stage 4 trained one, and an arm named after a
    // thing that does not exist renders the control twice.
    //
    // The absence of `identityWeight` is the arm, not an oversight. The deployed
    // renderer gates identity conditioning on the recipe and REFUSES a reference
    // image sent to a recipe without a weight, so this arm cannot accidentally
    // receive the PuLID anchor and quietly become the fourth cell. Everything
    // else is copied verbatim from `sdxl/identity-portrait` — the one-variable
    // rule, which here means the LoRA is the only difference from the control.
    id: "sdxl/lora-portrait",
    family: "sdxl",
    revision: 1,
    description:
      "Base portrait settings plus a character LoRA and no runtime identity conditioning — the LoRA-only arm of the Stage 3 identity matrix. Trial arm, not a tuned default.",
    checkpoint: "stabilityai/stable-diffusion-xl-base-1.0",
    sampler: "dpmpp_2m",
    scheduler: "karras",
    steps: 35,
    cfg: 5,
    width: 832,
    height: 1216,
    loraScale: 0.8,
  },
  // The other two arms of Stage 3's identity-strength trial. There are three
  // PuLID test points — 0.65 / 0.80 / 0.95 — and `sdxl/identity-portrait` above
  // is the middle one, so these two complete the set.
  //
  // Separate IDS rather than revisions of the identity recipe, deliberately. A
  // revision REPLACES: it is the answer to "what produced this image" after a
  // comparison has been won. These three are concurrent arms of a comparison
  // that has not been run, and they all have to be runnable and distinguishable
  // at the same time. Whichever arm wins becomes revision 2 of
  // `sdxl/identity-portrait`, and these two are retired rather than promoted —
  // an id that means "the 0.65 arm" has no meaning once the trial is over.
  //
  // Everything except `identityWeight` is copied verbatim from the middle arm,
  // because only one variable moves at a time.
  {
    id: "sdxl/identity-portrait-w065",
    family: "sdxl",
    revision: 1,
    description:
      "Stage 3 identity-strength trial, weak arm: the identity portrait with PuLID at 0.65. Trial arm, not a tuned default.",
    checkpoint: "stabilityai/stable-diffusion-xl-base-1.0",
    sampler: "dpmpp_2m",
    scheduler: "karras",
    steps: 35,
    cfg: 5,
    width: 832,
    height: 1216,
    identityWeight: 0.65,
    loraScale: 0.8,
  },
  {
    id: "sdxl/identity-portrait-w095",
    family: "sdxl",
    revision: 1,
    description:
      "Stage 3 identity-strength trial, strong arm: the identity portrait with PuLID at 0.95. Trial arm, not a tuned default.",
    checkpoint: "stabilityai/stable-diffusion-xl-base-1.0",
    sampler: "dpmpp_2m",
    scheduler: "karras",
    steps: 35,
    cfg: 5,
    width: 832,
    height: 1216,
    identityWeight: 0.95,
    loraScale: 0.8,
  },
];

/** The highest revision per id among these entries — the ones an operator may still run. */
function latestByIdOf(entries: readonly SdRecipe[]): Map<string, SdRecipe> {
  const latest = new Map<string, SdRecipe>();
  for (const recipe of entries) {
    const current = latest.get(recipe.id);
    if (current === undefined || recipe.revision > current.revision) latest.set(recipe.id, recipe);
  }
  return latest;
}

/**
 * The LIVE recipe with this id — the highest registered revision — or nothing.
 * Ids are unique across families, so this never has to disambiguate.
 */
export function sdRecipeById(id: string): SdRecipe | undefined {
  return latestByIdOf(sdRecipes.filter((recipe) => recipe.id === id)).get(id);
}

/**
 * One exact frozen revision, or nothing. This is the provenance lookup: an
 * image row that recorded `{recipe id, revision}` resolves through here to the
 * values that actually produced it, whether or not that revision is still the
 * live one.
 */
export function sdRecipeRevision(id: string, revision: number): SdRecipe | undefined {
  return sdRecipes.find((recipe) => recipe.id === id && recipe.revision === revision);
}

/**
 * Every live recipe — the highest revision of each id — or every live recipe of
 * one family. Retired revisions are deliberately absent: they exist to resolve
 * history, not to be offered to an operator picking a recipe to run.
 *
 * The family filter exists because SDXL and SD3.5 stay on separate internal
 * workflows: a caller offering recipes for a registered SDXL deployment must not
 * be able to hand it an `sd35/*` name that the deployment has no nodes for.
 */
export function listSdRecipes(family?: SdModelFamily): readonly SdRecipe[] {
  const scoped = family === undefined ? sdRecipes : sdRecipes.filter((recipe) => recipe.family === family);
  return [...latestByIdOf(scoped).values()];
}
