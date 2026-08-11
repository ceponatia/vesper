import { describe, expect, it } from "vitest";
import {
  IMAGE_LORA_INCOMPATIBLE,
  IMAGE_LORA_UNREACHABLE,
  imageLabDiagnosticCode,
  imageLabExperimentKinds,
  imageLabFailureCodes,
  imageLabOutcomeDropReasons,
  imageLabVerdictOptions,
  imageLabVerdicts,
} from "@/contracts";
import {
  imageLabDropReasonExplanation,
  imageLabFailureExplanation,
  imageLabVerdictChip,
  imageLabVerdictHint,
  imageLabVerdictLabel,
} from "./image-lab-copy";

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

  // The LoRA library refuses in its own namespace and the code settles onto the
  // row verbatim, so these two would fall through the lab's reader into the
  // pass-through branch below — an operator reading `image_lora.incompatible`
  // off a failed pass with no sentence beside it.
  it("explains the LoRA library's two refusals, and sends each somewhere different", () => {
    for (const code of [IMAGE_LORA_INCOMPATIBLE, IMAGE_LORA_UNREACHABLE]) {
      const copy = imageLabFailureExplanation(code);
      expect(copy).not.toBe(code);
      expect(copy.length).toBeGreaterThan(20);
    }
    expect(imageLabFailureExplanation(IMAGE_LORA_INCOMPATIBLE)).not.toBe(
      imageLabFailureExplanation(IMAGE_LORA_UNREACHABLE),
    );
  });

  // The render classifier's codes are a separate vocabulary — better raw than
  // translated into a lab reason that did not happen.
  it("passes a code outside the lab's vocabulary through verbatim", () => {
    expect(imageLabFailureExplanation("provider_timeout")).toBe("provider_timeout");
  });
});

/**
 * A recorded outcome's dropped references reach the detail with the planner's
 * own reason codes on them; each must land as a sentence, not an identifier,
 * because the reader is deciding whether to trust the ordered inputs.
 */
describe("imageLabDropReasonExplanation", () => {
  it("explains every recorded drop reason without leaking its identifier", () => {
    for (const reason of imageLabOutcomeDropReasons) {
      const copy = imageLabDropReasonExplanation(reason);
      expect(copy).not.toBe(reason);
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  it("names the capacity trim as recorded, not hidden", () => {
    expect(imageLabDropReasonExplanation("model_capacity")).toContain("recorded");
  });
});

/**
 * The verdict copy spans two vocabularies now, and the reviewer is choosing
 * between them from these words alone — a ruling offered as a bare identifier,
 * or offered with the wrong hint, is a misfiled ruling.
 */
describe("verdict copy", () => {
  it("names every ruling in both vocabularies, and hints at each", () => {
    for (const verdict of imageLabVerdicts) {
      expect(imageLabVerdictLabel(verdict)).not.toBe(verdict);
      expect(imageLabVerdictHint(verdict).length).toBeGreaterThan(20);
      // The chip is a space-constrained badge, so "inconclusive" is legitimately
      // its own best label; what it must never be is empty.
      expect(imageLabVerdictChip(verdict).label.length).toBeGreaterThan(0);
    }
  });

  it("gives every ruling a distinct label, so two options never read alike", () => {
    const labels = imageLabVerdicts.map(imageLabVerdictLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("covers whatever each kind may actually offer", () => {
    for (const kind of imageLabExperimentKinds) {
      for (const verdict of imageLabVerdictOptions(kind) ?? []) {
        expect(imageLabVerdictLabel(verdict).length).toBeGreaterThan(0);
      }
    }
  });

  it("marks the one promotable finishing ruling as good news and the over-reach as bad", () => {
    expect(imageLabVerdictChip("improves_identity").tone).toBe("ok");
    expect(imageLabVerdictChip("changes_beyond_identity").tone).toBe("danger");
  });
});
