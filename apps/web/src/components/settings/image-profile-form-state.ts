import type { ImageControlDefaults, ImageResolutionTier, ImageSeedPolicy } from "@vesper/image-core";

/**
 * The profile editor's control fields, in both directions — the row's
 * `control_defaults` read INTO the form, and the form read back OUT into the
 * column the save replaces.
 *
 * Pure and separate from the component for one reason: `updateImageModelProfile`
 * writes `control_defaults` with `.set(request)`, a whole-column replace, so a
 * control this form cannot say is a control an untouched Save DELETES. While a
 * transitional overlay re-applied Vesper's reviewed settings at the render
 * boundary that was invisible; with the task profile as their one owner (#244)
 * it is the difference between an identity-critical Qwen Edit render staying
 * unaccelerated and silently shipping the provider's speed preset — no drop, no
 * refusal, nothing in the run's own record to read.
 *
 * So the two directions live side by side, as one list, and
 * `image-profile-form-state.test.ts` round-trips every member the form supports.
 *
 * One property to know: a blank field CLEARS its control, which is what makes
 * "unset this" expressible at all. That leaves "send an empty value" with no
 * spelling of its own, and one control genuinely needs it — `negativePrompt: ""`
 * is how the Pony wrapper's hidden `"nsfw, naked"` default is cleared, and a
 * reviewed ruling is stored in exactly that value. So the negative prompt has a
 * companion flag: blank text plus the flag is the empty string, blank text
 * without it is unset, and any text at all is the text.
 */

/** A tri-state boolean field: blank leaves the control unset. */
export type ImageProfileBooleanField = "" | "on" | "off";

/** Every control field the editor holds, as the strings its inputs carry. */
export interface ImageProfileControlForm {
  seedPolicy: ImageSeedPolicy;
  guidance: string;
  steps: string;
  negativePrompt: string;
  /** Blank text plus this flag sends an empty string, rather than leaving the control unset. */
  clearNegativePrompt: boolean;
  editStrength: string;
  resolution: "" | ImageResolutionTier;
  width: string;
  height: string;
  /** The profile's intended output shape as a `W:H` spelling, or blank for the lane's own default (#247). */
  aspectRatio: string;
  fastMode: ImageProfileBooleanField;
  thinkingMode: ImageProfileBooleanField;
  loraId: string;
  loraScale: string;
}

/** The numeric fields after the form's own parse, absent when left blank. */
export interface ImageProfileControlNumbers {
  guidance?: number;
  steps?: number;
  editStrength?: number;
  width?: number;
  height?: number;
  loraScale?: number;
}

/** A stored row's control defaults, as the form's initial state. */
export function imageProfileControlForm(defaults: ImageControlDefaults | undefined): ImageProfileControlForm {
  return {
    seedPolicy: defaults?.seedPolicy ?? "random",
    guidance: numberField(defaults?.guidance),
    steps: numberField(defaults?.steps),
    negativePrompt: defaults?.negativePrompt ?? "",
    clearNegativePrompt: defaults?.negativePrompt === "",
    editStrength: numberField(defaults?.editStrength),
    resolution: defaults?.resolution ?? "",
    width: numberField(defaults?.width),
    height: numberField(defaults?.height),
    aspectRatio: defaults?.aspectRatio ?? "",
    fastMode: booleanField(defaults?.fastMode),
    thinkingMode: booleanField(defaults?.thinkingMode),
    loraId: defaults?.lora?.id ?? "",
    loraScale: numberField(defaults?.lora?.scale),
  };
}

/**
 * The form's state as the `control_defaults` column the save writes.
 *
 * Every control is omitted when its field is blank, so the column carries only
 * what the editor actually says — the profile schema reads an absent member as
 * "this profile expresses no opinion", and a `null`-shaped member would be a
 * second spelling of the same thing.
 */
export function imageProfileControlDefaults(
  form: ImageProfileControlForm,
  numbers: ImageProfileControlNumbers,
): ImageControlDefaults {
  return {
    seedPolicy: form.seedPolicy,
    ...(numbers.guidance === undefined ? {} : { guidance: numbers.guidance }),
    ...(numbers.steps === undefined ? {} : { steps: numbers.steps }),
    ...negativePromptDefault(form),
    ...(numbers.editStrength === undefined ? {} : { editStrength: numbers.editStrength }),
    ...(form.resolution === "" ? {} : { resolution: form.resolution }),
    ...(numbers.width === undefined ? {} : { width: numbers.width }),
    ...(numbers.height === undefined ? {} : { height: numbers.height }),
    ...(form.aspectRatio === "" ? {} : { aspectRatio: form.aspectRatio }),
    // `fastMode` is a tri-state rather than a checkbox because BOTH of its
    // values are requests: the wrappers that expose it default it ON, so "do
    // not accelerate" has to travel as a value while "say nothing" stays blank.
    ...(form.fastMode === "" ? {} : { fastMode: form.fastMode === "on" }),
    ...(form.thinkingMode === "" ? {} : { thinkingMode: form.thinkingMode === "on" }),
    ...(form.loraId === ""
      ? {}
      : { lora: { id: form.loraId, ...(numbers.loraScale === undefined ? {} : { scale: numbers.loraScale }) } }),
  };
}

/**
 * The negative prompt's three states, in precedence order: any text is the
 * value, blank text with the flag is the deliberate empty string, and blank
 * text alone leaves the control unset.
 *
 * Text wins over the flag rather than refusing the pair, because the two can
 * only disagree while an admin is mid-edit — typing into a field whose flag was
 * set for the row it was seeded from — and the text in front of them is the
 * clearer statement of intent.
 */
function negativePromptDefault(form: ImageProfileControlForm): { negativePrompt?: string } {
  const text = form.negativePrompt.trim();
  if (text !== "") return { negativePrompt: text };
  return form.clearNegativePrompt ? { negativePrompt: "" } : {};
}

function numberField(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function booleanField(value: boolean | undefined): ImageProfileBooleanField {
  return value === undefined ? "" : value ? "on" : "off";
}
