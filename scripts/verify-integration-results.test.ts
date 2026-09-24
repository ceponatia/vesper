import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildVitestArgs } from "./ci-integration.mjs";
import { integrationCensus, inventoryHash } from "./integration-policy.mjs";
import {
  authoritativeAttemptsFromJobs,
  loadEvidence,
  renderSummary,
  verifyIntegrationEvidence,
  type EvidenceBatch,
  type VerificationResult,
} from "./verify-integration-results.mjs";

/**
 * The integration evidence verifier (#638). A small synthetic universe —
 * four strict suites across two shards, one legacy suite that lands entirely
 * in shard 1 (so shard 2's legacy batch is PLANNED empty) — is the accepted
 * baseline; every deny row breaks exactly one property of it.
 */

const ROOT = "/home/runner/work/vesper/vesper";
const SHA = "a".repeat(40);
const RUN_ID = "4242";
const REASON = "submits an account-less player against unanchored branches";
const A = "apps/web/src/a.int.test.ts";
const B = "apps/web/src/b.int.test.ts";
const C = "apps/web/src/c.int.test.ts";
const D = "scripts/d.int.test.ts";
const E = "apps/web/src/e.int.test.ts";
const PURE = "apps/web/src/x.test.ts";
const TRACKED = [A, B, C, D, E, PURE, "docs/testing.md"];

type Mode = "strict" | "legacy";
type Plans = Record<Mode, [string[], string[]]>;

const DEFAULT_PLANS: Plans = { strict: [[A, C], [B, D]], legacy: [[E], []] };

interface Envelope {
  mode: Mode;
  shard: { index: number; count: number };
  root: string;
  checkout: { sha: string; prHead: string | null; prBase: string | null };
  run: { id: string; attempt: number; job: string };
  policy: { version: number; hash: string };
  universe: { files: string[]; hash: string };
  inventory: { files: string[]; hash: string };
  planned: string[];
  database: { name: string; host: string };
  environment: { integrationMode: string; legacyCapability: string; requireIntegrationDb: boolean };
  argv: string[];
  setup: { status: string; steps: unknown[]; problems: string[] };
  execution: { status: string; exitCode: number | null; signal: string | null; durationMs: number; report: string | null };
  [key: string]: unknown;
}

interface CaseResult {
  fullName: string;
  status: string;
  meta: Record<string, unknown>;
}

interface FileResult {
  name: string;
  status: string;
  message: string;
  assertionResults: CaseResult[];
}

interface Report {
  success: boolean;
  testResults: FileResult[];
}

interface Batch extends EvidenceBatch {
  envelope: Envelope;
  report: Report | null;
}

function attestation(mode: Mode, file: string) {
  return {
    vesperIntegration: {
      mode,
      file,
      legacyCapability: mode === "legacy" ? "enabled" : "absent",
      strictDatabase: true,
      fakeProviders: true,
    },
  };
}

function fileResult(mode: Mode, file: string): FileResult {
  return {
    name: `${ROOT}/${file}`,
    status: "passed",
    message: "",
    assertionResults: [{ fullName: `${file} holds`, status: "passed", meta: attestation(mode, file) }],
  };
}

function makeCensus(exceptions = [{ file: E, reason: REASON }], tracked = TRACKED) {
  return integrationCensus(tracked, exceptions);
}

function makeBatch(
  census: ReturnType<typeof makeCensus>,
  mode: Mode,
  index: number,
  planned: string[],
  attempt = 1,
): Batch {
  const inventory = mode === "strict" ? census.strict : census.legacy;
  const empty = planned.length === 0;
  const shard = { index, count: 2 };
  return {
    artifact: `integration-evidence-shard-${index}-of-2-attempt-${attempt}`,
    dir: mode,
    envelopeError: null,
    reportError: null,
    envelope: {
      schema: "vesper.integration-evidence",
      version: 1,
      mode,
      shard,
      root: ROOT,
      checkout: { sha: SHA, prHead: null, prBase: null },
      run: { id: RUN_ID, attempt, job: "integration" },
      policy: { version: 1, hash: census.policyHash },
      universe: { files: census.universe, hash: inventoryHash(census.universe) },
      inventory: { files: inventory, hash: inventoryHash(inventory) },
      planned,
      database: { name: `vesper_ci_${mode}`, host: "localhost:5435" },
      environment: { integrationMode: mode, legacyCapability: mode === "legacy" ? "enabled" : "absent", requireIntegrationDb: true },
      argv: empty
        ? []
        : [
            "pnpm",
            ...buildVitestArgs({
              shard,
              reportFile: `${ROOT}/integration-evidence/${mode}/report.json`,
              passWithNoTests: inventory.length < shard.count,
            }),
          ],
      setup: { status: "ok", steps: [], problems: [] },
      execution: empty
        ? { status: "no-work", exitCode: null, signal: null, durationMs: 0, report: null }
        : { status: "passed", exitCode: 0, signal: null, durationMs: 1_000, report: "report.json" },
    },
    report: empty ? null : { success: true, testResults: planned.map((file) => fileResult(mode, file)) },
  };
}

function baseline(plans: Plans = DEFAULT_PLANS, census = makeCensus()): Batch[] {
  const batches: Batch[] = [];
  for (const mode of ["strict", "legacy"] as const) {
    plans[mode].forEach((planned, offset) => batches.push(makeBatch(census, mode, offset + 1, planned)));
  }
  return batches;
}

function find(batches: Batch[], mode: Mode, index: number): Batch {
  const batch = batches.find((entry) => entry.envelope.mode === mode && entry.envelope.shard.index === index);
  if (batch === undefined) throw new Error(`no ${mode} ${index} batch in the fixture`);
  return batch;
}

function reportOf(batch: Batch): Report {
  if (batch.report === null) throw new Error("the fixture batch has no report");
  return batch.report;
}

function firstFile(batch: Batch): FileResult {
  const result = reportOf(batch).testResults[0];
  if (result === undefined) throw new Error("the fixture report is empty");
  return result;
}

interface VerifyOptions {
  census?: ReturnType<typeof makeCensus>;
  attempts?: Map<number, number> | null;
  runAttempt?: number;
  shardCount?: number;
  prHead?: string | null;
}

function verify(batches: Batch[], options: VerifyOptions = {}): VerificationResult {
  return verifyIntegrationEvidence({
    batches,
    census: options.census ?? makeCensus(),
    identity: { sha: SHA, runId: RUN_ID, runAttempt: options.runAttempt ?? 1, prHead: options.prHead ?? null, prBase: null },
    shardCount: options.shardCount ?? 2,
    authoritativeAttempts: options.attempts === undefined ? new Map([[1, 1], [2, 1]]) : options.attempts,
  });
}

describe("accepted evidence", () => {
  it("accepts one clean batch per mode and shard, including a planned-empty legacy shard", () => {
    const result = verify(baseline());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ universe: 5, strict: 4, legacy: 1, executedFiles: 5 });
  });

  it("accepts an empty legacy mode when no exception is listed", () => {
    const census = makeCensus([]);
    const result = verify(baseline({ strict: [[A, C, E], [B, D]], legacy: [[], []] }, census), { census });
    expect(result.problems).toEqual([]);
  });

  it("takes the rerun attempt of a shard and ignores the attempt it superseded", () => {
    const census = makeCensus();
    const batches = baseline();
    for (const mode of ["strict", "legacy"] as const) {
      const failed = find(batches, mode, 2);
      failed.envelope.execution = { ...failed.envelope.execution, status: "failed", exitCode: 1 };
    }
    batches.push(makeBatch(census, "strict", 2, [B, D], 2), makeBatch(census, "legacy", 2, [], 2));
    const result = verify(batches, { attempts: new Map([[1, 1], [2, 2]]), runAttempt: 2 });
    expect(result.problems).toEqual([]);
  });
});

describe("rejected evidence", () => {
  const rows: [string, (batches: Batch[]) => void, RegExp, VerifyOptions?][] = [
    [
      "duplicate shards (one file planned and executed by both strict shards)",
      (batches) => {
        const second = find(batches, "strict", 2);
        second.envelope.planned = [A, B, D];
        reportOf(second).testResults.push(fileResult("strict", A));
      },
      /planned in 2 shards[\s\S]*executed 2 times across the integration gate/,
    ],
    [
      "two batches for the same mode, shard and attempt",
      (batches) => {
        batches.push(structuredClone(find(batches, "strict", 1)));
      },
      /2 strict batches for shard 1\/2 at attempt 1/,
    ],
    [
      "a missing report",
      (batches) => {
        const batch = find(batches, "strict", 1);
        batch.report = null;
        batch.reportError = "missing report.json";
      },
      /report missing report\.json/,
    ],
    [
      "a malformed or truncated envelope",
      (batches) => {
        const batch = find(batches, "legacy", 1);
        batch.envelopeError = "unreadable or malformed JSON (Unexpected end of JSON input)";
      },
      /malformed JSON[\s\S]*missing legacy batch for shard 1\/2/,
    ],
    [
      "a truncated report",
      (batches) => {
        const batch = find(batches, "strict", 2);
        batch.report = null;
        batch.reportError = "unreadable or malformed JSON (Unterminated string in JSON)";
      },
      /report unreadable or malformed JSON/,
    ],
    [
      "evidence from another checkout",
      (batches) => {
        find(batches, "strict", 1).envelope.checkout.sha = "b".repeat(40);
      },
      /stale evidence/,
    ],
    [
      "evidence from another policy",
      (batches) => {
        find(batches, "legacy", 1).envelope.policy.hash = "0".repeat(64);
      },
      /ran under policy/,
    ],
    [
      "an older attempt standing in for a newer, failed or unfinished rerun",
      () => undefined,
      /missing strict batch for shard 2\/2 from attempt 2[\s\S]*missing legacy batch for shard 2\/2 from attempt 2/,
      { attempts: new Map([[1, 1], [2, 2]]), runAttempt: 2 },
    ],
    [
      "a pure app-project file in an integration report",
      (batches) => {
        reportOf(find(batches, "strict", 1)).testResults.push(fileResult("strict", PURE));
      },
      /executed unplanned file apps\/web\/src\/x\.test\.ts \(a pure app-project file\)/,
    ],
    [
      "an all-skipped file",
      (batches) => {
        const file = firstFile(find(batches, "strict", 1));
        file.assertionResults = [{ fullName: "skipped", status: "skipped", meta: {} }];
      },
      /not allowed in the required gate[\s\S]*executed no passing case/,
    ],
    [
      "an unapproved skipped case beside passing ones",
      (batches) => {
        firstFile(find(batches, "strict", 1)).assertionResults.push({ fullName: "later", status: "skipped", meta: {} });
      },
      /later ended "skipped"/,
    ],
    [
      "a todo case",
      (batches) => {
        firstFile(find(batches, "legacy", 1)).assertionResults.push({ fullName: "someday", status: "todo", meta: {} });
      },
      /someday ended "todo"/,
    ],
    [
      "a failed case",
      (batches) => {
        const batch = find(batches, "strict", 2);
        const file = firstFile(batch);
        file.status = "failed";
        file.assertionResults = [{ fullName: "breaks", status: "failed", meta: attestation("strict", B) }];
        reportOf(batch).success = false;
      },
      /breaks failed[\s\S]*did not pass[\s\S]*does not record success/,
    ],
    [
      "a file that failed at collection",
      (batches) => {
        const file = firstFile(find(batches, "strict", 1));
        file.status = "failed";
        file.message = "Error: [integration mode] strict mode must not carry the capability";
        file.assertionResults = [];
      },
      /did not pass \("failed"\): Error: \[integration mode\][\s\S]*executed no passing case/,
    ],
    [
      "a broken setup",
      (batches) => {
        const batch = find(batches, "legacy", 1);
        batch.envelope.setup = { status: "failed", steps: [], problems: ["migrate from zero failed for vesper_ci_legacy"] };
      },
      /setup failed — migrate from zero failed/,
    ],
    [
      "a failed execution",
      (batches) => {
        find(batches, "strict", 1).envelope.execution.status = "failed";
        find(batches, "strict", 1).envelope.execution.exitCode = 1;
      },
      /execution failed \(exit 1/,
    ],
    [
      "a timed-out or cancelled execution",
      (batches) => {
        const execution = find(batches, "strict", 2).envelope.execution;
        Object.assign(execution, { status: "failed", exitCode: null, signal: "SIGTERM" });
      },
      /signal "SIGTERM"/,
    ],
    [
      "a missing batch",
      (batches) => {
        batches.splice(batches.indexOf(find(batches, "legacy", 2)), 1);
      },
      /missing legacy batch for shard 2\/2 from attempt 1/,
    ],
    [
      "an accidental zero collection",
      (batches) => {
        reportOf(find(batches, "strict", 1)).testResults = [];
      },
      /planned apps\/web\/src\/a\.int\.test\.ts but it never executed/,
    ],
    [
      "a planned-empty shard that recorded a run instead of no-work",
      (batches) => {
        const batch = find(batches, "legacy", 2);
        Object.assign(batch.envelope.execution, { status: "passed", exitCode: 0, report: "report.json" });
      },
      /planned no files but recorded execution "passed" instead of no-work/,
    ],
    [
      "a nonempty shard that recorded no-work",
      (batches) => {
        Object.assign(find(batches, "strict", 1).envelope.execution, { status: "no-work", report: null });
      },
      /planned 2 file\(s\) but recorded no-work/,
    ],
    [
      "a legacy file run in the strict mode",
      (batches) => {
        const batch = find(batches, "strict", 1);
        batch.envelope.inventory.files = [A, B, C, D, E];
        batch.envelope.planned = [A, C, E];
        reportOf(batch).testResults.push(fileResult("strict", E));
      },
      /strict inventory differs from the policy partition \(missing none; unexpected apps\/web\/src\/e\.int\.test\.ts\)[\s\S]*e\.int\.test\.ts executed 2 times/,
    ],
    [
      "a case with no worker attestation",
      (batches) => {
        const file = firstFile(find(batches, "strict", 1));
        file.assertionResults = [{ fullName: "bare", status: "passed", meta: {} }];
      },
      /bare carries no worker attestation/,
    ],
    [
      "a strict case attesting the legacy capability",
      (batches) => {
        const file = firstFile(find(batches, "strict", 2));
        file.assertionResults = [{ fullName: "leaky", status: "passed", meta: attestation("legacy", B) }];
      },
      /leaky attests mode="legacy", expected "strict"/,
    ],
    [
      "a legacy batch that recorded no capability",
      (batches) => {
        find(batches, "legacy", 1).envelope.environment.legacyCapability = "absent";
      },
      /recorded environment .* does not match its mode/,
    ],
    [
      "an argv with the -- separator",
      (batches) => {
        const argv = find(batches, "strict", 1).envelope.argv;
        argv.splice(3, 0, "--");
      },
      /bare -- separator/,
    ],
    [
      "an argv without the integration project",
      (batches) => {
        const envelope = find(batches, "strict", 2).envelope;
        envelope.argv = envelope.argv.filter((arg) => arg !== "--project=app-int");
      },
      /differs from the launcher's construction/,
    ],
    ["no way to tell which attempt is authoritative", () => undefined, /refusing to guess/, { attempts: null }],
    [
      "no evidence at all",
      (batches) => {
        batches.splice(0);
      },
      /no integration evidence was downloaded/,
    ],
    [
      "a stale exception in the policy",
      () => undefined,
      /policy: stale legacy exception \(no such integration suite\): apps\/web\/src\/gone\.int\.test\.ts/,
      { census: makeCensus([{ file: E, reason: REASON }, { file: "apps/web/src/gone.int.test.ts", reason: REASON }]) },
    ],
    [
      "a batch that discovered a different universe",
      (batches) => {
        find(batches, "strict", 1).envelope.universe.files = [A, B, C, E];
      },
      /discovered universe differs from the tracked one \(missing 1, unexpected 0\)/,
    ],
    [
      "evidence from another run",
      (batches) => {
        find(batches, "legacy", 1).envelope.run.id = "999";
      },
      /evidence belongs to run 999/,
    ],
    [
      "a disagreeing shard count",
      () => undefined,
      /GitHub reports no execution of integration shard 3\/3[\s\S]*shard count 2, expected 3/,
      { shardCount: 3 },
    ],
    [
      "an artifact name that disagrees with its envelope",
      (batches) => {
        find(batches, "strict", 1).dir = "legacy";
      },
      /artifact name and directory do not match/,
    ],
    [
      "an attempt from the future",
      (batches) => {
        const batch = find(batches, "strict", 1);
        batch.envelope.run.attempt = 3;
        batch.artifact = "integration-evidence-shard-1-of-2-attempt-3";
      },
      /claims attempt 3, after this verification's attempt 1/,
    ],
    ["evidence for another pull request head", () => undefined, /pull request head\/base differ/, { prHead: "c".repeat(40) }],
    [
      "a report entry outside the checkout",
      (batches) => {
        firstFile(find(batches, "strict", 1)).name = `/elsewhere/${A}`;
      },
      /is outside the checkout/,
    ],
    [
      "a batch on the wrong database",
      (batches) => {
        find(batches, "strict", 2).envelope.database.name = "vesper_dev";
      },
      /did not run against its own vesper_ci_strict database/,
    ],
    [
      "a report that does not record success",
      (batches) => {
        reportOf(find(batches, "strict", 1)).success = false;
      },
      /does not record success/,
    ],
  ];

  it.each(rows)("rejects %s", (_label, mutate, problem, options) => {
    const batches = baseline();
    mutate(batches);
    const result = verify(batches, options);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(problem);
  });
});

describe("authoritative attempts", () => {
  it("takes each shard's latest execution and ignores other jobs and shard counts", () => {
    const attempts = authoritativeAttemptsFromJobs(
      [
        { id: 1, name: "integration (1/2)", run_attempt: 1 },
        { id: 2, name: "integration (2/2)", run_attempt: 1 },
        { id: 3, name: "integration (2/2)", run_attempt: 2 },
        { id: 3, name: "integration (2/2)", run_attempt: 2 },
        { id: 4, name: "verify", run_attempt: 2 },
        { id: 5, name: "integration (1/3)", run_attempt: 5 },
      ],
      2,
    );
    expect([...attempts.entries()].sort()).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("loading downloaded artifacts", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("marks a truncated envelope and a report path that escapes its batch", () => {
    dir = mkdtempSync(path.join(tmpdir(), "vesper-evidence-"));
    const artifact = path.join(dir, "integration-evidence-shard-1-of-2-attempt-1");
    mkdirSync(path.join(artifact, "strict"), { recursive: true });
    mkdirSync(path.join(artifact, "legacy"), { recursive: true });
    writeFileSync(path.join(artifact, "strict", "envelope.json"), JSON.stringify({ execution: { report: "../report.json" } }));
    writeFileSync(path.join(artifact, "legacy", "envelope.json"), '{"schema": "vesper.integ');
    const batches = loadEvidence(dir);
    expect(batches.map((batch) => [batch.dir, batch.envelopeError === null, batch.reportError])).toEqual([
      ["legacy", false, null],
      ["strict", true, 'report path "../report.json" is not a plain file name'],
    ]);
  });
});

describe("summary", () => {
  it("renders the batch table and lists problems when incomplete", () => {
    const batches = baseline();
    batches.splice(batches.indexOf(find(batches, "legacy", 2)), 1);
    const summary = renderSummary(verify(batches));
    expect(summary).toContain("| Mode | Shard | Attempt | Planned | Executed | Passed | Failed | Skipped | Status | Duration | Evidence |");
    expect(summary).toContain("**Incomplete or failing**");
    expect(summary).toMatch(/- missing legacy batch for shard 2\/2/);
  });
});
