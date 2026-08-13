import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import {
  bodyDetailSchemaById,
  bodyDetailSchemas,
  bodyLocusKey,
  coarsenBodyLocusRef,
  humanoidHandSegmentIds,
  validateBodyLocusRef,
  validateBodyLocusRefStrict,
  APPEARANCE_LOCUS_DETAIL_COARSENED,
  APPEARANCE_LOCUS_DETAIL_INVALID,
  APPEARANCE_LOCUS_UNKNOWN_LOCATION,
  HUMANOID_HAND_DETAIL_SCHEMA_ID,
  type BodyLocusRef,
} from "./locus";

/**
 * Fine locus rules (spec §Fine body locus without coverage-tree explosion):
 * the coarse location is always legal, detail paths are registry-validated,
 * and unsupported detail heals for appearance reads while failing closed for
 * topology writes.
 */

const ringFinger: BodyLocusRef = {
  bodyLocationId: "fingers",
  side: "left",
  detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["ring_finger"] },
};

describe("detail-schema registry", () => {
  it("ships exactly the humanoid hand, with the five named digits", () => {
    expect([...bodyDetailSchemas.keys()]).toEqual([HUMANOID_HAND_DETAIL_SCHEMA_ID]);
    expect(bodyDetailSchemaById(HUMANOID_HAND_DETAIL_SCHEMA_ID)?.segments).toEqual([...humanoidHandSegmentIds]);
  });
});

describe("validateBodyLocusRef", () => {
  it("accepts a coarse locus untouched", () => {
    const sink = new DiagnosticCollector();
    const result = validateBodyLocusRef({ bodyLocationId: "shoulders" }, sink);
    expect(result.ok).toBe(true);
    expect(result.locus).toEqual({ bodyLocationId: "shoulders" });
    expect(result.coarsened).toBe(false);
    expectCleanSink(sink);
  });

  it("accepts a registered detail path", () => {
    const sink = new DiagnosticCollector();
    const result = validateBodyLocusRef(ringFinger, sink);
    expect(result.ok).toBe(true);
    expect(bodyLocusKey(ringFinger)).toBe("fingers:left:ring_finger");
    expectCleanSink(sink);
  });

  it("fails closed on an unknown body location, in both modes", () => {
    const sink = new DiagnosticCollector();
    const appearance = validateBodyLocusRef({ bodyLocationId: "antenna" }, sink);
    const topology = validateBodyLocusRefStrict({ bodyLocationId: "antenna" }, sink);
    expect(appearance.ok).toBe(false);
    expect(topology.ok).toBe(false);
    expectDiagnostic(sink, APPEARANCE_LOCUS_UNKNOWN_LOCATION, { times: 2 });
  });

  it("coarsens an unknown path segment for an appearance read", () => {
    const sink = new DiagnosticCollector();
    const result = validateBodyLocusRef(
      { bodyLocationId: "fingers", side: "left", detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["sixth_finger"] } },
      sink,
    );
    expect(result.ok).toBe(true);
    expect(result.coarsened).toBe(true);
    expect(result.locus).toEqual({ bodyLocationId: "fingers", side: "left" });
    expectDiagnostic(sink, APPEARANCE_LOCUS_DETAIL_COARSENED);
  });

  it("coarsens an unknown detail schema, and refuses a schema that does not apply here", () => {
    const sink = new DiagnosticCollector();
    const unknownSchema = validateBodyLocusRef(
      { bodyLocationId: "fingers", detail: { schemaId: "alien_hand_v9", path: ["claw"] } },
      sink,
    );
    const misapplied = validateBodyLocusRef(
      { bodyLocationId: "nose", detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["ring_finger"] } },
      sink,
    );
    expect(unknownSchema.locus).toEqual({ bodyLocationId: "fingers" });
    expect(misapplied.locus).toEqual({ bodyLocationId: "nose" });
    expectDiagnostic(sink, APPEARANCE_LOCUS_DETAIL_COARSENED, { times: 2 });
  });

  it("rejects the same unsupported detail for a topology write", () => {
    const sink = new DiagnosticCollector();
    const result = validateBodyLocusRefStrict(
      { bodyLocationId: "fingers", side: "left", detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["sixth_finger"] } },
      sink,
    );
    expect(result.ok).toBe(false);
    expect(result.locus).toBeNull();
    expectDiagnostic(sink, APPEARANCE_LOCUS_DETAIL_INVALID);
  });

  it("never throws on a malformed reference", () => {
    const sink = new DiagnosticCollector();
    // A JSONB row that lost its shape — degradation, not an exception.
    const broken = { bodyLocationId: "" } as unknown as { bodyLocationId: string };
    expect(() => validateBodyLocusRef(broken, sink)).not.toThrow();
    expect(validateBodyLocusRef(broken, sink).ok).toBe(false);
  });
});

describe("coarsenBodyLocusRef", () => {
  it("keeps the side and drops only the detail path", () => {
    expect(coarsenBodyLocusRef(ringFinger)).toEqual({ bodyLocationId: "fingers", side: "left" });
  });

  it("is identity for a locus that has no detail", () => {
    const locus = { bodyLocationId: "shoulders" };
    expect(coarsenBodyLocusRef(locus)).toBe(locus);
  });
});
