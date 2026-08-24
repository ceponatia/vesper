import { z } from "zod";
import {
  imageAspectModes,
  imageControlReferenceRoles,
  imageEditKinds,
  imageIdentityPreservationSchema,
  imageModelAdvancedCapabilitiesSchema,
  imageReferenceArities,
  imageReferenceRoleSchema,
  imageReferenceTransports,
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

/**
 * The normalized per-run control overlay: the package's own schema plus ONE
 * Generator-owned field.
 *
 * `aspect` is the operator's explicit shape choice, spelled as a member of the
 * selected version's own `supportedAspects` (`"3:4"`, `"1536*2048"`). It is not
 * promoted into `ImageRenderControls` because it is not a normalized control —
 * it is a pointer INTO the model's declared shape enum, which the render path
 * already negotiates. The runner converts it to a target ratio and lets
 * `chooseAspect` pick the same member back, so the one mapper stays the one
 * mapper.
 *
 * ABSENT is the Generator's default and it means the model's own shape: no
 * aspect/size key in the payload, no bucket picked for being nearest a Vesper
 * target, and no crop afterwards. A raw bench that quietly reshaped a model's
 * answer would be reporting Vesper's opinion as the model's.
 */
export const imageGeneratorControlsSchema = imageRenderControlsSchema.extend({
  aspect: z.string().min(1).max(32).optional(),
});
export type ImageGeneratorControls = z.infer<typeof imageGeneratorControlsSchema>;

export function emptyImageGeneratorControls(): ImageGeneratorControls {
  return {};
}

/** The render-path half of a run's controls — `aspect` is the Generator's own. */
export function imageGeneratorRenderControls(controls: ImageGeneratorControls): ImageRenderControls {
  const renderControls: ImageRenderControls = { ...controls };
  delete (renderControls as ImageGeneratorControls).aspect;
  return renderControls;
}

/**
 * Which provider version a run executes.
 *
 * `current` re-resolves the registry's pin at run time — the ordinary case, and
 * the only honest answer for a first run. `captured` replays the exact version a
 * source run recorded, and is accepted ONLY beside a `sourceRunId` whose stored
 * capability snapshot can still describe that version; otherwise the run refuses
 * rather than pointing today's field bindings at yesterday's weights.
 */
export const imageGeneratorVersionPolicies = ["current", "captured"] as const;
export const imageGeneratorVersionPolicySchema = z.enum(imageGeneratorVersionPolicies);
export type ImageGeneratorVersionPolicy = (typeof imageGeneratorVersionPolicies)[number];

/**
 * The mechanical half of a registered model, frozen onto a run before it spends.
 *
 * This is the smallest thing that makes an exact-version replay honest. Vesper
 * keeps ONE capability record per registered model, replaced wholesale when the
 * row is re-probed, so once a model moves to a new version nothing anywhere can
 * still say how the old one bound its fields. A replay that used today's
 * bindings against yesterday's weights would send a request neither version
 * ever described.
 *
 * So every run writes down the capability facts it actually ran under, and a
 * captured-version replay plans against THOSE. Nothing here is optional and
 * nothing defaults: a snapshot missing a field is a snapshot that cannot be
 * trusted to describe the version, and the replay refuses instead.
 *
 * `probedVersionId` is the load-bearing member — it is what proves the record
 * described the version the run pinned, rather than some later one the row had
 * already moved to.
 */
export const imageGeneratorCapabilitySnapshotSchema = z.object({
  canGenerate: z.boolean(),
  canEdit: z.boolean(),
  referenceField: z.string().min(1),
  referenceArity: z.enum(imageReferenceArities),
  referenceTransport: z.enum(imageReferenceTransports),
  maxReferences: z.number().int().min(0),
  aspectMode: z.enum(imageAspectModes),
  supportedAspects: z.array(z.string()),
  outputFormat: z.string().nullable(),
  extraInput: z.record(z.string(), z.unknown()),
  editKind: z.enum(imageEditKinds),
  identityPreservation: imageIdentityPreservationSchema,
  probedVersionId: z.string().min(1),
  advancedCapabilities: imageModelAdvancedCapabilitiesSchema,
});
export type ImageGeneratorCapabilitySnapshot = z.infer<typeof imageGeneratorCapabilitySnapshotSchema>;

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
  /**
   * Possibly EMPTY. Whether this model can run without prompt text is a
   * capability fact — the version's probed `prompt` descriptor either sits in
   * its schema's `required` list or does not — and a contract cannot read it,
   * because a contract does not know which model was picked. An empty prompt on
   * a model that needs one refuses on the run row with `prompt_required`, where
   * the admin can see which model said so.
   */
  prompt: z.string().trim().max(IMAGE_GENERATOR_PROMPT_MAX),
  inputs: imageGeneratorRunInputsSchema.optional(),
  controls: imageGeneratorControlsSchema.optional(),
  providerInputs: imageGeneratorProviderInputsSchema
    .refine((record) => Object.keys(record).length <= IMAGE_GENERATOR_MAX_PROVIDER_INPUTS, {
      message: `providerInputs is capped at ${String(IMAGE_GENERATOR_MAX_PROVIDER_INPUTS)} keys`,
    })
    .optional(),
  /** Duplicate/variant lineage — the settled run this one was prefilled from. */
  sourceRunId: z.string().min(1).optional(),
  /** Which version runs; `captured` needs the `sourceRunId` it is replaying. */
  versionPolicy: imageGeneratorVersionPolicySchema.optional(),
}).superRefine((request, ctx) => {
  const roles = (request.inputs?.dedicated ?? []).map((input) => input.role);
  if (new Set(roles).size !== roles.length) {
    ctx.addIssue({
      code: "custom",
      path: ["inputs", "dedicated"],
      message: "a run sends at most one dedicated input per role",
    });
  }
  // A client bug, not a runtime fact: there is no version to replay without a
  // run to replay it from, and accepting the pair silently would let a
  // "captured" request quietly become a "current" one.
  if (request.versionPolicy === "captured" && request.sourceRunId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["versionPolicy"],
      message: "replaying a captured version needs the run it was captured from",
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
  /** The prompt is empty and this version declares its prompt input required. */
  "prompt_required",
  /** A captured version cannot be replayed against trustworthy capability facts. */
  "version_replay_unsafe",
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
  /** Which version this run asked for — `captured` means it replayed a source run's. */
  versionPolicy: imageGeneratorVersionPolicySchema.catch("current").default("current"),
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
  /**
   * The sanitized effective request, written BEFORE spend: the provider-shaped
   * control fields, the shape mode and the aspect field/value actually sent, and
   * the image-id → provider-slot mapping. Kept LOOSE for the same reason
   * `attempt` is: the inspector only displays it, and a strict shape here would
   * strip a record written by a newer deploy.
   */
  effectiveRequest: z.record(z.string(), z.unknown()).nullable().catch(null).default(null),
  /** What came back: returned dimensions, whether Vesper cropped, unsent inputs. */
  result: z.record(z.string(), z.unknown()).nullable().catch(null).default(null),
});
export type ImageGeneratorRun = z.infer<typeof imageGeneratorRunSchema>;
