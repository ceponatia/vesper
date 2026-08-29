import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { adapterSupported, adapterUnavailable, affordanceSubjectId } from "../affordances/core";
import { SENSORY_GUSTATORY_NO_ORAL_CONTACT, SENSORY_GUSTATORY_ORAL_CONTACT_UNAVAILABLE } from "./diagnostics";
import { probeGustatoryObservation, probeSensoryBodyLocus, SENSORY_PROBE_OBSERVER, SENSORY_PROBE_PARTNER } from "./fixtures";
import { perceiveGustatory } from "./gustatory";
import { sensoryLocusKey } from "./locus";

/**
 * Taste's access law: explicit committed direct oral contact with the
 * qualifying surface, and nothing else. Falsified against an owner that lets
 * proximity or participation stand in for oral contact, and against one that
 * treats a missing oral-contact read as "no contact" instead of failing closed
 * with the warn.
 */
describe("perceiveGustatory", () => {
  const TASTED = probeSensoryBodyLocus(SENSORY_PROBE_PARTNER, "hands");

  it("admits only an observer whose committed oral contact touches the tasted surface", () => {
    const sink = new DiagnosticCollector();
    const observation = probeGustatoryObservation();
    const touching = {
      observerId: SENSORY_PROBE_OBSERVER,
      oralContact: adapterSupported<ReadonlySet<string>>(new Set([sensoryLocusKey(TASTED)])),
    };
    expect(perceiveGustatory([observation], touching, sink)).toEqual({ perceived: [observation], withheld: [] });

    // Oral contact with a DIFFERENT surface is proximity, not taste.
    const elsewhere = {
      observerId: SENSORY_PROBE_OBSERVER,
      oralContact: adapterSupported<ReadonlySet<string>>(
        new Set([sensoryLocusKey(probeSensoryBodyLocus(SENSORY_PROBE_PARTNER, "neck"))]),
      ),
    };
    const refused = perceiveGustatory([observation], elsewhere, sink);
    expect(refused.perceived).toEqual([]);
    expect(refused.withheld).toEqual([
      { kind: "suppressed", phenomenonId: "probe.trace_taste", code: SENSORY_GUSTATORY_NO_ORAL_CONTACT },
    ]);
    expectCleanSink(sink);
  });

  it("fails closed when no owner can answer what the mouth touches, with the warn", () => {
    const sink = new DiagnosticCollector();
    const perception = perceiveGustatory(
      [probeGustatoryObservation()],
      { observerId: SENSORY_PROBE_OBSERVER, oralContact: adapterUnavailable },
      sink,
    );
    expect(perception.perceived).toEqual([]);
    expect(perception.withheld).toEqual([
      {
        kind: "suppressed",
        phenomenonId: "probe.trace_taste",
        code: SENSORY_GUSTATORY_ORAL_CONTACT_UNAVAILABLE,
        detail: "unavailable",
      },
    ]);
    expectDiagnostic(sink, SENSORY_GUSTATORY_ORAL_CONTACT_UNAVAILABLE, { times: 1 });
    expect(sink.items[0]?.severity).toBe("warn");
  });
});

/**
 * The locus key is the oral-contact membership check's whole basis, so two
 * distinct loci sharing one key is an access-law hole, not a formatting nit.
 * Falsified against the old "|" join, where body ("a", "b|c") and ("a|b", "c")
 * flattened to one key and committed contact with one surface admitted a taste
 * observation standing on the other.
 */
describe("sensoryLocusKey", () => {
  it("keeps loci distinct when their tokens contain the join delimiter", () => {
    const key = sensoryLocusKey(probeSensoryBodyLocus(affordanceSubjectId("a"), "b|c"));
    const other = sensoryLocusKey(probeSensoryBodyLocus(affordanceSubjectId("a|b"), "c"));
    expect(key).not.toBe(other);
  });
});
