import type { ImageRenderControls } from "../models/image-model-profiles";
import type {
  ImageInputBinding,
  ImageModelAdvancedCapabilities,
  ImageModelControlBindings,
} from "./image-model-capabilities";

/**
 * The normalized-control mapper (image-model-capabilities.spec.md §"Control
 * mapping"): normalized control names in, one version's real provider fields
 * out.
 *
 * The whole point of the layer is that ALIAS DISCOVERY HAPPENED ONCE, in the
 * probe. `guidance` is `guidance` on one model and `cfg` on another, and a
 * render-time mapper that searched a payload for something guidance-shaped
 * would reintroduce exactly the guessing the capability contract removes. So
 * this module reads `capabilities.controls` and nothing else: a control with no
 * binding on the ACTIVE version is DROPPED with a reason, never renamed,
 * inferred, or written to a field name that looked plausible.
 *
 * Two rules make the drop list load-bearing rather than debug noise:
 *
 * 1. **Nothing is silently ignored.** Every control that does not reach the
 *    payload leaves a `{ control, reason }` entry. The identity trial hashes
 *    the resolved controls INCLUDING the drops, so an arm that quietly lost its
 *    guidance setting is visible as a difference rather than surfacing as an
 *    unexplained render change six cells later.
 * 2. **Out-of-range is a drop, never a clamp.** A profile asking for guidance 40
 *    where the version declares a 0–20 range is a configuration mistake; sending
 *    20 instead would render something nobody configured under a hash that
 *    claims 40 was requested. The spec's "clamp only where the profile
 *    explicitly allows a bounded range" has no such opt-in yet, so the honest
 *    behavior is refusal of the value.
 *
 * Pure: no IO, no environment, no clock. It lives in `src/server/ai` because
 * that is where the spec puts it and where the provider payload is otherwise
 * built, not because it touches a provider.
 */

/** One control that did not reach the payload, and why. */
export interface DroppedImageControl {
  /**
   * WHAT was dropped, named in the vocabulary the caller supplied it in: the
   * NORMALIZED control name (`guidance`) when a normalized control was mapped,
   * and the PROVIDER FIELD name when the thing dropped was itself a provider key
   * — a `providerOverrides` entry, or a mapped value refused for colliding with
   * a reserved field ({@link filterReservedInputFields}). Naming an override's
   * normalized control would be a fabrication (it has none), and naming a
   * reserved collision's normalized control would hide WHICH provider key
   * collided, which is the only actionable half of that report.
   */
  control: string;
  reason: DroppedImageControlReason;
}

/**
 * Why a control or override was dropped.
 *
 * - `no_binding` — the active version exposes no field for this control.
 * - `invalid` — a value the binding's declared type, range, or enum rejects.
 * - `unsupported` — a control this mapper deliberately does not carry yet
 *   (coherent sets, an unresolved LoRA selection); the transport for those is
 *   owned by later capability slices and faking one here would send a field
 *   nobody probed.
 * - `unknown_field` — a provider override naming a key outside the version's
 *   probed `knownInputFields`.
 * - `reserved` — a field the render path owns (prompt, references, aspect,
 *   version, safety enforcement), named by a provider override OR landed on by
 *   a mapped control whose probed binding happens to point at it.
 * - `requires_custom_resolution` — a `width`/`height` request on a render whose
 *   `resolution` is not `custom`. The pair is only ever a request when the tier
 *   says so (`compileProfileRenderPlan`); honoring it beside a named tier would
 *   let leftover dimension defaults outrank the tier the profile asked for.
 */
export type DroppedImageControlReason =
  | "no_binding"
  | "invalid"
  | "unsupported"
  | "unknown_field"
  | "reserved"
  | "requires_custom_resolution";

export interface MapImageRenderControlsInput {
  /** The normalized controls to apply. Absent members are simply not sent. */
  controls: ImageRenderControls;
  /** The ACTIVE version's probed bindings — the only source of field names. */
  capabilities: ImageModelAdvancedCapabilities;
  /**
   * A library LoRA that has ALREADY been resolved against this model, version and
   * task (`resolveImageLoraForRender`).
   *
   * The locator arrives here and nowhere else, because this module cannot make the
   * judgment that produces one: compatibility is a fact about the weights, held in
   * the library, and a mapper that accepted `controls.lora` directly would send a
   * pointer nobody checked. When it is absent and `controls.lora` is set, the
   * selection is unresolved and drops as `unsupported` — see
   * {@link UNSUPPORTED_CONTROLS}.
   */
  resolvedLora?: ResolvedImageLoraControl;
}

/** The three facts a resolved LoRA contributes to a payload. */
export interface ResolvedImageLoraControl {
  id: string;
  /** Sent to the version's `loraWeights` field; NEVER echoed into `applied`. */
  locator: string;
  scale: number;
}

export interface MappedImageRenderControls {
  /** Provider-shaped: real field names to values, ready to merge into the input. */
  input: Record<string, unknown>;
  /** The same values keyed by NORMALIZED name — what a caller reports and stores. */
  applied: Record<string, unknown>;
  /**
   * For each `applied` key, the provider field(s) its value was written to.
   * This is what lets a later reserved-field filter keep the normalized record
   * consistent with the payload it filtered: when a field is refused there, the
   * caller can find and remove the applied entry that claimed it was sent,
   * without a second copy of the alias table.
   */
  appliedFields: Record<string, string[]>;
  dropped: DroppedImageControl[];
}

/**
 * The controls this mapper does not carry, with the reason each is out of scope.
 *
 * `coherentSet` belongs to the image-set path, which is parked — no slice owns
 * a transport for it, and faking one here would send a field nobody probed.
 * Listing it explicitly, rather than letting it fall through as `no_binding`,
 * keeps "this version has no field" distinct from "Vesper does not send this".
 *
 * `seed` left this list with the reproducibility slice: it now maps through the
 * version's probed `seed` binding like any other requested control, with the
 * randomness resolved by the CALLER (`renderImageIntent`) so this module stays
 * pure.
 *
 * `lora` left it when the library shipped, but only halfway: what this mapper
 * carries is a RESOLVED LoRA ({@link MapImageRenderControlsInput.resolvedLora}),
 * never a raw `controls.lora` selection. An unresolved selection still drops as
 * `unsupported`, because a selection is a request for a library row and this
 * module has no library to check it against — sending its id, or guessing a
 * locator from it, is exactly the fabrication the drop is there to prevent.
 */
const UNSUPPORTED_CONTROLS = ["coherentSet"] as const;

/**
 * Map normalized controls onto one version's declared input fields.
 *
 * The traversal is over an explicit list of (control, binding slot) pairs rather
 * than over the value object's keys: a control the caller supplies that this
 * function has no case for must be a compile error here, not a value that
 * silently disappears from the payload with no drop entry to show for it.
 */
export function mapImageRenderControls(input: MapImageRenderControlsInput): MappedImageRenderControls {
  const { controls, capabilities } = input;
  const bindings = capabilities.controls;
  const result: MappedImageRenderControls = { input: {}, applied: {}, appliedFields: {}, dropped: [] };

  for (const control of UNSUPPORTED_CONTROLS) {
    if (controls[control] !== undefined) result.dropped.push({ control, reason: "unsupported" });
  }

  // After the list above so the drop order stays coherentSet, lora, then the
  // requested rows — the order a reader of a stored `droppedControls` array has
  // seen since the unsupported list existed. (`seed` moved into the requested
  // rows with its transport; no stored array carries a seed drop from before,
  // because nothing could request one.)
  if (input.resolvedLora) mapResolvedLora(result, input.resolvedLora, bindings);
  else if (controls.lora !== undefined) result.dropped.push({ control: "lora", reason: "unsupported" });

  const requested: { control: string; value: unknown; binding: ImageInputBinding | undefined }[] = [
    { control: "seed", value: controls.seed, binding: bindings.seed },
    { control: "negativePrompt", value: controls.negativePrompt, binding: bindings.negativePrompt },
    { control: "guidance", value: controls.guidance, binding: bindings.guidance },
    { control: "steps", value: controls.steps, binding: bindings.steps },
    { control: "editStrength", value: controls.editStrength, binding: bindings.editStrength },
    { control: "outputCount", value: controls.outputCount, binding: bindings.outputCount },
    { control: "thinkingMode", value: controls.thinkingMode, binding: bindings.thinkingMode },
    { control: "resolution", value: controls.resolution, binding: bindings.resolutionTier },
    { control: "width", value: controls.width, binding: bindings.customWidth },
    { control: "height", value: controls.height, binding: bindings.customHeight },
  ];

  for (const entry of requested) {
    if (entry.value === undefined) continue;
    if (!entry.binding) {
      result.dropped.push({ control: entry.control, reason: "no_binding" });
      continue;
    }
    if (!bindingAccepts(entry.binding, entry.value)) {
      result.dropped.push({ control: entry.control, reason: "invalid" });
      continue;
    }
    result.input[entry.binding.field] = entry.value;
    result.applied[entry.control] = entry.value;
    result.appliedFields[entry.control] = [entry.binding.field];
  }

  return result;
}

/**
 * Write a resolved LoRA's two provider fields, or record ONE drop explaining why
 * neither went.
 *
 * The pair is all-or-nothing. A locator with no scale beside it runs at whatever
 * strength the model defaults to, which is a different render from the one the
 * library authorized and the record claims — so a version missing either binding
 * takes the whole LoRA out, once, under the control name the caller asked in
 * (`lora`) rather than twice under two field names.
 *
 * `applied` gets the id and the scale and NEVER the locator: `applied` is what a
 * caller stores and reports, and a signed URL's query string has no business in a
 * saved record (spec §`image_loras`).
 */
function mapResolvedLora(
  result: MappedImageRenderControls,
  lora: ResolvedImageLoraControl,
  bindings: ImageModelControlBindings,
): void {
  const weights = bindings.loraWeights;
  const scale = bindings.loraScale;
  if (!weights || !scale) {
    result.dropped.push({ control: "lora", reason: "no_binding" });
    return;
  }
  if (!bindingAccepts(weights, lora.locator) || !bindingAccepts(scale, lora.scale)) {
    result.dropped.push({ control: "lora", reason: "invalid" });
    return;
  }
  result.input[weights.field] = lora.locator;
  result.input[scale.field] = lora.scale;
  result.applied.lora = { id: lora.id, scale: lora.scale };
  result.appliedFields.lora = [weights.field, scale.field];
}

/**
 * Whether one value satisfies the binding the version declared.
 *
 * `integer` and `number` are checked apart because they are not interchangeable
 * at the provider: a model declaring `num_inference_steps` as an integer rejects
 * a fractional value outright rather than rounding it.
 *
 * An `enum` binding with no `enumValues` fails CLOSED. Absent bounds mean "the
 * provider did not declare one" everywhere else in this contract, but for an
 * enum that leaves no way to tell a member from a typo, and a typo'd enum value
 * is a provider validation error at spend time.
 */
function bindingAccepts(binding: ImageInputBinding, value: unknown): boolean {
  switch (binding.type) {
    case "string":
      return typeof value === "string" && withinEnum(binding, value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && withinRange(binding, value);
    case "number":
      return typeof value === "number" && Number.isFinite(value) && withinRange(binding, value);
    case "enum":
      return typeof value === "string" && binding.enumValues !== undefined && binding.enumValues.includes(value);
  }
}

function withinEnum(binding: ImageInputBinding, value: string): boolean {
  return binding.enumValues === undefined || binding.enumValues.includes(value);
}

function withinRange(binding: ImageInputBinding, value: number): boolean {
  if (binding.minimum !== undefined && value < binding.minimum) return false;
  if (binding.maximum !== undefined && value > binding.maximum) return false;
  return true;
}

export interface FilteredImageInputFields {
  input: Record<string, unknown>;
  dropped: DroppedImageControl[];
}

/**
 * Remove the render-path-owned fields from an already provider-shaped payload,
 * recording each removal.
 *
 * This is the gap `validateProviderOverrides` does not close. Overrides are the
 * obvious way a stored row reaches a reserved field, but they are not the only
 * one: a MAPPED control lands on whatever field the version's probe declared for
 * it, and those declarations genuinely collide — a model whose shape input is
 * `size` reserves that key, while `resolutionTier` is commonly probed as `size`
 * too. Left unfiltered, the mapped value would travel to the provider, be
 * discarded by the render path's own overlay, and appear in the trial's
 * `controlInput` hash as a control that was sent when it never was.
 *
 * Dropping it HERE, before it enters the payload a comparison fingerprints, is
 * what keeps "what is hashed is what is sent" true. The alternative — letting
 * the transport silently discard it — produces two arms whose recorded
 * configurations differ and whose actual renders do not.
 */
export function filterReservedInputFields(
  input: Record<string, unknown>,
  reservedFields: readonly string[],
): FilteredImageInputFields {
  const reserved = new Set(reservedFields);
  const result: FilteredImageInputFields = { input: {}, dropped: [] };
  for (const field of Object.keys(input).sort()) {
    if (reserved.has(field)) result.dropped.push({ control: field, reason: "reserved" });
    else result.input[field] = input[field];
  }
  return result;
}

export interface ValidatedProviderOverrides {
  input: Record<string, unknown>;
  dropped: DroppedImageControl[];
}

/**
 * Validate a profile's raw `providerOverrides` against one version's probed
 * field list. The escape hatch, kept from becoming a second configuration
 * system.
 *
 * Two rules, in this order:
 *
 * 1. **Reserved fields are refused first.** The prompt field, the reference
 *    field, the aspect field, the version, and the safety toggle are owned by
 *    the render path. An override reaching one of them would let a stored
 *    profile row redirect where the prompt goes or switch safety enforcement off
 *    — which is why the reserved names are passed in from the model row rather
 *    than pattern-matched here: only the images layer knows what THIS model
 *    calls its reference and aspect fields.
 * 2. **An empty `knownInputFields` rejects everything.** Empty means the probe
 *    has recorded nothing, and reading "nothing recorded" as permission is how
 *    an unprobed row would start forwarding arbitrary keys to a provider that
 *    rejects unknown inputs. Fail closed; every override drops with a reason.
 */
export function validateProviderOverrides(
  overrides: Record<string, unknown>,
  knownInputFields: readonly string[],
  reservedFields: readonly string[],
): ValidatedProviderOverrides {
  const known = new Set(knownInputFields);
  const reserved = new Set(reservedFields);
  const result: ValidatedProviderOverrides = { input: {}, dropped: [] };

  for (const field of Object.keys(overrides).sort()) {
    if (reserved.has(field)) {
      result.dropped.push({ control: field, reason: "reserved" });
      continue;
    }
    if (!known.has(field)) {
      result.dropped.push({ control: field, reason: "unknown_field" });
      continue;
    }
    result.input[field] = overrides[field];
  }
  return result;
}
