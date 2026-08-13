import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../../diagnostics";
import { attributeRegistry, type AttributeValue } from "../../../attributes";
import { bodyLocationRegistry } from "../../../body/locations";
import { codes, expectDiagnostic } from "@/test/diagnostics";
import { expectRefsResolve, expectUniqueBy } from "@/test/registry-invariants";
import {
  defineAttributeAxis,
  resolvedAttributeSnapshot,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
  type AttributeAxisSetMember,
} from "../../core";
import {
  hairAttributeAxes,
  hairAxisDiagnostics,
  hairConditionAxis,
  hairConditionValues,
  hairDensityAxis,
  hairDensityValues,
  hairLengthAxis,
  hairLengthValues,
  hairRequiredAttributeIds,
  hairStrandThicknessAxis,
  hairStrandThicknessValues,
  hairTextureAxis,
  hairTextureValues,
} from "./attribute-maps";
import { compileHairProfile } from "./profile";
import { hairAttributeFixture } from "./fixtures";

/**
 * Stage 1: raw hair vocabulary → stable structure.
 *
 * The two things worth proving here are that the tables are TOTAL over their
 * attribute's vocabulary (so a future enum value cannot silently compile to
 * nothing) and that the ladders are monotone (so every downstream "greater X
 * never lowers Y" law has something to stand on).
 */

const snapshot = (values: readonly AttributeValue[]) => resolvedAttributeSnapshot([...values]);

const FULL = hairAttributeFixture({
  length: "shoulder_length",
  density: "dense",
  strandThickness: "thick",
  texture: "wavy",
  condition: "healthy",
  arrangement: "loose",
});

/** Every mapped contribution, in ladder order, projected onto one field. */
function ladder<TValue extends string, TContribution>(
  values: readonly TValue[],
  table: Readonly<Partial<Record<TValue, TContribution>>>,
  project: (contribution: TContribution) => number,
): number[] {
  return values.map((value) => {
    const contribution = table[value];
    expect(contribution, `${value} is unmapped`).toBeDefined();
    return project(contribution as TContribution);
  });
}

function expectNonDecreasing(series: readonly number[], label: string): void {
  for (let index = 1; index < series.length; index += 1) {
    expect(series[index], `${label} fell at step ${index}: ${series.join(" → ")}`).toBeGreaterThanOrEqual(
      series[index - 1] ?? 0,
    );
  }
}

function expectNonIncreasing(series: readonly number[], label: string): void {
  expectNonDecreasing([...series].reverse(), label);
}

describe("the hair axis set", () => {
  it("validates at module load with nothing quarantined", () => {
    expect(hairAxisDiagnostics).toEqual([]);
    expect(hairRequiredAttributeIds).toEqual([
      "hair.length",
      "hair.density",
      "hair.strand_thickness",
      "hair.texture",
      "hair.condition",
    ]);
  });

  it("maps EVERY allowed value of every executable attribute", () => {
    for (const axis of hairAttributeAxes) {
      const allowed = attributeRegistry.byId(axis.attributeId)?.allowedValues ?? [];
      expect([...Object.keys(axis.values)].sort(), `${axis.attributeId} vocabulary`).toEqual([...allowed].sort());
    }
  });

  it("gives each of the nine profile paths exactly one owner", () => {
    const paths = hairAttributeAxes.flatMap((axis) => [...axis.ownedPaths]);
    expect(paths).toHaveLength(9);
    expectUniqueBy(paths, (path) => path, "hair profile paths");
    expectRefsResolve<AttributeAxisSetMember>(
      [...hairAttributeAxes],
      (axis) => [axis.attributeId],
      (id) => attributeRegistry.byId(id),
    );
  });

  it("leaves hair.color and hair.style without an axis — metadata and prose cannot drive mechanics", () => {
    const ids = hairAttributeAxes.map((axis) => axis.attributeId);
    expect(ids).not.toContain("hair.color");
    expect(ids).not.toContain("hair.style");
    expect(ids).not.toContain("hair.arrangement");
    // The core refuses the text attribute outright; colour is simply never mapped.
    expect(() =>
      defineAttributeAxis<"loose braid", { readonly scale: number }>({
        attributeId: "hair.style",
        version: 1,
        ownedPaths: ["hair.lengthScale"],
        values: { "loose braid": { scale: 1 } },
      }),
    ).toThrow(/free text/);
  });
});

describe("the calibration ladders", () => {
  it("length: scale rises and reach only ever grows", () => {
    expectNonDecreasing(
      ladder(hairLengthValues, hairLengthAxis.values, (contribution) => contribution.lengthScale),
      "lengthScale",
    );
    const reaches = hairLengthValues.map((value) => hairLengthAxis.values[value]?.nominalReach ?? new Set<string>());
    expect([...(reaches[0] ?? [])]).toEqual([]);
    for (let index = 1; index < reaches.length; index += 1) {
      for (const locationId of reaches[index - 1] ?? []) {
        expect(reaches[index]?.has(locationId), `${hairLengthValues[index]} lost ${locationId}`).toBe(true);
      }
    }
  });

  it("length: every reachable location is a real body location", () => {
    for (const value of hairLengthValues) {
      for (const locationId of hairLengthAxis.values[value]?.nominalReach ?? []) {
        expect(bodyLocationRegistry.byId(locationId), `${value} → ${locationId}`).toBeDefined();
      }
    }
    expect(hairLengthAxis.values.shoulder_length?.nominalReach.has("neck")).toBe(true);
    expect(hairLengthAxis.values.shoulder_length?.nominalReach.has("thighs")).toBe(false);
    expect(hairLengthAxis.values.feet_length?.nominalReach.has("thighs")).toBe(true);
  });

  it("density and strand thickness rise with their ladders", () => {
    expectNonDecreasing(
      ladder(hairDensityValues, hairDensityAxis.values, (contribution) => contribution.bulkDensity),
      "bulkDensity",
    );
    expectNonDecreasing(
      ladder(hairStrandThicknessValues, hairStrandThicknessAxis.values, (contribution) => contribution.strandThickness),
      "strandThickness",
    );
  });

  it("texture trades flexibility for curl retention", () => {
    expectNonIncreasing(
      ladder(hairTextureValues, hairTextureAxis.values, (contribution) => contribution.flexibility),
      "flexibility",
    );
    expectNonDecreasing(
      ladder(hairTextureValues, hairTextureAxis.values, (contribution) => contribution.curlRetention),
      "curlRetention",
    );
  });

  it("condition raises friction, absorption, and clump affinity together", () => {
    expectNonDecreasing(
      ladder(hairConditionValues, hairConditionAxis.values, (contribution) => contribution.surfaceFriction),
      "surfaceFriction",
    );
    expectNonDecreasing(
      ladder(hairConditionValues, hairConditionAxis.values, (contribution) => contribution.waterAbsorption),
      "waterAbsorption",
    );
    expectNonDecreasing(
      ladder(hairConditionValues, hairConditionAxis.values, (contribution) => contribution.clumpAffinity),
      "clumpAffinity",
    );
  });
});

describe("compileHairProfile", () => {
  it("compiles the nine structural fields and nothing else", () => {
    const result = compileHairProfile(snapshot(FULL));
    expect(result.profile).toBeDefined();
    expect(Object.keys(result.profile ?? {}).sort()).toEqual([
      "bulkDensity",
      "clumpAffinity",
      "curlRetention",
      "flexibility",
      "lengthScale",
      "nominalReach",
      "strandThickness",
      "surfaceFriction",
      "waterAbsorption",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.evidence.map((entry) => entry.ref)).toEqual([
      "hair.length",
      "hair.density",
      "hair.strand_thickness",
      "hair.texture",
      "hair.condition",
    ]);
  });

  it("is deterministic and independent of the order attributes arrive in", () => {
    const shuffled = [...FULL].reverse();
    expect(compileHairProfile(snapshot(shuffled))).toEqual(compileHairProfile(snapshot(FULL)));
  });

  it("ignores hair.color and hair.style entirely", () => {
    const recoloured = FULL.map((value) =>
      value.id === "hair.color" ? { ...value, value: "midnight_blue" } : value,
    );
    const styled: AttributeValue[] = [...recoloured, { id: "hair.style", value: "wet braid", source: "creation" }];
    expect(compileHairProfile(snapshot(styled)).profile).toEqual(compileHairProfile(snapshot(FULL)).profile);
  });

  it("suppresses the domain when ANY required axis is unset, naming every gap", () => {
    for (const missing of hairRequiredAttributeIds) {
      const result = compileHairProfile(snapshot(FULL.filter((value) => value.id !== missing)));
      expect(result.profile, `${missing} should be required structure`).toBeUndefined();
      expect(result.diagnostics.map((entry) => entry.path)).toEqual([missing]);
      expect(result.diagnostics[0]?.code).toBe(AFFORDANCE_INPUT_UNAVAILABLE);
    }
    const bare = compileHairProfile(resolvedAttributeSnapshot([]));
    expect(bare.profile).toBeUndefined();
    expect(bare.diagnostics).toHaveLength(5);
  });

  it("reports unmapped vocabulary as INVALID, never as a neighbouring value", () => {
    const drifted = FULL.map((value) => (value.id === "hair.density" ? { ...value, value: "wispy" } : value));
    const result = compileHairProfile(snapshot(drifted));
    expect(result.profile).toBeUndefined();
    const sink = new DiagnosticCollector();
    for (const diagnostic of result.diagnostics) sink.push(diagnostic);
    expectDiagnostic(sink, AFFORDANCE_INPUT_INVALID);
    expect(codes(sink)).not.toContain(AFFORDANCE_INPUT_UNAVAILABLE);
  });
});
