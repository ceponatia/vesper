import { z } from "zod";
import { sdModelFamilySchema } from "../recipes/sd-recipes";

/**
 * How a character LoRA is described to this package
 * (sd-rendering-package.plan.md §8, layer 2).
 *
 * **The package receives a generic image manifest; it never loads a character.**
 * That is the whole boundary in one sentence. Vesper's identity pack stays the
 * canonical visual source (§8 forbids a separate Stable Diffusion reference
 * collection), and the application is what turns a pack into the list of images
 * below. Nothing here knows what an identity pack is, who owns it, or that
 * characters exist — an `SdTrainingImage` is an id, a URI, and some optional
 * description of what the picture shows.
 *
 * The same rule decides what {@link sdTrainingResultSchema} carries. §9 keeps
 * the identity-pack-to-LoRA binding in the application database, with the pack
 * id, the `image_loras` row id, creation date and active/retired state. What the
 * binding cannot derive for itself is what the TRAINING did — which recipe at
 * which revision, against which checkpoint, at which rank, over which dataset —
 * so that provenance is what this package hands back, and nothing more.
 */

/**
 * The framings a curated training set should cover (§8).
 *
 * A closed list because it is used to answer "what is MISSING", and a free
 * string cannot answer that: `"3/4"`, `"three quarter"` and `"threequarter"`
 * would each report full coverage of a set that has one framing three times.
 */
export const sdTrainingViews = [
  "front",
  "three_quarter",
  "profile",
  "close_face",
  "upper_body",
  "full_body",
] as const;
export const sdTrainingViewSchema = z.enum(sdTrainingViews);
export type SdTrainingView = (typeof sdTrainingViews)[number];

/**
 * One image in a training set.
 *
 * `view` is optional because the application may not know a framing for every
 * image, and guessing one would corrupt the coverage report that reads it. An
 * untagged image still trains; it just does not count toward any view.
 *
 * `tags` is deliberately free-form headroom for the variety axes §8 asks a
 * curator to spread — lighting, background, clothing, expression. They are not
 * an enum because the failure they exist to prevent is a CORRELATION ("this
 * character always wears this shirt", "always appears in this room"), and the
 * axis that turns out to be correlated in a real pack is not knowable in
 * advance. When one of them earns a coverage rule of its own, it graduates into
 * a closed vocabulary like `view` did.
 */
export const sdTrainingImageSchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  view: sdTrainingViewSchema.optional(),
  caption: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type SdTrainingImage = z.infer<typeof sdTrainingImageSchema>;

/**
 * A training set.
 *
 * Ids must be unique because they are the sort key of the dataset fingerprint,
 * and a duplicate id makes that sort — and therefore the fingerprint — depend on
 * the order the application happened to assemble the list in. It is also almost
 * always the same image listed twice, which quietly doubles its weight in
 * training.
 */
export const sdTrainingDatasetSchema = z
  .object({
    images: z.array(sdTrainingImageSchema).min(1),
  })
  .superRefine((dataset, ctx) => {
    const seen = new Set<string>();
    for (const image of dataset.images) {
      if (seen.has(image.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["images"],
          message: `duplicate training image id ${image.id}`,
        });
        return;
      }
      seen.add(image.id);
    }
  });
export type SdTrainingDataset = z.infer<typeof sdTrainingDatasetSchema>;

/**
 * How a LoRA is trained — the training-side equivalent of a render recipe, and
 * versioned for the same reason: §4's "record the training recipe" is only
 * useful if the recipe named is still the recipe that ran.
 *
 * Every field below the identifying four is optional, and that is the contract:
 * an absent value means "whatever the pinned trainer does by default". The
 * seeded recipes still fill them in, because §8's comparison moves ONE variable
 * — rank — and a value the recipe leaves unnamed is a value two arms could
 * silently disagree about the day the trainer is re-pinned.
 */
export const sdTrainingRecipeSchema = z.object({
  id: z.string().min(1),
  family: sdModelFamilySchema,
  revision: z.number().int().positive(),
  /** The base weights the LoRA is trained against — and the only weights it is valid on. */
  baseCheckpoint: z.string().min(1),
  rank: z.number().int().min(1).max(128),
  /** The word the LoRA is trained to answer to, when the recipe uses one. */
  triggerToken: z.string().min(1).optional(),
  steps: z.number().int().positive().optional(),
  /**
   * The learning rate applied to the LoRA weights themselves.
   *
   * Singular because a recipe pins ONE rate. Trainers that also expose a
   * separate base-model or embedding rate keep their own defaults for those:
   * the first pass does not move them, and a field per trainer knob would turn
   * the recipe into a trainer schema — §17's rule, on the training side.
   */
  learningRate: z.number().positive().optional(),
  /**
   * The square pixel resolution training images are resized to.
   *
   * Pinned by the recipe rather than chosen by the caller because it changes
   * what the LoRA learns: a rank comparison run at two resolutions compares two
   * things at once. Multiples of 8 for the reason `SdRecipe` gives — the SDXL
   * VAE works in 8-pixel blocks.
   */
  resolution: z.number().int().positive().multipleOf(8).optional(),
  /** Images per training step, pinned for the same attributability reason as `resolution`. */
  batchSize: z.number().int().positive().optional(),
});
export type SdTrainingRecipe = z.infer<typeof sdTrainingRecipeSchema>;

/**
 * The provenance a Vesper-side identity-pack-to-LoRA binding records (§9).
 *
 * Enough to answer one question: **is this LoRA still the right one?** The
 * dataset fingerprint answers it when the identity pack changes, and the
 * recipe/revision/checkpoint triple answers it when the training configuration
 * or the base model moves underneath it.
 *
 * Timestamps, the identity pack id, the `image_loras` row id and the
 * active/retired flag are all absent on purpose — they are the application's
 * columns, on the application's row, and a package that named them would be
 * describing a database it is not allowed to know about.
 */
export const sdTrainingResultSchema = z.object({
  recipeId: z.string().min(1),
  recipeRevision: z.number().int().positive(),
  baseCheckpoint: z.string().min(1),
  rank: z.number().int().min(1).max(128),
  datasetFingerprint: z.string().min(1),
  triggerToken: z.string().min(1).optional(),
});
export type SdTrainingResult = z.infer<typeof sdTrainingResultSchema>;

/**
 * The curation window §8 asks for: "approximately 12–20 carefully selected
 * images, rather than automatically using every available image".
 *
 * **Guidance, not a schema rule, and deliberately so.** These are trial values —
 * the first LoRA comparison has not run, and nothing yet says 11 images fail or
 * 21 help. Enforcing them in {@link sdTrainingDatasetSchema} would make a
 * perfectly trainable dataset unrepresentable, and would freeze a guess as a
 * contract. {@link assessSdTrainingDataset} reports against them instead, so a
 * curator sees the advice and still decides.
 */
export const SD_TRAINING_DATASET_TARGET_MIN = 12;
export const SD_TRAINING_DATASET_TARGET_MAX = 20;
