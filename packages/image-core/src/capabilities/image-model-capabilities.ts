import { z } from "zod";

/**
 * Reviewed and probed capabilities of a registered image model
 * (image-model-capabilities.spec.md §"Extensions to `image_models`" and
 * §"Advanced capability contract").
 *
 * `image-models.ts` already carries the MECHANICS of calling a model: field
 * names, arity, transport, offered shapes. Those are all derivable from a
 * Replicate schema. This module adds the two kinds of fact that are not:
 *
 * 1. REVIEWED judgments. `canEdit` is true for every model with an image input,
 *    which lumps `qwen/qwen-image-edit-2511` (follows an edit instruction and
 *    keeps the face) in with `stability-ai/stable-diffusion-3.5-large` (strength
 *    repainting that can replace the person the render was preserving).
 *    `editKind` and `identityPreservation` are the human ratings that keep those
 *    apart, and a re-probe must never overwrite them — a schema cannot tell you
 *    whether a face survived.
 * 2. PROBED extras. `advancedCapabilities` records the optional input bindings
 *    (seed, guidance, steps, LoRA, thinking mode …) exactly as ONE version
 *    declared them, so the control mapper can send a normalized control only
 *    when the active version really exposes a field for it, and never has to
 *    guess a field name at render time.
 *
 * Nothing here imports `./image-models`: that module imports THIS one for the
 * reviewed enums, so a back-import would be a circular dependency — a
 * `pnpm lint:cycles` (madge) failure, not just a style problem.
 */

/**
 * What "editing" actually means on a model whose `canEdit` is true.
 *
 * - `none` — has no usable image input; an edit profile on it is invalid.
 * - `instruction_edit` — takes an instruction and the source image and changes
 *   what it was told to change (`qwen/qwen-image-edit-2511`).
 * - `multi_reference_compose` — composes a new image out of several supplied
 *   references (Seedream, Wan 2.7).
 * - `img2img` — strength-based repainting (`qwen/qwen-image-2512` with its
 *   optional `image` + `strength`, Stable Diffusion 3.5 Large). A deliberate
 *   remix tool: the subject is an input to the noise, not something preserved.
 * - `unknown` — nobody has reviewed this row yet.
 *
 * `unknown` is the column default and is deliberately PERMISSIVE: an
 * operator-added experimental row keeps working exactly as it does today rather
 * than being locked out of its own profiles by a rating nobody has written.
 * Only `none` and `img2img` actually gate anything (see `profileEligibility`).
 */
export const imageEditKinds = ["none", "instruction_edit", "multi_reference_compose", "img2img", "unknown"] as const;
export const imageEditKindSchema = z.enum(imageEditKinds);
export type ImageEditKind = (typeof imageEditKinds)[number];

/**
 * How well the model holds a person's identity across a render — the reviewed
 * fact that decides whether it may serve variant, scene, and chat-look work.
 *
 * `strong` is a model observed to carry a face through a full scene change
 * (`bytedance/seedream-5-lite`, `docs/developer-notes/images/seedream-5-lite.trial.md`);
 * `weak` is a model that produces a plausible stranger. Like `editKind`, this is
 * a judgment from looking at output, never a schema read, and `unknown` is
 * permissive so an unreviewed row is not silently demoted.
 */
export const imageIdentityPreservationRatings = ["strong", "moderate", "weak", "unknown"] as const;
export const imageIdentityPreservationSchema = z.enum(imageIdentityPreservationRatings);
export type ImageIdentityPreservation = (typeof imageIdentityPreservationRatings)[number];

/**
 * What one supplied reference image is FOR. The render path needs this because
 * reference slots are scarce: a three-reference model handed identity, location,
 * style and object must know which one to drop, and a multi-reference prompt has
 * to name each image's purpose in order.
 *
 * `identity` through `after_example` are roles Vesper's lanes produce or will
 * produce shortly. `mask` through `control` are the STRUCTURAL roles — an image
 * the model is asked to OBEY rather than to draw from
 * ({@link imageControlReferenceRoles}).
 *
 * `edge` was added with the control-role slice. Before it, an edge map was fed
 * under the generic `control` role because this list reserved `pose` and `depth`
 * but nothing edge-shaped, which made the lab's fixture vocabulary and this one
 * disagree about a kind they both name. `control` stays as the genuine catch-all
 * for a structural map that is none of the three — a segmentation mask, a normal
 * map — rather than as `edge`'s alias.
 *
 * `outfit` joined with the lab's controlled recipes, because wardrobe had no
 * honest role: a `style` reference promises to contribute "no subject or
 * object", an `object` reference is an item that appears IN the scene beside
 * the subject, while a wardrobe reference is clothing the subject WEARS. A
 * CONTENT role, not a structural one — the model draws the garment from it
 * rather than obeying it as layout.
 */
export const imageReferenceRoles = [
  "identity",
  "location",
  "style",
  "object",
  "outfit",
  "product",
  "before",
  "after_example",
  "mask",
  "pose",
  "depth",
  "edge",
  "control",
] as const;
export const imageReferenceRoleSchema = z.enum(imageReferenceRoles);
export type ImageReferenceRole = (typeof imageReferenceRoles)[number];

/**
 * The roles that carry STRUCTURE the model must obey, as against content it
 * draws from.
 *
 * The distinction is the whole point of the control-role slice, and it is a
 * transport fact rather than a semantic nicety: a structural image may have its
 * own provider input (`additionalImageInputs`), in which case it does not
 * compete for the primary reference field's scarce slots, and it must be named
 * in the prompt as something to FOLLOW rather than something to depict. A depth
 * map ordered as ordinary content produces a render of a grey gradient.
 *
 * Derived nowhere else: `imageLabControlRoles` in `./image-lab.ts` is the lab
 * fixture vocabulary's image over its three kinds, which is a subset of this and
 * must stay a subset — a test asserts it.
 */
export const imageControlReferenceRoles = ["mask", "pose", "depth", "edge", "control"] as const satisfies
  readonly ImageReferenceRole[];
export type ImageControlReferenceRole = (typeof imageControlReferenceRoles)[number];

/** Whether this role carries structure to obey rather than content to draw from. */
export function isImageControlReferenceRole(role: ImageReferenceRole): role is ImageControlReferenceRole {
  return imageControlReferenceRoles.some((controlRole) => controlRole === role);
}

/**
 * The primitive type of one optional input, as its OpenAPI schema declares it.
 * Kept because `integer` and `number` are not interchangeable at the provider:
 * sending `28.0` where a model declared `num_inference_steps` as an integer is a
 * validation failure, not a rounding.
 */
export const imageInputBindingTypes = ["string", "integer", "number", "boolean", "enum"] as const;
export const imageInputBindingTypeSchema = z.enum(imageInputBindingTypes);
export type ImageInputBindingType = (typeof imageInputBindingTypes)[number];

/**
 * Whether a binding carries one value or a list — used for extra image inputs
 * and for model output.
 *
 * This mirrors `imageReferenceArities` in `./image-models.ts` rather than
 * importing it, because that module imports the reviewed enums from this one and
 * the back-import would be a cycle. The values are identical on purpose: an
 * `additionalImageInputs` entry and the primary reference column describe the
 * same provider fact about a different field.
 */
export const imageBindingArities = ["single", "array"] as const;
export const imageBindingAritySchema = z.enum(imageBindingArities);
export type ImageBindingArity = (typeof imageBindingArities)[number];

/**
 * One optional non-image input, recorded verbatim from the version that declared
 * it. `field` is the provider's own key — `cfg` on one model and `guidance` on
 * another — which is exactly why the normalized control names live apart from
 * it: the probe resolves the alias once, and the render path never pattern-matches
 * a field name.
 *
 * `minimum`/`maximum`/`enumValues` are optional because plenty of Replicate
 * schemas state their range only in prose. Absent means "the provider did not
 * declare one", never "unbounded" — an out-of-range profile value is rejected at
 * save time rather than clamped into something the operator did not ask for.
 */
export const imageInputBindingSchema = z.object({
  field: z.string().min(1),
  type: imageInputBindingTypeSchema,
  required: z.boolean().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  enumValues: z.array(z.string()).optional(),
});
export type ImageInputBinding = z.infer<typeof imageInputBindingSchema>;

/**
 * One image-like input beyond the primary reference field. `required` is NOT
 * optional here: whether the model refuses to run without this image is the
 * single fact that decides if a profile using it can exist at all, so a probe
 * that cannot determine it must say so explicitly rather than defaulting.
 */
export const imageUriBindingSchema = z.object({
  field: z.string().min(1),
  arity: imageBindingAritySchema,
  required: z.boolean(),
  maxItems: z.number().int().positive().optional(),
  /** Extensions/media types the binding accepts, when declared. Masks and control
   * images are not necessarily WebP like Vesper's stored assets. */
  acceptedFormats: z.array(z.string()).optional(),
});
export type ImageUriBinding = z.infer<typeof imageUriBindingSchema>;

/**
 * Where the prompt goes and how long it may be. Optional as a whole because a
 * model that declares no prompt field at all is conceivable (a pure upscaler),
 * and because the limits are frequently unparseable prose — `fitPromptToModel`
 * needs to know the difference between "no limit was declared" and "the limit is
 * huge", and only an absent value says the first.
 */
export const imagePromptBindingSchema = z.object({
  field: z.string().min(1),
  /** Hard provider ceiling. Exceeding it is a provider error, so mandatory prompt
   * segments failing to fit is `image_model.prompt_too_long_required`. */
  maxChars: z.number().int().positive().optional(),
  /** Where quality starts degrading, per model documentation. Advisory only. */
  recommendedChars: z.number().int().positive().optional(),
});
export type ImagePromptBinding = z.infer<typeof imagePromptBindingSchema>;

/**
 * The fourteen normalized control slots, each either absent (this version does
 * not expose the control) or bound to a concrete provider field.
 *
 * Named slots rather than a free `Record<string, ImageInputBinding>` because the
 * point of the layer is that alias discovery happens ONCE, in the probe: a
 * render-time mapper that searched a bag for something guidance-shaped would
 * reintroduce exactly the guessing this contract removes. Adding a fifteenth
 * control is a deliberate edit here plus a probe rule, which is the intended cost.
 */
export const imageModelControlBindingsSchema = z.object({
  seed: imageInputBindingSchema.optional(),
  negativePrompt: imageInputBindingSchema.optional(),
  guidance: imageInputBindingSchema.optional(),
  steps: imageInputBindingSchema.optional(),
  editStrength: imageInputBindingSchema.optional(),
  outputCount: imageInputBindingSchema.optional(),
  coherentSet: imageInputBindingSchema.optional(),
  sequentialMode: imageInputBindingSchema.optional(),
  thinkingMode: imageInputBindingSchema.optional(),
  customWidth: imageInputBindingSchema.optional(),
  customHeight: imageInputBindingSchema.optional(),
  resolutionTier: imageInputBindingSchema.optional(),
  loraWeights: imageInputBindingSchema.optional(),
  loraScale: imageInputBindingSchema.optional(),
});
export type ImageModelControlBindings = z.infer<typeof imageModelControlBindingsSchema>;

/** An extra image input plus what Vesper should feed it. */
export const imageAdditionalImageInputSchema = z.object({
  roleHint: imageReferenceRoleSchema,
  binding: imageUriBindingSchema,
});
export type ImageAdditionalImageInput = z.infer<typeof imageAdditionalImageInputSchema>;

/**
 * What comes back. `supportsMultiple` is separate from `arity` because several
 * models return a one-element array and only produce more when an output-count
 * or image-set control is set — the single-image wrapper has to know that
 * asking for one is possible, not just that the response is a list.
 */
export const imageModelOutputCapabilitySchema = z.object({
  arity: imageBindingAritySchema,
  supportsMultiple: z.boolean(),
});
export type ImageModelOutputCapability = z.infer<typeof imageModelOutputCapabilitySchema>;

/**
 * Version-specific provider data for one model row, replaced atomically when the
 * active version changes.
 *
 * EVERY branch is optional or defaulted so that `{}` — what the migration writes
 * on all six seeded rows, and what a row created before the column existed reads
 * back as — parses to a valid, inert value. That inertness is the slice-1
 * contract: the probe does not derive control aliases until slice 4/5, so an
 * empty capability set must mean "no optional control is sent", which is exactly
 * what every lane does today.
 *
 * Each default is a THUNK. Zod 4's `.default()` hands back the value it was given
 * without re-parsing or cloning it, so a literal `[]` here would be the same array
 * instance on every parsed row and a probe pushing one field name onto
 * `knownInputFields` would rewrite all six models' allowlists at once.
 */
export const imageModelAdvancedCapabilitiesSchema = z.object({
  prompt: imagePromptBindingSchema.optional(),
  controls: imageModelControlBindingsSchema.default((): ImageModelControlBindings => ({})),
  /**
   * A control role's OWN provider input, where a version declares one. Read at
   * render time by `controlReferenceTransport`: an entry here routes that role
   * off the primary reference array and onto its own field. Empty on every model
   * Vesper runs today, so every control currently rides the numbered references
   * — which is how Qwen Image Edit 2511 takes a pose or depth map.
   */
  additionalImageInputs: z.array(imageAdditionalImageInputSchema).default((): ImageAdditionalImageInput[] => []),
  /**
   * Assumed single until a probe says otherwise: every current lane consumes one
   * image, so defaulting to `array` would advertise a set path that no seeded row
   * has been verified to support.
   */
  output: imageModelOutputCapabilitySchema.default(
    (): ImageModelOutputCapability => ({ arity: "single", supportsMultiple: false }),
  ),
  /**
   * Every input key the active version declares — the allowlist a profile's
   * `providerOverrides` is validated against. Empty means the probe has recorded
   * nothing, so override validation must fail CLOSED (reject every key) rather
   * than read emptiness as permission. Slice 1 rejects nothing in practice: all
   * seeded profiles carry `providerOverrides = {}`.
   */
  knownInputFields: z.array(z.string()).default((): string[] => []),
});
export type ImageModelAdvancedCapabilities = z.infer<typeof imageModelAdvancedCapabilitiesSchema>;

/**
 * The inert capability set: no prompt binding, no controls, no extra images, one
 * output, nothing known — identical to what the schema builds from `{}`.
 *
 * A function, not a shared constant, for the reason given above: it is the row
 * default on `imageModelSchema.advancedCapabilities`, and zod hands a default
 * straight through, so every row must get its own copy.
 */
export function emptyImageModelAdvancedCapabilities(): ImageModelAdvancedCapabilities {
  return {
    controls: {},
    additionalImageInputs: [],
    output: { arity: "single", supportsMultiple: false },
    knownInputFields: [],
  };
}
