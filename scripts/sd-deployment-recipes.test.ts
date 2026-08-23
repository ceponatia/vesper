import { readFileSync } from "node:fs";
import { sdRecipes } from "@vesper/image-sd";
import { describe, expect, it } from "vitest";
import { SD_DEPLOYMENT_RECIPES_COMMAND, SD_DEPLOYMENT_RECIPES_PATH } from "./generate-sd-deployment-recipes";

/**
 * Tripwire: the deployment's `recipes.json` still matches the recipe registry.
 *
 * `packages/image-sd/deployment/` is a Cog/ComfyUI image with no TypeScript in
 * it, and its predictor resolves the `recipe` input it is handed to a sampler,
 * a scheduler, a step count, a CFG and control strengths. Those numbers are
 * defined once, in `sd-recipe-registry.ts`, and generated across the language
 * boundary by `scripts/generate-sd-deployment-recipes.ts`.
 *
 * Nothing else notices when the copy goes stale. Typecheck does not read JSON,
 * the package boundary checker does not either, and the deployed renderer would
 * keep producing perfectly plausible images under the previous revision's
 * settings while every render's provenance recorded the NEW revision id — which
 * is exactly the failure the recipe contract exists to prevent.
 *
 * The defect this kills: adding revision 2 of a recipe (or editing a value in
 * the registry) and shipping without re-running the generator.
 */

describe("the SD deployment's recipe copy", () => {
  it("matches the @vesper/image-sd registry", () => {
    const generated: unknown = JSON.parse(readFileSync(SD_DEPLOYMENT_RECIPES_PATH, "utf8"));
    expect(generated, `recipes.json is stale — regenerate it with: ${SD_DEPLOYMENT_RECIPES_COMMAND}`).toEqual(
      sdRecipes,
    );
  });
});
