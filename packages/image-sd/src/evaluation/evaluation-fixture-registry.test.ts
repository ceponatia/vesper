import { describe, expect, it } from "vitest";
import { sdRecipeById } from "../recipes/sd-recipe-registry";
import { sdEvaluationFixtures } from "./evaluation-fixture-registry";
import { sdEvaluationDimensions, sdEvaluationFixtureSchema } from "./evaluation-fixtures";

/**
 * **A seeded fixture cannot ship in a state that would waste a paid run.**
 *
 * Stage 3's matrix is money: every fixture is rendered once per arm, on a GPU,
 * and the images are graded by eye afterwards. Each claim below kills a defect
 * that survives `tsc` and only shows up as a run that cannot be scored.
 *
 * Derived from `sdEvaluationFixtures` and from `sdEvaluationDimensions`, never
 * hand-enumerated, so a fixture added later is covered by being added and a
 * dimension added later is covered by being added.
 */

/**
 * Terms a fixture's negative prompt may never carry, taken from the list of
 * things a legitimate Vesper render CAN contain: unusual anatomy, missing limbs,
 * prosthetics, text, logos, blur, non-human features, authored wardrobe and
 * exposure states.
 *
 * This is the realistic defect, not a hypothetical one. Stock SDXL negative
 * prompts are pasted between forum posts and are made almost entirely of these
 * words, and `state-prosthetic-forearm` exists to render exactly what
 * "deformed, extra limbs, missing limbs" suppresses. A single paste would leave
 * that cell scoring a confident zero on `state_obedience` that says nothing
 * about identity strength at all.
 */
const FORBIDDEN_NEGATIVE_TERMS = [
  "deformed",
  "disfigured",
  "mutated",
  "mutation",
  "bad anatomy",
  "extra limbs",
  "extra arms",
  "extra fingers",
  "missing limbs",
  "missing arm",
  "amputee",
  "prosthetic",
  "text",
  "letters",
  "watermark",
  "signature",
  "logo",
  "blur",
  "blurry",
  "out of focus",
  "monster",
  "alien",
  "creature",
  "non-human",
  "nude",
  "naked",
  "topless",
  "nsfw",
  "clothed",
  "clothing",
  "underwear",
] as const;

/**
 * Whole-word containment. Substring matching is wrong in both directions here:
 * "text" would fire on "natural skin texture", and "age" would count "a general
 * image benchmark" as coverage of the `age` dimension.
 */
function mentions(haystack: string, term: string): boolean {
  return new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, "i").test(haystack);
}

describe("seeded SD evaluation fixtures", () => {
  it.each(sdEvaluationFixtures)("$id is renderable and grades something", (fixture) => {
    // The registry is typed literals, so TypeScript proves the shape and only
    // this proves the values — a seed of -1, an empty prompt, or (the one a
    // reviewer misses) a `recipeId` typo that no registry resolves, which the
    // renderer refuses AFTER the prediction has been created and billed.
    expect(sdEvaluationFixtureSchema.parse(fixture)).toEqual(fixture);
    expect(sdRecipeById(fixture.recipeId)).toBeDefined();

    const negative = fixture.negativePrompt ?? "";
    for (const term of FORBIDDEN_NEGATIVE_TERMS) {
      expect(
        mentions(negative, term),
        `${fixture.id}'s negative prompt carries "${term}", which Vesper renders as legitimate authored content`,
      ).toBe(false);
    }
  });

  it("gives every graded dimension at least one fixture that probes it", () => {
    // `scores.csv` has a column per dimension whether or not anything renders
    // it. A fixture set that stopped covering `state_obedience` would still
    // produce a full-looking grading sheet, and the empty column would read as
    // "not scored" rather than "nothing was ever rendered that could be".
    const probed = sdEvaluationFixtures.map((fixture) => fixture.notes ?? "").join("\n");
    const uncovered = sdEvaluationDimensions.filter((dimension) => !mentions(probed, dimension));
    expect(uncovered).toEqual([]);
  });

  it("never registers the same fixture id twice", () => {
    // The harness writes one image per arm per fixture id and one manifest row
    // keyed the same way, so a duplicated id silently overwrites an image and
    // leaves two rows pointing at one file.
    expect(new Set(sdEvaluationFixtures.map((fixture) => fixture.id)).size).toBe(sdEvaluationFixtures.length);
  });
});
