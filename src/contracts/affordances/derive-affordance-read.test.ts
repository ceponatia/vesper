import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DiagnosticCollector } from "../diagnostics";
import type { AttributeValue } from "../attributes";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { expectUniqueBy } from "@/test/registry-invariants";
import {
  adapterInputStatuses,
  adapterInvalid,
  adapterReadEvidence,
  adapterSupported,
  adapterUnavailable,
  affordanceEvidence,
  affordancePerceptionView,
  affordanceSubjectId,
  axisContributionFor,
  complementUnit,
  defineAffordancePhenomenon,
  defineAttributeAxis,
  emptyAffordanceCueState,
  multiplyUnits,
  registerAffordanceDomain,
  resolvedAttributeSnapshot,
  toUnitInterval,
  unitIntervalSchema,
  validateAxisSet,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
  AFFORDANCE_PERCEPTION_HIDDEN,
  AFFORDANCE_SUPPRESSED_NO_PROFILE,
  AFFORDANCE_UNIT_ONE,
  type AdapterRead,
  type AffordanceDomainDefinition,
  type AffordanceExposure,
  type AffordanceIntensityBand,
  type AffordanceResolutionContext,
  type AffordanceStateSnapshot,
  type DomainFrame,
  type RegisteredAffordancePhenomenon,
  type UnitInterval,
} from "./core";
import { affordanceDomains } from "./domains";
import { deriveAffordanceRead, type AffordanceRead } from "./derive-affordance-read";

/**
 * The staged runner, proved against a SYNTHETIC domain defined here and nowhere
 * else. That is the point of the exercise: if the core can stage, suppress,
 * filter, and rank a domain it has never heard of — one built from ordinary
 * `eyes.*` attributes — then it is not secretly shaped around hair.
 *
 * The fixture models a made-up "probe" surface: a tone compiled from eye color,
 * a current load that damps it, and an impulse that must actually exist before
 * anything is said to flare.
 */

// ---------------------------------------------------------------------------
// The synthetic domain
// ---------------------------------------------------------------------------

interface ToneContribution {
  readonly scale: UnitInterval;
}

const toneAxis = defineAttributeAxis<"green" | "blue", ToneContribution>(
  {
    attributeId: "eyes.color",
    version: 1,
    ownedPaths: ["probe.tone"],
    values: { green: { scale: toUnitInterval(4_000) }, blue: { scale: toUnitInterval(9_000) } },
  },
  (contribution) => (unitIntervalSchema.safeParse(contribution.scale).success ? null : "scale is not a unit"),
);

interface ProbeProfile {
  readonly tone: UnitInterval;
}

interface ProbeMechanics {
  readonly capacity: UnitInterval;
}

interface ProbeState extends AffordanceStateSnapshot {
  readonly load: UnitInterval;
}

interface ProbeContext extends AffordanceResolutionContext {
  /** `null` when no impulse was asserted — never a zero standing in for one. */
  readonly impulse: UnitInterval | null;
  readonly locationId: string;
  readonly targetLocationId: string;
}

interface ProbeFrame extends DomainFrame<ProbeProfile, ProbeMechanics> {
  readonly impulse: UnitInterval | null;
  readonly locationId: string;
  readonly targetLocationId: string;
}

const payloadSchema = z.object({ load: z.unknown().optional(), impulse: z.unknown().optional() });

/** One lane input, under the adapter result law. */
function readUnit(raw: unknown, key: string): AdapterRead<UnitInterval> {
  if (raw === undefined) return adapterUnavailable;
  const parsed = unitIntervalSchema.safeParse(raw);
  return parsed.success
    ? adapterSupported(parsed.data, [affordanceEvidence("state", key, String(parsed.data))])
    : adapterInvalid;
}

function bandFor(capacity: UnitInterval): AffordanceIntensityBand | null {
  if (capacity >= 7_000) return "strong";
  if (capacity >= 4_000) return "clear";
  if (capacity >= 1_000) return "subtle";
  return null;
}

const glow = defineAffordancePhenomenon<ProbeFrame, Pick<ProbeFrame, "mechanics" | "locationId">>({
  id: "probe.glow",
  dependencies: [{ key: "load" }],
  selectInput: (frame) => ({ mechanics: frame.mechanics, locationId: frame.locationId }),
  resolve: (input) => {
    const band = bandFor(input.mechanics.capacity);
    if (band === null) {
      return { kind: "suppressed", phenomenonId: "probe.glow", code: "below_response_threshold" };
    }
    return {
      kind: "observation",
      id: "probe.glow",
      sourceLocationId: input.locationId,
      intensityBand: band,
      semanticTags: ["glow"],
      repeatKey: "probe:glow",
    };
  },
});

const flare = defineAffordancePhenomenon<
  ProbeFrame,
  Pick<ProbeFrame, "mechanics" | "impulse" | "locationId" | "targetLocationId">
>({
  id: "probe.flare",
  dependencies: [{ key: "load" }, { key: "impulse" }],
  selectInput: (frame) => ({
    mechanics: frame.mechanics,
    impulse: frame.impulse,
    locationId: frame.locationId,
    targetLocationId: frame.targetLocationId,
  }),
  resolve: (input) => {
    if (input.impulse === null || input.impulse === 0) {
      return { kind: "suppressed", phenomenonId: "probe.flare", code: "no_current_impulse" };
    }
    // Load constrains what a force can do: capacity gates the response, so a
    // fully loaded probe cannot flare however hard it is struck.
    if (input.mechanics.capacity < 1_000) {
      return { kind: "suppressed", phenomenonId: "probe.flare", code: "below_response_threshold" };
    }
    return {
      kind: "observation",
      id: "probe.flare",
      sourceLocationId: input.locationId,
      targetLocationId: input.targetLocationId,
      intensityBand: "clear",
      semanticTags: ["flare"],
      repeatKey: "probe:flare",
    };
  },
});

const binding = defineAffordancePhenomenon<ProbeFrame, { readonly loaded: boolean; readonly locationId: string }>({
  id: "probe.binding",
  dependencies: [{ key: "load" }],
  selectInput: (frame) => ({
    loaded: frame.mechanics.capacity < 2_000,
    locationId: frame.locationId,
  }),
  resolve: (input) =>
    input.loaded
      ? { kind: "constraint", id: "probe.binding", code: "loaded", locationId: input.locationId }
      : { kind: "suppressed", phenomenonId: "probe.binding", code: "not_loaded" },
});

/** A fourth phenomenon a domain may bolt on WITHOUT the core learning anything. */
const sheen = defineAffordancePhenomenon<ProbeFrame, Pick<ProbeFrame, "locationId">>({
  id: "probe.sheen",
  dependencies: [{ key: "load" }],
  selectInput: (frame) => ({ locationId: frame.locationId }),
  resolve: (input) => ({
    kind: "observation",
    id: "probe.sheen",
    sourceLocationId: input.locationId,
    intensityBand: "clear",
    semanticTags: ["sheen"],
    repeatKey: "probe:sheen",
  }),
});

function probeDefinition(
  extra: readonly RegisteredAffordancePhenomenon<ProbeFrame>[] = [],
): AffordanceDomainDefinition<ProbeProfile, ProbeMechanics, ProbeState, ProbeContext, ProbeFrame> {
  return {
    id: "probe",
    requiredAttributeIds: ["eyes.color"],

    compileProfile: (attributes) => {
      const tone = axisContributionFor(toneAxis, attributes);
      if (!tone) return { profile: undefined, evidence: [], diagnostics: [] };
      return {
        profile: { tone: tone.contribution.scale },
        evidence: [affordanceEvidence("attribute", toneAxis.attributeId, tone.value)],
        diagnostics: [...validateAxisSet([toneAxis])],
      };
    },

    readInputs: (request) => {
      if (request.payload === undefined) return adapterUnavailable;
      const payload = payloadSchema.safeParse(request.payload);
      if (!payload.success) return adapterInvalid;
      const reads = { load: readUnit(payload.data.load, "load"), impulse: readUnit(payload.data.impulse, "impulse") };
      // The load is structural for this domain: without it there is no mechanics
      // to derive, so its failure is the whole domain's failure — not a zero.
      if (reads.load.status !== "supported") {
        return reads.load.status === "invalid" ? adapterInvalid : adapterUnavailable;
      }
      return adapterSupported({
        state: {
          subjectId: request.subjectId,
          storyTime: request.storyTime,
          inputs: adapterInputStatuses(reads),
          evidence: adapterReadEvidence(reads),
          load: reads.load.value,
        },
        context: {
          subjectId: request.subjectId,
          storyTime: request.storyTime,
          impulse: reads.impulse.status === "supported" ? reads.impulse.value : null,
          locationId: "eyes",
          targetLocationId: "face",
        },
      });
    },

    deriveMechanics: (profile, state) => ({
      mechanics: { capacity: multiplyUnits(profile.tone, complementUnit(state.load)) },
      evidence: [affordanceEvidence("adapter", "probe.mechanics")],
      diagnostics: [],
    }),

    buildFrame: (profile, mechanics, context) => ({
      subjectId: context.subjectId,
      storyTime: context.storyTime,
      profile,
      mechanics,
      evidence: [affordanceEvidence("adapter", "probe.frame")],
      impulse: context.impulse,
      locationId: context.locationId,
      targetLocationId: context.targetLocationId,
    }),

    phenomena: [glow, flare, binding, ...extra],
  };
}

const probe = registerAffordanceDomain(probeDefinition());

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SUBJECT = affordanceSubjectId("subject_1");

const attributesOf = (values: readonly AttributeValue[]) => resolvedAttributeSnapshot(values);

const GREEN_EYES: readonly AttributeValue[] = [
  { id: "eyes.color", value: "green", source: "creation" },
  { id: "eyes.pupil", value: "round", source: "creation" },
];

const BLUE_EYES: readonly AttributeValue[] = [{ id: "eyes.color", value: "blue", source: "creation" }];

const seen = (exposure: Record<string, AffordanceExposure> = { eyes: "visible", face: "visible" }) =>
  affordancePerceptionView({ exposure, channels: { sight: "available" } });

function read(input: {
  attributes?: readonly AttributeValue[];
  payload?: unknown;
  exposure?: Record<string, AffordanceExposure>;
  previousCues?: AffordanceRead["nextCues"];
  domains?: readonly (typeof probe)[];
  sink?: DiagnosticCollector;
  storyTime?: number;
}): AffordanceRead {
  return deriveAffordanceRead({
    subjectId: SUBJECT,
    storyTime: input.storyTime ?? 0,
    attributes: attributesOf(input.attributes ?? BLUE_EYES),
    perception: seen(input.exposure),
    domains: input.domains ?? [probe],
    payloads: { probe: input.payload ?? { load: 0, impulse: 5_000 } },
    previousCues: input.previousCues ?? emptyAffordanceCueState(),
    sink: input.sink,
  });
}

const idsOf = (read: AffordanceRead): string[] => read.observations.map((entry) => entry.id);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the shipped registry", () => {
  it("is empty — slice 1 ships the core disconnected from the narrator", () => {
    expect(affordanceDomains).toEqual([]);
    const empty = deriveAffordanceRead({
      subjectId: SUBJECT,
      storyTime: 0,
      attributes: attributesOf(BLUE_EYES),
      perception: seen(),
    });
    expect(empty.observations).toEqual([]);
    expect(empty.cues).toEqual([]);
    expect(empty.diagnostics).toEqual([]);
  });
});

describe("the staged pipeline", () => {
  it("compiles profile → mechanics → frame → phenomena and offers ranked cues", () => {
    const sink = new DiagnosticCollector();
    const result = read({ sink });
    expect(idsOf(result)).toEqual(["probe.glow", "probe.flare"]);
    expect(result.observations[0]?.intensityBand).toBe("strong");
    expect(result.cues.map((cue) => cue.repeatKey)).toEqual(["probe:glow", "probe:flare"]);
    expect(result.suppressed.map((entry) => entry.phenomenonId)).toEqual(["probe.binding"]);
    expectCleanSink(sink);
  });

  it("carries provenance from every stage, deduped", () => {
    const result = read({});
    expect(result.evidence).toEqual([
      { kind: "attribute", ref: "eyes.color", detail: "blue" },
      { kind: "state", ref: "load", detail: "0" },
      { kind: "state", ref: "impulse", detail: "5000" },
      { kind: "adapter", ref: "probe.mechanics" },
      { kind: "adapter", ref: "probe.frame" },
    ]);
  });

  it("emits a constraint when the mechanics say the effect is held down", () => {
    const result = read({ payload: { load: AFFORDANCE_UNIT_ONE, impulse: 5_000 } });
    expect(result.observations).toEqual([]);
    expect(result.constraints).toEqual([{ kind: "constraint", id: "probe.binding", code: "loaded", locationId: "eyes" }]);
  });

  it("is byte-stable: the same committed cut replays identically", () => {
    const first = read({ storyTime: 12 });
    const second = read({ storyTime: 12 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("profile compilation", () => {
  it("is deterministic and independent of the order attributes arrive in", () => {
    const shuffled: readonly AttributeValue[] = [...GREEN_EYES].reverse();
    const definition = probeDefinition();
    expect(definition.compileProfile(attributesOf(shuffled))).toEqual(
      definition.compileProfile(attributesOf(GREEN_EYES)),
    );
    expect(JSON.stringify(read({ attributes: shuffled }))).toBe(JSON.stringify(read({ attributes: GREEN_EYES })));
  });

  it("absent required structure suppresses the domain without failing the cut", () => {
    const sink = new DiagnosticCollector();
    const result = read({ attributes: [{ id: "eyes.pupil", value: "round", source: "creation" }], sink });
    expect(result.observations).toEqual([]);
    expect(result.suppressed.map((entry) => entry.code)).toEqual([
      AFFORDANCE_SUPPRESSED_NO_PROFILE,
      AFFORDANCE_SUPPRESSED_NO_PROFILE,
      AFFORDANCE_SUPPRESSED_NO_PROFILE,
    ]);
    expectDiagnostic(sink, AFFORDANCE_INPUT_UNAVAILABLE);
  });
});

describe("phenomenon inputs", () => {
  const capture: { input?: unknown } = {};
  const probeCapture = defineAffordancePhenomenon<ProbeFrame, Pick<ProbeFrame, "mechanics" | "profile">>({
    id: "probe.capture",
    dependencies: [],
    selectInput: (frame) => ({ mechanics: frame.mechanics, profile: frame.profile }),
    resolve: (input) => {
      capture.input = input;
      return { kind: "suppressed", phenomenonId: "probe.capture", code: "probe" };
    },
  });
  const withCapture = registerAffordanceDomain(probeDefinition([probeCapture]));

  it("never carries raw attribute vocabulary into a phenomenon", () => {
    read({ attributes: GREEN_EYES, domains: [withCapture] });
    expect(capture.input).toBeDefined();
    // "green" compiled into a tone at the profile stage and stops there.
    expect(JSON.stringify(capture.input)).not.toContain("green");
    expect(JSON.stringify(capture.input)).toBe(JSON.stringify({ mechanics: { capacity: 4_000 }, profile: { tone: 4_000 } }));
  });

  it("hands the resolver a deep-frozen input", () => {
    read({ domains: [withCapture] });
    const input = capture.input as { mechanics: { capacity: number } };
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.mechanics)).toBe(true);
    expect(() => {
      input.mechanics.capacity = 0;
    }).toThrow(TypeError);
  });

  it("a domain can add a phenomenon without editing the generic core", () => {
    const extended = registerAffordanceDomain(probeDefinition([sheen]));
    expectUniqueBy(extended.phenomenonIds, (id) => id, "extended probe");
    const result = read({ domains: [extended] });
    expect(idsOf(result)).toEqual(["probe.glow", "probe.flare", "probe.sheen"]);
  });
});

describe("the adapter result law", () => {
  it("no payload at all — every phenomenon suppressed, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = deriveAffordanceRead({
      subjectId: SUBJECT,
      storyTime: 0,
      attributes: attributesOf(BLUE_EYES),
      perception: seen(),
      domains: [probe],
      sink,
    });
    expect(result.observations).toEqual([]);
    expect(result.suppressed.every((entry) => entry.code === AFFORDANCE_INPUT_UNAVAILABLE)).toBe(true);
    expectDiagnostic(sink, AFFORDANCE_INPUT_UNAVAILABLE);
  });

  it("a malformed payload is invalid, not empty — nothing is inferred from the wreckage", () => {
    const sink = new DiagnosticCollector();
    const result = read({ payload: "load: quite a lot", sink });
    expect(result.observations).toEqual([]);
    expect(result.suppressed.every((entry) => entry.code === AFFORDANCE_INPUT_INVALID)).toBe(true);
    expectDiagnostic(sink, AFFORDANCE_INPUT_INVALID);
  });

  it("an unavailable dependency suppresses only its phenomenon, and never reads as zero", () => {
    const sink = new DiagnosticCollector();
    const result = read({ payload: { load: 0 }, sink });
    expect(idsOf(result)).toEqual(["probe.glow"]);
    // The CORE suppressed it: the code is the input law's, not the domain's
    // `no_current_impulse` — the resolver never ran, so a missing impulse could
    // not have been mistaken for a zero one.
    expect(result.suppressed.find((entry) => entry.phenomenonId === "probe.flare")).toEqual({
      kind: "suppressed",
      phenomenonId: "probe.flare",
      code: AFFORDANCE_INPUT_UNAVAILABLE,
      detail: "impulse",
    });
    expectDiagnostic(sink, AFFORDANCE_INPUT_UNAVAILABLE);
  });

  it("an invalid dependency suppresses with the invalid code", () => {
    const sink = new DiagnosticCollector();
    const result = read({ payload: { load: 0, impulse: "a strong one" }, sink });
    expect(idsOf(result)).toEqual(["probe.glow"]);
    expect(result.suppressed.find((entry) => entry.phenomenonId === "probe.flare")?.code).toBe(AFFORDANCE_INPUT_INVALID);
    expectDiagnostic(sink, AFFORDANCE_INPUT_INVALID);
  });

  it("a present-but-zero force is the domain's call, and reads as silence too", () => {
    const result = read({ payload: { load: 0, impulse: 0 } });
    expect(result.suppressed.find((entry) => entry.phenomenonId === "probe.flare")?.code).toBe("no_current_impulse");
  });
});

describe("perception and cues", () => {
  it("physically present but hidden never reaches a cue — or the cue memory", () => {
    const result = read({ exposure: { eyes: "visible", face: "hidden" } });
    expect(idsOf(result)).toEqual(["probe.glow"]);
    expect(result.suppressed).toContainEqual({
      kind: "suppressed",
      phenomenonId: "probe.flare",
      code: AFFORDANCE_PERCEPTION_HIDDEN,
      detail: "face",
    });
    expect(result.cues.map((cue) => cue.repeatKey)).toEqual(["probe:glow"]);
    expect(Object.keys(result.nextCues.bands)).toEqual(["probe:glow"]);
  });

  it("an observer who cannot see gets nothing at all", () => {
    const result = deriveAffordanceRead({
      subjectId: SUBJECT,
      storyTime: 0,
      attributes: attributesOf(BLUE_EYES),
      perception: affordancePerceptionView({ exposure: { eyes: "visible", face: "visible" } }),
      domains: [probe],
      payloads: { probe: { load: 0, impulse: 5_000 } },
    });
    expect(result.observations).toEqual([]);
    expect(result.cues).toEqual([]);
  });

  it("caps cues at two while keeping every observation available", () => {
    const result = read({ domains: [registerAffordanceDomain(probeDefinition([sheen]))] });
    expect(result.observations).toHaveLength(3);
    expect(result.cues).toHaveLength(2);
    expect(Object.keys(result.nextCues.bands)).toHaveLength(3);
  });

  it("repeats fall silent while the read itself stays true", () => {
    const first = read({});
    const second = read({ previousCues: first.nextCues });
    expect(second.cues).toEqual([]);
    expect(idsOf(second)).toEqual(["probe.glow", "probe.flare"]);

    // A band change re-opens exactly one slot.
    const moved = read({ payload: { load: 5_000, impulse: 5_000 }, previousCues: second.nextCues });
    expect(moved.cues.map((cue) => cue.repeatKey)).toEqual(["probe:glow"]);
  });
});
