/** Portrait-variant prompts: the identity lock and the four variant instructions. */

// ---------------------------------------------------------------------------
// Portrait variants (reference edit)
// ---------------------------------------------------------------------------

/** Ported from the old app's portrait-regen prompt builder (docs/images/pipelines.md §Portrait variants). */
export const PORTRAIT_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

export type VariantKind = "pose" | "outfit" | "expression" | "setting";

const VARIANT_FRAMING: Record<VariantKind, string> = {
  pose: "Change the pose",
  outfit: "Change the outfit",
  expression: "Change the facial expression",
  setting: "Change the background and setting",
};

/**
 * `ageAnchor` (apparentAgeAnchor, owner ruling 2026-07-29): without it a variant
 * edit "preserves" the model's own over-read of the reference's age, so every
 * pose-editor generation bakes another step of drift into the portrait line.
 */
export function buildVariantInstruction(kind: VariantKind, instruction: string, ageAnchor?: string): string {
  const change = `${VARIANT_FRAMING[kind]}: ${instruction.trim().replace(/\.+$/, "")}.`;
  const keepOutfit = kind === "outfit" ? "" : "Keep the same outfit as the reference image.";
  return [PORTRAIT_IDENTITY_LOCK, ageAnchor ?? "", change, keepOutfit, "Soft flattering lighting, high quality, no text, no watermark."]
    .filter(Boolean)
    .join(" ");
}
