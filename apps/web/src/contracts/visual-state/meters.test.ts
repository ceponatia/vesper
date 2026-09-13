import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { VISUAL_STATE_VALUE_INVALID } from "./diagnostics";
import { VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";
import { VISUAL_STATE_METER_VISIBLE_EFFECT_KIND_ID } from "./kinds";
import { projectMeterFeatures } from "./meters";

const SUBJECT = VISUAL_STATE_FIXTURE_SUBJECT_ID;

function project(meters: Readonly<Record<string, number>>, sink?: DiagnosticCollector) {
  return projectMeterFeatures({ subjectId: SUBJECT, meters, sink });
}

/**
 * The band-to-fact mapping and its suppression (issue #427 acceptance): the
 * owner's four ruled deepest bands mint a typed current-state fact, every
 * shallower band and every other meter stays silent, and a raw number never
 * reaches the value.
 */
describe("projectMeterFeatures", () => {
  it("projects intoxication 0.8 (past the drunk band) as a current-layer visible-effect fact", () => {
    const sink = new DiagnosticCollector();
    const [feature] = project({ intoxication: 0.8 }, sink);
    expect(feature?.kindId).toBe(VISUAL_STATE_METER_VISIBLE_EFFECT_KIND_ID);
    expect(feature?.key).toBe(`${SUBJECT}/subject:${SUBJECT}/meter.visible_effect:intoxication`);
    expect(feature?.layer).toBe("current");
    expect(feature?.stability).toBe("transient");
    expect(feature?.locus).toEqual({ kind: "subject", subjectId: SUBJECT });
    expect(feature?.value).toEqual({ meter: "intoxication", band: "drunk", effects: ["glassy, unfocused eyes"] });
    expect(feature?.sourceRef).toEqual({ kind: "meter", meterId: "intoxication", band: "intoxication:0.7" });
    expect(feature?.semanticTags).toEqual(["meter:intoxication", "band:drunk"]);
    expectCleanSink(sink);
  });

  it("stays silent at intoxication 0.2 — no threshold crossed at all", () => {
    expect(project({ intoxication: 0.2 })).toEqual([]);
  });

  it("stays silent at intoxication 0.5 — only the shallower tipsy band is crossed", () => {
    expect(project({ intoxication: 0.5 })).toEqual([]);
  });

  it("projects the ruled low-hygiene effects and omits the shallower lived-in band", () => {
    const [feature] = project({ hygiene: 0.2 });
    expect(feature?.value).toEqual({
      meter: "hygiene",
      band: "unwashed",
      effects: ["lank, greasy hair", "grimy skin"],
    });
    expect(project({ hygiene: 0.5 })).toEqual([]); // lived-in band: no visibleEffects
    expect(project({ hygiene: 0.9 })).toEqual([]); // healthy
  });

  it("projects the ruled low-energy effects and omits the shallower tired band", () => {
    const [feature] = project({ energy: 0.1 });
    expect(feature?.value).toEqual({
      meter: "energy",
      band: "exhausted",
      effects: ["heavy-lidded eyes", "dark circles under the eyes"],
    });
    expect(project({ energy: 0.3 })).toEqual([]); // tired band: no visibleEffects
  });

  it("projects the ruled high-arousal effect at its one band", () => {
    const [feature] = project({ arousal: 0.6 });
    expect(feature?.value).toEqual({ meter: "arousal", band: "flushed", effects: ["parted lips"] });
  });

  it("never states a flush/blush word in the rendered effects — the owner's ruling as a projection-level tripwire", () => {
    // The BAND label ("flushed") is a stable vocabulary key, carried in `value.band`
    // and `semanticTags` for provenance — never worded into a prompt (only `effects`
    // is). The tripwire therefore reads `effects` alone, exactly like the registry's
    // own tripwire (`registry.test.ts`), and would catch a future author putting the
    // forbidden word INTO an effect phrase, which is the actual leak path to a prompt.
    const [feature] = project({ arousal: 0.9 });
    const value = feature?.value as { effects?: readonly string[] } | undefined;
    for (const effect of value?.effects ?? []) {
      expect(effect).not.toMatch(/flush|blush|reddened|rosy|crimson/i);
    }
    expect(value?.effects).toEqual(["parted lips"]);
  });

  it("stays silent for stress and mood — every band and value, no ruled effect anywhere", () => {
    expect(project({ stress: 0.95 })).toEqual([]);
    expect(project({ mood: 0.05 })).toEqual([]);
    expect(project({ mood: 0.95 })).toEqual([]);
  });

  it("stays silent for an unknown meter id, with no diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(project({ mystery: 0.9 }, sink)).toEqual([]);
    expectCleanSink(sink);
  });

  it("degrades a non-finite or out-of-range value rather than projecting a guess", () => {
    const sink = new DiagnosticCollector();
    expect(project({ intoxication: Number.NaN }, sink)).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_VALUE_INVALID, { times: 1 });
    const sinkOutOfRange = new DiagnosticCollector();
    expect(project({ intoxication: 1.4 }, sinkOutOfRange)).toEqual([]);
    expectDiagnostic(sinkOutOfRange, VISUAL_STATE_VALUE_INVALID, { times: 1 });
    const sinkNegative = new DiagnosticCollector();
    expect(project({ hygiene: -0.1 }, sinkNegative)).toEqual([]);
    expectDiagnostic(sinkNegative, VISUAL_STATE_VALUE_INVALID, { times: 1 });
  });

  it("projects several meters at once, sorted by key", () => {
    const features = project({ intoxication: 0.8, hygiene: 0.1, stress: 0.9 });
    expect(features.map((feature) => feature.key)).toEqual([
      `${SUBJECT}/subject:${SUBJECT}/meter.visible_effect:hygiene`,
      `${SUBJECT}/subject:${SUBJECT}/meter.visible_effect:intoxication`,
    ]);
  });

  it("produces byte-equal output from the same meters, regardless of key order", () => {
    const first = project({ intoxication: 0.8, hygiene: 0.1 });
    const second = project({ hygiene: 0.1, intoxication: 0.8 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("empty meters project nothing", () => {
    expect(project({})).toEqual([]);
  });
});
