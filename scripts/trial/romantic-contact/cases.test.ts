import { describe, expect, it } from "vitest";
import type { ChatContactTurnRecord } from "@/server/engine";
import { assertRequiredState, deriveCaseState, TRIAL_CASES, type ObservedCase } from "./cases";

/**
 * The required-state check, which is what actually decides whether a rollout
 * case passed.
 *
 * The prose oracle cannot do this job, and was briefly asked to. It only ever
 * asks whether the narration contradicts what happened, so on its own it passes
 * a withdrawal that ended nothing (nothing ended, so nothing is contradicted)
 * and a retake that left two contacts (both are live, so "still touching" is
 * true). Those are exactly the two cases the trial exists to prove, and both
 * would have reported green.
 *
 * The second thing these pin is that the check reads what HAPPENED, never what
 * the case intended. Deriving observed state from a case's own expectation would
 * make the whole rerun self-confirming: a case labelled "should refuse" that
 * silently committed would be graded against the refusal it was supposed to
 * produce.
 */

const turn = (over: Partial<ChatContactTurnRecord> = {}): ChatContactTurnRecord => ({
  resultCodes: [],
  committed: false,
  ended: [],
  guidanceLines: [],
  ...over,
});

const CARESS = { kind: "romantic", gesture: "caress", targetLocationId: "arms" } as const;

const observed = (over: Partial<ObservedCase> = {}): ObservedCase => ({
  turn: turn(),
  beforeSetup: { contactIds: [] },
  afterSetup: { contactIds: [] },
  afterExchange: { contactIds: [] },
  permissionStanding: "none",
  attemptDeniedBound: false,
  ...over,
});

const fields = (failures: readonly { field: string }[]): readonly string[] => failures.map((entry) => entry.field);

function expectationFor(id: string) {
  const found = TRIAL_CASES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`the ${id} case is missing`);
  return found.expect;
}

describe("the withdrawal case — the sweep runs during SETUP, not during the exchange", () => {
  const expectation = expectationFor("withdrawal");

  /**
   * The withdrawal's dependent-contact sweep runs in the same transaction that
   * records the withdrawal, so the contact is already gone before the exchange
   * begins. A check that only looked either side of the EXCHANGE would see
   * nothing end and pass a run in which the sweep never fired.
   */
  it("passes when a live contact disappears across the setup and stays gone", () => {
    expect(
      assertRequiredState(
        observed({
          turn: null,
          beforeSetup: { contactIds: ["contact_1"] },
          afterSetup: { contactIds: [] },
          afterExchange: { contactIds: [] },
          permissionStanding: "withdrawn",
        }),
        expectation,
      ),
    ).toEqual([]);
  });

  it("fails when nothing was live to end — the case proved nothing", () => {
    const failures = assertRequiredState(observed({ turn: null, permissionStanding: "withdrawn" }), expectation);
    expect(fields(failures)).toContain("endedPairContacts");
  });

  it("fails when the contact survives the withdrawal", () => {
    const failures = assertRequiredState(
      observed({
        turn: null,
        beforeSetup: { contactIds: ["contact_1"] },
        afterSetup: { contactIds: ["contact_1"] },
        afterExchange: { contactIds: ["contact_1"] },
        permissionStanding: "withdrawn",
      }),
      expectation,
    );
    expect(fields(failures)).toEqual(expect.arrayContaining(["pairContactsAfter", "endedPairContacts"]));
  });
});

describe("the retake case — identity, not just a count", () => {
  const expectation = expectationFor("retake");
  const committed = turn({ act: { ...CARESS, actionId: "a1" }, status: "committable", committed: true });

  it("passes when the same contact survives the rerun", () => {
    expect(
      assertRequiredState(
        observed({
          turn: committed,
          beforeSetup: { contactIds: ["contact_1"] },
          afterSetup: { contactIds: ["contact_1"] },
          afterExchange: { contactIds: ["contact_1"] },
          permissionStanding: "granted",
          priorPairContactIds: ["contact_1"],
        }),
        expectation,
      ),
    ).toEqual([]);
  });

  it("fails when the retake duplicated the contact", () => {
    const failures = assertRequiredState(
      observed({
        turn: committed,
        beforeSetup: { contactIds: ["contact_1"] },
        afterSetup: { contactIds: ["contact_1"] },
        afterExchange: { contactIds: ["contact_1", "contact_2"] },
        permissionStanding: "granted",
        priorPairContactIds: ["contact_1"],
      }),
      expectation,
    );
    expect(fields(failures)).toEqual(expect.arrayContaining(["pairContactsAfter", "pairContactIds"]));
  });

  /**
   * The case a count alone cannot catch: one contact before, one after, but a
   * DIFFERENT one — the retake ended the original and started a fresh contact
   * rather than reproducing it.
   */
  it("fails when the surviving contact is a different one", () => {
    const failures = assertRequiredState(
      observed({
        turn: committed,
        beforeSetup: { contactIds: ["contact_1"] },
        afterSetup: { contactIds: ["contact_1"] },
        afterExchange: { contactIds: ["contact_9"] },
        permissionStanding: "granted",
        priorPairContactIds: ["contact_1"],
      }),
      expectation,
    );
    expect(fields(failures)).toEqual(["endedPairContacts", "pairContactIds"]);
  });
});

describe("the no-grant case — the exact refusal, not merely a refusal", () => {
  const expectation = expectationFor("no_grant");

  it("passes on an unanswered permission owner with the premise rendered", () => {
    expect(
      assertRequiredState(
        observed({
          turn: turn({
            act: { ...CARESS, actionId: "a1" },
            status: "unresolved",
            reason: "permission_unresolved",
            premiseKind: "permission",
          }),
        }),
        expectation,
      ),
    ).toEqual([]);
  });

  /**
   * The substitution the case is written to rule out. An unestablished REACH is
   * also `unresolved`, also commits nothing, and would read as a clean refusal —
   * while proving nothing at all about permission.
   */
  it("fails when the refusal was distance rather than permission", () => {
    const failures = assertRequiredState(
      observed({
        turn: turn({
          act: { ...CARESS, actionId: "a1" },
          status: "unresolved",
          reason: "geometry_unavailable",
          premiseKind: "reach",
        }),
      }),
      expectation,
    );
    expect(fields(failures)).toEqual(["resolver.reason", "guidanceKind"]);
  });

  it("fails when a stale grant let the touch commit", () => {
    const failures = assertRequiredState(
      observed({
        turn: turn({ act: { ...CARESS, actionId: "a1" }, status: "committable", committed: true }),
        afterExchange: { contactIds: ["contact_1"] },
        permissionStanding: "granted",
      }),
      expectation,
    );
    expect(fields(failures)).toEqual(
      expect.arrayContaining(["resolver.status", "durableCommits", "pairContactsAfter", "permissionStanding"]),
    );
  });
});

describe("the denial case — the denial must be bound to this attempt", () => {
  const expectation = expectationFor("explicit_denial");

  it("passes on a rejection whose denial names this attempt", () => {
    expect(
      assertRequiredState(
        observed({
          turn: turn({ act: { ...CARESS, actionId: "a1" }, status: "rejected", reason: "permission_denied" }),
          attemptDeniedBound: true,
        }),
        expectation,
      ),
    ).toEqual([]);
  });

  /**
   * An unbound `attempt_denied` changes nothing: the policy read applies a
   * denial only when it names the attempt being resolved. The turn then falls
   * through to "nobody answered" — which commits nothing and looks like a
   * successful denial test unless the reason is checked.
   */
  it("fails when the turn actually resolved as unanswered", () => {
    const failures = assertRequiredState(
      observed({
        turn: turn({
          act: { ...CARESS, actionId: "a1" },
          status: "unresolved",
          reason: "permission_unresolved",
          premiseKind: "permission",
        }),
      }),
      expectation,
    );
    expect(fields(failures)).toEqual(
      expect.arrayContaining(["resolver.status", "resolver.reason", "guidanceKind", "attemptDeniedBound"]),
    );
  });
});

describe("the act itself", () => {
  const expectation = expectationFor("commit");

  it("fails when the line produced no act at all — silence is not a refusal", () => {
    const failures = assertRequiredState(
      observed({ turn: turn({ status: "none" }), permissionStanding: "granted" }),
      expectation,
    );
    expect(fields(failures)).toContain("act");
  });

  it("fails when the act landed on a different surface than the case names", () => {
    const failures = assertRequiredState(
      observed({
        turn: turn({
          act: { kind: "romantic", gesture: "caress", targetLocationId: "hands", actionId: "a1" },
          status: "committable",
          committed: true,
        }),
        afterExchange: { contactIds: ["contact_1"] },
        permissionStanding: "granted",
      }),
      expectation,
    );
    expect(fields(failures)).toEqual(["act.targetLocationId"]);
  });
});

describe("deriving what the prose oracle grades against", () => {
  it("reads the recorded material fact, not the case's intent", () => {
    expect(
      deriveCaseState(
        observed({
          turn: turn({ status: "committable", committed: true, directSkinContact: false }),
          afterExchange: { contactIds: ["contact_1"] },
        }),
      ),
    ).toEqual({ committed: true, layer: "through_layer", endedLiveContact: false, contactLiveAfter: true });
  });

  it("states no layer when nothing committed — there is no fact to contradict", () => {
    const state = deriveCaseState(observed({ turn: turn({ status: "unresolved", reason: "permission_unresolved" }) }));
    expect(state.layer).toBeUndefined();
    expect(state.committed).toBe(false);
  });

  it("sees a contact disappear across the whole case, setup included", () => {
    const state = deriveCaseState(
      observed({ turn: null, beforeSetup: { contactIds: ["contact_1"] }, afterSetup: { contactIds: [] } }),
    );
    expect(state.endedLiveContact).toBe(true);
    expect(state.contactLiveAfter).toBe(false);
  });
});

describe("the case list", () => {
  it("covers the six the owner named", () => {
    expect([...TRIAL_CASES].map((entry) => entry.id).sort()).toEqual([
      "commit",
      "explicit_denial",
      "natural_named",
      "no_grant",
      "retake",
      "withdrawal",
    ]);
  });

  /**
   * The retake reruns the previous case's persisted user line, so anything
   * scheduled between them would move the message it targets — and the runner
   * would rerun the wrong turn, or refuse because the text no longer matches.
   */
  it("puts the retake immediately after the exchange it reruns, on the same line", () => {
    const ids = TRIAL_CASES.map((entry) => entry.id);
    expect(ids.indexOf("retake")).toBe(ids.indexOf("commit") + 1);
    const commit = TRIAL_CASES.find((entry) => entry.id === "commit");
    const retake = TRIAL_CASES.find((entry) => entry.id === "retake");
    expect(retake?.rerun).toBe("previous");
    expect(retake?.line).toBe(commit?.line);
  });

  it("runs the no-grant case before anything can put an answer on the ledger", () => {
    expect(TRIAL_CASES[0]?.id).toBe("no_grant");
    expect(TRIAL_CASES[0]?.setup).toBe("none");
  });

  /**
   * The no-grant line closes its own distance, and is the committing line with
   * the grant removed. Without that the attempt could refuse for reach instead,
   * and the case would report a refusal that says nothing about permission.
   */
  it("gives the no-grant case the same line as the committing case", () => {
    const noGrant = TRIAL_CASES.find((entry) => entry.id === "no_grant");
    const commit = TRIAL_CASES.find((entry) => entry.id === "commit");
    expect(noGrant?.line).toBe(commit?.line);
    expect(noGrant?.setup).toBe("none");
    expect(commit?.setup).toBe("grant");
  });
});
