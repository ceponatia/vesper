import type { IdentityReferenceRole } from "../identity/identity-pack";
import type { ImagePromptStrategy } from "../models/image-model-profiles";
import type { ProfileRenderPlan } from "./compile-profile-plan";
import { stableJson } from "./stable-json";

export interface ProfileRenderControlsFingerprintInput {
  profileId: string;
  profileKey: string;
  promptStrategy: ImagePromptStrategy;
  /** Reference roles in send order — part of the configuration, not of the prompt. */
  orderedReferenceRoles: readonly IdentityReferenceRole[];
}

/**
 * The fingerprint of an ACTUALLY-EXECUTING configuration: everything about how
 * this render will be made beyond its prompt text, as one deterministic string.
 *
 * This function decides WHAT represents the configuration; hashing that string
 * is the application's job, because SHA-256 execution is Node work and this
 * package stays browser/server portable
 * (monorepo-image-core.spec.guardrails.md §"Runtime targets"). The split is
 * ownership, not behavior: the application's `profileRenderControlsHash` is
 * `sha256Hex` of exactly this string, and the stored value is unchanged.
 *
 * Two rules decide what goes in. Everything fingerprinted must be something the
 * render sends or is shaped by — the effective model's identity and transport
 * facts, the resolved control payload, the drops, the version, the timeout, the
 * profile's identity and strategy. And nothing the render sends may be left out,
 * which is why the input is the PLAN rather than the rows: a field that reaches
 * the provider without reaching this string is a change a pinned comparison
 * cannot detect.
 *
 * `promptStrategy` earns its place under the FIRST rule, and only since the
 * prompt-strategy dispatch shipped: the strategy now decides how the references
 * are named in the compiled text, or refuses the compile outright. It was
 * fingerprinted before that dispatch existed too, and that was the bug — two
 * profiles differing only in strategy fingerprinted differently while sending
 * identical prompts, so the fingerprint asserted a difference nothing downstream
 * made.
 *
 * Display-only fields (labels, sort order, `enabled`) are deliberately absent: a
 * renamed profile is the same experiment, and invalidating a grid over a label
 * edit would train operators to ignore `cell_conflict`.
 *
 * What this describes is the MERGE INPUTS, not the post-merge payload, and the
 * distinction is worth stating because the payload builder applies `extraInput`
 * AFTER the aspect key: a model whose `extraInput` carries `size` or
 * `aspect_ratio` overrides the `aspectValue` recorded here, so the two fields
 * below can disagree with what finally travels. That is safe rather than
 * sloppy — both are fingerprinted, so any drift in either still moves the
 * value — and the alternative (fingerprinting a payload this function would have
 * to rebuild) would be a second construction of the provider input, which is
 * precisely the duplication "what is fingerprinted is what is sent" exists to
 * remove.
 *
 * `extraInput`'s `disable_safety_checker` is the CALLER-SUPPLIED value by the
 * time a plan reaches here (`compileProfileRenderPlan`), so this tracks the
 * enforcement that will actually apply rather than the row's placeholder.
 */
export function profileRenderControlsFingerprintJson(
  plan: ProfileRenderPlan,
  extra: ProfileRenderControlsFingerprintInput,
): string {
  const model = plan.effectiveModel;
  return stableJson({
    modelId: model.id,
    modelSlug: model.slug,
    modelVersion: plan.versionId,
    referenceField: model.referenceField,
    referenceArity: model.referenceArity,
    referenceTransport: model.referenceTransport,
    maxReferences: model.maxReferences,
    aspect: plan.aspectValue,
    outputFormat: model.outputFormat,
    extraInput: model.extraInput,
    operation: plan.resolvedControls.operation,
    promptStrategy: extra.promptStrategy,
    timeoutMs: plan.timeoutMs,
    controlInput: plan.controlInput,
    droppedControls: plan.resolvedControls.droppedControls,
    profileId: extra.profileId,
    profileKey: extra.profileKey,
    orderedReferenceRoles: [...extra.orderedReferenceRoles],
  });
}
