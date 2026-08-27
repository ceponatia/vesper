import { IMAGE_LORA_MAX_SCALE, IMAGE_LORA_MIN_SCALE } from "@vesper/image-core";
import { z } from "zod";
import { sdRecipeIdSchema } from "../recipes/sd-recipes";

/**
 * The public input contract of the Vesper-owned Stable Diffusion renderer —
 * conceptually `vesper/sdxl-character-render`.
 *
 * **Complexity belongs inside the renderer.** One prediction may internally run
 * identity conditioning, a ControlNet, SDXL sampling, targeted inpainting and a
 * low-denoise finishing pass; from Vesper's side it was one image render, with
 * one cost line, one provenance record and one retry. Every field below is
 * therefore something the application genuinely has to decide — the prompt, the
 * references it resolved, the seed, the size, and the recipe name. Everything
 * the recipe already fixes (sampler, scheduler, steps, CFG, control strengths,
 * denoise values) is absent by design, because a caller that could override
 * them per render would make the recorded recipe name stop identifying anything.
 *
 * **The field names are snake_case on purpose.** They are the vocabulary
 * Vesper's existing Replicate capability probe already reads, so the deployment
 * registers as an ordinary `image_models` row and its inputs bind to image-core
 * controls with no Stable Diffusion special case anywhere in the render path.
 * This is the one place in the package where an external naming convention wins
 * over the repository's.
 *
 * **This schema is a seam, not a transport.** It says what the model accepts;
 * it does not build a request, upload a file, or call anything. Transport stays
 * in the application and `@vesper/image-replicate`, which this package may not
 * import — the two are peers, and the application is where they meet.
 *
 * It is written down here, before the model exists, so Stage 2 has a target to
 * build against rather than a shape discovered by reading a deployed schema.
 */

/** An image the renderer fetches: a URI string, never bytes. Byte handling is transport's job. */
const referenceImage = z.string().min(1);

export const sdxlCharacterRenderInputSchema = z.object({
  prompt: z.string().min(1),
  /**
   * Authored by Vesper, never assembled here. A legitimate render can
   * contain unusual anatomy, prosthetics, text, logos, blur, non-human features
   * or an authored wardrobe state, so a package-side generic negative string
   * would contradict canonical visual state it cannot see.
   */
  negative_prompt: z.string().optional(),
  /** The identity anchor for PuLID-style conditioning (layer 3). */
  reference_image: referenceImage.optional(),
  /** Structural control maps, in image-core's `pose`/`depth` reference roles. */
  pose_image: referenceImage.optional(),
  depth_image: referenceImage.optional(),
  /** Inpainting inputs: repair, not the normal route for changing authored state. */
  mask_image: referenceImage.optional(),
  source_image: referenceImage.optional(),
  /**
   * One LoRA, matching Vesper's existing single-selection limit. The slot
   * is the character identity LoRA; multi-LoRA stacking is explicitly deferred
   * until identity rendering works and a style LoRA proves worth the extra slot.
   */
  lora_weights: z.string().optional(),
  lora_scale: z.number().min(IMAGE_LORA_MIN_SCALE).max(IMAGE_LORA_MAX_SCALE).optional(),
  /** Absent means the renderer picks one; a comparison run always sends it. */
  seed: z.number().int().min(0).optional(),
  width: z.number().int().positive().multipleOf(8),
  height: z.number().int().positive().multipleOf(8),
  /**
   * Which frozen recipe to run, by id. Validated against the same shape the
   * recipe contract itself uses, so a name that could never resolve is refused
   * before a prediction is paid for rather than falling back to a renderer
   * default nobody chose.
   *
   * **Defaulted, because the one surface offered this model cannot name a
   * recipe.** Stage 2 gives the renderer to the Advanced Image Lab alone, and a
   * lab run sends none: lab recipes carry empty `providerOverrides`, and a
   * controlled run refuses a raw provider bag. The deployed Cog schema declares
   * the same default and this line mirrors it — the two drifting apart is what
   * writing the contract down here is meant to prevent. `sdxl/identity-portrait`
   * rather than the control arm because it degrades exactly to
   * `sdxl/base-portrait` when no identity or LoRA input is sent, so it is the
   * right choice on both kinds of render.
   *
   * The default id must always resolve in the recipe registry. The schema is a
   * regex, so a rename that orphans this id stays well-formed and sends every
   * defaulted render to a recipe nothing registers — `render-input.test.ts`
   * holds that tie.
   */
  recipe: sdRecipeIdSchema.default("sdxl/identity-portrait"),
});
export type SdxlCharacterRenderInput = z.infer<typeof sdxlCharacterRenderInputSchema>;
