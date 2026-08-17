import { describe, expect, it } from "vitest";
import { expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import {
  unsupportedCurrentStateSuppressions,
  VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS,
} from "./current-suppressions";
import { VISUAL_STATE_DUPLICATE_KEY, VISUAL_STATE_SOURCE_UNAVAILABLE } from "./diagnostics";
import { visualStateFeatureFixture, VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";
import { buildVisualStateSnapshot } from "./snapshot";

const SUBJECT = VISUAL_STATE_FIXTURE_SUBJECT_ID;

describe("unsupportedCurrentStateSuppressions", () => {
  it("records one suppression per unavailable fact, addressed at the subject", () => {
    const suppressions = unsupportedCurrentStateSuppressions(SUBJECT);
    expect(suppressions).toHaveLength(VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS.length);
    for (const suppression of suppressions) {
      expect(suppression.code).toBe(VISUAL_STATE_SOURCE_UNAVAILABLE);
      expect(suppression.key.startsWith(`${SUBJECT}/subject:${SUBJECT}/`)).toBe(true);
    }
    expect(suppressions.map((suppression) => suppression.detail)).toEqual([
      "physiology:swelling",
      "physiology:visible_fatigue",
      "contamination:dirt_on_skin",
      "contamination:blood_on_skin",
      "contamination:cosmetics_wear",
      "contact:contact_marks",
      "fit:garment_fit",
    ]);
  });

  it("does not declare a fact an adapter now owns", () => {
    // The table retires a row when its owner ships. `body_language.hand_occupation`
    // (slice 4) derives occupied hands from the committed contacts, so a row for
    // it would make one snapshot call the fact unavailable and state it at once.
    const facts = VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS.map((row) => `${row.family}:${row.fact}`);
    expect(facts).not.toContain("contact:occupied_hands");
  });

  it("reports each gap on the sink as context, not as a degradation alarm", () => {
    const sink = new DiagnosticCollector();
    unsupportedCurrentStateSuppressions(SUBJECT, sink);
    expectDiagnostic(sink, VISUAL_STATE_SOURCE_UNAVAILABLE, {
      times: VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS.length,
    });
    for (const item of sink.items) expect(item.severity).toBe("info");
  });

  it("rides a contribution onto the snapshot, ahead of merge and composition drops", () => {
    const feature = visualStateFeatureFixture();
    const snapshot = buildVisualStateSnapshot({
      scope: { kind: "chat", memoryGroupId: "group_fixture" },
      atMinutes: 0,
      cutId: "cut_fixture",
      contributions: [
        { adapterId: "appearance", features: [feature] },
        {
          adapterId: "condition",
          // The duplicate proves the ordering claim: the same key arrives again
          // from a later adapter, and its merge drop must land AFTER the
          // adapter's own suppressions.
          features: [feature],
          suppressions: unsupportedCurrentStateSuppressions(SUBJECT),
        },
      ],
    });
    expect(snapshot.suppressions.map((suppression) => suppression.code)).toEqual([
      ...VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS.map(() => VISUAL_STATE_SOURCE_UNAVAILABLE),
      VISUAL_STATE_DUPLICATE_KEY,
    ]);
  });

  it("is byte-equal for the same subject", () => {
    expect(JSON.stringify(unsupportedCurrentStateSuppressions(SUBJECT))).toBe(
      JSON.stringify(unsupportedCurrentStateSuppressions(SUBJECT)),
    );
  });
});
