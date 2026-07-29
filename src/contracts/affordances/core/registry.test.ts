import { describe, expect, it } from "vitest";
import { attributeRegistry } from "../../attributes";
import { expectRefsResolve, expectUniqueBy } from "@/test/registry-invariants";
import {
  axisContributionFor,
  defineAffordancePhenomenon,
  defineAttributeAxis,
  registerAffordanceDomain,
  validateAxisSet,
  AFFORDANCE_AXIS_PROVISIONAL,
  type AttributeAxisSetMember,
} from "./registry";
import {
  adapterSupported,
  deepFreeze,
  resolvedAttributeSnapshot,
  type AffordanceDomainDefinition,
  type AffordanceResolutionContext,
  type AffordanceStateSnapshot,
  type DomainFrame,
} from "./types";

/**
 * Definition-time validation. Everything here runs at module load, so every
 * failure is a THROW: a mistyped attribute id or a double-owned profile path is
 * a bug in a definition file, and discovering it as silent nothing in
 * production is exactly what this layer exists to prevent.
 *
 * The axes below deliberately use ordinary registry attributes (`eyes.*`,
 * `voice.*`) — the core must be provable without any domain existing.
 */

interface ToneContribution {
  readonly scale: number;
}

const colorAxis = defineAttributeAxis<"green" | "blue", ToneContribution>({
  attributeId: "eyes.color",
  version: 1,
  ownedPaths: ["tone.scale"],
  values: { green: { scale: 4_000 }, blue: { scale: 7_000 } },
});

const pupilAxis = defineAttributeAxis<"round" | "vertical_slit", ToneContribution>({
  attributeId: "eyes.pupil",
  version: 2,
  ownedPaths: ["tone.edge"],
  values: { round: { scale: 1_000 }, vertical_slit: { scale: 9_000 } },
});

describe("defineAttributeAxis", () => {
  it("accepts a real attribute mapping real vocabulary", () => {
    expect(colorAxis.attributeId).toBe("eyes.color");
    expectRefsResolve<AttributeAxisSetMember>(
      [colorAxis, pupilAxis],
      (axis) => [axis.attributeId],
      (id) => attributeRegistry.byId(id),
    );
  });

  it("refuses an attribute the registry does not know", () => {
    expect(() =>
      defineAttributeAxis<"green", ToneContribution>({
        attributeId: "eyes.colour",
        version: 1,
        ownedPaths: ["tone.scale"],
        values: { green: { scale: 1 } },
      }),
    ).toThrow(/unknown attribute/);
  });

  it("refuses a value outside allowedValues", () => {
    expect(() =>
      defineAttributeAxis<"chartreuse", ToneContribution>({
        attributeId: "eyes.color",
        version: 1,
        ownedPaths: ["tone.scale"],
        values: { chartreuse: { scale: 1 } },
      }),
    ).toThrow(/not in allowedValues/);
  });

  it("refuses a text attribute — free text cannot drive mechanics", () => {
    expect(() =>
      defineAttributeAxis<"soft coastal lilt", ToneContribution>({
        attributeId: "voice.accent",
        version: 1,
        ownedPaths: ["tone.scale"],
        values: { "soft coastal lilt": { scale: 1 } },
      }),
    ).toThrow(/free text/);
  });

  it("refuses a non-positive or fractional version", () => {
    for (const version of [0, -1, 1.5]) {
      expect(() =>
        defineAttributeAxis<"green", ToneContribution>({
          attributeId: "eyes.color",
          version,
          ownedPaths: ["tone.scale"],
          values: { green: { scale: 1 } },
        }),
      ).toThrow(/positive integer/);
    }
  });

  it("refuses an axis that owns no profile path", () => {
    expect(() =>
      defineAttributeAxis<"green", ToneContribution>({
        attributeId: "eyes.color",
        version: 1,
        ownedPaths: [],
        values: { green: { scale: 1 } },
      }),
    ).toThrow(/owns no profile path/);
  });

  it("runs the caller's contribution bounds check", () => {
    const bounded = (contribution: ToneContribution): string | null =>
      contribution.scale >= 0 && contribution.scale <= 10_000 ? null : "out of unit range";
    expect(() =>
      defineAttributeAxis<"green", ToneContribution>(
        { attributeId: "eyes.color", version: 1, ownedPaths: ["tone.scale"], values: { green: { scale: 99_999 } } },
        bounded,
      ),
    ).toThrow(/out of unit range/);
  });
});

describe("validateAxisSet", () => {
  it("passes a set with disjoint owned paths", () => {
    expect(validateAxisSet([colorAxis, pupilAxis])).toEqual([]);
  });

  it("refuses two owners for one exclusive path", () => {
    const rival = defineAttributeAxis<"round", ToneContribution>({
      attributeId: "eyes.pupil",
      version: 1,
      ownedPaths: ["tone.scale"],
      values: { round: { scale: 1 } },
    });
    expect(() => validateAxisSet([colorAxis, rival])).toThrow(/owned by both/);
  });

  it("surfaces a provisional mapping as a diagnostic instead of dropping it", () => {
    const provisional = defineAttributeAxis<"green", ToneContribution>({
      attributeId: "eyes.color",
      version: 1,
      ownedPaths: ["tone.scale"],
      values: { green: { scale: 1 } },
      provisional: true,
    });
    const diagnostics = validateAxisSet([provisional]);
    expect(diagnostics.map((entry) => entry.code)).toEqual([AFFORDANCE_AXIS_PROVISIONAL]);
    expect(diagnostics[0]?.severity).toBe("info");
  });
});

describe("axisContributionFor", () => {
  const attributes = resolvedAttributeSnapshot([
    { id: "eyes.color", value: "green", source: "creation" },
    { id: "eyes.pupil", value: "goat", source: "creation" },
  ]);

  it("maps a resolved value through the axis table", () => {
    expect(axisContributionFor(colorAxis, attributes)).toEqual({ value: "green", contribution: { scale: 4_000 } });
  });

  it("omits an unmapped value rather than guessing a neighbour", () => {
    expect(axisContributionFor(pupilAxis, attributes)).toBeUndefined();
  });

  it("omits an unset attribute", () => {
    expect(axisContributionFor(colorAxis, resolvedAttributeSnapshot([]))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phenomenon and domain registration
// ---------------------------------------------------------------------------

type ProbeProfile = { readonly tone: number };
type ProbeMechanics = { readonly capacity: number };
type ProbeState = AffordanceStateSnapshot;
type ProbeContext = AffordanceResolutionContext;
type ProbeFrame = DomainFrame<ProbeProfile, ProbeMechanics>;

const probePhenomenon = (id: string) =>
  defineAffordancePhenomenon<ProbeFrame, Pick<ProbeFrame, "mechanics">>({
    id,
    dependencies: [],
    selectInput: (frame) => ({ mechanics: frame.mechanics }),
    resolve: () => ({ kind: "suppressed", phenomenonId: id, code: "probe" }),
  });

function probeDomain(
  overrides: Partial<AffordanceDomainDefinition<ProbeProfile, ProbeMechanics, ProbeState, ProbeContext, ProbeFrame>>,
): AffordanceDomainDefinition<ProbeProfile, ProbeMechanics, ProbeState, ProbeContext, ProbeFrame> {
  return {
    id: "probe",
    requiredAttributeIds: ["eyes.color"],
    readInputs: (request) =>
      adapterSupported({
        state: { subjectId: request.subjectId, storyTime: request.storyTime, inputs: {}, evidence: [] },
        context: { subjectId: request.subjectId, storyTime: request.storyTime },
      }),
    compileProfile: () => ({ profile: { tone: 1 }, evidence: [], diagnostics: [] }),
    deriveMechanics: () => ({ mechanics: { capacity: 1 }, evidence: [], diagnostics: [] }),
    buildFrame: (profile, mechanics, context) => ({
      subjectId: context.subjectId,
      storyTime: context.storyTime,
      profile,
      mechanics,
      evidence: [],
    }),
    phenomena: [probePhenomenon("probe.one")],
    ...overrides,
  };
}

/**
 * `Object.freeze` seals own properties only, so a `Set`/`Map` reached through a
 * frame would stay writable through its internal slots — a `ReadonlySet` field
 * that is read-only to the compiler and wide open at runtime. These cases pin
 * the collection handling, and the totality the frozen-input law depends on.
 */
describe("deepFreeze", () => {
  it("blocks every Set mutator while leaving reads intact", () => {
    const set = deepFreeze(new Set(["neck", "shoulders"]));
    expect(() => set.add("thighs")).toThrow(TypeError);
    expect(() => set.add("thighs")).toThrow(/deepFreeze/);
    expect(() => set.delete("neck")).toThrow(TypeError);
    expect(() => set.clear()).toThrow(TypeError);

    expect(set.has("neck")).toBe(true);
    expect(set.has("thighs")).toBe(false);
    expect(set.size).toBe(2);
    expect([...set]).toEqual(["neck", "shoulders"]);
    expect(Object.isFrozen(set)).toBe(true);
  });

  it("blocks every Map mutator while leaving reads intact", () => {
    const map = deepFreeze(new Map([["neck", 1]]));
    expect(() => map.set("neck", 2)).toThrow(TypeError);
    expect(() => map.set("hips", 3)).toThrow(/deepFreeze/);
    expect(() => map.delete("neck")).toThrow(TypeError);
    expect(() => map.clear()).toThrow(TypeError);

    expect(map.get("neck")).toBe(1);
    expect(map.has("hips")).toBe(false);
    expect(map.size).toBe(1);
    expect([...map.entries()]).toEqual([["neck", 1]]);
  });

  it("descends into collection elements, keys, and values", () => {
    const element = { depth: 1 };
    const key = { id: "k" };
    const nested = { set: new Set([element]), map: new Map([[key, { depth: 2 }]]) };
    deepFreeze(nested);

    expect(Object.isFrozen(nested.set)).toBe(true);
    expect(Object.isFrozen(element)).toBe(true);
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.isFrozen(nested.map.get(key))).toBe(true);
    expect(() => nested.set.add({ depth: 3 })).toThrow(TypeError);
  });

  it("terminates on cyclic structures, collections included", () => {
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    expect(deepFreeze(cyclicObject)).toBe(cyclicObject);

    const cyclicSet = new Set<unknown>();
    cyclicSet.add(cyclicSet);
    expect(deepFreeze(cyclicSet)).toBe(cyclicSet);
    expect(() => cyclicSet.add("more")).toThrow(TypeError);

    const cyclicMap = new Map<unknown, unknown>();
    cyclicMap.set(cyclicMap, cyclicMap);
    expect(deepFreeze(cyclicMap)).toBe(cyclicMap);
  });

  it("is total — non-objects and already-frozen values pass through untouched", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
    expect(deepFreeze(7)).toBe(7);
    expect(deepFreeze("wet")).toBe("wet");
    const once = deepFreeze(new Set(["neck"]));
    expect(deepFreeze(once)).toBe(once);
  });
});

describe("defineAffordancePhenomenon", () => {
  it("freezes the selected input — a resolver that writes fails loudly", () => {
    const mutating = defineAffordancePhenomenon<ProbeFrame, ProbeMechanics>({
      id: "probe.mutate",
      dependencies: [],
      selectInput: (frame) => frame.mechanics,
      resolve: (input) => {
        (input as { capacity: number }).capacity = 0;
        return { kind: "suppressed", phenomenonId: "probe.mutate", code: "unreachable" };
      },
    });
    const frame: ProbeFrame = {
      subjectId: "s1" as ProbeFrame["subjectId"],
      storyTime: 0,
      profile: { tone: 1 },
      mechanics: { capacity: 5 },
      evidence: [],
    };
    expect(() => mutating.resolveFrame(frame)).toThrow(TypeError);
    expect(frame.mechanics.capacity).toBe(5);
  });
});

describe("registerAffordanceDomain", () => {
  it("registers a well-formed domain and reports its phenomena", () => {
    const registered = registerAffordanceDomain(
      probeDomain({ phenomena: [probePhenomenon("probe.one"), probePhenomenon("probe.two")] }),
    );
    expect(registered.id).toBe("probe");
    expect(registered.phenomenonIds).toEqual(["probe.one", "probe.two"]);
    expectUniqueBy(registered.phenomenonIds, (id) => id, "probe phenomena");
  });

  it("refuses a domain id that is not one lowercase segment", () => {
    expect(() => registerAffordanceDomain(probeDomain({ id: "Probe.Domain" }))).toThrow(/snake_case segment/);
  });

  it("refuses a phenomenon that is not prefixed by its domain", () => {
    expect(() => registerAffordanceDomain(probeDomain({ phenomena: [probePhenomenon("other.one")] }))).toThrow(
      /registered under domain/,
    );
  });

  it("refuses an undotted phenomenon id", () => {
    expect(() => registerAffordanceDomain(probeDomain({ phenomena: [probePhenomenon("probe")] }))).toThrow(
      /<domain>\.<snake_case>/,
    );
  });

  it("refuses duplicate phenomenon ids", () => {
    expect(() =>
      registerAffordanceDomain(probeDomain({ phenomena: [probePhenomenon("probe.one"), probePhenomenon("probe.one")] })),
    ).toThrow(/Duplicate affordance phenomenon/);
  });

  it("refuses a required attribute the registry does not know", () => {
    expect(() => registerAffordanceDomain(probeDomain({ requiredAttributeIds: ["eyes.colour"] }))).toThrow(
      /unknown attribute/,
    );
  });
});
