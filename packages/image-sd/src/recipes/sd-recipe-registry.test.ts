import { describe, expect, it } from "vitest";
import { listSdRecipes, sdRecipeById, sdRecipeRevision, sdRecipes } from "./sd-recipe-registry";
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
  it.each(sdRecipes)("$id@$revision satisfies the recipe contract and resolves", (recipe) => {
    expect(sdRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(recipe.id.startsWith(`${recipe.family}/`)).toBe(true);
    // The provenance lookup reaches every registered revision, live or retired…
    expect(sdRecipeRevision(recipe.id, recipe.revision)).toBe(recipe);
    // …while the live lookup and the operator list only ever surface the
    // highest revision of an id. With single-revision entries the two coincide;
    // the day a revision 2 lands, this same derivation proves revision 1 stays
    // resolvable without being offered.
    const live = sdRecipeById(recipe.id);
    if (live === undefined) throw new Error(`no live recipe resolves for ${recipe.id}`);
    expect(live.id).toBe(recipe.id);
    expect(live.revision).toBeGreaterThanOrEqual(recipe.revision);
    expect(listSdRecipes(recipe.family)).toContain(live);
  });

  it("never registers the same id + revision pair twice", () => {
    // `sdRecipeRevision` returns the FIRST match, so a duplicated pair makes
    // one entry permanently unreachable — and provenance that recorded the pair
    // could resolve to either set of values.
    expect(new Set(sdRecipes.map((recipe) => `${recipe.id}@${recipe.revision}`)).size).toBe(sdRecipes.length);
  });
});
