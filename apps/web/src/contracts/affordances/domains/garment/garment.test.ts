import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../../diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";
import { effectiveCoverageAt, effectiveCoverageReadSchema } from "../../../items/effective-coverage-read";
import {
  affordanceSubjectId,
  resolvedAttributeSnapshot,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
  AFFORDANCE_SUPPRESSED_NO_PROFILE,
  type RegisteredAffordanceDomain,
} from "../../core";
import { affordanceDomains } from "../../domains";
import { deriveAffordanceRead, type AffordanceRead } from "../../derive-affordance-read";
import { hairAffordanceDomain } from "../hair/domain";
import { garmentAffordanceDomain, garmentDomainDefinition, GARMENT_DOMAIN_ID } from "./domain";
import { deriveGarmentEffectiveCoverage } from "./effective-coverage";
import { garmentContactsFromFit } from "./frame";
import { compileGarmentProfile } from "./profile";
import { deriveGarmentMechanics } from "./mechanics";
import {
  fittedCottonShirtInRain,
  garmentFixtureContact,
  garmentFixturePayload,
  garmentFixtureRegion,
  garmentObserver,
  garmentWorkedCases,
  leatherJacketInRain,
  readGarmentAffordances,
  soakedCamisoleUnderCoat,
  soakedLooseSkirt,
  type GarmentFixture,
} from "./fixtures";

/**
 * The garment domain end to end — the spec's worked cases driven through
 * `deriveAffordanceRead` exactly as a lane adapter will, plus the acceptance
 * tests the garment spec lists and the second-domain proof the plan is judged on.
 */

function readCase(
  fixture: GarmentFixture,
  overrides: { sink?: DiagnosticCollector; previousCues?: AffordanceRead["nextCues"]; storyTime?: number } = {},
): AffordanceRead {
  return readGarmentAffordances({
    payload: fixture.payload,
    perception: fixture.perception,
    ...(overrides.sink === undefined ? {} : { sink: overrides.sink }),
    ...(overrides.previousCues === undefined ? {} : { previousCues: overrides.previousCues }),
    ...(overrides.storyTime === undefined ? {} : { storyTime: overrides.storyTime }),
  });
}

const ids = (result: AffordanceRead): string[] => result.observations.map((observation) => observation.id);

const observationOf = (result: AffordanceRead, id: string) =>
  result.observations.find((observation) => observation.id === id);

const codeOf = (result: AffordanceRead, phenomenonId: string): string | undefined =>
  result.suppressed.find((entry) => entry.phenomenonId === phenomenonId)?.code;

function coverageFor(fixture: GarmentFixture, atMinutes = 0) {
  const traced = garmentAffordanceDomain.trace({
    subjectId: affordanceSubjectId("garment_fixture_subject"),
    storyTime: atMinutes,
    attributes: resolvedAttributeSnapshot([]),
    payload: fixture.payload,
  });
  return deriveGarmentEffectiveCoverage({
    frame: traced.frame as Parameters<typeof deriveGarmentEffectiveCoverage>[0]["frame"],
    atMinutes,
  });
}

// ---------------------------------------------------------------------------
// Registration — the second-domain proof
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("ships in the shared registry with its three first-release phenomena", () => {
    expect(affordanceDomains.map((domain) => domain.id)).toContain(GARMENT_DOMAIN_ID);
    expect(garmentAffordanceDomain.phenomenonIds).toEqual([
      "garment.wet_surface_state",
      "garment.wet_cling",
      "garment.effective_opacity",
    ]);
  });

  it("registers the DEFERRED phenomena nowhere — wind and pose drape wait on the scene owner", () => {
    expect(garmentAffordanceDomain.phenomenonIds).not.toContain("garment.wind_or_motion_response");
    expect(garmentAffordanceDomain.phenomenonIds).not.toContain("garment.pose_drape");
  });

  /**
   * The whole point of slice 6: a domain whose structure is NOT the character's
   * rides the same registry with no attribute requirement at all.
   */
  it("requires no character attribute — its structure belongs to the wardrobe", () => {
    expect(garmentAffordanceDomain.requiredAttributeIds).toEqual([]);
  });

  it("resolves identically however the registry is ordered", () => {
    const orders: readonly (readonly RegisteredAffordanceDomain[])[] = [
      [hairAffordanceDomain, garmentAffordanceDomain],
      [garmentAffordanceDomain, hairAffordanceDomain],
    ];
    const runs = orders.map((domains) =>
      deriveAffordanceRead({
        subjectId: affordanceSubjectId("garment_fixture_subject"),
        storyTime: 0,
        attributes: resolvedAttributeSnapshot([]),
        perception: fittedCottonShirtInRain().perception,
        domains,
        payloads: { [GARMENT_DOMAIN_ID]: fittedCottonShirtInRain().payload },
      }),
    );
    expect(JSON.stringify(runs[0]?.observations)).toBe(JSON.stringify(runs[1]?.observations));
  });
});

// ---------------------------------------------------------------------------
// The worked cases
// ---------------------------------------------------------------------------

describe("fitted cotton shirt in rain", () => {
  it("darkens, goes translucent, and clings where the fit establishes contact", () => {
    const result = readCase(fittedCottonShirtInRain());
    expect(ids(result)).toEqual(
      expect.arrayContaining(["garment.wet_surface_state", "garment.effective_opacity", "garment.wet_cling"]),
    );
  });

  it("carries the rain provenance only because a committed rain event is in the frame", () => {
    const withRain = observationOf(readCase(fittedCottonShirtInRain()), "garment.wet_surface_state");
    expect(withRain?.semanticTags).toContain("recent_rain");

    const fixture = fittedCottonShirtInRain();
    const noEvent = readCase({ ...fixture, payload: { ...fixture.payload, events: [] } });
    expect(observationOf(noEvent, "garment.wet_surface_state")?.semanticTags).not.toContain("recent_rain");
  });
});

describe("leather jacket in the same rain", () => {
  /** The spec's headline acceptance test. */
  it("produces a materially DIFFERENT observation from wet cotton", () => {
    const cotton = observationOf(readCase(fittedCottonShirtInRain()), "garment.wet_surface_state");
    const leather = observationOf(readCase(leatherJacketInRain()), "garment.wet_surface_state");
    expect(cotton).toBeDefined();
    expect(leather).toBeDefined();
    expect(leather?.semanticTags).toContain("beading");
    expect(cotton?.semanticTags).not.toContain("beading");
    expect(cotton?.semanticTags.some((tag) => tag.startsWith("dark") || tag === "saturated")).toBe(true);
  });

  it("neither sheers out nor clings", () => {
    const result = readCase(leatherJacketInRain());
    expect(ids(result)).not.toContain("garment.effective_opacity");
    expect(ids(result)).not.toContain("garment.wet_cling");
    expect(codeOf(result, "garment.effective_opacity")).toBe("opacity_unchanged");
  });
});

describe("soaked loose skirt", () => {
  it("says nothing about cling — a loose garment establishes no contact", () => {
    const result = readCase(soakedLooseSkirt());
    expect(ids(result)).not.toContain("garment.wet_cling");
    expect(codeOf(result, "garment.wet_cling")).toBe("no_asserted_contact");
  });

  it("narrates no movement at all — the motion phenomena are not registered", () => {
    const result = readCase(soakedLooseSkirt());
    for (const observation of result.observations) {
      expect(observation.semanticTags).not.toContain("fluttering");
    }
    expect(result.suppressed.map((entry) => entry.phenomenonId)).not.toContain("garment.wind_or_motion_response");
  });
});

describe("soaked sheer camisole under a dry coat", () => {
  it("says nothing about the buried layer — occlusion is wardrobe truth", () => {
    const result = readCase(soakedCamisoleUnderCoat());
    for (const observation of result.observations) {
      expect(observation.semanticTags).not.toContain("garment:g_camisole");
    }
  });

  it("keeps the chest OPAQUE — a layer adds cover and never subtracts it", () => {
    const coverage = coverageFor(soakedCamisoleUnderCoat());
    expect(effectiveCoverageAt(coverage, "chest")).toBe("opaque");
    // Both layers are recorded as evidence, most-concealing first.
    const chest = coverage.entries.find((entry) => entry.locationId === "chest");
    expect(chest?.evidence.map((row) => row.garmentId)).toEqual(["g_coat", "g_camisole"]);
  });
});

// ---------------------------------------------------------------------------
// Contact establishment law
// ---------------------------------------------------------------------------

describe("the establishment law", () => {
  const profileOf = (fit: string) => {
    const compiled = compileGarmentProfile([
      { garmentId: "g", partId: "root", coveredBodyLocations: ["back", "waist"], materialClass: "knit", fit },
    ]);
    if (!compiled.profile) throw new Error("no profile");
    return compiled.profile;
  };

  it("fitted and tight garments establish ordinary contact from wardrobe truth alone", () => {
    expect(garmentContactsFromFit(profileOf("fitted")).map((contact) => contact.bodyLocationId)).toEqual([
      "back",
      "waist",
    ]);
    const tight = garmentContactsFromFit(profileOf("tight"));
    expect(tight[0]?.basis).toBe("fit");
    expect(tight[0]?.strength).toBeGreaterThan(garmentContactsFromFit(profileOf("fitted"))[0]?.strength ?? 0);
  });

  it("loose, structured, and UNRECORDED fits establish nothing", () => {
    for (const fit of ["loose", "structured", "unknown"]) {
      expect(garmentContactsFromFit(profileOf(fit))).toEqual([]);
    }
  });

  /**
   * The production silence the plan asks for: a lane that cannot establish
   * contact OMITS the key, so the core suppresses the phenomenon with the input
   * law's own code before its resolver can read an empty list as "nothing is
   * touching".
   */
  it("a lane with no contact owner is suppressed by the CORE, not by the resolver", () => {
    const sink = new DiagnosticCollector();
    const fixture = soakedLooseSkirt();
    const payload = { ...fixture.payload };
    delete (payload as { contacts?: unknown }).contacts;
    const result = readGarmentAffordances({ payload, perception: fixture.perception, sink });
    expect(codeOf(result, "garment.wet_cling")).toBe(AFFORDANCE_INPUT_UNAVAILABLE);
    expectDiagnostic(sink, AFFORDANCE_INPUT_UNAVAILABLE);
    // The other two phenomena are unaffected — an absent contact owner is not a
    // reason to stop reading a soaked skirt.
    expect(ids(result)).toContain("garment.wet_surface_state");
  });

  it("wet cling needs saturation as well as contact", () => {
    const dry = garmentFixtureRegion({
      garmentId: "g_shirt",
      materialClass: "woven_cotton_linen",
      coveredBodyLocations: ["back"],
      saturation: 0,
      fit: "fitted",
    });
    const result = readGarmentAffordances({
      payload: garmentFixturePayload([dry], {
        contacts: [garmentFixtureContact({ garmentId: "g_shirt", bodyLocationId: "back" })],
      }),
      perception: garmentObserver({ back: "visible" }),
    });
    expect(codeOf(result, "garment.wet_cling")).toBe("insufficient_saturation");
  });
});

// ---------------------------------------------------------------------------
// The shared narrative-focus policy
// ---------------------------------------------------------------------------

describe("intimate narrative-focus policy", () => {
  function intimateFixture(focus?: { intimateRelevant: boolean; intimateAllowed: boolean }): GarmentFixture {
    const top = garmentFixtureRegion({
      garmentId: "g_top",
      materialClass: "woven_cotton_linen",
      coveredBodyLocations: ["chest"],
      saturation: 9_500,
      fit: "tight",
    });
    return {
      payload: garmentFixturePayload([top], {
        contacts: [garmentFixtureContact({ garmentId: "g_top", bodyLocationId: "chest", mode: "pressed" })],
        ...(focus === undefined ? {} : { focus }),
      }),
      perception: garmentObserver({ chest: "visible" }),
    };
  }

  it("says nothing at an intimate location when the lane asserts no focus at all", () => {
    const result = readCase(intimateFixture());
    expect(result.observations).toEqual([]);
    expect(codeOf(result, "garment.wet_cling")).toBe("intimate_gated");
    expect(codeOf(result, "garment.effective_opacity")).toBe("intimate_gated");
  });

  it("consent is a HARD gate — relevance alone does not open it", () => {
    const result = readCase(intimateFixture({ intimateRelevant: true, intimateAllowed: false }));
    expect(result.observations).toEqual([]);
    expect(codeOf(result, "garment.wet_cling")).toBe("intimate_gated");
  });

  it("an allowed but IRRELEVANT exchange is still silent — ordinary visibility is insufficient", () => {
    const result = readCase(intimateFixture({ intimateRelevant: false, intimateAllowed: true }));
    expect(result.observations).toEqual([]);
    expect(codeOf(result, "garment.wet_cling")).toBe("not_narrative_focus");
  });

  it("speaks only when a current action makes it relevant AND consent is open", () => {
    const result = readCase(intimateFixture({ intimateRelevant: true, intimateAllowed: true }));
    expect(ids(result)).toContain("garment.wet_cling");
  });

  it("the cue cap still holds it to at most the shared budget", () => {
    const result = readCase(intimateFixture({ intimateRelevant: true, intimateAllowed: true }));
    expect(result.cues.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe("degradation", () => {
  it("no payload at all ⇒ no profile ⇒ every phenomenon suppressed, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = readGarmentAffordances({ payload: undefined, perception: garmentObserver({}), sink });
    expect(result.observations).toEqual([]);
    for (const phenomenonId of garmentAffordanceDomain.phenomenonIds) {
      expect(codeOf(result, phenomenonId)).toBe(AFFORDANCE_SUPPRESSED_NO_PROFILE);
    }
    expectDiagnostic(sink, AFFORDANCE_INPUT_UNAVAILABLE);
  });

  it("an unreadable region list is INVALID, not an empty wardrobe", () => {
    const sink = new DiagnosticCollector();
    const result = readGarmentAffordances({
      payload: { regions: "not-a-list", state: [] },
      perception: garmentObserver({}),
      sink,
    });
    expect(result.observations).toEqual([]);
    expect(codeOf(result, "garment.wet_surface_state")).toBe(AFFORDANCE_SUPPRESSED_NO_PROFILE);
  });

  it("structure present but no current reading ⇒ the whole domain is unavailable", () => {
    const sink = new DiagnosticCollector();
    const region = garmentFixtureRegion({
      garmentId: "g",
      materialClass: "knit",
      coveredBodyLocations: ["chest"],
      saturation: 0,
    });
    const result = readGarmentAffordances({
      payload: { regions: [region.region] },
      perception: garmentObserver({ chest: "visible" }),
      sink,
    });
    expect(codeOf(result, "garment.wet_surface_state")).toBe(AFFORDANCE_INPUT_UNAVAILABLE);
  });

  it("an unregistered material keeps its coverage and takes the conservative profile", () => {
    const compiled = compileGarmentProfile([
      { garmentId: "g", partId: "root", coveredBodyLocations: ["chest"], materialClass: "unobtainium" },
    ]);
    expect(compiled.profile?.regions[0]?.materialClass).toBe("unknown");
    expect(compiled.profile?.regions[0]?.coveredBodyLocations).toEqual(["chest"]);
    expect(compiled.diagnostics.map((entry) => entry.code)).toContain("affordance.garment.unknown_material");
  });

  it("a malformed lane payload never throws", () => {
    for (const payload of [null, 7, "x", [], { regions: [{}] }]) {
      expect(() => readGarmentAffordances({ payload, perception: garmentObserver({}) })).not.toThrow();
    }
  });

  it("an invalid state list is reported INVALID rather than treated as dry", () => {
    const sink = new DiagnosticCollector();
    const region = garmentFixtureRegion({
      garmentId: "g",
      materialClass: "knit",
      coveredBodyLocations: ["chest"],
      saturation: 0,
    });
    const result = readGarmentAffordances({
      payload: { regions: [region.region], state: "broken" },
      perception: garmentObserver({ chest: "visible" }),
      sink,
    });
    expect(codeOf(result, "garment.wet_surface_state")).toBe(AFFORDANCE_INPUT_INVALID);
    expectDiagnostic(sink, AFFORDANCE_INPUT_INVALID);
  });
});

// ---------------------------------------------------------------------------
// Determinism and capture
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("the same cut produces a byte-identical read", () => {
    for (const build of Object.values(garmentWorkedCases)) {
      const fixture = build();
      expect(JSON.stringify(readCase(fixture, { storyTime: 12 }))).toBe(
        JSON.stringify(readCase(fixture, { storyTime: 12 })),
      );
    }
  });

  it("the captured coverage read is byte-identical on a rebuild — the retake law", () => {
    for (const build of Object.values(garmentWorkedCases)) {
      const fixture = build();
      expect(JSON.stringify(coverageFor(fixture, 30))).toBe(JSON.stringify(coverageFor(fixture, 30)));
    }
  });

  it("the capture round-trips through its persistence schema unchanged", () => {
    const captured = coverageFor(fittedCottonShirtInRain(), 30);
    expect(effectiveCoverageReadSchema.parse(JSON.parse(JSON.stringify(captured)))).toEqual(captured);
  });

  it("the coverage read is independent of the order the lane listed garments in", () => {
    const fixture = soakedCamisoleUnderCoat();
    const reversed: GarmentFixture = {
      ...fixture,
      payload: {
        ...fixture.payload,
        regions: [...fixture.payload.regions].reverse(),
        state: [...fixture.payload.state].reverse(),
      },
    };
    expect(JSON.stringify(coverageFor(reversed))).toBe(JSON.stringify(coverageFor(fixture)));
  });

  it("opacity feeds the staged coverage read deterministically", () => {
    const shirt = garmentFixtureRegion({
      garmentId: "g_shirt",
      materialClass: "woven_cotton_linen",
      coveredBodyLocations: ["back"],
      saturation: 10_000,
      fit: "fitted",
    });
    const compiled = compileGarmentProfile([shirt.region]);
    const profile = compiled.profile;
    expect(profile).toBeDefined();
    if (!profile) return;
    const mechanics = deriveGarmentMechanics({ profile, state: [shirt.state] });
    const coverage = deriveGarmentEffectiveCoverage({ frame: { profile, mechanics }, atMinutes: 3 });
    expect(effectiveCoverageAt(coverage, "back")).toBe("hinted");
    expect(coverage.entries[0]?.evidence[0]?.effectiveOpacity).toBe(mechanics.regions[0]?.effectiveOpacity);
  });
});

// ---------------------------------------------------------------------------
// Layer boundaries
// ---------------------------------------------------------------------------

describe("layer boundaries", () => {
  it("phenomena never see a raw material id — only the compiled profile does", () => {
    const compiled = compileGarmentProfile([
      { garmentId: "g", partId: "root", coveredBodyLocations: ["chest"], materialClass: "denim" },
    ]);
    const region = compiled.profile?.regions[0];
    expect(region?.absorbency).toBeTypeOf("number");
    expect(region?.dryMass).toBeTypeOf("number");
  });

  it("resolvers cannot write to their frame", () => {
    const traced = garmentAffordanceDomain.trace({
      subjectId: affordanceSubjectId("frozen"),
      storyTime: 0,
      attributes: resolvedAttributeSnapshot([]),
      payload: fittedCottonShirtInRain().payload,
    });
    expect(Object.isFrozen(traced.frame)).toBe(true);
  });

  it("perception still filters on top of wardrobe occlusion", () => {
    const fixture = fittedCottonShirtInRain();
    const blind = readGarmentAffordances({
      payload: fixture.payload,
      // No exposure entries at all: every location reads `unknown` and fails closed.
      perception: garmentObserver({}),
    });
    expect(blind.observations).toEqual([]);
    expect(blind.suppressed.some((entry) => entry.code === "affordance.perception.unknown")).toBe(true);
  });

  it("exposes its staged calculation for the developer preview without recomputing it differently", () => {
    const request = {
      subjectId: affordanceSubjectId("garment_fixture_subject"),
      storyTime: 0,
      attributes: resolvedAttributeSnapshot([]),
      payload: fittedCottonShirtInRain().payload,
    };
    const traced = garmentAffordanceDomain.trace(request);
    expect(traced.resolutions).toEqual(garmentAffordanceDomain.resolve(request).resolutions);
    expect(traced.inputs?.regions).toBe("supported");
    expect(traced.inputs?.contacts).toBe("supported");
  });

  it("the domain definition is exported fully typed for previews and adapters", () => {
    expect(garmentDomainDefinition.id).toBe(GARMENT_DOMAIN_ID);
    expect(garmentDomainDefinition.phenomena.length).toBe(3);
  });
});
