import { describe, expect, it } from "vitest";
import { listSdRecipes, sdRecipeById, sdRecipes } from "./sd-recipe-registry";
import { sdRecipeSchema } from "./sd-recipes";

/**
 * **A seeded recipe cannot ship without satisfying its own contract.**
 *
 * The registry is declared as typed literals, so TypeScript proves the shape and
 * nothing proves the values. The bad implementation this kills is a recipe that
 * typechecks and is quietly unusable: `revision: 0`, `steps: 200`, a width of
 * 833, `cfg: 40`, or — the one a reviewer is most likely to miss —
 * `id: "sd35/…"` left on a `family: "sdxl"` row after a copy-paste, which would
 * file every image it renders under the wrong family forever.
 *
 * Derived from `sdRecipes` rather than hand-enumerated, so a recipe added in
 * Stage 3 is covered the moment it is added and cannot be forgotten here. This
 * is the one test that has to grow by NOT being edited.
 */

describe("seeded SD recipes", () => {
  it.each(sdRecipes)("$id satisfies the recipe contract and resolves by id", (recipe) => {
    expect(sdRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(recipe.id.startsWith(`${recipe.family}/`)).toBe(true);
    expect(sdRecipeById(recipe.id)).toBe(recipe);
    expect(listSdRecipes(recipe.family)).toContain(recipe);
  });

  it("gives every recipe a unique id", () => {
    // `sdRecipeById` returns the FIRST match, so a duplicated id makes one
    // recipe permanently unreachable while both still appear in the lab's list.
    expect(new Set(sdRecipes.map((recipe) => recipe.id)).size).toBe(sdRecipes.length);
  });
});
