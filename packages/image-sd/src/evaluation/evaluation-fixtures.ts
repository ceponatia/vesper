import { z } from "zod";

/**
 * Deterministic comparison fixtures.
 *
 * **The package owns fixture DEFINITIONS; it does not own results.** A fixture
 * is the fixed half of a comparison — the same prompt, the same seed, the same
 * recipe — so that two workflow revisions differ only in the thing being tested.
 * The rendered images, the grades and the verdicts are records about Vesper's
 * models at a point in time, and they belong to Vesper and the Advanced Image
 * Lab, which already own trial storage. A package that stored its own results
 * would be a second, quieter comparison history nobody reconciles with the
 * first.
 *
 * The seed is required rather than optional, and that is the entire point of the
 * type. A comparison run without one measures the sampler's luck: two images
 * that differ because they started from different noise say nothing about
 * whether identity weight 0.65 beats 0.80, and the tuning discipline —
 * "only one variable should move at a time" — is unenforceable without it.
 */

/**
 * What a Stage 3 comparison grades.
 *
 * Split this finely because the layers being compared fail in opposite
 * directions and a single "quality" score would hide it: pushing identity
 * conditioning up improves `face` while destroying `clothing_flexibility` and
 * `pose_flexibility`, and a grader recording one number would report the
 * strongest identity setting as the winner every time. `state_obedience` is the
 * Vesper-specific one — whether the render actually produced the authored visual
 * state it was asked for, which no general image benchmark measures.
 */
export const sdEvaluationDimensions = [
  "face",
  "age",
  "hair",
  "build",
  "clothing_flexibility",
  "pose_flexibility",
  "state_obedience",
] as const;
export const sdEvaluationDimensionSchema = z.enum(sdEvaluationDimensions);
export type SdEvaluationDimension = (typeof sdEvaluationDimensions)[number];

/**
 * One fixed cell of a comparison.
 *
 * `recipeId` is a plain string rather than the recipe-id shape, because a
 * fixture legitimately outlives the recipe it names: a comparison sheet from
 * three revisions ago still has to be readable after the recipe that produced it
 * is retired. Resolution is the caller's job, and `sdRecipeById` returning
 * nothing is the honest answer.
 *
 * `notes` is what the fixture is FOR — "tests whether a full-body framing
 * survives identity conditioning" — so a later reader knows what a regression in
 * this cell means.
 */
export const sdEvaluationFixtureSchema = z.object({
  id: z.string().min(1),
  recipeId: z.string().min(1),
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  seed: z.number().int().min(0),
  notes: z.string().optional(),
});
export type SdEvaluationFixture = z.infer<typeof sdEvaluationFixtureSchema>;
