/**
 * `@vesper/image-sd` — the Stable Diffusion implementation layer.
 *
 * Everything exported here answers a question about operating Stable Diffusion
 * well: which frozen sampler configuration a render ran under, what the
 * Vesper-owned renderer accepts as input, how a character LoRA is trained and
 * whether its dataset is still the one it was trained on, and what a comparison
 * between two workflow revisions holds fixed.
 *
 * It is **not** an alternative to `@vesper/image-core`. The core still owns
 * model capabilities, profiles, reference roles, render intent and planning,
 * prompt fitting, LoRA control contracts and failure vocabulary; this package
 * sits beside `@vesper/image-replicate` above it, and the two never import each
 * other. Nothing here knows that Vesper has characters, chats, identity packs,
 * a database, or a Next.js application — see README.md §Boundary.
 *
 * **This list is the package's entire public API, and it is deliberately
 * explicit.** Internal folder barrels may still use `export *` — they are
 * reading aids, not publication. The root may not: a wildcard here would make
 * every helper added to an internal barrel public without appearing in any
 * diff, and `pnpm lint:package-boundaries` fails the build if one appears.
 * Adding an entry below is a public-API change, and reviewers should read it as
 * one.
 */

export {
  listSdRecipes,
  sdControlNetSettingSchema,
  sdModelFamilies,
  sdModelFamilySchema,
  sdRecipeById,
  sdRecipeIdSchema,
  sdRecipeSchema,
  sdRecipes,
  sdSamplerSchema,
  sdSamplers,
  sdSchedulerSchema,
  sdSchedulers,
} from "./recipes";
export type { SdControlNetSetting, SdModelFamily, SdRecipe, SdSampler, SdScheduler } from "./recipes";
export { sdxlCharacterRenderInputSchema } from "./deployment";
export type { SdxlCharacterRenderInput } from "./deployment";
export {
  SD_TRAINING_DATASET_TARGET_MAX,
  SD_TRAINING_DATASET_TARGET_MIN,
  assessSdTrainingDataset,
  fingerprintSdTrainingDataset,
  sdTrainingDatasetSchema,
  sdTrainingImageSchema,
  sdTrainingRecipeSchema,
  sdTrainingResultSchema,
  sdTrainingViewSchema,
  sdTrainingViews,
} from "./training";
export type {
  SdTrainingDataset,
  SdTrainingDatasetAssessment,
  SdTrainingImage,
  SdTrainingRecipe,
  SdTrainingResult,
  SdTrainingView,
} from "./training";
export { sdEvaluationDimensionSchema, sdEvaluationDimensions, sdEvaluationFixtureSchema } from "./evaluation";
export type { SdEvaluationDimension, SdEvaluationFixture } from "./evaluation";
