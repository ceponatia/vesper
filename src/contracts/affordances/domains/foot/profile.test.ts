import { describe, expect, it } from "vitest";
import type { AttributeValue } from "../../../attributes";
import {
  resolvedAttributeSnapshot,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
} from "../../core";
import { footArchValues, footNailValues, footToeValues } from "./attribute-maps";
import { footAttributeFixture } from "./fixtures";
import { compileFootProfile, footSurfaceProfile, footTextureBandRank, type FootStructuralProfile } from "./profile";
import { footSurfaceIds, type FootSurfaceId } from "./topology";

function compile(attributes: readonly AttributeValue[]): FootStructuralProfile | undefined {
  return compileFootProfile(resolvedAttributeSnapshot([...attributes])).profile;
}

function profileOf(arch: (typeof footArchValues)[number] = "average"): FootStructuralProfile {
  const compiled = compile(footAttributeFixture({ arch, nails: "neat", toes: "average" }));
  if (compiled === undefined) throw new Error("fixture attributes failed to compile");
  return compiled;
}

function surface(profile: FootStructuralProfile, surfaceId: FootSurfaceId) {
  const found = footSurfaceProfile(profile, surfaceId);
  if (found === undefined) throw new Error(`no profile for ${surfaceId}`);
  return found;
}

describe("compileFootProfile", () => {
  it("compiles one entry per topology surface, in topology order", () => {
    expect(profileOf().surfaces.map((entry) => entry.surfaceId)).toEqual([...footSurfaceIds]);
  });

  it("is deterministic: identical attributes give an identical profile", () => {
    const attributes = footAttributeFixture({ arch: "low", nails: "chipped", toes: "long" });
    expect(compile(attributes)).toEqual(compile([...attributes].reverse()));
  });

  it("suppresses the whole domain when any required axis is unset, and names every one", () => {
    const result = compileFootProfile(
      resolvedAttributeSnapshot([{ id: "feet.arch", value: "average", source: "creation" }]),
    );
    expect(result.profile).toBeUndefined();
    expect(result.diagnostics.map((entry) => entry.path).sort()).toEqual(["feet.nails", "feet.toes"]);
    expect(new Set(result.diagnostics.map((entry) => entry.code))).toEqual(new Set([AFFORDANCE_INPUT_UNAVAILABLE]));
  });

  it("separates unmapped vocabulary from an unset attribute", () => {
    const result = compileFootProfile(
      resolvedAttributeSnapshot([
        { id: "feet.arch", value: "cathedral", source: "creation" },
        { id: "feet.nails", value: "neat", source: "creation" },
        { id: "feet.toes", value: "average", source: "creation" },
      ]),
    );
    expect(result.profile).toBeUndefined();
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([AFFORDANCE_INPUT_INVALID]);
  });

  it("records provenance for every axis it read", () => {
    const result = compileFootProfile(
      resolvedAttributeSnapshot(footAttributeFixture({ arch: "high", nails: "painted", toes: "tiny" })),
    );
    expect(result.evidence).toEqual([
      { kind: "attribute", ref: "feet.arch", detail: "high" },
      { kind: "attribute", ref: "feet.nails", detail: "painted" },
      { kind: "attribute", ref: "feet.toes", detail: "tiny" },
    ]);
  });
});

describe("regional calibration", () => {
  it("gives the heel more callus and the arch less than the plantar baseline", () => {
    const profile = profileOf();
    const plantar = surface(profile, "plantar_surface");
    expect(surface(profile, "heel_pad").callusBand).toBeGreaterThan(plantar.callusBand);
    expect(surface(profile, "arch").callusBand).toBeLessThan(plantar.callusBand);
    expect(surface(profile, "heel_pad").compliance).toBeLessThan(plantar.compliance);
    expect(surface(profile, "arch").compliance).toBeGreaterThan(plantar.compliance);
  });

  it("gives the ball more pressure exposure than the arch", () => {
    const profile = profileOf();
    expect(surface(profile, "ball").pressureExposure).toBeGreaterThan(surface(profile, "arch").pressureExposure);
  });

  it("keeps the interdigital spaces wetter and less aired than the toe tops", () => {
    const profile = profileOf();
    const between = surface(profile, "interdigital_spaces");
    const tops = surface(profile, "toe_tops");
    expect(between.moistureRetention).toBeGreaterThan(tops.moistureRetention);
    expect(between.airflowExposure).toBeLessThan(tops.airflowExposure);
  });

  it("keeps the dorsal surface distinct from the plantar baseline on every term", () => {
    const profile = profileOf();
    const dorsal = surface(profile, "dorsal_surface");
    const plantar = surface(profile, "plantar_surface");
    expect(dorsal.callusBand).toBeLessThan(plantar.callusBand);
    expect(dorsal.drySurfaceFriction).toBeLessThan(plantar.drySurfaceFriction);
    expect(dorsal.airflowExposure).toBeGreaterThan(plantar.airflowExposure);
    expect(dorsal.tactileTextureBand).toBe("smooth");
  });

  it("gives the toenail hard-surface structure rather than skin inheritance", () => {
    const profile = profileOf();
    const nail = surface(profile, "toenails");
    const toes = surface(profile, "toes");
    expect(nail.structureKind).toBe("keratin");
    expect(nail.softness).toBe(0);
    expect(nail.compliance).toBeLessThan(toes.compliance);
    expect(nail.tactileTextureBand).toBe("hard");
    // Nothing about it tracks the toes it hangs off.
    expect(nail.callusBand).toBe(0);
  });

  it("inherits a child's unshifted terms from its parent verbatim", () => {
    const profile = profileOf();
    // `medial_arch` shifts only callus and compliance, so everything else is the
    // arch's own value — which is what makes the modifier tables sparse.
    expect(surface(profile, "medial_arch").drySurfaceFriction).toBe(surface(profile, "arch").drySurfaceFriction);
    expect(surface(profile, "medial_arch").moistureRetention).toBe(surface(profile, "arch").moistureRetention);
    expect(surface(profile, "medial_arch").airflowExposure).toBe(surface(profile, "arch").airflowExposure);
    // The two terms the arch axis touches must be inherited too, NOT re-derived:
    // re-applying the axis at every descendant compounded a 3_000 span into
    // 6_000 and pushed a flat foot's lateral arch past its own heel.
    expect(surface(profile, "medial_arch").pressureExposure).toBe(surface(profile, "arch").pressureExposure);
    expect(surface(profile, "lateral_arch").pressureExposure).toBe(surface(profile, "arch").pressureExposure);
    // `medial_arch`/`lateral_arch` shift callus by their own modifier and nothing
    // more, so the gap to the parent is exactly that modifier at every setting.
    for (const value of footArchValues) {
      const each = profileOf(value);
      expect(surface(each, "medial_arch").callusBand - surface(each, "arch").callusBand, value).toBe(-500);
      expect(surface(each, "lateral_arch").callusBand - surface(each, "arch").callusBand, value).toBe(500);
    }
  });

  it("keeps the arch subtree below the heel and the ball, at every arch setting", () => {
    for (const value of footArchValues) {
      const profile = profileOf(value);
      const heel = surface(profile, "heel_pad");
      const ball = surface(profile, "ball");
      for (const surfaceId of ["arch", "medial_arch", "lateral_arch"] as const) {
        const entry = surface(profile, surfaceId);
        expect(entry.callusBand, `${value}/${surfaceId} callus`).toBeLessThan(heel.callusBand);
        expect(entry.pressureExposure, `${value}/${surfaceId} pressure`).toBeLessThan(ball.pressureExposure);
      }
    }
  });

  it("never lets a child read rougher than the parent it inherits from", () => {
    for (const value of footArchValues) {
      const profile = profileOf(value);
      const parent = surface(profile, "arch");
      for (const surfaceId of ["medial_arch", "lateral_arch"] as const) {
        const band = surface(profile, surfaceId).tactileTextureBand;
        expect(
          Math.abs(footTextureBandRank(band) - footTextureBandRank(parent.tactileTextureBand)),
          `${value}/${surfaceId}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("callus never raises softness at the same locus", () => {
  it("holds across the whole feet.arch ladder at the arch", () => {
    const ladder = footArchValues.map((value) => surface(profileOf(value), "arch"));
    for (let index = 1; index < ladder.length; index += 1) {
      const softer = ladder[index];
      const firmer = ladder[index - 1];
      if (softer === undefined || firmer === undefined) throw new Error("ladder gap");
      // `flat → high` runs callus DOWN, so softness must run up.
      expect(softer.callusBand).toBeLessThan(firmer.callusBand);
      expect(softer.softness).toBeGreaterThan(firmer.softness);
    }
  });

  it("holds across every surface of one foot", () => {
    const profile = profileOf();
    for (const entry of profile.surfaces) {
      if (entry.structureKind !== "skin") continue;
      const rougher = profile.surfaces.filter(
        (other) => other.structureKind === "skin" && other.callusBand > entry.callusBand,
      );
      for (const other of rougher) {
        // Different seeds legitimately have different base softness, so the law
        // is checked where it means something: within one seed's subtree.
        if (other.bodyLocationId !== entry.bodyLocationId) continue;
        expect(other.softness, `${other.surfaceId} vs ${entry.surfaceId}`).toBeLessThanOrEqual(entry.softness);
      }
    }
  });

  it("never lets a rougher texture band come with more softness", () => {
    const profile = profileOf();
    const heel = surface(profile, "heel_pad");
    const arch = surface(profile, "arch");
    expect(footTextureBandRank(heel.tactileTextureBand)).toBeGreaterThan(footTextureBandRank(arch.tactileTextureBand));
    expect(heel.softness).toBeLessThan(arch.softness);
  });
});

describe("authored nails and toes reach exactly one thing each", () => {
  it("moves only the nail plate as feet.nails changes", () => {
    const neglected = compile(footAttributeFixture({ arch: "average", nails: "neglected", toes: "average" }));
    const pedicured = compile(footAttributeFixture({ arch: "average", nails: "pedicured", toes: "average" }));
    if (neglected === undefined || pedicured === undefined) throw new Error("fixtures failed to compile");
    expect(surface(neglected, "toenails").nailEdgeProminence).toBeGreaterThan(
      surface(pedicured, "toenails").nailEdgeProminence,
    );
    expect(surface(neglected, "toenails").drySurfaceFriction).toBeGreaterThan(
      surface(pedicured, "toenails").drySurfaceFriction,
    );
    expect(surface(neglected, "toe_pads")).toEqual(surface(pedicured, "toe_pads"));
  });

  it("moves only the interdigital spaces as feet.toes changes", () => {
    const [shortest, longest] = [footToeValues[0], footToeValues[footToeValues.length - 1]];
    if (shortest === undefined || longest === undefined) throw new Error("ladder gap");
    const tiny = compile(footAttributeFixture({ arch: "average", nails: "neat", toes: shortest }));
    const long = compile(footAttributeFixture({ arch: "average", nails: "neat", toes: longest }));
    if (tiny === undefined || long === undefined) throw new Error("fixtures failed to compile");
    expect(surface(long, "interdigital_spaces").moistureRetention).toBeGreaterThan(
      surface(tiny, "interdigital_spaces").moistureRetention,
    );
    expect(surface(long, "toe_tops")).toEqual(surface(tiny, "toe_tops"));
  });

  it("covers every authored value in each table", () => {
    for (const arch of footArchValues) expect(compile(footAttributeFixture({ arch, nails: "neat", toes: "average" }))).toBeDefined();
    for (const nails of footNailValues) expect(compile(footAttributeFixture({ arch: "average", nails, toes: "average" }))).toBeDefined();
    for (const toes of footToeValues) expect(compile(footAttributeFixture({ arch: "average", nails: "neat", toes }))).toBeDefined();
  });
});
