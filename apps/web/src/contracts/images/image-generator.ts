import { z } from "zod";
import {
  imageControlReferenceRoles,
  imageReferenceRoleSchema,
  imageRenderControlsSchema,
  type ImageRenderControls,
} from "@vesper/image-core";

/**
 * PURE. The Image Generator's run contracts
 * (image-lab-general-model-trials.spec.md §"Generator run contracts").
 *
 * The Generator is the raw prompt/model bench: one run is one immutable paid
 * attempt against one registered model, with the admin's whole prompt and every
 * selected input written down. These shapes are shared by the schema column
 * enums, the routes, the runner, and the client — which is why they live in
 * contracts rather than beside the server modules that consume them.
 *
 * Deliberately NOT imported from any Image Lab contract: the Generator is a
 * separate surface with its own record and failure vocabulary, and sharing the
 * Lab's would couple two benches the spec keeps apart.
 */

export const imageGeneratorRunStatuses = ["pending", "running", "succeeded", "failed"] as const;
export const imageGeneratorRunStatusSchema = z.enum(imageGeneratorRunStatuses);
export type ImageGeneratorRunStatus = (typeof imageGeneratorRunStatuses)[number];

/** Conservative app cap on explicit primary references; the UI states it. */
export const IMAGE_GENERATOR_MAX_PRIMARY = 6;
export const IMAGE_GENERATOR_PROMPT_MAX = 10_000;
/** Advanced provider values are an escape hatch, not a payload builder. */
export const IMAGE_GENERATOR_MAX_PROVIDER_INPUTS = 32;

/**
 * A recorded purpose is any member of the package's own reference-role
 * vocabulary. Accepting the whole vocabulary keeps provenance honest — the
 * contract records what the admin said, and routing never reads it.
 */
export const imageGeneratorPurposeSchema = imageReferenceRoleSchema;

/** The structural roles a dedicated input may occupy — the package's own tuple. */
export const imageGeneratorDedicatedRoleSchema = z.enum(imageControlReferenceRoles);
export type ImageGeneratorDedicatedRole = (typeof imageControlReferenceRoles)[number];

/**
 * One explicit primary reference. `purpose` is recorded provenance/UI metadata
 * ONLY — every primary reference enters the render planner under the neutral
 * `reference` role in caller order, and nothing routes on the purpose. A purpose
 * that changed routing would let two identical requests send different payloads.
 */
export const imageGeneratorPrimaryInputSchema = z.object({
  imageId: z.string().min(1),
  purpose: imageGeneratorPurposeSchema.optional(),
});
export type ImageGeneratorPrimaryInput = z.infer<typeof imageGeneratorPrimaryInputSchema>;

/**
 * One dedicated structural input. Unlike a purpose, the role here IS routing:
 * the runner refuses the run unless the model's probed capabilities bind this
 * role to a dedicated provider field — an explicitly dedicated selection never
 * falls back to the numbered reference array.
 */
export const imageGeneratorDedicatedInputSchema = z.object({
  role: imageGeneratorDedicatedRoleSchema,
  imageId: z.string().min(1),
});
export type ImageGeneratorDedicatedInput = z.infer<typeof imageGeneratorDedicatedInputSchema>;

export const imageGeneratorRunInputsSchema = z.object({
  primary: z
    .array(imageGeneratorPrimaryInputSchema)
    .max(IMAGE_GENERATOR_MAX_PRIMARY)
    .default((): ImageGeneratorPrimaryInput[] => []),
  dedicated: z
    .array(imageGeneratorDedicatedInputSchema)
    .max(8)
    .default((): ImageGeneratorDedicatedInput[] => []),
});
export type ImageGeneratorRunInputs = z.infer<typeof imageGeneratorRunInputsSchema>;

export function emptyImageGeneratorRunInputs(): ImageGeneratorRunInputs {
  return { primary: [], dedicated: [] };
}

/** The normalized per-run control overlay — the package's own schema, verbatim. */
export const imageGeneratorControlsSchema: z.ZodType<ImageRenderControls> = imageRenderControlsSchema;

export function emptyImageGeneratorControls(): ImageRenderControls {
  return {};
}

export const imageGeneratorProviderInputValueSchema = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
]);
export type ImageGeneratorProviderInputValue = z.infer<typeof imageGeneratorProviderInputValueSchema>;

export const imageGeneratorProviderInputsSchema = z.record(
  z.string().min(1),
  imageGeneratorProviderInputValueSchema,
);
export type ImageGeneratorProviderInputs = z.infer<typeof imageGeneratorProviderInputsSchema>;

export function emptyImageGeneratorProviderInputs(): ImageGeneratorProviderInputs {
  return {};
}

/**
 * The create-run request.
 *
 * Create-time rules enforce only client-bug CONTRADICTIONS: at most one
 * dedicated input per role (two pose maps in one dedicated slot is a request no
 * UI produces), and the provider-input bag capped at
 * {@link IMAGE_GENERATOR_MAX_PROVIDER_INPUTS} keys. Runtime facts — model
 * existence, the version pin, capability bindings, capacity, readable inputs —
 * are deliberately RUNNER checks, so a failed attempt lands on the run row
 * where the admin can read why, instead of vanishing as a 400.
 */
export const imageGeneratorCreateRunRequestSchema = z.object({
  modelId: z.string().min(1),
  prompt: z.string().trim().min(1).max(IMAGE_GENERATOR_PROMPT_MAX),
  inputs: imageGeneratorRunInputsSchema.optional(),
  controls: imageGeneratorControlsSchema.optional(),
  providerInputs: imageGeneratorProviderInputsSchema
    .refine((record) => Object.keys(record).length <= IMAGE_GENERATOR_MAX_PROVIDER_INPUTS, {
      message: `providerInputs is capped at ${String(IMAGE_GENERATOR_MAX_PROVIDER_INPUTS)} keys`,
    })
    .optional(),
  /** Duplicate/variant lineage — the settled run this one was prefilled from. */
  sourceRunId: z.string().min(1).optional(),
}).superRefine((request, ctx) => {
  const roles = (request.inputs?.dedicated ?? []).map((input) => input.role);
  if (new Set(roles).size !== roles.length) {
    ctx.addIssue({
      code: "custom",
      path: ["inputs", "dedicated"],
      message: "a run sends at most one dedicated input per role",
    });
  }
});
export type ImageGeneratorCreateRunRequest = z.infer<typeof imageGeneratorCreateRunRequestSchema>;

/**
 * The Generator's own failure vocabulary, mirroring the Lab's pattern. The
 * stored `failure_code` column stays PLAIN TEXT because it carries two
 * vocabularies: these codes (dotted through
 * {@link imageGeneratorDiagnosticCode}) plus verbatim shared-layer codes
 * (`image_profile.*`, `image_lora.*`) when the planner or LoRA layer owns the
 * refusal — freezing that union into a column enum would make a shared-layer
 * code a migration.
 */
export const imageGeneratorFailureCodes = [
  /** The stored slug no longer resolves in the registry. */
  "model_missing",
  /** No exact provider version resolvable before spend. */
  "version_unpinned",
  /** Prompt-only on a model that cannot generate; references on one that cannot edit. */
  "operation_unsupported",
  /** A selected image id is unreadable or its bytes are gone. */
  "input_missing",
  /** Explicit primary references exceed model/app capacity. */
  "capacity_exceeded",
  /** A structural role with no active dedicated capability binding. */
  "dedicated_input_unbound",
  /** An explicitly selected normalized control cannot be represented. */
  "control_refused",
  /** An unknown/reserved/invalid advanced provider value. */
  "provider_input_rejected",
  /** Provider execution failed. */
  "render_failed",
  /** The provider succeeded; local persistence did not. */
  "output_store_failed",
] as const;
export type ImageGeneratorFailureCode = (typeof imageGeneratorFailureCodes)[number];

export function imageGeneratorDiagnosticCode(code: ImageGeneratorFailureCode): string {
  return `image_generator.${code}`;
}

/**
 * One run as the routes report it. Forgiving on the client-facing read-back:
 * a jsonb bag that no longer parses costs the field its content with a caught
 * default, never the row — a history list must survive one malformed record.
 * Everything an unsettled run has not learned is nullable.
 */
export const imageGeneratorRunSchema = z.object({
  id: z.string().min(1),
  status: imageGeneratorRunStatusSchema,
  modelSlug: z.string().min(1),
  /** The exact provider version the run pinned before spend. */
  requestedVersionId: z.string().min(1).nullable().default(null),
  /** The version the provider echoed back — disagreement surfaces an unannounced bump. */
  executedVersionId: z.string().min(1).nullable().default(null),
  /** The admin's whole positive prompt, verbatim. */
  prompt: z.string(),
  /** What was actually sent, post shared-boundary preparation, recorded pre-spend. */
  finalPrompt: z.string().nullable().default(null),
  inputs: imageGeneratorRunInputsSchema.catch(emptyImageGeneratorRunInputs).default(emptyImageGeneratorRunInputs),
  controls: imageGeneratorControlsSchema.catch(emptyImageGeneratorControls).default(emptyImageGeneratorControls),
  providerInputs: imageGeneratorProviderInputsSchema
    .catch(emptyImageGeneratorProviderInputs)
    .default(emptyImageGeneratorProviderInputs),
  sourceRunId: z.string().min(1).nullable().default(null),
  resultImageId: z.string().min(1).nullable().default(null),
  /** Dotted generator code, or a verbatim shared-layer code — see the vocabulary note. */
  failureCode: z.string().nullable().default(null),
  /** Truncated provider/classifier detail beside the code. */
  error: z.string().nullable().default(null),
  predictionId: z.string().min(1).nullable().default(null),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).nullable().default(null),
  finishedAt: z.string().min(1).nullable().default(null),
  /**
   * The attempt's provenance record (`ResolvedImageAttempt`), read out of the
   * row's meta bag. Kept LOOSE, exactly as the Gallery keeps `meta.render`: the
   * client only carries it, and a strict shape here would strip a record
   * written by a newer deploy.
   */
  attempt: z.record(z.string(), z.unknown()).nullable().catch(null).default(null),
});
export type ImageGeneratorRun = z.infer<typeof imageGeneratorRunSchema>;
