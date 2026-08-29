import { describe, expect, it } from "vitest";
import { SENSORY_TACTILE_NOT_PARTICIPANT } from "./diagnostics";
import { probeTactileObservation, SENSORY_PROBE_BYSTANDER, SENSORY_PROBE_OBSERVER } from "./fixtures";
import { perceiveTactile, presentTactileCues } from "./tactile";

/**
 * Touch's access law: the observer must participate in the qualifying
 * committed contact. Falsified against an owner that admits any nearby
 * observer — the bystander an inch from a touch between two other people —
 * and against one whose refusal keeps the observation payload around for a
 * consumer to cast back into a cue.
 */
describe("perceiveTactile", () => {
  it("admits a participant and refuses a bystander as a payload-free suppression", () => {
    const observation = probeTactileObservation();
    expect(perceiveTactile([observation], { observerId: SENSORY_PROBE_OBSERVER })).toEqual({
      perceived: [observation],
      withheld: [],
    });
    expect(perceiveTactile([observation], { observerId: SENSORY_PROBE_BYSTANDER })).toEqual({
      perceived: [],
      withheld: [
        { kind: "suppressed", phenomenonId: "probe.felt_pressure", code: SENSORY_TACTILE_NOT_PARTICIPANT },
      ],
    });
  });

  it("offers a bystander nothing through the whole presentation either", () => {
    const presentation = presentTactileCues([probeTactileObservation()], { observerId: SENSORY_PROBE_BYSTANDER });
    expect(presentation.digest).toEqual({
      sense: "tactile",
      observerId: SENSORY_PROBE_BYSTANDER,
      selected: [],
      suppressedCount: 0,
    });
    expect(presentation.withheld.map((entry) => entry.code)).toEqual([SENSORY_TACTILE_NOT_PARTICIPANT]);
  });
});
