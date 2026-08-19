import type { PortraitVariantKind } from "@/contracts/images/portrait-variant";

/** Portrait-variant prompts: the identity lock and the variant instructions. */

// ---------------------------------------------------------------------------
// Portrait variants (reference edit)
// ---------------------------------------------------------------------------

/** Ported from the old app's portrait-regen prompt builder (docs/images/pipelines.md §Portrait variants). */
export const PORTRAIT_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

/** The kinds are one contract now; this alias keeps the server's own name for them. */
export type VariantKind = PortraitVariantKind;

/** Re-exported so the render lane names the bench kind rather than a bare string. */
export const NSFW_TEST_VARIANT_KIND: VariantKind = "nsfw_test";

const VARIANT_FRAMING: Record<VariantKind, string> = {
  pose: "Change the pose",
  outfit: "Change the outfit",
  expression: "Change the facial expression",
  setting: "Change the background and setting",
  // Deliberately open: the bench kind exists to render whatever the owner types,
  // and a narrower verb ("change the pose") would fight an instruction that
  // restages the whole shot.
  nsfw_test: "Restage the subject",
};

/**
 * The kinds that must NOT carry "keep the same outfit".
 *
 * `outfit` because changing it is the whole request, and `nsfw_test` because the
 * typed instruction owns clothing there — a sentence pinning the reference's
 * outfit would contradict an instruction that undresses the subject, and the
 * model resolves that contradiction by rendering neither request faithfully.
 */
const KINDS_WITHOUT_OUTFIT_LOCK: ReadonlySet<VariantKind> = new Set<VariantKind>(["outfit", NSFW_TEST_VARIANT_KIND]);

export interface VariantInstructionOptions {
  /**
   * `apparentAgeAnchor` (owner ruling 2026-07-29): without it a variant edit
   * "preserves" the model's own over-read of the reference's age, so every
   * pose-editor generation bakes another step of drift into the portrait line.
   */
  ageAnchor?: string;
  /**
   * The character sheet's intimate anatomy (`intimateAnatomySummary`), stated
   * only for the `nsfw_test` kind. It rides as its own sentence rather than
   * inside the instruction so the LoRA is describing the SHEET's body while the
   * owner's words describe the shot — the same division the chat scene lane uses
   * between its reveal line and its staging sentence.
   */
  anatomy?: string;
}

/** Compose one variant edit instruction: identity lock, age anchor, the change, then quality. */
export function buildVariantInstruction(
  kind: VariantKind,
  instruction: string,
  options: VariantInstructionOptions = {},
): string {
  const change = `${VARIANT_FRAMING[kind]}: ${instruction.trim().replace(/\.+$/, "")}.`;
  const keepOutfit = KINDS_WITHOUT_OUTFIT_LOCK.has(kind) ? "" : "Keep the same outfit as the reference image.";
  const anatomy = kind === NSFW_TEST_VARIANT_KIND && options.anatomy ? `Anatomy: ${options.anatomy}.` : "";
  return [PORTRAIT_IDENTITY_LOCK, options.ageAnchor ?? "", change, anatomy, keepOutfit, "Soft flattering lighting, high quality, no text, no watermark."]
    .filter(Boolean)
    .join(" ");
}
