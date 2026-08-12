import type { ImageModel } from "../models/image-models";

/**
 * The input fields the render path owns, which nothing merged later may write.
 *
 * This is the one spelling of that set, shared by the transport's `controlInput`
 * overlay and by the compile step's `providerOverrides` validation — two copies
 * would be two answers to "may a profile redirect the prompt?", and the copy
 * nobody edits is the one that eventually says yes.
 *
 * `prompt`, the reference field and the aspect key are structural: they are what
 * the payload builder writes, and an override reaching one of them would send
 * the render somewhere the caller did not compile. `version` is never an input
 * key at all, but naming it here keeps a stored profile from looking like it can
 * repin the model. `disable_safety_checker` is the safety enforcement the
 * deployment owns; a database row must not be able to flip it.
 *
 * It lives here rather than with the Replicate transport because it is a pure
 * calculation over a model's own declared fields — the transport reads the
 * answer, it does not decide it.
 */
export function reservedImageInputFields(model: ImageModel): string[] {
  const fields = new Set<string>([
    "prompt",
    model.referenceField,
    model.aspectMode === "size" ? "size" : "aspect_ratio",
    "version",
    "disable_safety_checker",
  ]);
  const probedPromptField = model.advancedCapabilities.prompt?.field;
  if (probedPromptField) fields.add(probedPromptField);
  return [...fields];
}
