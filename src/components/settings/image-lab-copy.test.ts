import { describe, expect, it } from "vitest";
import { imageLabDiagnosticCode, imageLabFailureCodes } from "@/contracts";
import { imageLabFailureExplanation } from "./image-lab-copy";

/**
 * A settled experiment's `failureCode` reaches this function in the dotted form
 * the runner stored, so the pairing with the contract's reader is what decides
 * whether an admin sees the sentence or the identifier behind it.
 */

describe("imageLabFailureExplanation", () => {
  it("explains a stored dotted lab code in English", () => {
    expect(imageLabFailureExplanation("image_lab.version_unpinned")).toBe(
      "The model's exact provider version could not be identified. The run was refused before any spend — evidence rendered against an unknown version answers nothing.",
    );
  });

  it("explains every lab code without leaking its identifier", () => {
    for (const code of imageLabFailureCodes) {
      const copy = imageLabFailureExplanation(imageLabDiagnosticCode(code));
      expect(copy).not.toBe(imageLabDiagnosticCode(code));
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  // The render classifier's codes are a separate vocabulary — better raw than
  // translated into a lab reason that did not happen.
  it("passes a code outside the lab's vocabulary through verbatim", () => {
    expect(imageLabFailureExplanation("provider_timeout")).toBe("provider_timeout");
  });
});
