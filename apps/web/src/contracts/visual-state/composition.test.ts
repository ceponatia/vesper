import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { AFFORDANCE_UNIT_ONE, AFFORDANCE_UNIT_ZERO, toUnitInterval } from "../affordances/core";
import { DiagnosticCollector } from "../diagnostics";
import { resolveVisualStateComposition, visualStateCompositionFor } from "./composition";
import { VISUAL_STATE_RELATIONSHIP_CYCLE, VISUAL_STATE_RELATIONSHIP_TARGET_MISSING } from "./diagnostics";
import type { VisualStateFeature } from "./feature";
import { visualStateFeatureFixture } from "./fixtures";
import type { VisualStateRelationship } from "./relationships";

/**
 * The composition resolver, judged on the plan's own worked scenarios: wetness
 * modifies a hairstyle, a hairpiece replaces natural hair as the visible
 * surface, a hat covers part of it, smudging modifies makeup, a coat occludes a
 * shirt.
 *
 * Features here are hand-built rather than adapter-produced, and deliberately
 * so — the resolver's contract is "given these edges, what is visible", and it
 * must hold for every relationship kind including the two no slice-2 adapter
 * emits yet (`replaces_visible_surface` has no owner that distinguishes a
 * hairpiece from a hat, and `derived_from` needs slice 3's material reads).
 */

const HALF = toUnitInterval(5_000);

function featureAt(aspect: string, relationships: readonly VisualStateRelationship[] = []): VisualStateFeature {
  return visualStateFeatureFixture({ aspect, relationships });
}

function keyOf(aspect: string): string {
  return featureAt(aspect).key;
}

function resolve(features: readonly VisualStateFeature[], sink?: DiagnosticCollector) {
  return resolveVisualStateComposition(features, sink);
}

describe("resolveVisualStateComposition", () => {
  it("annotates every feature, even one with no edges at all", () => {
    const sink = new DiagnosticCollector();
    const composition = resolve([featureAt("shape")], sink);
    expect(composition.entries).toHaveLength(1);
    expect(composition.entries[0]?.effectiveVisibility).toBe(AFFORDANCE_UNIT_ONE);
    expect(composition.entries[0]?.coverage).toBe(AFFORDANCE_UNIT_ZERO);
    expectCleanSink(sink);
  });

  it("records a modification on the feature it acts on — wetness on a hairstyle", () => {
    const hairstyle = featureAt("hairstyle");
    const wetness = featureAt("wetness", [{ kind: "modifies", targetKey: hairstyle.key }]);
    const entry = visualStateCompositionFor(resolve([hairstyle, wetness]), hairstyle.key);
    expect(entry?.modifiedBy).toEqual([wetness.key]);
    // A modification does not hide what it acts on: damp hair is still hair.
    expect(entry?.effectiveVisibility).toBe(AFFORDANCE_UNIT_ONE);
  });

  it("keeps replaced natural hair in the snapshot and marks it invisible — the wig case", () => {
    const naturalHair = featureAt("hairstyle");
    const hairpiece = featureAt("wardrobe", [
      { kind: "replaces_visible_surface", targetKey: naturalHair.key },
    ]);
    const composition = resolve([naturalHair, hairpiece]);
    expect(composition.entries.map((entry) => entry.key)).toContain(naturalHair.key);
    const replaced = visualStateCompositionFor(composition, naturalHair.key);
    expect(replaced?.replacedBy).toBe(hairpiece.key);
    expect(replaced?.effectiveVisibility).toBe(AFFORDANCE_UNIT_ZERO);
    // The replacement itself is untouched — it IS the visible surface.
    expect(visualStateCompositionFor(composition, hairpiece.key)?.effectiveVisibility).toBe(AFFORDANCE_UNIT_ONE);
  });

  it("takes coverage off what is visible without removing it — the hat case", () => {
    const hairstyle = featureAt("hairstyle");
    const hat = featureAt("wardrobe", [{ kind: "covers", targetKey: hairstyle.key, degree: HALF }]);
    const composition = resolve([hairstyle, hat]);
    const covered = visualStateCompositionFor(composition, hairstyle.key);
    expect(covered?.coverage).toBe(HALF);
    expect(covered?.effectiveVisibility).toBe(toUnitInterval(5_000));
    expect(composition.entries.map((entry) => entry.key)).toContain(hairstyle.key);
  });

  it("keeps the strongest cover when two things reach the same surface", () => {
    const shirt = featureAt("shape");
    const light = featureAt("hairstyle", [{ kind: "covers", targetKey: shirt.key, degree: HALF }]);
    const heavy = featureAt("wardrobe", [
      { kind: "covers", targetKey: shirt.key, degree: AFFORDANCE_UNIT_ONE },
    ]);
    const entry = visualStateCompositionFor(resolve([shirt, light, heavy]), shirt.key);
    expect(entry?.coverage).toBe(AFFORDANCE_UNIT_ONE);
    expect(entry?.effectiveVisibility).toBe(AFFORDANCE_UNIT_ZERO);
  });

  it("occludes a garment behind another — the coat over the shirt", () => {
    const shirt = featureAt("shirt");
    const coat = featureAt("coat", [{ kind: "occludes", targetKey: shirt.key, degree: HALF }]);
    const entry = visualStateCompositionFor(resolve([shirt, coat]), shirt.key);
    expect(entry?.occlusion).toBe(HALF);
    expect(entry?.coverage).toBe(AFFORDANCE_UNIT_ZERO);
    expect(entry?.effectiveVisibility).toBe(toUnitInterval(5_000));
  });

  it("takes the worse of coverage and occlusion rather than stacking them", () => {
    const shirt = featureAt("shirt");
    const coat = featureAt("coat", [
      { kind: "occludes", targetKey: shirt.key, degree: HALF },
      { kind: "covers", targetKey: shirt.key, degree: toUnitInterval(8_000) },
    ]);
    const entry = visualStateCompositionFor(resolve([shirt, coat]), shirt.key);
    expect(entry?.effectiveVisibility).toBe(toUnitInterval(2_000));
  });

  it("records an attachment without hiding what it hangs from", () => {
    const nose = featureAt("shape");
    const ring = featureAt("wardrobe", [{ kind: "attached_to", targetKey: nose.key }]);
    const composition = resolve([nose, ring]);
    expect(visualStateCompositionFor(composition, ring.key)?.attachedTo).toEqual([nose.key]);
    expect(visualStateCompositionFor(composition, nose.key)?.effectiveVisibility).toBe(AFFORDANCE_UNIT_ONE);
  });

  it("records a derivation on the feature that derives", () => {
    const material = featureAt("shape");
    const beading = featureAt("beading", [{ kind: "derived_from", targetKey: material.key }]);
    expect(visualStateCompositionFor(resolve([material, beading]), beading.key)?.derivedFrom).toEqual([
      material.key,
    ]);
  });

  it("suppresses an edge whose target the snapshot does not hold", () => {
    const sink = new DiagnosticCollector();
    const orphan = featureAt("hairstyle", [{ kind: "modifies", targetKey: "nobody/nowhere/nothing" }]);
    const composition = resolve([orphan], sink);
    expect(composition.entries[0]?.relationships).toEqual([]);
    expect(composition.suppressions).toEqual([
      { key: orphan.key, code: VISUAL_STATE_RELATIONSHIP_TARGET_MISSING, detail: "modifies:nobody/nowhere/nothing" },
    ]);
    expectDiagnostic(sink, VISUAL_STATE_RELATIONSHIP_TARGET_MISSING, { times: 1 });
  });

  it("keeps a feature's other edges when one of them is broken", () => {
    const hairstyle = featureAt("hairstyle");
    const hat = featureAt("wardrobe", [
      { kind: "covers", targetKey: "nobody/nowhere/nothing", degree: AFFORDANCE_UNIT_ONE },
      { kind: "covers", targetKey: hairstyle.key, degree: AFFORDANCE_UNIT_ONE },
    ]);
    const composition = resolve([hairstyle, hat]);
    expect(visualStateCompositionFor(composition, hat.key)?.relationships).toHaveLength(1);
    expect(visualStateCompositionFor(composition, hairstyle.key)?.coverage).toBe(AFFORDANCE_UNIT_ONE);
  });

  it("suppresses a feature that composes with itself", () => {
    const sink = new DiagnosticCollector();
    const key = keyOf("hairstyle");
    const looping = visualStateFeatureFixture({
      aspect: "hairstyle",
      relationships: [{ kind: "modifies", targetKey: key }],
    });
    const composition = resolve([looping], sink);
    expect(composition.entries[0]?.modifiedBy).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_RELATIONSHIP_CYCLE, { times: 1 });
  });

  it("suppresses the edge that closes a two-feature cycle and keeps the other", () => {
    const sink = new DiagnosticCollector();
    const first = featureAt("hairstyle", [{ kind: "modifies", targetKey: keyOf("makeup") }]);
    const second = featureAt("makeup", [{ kind: "modifies", targetKey: keyOf("hairstyle") }]);
    const composition = resolve([first, second], sink);
    expect(visualStateCompositionFor(composition, second.key)?.modifiedBy).toEqual([first.key]);
    expect(visualStateCompositionFor(composition, first.key)?.modifiedBy).toEqual([]);
    expect(composition.suppressions).toEqual([
      { key: second.key, code: VISUAL_STATE_RELATIONSHIP_CYCLE, detail: `modifies:${first.key}` },
    ]);
    expectDiagnostic(sink, VISUAL_STATE_RELATIONSHIP_CYCLE, { times: 1 });
  });

  it("breaks a three-feature cycle at exactly one edge", () => {
    const sink = new DiagnosticCollector();
    const a = featureAt("a", [{ kind: "modifies", targetKey: keyOf("b") }]);
    const b = featureAt("b", [{ kind: "modifies", targetKey: keyOf("c") }]);
    const c = featureAt("c", [{ kind: "modifies", targetKey: keyOf("a") }]);
    const composition = resolve([a, b, c], sink);
    expect(composition.suppressions).toHaveLength(1);
    const surviving = composition.entries.flatMap((entry) => entry.relationships);
    expect(surviving).toHaveLength(2);
  });

  it("blames the same edge of a cycle on every run", () => {
    const build = () => [
      featureAt("a", [{ kind: "modifies", targetKey: keyOf("b") }]),
      featureAt("b", [{ kind: "modifies", targetKey: keyOf("c") }]),
      featureAt("c", [{ kind: "modifies", targetKey: keyOf("a") }]),
    ];
    expect(JSON.stringify(resolve(build()))).toBe(JSON.stringify(resolve(build())));
  });

  it("produces byte-equal annotations from the same feature list", () => {
    const build = () => {
      const hairstyle = featureAt("hairstyle");
      return [
        hairstyle,
        featureAt("wardrobe", [{ kind: "covers", targetKey: hairstyle.key, degree: HALF }]),
        featureAt("makeup", [{ kind: "modifies", targetKey: hairstyle.key }]),
      ];
    };
    expect(JSON.stringify(resolve(build()))).toBe(JSON.stringify(resolve(build())));
  });

  it("sorts every accumulated key list, so two adapters cannot swap the order", () => {
    const target = featureAt("shape");
    const zebra = visualStateFeatureFixture({
      subjectId: "z_subject",
      aspect: "hairstyle",
      relationships: [{ kind: "modifies", targetKey: target.key }],
    });
    const alpha = visualStateFeatureFixture({
      subjectId: "a_subject",
      aspect: "hairstyle",
      relationships: [{ kind: "modifies", targetKey: target.key }],
    });
    expect(visualStateCompositionFor(resolve([target, zebra, alpha]), target.key)?.modifiedBy).toEqual([
      alpha.key,
      zebra.key,
    ]);
  });

  it("resolves an empty feature list to an empty composition", () => {
    expect(resolve([])).toEqual({ entries: [], suppressions: [] });
  });
});
