import { baseImageModelSlug, resolveImageLoraBindingPair, type ImageLora, type ImageModel } from "@vesper/image-core";
import { imageModelProvider, type ImageModelProvider } from "@vesper/image-models";

const PROVIDER_LABELS: Record<ImageModelProvider, string> = {
  civitai: "Civitai",
  fal: "Fal.ai",
  replicate: "Replicate",
};

/**
 * The registry label owns the model's name. Remove only presentation suffixes
 * that repeat the use/provider badge; never derive an invented name from a slug
 * or replace the operator's curated label with adapter-family text.
 */
export function imageModelOptionName(model: ImageModel): string {
  let name = model.label.trim();
  name = name.replace(/\s+[—–-]\s+(?:Text to Image|Edit|LoRA)$/i, "");
  name = name.replace(/\s+\((?:Civitai|Replicate|Fal(?:\.ai)?)\s+LoRA\)$/i, "");
  if (
    resolveImageLoraBindingPair(
      model.advancedCapabilities.controls.loraWeights,
      model.advancedCapabilities.controls.loraScale,
    ) !== null
  ) {
    name = name.replace(/\s+LoRA$/i, "");
  }
  return name;
}

/** One use marker per model: a usable LoRA binding, then editing, then generation. */
export function imageModelOptionLabel(model: ImageModel): string {
  const controls = model.advancedCapabilities.controls;
  const use =
    resolveImageLoraBindingPair(controls.loraWeights, controls.loraScale) !== null
      ? "LoRA"
      : model.canEdit
        ? "Edit"
        : model.canGenerate
          ? "TTS"
          : "Unknown";
  return `${imageModelOptionName(model)} (${use}) - ${PROVIDER_LABELS[imageModelProvider(model.slug)]}`;
}

/**
 * A curated LoRA's own label may start with its compatible model's name.
 * In a model-scoped picker, that repeated prefix hides the useful weights name.
 * Keep the library record, option id and compatibility rules untouched.
 */
export function imageLoraOptionLabel(lora: ImageLora, models: readonly ImageModel[]): string {
  const label = lora.label.trim();
  const compatibleNames = models
    .filter((model) => lora.compatibleModelSlugs.includes(baseImageModelSlug(model.slug)))
    .flatMap((model) => {
      const name = imageModelOptionName(model);
      // A Base-LoRA endpoint may share the family name with weights that are
      // not themselves labeled "Base" (the seeded FLUX.2 RefControl LoRA).
      const familyName = name.replace(/\s+Base$/i, "");
      return familyName === name ? [name] : [name, familyName];
    })
    .sort((left, right) => right.length - left.length);
  for (const name of compatibleNames) {
    if (label.toLocaleLowerCase().startsWith(`${name.toLocaleLowerCase()} `)) {
      const remainder = label.slice(name.length).trim();
      if (remainder.length > 0) return remainder;
    }
  }
  return label;
}
