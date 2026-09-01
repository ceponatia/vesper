import { describe, expect, it } from "vitest";
import {
  IMAGE_LORA_INCOMPATIBLE,
  IMAGE_LORA_UNREACHABLE,
  imageLabDiagnosticCode,
  imageLabExperimentKinds,
  imageLabFailureCodes,
  imageLabOutcomeDropReasons,
  imageLabStagedSceneVerdicts,
  imageLabSubjectFactsModes,
  imageLabTwoCharacterVerdicts,
  imageLabVerdictOptions,
  imageLabVerdicts,
} from "@vesper/image-core";
import { sceneStagingList } from "@/contracts/images/scene-staging";
import {
  imageLabDropReasonExplanation,
  imageLabExperimentKindDescription,
  imageLabExperimentKindLabel,
  imageLabFailureExplanation,
  imageLabStagingBareSummary,
  imageLabStagingCameraSummary,
  imageLabStagingOptionLabel,
  imageLabStagingViewerPartsSummary,
  imageLabSubjectFactsHint,
  imageLabSubjectFactsLabel,
  imageLabVerdictChip,
  imageLabVerdictHint,
  imageLabVerdictLabel,
} from "./image-lab-copy";

/**
 * The kind vocabulary is what the create form's select and its hint are built
 * from, and a kind reaching either as a bare identifier is an admin choosing a
 * run from a code name.
 */
describe("experiment kind copy", () => {
  it("names and explains every declared kind", () => {
    for (const kind of imageLabExperimentKinds) {
      expect(imageLabExperimentKindLabel(kind)).not.toBe(kind);
      expect(imageLabExperimentKindDescription(kind).length).toBeGreaterThan(40);
    }
  });

  it("gives every kind a distinct label and a distinct description", () => {
    const labels = imageLabExperimentKinds.map(imageLabExperimentKindLabel);
    expect(new Set(labels).size).toBe(labels.length);
    const descriptions = imageLabExperimentKinds.map(imageLabExperimentKindDescription);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

/**
 * The staging select is the only picker on the bench whose options are registry
 * data rather than stored rows, so these summaries are all that separates two
 * acts an admin is choosing between — and the id has to survive into the label,
 * because the id is what the created row records and what a ruling cites.
 */
describe("staging copy", () => {
  const intimate = sceneStagingList.filter((staging) => staging.intimate);

  it("has intimate stagings to offer at all", () => {
    expect(intimate.length).toBeGreaterThan(0);
  });

  it("labels every intimate staging with its own id and its camera", () => {
    for (const staging of intimate) {
      const label = imageLabStagingOptionLabel(staging);
      expect(label).toContain(staging.id);
      expect(label).toContain(imageLabStagingCameraSummary(staging.camera));
      // Two entries differing only by orientation must not read alike.
      expect(label).toContain(staging.camera.orientation.replaceAll("_", " "));
    }
  });

  it("gives every intimate staging a distinct option label", () => {
    const labels = intimate.map(imageLabStagingOptionLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names the regions a staging needs bare, and says whose when it needs none", () => {
    for (const staging of intimate) {
      const summary = imageLabStagingBareSummary(staging);
      expect(summary.length).toBeGreaterThan(0);
      for (const region of staging.requiresBare) expect(summary).toContain(region);
    }
    // The two oral compositions need nothing of the SUBJECT bared — the anatomy
    // the shot needs is the viewer's — so the empty case must not read as
    // "clothed", which would send an admin looking for a bug in the exposure.
    const noSubjectExposure = intimate.filter((staging) => staging.requiresBare.length === 0);
    expect(noSubjectExposure.length).toBeGreaterThan(0);
    for (const staging of noSubjectExposure) {
      expect(imageLabStagingBareSummary(staging)).toContain("subject");
      // ...and the viewer parts line is where that exposure requirement actually
      // lands, so it must be saying something.
      expect(imageLabStagingViewerPartsSummary(staging)).not.toBe("none");
    }
  });
});

/**
 * The staged bench's two subject-facts arms produce measurably different
 * prompts, and the operator picks between them from these words alone. The one
 * thing this copy must never do is present them as two equally ordinary styles:
 * `reference_only` is a deliberately reduced run whose result is meaningless on
 * its own, and an option that did not say so would be picked by accident.
 */
describe("subject-facts copy", () => {
  it("names and explains every arm without leaking its identifier", () => {
    for (const mode of imageLabSubjectFactsModes) {
      expect(imageLabSubjectFactsLabel(mode)).not.toBe(mode);
      expect(imageLabSubjectFactsHint(mode).length).toBeGreaterThan(40);
    }
    const labels = imageLabSubjectFactsModes.map(imageLabSubjectFactsLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("labels the reduced arm as an ablation, in both the option and the hint", () => {
    expect(imageLabSubjectFactsLabel("reference_only").toLowerCase()).toContain("ablation");
    expect(imageLabSubjectFactsHint("reference_only")).toContain("beside");
    expect(imageLabSubjectFactsLabel("production_parity").toLowerCase()).not.toContain("ablation");
  });
});

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
 * The verdict copy spans three vocabularies now, and the reviewer is choosing
 * between them from these words alone — a ruling offered as a bare identifier,
 * or offered with the wrong hint, is a misfiled ruling.
 */
describe("verdict copy", () => {
  it("names every ruling in every vocabulary, and hints at each", () => {
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

  // The two-character rulings are read as a set — four ways one render can lose a
  // cast, and one way it can keep it — so the reviewer has to be able to tell them
  // apart at a glance as well as in the select.
  it("names every two-character ruling and marks the clean one as good news", () => {
    for (const verdict of imageLabTwoCharacterVerdicts) {
      expect(imageLabVerdictLabel(verdict)).not.toBe(verdict);
      expect(imageLabVerdictHint(verdict).length).toBeGreaterThan(20);
    }
    expect(imageLabVerdictChip("both_identities_held").tone).toBe("ok");
    expect(imageLabVerdictChip("identities_swapped").tone).toBe("danger");
  });

  // A kind whose gate answered `null` would render no verdict section at all, and
  // the loop above would pass over it in silence — so the gate is asserted, not
  // just iterated.
  it("offers the two-character kind a vocabulary to rule in", () => {
    const options = imageLabVerdictOptions("two_character_scene");
    expect(options).not.toBeNull();
    for (const verdict of options ?? []) {
      expect(imageLabVerdictLabel(verdict).length).toBeGreaterThan(0);
    }
  });

  it("offers the staged kind a vocabulary to rule in, and marks the promotable one", () => {
    const options = imageLabVerdictOptions("staged_scene");
    expect(options).not.toBeNull();
    for (const verdict of imageLabStagedSceneVerdicts) {
      expect(imageLabVerdictLabel(verdict)).not.toBe(verdict);
      expect(imageLabVerdictHint(verdict).length).toBeGreaterThan(20);
    }
    expect(imageLabVerdictChip("act_depicted").tone).toBe("ok");
    expect(imageLabVerdictChip("act_substituted").tone).toBe("danger");
  });

  // The pair this bench is actually used for. Both mean "the picture is wrong"
  // and they point at OPPOSITE scale corrections, so an admin running a sweep has
  // to be able to read the direction off the hint itself — a month later, with no
  // memory of which one meant which.
  it("sends the two middle staged rulings in opposite directions", () => {
    const withheld = imageLabVerdictHint("anatomy_withheld");
    const geometry = imageLabVerdictHint("geometry_wrong");
    expect(withheld).toContain("LOW");
    expect(geometry).toContain("HIGH");
    expect(withheld).not.toBe(geometry);
    // And the third failure mode must NOT be read as a scale problem at all.
    expect(imageLabVerdictHint("act_substituted")).toContain("wording");
  });
});
