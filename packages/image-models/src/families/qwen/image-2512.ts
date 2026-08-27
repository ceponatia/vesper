import { defineImageModel, type ImageModelAdapter } from "../../composer";
import {
  aspectRatioFeature,
  fastModeFeature,
  guidanceFeature,
  outputFormatFeature,
  outputQualityFeature,
  promptFeature,
  safetyToggleFeature,
  seedFeature,
} from "../../features";
import { QWEN_IMAGE_FAMILY } from "./shared";

/**
 * `qwen/qwen-image-2512` — the family's GENERATOR arm
 * (`docs/image-models/models/qwen-image-2512.md`).
 *
 * Text-to-image, and Vesper's default for a brand-new portrait. Its optional
 * reference input is strength-based image-to-image — a deliberate remix, where
 * the subject is an input to the noise rather than something preserved — not
 * the identity-preserving instruction edit its edit-family siblings perform.
 * That is why it composes neither the numbered-reference dialect nor the
 * multi-reference feature: it takes a single reference, and there is nothing
 * numbered to address.
 *
 * **No negative-prompt feature, deliberately.** The endpoint declares a
 * negative field and does not act on it — Vesper measured this directly, and a
 * render asked for a red apple with the apple in the negative field kept the
 * apple in 16 of 16 paired renders across both sampling paths; upstream
 * reporting gives the mechanism, which is that the model was never trained on
 * negative conditioning and the parameter exists for pipeline compatibility
 * (`docs/image-models/models/qwen-image-2512.md` §"Negative-prompt ruling").
 * Composing the feature
 * would make this endpoint claim a capability whose only effect is that
 * exclusions vanish where nobody can see them. The positive channel is the only
 * one that steers here, and every exclusion that matters has to be written as
 * an affirmative claim about what the picture should contain.
 *
 * It does take a guidance strength, which its edit-family siblings do not. It
 * shares their accelerated sampling path, and here the trade is the caller's to
 * make either way: this row carries no reviewed correction turning it off, so
 * both asking for speed and refusing it are things a run has to be able to say.
 */
export const qwenImage2512: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: [
    promptFeature(),
    aspectRatioFeature(),
    seedFeature(),
    guidanceFeature(),
    fastModeFeature(),
    outputFormatFeature(),
    outputQualityFeature(),
    safetyToggleFeature(),
  ],
});
