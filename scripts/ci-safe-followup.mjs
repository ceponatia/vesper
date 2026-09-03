#!/usr/bin/env node
// The safe-follow-up detector for CI's `changes` job.
//
// A pull request that already earned a green `verify` and then receives a
// commit touching only documentation paths does not need its code gates run
// again: the code the gates proved is unchanged, and the documentation checks
// are the only gate whose input moved. This script decides whether the update
// that triggered the workflow is such a follow-up. When it is, the classifier
// treats the PR as documentation-only for THIS run — the `docs` job runs on the
// new head and `verify` is produced fresh from it; nothing is copied from the
// previous result.
//
// The fast path needs ALL of the following, checked in this order:
//
//   1. EVENT — a `pull_request` `synchronize` into a branch other than `prod`,
//      with distinct, non-zero previous and new head SHAs.
//   2. HISTORY — the previous head is an ancestor of the new head. A force
//      push or a rebase breaks that, and so does a previous head the checkout
//      no longer has: both fall back.
//   3. PATHS — every path in `git diff --name-only PREVIOUS NEW` is in the
//      documentation set the classifier's whole-PR rule uses (`docs/*`,
//      `*.md`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE*`).
//      An empty diff falls back. The workflow file is outside the set, so a
//      workflow change falls back like any other code path.
//   4. PREVIOUS RESULT — the newest CI workflow run for this pull request at
//      the previous head completed with `success`, and the pull request's base
//      SHA recorded on that run equals the base SHA of this event (a base that
//      moved means the previous run proved a different merge).
//   5. VERIFY — a `verify` check run from GitHub Actions in that run's check
//      suite concluded `success`. A green run object alone is not trusted.
//
// The decision FAILS CLOSED: any API error, timeout, missing input, or shape
// the script does not recognise yields `safe_followup=false`, and the
// classifier proceeds with its ordinary whole-PR diff. The script never fails
// the job — its exit code is always 0, because the fallback IS the normal path.
//
// Zero dependencies on purpose, like `scripts/check-docs.mjs`: it runs in the
// classify job before any install, on Node built-ins and the global `fetch`.
//
// Usage: node scripts/ci-safe-followup.mjs
// Inputs come from the environment the workflow step sets (see `main`); the
// verdict is written to `GITHUB_OUTPUT` as `safe_followup=` and `reason=`.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ZERO_SHA = "0000000000000000000000000000000000000000";
const API_TIMEOUT_MS = 15_000;
const VERIFY_CHECK_NAME = "verify";
const ACTIONS_APP_SLUG = "github-actions";

/**
 * The classifier's documentation path set, one predicate per bash glob:
 * `docs/*` | `*.md` | `.github/ISSUE_TEMPLATE/*` | `.github/PULL_REQUEST_TEMPLATE*`.
 * Bash `*` matches `/` inside a `case` pattern, so `docs/*` is a prefix test.
 * @param {string} file repo-relative path with forward slashes
 */
export function isDocumentationPath(file) {
  return (
    file.startsWith("docs/") ||
    file.endsWith(".md") ||
    file.startsWith(".github/ISSUE_TEMPLATE/") ||
    file.startsWith(".github/PULL_REQUEST_TEMPLATE")
  );
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) && value !== ZERO_SHA;
}

function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 12) : String(sha);
}

function fallback(reason) {
  return { safe: false, reason };
}

/**
 * Decide whether the update is a safe documentation follow-up.
 *
 * Pure with respect to its inputs: git and the GitHub API are reached only
 * through the injected `git` and `api` adapters, so the decision can be tested
 * with fakes. Any adapter throwing is a fallback, never a failure.
 *
 * @param {{
 *   event: { name: string, action: string, baseRef: string, beforeSha: string, headSha: string, baseSha: string, prNumber: number },
 *   git: { isAncestor: (ancestor: string, descendant: string) => boolean, changedFiles: (from: string, to: string) => string[] },
 *   api: { workflowRuns: (headSha: string) => Promise<unknown[]>, checkRuns: (headSha: string) => Promise<unknown[]> },
 * }} input
 * @returns {Promise<{ safe: boolean, reason: string }>}
 */
export async function decideSafeFollowup({ event, git, api }) {
  try {
    return await decide(event, git, api);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallback(`lookup failed, running the normal checks: ${message}`);
  }
}

async function decide(event, git, api) {
  // 1. EVENT
  if (event.name !== "pull_request") return fallback(`event is ${event.name || "unknown"}, not a pull request update`);
  if (event.action !== "synchronize") return fallback(`action is ${event.action || "unknown"}, not synchronize`);
  if (event.baseRef === "prod") return fallback("a promotion to prod always runs the full suite");
  if (!isSha(event.beforeSha) || !isSha(event.headSha)) return fallback("previous or new head sha is missing");
  if (event.beforeSha === event.headSha) return fallback("head did not move");
  if (!isSha(event.baseSha)) return fallback("base sha is missing");
  if (!Number.isInteger(event.prNumber) || event.prNumber <= 0) return fallback("pull request number is missing");

  const before = event.beforeSha;
  const head = event.headSha;

  // 2. HISTORY
  if (!git.isAncestor(before, head)) {
    return fallback(`previous head ${short(before)} is not an ancestor of ${short(head)} (force push, rebase, or unknown history)`);
  }

  // 3. PATHS
  const changed = git.changedFiles(before, head);
  if (changed.length === 0) return fallback(`no paths changed between ${short(before)} and ${short(head)}`);
  const outside = changed.filter((file) => !isDocumentationPath(file));
  if (outside.length > 0) {
    const workflow = outside.find((file) => file.startsWith(".github/workflows/"));
    if (workflow !== undefined) return fallback(`workflow changed: ${workflow}`);
    return fallback(`path outside the documentation set: ${outside[0]}`);
  }

  // 4. PREVIOUS RESULT
  const runs = await api.workflowRuns(before);
  if (!Array.isArray(runs)) return fallback("workflow-run lookup returned an unexpected shape");
  const forThisPr = runs.filter((run) => pullRequestOnRun(run, event.prNumber) !== undefined);
  if (forThisPr.length === 0) return fallback(`no CI run for pull request #${event.prNumber} at ${short(before)}`);
  const run = forThisPr[0];
  if (run.status !== "completed" || run.conclusion !== "success") {
    return fallback(`previous run at ${short(before)} ended ${run.status ?? "unknown"}/${run.conclusion ?? "none"}, not success`);
  }
  const previousPr = pullRequestOnRun(run, event.prNumber);
  if (previousPr.base?.sha !== event.baseSha) {
    return fallback(`base moved since the previous run (${short(previousPr.base?.sha)} -> ${short(event.baseSha)})`);
  }
  if (!Number.isInteger(run.check_suite_id)) return fallback("previous run carries no check suite id");

  // 5. VERIFY
  const checks = await api.checkRuns(before);
  if (!Array.isArray(checks)) return fallback("check-run lookup returned an unexpected shape");
  const verify = checks.find(
    (check) =>
      check?.name === VERIFY_CHECK_NAME &&
      check.app?.slug === ACTIONS_APP_SLUG &&
      check.check_suite?.id === run.check_suite_id,
  );
  if (verify === undefined) return fallback(`no ${VERIFY_CHECK_NAME} check run from GitHub Actions on ${short(before)}`);
  if (verify.status !== "completed" || verify.conclusion !== "success") {
    return fallback(`${VERIFY_CHECK_NAME} on ${short(before)} ended ${verify.status ?? "unknown"}/${verify.conclusion ?? "none"}, not success`);
  }

  return {
    safe: true,
    reason:
      `${changed.length} documentation path(s) changed since ${short(before)}, ` +
      `which passed ${VERIFY_CHECK_NAME} in run ${run.id ?? "?"} against base ${short(event.baseSha)}`,
  };
}

function pullRequestOnRun(run, prNumber) {
  const pulls = run?.pull_requests;
  if (!Array.isArray(pulls)) return undefined;
  return pulls.find((pr) => pr?.number === prNumber);
}

// ---------------------------------------------------------------------------
// Real adapters
// ---------------------------------------------------------------------------

const realGit = {
  isAncestor(ancestor, descendant) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "pipe" });
      return true;
    } catch {
      // Exit 1 is "not an ancestor"; anything else (128: unknown object) is
      // history the checkout cannot vouch for. Both fall back.
      return false;
    }
  },
  changedFiles(from, to) {
    const output = execFileSync("git", ["diff", "--name-only", from, to], { encoding: "utf8", stdio: "pipe" });
    return output.split(/\r?\n/).filter((line) => line !== "");
  },
};

function githubApi({ apiUrl, repo, token, workflowFile }) {
  async function get(route) {
    const response = await fetch(`${apiUrl}${route}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET ${route} -> HTTP ${response.status}`);
    return response.json();
  }
  return {
    async workflowRuns(headSha) {
      const query = new URLSearchParams({ head_sha: headSha, event: "pull_request", per_page: "10" });
      const body = await get(`/repos/${repo}/actions/workflows/${workflowFile}/runs?${query}`);
      return body?.workflow_runs;
    },
    async checkRuns(headSha) {
      const query = new URLSearchParams({ check_name: VERIFY_CHECK_NAME, per_page: "50" });
      const body = await get(`/repos/${repo}/commits/${headSha}/check-runs?${query}`);
      return body?.check_runs;
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function writeOutput(outputPath, verdict) {
  const reason = verdict.reason.replace(/\s+/g, " ").trim();
  const line = `${verdict.safe ? "Safe follow-up" : "Normal classification"}: ${reason}`;
  console.log(line);
  if (outputPath) appendFileSync(outputPath, `safe_followup=${verdict.safe}\nreason=${reason}\n`);
}

async function main(env) {
  const token = env.GITHUB_TOKEN ?? "";
  const repo = env.REPO ?? "";
  if (token === "" || repo === "") {
    return fallback("GITHUB_TOKEN or REPO is not set");
  }
  return decideSafeFollowup({
    event: {
      name: env.EVENT_NAME ?? "",
      action: env.EVENT_ACTION ?? "",
      baseRef: env.BASE_REF ?? "",
      beforeSha: env.BEFORE_SHA ?? "",
      headSha: env.HEAD_SHA ?? "",
      baseSha: env.BASE_SHA ?? "",
      prNumber: Number(env.PR_NUMBER),
    },
    git: realGit,
    api: githubApi({
      apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
      repo,
      token,
      workflowFile: path.posix.basename(env.WORKFLOW_FILE ?? "ci.yml"),
    }),
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Never a job failure: the fallback is the ordinary classifier, so the worst
  // outcome of a broken detector is the full suite running as it always did.
  main(process.env)
    .catch((error) => fallback(`detector error: ${error instanceof Error ? error.message : String(error)}`))
    .then((verdict) => writeOutput(process.env.GITHUB_OUTPUT, verdict))
    .catch((error) => console.log(`Normal classification: could not write the verdict: ${String(error)}`))
    .finally(() => {
      process.exitCode = 0;
    });
}
