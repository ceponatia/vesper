import { IMAGE_LORA_MAX_SCALE, IMAGE_LORA_MIN_SCALE, type ImageReferenceRole } from "@vesper/image-core";
import { z } from "zod";

/**
 * What a Stable Diffusion recipe IS (sd-rendering-package.plan.md §3).
 *
 * A recipe is **deployed configuration, frozen**: one named, versioned set of
 * fixed values that a render either ran under or did not. It is deliberately
 * NOT a tuning envelope. The plan's §7 table — "steps 30–40", "CFG roughly
 * 4–6", "PuLID identity weight: test 0.65 / 0.80 / 0.95" — describes the
 * SEARCH, and the search happens in the Image Lab against fixed fixtures. The
 * value that wins a comparison lands here as a new `revision`, and the old
 * revision stays readable so an image rendered last month can still say what
 * produced it.
 *
 * That is why every numeric field is a single number and every schema bound is
 * a rail rather than a policy. A field spelled `steps: { min, max }` would let
 * two renders of "the same recipe" differ, and Vesper's render provenance would
 * record a name that no longer identifies anything.
 *
 * Two ownership rules follow from the plan and are worth stating where the
 * types are, because both are easy to erode one field at a time:
 *
 * 1. **A recipe describes Stable Diffusion, never Vesper game state** (§3). It
 *    has no idea a character has an outfit, a location, or a mood. The
 *    application resolves visual state and hands over prompt text and
 *    references; the recipe decides only how the sampler behaves.
 * 2. **A recipe is not a ComfyUI schema** (§17). Checkpoint-specific knobs live
 *    here or in a profile's `providerOverrides`, and are promoted into
 *    `@vesper/image-core`'s normalized vocabulary only when a second model
 *    family needs the same concept or Vesper must vary it per render.
 *
 * Pure data. Nothing in this module reads a row, calls a provider, or knows
 * that Replicate exists.
 */

/**
 * The Stable Diffusion families this package plans for.
 *
 * SDXL is first because its LoRA/ControlNet/identity-adapter ecosystem is the
 * mature one (§6); SD3.5 is kept as a separate family rather than a variant
 * because the plan is explicit that the two must not be forced through
 * identical internal workflows. A recipe id carries its family as a prefix, so
 * this tuple is also the namespace of every recipe that will ever exist.
 */
export const sdModelFamilies = ["sdxl", "sd35"] as const;
export const sdModelFamilySchema = z.enum(sdModelFamilies);
export type SdModelFamily = (typeof sdModelFamilies)[number];

/**
 * The samplers a recipe may name — the DPM++ family the plan calls for (§7),
 * plus the two euler variants that serve as the honest baseline in a sampler
 * comparison.
 *
 * A bounded list rather than a free string. Stable Diffusion front-ends accept
 * dozens of sampler names in several spellings, and a typo'd one does not fail
 * loudly: the renderer falls back to its own default and produces a perfectly
 * plausible image under settings nobody chose, recorded as if the recipe had
 * been honoured. Widening this list is a deliberate edit, made once the
 * deployed workflow actually implements the new sampler.
 */
export const sdSamplers = ["dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "euler", "euler_ancestral"] as const;
export const sdSamplerSchema = z.enum(sdSamplers);
export type SdSampler = (typeof sdSamplers)[number];

/** The noise schedules pairable with those samplers. Karras is the plan's §7 default where supported. */
export const sdSchedulers = ["karras", "normal", "simple", "exponential"] as const;
export const sdSchedulerSchema = z.enum(sdSchedulers);
export type SdScheduler = (typeof sdSchedulers)[number];

/**
 * The ControlNet keys a recipe may configure, tied to the reference-role
 * vocabulary `@vesper/image-core` already publishes (§11: "use those roles
 * rather than creating Stable Diffusion-specific reference types").
 *
 * `Extract` rather than a fresh union so the tie is checked by the compiler: if
 * image-core ever renames or drops one of these roles, the `satisfies` below
 * stops compiling instead of leaving this package quietly describing a control
 * image the render path can no longer produce.
 */
type SdControlNetRole = Extract<ImageReferenceRole, "depth" | "pose" | "edge">;

/**
 * How hard one ControlNet pushes, and over which slice of the sampling run.
 *
 * `start`/`end` are fractions of the schedule, not step counts, so a recipe
 * keeps meaning the same thing when its `steps` change — the plan tunes steps
 * and control strength independently (§7), and a control expressed in absolute
 * steps would silently move when only steps were meant to move.
 *
 * `strength` allows up to 2 because SDXL ControlNet implementations accept
 * over-strength values; that is a rail, not an endorsement. The plan's starting
 * bands are much narrower (depth roughly 0.45–0.70, pose roughly 0.65–0.85).
 */
export const sdControlNetSettingSchema = z
  .object({
    strength: z.number().min(0).max(2),
    /** Fraction of the sampling schedule where this control switches on. */
    start: z.number().min(0).max(1),
    /** Fraction of the sampling schedule where it switches off. */
    end: z.number().min(0).max(1),
  })
  .refine((setting) => setting.start <= setting.end, {
    // An inverted window is not a weak control, it is NO control: the renderer
    // applies it over an empty slice and produces an image that looks like the
    // uncontrolled one while the provenance claims a ControlNet ran.
    path: ["end"],
    message: "a ControlNet window must start at or before it ends",
  });
export type SdControlNetSetting = z.infer<typeof sdControlNetSettingSchema>;

/**
 * `<family>/<slug>` — the stable name a render's provenance records, and the
 * only thing the deployed renderer receives to select a recipe by.
 *
 * Family-prefixed because §6 keeps `sdxl/*` and `sd35/*` as separate recipe
 * namespaces; lowercase and hyphenated because the id travels through provider
 * inputs, URLs and log lines, where case folding is somebody else's decision.
 */
export const sdRecipeIdSchema = z.string().regex(/^(sdxl|sd35)\/[a-z0-9-]+$/);

/**
 * The fields, spelled once and separately from the cross-field rule below, so
 * the refinement stays legible instead of trailing eighty lines of schema.
 */
const sdRecipeShape = {
  id: sdRecipeIdSchema,
  family: sdModelFamilySchema,
  /**
   * Bumped every time any value below changes. A recipe id plus a revision is
   * the whole answer to "what produced this image", so a revision is never
   * reused and a value never changes in place.
   */
  revision: z.number().int().positive(),
  /** What this recipe is for, in a sentence an operator reads in the lab. */
  description: z.string().min(1),
  /** The base weights, as the deployed workflow names them. */
  checkpoint: z.string().min(1),
  sampler: sdSamplerSchema,
  scheduler: sdSchedulerSchema,
  steps: z.number().int().min(1).max(150),
  cfg: z.number().min(0).max(30),
  /** Native render size. Multiples of 8 because the SDXL VAE works in 8-pixel blocks. */
  width: z.number().int().positive().multipleOf(8),
  height: z.number().int().positive().multipleOf(8),
  /**
   * Strength of the runtime identity adapter — PuLID initially (§8, layer 3).
   *
   * Absent means the recipe runs no identity conditioning at all, which is a
   * different render from one conditioned at zero: the plan's Stage 3 matrix
   * compares "base SDXL", "PuLID only", "LoRA only" and "LoRA + PuLID", and
   * those four cells have to be distinguishable in the recipe that produced
   * them.
   */
  identityWeight: z.number().min(0).max(1).optional(),
  /**
   * Strength of the single character LoRA (§10 keeps Vesper's one-LoRA-per-render
   * limitation for the first slice).
   *
   * Bounded by `@vesper/image-core`'s curated LoRA scale band rather than a
   * number spelled again here — the library row, the provider binding and this
   * recipe must agree on what an out-of-range scale is, and a second spelling
   * of "0 to 4" is how they stop agreeing.
   */
  loraScale: z.number().min(IMAGE_LORA_MIN_SCALE).max(IMAGE_LORA_MAX_SCALE).optional(),
  /**
   * Structural conditioning, keyed by image-core reference role. Absent means
   * the recipe uses none — §11's initial priority is depth first, pose second,
   * edge only if trials prove it useful.
   */
  controlNets: z
    .object({
      depth: sdControlNetSettingSchema.optional(),
      pose: sdControlNetSettingSchema.optional(),
      edge: sdControlNetSettingSchema.optional(),
    } satisfies Record<SdControlNetRole, unknown>)
    .optional(),
  /**
   * Denoise strengths for the two inpainting jobs §12 distinguishes: repairing
   * a localized failure (a malformed hand, a face artifact) versus replacing
   * something outright. Repair runs lower — the point is to keep the
   * surrounding lighting and composition intact.
   */
  inpaint: z
    .object({
      repairDenoise: z.number().min(0).max(1).optional(),
      replaceDenoise: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** The low-denoise finishing/upscale pass (§7, Stage 7). Absent means no finishing pass runs. */
  finishing: z
    .object({
      denoise: z.number().min(0).max(1),
      upscale: z.number().min(1).max(4),
    })
    .optional(),
};

/**
 * One deployed Stable Diffusion configuration.
 *
 * The cross-field rule is the id/family agreement. It exists because the id is
 * what travels — into the renderer's `recipe` input, into render provenance,
 * into a comparison sheet — while `family` is what decides which workflow the
 * values are even meaningful for. A row reading `sd35/identity-portrait` with
 * `family: "sdxl"` would resolve, render, and be filed under the wrong family
 * forever.
 */
export const sdRecipeSchema = z.object(sdRecipeShape).superRefine((recipe, ctx) => {
  if (!recipe.id.startsWith(`${recipe.family}/`)) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: `recipe id ${recipe.id} does not start with its family prefix ${recipe.family}/`,
    });
  }
});
export type SdRecipe = z.infer<typeof sdRecipeSchema>;
