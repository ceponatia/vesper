import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { adapterInvalid, adapterSupported, adapterUnavailable, type AdapterRead } from "../affordances/core";
import { SENSORY_OLFACTORY_OUT_OF_RANGE, SENSORY_OLFACTORY_RANGE_UNAVAILABLE } from "./diagnostics";
import { probeOlfactoryObservation, SENSORY_PROBE_OBSERVER } from "./fixtures";
import { perceiveOlfactory } from "./olfactory";

/**
 * Smell's access law: a real range answer is required, and a missing one can
 * never read as "odorless" or "clean". Falsified against an owner that treats
 * an unanswered range as within range, and against one that reports an
 * attested out-of-range answer as a degradation.
 */
describe("perceiveOlfactory", () => {
  function access(range: AdapterRead<boolean>) {
    return { observerId: SENSORY_PROBE_OBSERVER, scentRange: () => range };
  }

  it("admits an observer the lane attests is within range", () => {
    const sink = new DiagnosticCollector();
    const observation = probeOlfactoryObservation();
    expect(perceiveOlfactory([observation], access(adapterSupported(true)), sink)).toEqual({
      perceived: [observation],
      withheld: [],
    });
    expectCleanSink(sink);
  });

  it("refuses an attested out-of-range observer as an answer — suppression, no diagnostic", () => {
    const sink = new DiagnosticCollector();
    const perception = perceiveOlfactory([probeOlfactoryObservation()], access(adapterSupported(false)), sink);
    expect(perception.perceived).toEqual([]);
    expect(perception.withheld).toEqual([
      { kind: "suppressed", phenomenonId: "probe.trace_scent", code: SENSORY_OLFACTORY_OUT_OF_RANGE },
    ]);
    expectCleanSink(sink);
  });

  it.each<[string, AdapterRead<never>]>([
    ["unavailable", adapterUnavailable],
    ["invalid", adapterInvalid],
  ])("fails closed when the range read is %s, with the warn that an owner could not answer", (status, read) => {
    const sink = new DiagnosticCollector();
    const perception = perceiveOlfactory([probeOlfactoryObservation()], access(read), sink);
    expect(perception.perceived).toEqual([]);
    expect(perception.withheld).toEqual([
      {
        kind: "suppressed",
        phenomenonId: "probe.trace_scent",
        code: SENSORY_OLFACTORY_RANGE_UNAVAILABLE,
        detail: status,
      },
    ]);
    expectDiagnostic(sink, SENSORY_OLFACTORY_RANGE_UNAVAILABLE, { times: 1 });
    expect(sink.items[0]?.severity).toBe("warn");
  });
});
