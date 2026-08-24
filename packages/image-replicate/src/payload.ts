import {
  type ImageEmptyPromptPolicy,
  type ImageModel,
  type ImageRenderPolicy,
  type ProviderExecutionPolicy,
  reservedImageInputFields,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@vesper/contracts";
import type { PreparedReferenceBytes } from "./files";

/**
 * One structural control image and the provider input it was bound to.
 *
 * The field is resolved upstream from the version's `additionalImageInputs`
 * (`planImageRender`); this package never derives it. That is the same division
 * `controlInput` follows — alias discovery happens once, in the probe, and the
 * transport writes what it was told.
 */
export interface RenderControlReference {
  field: string;
  /** `single` writes one URI; `array` writes a list, matching the declared schema. */
  arity: "single" | "array";
  buffers: PreparedReferenceBytes[];
}

export interface RegistryModelRequest {
  prompt: string;
  /**
   * Ordered identity/location references; trimmed to what the model accepts.
   * PREPARED bytes, never raw buffers: the application's preparation step
   * (orientation, metadata strip, encode) resolves the media type and extension
   * this package stamps on uploads and data URIs, because deriving them here
   * would need sharp — which this package may not run.
   */
  references?: PreparedReferenceBytes[];
  /**
   * Structural controls that have their own provider input, already bound to a
   * field name.
   *
   * They travel the same transport as `references` — uploaded as short-lived
   * files, or inlined for a `data_url` model — but they are NOT subject to
   * `fitReferences`, because the primary field's capacity says nothing about how
   * many images a separate `pose_image` input takes. Their own arity, resolved
   * from the schema that declared them, is the limit, and it was applied before
   * this call.
   */
  controlReferences?: RenderControlReference[];
  /**
   * The shape to request, already negotiated against the model's offerings by
   * `chooseAspect`. Null omits the aspect key entirely, letting the model use
   * its own default.
   */
  aspect?: string | null;
  /**
   * Already-mapped provider fields — the caller's resolved controls and
   * validated overrides, keyed by this version's real input names
   * (`mapImageRenderControls` / `validateProviderOverrides`). Merged LAST, per
   * the capabilities spec's merge order, so a profile's guidance beats the
   * model row's `extraInput` constant.
   *
   * It is deliberately opaque here: this module does not know a control from a
   * constant, and adding a second place that reasons about control names is how
   * the two would drift. What it DOES enforce is that the overlay cannot touch
   * the fields the render path owns ({@link reservedImageInputFields}).
   */
  controlInput?: Record<string, unknown>;
  /**
   * The `controlInput` fields a typed semantic control produced — mapper-written,
   * never the raw override bag. The strict arm's provider-input validation
   * extends its typed-owner trust to exactly these, which is how a curated
   * LoRA's probed weights field may carry a URI while a raw advanced value may
   * not (image-model-adapters.spec.md).
   */
  typedControlFields?: readonly string[];
  /**
   * This run's prediction budget, overriding the configured default for BOTH the
   * poll deadline and Replicate's `Cancel-After`. A profile's `timeoutMs` arrives
   * here; anything out of the sane 30s–30m band is clamped rather than honored,
   * because a caller asking for a 12-hour prediction is a bug, not a budget.
   */
  timeoutMs?: number;
  /**
   * Execute EXACTLY this provider version, whatever the slug says. A controlled
   * comparison cannot run against a floating `latest_version`, so the identity
   * trial pins the probed version id here and the prediction goes to
   * `/predictions` carrying it even for a bare `owner/name` slug.
   */
  versionId?: string;
  /**
   * How strictly this request is to be treated when the payload cannot carry
   * everything it was handed (`ImageRenderPolicy` in `@vesper/image-core`).
   *
   * Absent is the production answer — trim references that do not fit and let
   * the provider judge the values — so every existing lane behaves exactly as
   * it did before the field existed. The Image Generator asks for the strict
   * arm on both halves, because an operator-authored bench request that was
   * quietly reduced is a different experiment under the same run id.
   */
  policy?: ImageRenderPolicy;
  /**
   * How this run's prediction is WATCHED: one budget, or a startup budget and a
   * render budget with startup retries (`ProviderExecutionPolicy` in
   * `@vesper/image-core`, enforced in `runPrediction`).
   *
   * A pure passthrough here — nothing about the payload changes — but it lives
   * on the request because the lane that decided to be patient with a cold-boot
   * queue is the same lane that assembled the render. Absent is the production
   * answer and keeps the legacy single-budget shell exactly as it was; the
   * bench lanes supply one and read the `attempts` the result comes back with.
   */
  executionPolicy?: ProviderExecutionPolicy;
}

/**
 * Merge already-mapped provider fields onto a built payload, skipping anything
 * reserved.
 *
 * Build-then-overlay rather than overlay-then-build: the reserved keys must be
 * the ones the BUILDER produced, so a collision is detectable. A collision is
 * reported rather than swallowed — an operator who wrote `prompt` into a
 * profile's overrides needs told that it did nothing, not left to wonder why
 * their prompt text never appeared.
 */
export function overlayControlInput(
  built: Record<string, unknown>,
  controlInput: Record<string, unknown> | undefined,
  model: ImageModel,
  sink?: DiagnosticSink,
): Record<string, unknown> {
  if (!controlInput) return built;
  const reserved = new Set(reservedImageInputFields(model));
  const merged = { ...built };
  const refused: string[] = [];
  for (const [field, value] of Object.entries(controlInput)) {
    if (reserved.has(field)) {
      refused.push(field);
      continue;
    }
    merged[field] = value;
  }
  if (refused.length > 0) {
    sink?.push(
      diag("warn", "image_model.reserved_field_ignored", "control input tried to write a render-path field", {
        path: "image_models",
        context: { slug: model.slug, fields: refused.sort() },
      }),
    );
  }
  return merged;
}

/**
 * Build one model's prediction input (PURE — the unit-testable half of the
 * render path). Every difference between the models we run lives here rather
 * than in a per-model branch:
 *
 * - The reference key differs (`image` / `image_input` / `images`) and so does
 *   its arity — both Qwen models call it `image`, one a string and one an array.
 *   The key is OMITTED entirely when there are no references, because a model
 *   whose reference input is optional treats an empty array differently from an
 *   absent one on some backends.
 * - Shape is written to `aspect_ratio` on most models and to `size` on Wan,
 *   which has no aspect input at all. The VALUE is chosen upstream by
 *   `chooseAspect` against what the model offers; null omits the key so the
 *   model falls back to its own default.
 * - `output_format` is omitted where the model has no such input.
 * - `extraInput` carries per-model constants. `disable_safety_checker` is only
 *   ever present when the model's schema actually declares it — Replicate
 *   rejects unknown inputs — so its VALUE is overridden from the configured
 *   deployment fact here, but the key is never introduced.
 *
 * `safetyCheckerDisabled` is a PARAMETER rather than something this function
 * resolves. It used to be an environment read, which meant a stored
 * `extraInput.disable_safety_checker` was a placeholder rather than a fact and
 * anything fingerprinting a render had to remember to ask the same question.
 * One resolved config now feeds both the plan and the send.
 */
export function buildRegistryModelInput(
  model: ImageModel,
  prompt: string,
  referenceUrls: readonly string[],
  aspect: string | null | undefined,
  safetyCheckerDisabled: boolean,
  emptyPrompt: ImageEmptyPromptPolicy = "send",
): Record<string, unknown> {
  // An empty prompt writes the empty string unless the CALLER asked for it to
  // be omitted (`ImageRenderPolicy.emptyPrompt`). The distinction matters: the
  // Image Lab's control probe may legitimately send a blank instruction and
  // must keep posting `prompt: ""`, while a caller that has checked the version
  // does not require a prompt wants the version's own default to apply, which
  // only an absent key produces.
  const input: Record<string, unknown> = prompt.length > 0 || emptyPrompt === "send" ? { prompt } : {};

  if (referenceUrls.length > 0) {
    input[model.referenceField] = model.referenceArity === "single" ? referenceUrls[0] : [...referenceUrls];
  }

  if (aspect) input[model.aspectMode === "size" ? "size" : "aspect_ratio"] = aspect;

  if (model.outputFormat) input.output_format = model.outputFormat;

  for (const [key, value] of Object.entries(model.extraInput)) {
    input[key] = key === "disable_safety_checker" ? safetyCheckerDisabled : value;
  }
  return input;
}

/**
 * Build the prediction input for one transport: the ordinary payload, the bound
 * control fields written over it, then the caller's control overlay.
 *
 * Shared by both transports so the field-writing rules have one home. The ORDER
 * matters and is the capabilities spec's: controls are structural inputs the
 * render path owns, so they are written before `controlInput`, whose overlay
 * refuses reserved fields but is otherwise a later layer that wins.
 */
export function buildPayload(
  model: ImageModel,
  request: RegistryModelRequest,
  referenceUris: readonly string[],
  controls: readonly { field: string; value: string | string[] }[],
  safetyCheckerDisabled: boolean,
  sink?: DiagnosticSink,
): Record<string, unknown> {
  const built = buildRegistryModelInput(
    model,
    request.prompt,
    referenceUris,
    request.aspect,
    safetyCheckerDisabled,
    request.policy?.emptyPrompt,
  );
  const reserved = new Set(reservedImageInputFields(model));
  const refused: string[] = [];
  for (const control of controls) {
    // The same rule the override overlay follows, for the same reason: a probe
    // that recorded an image input named `prompt` (or the aspect key) would
    // otherwise have the control image overwrite what the render path itself
    // wrote. The binding step already rules out the primary reference field.
    if (reserved.has(control.field)) {
      refused.push(control.field);
      continue;
    }
    built[control.field] = control.value;
  }
  if (refused.length > 0) {
    sink?.push(
      diag("warn", "image_model.control_field_reserved", "a bound control image named a render-path field", {
        path: "image_models",
        context: { slug: model.slug, fields: refused.sort() },
      }),
    );
  }
  return overlayControlInput(built, request.controlInput, model, sink);
}

/**
 * The payload this request WILL produce, assembled without any IO.
 *
 * Same builder, same reserved filter, same overlay order as the real send — the
 * only difference is that reference and control URIs are placeholders, because
 * the addresses do not exist until the bytes are transported and the strict
 * gate asks about FIELDS, not addresses.
 *
 * It exists so a caller can hold its request against the version's declared
 * schema before committing to the transport at all, without rebuilding the
 * payload rules in application code — which is the one thing this package
 * exists to prevent.
 */
export function previewRegistryModelInput(input: {
  model: ImageModel;
  prompt: string;
  referenceCount: number;
  controlReferences?: readonly { field: string; arity: "single" | "array"; count: number }[];
  aspect: string | null;
  controlInput?: Record<string, unknown>;
  policy?: ImageRenderPolicy;
  safetyCheckerDisabled: boolean;
}): Record<string, unknown> {
  const placeholder = (index: number): string => `https://placeholder.invalid/reference-${String(index + 1)}`;
  const references = Array.from({ length: input.referenceCount }, (_unused, index) => placeholder(index));
  const controls = (input.controlReferences ?? []).flatMap((control) => {
    if (control.count === 0) return [];
    const uris = Array.from({ length: control.count }, (_unused, index) => placeholder(index));
    const value: string | string[] = control.arity === "array" ? uris : (uris[0] ?? "");
    return [{ field: control.field, value }];
  });
  return buildPayload(
    input.model,
    {
      prompt: input.prompt,
      aspect: input.aspect,
      ...(input.controlInput ? { controlInput: input.controlInput } : {}),
      ...(input.policy ? { policy: input.policy } : {}),
    },
    references,
    controls,
    input.safetyCheckerDisabled,
  );
}

/**
 * Each bound control's field and the URI(s) its declared arity calls for.
 *
 * `uris` is the control images' URIs in the SAME order the controls list their
 * buffers — the order they were inlined or uploaded in — and is walked with a
 * cursor rather than matched by buffer, so two byte-identical control images
 * stay two images.
 */
export function controlUris(
  controls: readonly RenderControlReference[],
  uris: readonly string[],
): { field: string; value: string | string[] }[] {
  let cursor = 0;
  return controls.flatMap((control) => {
    const taken = uris.slice(cursor, cursor + control.buffers.length);
    cursor += control.buffers.length;
    if (taken.length === 0) return [];
    // An `array` field takes the list even at one image — the schema declared a
    // list, and a bare string where a list is expected is a validation failure,
    // not a convenience. A `single` field takes the first and only image the
    // binding step allowed through.
    const value: string | string[] = control.arity === "array" ? [...taken] : (taken[0] ?? "");
    return [{ field: control.field, value }];
  });
}
