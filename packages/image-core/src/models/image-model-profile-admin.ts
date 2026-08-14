import { z } from "zod";
import { validateProviderOverrides } from "../capabilities/image-control-mapping";
import { reservedImageInputFields } from "../capabilities/reserved-image-input-fields";
import type { ImageModel } from "./image-models";
import {
  emptyImageControlDefaults,
  emptyImageReferencePolicy,
  imageControlDefaultsSchema,
  imageProfileOperationSchema,
  imageProfileTaskSchema,
  imagePromptStrategySchema,
  imageReferencePolicySchema,
  profileEligibility,
  type ImageModelProfile,
  type ImageProfileIneligibility,
} from "./image-model-profiles";

/**
 * The profile registry's admin contract (image-model-capabilities.spec.md
 * §"Admin UI", §`image_model_profiles`): what the create and edit routes accept,
 * and the one configuration judgment a save must pass.
 *
 * The request schemas follow the LoRA library's precedent (`../loras/image-loras.ts`):
 * bounded strings, the row's own jsonb schemas reused verbatim so a request that
 * saves cleanly always reads back, and no `id`/`builtin` — the id is the
 * server's to mint and a row created through the API is by definition not
 * seeded.
 *
 * {@link validateImageProfileConfiguration} is the pure half of the save-time
 * check. It exists as its own function, rather than inline in the service,
 * because it is a decision table: which profile/model pairs may be STORED. It
 * deliberately reuses the two rules the render path already keeps —
 * {@link profileEligibility} for "could this model ever offer the profile", and
 * `validateProviderOverrides` for the escape hatch — so a save refusal and a
 * render refusal can never disagree about the same row.
 */

/**
 * A stable machine key, unique within the model (`scene-standard`). Lowercase
 * slug shape on purpose: the key is compared and grepped, never displayed, and
 * a free-text key would make "unique within the model" depend on whitespace.
 */
const profileKey = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "a key is lowercase letters, digits, dashes and underscores");
const profileLabel = z.string().trim().min(1).max(200);
/** Bounded to the table's own check constraint (30s–15min); null = env budget. */
const profileTimeout = z.number().int().min(30_000).max(900_000).nullable();
const profileSort = z.number().int().min(0).max(9999);
/** Raw provider keys. Key-validated against the model at save time, not here —
 * the schema cannot see the model row. */
const profileOverrides = z.record(z.string(), z.unknown());

/**
 * What the admin create route accepts. Everything past the identity fields is
 * defaulted to the same inert values the seeded `'{}'::jsonb` rows parse to, so
 * a minimal request produces a row whose render behavior is the model's own.
 *
 * The defaults are thunks for the standing reason in
 * `../capabilities/image-model-capabilities.ts`: zod hands a default through
 * without cloning, and one shared object would let a caller's edit rewrite
 * every parsed request.
 */
export const imageModelProfileCreateRequestSchema = z.object({
  key: profileKey,
  label: profileLabel,
  task: imageProfileTaskSchema,
  operation: imageProfileOperationSchema,
  promptStrategy: imagePromptStrategySchema,
  referencePolicy: imageReferencePolicySchema.default(emptyImageReferencePolicy),
  controlDefaults: imageControlDefaultsSchema.default(emptyImageControlDefaults),
  providerOverrides: profileOverrides.default((): Record<string, unknown> => ({})),
  timeoutMs: profileTimeout.default(null),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  sort: profileSort.default(0),
});
export type ImageModelProfileCreateRequest = z.infer<typeof imageModelProfileCreateRequestSchema>;

/**
 * A partial edit. Every field is optional; the rules that need the fields a
 * request did not send — eligibility, override keys, the duplicate key and the
 * second-default-per-task — are judged by the service against the MERGED row,
 * the only place that can see them.
 */
export const imageModelProfileUpdateRequestSchema = z.object({
  key: profileKey.optional(),
  label: profileLabel.optional(),
  task: imageProfileTaskSchema.optional(),
  operation: imageProfileOperationSchema.optional(),
  promptStrategy: imagePromptStrategySchema.optional(),
  referencePolicy: imageReferencePolicySchema.optional(),
  controlDefaults: imageControlDefaultsSchema.optional(),
  providerOverrides: profileOverrides.optional(),
  timeoutMs: profileTimeout.optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sort: profileSort.optional(),
});
export type ImageModelProfileUpdateRequest = z.infer<typeof imageModelProfileUpdateRequestSchema>;

/**
 * One reason a profile configuration may not be stored against its model.
 *
 * Two kinds rather than one bucket because they send an operator to different
 * fixes: `ineligible` means the task/operation pair is wrong for this model
 * (pick another model, or another operation), `override_rejected` names the
 * specific provider key the escape hatch refused.
 */
export type ImageProfileConfigurationIssue =
  | { kind: "ineligible"; reason: ImageProfileIneligibility; message: string }
  | { kind: "override_rejected"; field: string; reason: "reserved" | "unknown_field"; message: string };

/** The eligibility refusals, in an operator's words rather than the enum's. */
function ineligibilityMessage(reason: ImageProfileIneligibility, profile: Pick<ImageModelProfile, "task" | "operation">): string {
  switch (reason) {
    case "operation_unsupported":
      return profile.operation === "generate"
        ? "this model cannot generate from a prompt alone, so a generate profile can never run on it"
        : "this model has no reference input, so an edit profile can never run on it";
    case "edit_kind_none":
      return "this model's reviewed edit kind is “none”, so an edit profile can never run on it";
    case "identity_too_weak":
      return `this model's reviewed identity preservation is “weak”, and “${profile.task}” must keep a specific person recognizable`;
    case "img2img_identity_task":
      return `this model repaints from noise (img2img), which cannot keep identity for “${profile.task}”`;
  }
}

/**
 * Whether this profile configuration may be STORED against this model — the
 * save-time decision table. An empty result means the save may proceed.
 *
 * Two gates, both reused from the render path rather than restated:
 *
 * 1. **Eligibility** ({@link profileEligibility}): a profile the model could
 *    never offer — wrong operation, reviewed edit kind `none`, or an
 *    identity-critical task on a `weak`/`img2img` model — is refused with the
 *    eligibility reason. Storing it would create a row every resolution
 *    silently skips, which reads to an operator as "the profile I saved does
 *    nothing".
 * 2. **Provider overrides** (`validateProviderOverrides` with the model's
 *    reserved fields): a reserved key is refused, and a key outside the probed
 *    `knownInputFields` is refused — with EMPTY `knownInputFields` failing
 *    CLOSED when overrides exist, the same rule the render path and candidate
 *    activation apply. Empty means the probe recorded nothing, not that
 *    everything is permitted; the fix is a re-probe, and the message says so.
 *
 * What it deliberately does NOT check: `enabled`, `isDefault`, the timeout
 * (schema-bounded), and the LoRA selection. Disabling a task's only default is
 * allowed — resolution degrades by design — and a LoRA that does not suit the
 * model refuses at render time with its own two codes, where the version that
 * will actually run is known.
 */
export function validateImageProfileConfiguration(
  profile: Pick<ImageModelProfile, "task" | "operation" | "providerOverrides">,
  model: ImageModel,
): ImageProfileConfigurationIssue[] {
  const issues: ImageProfileConfigurationIssue[] = [];

  const eligibility = profileEligibility(profile, model);
  if (!eligibility.ok) {
    issues.push({ kind: "ineligible", reason: eligibility.reason, message: ineligibilityMessage(eligibility.reason, profile) });
  }

  const known = model.advancedCapabilities.knownInputFields;
  const overrides = validateProviderOverrides(profile.providerOverrides, known, reservedImageInputFields(model));
  for (const drop of overrides.dropped) {
    if (drop.reason === "reserved") {
      issues.push({
        kind: "override_rejected",
        field: drop.control,
        reason: "reserved",
        message: `providerOverrides may not write “${drop.control}” — the render path owns that field`,
      });
    } else {
      issues.push({
        kind: "override_rejected",
        field: drop.control,
        reason: "unknown_field",
        message:
          known.length === 0
            ? `providerOverrides key “${drop.control}” cannot be validated: this model has no probed input fields — re-probe it first`
            : `providerOverrides key “${drop.control}” is not an input this model's probed version declares`,
      });
    }
  }

  return issues;
}
