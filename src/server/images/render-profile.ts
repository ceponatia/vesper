import { createHash } from "node:crypto";
import {
  chooseAspect,
  type IdentityReferenceRole,
  type ImageModel,
  type ImageModelProfile,
  type ImagePromptStrategy,
  type ImageRenderControls,
  type TrialResolvedControls,
} from "@/contracts";
import { compileIdentityReferencePrompt } from "@/lib/images/identity-reference-prompt";
import { mapImageRenderControls, reservedImageInputFields, validateProviderOverrides } from "../ai";
import { preparePromptForImageModel, withReviewedImageQuality } from "./quality-presets";

/**
 * THE profile compile step: one profile row plus one prompt in, the exact
 * provider-shaped configuration out (image-model-capabilities.spec.md
 * §"Normalized render intent" steps 5–11, §"Control mapping", §"Timeouts").
 *
 * This is the kernel of the capabilities plan's slice 2/4 work, landed early
 * because the identity trial needs it FIRST: a comparison harness that records a
 * profile's controls but sends the model row's raw defaults is grading a
 * configuration nobody ran. It is written to be adopted by the production render
 * intent rather than re-invented beside it — `renderImageIntent` should call
 * this for its resolved profile and add only the parts a trial has no use for
 * (reference selection by policy, LoRA resolution, per-request control
 * overrides, image sets).
 *
 * Three properties are load-bearing and are why this lives in ONE function:
 *
 * 1. **What is hashed is what is sent.** {@link profileRenderControlsHash}
 *    hashes fields taken from the plan this same call produced, so a field
 *    cannot enter the hash unless it entered the payload. The old trial hash was
 *    assembled independently of the render call and drifted from it immediately.
 * 2. **The EFFECTIVE model is what counts.** `withReviewedImageQuality` rewrites
 *    `extraInput` at the render boundary (Qwen Edit's `go_fast`, Juggernaut's
 *    step/CFG correction). Hashing the raw row let that table change the
 *    provider payload with no `cell_conflict` to show for it — a silent change
 *    to what a pinned comparison sends.
 * 3. **Nothing is guessed and nothing is silently dropped.** Controls map only
 *    through the version's probed bindings, and every omission is recorded in
 *    `resolvedControls.droppedControls`, which is itself hashed.
 */

/**
 * Deterministic JSON for hashing: keys sorted recursively, `undefined` members
 * dropped. Exported so the one hashing helper in the image lane has one home —
 * a second copy would be a second answer to "did this configuration move?".
 *
 * Local rather than imported from the engine's `canonicalJson` because that
 * module carries the contact-ledger machinery, and reaching into it from the
 * image lane for a string formatter would couple two systems over nothing.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hex sha256 of a string. One spelling, shared by prompt and control hashes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The exact provider version this model row runs, or null when nothing can say.
 *
 * Prefers the probed version id, then a version pinned in the slug itself. When
 * BOTH exist and DISAGREE the answer is null: the stored bindings describe one
 * version while the slug names another, so there is no single version this row
 * can honestly claim to execute, and picking either would be a coin flip
 * recorded as a pin.
 *
 * Null means a CONTROLLED run cannot use this model — the identity trial refuses
 * `version_unpinned` rather than planning a cell against whatever Replicate
 * calls `latest_version` that hour. Production is deliberately unaffected: an
 * ordinary render happily follows the floating latest, because a portrait that
 * came out well is still a portrait, whereas a comparison run against two
 * different versions is not a comparison.
 */
export function pinnedImageModelVersion(model: ImageModel): string | null {
  const slugPin = model.slug.split(":")[1] ?? null;
  const pinned = slugPin !== null && slugPin.length > 0 ? slugPin : null;
  if (model.probedVersionId !== null && pinned !== null) {
    return model.probedVersionId === pinned ? pinned : null;
  }
  return model.probedVersionId ?? pinned;
}

export interface CompileProfileRenderPlanInput {
  model: ImageModel;
  profile: ImageModelProfile;
  /** The lane's or fixture's prompt, BEFORE reference-role compilation. */
  basePrompt: string;
  /** The caller's negative prompt; null falls back to the profile's default. */
  baseNegativePrompt: string | null;
  /** Reference roles in SEND order — the same order the buffers travel in. */
  referenceRoles: readonly IdentityReferenceRole[];
}

/**
 * One compiled render: the model that will actually run, the exact text that
 * will be sent, and the provider-shaped controls that will accompany it.
 */
export interface ProfileRenderPlan {
  /** The model AFTER the reviewed-quality seam — what the provider really sees. */
  effectiveModel: ImageModel;
  /** The final prompt text, role preamble and model-dialect rewrite included. */
  finalPrompt: string;
  /**
   * The negative text that WILL be sent, or null. Null covers both "no negative
   * was configured" and "this version exposes no negative-prompt field", because
   * from the render's point of view those are the same fact: nothing goes. The
   * distinction survives in `resolvedControls.droppedControls`.
   */
  negativePrompt: string | null;
  /** The aspect value `chooseAspect` will pick, or null when the model offers none. */
  aspectValue: string | null;
  /** Mapped controls plus validated overrides, keyed by provider field name. */
  controlInput: Record<string, unknown>;
  /** The auditable record of the above, drops included. */
  resolvedControls: TrialResolvedControls;
  /** The profile's prediction budget; null uses the env/default. */
  timeoutMs: number | null;
  /** The pinned provider version, or null when this row has none. */
  versionId: string | null;
}

/**
 * Compile one profile against one model and prompt.
 *
 * The pipeline mirrors the spec's resolution order for the steps a single-image
 * render needs: reviewed-quality model, role-compiled prompt, model-dialect
 * prompt preparation, negative resolution, control mapping, override
 * validation, aspect choice, version pin.
 *
 * `preparePromptForImageModel` runs HERE and again inside `renderWithModel`.
 * That is deliberate and safe: the rewrite is idempotent (it replaces the legacy
 * identity lock, and a prompt with no legacy lock left in it passes through
 * untouched), so the text hashed here is byte-for-byte the text the provider
 * receives. Relying on that property beats adding a "already prepared" flag
 * whose two code paths would need keeping honest forever.
 */
export function compileProfileRenderPlan(input: CompileProfileRenderPlanInput): ProfileRenderPlan {
  const { model, profile, basePrompt, baseNegativePrompt, referenceRoles } = input;
  const effectiveModel = withReviewedImageQuality(model);
  const rolePrompt = compileIdentityReferencePrompt({ basePrompt, roles: referenceRoles });
  const finalPrompt = preparePromptForImageModel(effectiveModel, rolePrompt, referenceRoles.length);

  const defaults = profile.controlDefaults;
  const negative = baseNegativePrompt ?? defaults.negativePrompt ?? null;

  // The profile's stored defaults with the resolved negative folded in.
  // `seedPolicy` is deliberately absent: it is a POLICY, not a value to send,
  // and no seed transport exists anywhere in the render path yet — so a
  // seed-shaped default is recorded as a DROP below rather than quietly ignored,
  // because "this run was not seeded" is a fact the comparison hash must carry.
  const controls: ImageRenderControls = {
    ...(negative !== null ? { negativePrompt: negative } : {}),
    ...(defaults.guidance !== undefined ? { guidance: defaults.guidance } : {}),
    ...(defaults.steps !== undefined ? { steps: defaults.steps } : {}),
    ...(defaults.editStrength !== undefined ? { editStrength: defaults.editStrength } : {}),
    ...(defaults.outputCount !== undefined ? { outputCount: defaults.outputCount } : {}),
    ...(defaults.coherentSet !== undefined ? { coherentSet: defaults.coherentSet } : {}),
    ...(defaults.thinkingMode !== undefined ? { thinkingMode: defaults.thinkingMode } : {}),
    ...(defaults.resolution !== undefined ? { resolution: defaults.resolution } : {}),
    ...(defaults.width !== undefined ? { width: defaults.width } : {}),
    ...(defaults.height !== undefined ? { height: defaults.height } : {}),
    ...(defaults.lora !== undefined ? { lora: defaults.lora } : {}),
  };

  const mapped = mapImageRenderControls({ controls, capabilities: effectiveModel.advancedCapabilities });
  const overrides = validateProviderOverrides(
    profile.providerOverrides,
    effectiveModel.advancedCapabilities.knownInputFields,
    reservedImageInputFields(effectiveModel),
  );
  // Overrides merge LAST, per the spec's "a later layer wins". They therefore
  // may also replace a mapped control's value, which is why the reported
  // negative below is read back out of the FINAL payload rather than from the
  // mapping step: a hash that described the pre-override text would be a hash of
  // something the provider never saw.
  const controlInput = { ...mapped.input, ...overrides.input };
  const negativeField = effectiveModel.advancedCapabilities.controls.negativePrompt?.field;
  const sentNegative = negativeField === undefined ? undefined : controlInput[negativeField];

  // Typed as the contract's own list rather than the mapper's narrower union:
  // the seed note below is this layer's fact, not one the mapper can produce.
  const droppedControls: TrialResolvedControls["droppedControls"] = [...mapped.dropped, ...overrides.dropped];
  if (defaults.seedPolicy !== "random") {
    // Only a non-default policy is worth recording: `random` is what sending no
    // seed key already does at every provider, so it drops nothing.
    droppedControls.push({ control: "seedPolicy", reason: "no_seed_transport" });
  }

  return {
    effectiveModel,
    finalPrompt,
    // The negative text only counts as "will be sent" if a real field carries it.
    negativePrompt: typeof sentNegative === "string" ? sentNegative : null,
    aspectValue: chooseAspect(effectiveModel).value,
    controlInput,
    resolvedControls: {
      operation: profile.operation,
      timeoutMs: profile.timeoutMs,
      controlInput,
      droppedControls,
    },
    timeoutMs: profile.timeoutMs,
    versionId: pinnedImageModelVersion(model),
  };
}

export interface ProfileRenderControlsHashInput {
  profileId: string;
  profileKey: string;
  promptStrategy: ImagePromptStrategy;
  /** Reference roles in send order — part of the configuration, not of the prompt. */
  orderedReferenceRoles: readonly IdentityReferenceRole[];
}

/**
 * The fingerprint of an ACTUALLY-EXECUTING configuration: everything about how
 * this render will be made beyond its prompt text.
 *
 * Two rules decide what goes in. Everything hashed must be something the render
 * sends or is shaped by — the effective model's identity and transport facts,
 * the resolved control payload, the drops, the version, the timeout, the
 * profile's identity and strategy. And nothing the render sends may be left out,
 * which is why the input is the PLAN rather than the rows: a field that reaches
 * the provider without reaching this hash is a change a pinned comparison cannot
 * detect.
 *
 * Display-only fields (labels, sort order, `enabled`) are deliberately absent: a
 * renamed profile is the same experiment, and invalidating a grid over a label
 * edit would train operators to ignore `cell_conflict`.
 */
export function profileRenderControlsHash(plan: ProfileRenderPlan, extra: ProfileRenderControlsHashInput): string {
  const model = plan.effectiveModel;
  return sha256Hex(
    stableJson({
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
    }),
  );
}
