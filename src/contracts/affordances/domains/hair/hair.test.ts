import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../../diagnostics";
import { attributeRegistry, type AttributeValue } from "../../../attributes";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import {
  affordanceSubjectId,
  defineAffordancePhenomenon,
  registerAffordanceDomain,
  resolvedAttributeSnapshot,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
  AFFORDANCE_SUPPRESSED_NO_PROFILE,
  type RegisteredAffordanceDomain,
} from "../../core";
import { affordanceDomains } from "../../domains";
import { deriveAffordanceRead, type AffordanceRead } from "../../derive-affordance-read";
import { hairAttributeAxes, hairRequiredAttributeIds } from "./attribute-maps";
import type { HairAffordanceFrame } from "./frame";
import { hairAffordanceDomain, hairDomainDefinition, HAIR_DOMAIN_ID } from "./domain";
import { hairPhenomena } from "./phenomena";
import {
  braidedUnderHood,
  dampThickGustLooseEnds,
  dryFineLooseInBreeze,
  hairWorkedCases,
  readHairAffordances,
  saturatedDenseNeckContact,
  type HairFixture,
} from "./fixtures";

/**
 * The hair domain end to end: the spec's four worked cases driven through
 * `deriveAffordanceRead` exactly as a lane adapter will, plus the structural
 * guarantees the plan is judged on — determinism, registration-order
 * independence, and conservative silence with an explainable reason whenever an
 * input is missing.
 */

function readCase(fixture: HairFixture, overrides: { sink?: DiagnosticCollector; previousCues?: AffordanceRead["nextCues"]; storyTime?: number } = {}): AffordanceRead {
  return readHairAffordances({
    attributes: fixture.attributes,
    payload: fixture.payload,
    perception: fixture.perception,
    ...(overrides.sink === undefined ? {} : { sink: overrides.sink }),
    ...(overrides.previousCues === undefined ? {} : { previousCues: overrides.previousCues }),
    ...(overrides.storyTime === undefined ? {} : { storyTime: overrides.storyTime }),
  });
}

/** The same cut, resolved through a VARIANT registration (reordered, or probed). */
function readWithDomains(fixture: HairFixture, domains: readonly RegisteredAffordanceDomain[]): AffordanceRead {
  return deriveAffordanceRead({
    subjectId: affordanceSubjectId("hair_fixture_subject"),
    storyTime: 0,
    attributes: resolvedAttributeSnapshot([...fixture.attributes]),
    perception: fixture.perception,
    domains,
    payloads: { [HAIR_DOMAIN_ID]: fixture.payload },
  });
}

const ids = (result: AffordanceRead): string[] => result.observations.map((observation) => observation.id);

const codeOf = (result: AffordanceRead, phenomenonId: string): string | undefined =>
  result.suppressed.find((entry) => entry.phenomenonId === phenomenonId)?.code;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("hair is in the shipped registry with its four phenomena", () => {
    expect(affordanceDomains.map((domain) => domain.id)).toContain(HAIR_DOMAIN_ID);
    expect(hairAffordanceDomain.phenomenonIds).toEqual([
      "hair.wet_clumping",
      "hair.wind_or_motion_response",
      "hair.strands_adhere_to_skin",
      "hair.sheds_droplets",
    ]);
  });

  it("declares exactly the five executable attributes, and all of them exist", () => {
    expect(hairAffordanceDomain.requiredAttributeIds).toEqual(hairRequiredAttributeIds);
    expect(hairRequiredAttributeIds).toHaveLength(hairAttributeAxes.length);
    for (const attributeId of hairAffordanceDomain.requiredAttributeIds) {
      expect(attributeRegistry.byId(attributeId), attributeId).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Worked cases
// ---------------------------------------------------------------------------

describe("worked case 1 — dry, fine, shoulder-length, loose; moderate breeze", () => {
  it("reads clear whole-hair motion and nothing else", () => {
    const sink = new DiagnosticCollector();
    const result = readCase(dryFineLooseInBreeze(), { sink });
    expect(ids(result)).toEqual(["hair.wind_or_motion_response"]);
    expect(result.observations[0]?.intensityBand).toBe("clear");
    expect(codeOf(result, "hair.wet_clumping")).toBe("insufficient_wetness");
    expect(codeOf(result, "hair.strands_adhere_to_skin")).toBe("no_asserted_contact");
    expect(codeOf(result, "hair.sheds_droplets")).toBe("no_current_impulse");
    // Nothing DEGRADED: conservative silence is data on the resolutions, not noise
    // in the diagnostic sink.
    expectCleanSink(sink);
  });
});

describe("worked case 2 — saturated, dense/coarse; light breeze; exposed neck contact", () => {
  it("clumps and clings while the water load suppresses whole-hair motion", () => {
    const result = readCase(saturatedDenseNeckContact());
    expect(ids(result)).toEqual(["hair.wet_clumping", "hair.strands_adhere_to_skin"]);
    expect(codeOf(result, "hair.wind_or_motion_response")).toBe("water_loaded");
    expect(codeOf(result, "hair.sheds_droplets")).toBe("no_current_impulse");
    expect(result.observations.map((observation) => observation.repeatKey)).toEqual([
      "hair:clumping",
      "hair:adhesion:neck",
    ]);
  });

  it("carries rain provenance only because the exposure event is in the frame", () => {
    const withRain = readCase(saturatedDenseNeckContact());
    expect(withRain.observations[0]?.semanticTags).toContain("recent_rain");

    const fixture = saturatedDenseNeckContact();
    const unattributed = readHairAffordances({
      attributes: fixture.attributes,
      payload: { ...fixture.payload, events: [] },
      perception: fixture.perception,
    });
    expect(unattributed.observations[0]?.semanticTags).not.toContain("recent_rain");
    expect(unattributed.observations.map((observation) => observation.id)).toEqual(ids(withRain));
  });

  it("records the provenance of every stage, deduped and in order", () => {
    const result = readCase(saturatedDenseNeckContact());
    expect(result.evidence).toEqual([
      { kind: "attribute", ref: "hair.length", detail: "shoulder_length" },
      { kind: "attribute", ref: "hair.density", detail: "dense" },
      { kind: "attribute", ref: "hair.strand_thickness", detail: "thick" },
      { kind: "attribute", ref: "hair.texture", detail: "wavy" },
      { kind: "attribute", ref: "hair.condition", detail: "healthy" },
      { kind: "state", ref: "wetness" },
      { kind: "coverage", ref: "coveredFraction" },
      { kind: "attribute", ref: "hair.arrangement" },
      { kind: "environment", ref: "wind" },
      { kind: "contact", ref: "contacts" },
      { kind: "event", ref: "events" },
    ]);
  });

  it("offers both changed reads as cues, then falls silent while they stay true", () => {
    const first = readCase(saturatedDenseNeckContact());
    expect(first.cues.map((cue) => cue.repeatKey)).toEqual(["hair:clumping", "hair:adhesion:neck"]);
    const second = readCase(saturatedDenseNeckContact(), { previousCues: first.nextCues });
    expect(second.cues).toEqual([]);
    expect(ids(second)).toEqual(ids(first));
  });
});

describe("worked case 3 — the same hair braided under a hood", () => {
  it("suppresses visible motion and emits no cue at all", () => {
    const result = readCase(braidedUnderHood());
    expect(codeOf(result, "hair.wind_or_motion_response")).toBe("bound");
    // Reach made the neck contact possible and the lane asserted it; a braid
    // still has no loose strands to cling with.
    expect(codeOf(result, "hair.strands_adhere_to_skin")).toBe("bound");
    expect(result.observations).toEqual([]);
    expect(result.cues).toEqual([]);
  });

  it("keeps the clumping physically true while perception hides it under the hood", () => {
    const fixture = braidedUnderHood();
    const hidden = readCase(fixture);
    expect(hidden.suppressed.map((entry) => entry.code)).toContain("affordance.perception.hidden");

    const uncovered = readHairAffordances({
      attributes: fixture.attributes,
      payload: fixture.payload,
      perception: { exposure: { hair: "visible", neck: "visible" }, channels: { sight: "available" } },
    });
    expect(uncovered.observations.map((observation) => observation.id)).toEqual(["hair.wet_clumping"]);
  });
});

describe("worked case 4 — damp thick hair, strong gust, loose ends below a hood", () => {
  it("stirs the exposed ends only, and cannot be read as the whole style flying free", () => {
    const result = readCase(dampThickGustLooseEnds());
    const motion = result.observations.find((observation) => observation.id === "hair.wind_or_motion_response");
    expect(motion?.repeatKey).toBe("hair:motion:ends");
    expect(motion?.intensityBand).toBe("subtle");
    expect(motion?.semanticTags).toEqual(["exposed_ends", "stirs", "ends_long"]);
    expect(result.observations.map((observation) => observation.repeatKey)).not.toContain("hair:motion");
  });
});

// ---------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("replays byte-identically from the same committed cut", () => {
    for (const build of Object.values(hairWorkedCases)) {
      const first = readCase(build(), { storyTime: 12 });
      const second = readCase(build(), { storyTime: 12 });
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it("does not depend on the order attributes arrived in", () => {
    const fixture = saturatedDenseNeckContact();
    const shuffled: readonly AttributeValue[] = [...fixture.attributes].reverse();
    const straight = readCase(fixture);
    const reversed = readHairAffordances({
      attributes: shuffled,
      payload: fixture.payload,
      perception: fixture.perception,
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(straight));
  });

  it("does not depend on the order phenomena were registered in", () => {
    const reordered: RegisteredAffordanceDomain = registerAffordanceDomain({
      ...hairDomainDefinition,
      phenomena: [...hairPhenomena].reverse(),
    });
    const fixture = saturatedDenseNeckContact();
    const forward = readCase(fixture);
    const backward = readWithDomains(fixture, [reordered]);
    const sorted = (result: AffordanceRead) =>
      [...result.observations].map((observation) => observation.id).sort();
    expect(reordered.phenomenonIds).toHaveLength(hairPhenomena.length);
    expect(sorted(backward)).toEqual(sorted(forward));
    expect([...backward.suppressed].map((entry) => entry.code).sort()).toEqual(
      [...forward.suppressed].map((entry) => entry.code).sort(),
    );
  });
});

describe("no raw hair vocabulary reaches a phenomenon", () => {
  it("the frame carries compiled structure only — every structural enum value stops at the profile", () => {
    const capture: { frame?: string } = {};
    const probe = defineAffordancePhenomenon<HairAffordanceFrame, HairAffordanceFrame>({
      id: "hair.probe",
      dependencies: [],
      selectInput: (frame) => frame,
      resolve: (frame) => {
        capture.frame = JSON.stringify(frame);
        return { kind: "suppressed", phenomenonId: "hair.probe", code: "probe" };
      },
    });
    const withProbe = registerAffordanceDomain({ ...hairDomainDefinition, phenomena: [...hairPhenomena, probe] });
    readWithDomains(saturatedDenseNeckContact(), [withProbe]);

    expect(capture.frame).toBeDefined();
    for (const axis of hairAttributeAxes) {
      for (const value of Object.keys(axis.values)) {
        expect(capture.frame, `${axis.attributeId}="${value}" leaked into the frame`).not.toContain(`"${value}"`);
      }
    }
    // Presentation state legitimately does carry its own arrangement vocabulary.
    expect(capture.frame).toContain('"arrangement":"loose"');
  });
});

describe("the frame a resolver receives is genuinely frozen", () => {
  it("hands out a nominalReach that cannot be written to — ReadonlySet enforced, not just declared", () => {
    const capture: { reach?: ReadonlySet<string> } = {};
    const probe = defineAffordancePhenomenon<HairAffordanceFrame, HairAffordanceFrame>({
      id: "hair.freeze_probe",
      dependencies: [],
      selectInput: (frame) => frame,
      resolve: (frame) => {
        capture.reach = frame.profile.nominalReach;
        return { kind: "suppressed", phenomenonId: "hair.freeze_probe", code: "probe" };
      },
    });
    const withProbe = registerAffordanceDomain({ ...hairDomainDefinition, phenomena: [...hairPhenomena, probe] });
    readWithDomains(saturatedDenseNeckContact(), [withProbe]);

    const reach = capture.reach;
    expect(reach).toBeDefined();
    // Reads are untouched — reach is still the thing adhesion consults.
    expect(reach?.has("neck")).toBe(true);
    // Writes are not. The reach table is a module-level singleton shared by every
    // read, so `Object.freeze` alone would let one resolver reshape every later
    // subject's anatomy.
    expect(() => (reach as Set<string>).add("thighs")).toThrow(TypeError);
    expect(() => (reach as Set<string>).delete("neck")).toThrow(TypeError);
    expect(() => (reach as Set<string>).clear()).toThrow(TypeError);
    expect(reach?.has("thighs")).toBe(false);
    expect(reach?.has("neck")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe("degradation", () => {
  const fixture = () => saturatedDenseNeckContact();

  it("missing hair structure suppresses the whole domain with a diagnostic", () => {
    for (const missing of hairRequiredAttributeIds) {
      const sink = new DiagnosticCollector();
      const base = fixture();
      const result = readHairAffordances({
        attributes: base.attributes.filter((value) => value.id !== missing),
        payload: base.payload,
        perception: base.perception,
        sink,
      });
      expect(result.observations, missing).toEqual([]);
      expect(result.suppressed.map((entry) => entry.code)).toEqual(
        hairPhenomena.map(() => AFFORDANCE_SUPPRESSED_NO_PROFILE),
      );
      expectDiagnostic(sink, AFFORDANCE_INPUT_UNAVAILABLE);
    }
  });

  it("no lane payload at all is silence, never assumed-dry hair", () => {
    const sink = new DiagnosticCollector();
    const base = fixture();
    const result = readHairAffordances({
      attributes: base.attributes,
      payload: undefined,
      perception: base.perception,
      sink,
    });
    expect(result.observations).toEqual([]);
    expect(result.suppressed.every((entry) => entry.code === AFFORDANCE_INPUT_UNAVAILABLE)).toBe(true);
    expectDiagnostic(sink, AFFORDANCE_INPUT_UNAVAILABLE);
  });

  it("a malformed payload is invalid, not empty", () => {
    const sink = new DiagnosticCollector();
    const base = fixture();
    const result = readHairAffordances({
      attributes: base.attributes,
      payload: "the hair is quite wet",
      perception: base.perception,
      sink,
    });
    expect(result.observations).toEqual([]);
    expect(result.suppressed.every((entry) => entry.code === AFFORDANCE_INPUT_INVALID)).toBe(true);
    expectDiagnostic(sink, AFFORDANCE_INPUT_INVALID);
  });

  it("an unparsable wetness suppresses the domain rather than reading as dry", () => {
    const sink = new DiagnosticCollector();
    const base = fixture();
    const result = readHairAffordances({
      attributes: base.attributes,
      payload: { ...base.payload, wetness: "soaked" },
      perception: base.perception,
      sink,
    });
    expect(result.observations).toEqual([]);
    expectDiagnostic(sink, AFFORDANCE_INPUT_INVALID);
  });

  it("unknown coverage fails closed, and an unset arrangement is never assumed loose", () => {
    const base = fixture();
    for (const broken of [
      { attributes: base.attributes, payload: { wetness: 9_500 } },
      { attributes: base.attributes.filter((value) => value.id !== "hair.arrangement"), payload: base.payload },
    ]) {
      const sink = new DiagnosticCollector();
      const result = readHairAffordances({ ...broken, perception: base.perception, sink });
      expect(result.observations).toEqual([]);
      expect(result.suppressed.every((entry) => entry.code === AFFORDANCE_INPUT_UNAVAILABLE)).toBe(true);
      expectDiagnostic(sink, AFFORDANCE_INPUT_UNAVAILABLE);
    }
  });

  it("an observer who cannot see gets nothing, however much is physically true", () => {
    const base = fixture();
    const result = readHairAffordances({
      attributes: base.attributes,
      payload: base.payload,
      perception: { exposure: { hair: "visible", neck: "visible" }, channels: {} },
    });
    expect(result.observations).toEqual([]);
    expect(result.cues).toEqual([]);
  });
});
