import { describe, expect, it } from "vitest";
import { sdTrainingRecipeRevision, sdTrainingRecipes } from "./sd-training-recipe-registry";
import { sdTrainingRecipeSchema } from "./training-manifest";

/**
 * **The rank-comparison arms may differ in rank and in nothing else.**
 *
 * This is the invariant Stage 4's whole result rests on. The comparison asks one
 * question — is rank 8 or rank 16 the better character LoRA — and §7's rule for
 * the entire plan is that only one variable moves at a time. The bad
 * implementation this kills is not a crash and not a typecheck failure: it is
 * somebody retuning one arm's `steps` or `resolution` while tuning, shipping two
 * recipes that differ in two ways, and producing a graded run whose winner
 * cannot be attributed to rank at all. Nothing about that is visible in a diff
 * that touches one literal in a hundred-line file, and nothing else in the
 * repository would notice.
 *
 * `revision` is excluded from the comparison because a bump is how a recipe
 * carries a deliberate change; whatever the bump changed is still compared, so a
 * retuned arm still fails here on the field it actually moved.
 *
 * The contract check that follows is derived from the registry rather than
 * hand-enumerated, so an arm added later is covered the moment it is added.
 */

/** Everything that is not the id, the revision, or the variable under test. */
type ComparedFields = Omit<(typeof sdTrainingRecipes)[number], "id" | "revision" | "rank">;

function comparedFields(recipe: (typeof sdTrainingRecipes)[number]): ComparedFields {
  const { id, revision, rank, ...rest } = recipe;
  void id;
  void revision;
  void rank;
  return rest;
}

describe("seeded SD training recipes", () => {
  it.each(sdTrainingRecipes)("$id@$revision satisfies the training-recipe contract", (recipe) => {
    expect(sdTrainingRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(recipe.id.startsWith(`${recipe.family}/`)).toBe(true);
    // The provenance lookup reaches every registered revision. A binding row
    // persists `{recipe id, revision}` beside real weights, so a revision that
    // stopped resolving would leave those weights unable to say what trained them.
    expect(sdTrainingRecipeRevision(recipe.id, recipe.revision)).toBe(recipe);
  });

  it("moves only rank between the character-LoRA arms", () => {
    const arms = sdTrainingRecipes.filter((recipe) => recipe.id.includes("character-lora"));
    expect(arms.length).toBeGreaterThan(1);
    const ranks = arms.map((arm) => arm.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const arm of arms.slice(1)) {
      expect(comparedFields(arm)).toEqual(comparedFields(arms[0]!));
    }
  });
});
