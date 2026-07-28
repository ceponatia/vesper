import { beforeAll, describe, expect, it } from "vitest";
import { simulationSuiteHarness } from "@/server/test-support";
import { gate2SoakCiProfile, runGate2Soak, type Gate2SoakReport } from "./soak-harness";

/**
 * E2.6 — Gate 2 soak at the CI profile. The heavy lifting happens once in
 * beforeAll; each case then asserts one proof domain of the report so a
 * failure names the proof that broke, with the harness detail attached.
 *
 * The soak drives every command through system/scheduler principals, so it opts
 * OUT of the harness's legacy-player guard; the worlds it seeds are handed to
 * the harness for teardown as the report names them.
 */

const harness = await simulationSuiteHarness({
  suite: "gate2-soak.int.test",
  // Selecting from sim_snapshots is itself the from-zero migration check.
  table: "sim_snapshots",
  legacyPlayerMode: false,
});

const SOAK_TIMEOUT_MS = 240_000;

let report: Gate2SoakReport | undefined;

function proofs(report: Gate2SoakReport | undefined, name: string) {
  const matched = (report?.proofs ?? []).filter((proof) => proof.name === name);
  expect(matched.length, `no proof named ${name} was recorded`).toBeGreaterThan(0);
  return matched;
}

function expectAllPass(current: Gate2SoakReport | undefined, name: string): void {
  for (const proof of proofs(current, name)) {
    expect(proof.pass, `${proof.name}: ${proof.detail}`).toBe(true);
  }
}

beforeAll(async () => {
  if (!harness.ready) return;
  report = await runGate2Soak(gate2SoakCiProfile);
  for (const worldId of report.worldIds) harness.trackWorld(worldId);
}, SOAK_TIMEOUT_MS);

describe.runIf(harness.ready)("E2.6 Gate 2 soak and verdict", () => {
  it("advances a synthetic month on every soaked branch", () => {
    expectAllPass(report, "G-month-advanced");
  });

  it("produces identical material outcomes for one skip and equivalent partitions (P1)", () => {
    expectAllPass(report, "P1-partition-invariance");
    expect(report?.materialHash.singleSkip).toBe(report?.materialHash.partitioned);
  });

  it("inherits exactly the pending alarms across the soak fork", () => {
    expectAllPass(report, "G-fork-inherits-alarms");
  });

  it("drives every chaos trigger to a terminal state without duplication (P2)", () => {
    expectAllPass(report, "P2-trigger-no-duplication");
    expect(report?.metrics.chaos.triggersCompleted).toBeGreaterThan(0);
  });

  it("fails stale commands with structured retryable conflicts (P3)", () => {
    expectAllPass(report, "P3-stale-conflict");
    expect(report?.metrics.chaos.staleConflicts).toBeGreaterThan(0);
  });

  it("resumes crashed outbox consumers idempotently (P4)", () => {
    expectAllPass(report, "P4-outbox-crash-resume");
    expect(report?.metrics.chaos.injectedOutboxCrashes).toBeGreaterThan(0);
  });

  it("records derivation versions on every event and terminal trigger (P5)", () => {
    expectAllPass(report, "P5-derivation-recorded");
  });

  it("rebuilds every soaked branch from zero and from snapshot to the live hash (P6)", () => {
    expectAllPass(report, "P6-rebuild-matches");
  });

  it("keeps queues bounded and drains them by month-end", () => {
    expectAllPass(report, "G-queues-bounded-drained");
  });

  it("leaves no duplicate outcomes under injected crashes and replays", () => {
    expectAllPass(report, "G-no-duplicate-outcomes");
    expectAllPass(report, "G-idempotency-replays");
    expect(report?.metrics.chaos.injectedCommandCrashes).toBeGreaterThan(0);
    expect(report?.metrics.chaos.duplicateReplays).toBeGreaterThan(0);
  });

  it("emits useful structured diagnostics for every failure path", () => {
    expectAllPass(report, "G-diagnostics");
    expect(Object.keys(report?.metrics.chaos.rejectionCodes ?? {}).length).toBeGreaterThan(0);
  });

  it("schedules idempotently, rebuilds feeds, and explains placements causally", () => {
    expectAllPass(report, "G-schedule-idempotent");
    expectAllPass(report, "G-feed-rebuild");
    expectAllPass(report, "G-audit-explains");
  });
});
