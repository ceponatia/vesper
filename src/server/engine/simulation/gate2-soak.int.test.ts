import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, simWorlds } from "@/server/db";
import { gate2SoakCiProfile, runGate2Soak, type Gate2SoakReport } from "./soak-harness";

/**
 * E2.6 — Gate 2 soak at the CI profile. The heavy lifting happens once in
 * beforeAll; each case then asserts one proof domain of the report so a
 * failure names the proof that broke, with the harness detail attached.
 */
async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // Selecting from sim_snapshots is itself the from-zero migration check.
      db().execute(sql`select 1 from sim_snapshots limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") {
      throw error;
    }
    process.stderr.write(
      `[gate2-soak.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
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
  if (!ready) return;
  report = await runGate2Soak(gate2SoakCiProfile);
}, SOAK_TIMEOUT_MS);

afterAll(async () => {
  if (ready && report) {
    for (const worldId of report.worldIds) {
      await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
    }
  }
  await globalThis.__vesperPool?.end();
});

describe.skipIf(!ready)("E2.6 Gate 2 soak and verdict", () => {
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
