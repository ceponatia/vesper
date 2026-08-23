import type { SdModelFamily } from "../recipes/sd-recipes";
import type { SdTrainingRecipe } from "./training-manifest";

/**
 * The seeded character-LoRA training recipes
 * (sd-rendering-package.plan.md §20, Stage 4).
 *
 * **Two entries, differing in exactly one number.** Stage 4 asks one question —
 * rank 8 or rank 16 — and §7's rule for the whole plan is that only one variable
 * moves at a time. So every other value below is copied verbatim between the two,
 * and `sd-training-recipe-registry.test.ts` checks that it stayed that way rather
 * than trusting a reader to notice a drifted digit.
 *
 * **These are trial starting points, not tuned defaults**, exactly as the render
 * recipes are. Nothing here has been graded; the winning rank becomes revision 2
 * of a single `sdxl/character-lora` recipe, and the losing arm is retired the way
 * the render registry retires a losing identity arm.
 *
 * **A revision bump ADDS an entry; it never edits one in place.** A binding row
 * persists `{recipe id, revision}` as the provenance of real weights sitting in
 * the LoRA library, so a revision that changed underneath it would leave every
 * trained LoRA describing settings that no longer exist.
 *
 * ## What a recipe deliberately does not say
 *
 * **Which trainer runs it.** A trainer is a provider fact — a Replicate model at
 * a pinned version — and this package holds no provider knowledge (README
 * §Boundary). The operator script pins the trainer and records that pin beside
 * the weights; the recipe pins what Stable Diffusion is being asked to learn.
 *
 * **How the images are captioned.** Captioning belongs to the trainer, and the
 * one Vesper pins today writes its own captions from a prefix rather than reading
 * the caption fields an `SdTrainingImage` may carry. A recipe that specified a
 * caption format would be describing behavior it cannot cause.
 */
export const sdTrainingRecipes: readonly SdTrainingRecipe[] = [
  {
    id: "sdxl/character-lora-r8",
    family: "sdxl",
    revision: 1,
    // The same checkpoint the render recipes name. A LoRA is only valid on the
    // weights it was trained against, so training against anything other than
    // the deployed renderer's checkpoint would produce a file the renderer can
    // load and cannot use.
    baseCheckpoint: "stabilityai/stable-diffusion-xl-base-1.0",
    rank: 8,
    steps: 1000,
    learningRate: 0.0001,
    // 1024 rather than the more common 768: the deployed renderer's native
    // portrait is 832x1216, and a LoRA trained smaller than the size it will be
    // sampled at learns detail the render then has to invent. §7 fixes the
    // render size, so the training size follows it rather than the other way
    // round.
    resolution: 1024,
    batchSize: 4,
    // No trigger token by default. §22 makes textual inversion a non-goal for
    // the first training pass, and the deployed renderer loads LoRA weights
    // only — it has no embedding loader — so a token trained as an embedding
    // would be a prompt word pointing at nothing. The operator supplies a plain
    // in-vocabulary word instead, per-character, and it is recorded on the
    // binding rather than frozen into a recipe shared by every character.
  },
  {
    id: "sdxl/character-lora-r16",
    family: "sdxl",
    revision: 1,
    baseCheckpoint: "stabilityai/stable-diffusion-xl-base-1.0",
    rank: 16,
    steps: 1000,
    learningRate: 0.0001,
    resolution: 1024,
    batchSize: 4,
  },
];

/** The highest revision per id among these entries — the ones an operator may still run. */
function latestByIdOf(entries: readonly SdTrainingRecipe[]): Map<string, SdTrainingRecipe> {
  const latest = new Map<string, SdTrainingRecipe>();
  for (const recipe of entries) {
    const current = latest.get(recipe.id);
    if (current === undefined || recipe.revision > current.revision) latest.set(recipe.id, recipe);
  }
  return latest;
}

/** The LIVE training recipe with this id — the highest registered revision — or nothing. */
export function sdTrainingRecipeById(id: string): SdTrainingRecipe | undefined {
  return latestByIdOf(sdTrainingRecipes.filter((recipe) => recipe.id === id)).get(id);
}

/**
 * One exact frozen revision, or nothing — the provenance lookup. A binding row
 * that recorded `{recipe id, revision}` resolves through here to the settings
 * that actually trained its weights, whether or not that revision is still live.
 */
export function sdTrainingRecipeRevision(id: string, revision: number): SdTrainingRecipe | undefined {
  return sdTrainingRecipes.find((recipe) => recipe.id === id && recipe.revision === revision);
}

/** Every live training recipe, or every live one of a single family. */
export function listSdTrainingRecipes(family?: SdModelFamily): readonly SdTrainingRecipe[] {
  const scoped = family === undefined ? sdTrainingRecipes : sdTrainingRecipes.filter((r) => r.family === family);
  return [...latestByIdOf(scoped).values()];
}
