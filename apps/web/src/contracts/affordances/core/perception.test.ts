import { describe, expect, it } from "vitest";
import {
  affordanceExposureAt,
  affordancePerceptionView,
  emptyAffordancePerceptionView,
  filterAffordanceObservations,
  isAffordanceChannelAvailable,
  AFFORDANCE_PERCEPTION_CHANNEL_UNAVAILABLE,
  AFFORDANCE_PERCEPTION_HIDDEN,
  AFFORDANCE_PERCEPTION_UNKNOWN,
  type AffordanceExposure,
} from "./perception";
import type { AffordanceObservation } from "./types";

/**
 * The perception filter's law: `visible` and `hinted` pass, `hidden` is
 * suppressed, and anything the lane cannot answer — an unlisted location, an
 * unasserted channel — FAILS CLOSED. A physically true read that this observer
 * cannot see must never reach a cue.
 */

const observation = (input: {
  id?: string;
  source: string;
  target?: string;
  repeatKey?: string;
}): AffordanceObservation => ({
  kind: "observation",
  id: input.id ?? "probe.read",
  sourceLocationId: input.source,
  ...(input.target === undefined ? {} : { targetLocationId: input.target }),
  intensityBand: "clear",
  semanticTags: [],
  repeatKey: input.repeatKey ?? `probe:${input.source}`,
});

const sighted = (exposure: Record<string, AffordanceExposure>) =>
  affordancePerceptionView({ exposure, channels: { sight: "available" } });

describe("the view", () => {
  it("an unlisted location reads unknown; an unasserted channel reads unavailable", () => {
    const view = emptyAffordancePerceptionView();
    expect(affordanceExposureAt(view, "eyes")).toBe("unknown");
    expect(isAffordanceChannelAvailable(view, "sight")).toBe(false);
    expect(isAffordanceChannelAvailable(sighted({}), "sight")).toBe(true);
    expect(isAffordanceChannelAvailable(sighted({}), "touch")).toBe(false);
  });
});

describe("filterAffordanceObservations", () => {
  it("visible and hinted pass", () => {
    const split = filterAffordanceObservations({
      observations: [observation({ source: "eyes" }), observation({ source: "face", repeatKey: "probe:face" })],
      perception: sighted({ eyes: "visible", face: "hinted" }),
    });
    expect(split.observations).toHaveLength(2);
    expect(split.suppressed).toEqual([]);
  });

  it("hidden is suppressed with the hidden reason", () => {
    const split = filterAffordanceObservations({
      observations: [observation({ source: "eyes" })],
      perception: sighted({ eyes: "hidden" }),
    });
    expect(split.observations).toEqual([]);
    expect(split.suppressed).toEqual([
      { kind: "suppressed", phenomenonId: "probe.read", code: AFFORDANCE_PERCEPTION_HIDDEN, detail: "eyes" },
    ]);
  });

  it("unknown fails closed", () => {
    const split = filterAffordanceObservations({
      observations: [observation({ source: "eyes" })],
      perception: sighted({}),
    });
    expect(split.observations).toEqual([]);
    expect(split.suppressed[0]?.code).toBe(AFFORDANCE_PERCEPTION_UNKNOWN);
  });

  it("needs BOTH ends: a visible source cannot carry a hidden target", () => {
    const split = filterAffordanceObservations({
      observations: [observation({ source: "eyes", target: "neck" })],
      perception: sighted({ eyes: "visible", neck: "hidden" }),
    });
    expect(split.observations).toEqual([]);
    expect(split.suppressed[0]).toMatchObject({ code: AFFORDANCE_PERCEPTION_HIDDEN, detail: "neck" });
  });

  it("an unavailable sight channel silences everything, whatever the coverage says", () => {
    const split = filterAffordanceObservations({
      observations: [observation({ source: "eyes" }), observation({ source: "face", repeatKey: "probe:face" })],
      perception: affordancePerceptionView({ exposure: { eyes: "visible", face: "visible" } }),
    });
    expect(split.observations).toEqual([]);
    expect(split.suppressed.map((entry) => entry.code)).toEqual([
      AFFORDANCE_PERCEPTION_CHANNEL_UNAVAILABLE,
      AFFORDANCE_PERCEPTION_CHANNEL_UNAVAILABLE,
    ]);
  });

  it("keeps input order for the survivors — ranking, not perception, decides priority", () => {
    const split = filterAffordanceObservations({
      observations: [
        observation({ source: "eyes", repeatKey: "a" }),
        observation({ source: "hidden_place", repeatKey: "b" }),
        observation({ source: "face", repeatKey: "c" }),
      ],
      perception: sighted({ eyes: "visible", hidden_place: "hidden", face: "visible" }),
    });
    expect(split.observations.map((entry) => entry.repeatKey)).toEqual(["a", "c"]);
  });
});
