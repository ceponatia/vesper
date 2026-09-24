#!/usr/bin/env node
// The integration evidence check inside the aggregate `verify` job.
//
// A green integration matrix proves only that each shard's process exited 0.
// It cannot see two shards running the same files, a suite nobody selected, a
// strict batch that carried the legacy capability, or a skipped file. This
// script reconciles what SHOULD have run with what DID run, from the evidence
// each batch uploaded (`scripts/ci-integration.mjs`: an envelope plus Vitest's
// JSON report), and fails `verify` unless:
//
//   - the application universe it recomputes from `git ls-files` and the
//     policy is consistent (no stale exception, no misplaced suite, not
//     empty), and every batch discovered exactly that universe;
//   - for every mode (strict, legacy) and every shard there is exactly one
//     batch from the job attempt GitHub reports as that shard's latest
//     execution — an older attempt's success never covers a newer attempt;
//   - every batch tested this run's checkout under this policy, in its own
//     mode, with its own database, through the expected Vitest argv;
//   - the planned shards partition each mode's inventory, and strict and
//     legacy partition the universe;
//   - the MULTISET of executed files equals the planned inventory with
//     multiplicity one (duplicates are counted before anything is merged);
//   - every executed file passed with at least one passed case, no failed,
//     skipped or todo case, and every case carries the worker's attestation
//     of the mode it ran in; and
//   - a shard planned empty recorded no-work instead of an empty run.
//
// Zero dependencies (Node built-ins and global fetch): `verify` runs it after
// a checkout, without installing the workspace.
//
// Usage: node scripts/verify-integration-results.mjs --evidence=<dir> --shards=<n>
// Environment: GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY,
// GITHUB_TOKEN, GITHUB_API_URL, PR_HEAD_SHA, PR_BASE_SHA, GITHUB_STEP_SUMMARY.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EVIDENCE_SCHEMA, EVIDENCE_VERSION, buildVitestArgs } from "./ci-integration.mjs";
import {
  CI_INTEGRATION_MODES,
  integrationCensus,
  inventoryForMode,
  inventoryHash,
  repositoryRoot,
  trackedFiles,
} from "./integration-policy.mjs";

/** The integration matrix job's display name: `integration (<i>/<n>)`. */
export const INTEGRATION_JOB_NAME = /^integration \((\d+)\/(\d+)\)$/;

/** `integration-evidence-shard-<i>-of-<n>-attempt-<k>` */
export const ARTIFACT_NAME = /^integration-evidence-shard-(\d+)-of-(\d+)-attempt-(\d+)$/;

const ATTESTATION_KEY = "vesperIntegration";
const API_TIMEOUT_MS = 15_000;
const MAX_LISTED_PROBLEMS = 200;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: `unreadable or malformed JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

function subdirectories(dir) {
  return readdirSync(dir)
    .filter((name) => statSync(path.join(dir, name)).isDirectory())
    .sort();
}

/**
 * Read every downloaded batch: `<evidence>/<artifact>/<mode>/envelope.json`
 * and the report the envelope names. Nothing is judged here; a missing or
 * malformed file becomes an error on its batch.
 */
export function loadEvidence(evidenceDir) {
  const batches = [];
  if (!existsSync(evidenceDir)) return batches;
  for (const artifact of subdirectories(evidenceDir)) {
    const artifactDir = path.join(evidenceDir, artifact);
    for (const modeDir of subdirectories(artifactDir)) {
      const dir = path.join(artifactDir, modeDir);
      const batch = { artifact, dir: modeDir, envelope: null, envelopeError: null, report: null, reportError: null };
      const envelopePath = path.join(dir, "envelope.json");
      if (!existsSync(envelopePath)) {
        batch.envelopeError = "missing envelope.json";
      } else {
        const read = readJsonFile(envelopePath);
        batch.envelope = read.value;
        batch.envelopeError = read.error;
      }
      const reportName = batch.envelope?.execution?.report;
      if (typeof reportName === "string") {
        if (reportName !== path.basename(reportName) || reportName.startsWith(".")) {
          batch.reportError = `report path ${JSON.stringify(reportName)} is not a plain file name`;
        } else if (!existsSync(path.join(dir, reportName))) {
          batch.reportError = `missing ${reportName}`;
        } else {
          const read = readJsonFile(path.join(dir, reportName));
          batch.report = read.value;
          batch.reportError = read.error;
        }
      }
      batches.push(batch);
    }
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Pure verification
// ---------------------------------------------------------------------------

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

/** Structural checks on one envelope. Returns problems; empty means well-formed. */
export function envelopeShapeProblems(envelope) {
  if (!isObject(envelope)) return ["envelope is not an object"];
  const problems = [];
  if (envelope.schema !== EVIDENCE_SCHEMA) problems.push(`unknown envelope schema ${JSON.stringify(envelope.schema)}`);
  if (envelope.version !== EVIDENCE_VERSION) problems.push(`unsupported envelope version ${JSON.stringify(envelope.version)}`);
  if (!CI_INTEGRATION_MODES.includes(envelope.mode)) problems.push(`envelope mode ${JSON.stringify(envelope.mode)} is not a CI mode`);
  if (!isObject(envelope.shard) || !isPositiveInteger(envelope.shard.index) || !isPositiveInteger(envelope.shard.count)) {
    problems.push("envelope shard is malformed");
  }
  if (typeof envelope.root !== "string" || !path.isAbsolute(envelope.root)) problems.push("envelope root is not an absolute path");
  if (!isObject(envelope.checkout) || typeof envelope.checkout.sha !== "string") problems.push("envelope checkout sha is missing");
  if (!isObject(envelope.run) || !isPositiveInteger(envelope.run.attempt) || typeof envelope.run.id !== "string") {
    problems.push("envelope run identity is missing");
  }
  if (!isObject(envelope.policy) || typeof envelope.policy.hash !== "string") problems.push("envelope policy hash is missing");
  for (const key of ["universe", "inventory"]) {
    if (!isObject(envelope[key]) || !isStringArray(envelope[key].files)) problems.push(`envelope ${key} is malformed`);
  }
  if (!isStringArray(envelope.planned)) problems.push("envelope planned list is malformed");
  if (!isStringArray(envelope.argv)) problems.push("envelope argv is malformed");
  if (!isObject(envelope.setup) || typeof envelope.setup.status !== "string") problems.push("envelope setup is malformed");
  if (!isObject(envelope.execution) || typeof envelope.execution.status !== "string") problems.push("envelope execution is malformed");
  return problems;
}

function difference(expected, actual) {
  const have = new Set(actual);
  const want = new Set(expected);
  return {
    missing: [...want].filter((file) => !have.has(file)).sort(),
    unexpected: [...have].filter((file) => !want.has(file)).sort(),
  };
}

function sameList(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

function batchLabel(envelope) {
  return `${envelope.mode} ${envelope.shard.index}/${envelope.shard.count} (attempt ${envelope.run.attempt})`;
}

/** The argv problems of one batch, against the launcher's own construction. */
export function argvProblems(envelope) {
  const argv = envelope.argv;
  if (argv.includes("--")) return ["argv contains a bare -- separator, which turns every later option into a filter"];
  if (argv[0] !== "pnpm") return ["argv does not start with pnpm"];
  const reportArg = argv.find((arg) => arg.startsWith("--outputFile.json="));
  if (reportArg === undefined) return ["argv writes no JSON report"];
  const expected = [
    "pnpm",
    ...buildVitestArgs({
      shard: envelope.shard,
      reportFile: reportArg.slice("--outputFile.json=".length),
      passWithNoTests: envelope.inventory.files.length < envelope.shard.count,
    }),
  ];
  return argv.length === expected.length && argv.every((arg, index) => arg === expected[index])
    ? []
    : [`argv ${JSON.stringify(argv)} differs from the launcher's construction ${JSON.stringify(expected)}`];
}

function expectedAttestation(mode, file) {
  return {
    mode,
    file,
    legacyCapability: mode === "legacy" ? "enabled" : "absent",
    strictDatabase: true,
    fakeProviders: true,
  };
}

function attestationProblem(meta, expected) {
  const actual = isObject(meta) ? meta[ATTESTATION_KEY] : undefined;
  if (!isObject(actual)) return "carries no worker attestation";
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) return `attests ${key}=${JSON.stringify(actual[key])}, expected ${JSON.stringify(value)}`;
  }
  return null;
}

/**
 * Judge one report against its batch. Returns per-file execution counts
 * (before any merging) and the case tallies, and appends problems.
 */
function judgeReport(envelope, report, problems) {
  const label = batchLabel(envelope);
  const executed = new Map();
  const tally = { files: 0, passed: 0, failed: 0, skipped: 0 };
  if (!isObject(report) || !Array.isArray(report.testResults)) {
    problems.push(`${label}: the JSON report has no testResults array`);
    return { executed, tally };
  }
  const prefix = `${envelope.root.replace(/\/+$/, "")}/`;
  for (const result of report.testResults) {
    const name = isObject(result) ? result.name : undefined;
    if (typeof name !== "string" || !name.startsWith(prefix)) {
      problems.push(`${label}: report entry ${JSON.stringify(name)} is outside the checkout`);
      continue;
    }
    const file = name.slice(prefix.length);
    executed.set(file, (executed.get(file) ?? 0) + 1);
    tally.files += 1;
    const cases = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    let passedCases = 0;
    for (const entry of cases) {
      const status = isObject(entry) ? entry.status : undefined;
      const title = isObject(entry) && typeof entry.fullName === "string" ? entry.fullName : "(unnamed case)";
      if (status === "passed") {
        passedCases += 1;
        tally.passed += 1;
        const problem = attestationProblem(entry.meta, expectedAttestation(envelope.mode, file));
        if (problem !== null) problems.push(`${label}: ${file} › ${title} ${problem}`);
      } else if (status === "failed") {
        tally.failed += 1;
        problems.push(`${label}: ${file} › ${title} failed`);
      } else {
        tally.skipped += 1;
        problems.push(`${label}: ${file} › ${title} ended ${JSON.stringify(status)}; skipped and todo cases are not allowed in the required gate`);
      }
    }
    if (result.status !== "passed") {
      const message = typeof result.message === "string" && result.message !== "" ? `: ${result.message.split("\n")[0]}` : "";
      problems.push(`${label}: ${file} did not pass (${JSON.stringify(result.status)})${message}`);
    }
    if (passedCases === 0) problems.push(`${label}: ${file} executed no passing case`);
  }
  if (report.success !== true) problems.push(`${label}: the JSON report does not record success`);
  return { executed, tally };
}

/**
 * Verify the downloaded evidence.
 *
 * @param {{
 *   batches: Array<{ artifact: string, dir: string, envelope: any, envelopeError: string | null, report: any, reportError: string | null }>,
 *   census: { universe: string[], strict: string[], legacy: string[], problems: string[], policyHash: string },
 *   identity: { sha: string, runId: string, runAttempt: number, prHead?: string | null, prBase?: string | null },
 *   shardCount: number,
 *   authoritativeAttempts: Map<number, number> | null,
 * }} input
 */
export function verifyIntegrationEvidence({ batches, census, identity, shardCount, authoritativeAttempts }) {
  const problems = [...census.problems.map((problem) => `policy: ${problem}`)];
  const batchSummaries = [];

  if (!isPositiveInteger(shardCount)) problems.push(`the expected shard count ${JSON.stringify(shardCount)} is invalid`);
  if (authoritativeAttempts === null) {
    problems.push("could not determine which attempt of each integration shard is authoritative; refusing to guess");
  }
  if (batches.length === 0) problems.push("no integration evidence was downloaded");

  // 1. Well-formed envelopes only; every malformed one is a problem.
  const valid = [];
  for (const batch of batches) {
    const where = `${batch.artifact}/${batch.dir}`;
    if (batch.envelopeError !== null) {
      problems.push(`${where}: ${batch.envelopeError}`);
      continue;
    }
    const shape = envelopeShapeProblems(batch.envelope);
    if (shape.length > 0) {
      problems.push(...shape.map((problem) => `${where}: ${problem}`));
      continue;
    }
    const artifact = ARTIFACT_NAME.exec(batch.artifact);
    const { envelope } = batch;
    if (
      artifact === null ||
      Number(artifact[1]) !== envelope.shard.index ||
      Number(artifact[2]) !== envelope.shard.count ||
      Number(artifact[3]) !== envelope.run.attempt ||
      batch.dir !== envelope.mode
    ) {
      problems.push(`${where}: the artifact name and directory do not match the envelope's mode, shard and attempt`);
      continue;
    }
    if (envelope.run.id !== identity.runId) {
      problems.push(`${where}: evidence belongs to run ${envelope.run.id}, not this run ${identity.runId}`);
      continue;
    }
    if (envelope.run.attempt > identity.runAttempt) {
      problems.push(`${where}: evidence claims attempt ${envelope.run.attempt}, after this verification's attempt ${identity.runAttempt}`);
      continue;
    }
    valid.push(batch);
  }

  // 2. Exactly one authoritative batch per (mode, shard).
  const selected = new Map();
  for (const mode of CI_INTEGRATION_MODES) {
    for (let index = 1; isPositiveInteger(shardCount) && index <= shardCount; index += 1) {
      const attempt = authoritativeAttempts?.get(index);
      if (authoritativeAttempts !== null && attempt === undefined) {
        problems.push(`GitHub reports no execution of integration shard ${index}/${shardCount}`);
        continue;
      }
      const candidates = valid.filter(
        (batch) => batch.envelope.mode === mode && batch.envelope.shard.index === index && batch.envelope.run.attempt === attempt,
      );
      if (candidates.length === 0) {
        problems.push(`missing ${mode} batch for shard ${index}/${shardCount} from attempt ${attempt ?? "?"}`);
      } else if (candidates.length > 1) {
        problems.push(`${candidates.length} ${mode} batches for shard ${index}/${shardCount} at attempt ${attempt}; expected exactly one`);
      } else {
        selected.set(`${mode}#${index}`, candidates[0]);
      }
    }
  }

  // 3. Per-batch identity, plan and outcome.
  const executedByMode = new Map(CI_INTEGRATION_MODES.map((mode) => [mode, new Map()]));
  const plannedByMode = new Map(CI_INTEGRATION_MODES.map((mode) => [mode, new Map()]));
  for (const batch of selected.values()) {
    const { envelope } = batch;
    const label = batchLabel(envelope);
    const expectedInventory = inventoryForMode(envelope.mode, census);
    if (envelope.shard.count !== shardCount) problems.push(`${label}: shard count ${envelope.shard.count}, expected ${shardCount}`);
    if (envelope.checkout.sha !== identity.sha) {
      problems.push(`${label}: tested checkout ${envelope.checkout.sha}, not this run's ${identity.sha} (stale evidence)`);
    }
    if ((identity.prHead ?? null) !== (envelope.checkout.prHead ?? null) || (identity.prBase ?? null) !== (envelope.checkout.prBase ?? null)) {
      problems.push(`${label}: pull request head/base differ from this run's`);
    }
    if (envelope.policy.hash !== census.policyHash) problems.push(`${label}: ran under policy ${envelope.policy.hash}, not ${census.policyHash}`);
    if (!sameList(envelope.universe.files, census.universe)) {
      const diff = difference(census.universe, envelope.universe.files);
      problems.push(`${label}: discovered universe differs from the tracked one (missing ${diff.missing.length}, unexpected ${diff.unexpected.length})`);
    }
    if (!sameList(envelope.inventory.files, expectedInventory)) {
      const diff = difference(expectedInventory, envelope.inventory.files);
      problems.push(
        `${label}: ${envelope.mode} inventory differs from the policy partition (missing ${diff.missing.join(", ") || "none"}; unexpected ${diff.unexpected.join(", ") || "none"})`,
      );
    }
    if (typeof envelope.inventory.hash === "string" && envelope.inventory.hash !== inventoryHash(envelope.inventory.files)) {
      problems.push(`${label}: inventory hash does not match its file list`);
    }
    if (envelope.setup.status !== "ok") {
      const detail = Array.isArray(envelope.setup.problems) ? envelope.setup.problems.slice(0, 5).join("; ") : "";
      problems.push(`${label}: setup ${envelope.setup.status}${detail === "" ? "" : ` — ${detail}`}`);
    }
    const environment = envelope.environment;
    if (
      !isObject(environment) ||
      environment.integrationMode !== envelope.mode ||
      environment.legacyCapability !== (envelope.mode === "legacy" ? "enabled" : "absent") ||
      environment.requireIntegrationDb !== true
    ) {
      problems.push(`${label}: recorded environment ${JSON.stringify(environment)} does not match its mode`);
    }
    if (!isObject(envelope.database) || envelope.database.name !== `vesper_ci_${envelope.mode}`) {
      problems.push(`${label}: did not run against its own vesper_ci_${envelope.mode} database`);
    }

    const planned = plannedByMode.get(envelope.mode);
    for (const file of envelope.planned) planned.set(file, (planned.get(file) ?? 0) + 1);

    const execution = envelope.execution;
    let executed = new Map();
    let tally = { files: 0, passed: 0, failed: 0, skipped: 0 };
    if (envelope.planned.length === 0) {
      if (execution.status !== "no-work" || execution.report !== null) {
        problems.push(`${label}: planned no files but recorded execution ${JSON.stringify(execution.status)} instead of no-work`);
      }
    } else {
      if (execution.status === "no-work") problems.push(`${label}: planned ${envelope.planned.length} file(s) but recorded no-work`);
      else if (execution.status !== "passed" || execution.exitCode !== 0 || execution.signal !== null) {
        problems.push(
          `${label}: execution ${execution.status} (exit ${JSON.stringify(execution.exitCode)}, signal ${JSON.stringify(execution.signal)})`,
        );
      }
      problems.push(...argvProblems(envelope).map((problem) => `${label}: ${problem}`));
      if (batch.reportError !== null) problems.push(`${label}: report ${batch.reportError}`);
      else if (batch.report === null) problems.push(`${label}: no JSON report was produced`);
      else ({ executed, tally } = judgeReport(envelope, batch.report, problems));

      for (const [file, count] of executed) {
        if (count > 1) problems.push(`${label}: ${file} executed ${count} times in one batch`);
      }
      const diff = difference(envelope.planned, [...executed.keys()]);
      for (const file of diff.missing) problems.push(`${label}: planned ${file} but it never executed`);
      for (const file of diff.unexpected) {
        const hint = file.endsWith(".int.test.ts") ? "" : " (a pure app-project file)";
        problems.push(`${label}: executed unplanned file ${file}${hint}`);
      }
    }
    const modeExecuted = executedByMode.get(envelope.mode);
    for (const [file, count] of executed) modeExecuted.set(file, (modeExecuted.get(file) ?? 0) + count);
    batchSummaries.push({
      mode: envelope.mode,
      shard: `${envelope.shard.index}/${envelope.shard.count}`,
      attempt: envelope.run.attempt,
      artifact: batch.artifact,
      planned: envelope.planned.length,
      executed: tally.files,
      passed: tally.passed,
      failed: tally.failed,
      skipped: tally.skipped,
      status: execution.status,
      durationMs: typeof execution.durationMs === "number" ? execution.durationMs : null,
    });
  }

  // 4. Partitions: shards within a mode, modes within the universe.
  const allExecutions = new Map();
  for (const mode of CI_INTEGRATION_MODES) {
    const expectedInventory = inventoryForMode(mode, census);
    const planned = plannedByMode.get(mode);
    for (const [file, count] of planned) {
      if (count > 1) problems.push(`${mode}: ${file} is planned in ${count} shards`);
    }
    if (selected.size === CI_INTEGRATION_MODES.length * shardCount) {
      const diff = difference(expectedInventory, [...planned.keys()]);
      for (const file of diff.missing) problems.push(`${mode}: ${file} is in no shard's plan`);
      for (const file of diff.unexpected) problems.push(`${mode}: ${file} is planned outside the ${mode} inventory`);
    }
    for (const [file, count] of executedByMode.get(mode)) {
      allExecutions.set(file, (allExecutions.get(file) ?? 0) + count);
    }
  }
  for (const [file, count] of allExecutions) {
    if (count > 1) problems.push(`${file} executed ${count} times across the integration gate; expected exactly once`);
  }
  if (selected.size === CI_INTEGRATION_MODES.length * shardCount) {
    for (const file of census.universe) {
      if (!allExecutions.has(file)) problems.push(`${file} did not execute in any batch`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    summary: {
      universe: census.universe.length,
      strict: census.strict.length,
      legacy: census.legacy.length,
      executedFiles: allExecutions.size,
      batches: batchSummaries.sort((a, b) => (a.mode === b.mode ? a.shard.localeCompare(b.shard) : a.mode.localeCompare(b.mode))),
    },
  };
}

// ---------------------------------------------------------------------------
// Authoritative attempts (GitHub API)
// ---------------------------------------------------------------------------

/**
 * The latest EXECUTED attempt of each integration shard, from every job record
 * in the run (`filter=all`).
 *
 * A rerun of a shard is a new execution with a higher `run_attempt`. A shard
 * that was NOT rerun ("Re-run failed jobs", or a single-job rerun) is still
 * listed again under the new attempt — with a new job id and the new
 * `run_attempt`, but the same `started_at`/`completed_at` as the execution it
 * carries over (observed on run 36070936379, attempt 2). So records are grouped
 * by shard and timing, and each group counts under the LOWEST attempt it
 * appears in: the attempt that actually ran it. A record with no start time
 * counts as its own execution, so a rerun that never produced evidence fails.
 * @param {Array<{ id?: number, name?: string, run_attempt?: number, started_at?: string | null, completed_at?: string | null }>} jobs
 * @param {number} shardCount
 */
export function authoritativeAttemptsFromJobs(jobs, shardCount) {
  const executions = new Map();
  const seen = new Set();
  for (const job of jobs) {
    if (!isObject(job) || seen.has(job.id)) continue;
    seen.add(job.id);
    const match = INTEGRATION_JOB_NAME.exec(job.name ?? "");
    if (match === null || Number(match[2]) !== shardCount || !isPositiveInteger(job.run_attempt)) continue;
    const index = Number(match[1]);
    const timing =
      typeof job.started_at === "string" && job.started_at !== ""
        ? `${job.started_at}|${job.completed_at ?? ""}`
        : `id:${String(job.id)}`;
    const key = `${index}|${timing}`;
    const previous = executions.get(key);
    executions.set(key, { index, attempt: Math.min(previous?.attempt ?? job.run_attempt, job.run_attempt) });
  }
  const attempts = new Map();
  for (const { index, attempt } of executions.values()) {
    attempts.set(index, Math.max(attempts.get(index) ?? 0, attempt));
  }
  return attempts;
}

async function fetchRunJobs({ apiUrl, repo, token, runId }) {
  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const query = new URLSearchParams({ filter: "all", per_page: "100", page: String(page) });
    const response = await fetch(`${apiUrl}/repos/${repo}/actions/runs/${runId}/jobs?${query}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET run jobs -> HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.jobs)) throw new Error("run jobs response has no jobs array");
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) break;
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function seconds(ms) {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

export function renderSummary(result) {
  const { summary } = result;
  const lines = [
    "### Integration evidence",
    "",
    `**${result.ok ? "Complete" : "Incomplete or failing"}** — ${summary.universe} discovered suites: ${summary.strict} strict, ${summary.legacy} legacy; ${summary.executedFiles} executed.`,
    "",
    "| Mode | Shard | Attempt | Planned | Executed | Passed | Failed | Skipped | Status | Duration | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summary.batches.map(
      (batch) =>
        `| ${batch.mode} | ${batch.shard} | ${batch.attempt} | ${batch.planned} | ${batch.executed} | ${batch.passed} | ${batch.failed} | ${batch.skipped} | ${batch.status} | ${seconds(batch.durationMs)} | \`${batch.artifact}\` |`,
    ),
  ];
  if (!result.ok) {
    lines.push("", `**Problems (${result.problems.length}):**`, "");
    for (const problem of result.problems.slice(0, MAX_LISTED_PROBLEMS)) lines.push(`- ${problem}`);
    if (result.problems.length > MAX_LISTED_PROBLEMS) lines.push(`- … ${result.problems.length - MAX_LISTED_PROBLEMS} more in the job log`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(argv, env) {
  const { values } = parseArgs({
    args: argv,
    options: { evidence: { type: "string" }, shards: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  const shardCount = Number(values.shards);
  if (values.evidence === undefined || !isPositiveInteger(shardCount)) {
    console.error("usage: node scripts/verify-integration-results.mjs --evidence=<dir> --shards=<n>");
    return 2;
  }
  const root = repositoryRoot();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const problems = [];
  if (env.GITHUB_SHA && env.GITHUB_SHA !== head) problems.push(`verify checked out ${head}, but this run tested ${env.GITHUB_SHA}`);

  let authoritativeAttempts = null;
  try {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are required");
    const jobs = await fetchRunJobs({
      apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
      repo: env.GITHUB_REPOSITORY,
      token: env.GITHUB_TOKEN,
      runId: env.GITHUB_RUN_ID,
    });
    authoritativeAttempts = authoritativeAttemptsFromJobs(jobs, shardCount);
  } catch (error) {
    problems.push(`could not list this run's jobs: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = verifyIntegrationEvidence({
    batches: loadEvidence(path.resolve(values.evidence)),
    census: integrationCensus(trackedFiles(root)),
    identity: {
      sha: head,
      runId: env.GITHUB_RUN_ID ?? "",
      runAttempt: Number(env.GITHUB_RUN_ATTEMPT ?? "0"),
      prHead: env.PR_HEAD_SHA || null,
      prBase: env.PR_BASE_SHA || null,
    },
    shardCount,
    authoritativeAttempts,
  });
  const merged = { ...result, ok: result.ok && problems.length === 0, problems: [...problems, ...result.problems] };
  const summary = renderSummary(merged);
  console.log(summary);
  for (const problem of merged.problems.slice(0, 50)) console.log(`::error title=integration evidence::${problem}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return merged.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
