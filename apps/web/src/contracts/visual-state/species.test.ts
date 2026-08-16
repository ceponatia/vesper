import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { realizeBody } from "../species";
import { DiagnosticCollector } from "../diagnostics";
import { VISUAL_STATE_FEATURE_GROUP_UNPLACED } from "./diagnostics";
import { visualStateHumanBody, visualStateNonHumanBody, VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";
import { projectSpeciesFeatureGroups } from "./species";

/**
 * Fixture VS-5 — the non-human case, and the one the audit singled out: wings,
 * horns and a tail are species/heritage feature groups through `realizeBody`,
 * NOT anatomy state, so nothing here reads `anatomyPartStateValues`.
 */

function project(body = visualStateNonHumanBody(), sink?: DiagnosticCollector) {
  return projectSpeciesFeatureGroups({ subjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID, realizedBody: body, sink });
}

describe("projectSpeciesFeatureGroups", () => {
  it("projects every realized feature group, in registry order", () => {
    const sink = new DiagnosticCollector();
    const features = project(visualStateNonHumanBody(), sink);
    expect(features.map((feature) => feature.value)).toEqual([
      { group: "wings" },
      { group: "horns" },
      { group: "tail" },
    ]);
    expectCleanSink(sink);
  });

  it("hangs each group at its own body location", () => {
    expect(project().map((feature) => feature.key)).toEqual([
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/wings/species.feature_group`,
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/horns/species.feature_group`,
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/tail/species.feature_group`,
    ]);
  });

  it("files them on the identity layer as inherent truth", () => {
    for (const feature of project()) {
      expect(feature.layer).toBe("identity");
      expect(feature.stability).toBe("inherent");
    }
  });

  it("marks them mandatory, so an image cannot drop an intentional appendage", () => {
    for (const feature of project()) {
      expect(feature.priors.mandatoryForIdentity).toBe(true);
      expect(feature.priors.mandatoryForContinuity).toBe(true);
    }
  });

  it("names the species as the source, not an attribute", () => {
    const [first] = project();
    expect(first?.sourceRef).toEqual({ kind: "species_feature", speciesId: "succubus", featureGroup: "wings" });
  });

  it("projects nothing for an ordinary human body", () => {
    const sink = new DiagnosticCollector();
    expect(project(visualStateHumanBody(), sink)).toEqual([]);
    expectCleanSink(sink);
  });

  it("follows the per-character override rather than the species default", () => {
    const features = project(visualStateNonHumanBody(["tail"]));
    expect(features.map((feature) => feature.value)).toEqual([{ group: "tail" }]);
  });

  it("produces byte-equal output from the same realized body", () => {
    expect(JSON.stringify(project())).toBe(JSON.stringify(project()));
  });

  it("falls silent with a diagnostic when a group has nowhere on the body to sit", () => {
    const sink = new DiagnosticCollector();
    // A body plan whose id the registry does not know degrades to the FULL
    // location set, so the contradiction has to be built the other way: a
    // realized body that claims a group its location set does not carry.
    const body = realizeBody({ speciesId: "succubus" });
    const contradictory = { ...body, isLocationPresent: (id: string) => id !== "wings" };
    const features = projectSpeciesFeatureGroups({
      subjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID,
      realizedBody: contradictory,
      sink,
    });
    expect(features.map((feature) => feature.value)).toEqual([{ group: "horns" }, { group: "tail" }]);
    expectDiagnostic(sink, VISUAL_STATE_FEATURE_GROUP_UNPLACED, { times: 1 });
  });
});
