import { describe, expect, it } from "vitest";
import type { AffordanceObservation } from "../affordances/core";
import { probeGustatoryObservation, probeOlfactoryObservation, probeTactileObservation } from "./fixtures";
import type { OlfactoryObservation } from "./olfactory";
import { selectSensoryCues, SENSORY_NARRATOR_CUE_BUDGET } from "./presentation";

/**
 * The shared presentation architecture's selection laws — one repeat family
 * speaks once with its strongest member, stronger bands outrank weaker ones,
 * and the strict budget caps the rest — plus the ruling's type walls: each
 * sense's contract stands alone, assignable neither to the shared visual
 * observation contract nor to a sibling sense's.
 *
 * Falsified against a selection that lets one family fill the whole budget,
 * one that ranks by input order, and — via the pins — against a future edit
 * that collapses the senses into one cross-sensory type or widens the shared
 * contract to swallow them.
 */
/** Every ordering of `items` — tiny n; exhausting them is the point of the pin. */
function permutationsOf<T>(items: readonly T[]): readonly (readonly T[])[] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutationsOf([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("selectSensoryCues", () => {
  it("dedupes a repeat family to its strongest member and counts everything left unsaid", () => {
    const selection = selectSensoryCues([
      probeTactileObservation({ phenomenonId: "probe.a_family_subtle", intensityBand: "subtle" }),
      probeTactileObservation({ phenomenonId: "probe.a_family_strong", intensityBand: "strong" }),
      probeTactileObservation({
        phenomenonId: "probe.other_family",
        repeatFamily: "probe:other",
        intensityBand: "clear",
      }),
    ]);
    expect(selection.selected.map((cue) => cue.phenomenonId)).toEqual([
      "probe.a_family_strong",
      "probe.other_family",
    ]);
    expect(selection.suppressedCount).toBe(1);
  });

  it("caps at the strict budget, strongest bands first, ties on the phenomenon id", () => {
    const selection = selectSensoryCues([
      probeTactileObservation({ phenomenonId: "probe.zeta", repeatFamily: "probe:z", intensityBand: "clear" }),
      probeTactileObservation({ phenomenonId: "probe.alpha", repeatFamily: "probe:a", intensityBand: "clear" }),
      probeTactileObservation({ phenomenonId: "probe.mid", repeatFamily: "probe:m", intensityBand: "strong" }),
    ]);
    expect(SENSORY_NARRATOR_CUE_BUDGET).toBe(2);
    expect(selection.selected.map((cue) => cue.phenomenonId)).toEqual(["probe.mid", "probe.alpha"]);
    expect(selection.suppressedCount).toBe(1);
  });

  it("selects identically under every permutation of the candidate set", () => {
    // Engineered ties the cases above never hit: one phenomenon id at one band
    // across three repeat families, plus a same-family twin differing only in
    // a field the shared bound cannot see. A comparator whose order stops at
    // the phenomenon id survives the other tests, leaves these ties to the
    // stable sort's input order, and fails here — the deterministic-replay
    // guarantee requires a merged candidate set to select the same cues in
    // any producer order.
    const alphaTwin = probeTactileObservation({
      phenomenonId: "probe.same",
      repeatFamily: "probe:family_a",
      semanticTags: ["alpha"],
    });
    const omegaTwin = probeTactileObservation({
      phenomenonId: "probe.same",
      repeatFamily: "probe:family_a",
      semanticTags: ["omega"],
    });
    const familyB = probeTactileObservation({ phenomenonId: "probe.same", repeatFamily: "probe:family_b" });
    const familyC = probeTactileObservation({ phenomenonId: "probe.same", repeatFamily: "probe:family_c" });
    for (const permutation of permutationsOf([alphaTwin, omegaTwin, familyB, familyC])) {
      expect(selectSensoryCues(permutation)).toEqual({ selected: [alphaTwin, familyB], suppressedCount: 2 });
    }
  });
});

describe("the sense contracts stay walled", () => {
  it("no sense contract satisfies the shared visual observation contract", () => {
    // @ts-expect-error — a TactileObservation must never satisfy
    // AffordanceObservation: assignability here would let a felt fact reach
    // projectObservationFeatures without its owner's access law.
    const tactile: AffordanceObservation = probeTactileObservation();
    // @ts-expect-error — same wall for smell.
    const olfactory: AffordanceObservation = probeOlfactoryObservation();
    // @ts-expect-error — same wall for taste.
    const gustatory: AffordanceObservation = probeGustatoryObservation();
    expect([tactile, olfactory, gustatory]).toHaveLength(3);
  });

  it("no sense's contract satisfies a sibling sense's", () => {
    // @ts-expect-error — the senses are never collapsed into one generic
    // cross-sensory type: a felt fact cannot be handed to the olfactory owner.
    const collapsed: OlfactoryObservation = probeTactileObservation();
    expect(collapsed).toBeDefined();
  });
});
