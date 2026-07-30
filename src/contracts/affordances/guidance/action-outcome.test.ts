import { describe, expect, it } from "vitest";
import { affordanceEvidence } from "../core";
import { buildActionOutcome, guidanceActionMustResolve } from "./action-outcome";
import { physicalActionStatuses } from "./types";

/**
 * The adapter seam slice 3 plugs into. Its one piece of policy is the
 * `narratorMustResolve` FLOOR: a blocked, partial, or transition-requiring
 * outcome mandates resolution whatever the caller passes, because "the narrator
 * quietly skipped the blocked attempt" is the failure this layer exists to stop.
 */

describe("guidanceActionMustResolve", () => {
  it("mandates resolution for the three statuses the narrator cannot render as done", () => {
    expect(physicalActionStatuses.filter(guidanceActionMustResolve)).toEqual([
      "partially_committed",
      "explicit_transition_required",
      "rejected",
    ]);
  });

  it("leaves committed and unresolved optional — one is the requested beat, the other is silence", () => {
    expect(guidanceActionMustResolve("committed")).toBe(false);
    expect(guidanceActionMustResolve("unresolved")).toBe(false);
  });
});

describe("buildActionOutcome", () => {
  it("stamps a deterministic fingerprint over the resolver's fields", () => {
    const build = () =>
      buildActionOutcome({
        actionId: "reach_one",
        status: "rejected",
        resultCodes: ["blocked_by_support", "no_transition"],
        disclosure: "consistency_only",
        evidence: [affordanceEvidence("contact", "probe.contact", "absent")],
      });
    expect(build()).toEqual(build());
    expect(build().fingerprint).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("distinguishes outcomes that differ only in result order", () => {
    const codes = (resultCodes: readonly string[]) =>
      buildActionOutcome({ actionId: "reach_one", status: "committed", resultCodes, disclosure: "consistency_only" })
        .fingerprint;
    expect(codes(["a", "b"])).not.toBe(codes(["b", "a"]));
  });

  it("cannot be talked out of a mandate", () => {
    const outcome = buildActionOutcome({
      actionId: "reach_one",
      status: "rejected",
      resultCodes: [],
      narratorMustResolve: false,
      disclosure: "consistency_only",
    });
    expect(outcome.narratorMustResolve).toBe(true);
  });

  it("lets a committed outcome opt in to a mandate", () => {
    const outcome = buildActionOutcome({
      actionId: "touch_one",
      status: "committed",
      resultCodes: ["contact_made"],
      narratorMustResolve: true,
      disclosure: "positive_detail_allowed",
    });
    expect(outcome.narratorMustResolve).toBe(true);
  });

  it("defaults evidence to nothing rather than inventing provenance", () => {
    const outcome = buildActionOutcome({
      actionId: "reach_one",
      status: "unresolved",
      resultCodes: [],
      disclosure: "resolver_only",
    });
    expect(outcome.evidence).toEqual([]);
    expect(outcome.narratorMustResolve).toBe(false);
  });
});
