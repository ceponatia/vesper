import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import type { ActiveCondition } from "../conditions/condition";
import { DiagnosticCollector } from "../diagnostics";
import { projectActiveConditionFeatures } from "./conditions";
import { VISUAL_STATE_METER_EFFECT_ALREADY_STATED, VISUAL_STATE_VALUE_INVALID } from "./diagnostics";
import type { VisualStateFeature } from "./feature";
import { VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";
import { VISUAL_STATE_METER_VISIBLE_EFFECT_KIND_ID } from "./kinds";
import { projectMeterFeatures, type VisualStateMeterProjection } from "./meters";

const SUBJECT = VISUAL_STATE_FIXTURE_SUBJECT_ID;

function projectFull(
  meters: Readonly<Record<string, number>>,
  options: { sink?: DiagnosticCollector; composeAgainst?: readonly VisualStateFeature[] } = {},
): VisualStateMeterProjection {
  return projectMeterFeatures({
    subjectId: SUBJECT,
    meters,
    ...(options.sink === undefined ? {} : { sink: options.sink }),
    ...(options.composeAgainst === undefined ? {} : { composeAgainst: options.composeAgainst }),
  });
}

function project(meters: Readonly<Record<string, number>>, sink?: DiagnosticCollector) {
  return projectFull(meters, { sink }).features;
}

/** An active `unwashed` condition, as `projectActiveConditionFeatures` would produce it. */
function unwashedConditionFeature(): readonly VisualStateFeature[] {
  const condition: ActiveCondition = {
    id: "cond_unwashed",
    label: "unwashed",
    startedAtMinutes: 0,
    attributeEffects: [],
  };
  return projectActiveConditionFeatures({ subjectId: SUBJECT, conditions: [condition], atMinutes: 30 });
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

/**
 * Composition against an already-active condition (issue #427 reviewer
 * finding): the catalog's own `unwashed` condition
 * (`contracts/conditions/catalog.ts`) already states hygiene's `unwashed`
 * band under its own label, so the meter must not restate it as a second,
 * differently-worded current-state fact.
 */
describe("projectMeterFeatures composed against an active condition", () => {
  it("withholds the hygiene effect when an active `unwashed` condition already states it, and records why", () => {
    const composeAgainst = unwashedConditionFeature();
    expect(composeAgainst).not.toEqual([]); // control: the condition feature exists to compose against

    const projection = projectFull({ hygiene: 0.2 }, { composeAgainst });
    expect(projection.features).toEqual([]);
    expect(projection.suppressions).toEqual([
      {
        key: `${SUBJECT}/subject:${SUBJECT}/meter.visible_effect:hygiene`,
        code: VISUAL_STATE_METER_EFFECT_ALREADY_STATED,
        detail: "condition:unwashed",
      },
    ]);
  });

  it("still projects the hygiene effect when no overlapping condition is active", () => {
    const projection = projectFull({ hygiene: 0.2 });
    expect(projection.features).toHaveLength(1);
    expect(projection.suppressions).toEqual([]);
  });

  it("an unrelated active condition does not withhold a meter with no overlap row", () => {
    // `unwashed` only overlaps `hygiene` (issue #427's evidenced catalog scan);
    // intoxication has no catalog condition stating it, so it still projects.
    const composeAgainst = unwashedConditionFeature();
    const projection = projectFull({ intoxication: 0.8 }, { composeAgainst });
    expect(projection.features).toHaveLength(1);
    expect(projection.suppressions).toEqual([]);
  });

  it("a condition on a DIFFERENT subject never withholds this subject's effect", () => {
    const other: ActiveCondition = {
      id: "cond_other",
      label: "unwashed",
      startedAtMinutes: 0,
      attributeEffects: [],
    };
    const composeAgainst = projectActiveConditionFeatures({
      subjectId: "someone_else",
      conditions: [other],
      atMinutes: 30,
    });
    const projection = projectFull({ hygiene: 0.2 }, { composeAgainst });
    expect(projection.features).toHaveLength(1);
    expect(projection.suppressions).toEqual([]);
  });
});
