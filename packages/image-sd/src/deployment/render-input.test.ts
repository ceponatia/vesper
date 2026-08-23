import { describe, expect, it } from "vitest";
import { sdRecipeById } from "../recipes/sd-recipe-registry";
import { sdxlCharacterRenderInputSchema } from "./render-input";

/**
 * **The defaulted recipe id must resolve, and only an absent recipe may reach
 * the default.**
 *
 * `recipe` carries a default because the Advanced Image Lab — the only surface
 * offered this renderer in Stage 2 — cannot name a recipe. That makes the
 * default the id most renders actually run under, while `sdRecipeIdSchema` is
 * only a regex: any well-formed `sdxl/…` string satisfies it. So the two bad
 * implementations this kills are both silent.
 *
 * 1. Renaming or dropping `sdxl/identity-portrait` in the registry. Nothing else
 *    catches it — `sd-recipe-registry.test.ts` derives its cases from the
 *    registry, so it keeps passing while every defaulted render points at a
 *    recipe that no longer exists.
 * 2. Loosening the field to `.catch()` (or a bare string) to be tolerant of the
 *    lab. That swallows a typo'd id instead of refusing it, and the render costs
 *    a prediction, runs under settings nobody chose, and records the name as if
 *    it had been honoured.
 */

/** The smallest accepted render: no recipe, so the default is what applies. */
const minimalInput = { prompt: "a portrait", width: 832, height: 1216 };

describe("sdxl character render input", () => {
  it("defaults recipe to an id the registry still resolves", () => {
    const parsed = sdxlCharacterRenderInputSchema.parse(minimalInput);
    expect(parsed.recipe).toBe("sdxl/identity-portrait");
    expect(sdRecipeById(parsed.recipe)?.id).toBe(parsed.recipe);
  });

  it("refuses a recipe it was actually given instead of substituting the default", () => {
    const result = sdxlCharacterRenderInputSchema.safeParse({ ...minimalInput, recipe: "sdxl_identity_portrait" });
    expect(result.success).toBe(false);
  });
});
