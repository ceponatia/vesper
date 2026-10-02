import { describe, expect, it } from "vitest";
import { IMAGE_LORA_INCOMPATIBLE, IMAGE_LORA_UNREACHABLE } from "@vesper/image-core";
import { imageGeneratorDiagnosticCode, imageGeneratorFailureCodes } from "@/contracts/images/image-generator";
import {
  imageGeneratorFailureExplanation,
  imageGeneratorRecoverableHint,
  imageGeneratorRecoverActionLabel,
  imageGeneratorRecoverFailedTitle,
  imageGeneratorRecoveredToast,
} from "./image-generator-copy";

/**
 * A settled run's `failureCode` is stored in dotted diagnostic form
 * (`image_generator.…`), so the copy module's reader must unwrap exactly what
 * {@link imageGeneratorDiagnosticCode} wraps — the pairing is what decides
 * whether the admin sees the sentence or the identifier behind it. Killed
 * defect: a prefix drift between the two, which would pass every type check
 * and put raw codes in front of the person reading why a paid run stopped
 * (the lab copy suite's precedent).
 */
describe("imageGeneratorFailureExplanation", () => {
  it("explains every generator code, stored dotted, without leaking its identifier", () => {
    for (const code of imageGeneratorFailureCodes) {
      const copy = imageGeneratorFailureExplanation(imageGeneratorDiagnosticCode(code));
      expect(copy).not.toBe(imageGeneratorDiagnosticCode(code));
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  // The LoRA library refuses in its own namespace and the code settles onto
  // the row verbatim; each must land as a sentence, and a different one — the
  // two refusals send an operator to two different screens.
  it("explains the LoRA library's two refusals distinctly", () => {
    for (const code of [IMAGE_LORA_INCOMPATIBLE, IMAGE_LORA_UNREACHABLE]) {
      const copy = imageGeneratorFailureExplanation(code);
      expect(copy).not.toBe(code);
      expect(copy.length).toBeGreaterThan(20);
    }
    expect(imageGeneratorFailureExplanation(IMAGE_LORA_INCOMPATIBLE)).not.toBe(
      imageGeneratorFailureExplanation(IMAGE_LORA_UNREACHABLE),
    );
  });

  // Shared-layer codes (`image_profile.*`, the render classifier's) are a
  // separate vocabulary — better raw than translated into a generator reason
  // that did not happen.
  it("passes a code outside the generator's vocabulary through verbatim", () => {
    expect(imageGeneratorFailureExplanation("image_profile.control_unsupported")).toBe(
      "image_profile.control_unsupported",
    );
  });
});

/**
 * A failed output's recoverable copy (#682/#686) reads from `output.recoverable`
 * alone — never from a failure code — so it must never collide with any of the
 * ordinary failure explanations above: a tile showing the wrong one would tell
 * the admin a dead offer is still live, or hide a live one behind a generic
 * failure sentence.
 */
describe("the recoverable output's own copy", () => {
  it("is a real sentence, distinct from every ordinary failure explanation", () => {
    expect(imageGeneratorRecoverableHint.length).toBeGreaterThan(20);
    expect(imageGeneratorRecoverActionLabel.length).toBeGreaterThan(0);
    expect(imageGeneratorRecoverFailedTitle.length).toBeGreaterThan(0);
    expect(imageGeneratorRecoveredToast.title.length).toBeGreaterThan(0);
    for (const code of imageGeneratorFailureCodes) {
      const explanation = imageGeneratorFailureExplanation(imageGeneratorDiagnosticCode(code));
      expect(explanation).not.toBe(imageGeneratorRecoverableHint);
    }
  });
});
