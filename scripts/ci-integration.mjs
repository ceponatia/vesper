#!/usr/bin/env node
// The CI launcher for one application integration batch: one authorization
// mode, one shard, one disposable database, one Vitest process.
//
//   node scripts/ci-integration.mjs --mode=strict --shard=1/2
//   node scripts/ci-integration.mjs --mode=legacy --shard=1/2
//
// It is deliberately thin. Vitest discovers the files (through the policy the
// root configuration applies), Vitest shards them, and Vitest runs them; this
// script only fixes everything around that run so it is the same every time:
//
//   1. INPUTS — `--mode` must be `strict` or `legacy` (never `all`), `--shard`
//      must be `<i>/<n>`. No other option exists: the required gate accepts
//      no narrowing filter.
//   2. CENSUS — `git ls-files` is reconciled against the policy; a stale or
//      duplicate legacy exception, or an integration file outside the
//      application roots, fails the batch before anything runs.
//   3. DATABASE — a CI-owned database per mode (`vesper_ci_<mode>`) on the
//      LOCAL disposable server is dropped if present, created, and migrated
//      from zero. A non-local host is refused.
//   4. PLAN — `scripts/integration-plan.mjs` asks Vitest for the unpartitioned
//      universe and for this mode's inventory and shard; both must agree with
//      the census. An empty shard is recorded as planned no-work, not run.
//   5. RUN — `pnpm exec vitest run --project=app-int --no-file-parallelism
//      --shard=<i>/<n>` from an argument array (no shell, no `--` separator),
//      in a child whose environment is built here: the legacy capability is
//      removed for `strict` and set only for `legacy`, the strict database
//      probe is on, and `DATABASE_URL` names the mode's database.
//   6. EVIDENCE — `<out>/<mode>/envelope.json` records the tested checkout,
//      run identity, policy/inventory hashes, the plan, the argv, the
//      effective environment and the outcome, beside Vitest's JSON report.
//      `scripts/verify-integration-results.mjs` reconciles them in `verify`.
//
// The exit code is the batch's: 0 for a passed or planned-empty batch,
// non-zero for any setup or test failure.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CI_INTEGRATION_MODES,
  INTEGRATION_MODE_ENV,
  LEGACY_CAPABILITY_ENV,
  POLICY_VERSION,
  integrationCensus,
  inventoryForMode,
  inventoryHash,
  repositoryRoot,
  trackedFiles,
} from "./integration-policy.mjs";

export const EVIDENCE_SCHEMA = "vesper.integration-evidence";
export const EVIDENCE_VERSION = 1;
export const MAX_SHARDS = 16;
export const DEFAULT_OUT_DIR = "integration-evidence";

/** The compose service from `docker-compose.yml`; overridable only to another local server. */
export const DEFAULT_DATABASE_SERVER = "postgresql://vesper:vesper_dev_password@localhost:5435";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const USAGE = "usage: node scripts/ci-integration.mjs --mode=strict|legacy [--shard=<i>/<n>] [--out=<dir>]";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Parse `<i>/<n>` with 1 <= i <= n <= MAX_SHARDS. */
export function parseShard(text) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text ?? "");
  if (match === null) throw new Error(`--shard must look like 1/2, got ${JSON.stringify(text)}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count) throw new Error(`--shard index ${index} is greater than its count ${count}`);
  if (count > MAX_SHARDS) throw new Error(`--shard count ${count} exceeds ${MAX_SHARDS}`);
  return { index, count };
}

/**
 * Parse and validate the launcher's own arguments. Unknown options and
 * positional filters are errors (`strict: true`), so the required gate cannot
 * be narrowed from the workflow.
 */
export function parseLauncherArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" },
      shard: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!CI_INTEGRATION_MODES.includes(values.mode)) {
    throw new Error(`--mode must be one of ${CI_INTEGRATION_MODES.join(", ")}, got ${JSON.stringify(values.mode)}`);
  }
  const out = values.out ?? DEFAULT_OUT_DIR;
  if (out === "" || path.isAbsolute(out) || out.split(/[\\/]/).includes("..")) {
    throw new Error(`--out must be a relative directory inside the repository, got ${JSON.stringify(out)}`);
  }
  return { mode: values.mode, shard: parseShard(values.shard ?? "1/1"), out };
}

/** The CI-owned database a mode runs against. */
export function databaseNameForMode(mode) {
  return `vesper_ci_${mode}`;
}

/**
 * Build the mode's database URL on a LOCAL server. The server URL may not name
 * a database, and its host must be local: this launcher drops and recreates the
 * database, so it must never be pointed at a shared or production server.
 */
export function databaseTarget(serverUrl, name) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error("the integration database server is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`the integration database server must be a postgres URL, got ${url.protocol}`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`refusing a non-local integration database host (${url.hostname}); CI databases live on the disposable local service`);
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error("the integration database server URL must not name a database; the launcher owns the database name");
  }
  if (!/^vesper_ci_[a-z]+$/.test(name)) throw new Error(`refusing a database name outside vesper_ci_*: ${name}`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const target = new URL(url);
  target.pathname = `/${name}`;
  // The identifier recorded in evidence: never the credentials.
  const host = `${url.hostname}:${url.port === "" ? "5432" : url.port}`;
  return { adminUrl: admin.toString(), url: target.toString(), name, host };
}

/**
 * The Vitest argument array. Options come before anything else and there is no
 * `--` element: pnpm forwards a separator verbatim, and Vitest's parser then
 * treats every following option as a filter — the #638 defect.
 */
export function buildVitestArgs({ shard, reportFile, passWithNoTests }) {
  return [
    "exec",
    "vitest",
    "run",
    "--project=app-int",
    "--no-file-parallelism",
    `--shard=${shard.index}/${shard.count}`,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportFile}`,
    ...(passWithNoTests ? ["--passWithNoTests"] : []),
  ];
}

/**
 * The child environment for a mode. Built from the parent's, then made
 * deterministic: the legacy capability is REMOVED unless the mode is `legacy`,
 * NODE_ENV is left for Vitest to set to `test`, the strict database probe is
 * on, and the database is the mode's own.
 */
export function buildChildEnv(baseEnv, { mode, databaseUrl }) {
  const env = { ...baseEnv };
  delete env[LEGACY_CAPABILITY_ENV];
  delete env.NODE_ENV;
  env[INTEGRATION_MODE_ENV] = mode;
  env.DATABASE_URL = databaseUrl;
  env.REQUIRE_INTEGRATION_DB = "true";
  if (mode === "legacy") env[LEGACY_CAPABILITY_ENV] = "1";
  return env;
}

/** The environment facts the envelope records (no values beyond these flags). */
export function describeEnvironment(env) {
  const mode = env[INTEGRATION_MODE_ENV];
  const capability = env[LEGACY_CAPABILITY_ENV];
  return {
    integrationMode: mode ?? null,
    legacyCapability: capability === undefined ? "absent" : capability === "1" ? "enabled" : "malformed",
    requireIntegrationDb: env.REQUIRE_INTEGRATION_DB === "true",
  };
}

/** Differences between two file lists, for readable plan-mismatch errors. */
export function listDifference(expected, actual) {
  const want = new Set(expected);
  const have = new Set(actual);
  return {
    missing: [...want].filter((file) => !have.has(file)).sort(),
    unexpected: [...have].filter((file) => !want.has(file)).sort(),
  };
}

function duplicates(files) {
  const seen = new Set();
  const repeated = new Set();
  for (const file of files) {
    if (seen.has(file)) repeated.add(file);
    seen.add(file);
  }
  return [...repeated].sort();
}

/** Compare the Vitest plan with the census; returns problems (empty when consistent). */
export function checkPlan({ mode, census, universePlan, modePlan, shard }) {
  const problems = [];
  const expectedInventory = inventoryForMode(mode, census);
  for (const [label, files] of [
    ["discovered universe", universePlan.files],
    ["mode inventory", modePlan.files],
    ["shard plan", modePlan.shardFiles],
  ]) {
    for (const file of duplicates(files)) problems.push(`${label} lists ${file} more than once`);
  }
  const universeDiff = listDifference(census.universe, universePlan.files);
  for (const file of universeDiff.missing) problems.push(`tracked integration suite not discovered by Vitest: ${file}`);
  for (const file of universeDiff.unexpected) problems.push(`Vitest discovered an untracked or unexpected integration file: ${file}`);
  const inventoryDiff = listDifference(expectedInventory, modePlan.files);
  for (const file of inventoryDiff.missing) problems.push(`${mode} inventory is missing ${file}`);
  for (const file of inventoryDiff.unexpected) problems.push(`${mode} inventory wrongly contains ${file}`);
  const inventory = new Set(modePlan.files);
  for (const file of modePlan.shardFiles) {
    if (!inventory.has(file)) problems.push(`shard ${shard.index}/${shard.count} plans ${file}, which is outside the ${mode} inventory`);
  }
  if (modePlan.mode !== mode) problems.push(`the plan ran in mode ${modePlan.mode}, not ${mode}`);
  if (universePlan.mode !== "all") problems.push(`the universe plan ran in mode ${universePlan.mode}, not all`);
  return problems;
}

// ---------------------------------------------------------------------------
// Side-effecting steps
// ---------------------------------------------------------------------------

function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runStep(label, command, args, { cwd, env }) {
  const started = Date.now();
  console.log(`::group::${label}`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  console.log("::endgroup::");
  return {
    step: label,
    status: result.status === 0 ? "ok" : "failed",
    exitCode: result.status,
    signal: result.signal,
    error: result.error === undefined ? null : result.error.message,
    durationMs: Date.now() - started,
  };
}

async function dropDatabase(target) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: target.adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${target.name}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function runPlan({ root, batchDir, env, mode, shard, label }) {
  const out = path.join(batchDir, `${label}.json`);
  const args = [path.join(root, "scripts", "integration-plan.mjs"), `--out=${out}`];
  if (shard !== undefined) args.push(`--shard=${shard.index}/${shard.count}`);
  const planEnv = { ...env, [INTEGRATION_MODE_ENV]: mode };
  delete planEnv[LEGACY_CAPABILITY_ENV];
  delete planEnv.NODE_ENV;
  const step = runStep(`plan ${label}`, process.execPath, args, { cwd: root, env: planEnv });
  return { step, plan: step.status === "ok" && existsSync(out) ? readJson(out) : null };
}

function newEnvelope({ options, env, root }) {
  const sha = gitHead(root);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  return {
    schema: EVIDENCE_SCHEMA,
    version: EVIDENCE_VERSION,
    mode: options.mode,
    shard: options.shard,
    root,
    checkout: {
      sha,
      prHead: env.PR_HEAD_SHA || null,
      prBase: env.PR_BASE_SHA || null,
    },
    run: {
      id: env.GITHUB_RUN_ID || null,
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : null,
      job: env.GITHUB_JOB || null,
    },
    policy: { version: POLICY_VERSION, hash: null },
    universe: { files: [], hash: null },
    inventory: { files: [], hash: null },
    planned: [],
    database: null,
    environment: null,
    argv: [],
    setup: { status: "pending", steps: [], problems: [] },
    execution: { status: "not-run", exitCode: null, signal: null, durationMs: null, report: null },
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

async function runBatch(options, env) {
  const root = repositoryRoot();
  process.chdir(root);
  const batchDir = path.join(root, options.out, options.mode);
  rmSync(batchDir, { recursive: true, force: true });
  mkdirSync(batchDir, { recursive: true });
  const envelope = newEnvelope({ options, env, root });
  const envelopePath = path.join(batchDir, "envelope.json");

  const finish = (exitCode) => {
    envelope.finishedAt = new Date().toISOString();
    writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);
    const { setup, execution } = envelope;
    console.log(
      `[ci-integration] ${options.mode} ${options.shard.index}/${options.shard.count}: setup ${setup.status}, ` +
        `execution ${execution.status}, ${envelope.planned.length} planned file(s) -> ${path.relative(root, envelopePath)}`,
    );
    for (const problem of setup.problems) console.error(`[ci-integration] ${problem}`);
    return exitCode;
  };
  const setupFailed = (problems) => {
    envelope.setup.status = "failed";
    envelope.setup.problems.push(...problems);
    return finish(1);
  };

  // 2. CENSUS
  const census = integrationCensus(trackedFiles(root));
  envelope.policy.hash = census.policyHash;
  envelope.universe = { files: census.universe, hash: census.universeHash };
  if (census.problems.length > 0) return setupFailed(census.problems);

  // 3. DATABASE
  let target;
  try {
    target = databaseTarget(env.INTEGRATION_DATABASE_SERVER || DEFAULT_DATABASE_SERVER, databaseNameForMode(options.mode));
  } catch (error) {
    return setupFailed([error instanceof Error ? error.message : String(error)]);
  }
  envelope.database = { name: target.name, host: target.host };
  const dbEnv = { ...env, DATABASE_URL: target.url };
  delete dbEnv[LEGACY_CAPABILITY_ENV];
  try {
    await dropDatabase(target);
    envelope.setup.steps.push({ step: "drop database", status: "ok" });
  } catch (error) {
    envelope.setup.steps.push({ step: "drop database", status: "failed" });
    return setupFailed([`could not reset ${target.name}: ${error instanceof Error ? error.message : String(error)}`]);
  }
  for (const [label, script] of [
    ["create database", "db:create"],
    ["migrate from zero", "db:migrate"],
  ]) {
    const step = runStep(label, "pnpm", [script], { cwd: root, env: dbEnv });
    envelope.setup.steps.push(step);
    if (step.status !== "ok") return setupFailed([`${label} failed for ${target.name}`]);
  }

  // 4. PLAN
  const universe = runPlan({ root, batchDir, env, mode: "all", shard: undefined, label: "plan-universe" });
  envelope.setup.steps.push(universe.step);
  const modePlan = runPlan({ root, batchDir, env, mode: options.mode, shard: options.shard, label: "plan" });
  envelope.setup.steps.push(modePlan.step);
  if (universe.plan === null || modePlan.plan === null) return setupFailed(["Vitest planning failed"]);
  envelope.inventory = { files: modePlan.plan.files, hash: inventoryHash(modePlan.plan.files) };
  envelope.planned = modePlan.plan.shardFiles;
  const planProblems = checkPlan({
    mode: options.mode,
    census,
    universePlan: universe.plan,
    modePlan: modePlan.plan,
    shard: options.shard,
  });
  if (planProblems.length > 0) return setupFailed(planProblems);
  envelope.setup.status = "ok";

  // 5. RUN
  const childEnv = buildChildEnv(env, { mode: options.mode, databaseUrl: target.url });
  envelope.environment = describeEnvironment(childEnv);
  if (envelope.planned.length === 0) {
    envelope.execution = { status: "no-work", exitCode: null, signal: null, durationMs: 0, report: null };
    return finish(0);
  }
  const reportFile = path.join(batchDir, "report.json");
  const args = buildVitestArgs({
    shard: options.shard,
    reportFile,
    // Vitest refuses a shard count larger than its file count unless told an
    // empty shard is acceptable. That can only happen here when the mode's
    // whole inventory is smaller than the shard count, and the verifier still
    // requires every planned file to have run.
    passWithNoTests: envelope.inventory.files.length < options.shard.count,
  });
  envelope.argv = ["pnpm", ...args];
  const started = Date.now();
  const result = spawnSync("pnpm", args, { cwd: root, env: childEnv, stdio: "inherit" });
  const reportExists = existsSync(reportFile);
  envelope.execution = {
    status: result.status === 0 && reportExists ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal,
    error: result.error === undefined ? null : result.error.message,
    durationMs: Date.now() - started,
    report: reportExists ? "report.json" : null,
  };
  return finish(envelope.execution.status === "passed" ? 0 : 1);
}

async function main(argv, env) {
  let options;
  try {
    options = parseLauncherArgs(argv);
  } catch (error) {
    console.error(`${USAGE}\n${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  return runBatch(options, env);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
