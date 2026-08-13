import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { attributeRegistry } from "../attributes";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { appearanceAttributeRecognitionCatalog } from "./attribute-recognition";
import {
  birthmarkFact,
  crookedNoseAttributes,
  freckleClusterFact,
  missingFingerState,
  projectFixture,
  scarFact,
  APPEARANCE_FIXTURE_SUBJECT_ID,
} from "./fixtures";
import { APPEARANCE_FRECKLE_CLUSTER_KIND_ID, APPEARANCE_SCAR_KIND_ID } from "./kinds";
import { APPEARANCE_LOCUS_UNKNOWN_LOCATION, HUMANOID_HAND_DETAIL_SCHEMA_ID } from "./locus";
import { appearanceFeatureKindRegistry } from "./registry";
import {
  deriveBodyAreaView,
  APPEARANCE_ATTRIBUTE_VALUE_UNUSABLE,
  APPEARANCE_FEATURE_KEY_DUPLICATE,
  APPEARANCE_PRESENCE_ASPECT,
} from "./projection";
import { APPEARANCE_FACT_KIND_UNKNOWN, APPEARANCE_FACT_LOCUS_NOT_ALLOWED, APPEARANCE_FACT_VALUE_INVALID } from "./facts";

/**
 * The spec's acceptance tests for the truth half of slice 7 (§Acceptance
 * tests): identical body truth → identical keys and fingerprints, shoulder
 * freckles at the coarse locus, a crooked nose with no duplicate fact,
 * missing-finger truth from anatomy alone, and malformed input degrading to
 * diagnostics and silence.
 */

const keysOf = (records: readonly { key: string }[]): string[] => records.map((record) => record.key);

describe("determinism", () => {
  it("gives identical keys and fingerprints for identical body truth", () => {
    const truth = {
      attributes: crookedNoseAttributes(),
      locatedFacts: [freckleClusterFact(), birthmarkFact(), scarFact()],
      anatomy: [missingFingerState()],
      atMinutes: 600,
    };
    const first = projectFixture(truth);
    const second = projectFixture(truth);
    expect(second).toEqual(first);
    expect(keysOf(first)).toEqual([...keysOf(first)].sort());
  });

  it("does not depend on the order truth arrives in", () => {
    const facts = [freckleClusterFact(), birthmarkFact(), scarFact()];
    const forward = projectFixture({ locatedFacts: facts });
    const reversed = projectFixture({ locatedFacts: [...facts].reverse() });
    expect(reversed).toEqual(forward);
  });

  it("fingerprints a value canonically, not by key order", () => {
    const [record] = projectFixture({ locatedFacts: [freckleClusterFact()] });
    expect(record?.truthFingerprint).toBe('{"density":"dense","pattern":"clustered"}');
  });
});

describe("located facts", () => {
  it("projects shoulder freckles at the coarse shoulders locus", () => {
    const sink = new DiagnosticCollector();
    const [record] = projectFixture({ locatedFacts: [freckleClusterFact()], sink });
    expect(record?.locus).toEqual({ bodyLocationId: "shoulders" });
    expect(record?.key).toBe(`${APPEARANCE_FIXTURE_SUBJECT_ID}/shoulders/${APPEARANCE_FRECKLE_CLUSTER_KIND_ID}`);
    expect(record?.stability).toBe("inherent");
    expect(record?.semanticTags).toContain("pigmentation");
    expect(record?.priors).toEqual(appearanceFeatureKindRegistry.byId(APPEARANCE_FRECKLE_CLUSTER_KIND_ID)?.recognition);
    expectCleanSink(sink);
  });

  it("reads a mark on a finger at the coarse locus when the detail is unsupported", () => {
    const sink = new DiagnosticCollector();
    const [record] = projectFixture({
      locatedFacts: [
        scarFact({
          locus: {
            bodyLocationId: "hands",
            side: "left",
            detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["sixth_finger"] },
          },
        }),
      ],
      sink,
    });
    expect(record?.locus).toEqual({ bodyLocationId: "hands", side: "left" });
    expectDiagnostic(sink, "appearance.locus.detail_coarsened");
  });

  it("carries the kind's persistence into stability and its priors verbatim", () => {
    const [record] = projectFixture({ locatedFacts: [scarFact()] });
    expect(record?.stability).toBe("persistent");
    expect(record?.priors.repeatFamily).toBe("scar");
    expect(record?.sourceRef).toEqual({ kind: "located_fact", factId: "fact_scar" });
  });

  it("leaves one record when a scar supersedes its wound-era row", () => {
    const wound = scarFact({ id: "fact_wound", size: "large", validFrom: 10 });
    const healed = scarFact({ id: "fact_scar", validFrom: 400, supersedesFactId: "fact_wound" });
    const records = projectFixture({ locatedFacts: [wound, healed], atMinutes: 500 });
    expect(records).toHaveLength(1);
    expect(records[0]?.sourceRef).toEqual({ kind: "located_fact", factId: "fact_scar" });
  });

  it("respects validity windows", () => {
    const seasonal = freckleClusterFact({ validFrom: 100, validUntil: 200 });
    expect(projectFixture({ locatedFacts: [seasonal], atMinutes: 50 })).toEqual([]);
    expect(projectFixture({ locatedFacts: [seasonal], atMinutes: 150 })).toHaveLength(1);
    expect(projectFixture({ locatedFacts: [seasonal], atMinutes: 200 })).toEqual([]);
  });

  it("ignores another subject's rows", () => {
    expect(projectFixture({ locatedFacts: [freckleClusterFact({ subjectId: "someone_else" })] })).toEqual([]);
  });
});

describe("attributes", () => {
  it("projects a crooked nose without any located fact", () => {
    const sink = new DiagnosticCollector();
    const records = projectFixture({ attributes: crookedNoseAttributes(), sink });
    expect(records).toHaveLength(1);
    expect(records[0]?.key).toBe(`${APPEARANCE_FIXTURE_SUBJECT_ID}/nose/shape`);
    expect(records[0]?.sourceRef).toEqual({ kind: "attribute", attributeId: "nose.shape" });
    expect(records[0]?.truthFingerprint).toBe("crooked");
    expect(records[0]?.stability).toBe("inherent");
    expect(records[0]?.semanticTags).toEqual(["nose", "crooked"]);
    expectCleanSink(sink);
    // …and the vocabulary the projection reads is the ordinary registry one.
    expect(attributeRegistry.byId("nose.shape")?.allowedValues).toContain("crooked");
  });

  it("is the nose's only source when a whole body projects at once", () => {
    // The acceptance test in full: the crooked nose comes from the attribute
    // and nothing duplicates it as a located fact.
    const records = projectFixture({
      attributes: crookedNoseAttributes(),
      locatedFacts: [freckleClusterFact(), scarFact(), birthmarkFact()],
      anatomy: [missingFingerState()],
      atMinutes: 600,
    });
    const nose = records.filter((record) => record.locus.bodyLocationId === "nose");
    expect(nose.map((record) => record.sourceRef.kind)).toEqual(["attribute"]);
    expect(records).toHaveLength(5);
  });

  it("stays silent for ordinary vocabulary members", () => {
    const sink = new DiagnosticCollector();
    const records = projectFixture({
      attributes: [{ id: "nose.shape", value: "straight", source: "creation" }],
      sink,
    });
    expect(records).toEqual([]);
    expectCleanSink(sink);
  });

  it("projects each catalogued attribute at its own locus and aspect", () => {
    const records = projectFixture({
      attributes: [
        { id: "teeth.shape", value: "gapped", source: "creation" },
        { id: "teeth.condition", value: "gold_capped", source: "creation" },
        { id: "face.freckles", value: "heavy", source: "creation" },
      ],
    });
    expect(keysOf(records)).toEqual([
      `${APPEARANCE_FIXTURE_SUBJECT_ID}/face/freckles`,
      `${APPEARANCE_FIXTURE_SUBJECT_ID}/face/teeth_condition`,
      `${APPEARANCE_FIXTURE_SUBJECT_ID}/face/teeth_shape`,
    ]);
  });

  it("keeps the catalog inside the attribute registry's own vocabulary", () => {
    for (const entry of appearanceAttributeRecognitionCatalog) {
      const definition = attributeRegistry.byId(entry.attributeId);
      expect(definition, entry.attributeId).toBeDefined();
      for (const value of entry.eligibleValues) {
        expect(definition?.allowedValues, `${entry.attributeId} = ${value}`).toContain(value);
      }
    }
  });

  it("degrades a non-enum attribute value to a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const records = projectFixture({
      attributes: [{ id: "nose.shape", value: ["crooked"], source: "creation" }],
      sink,
    });
    expect(records).toEqual([]);
    expectDiagnostic(sink, APPEARANCE_ATTRIBUTE_VALUE_UNUSABLE);
  });
});

describe("anatomy", () => {
  it("takes missing-finger truth only from anatomy state", () => {
    const sink = new DiagnosticCollector();
    const records = projectFixture({ anatomy: [missingFingerState()], sink });
    expect(records).toHaveLength(1);
    expect(records[0]?.key).toBe(
      `${APPEARANCE_FIXTURE_SUBJECT_ID}/fingers:left:ring_finger/${APPEARANCE_PRESENCE_ASPECT}`,
    );
    expect(records[0]?.truthFingerprint).toBe("absent");
    expect(records[0]?.stability).toBe("persistent");
    expect(records[0]?.semanticTags).toContain("ring_finger");
    expect(records[0]?.sourceRef).toEqual({ kind: "anatomy", locusKey: "fingers:left:ring_finger" });
    expectCleanSink(sink);
  });

  it("has no located-fact kind that could claim presence", () => {
    // The structural half of "missing-finger truth comes only from anatomy":
    // there is no registered kind whose rows could assert a part's presence,
    // so a located fact can never project a `presence` aspect.
    for (const kind of appearanceFeatureKindRegistry.definitions) {
      expect(kind.id).not.toContain(APPEARANCE_PRESENCE_ASPECT);
      expect(kind.bodyAreaPath).not.toContain(APPEARANCE_PRESENCE_ASPECT);
    }
    const records = projectFixture({
      locatedFacts: [freckleClusterFact(), scarFact(), birthmarkFact()],
      anatomy: [missingFingerState()],
    });
    const presence = records.filter((record) => record.key.endsWith(`/${APPEARANCE_PRESENCE_ASPECT}`));
    expect(presence).toHaveLength(1);
    expect(presence[0]?.sourceRef.kind).toBe("anatomy");
  });

  it("does not treat an ordinary present part as a feature", () => {
    const present = { ...missingFingerState(), state: "present" as const };
    expect(projectFixture({ anatomy: [present] })).toEqual([]);
  });

  it("projects an alteration with its kind in the fingerprint", () => {
    const prosthetic = {
      ...missingFingerState(),
      state: "prosthetic" as const,
      alterationKindId: "silver_ring_finger",
    };
    const [record] = projectFixture({ anatomy: [prosthetic] });
    expect(record?.truthFingerprint).toBe("prosthetic:silver_ring_finger");
    expect(record?.semanticTags).toContain("silver_ring_finger");
  });
});

describe("degradation", () => {
  it("never throws, and omits what it cannot read", () => {
    const sink = new DiagnosticCollector();
    const records = projectFixture({
      locatedFacts: [
        { ...freckleClusterFact({ id: "fact_unknown_kind" }), kindId: "mark.glitter" },
        { ...freckleClusterFact({ id: "fact_bad_value" }), value: { density: "galactic", pattern: "band" } },
        { ...freckleClusterFact({ id: "fact_nowhere" }), locus: { bodyLocationId: "antenna" } },
        { ...freckleClusterFact({ id: "fact_wrong_place" }), locus: { bodyLocationId: "feet" } },
        freckleClusterFact({ id: "fact_good" }),
      ],
      sink,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.sourceRef).toEqual({ kind: "located_fact", factId: "fact_good" });
    expectDiagnostic(sink, APPEARANCE_FACT_KIND_UNKNOWN);
    expectDiagnostic(sink, APPEARANCE_FACT_VALUE_INVALID);
    expectDiagnostic(sink, APPEARANCE_LOCUS_UNKNOWN_LOCATION);
    expectDiagnostic(sink, APPEARANCE_FACT_LOCUS_NOT_ALLOWED);
  });

  it("keeps the first of two records claiming the same key", () => {
    const sink = new DiagnosticCollector();
    const records = projectFixture({
      locatedFacts: [freckleClusterFact({ id: "fact_a" }), freckleClusterFact({ id: "fact_b", density: "sparse" })],
      sink,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.sourceRef).toEqual({ kind: "located_fact", factId: "fact_a" });
    expectDiagnostic(sink, APPEARANCE_FEATURE_KEY_DUPLICATE);
  });
});

describe("deriveBodyAreaView", () => {
  it("assembles the spec's nested example", () => {
    const view = deriveBodyAreaView(
      projectFixture({
        attributes: crookedNoseAttributes(),
        locatedFacts: [freckleClusterFact()],
        anatomy: [missingFingerState()],
      }),
    );
    expect(view).toEqual({
      shoulders: { surface: { freckles: [{ density: "dense", pattern: "clustered" }] } },
      nose: { geometry: { shape: "crooked" } },
      fingers: { left: { ring_finger: { presence: "absent" } } },
    });
  });

  it("collects repeated marks of one family into a list", () => {
    const view = deriveBodyAreaView(
      projectFixture({
        locatedFacts: [
          freckleClusterFact({ id: "fact_shoulders" }),
          birthmarkFact({ id: "fact_birthmark", locus: { bodyLocationId: "shoulders" } }),
          scarFact({ id: "fact_scar", locus: { bodyLocationId: "shoulders" } }),
        ],
      }),
    );
    expect(view).toEqual({
      shoulders: {
        surface: {
          freckles: [{ density: "dense", pattern: "clustered" }],
          birthmarks: [{ shape: "crescent", size: "small" }],
          scars: [{ shape: "linear", size: "medium" }],
        },
      },
    });
  });

  it("is empty for a body with nothing recognizable", () => {
    expect(deriveBodyAreaView(projectFixture())).toEqual({});
    expect(appearanceFeatureKindRegistry.byId(APPEARANCE_SCAR_KIND_ID)?.persistence).toBe("persistent");
  });
});
