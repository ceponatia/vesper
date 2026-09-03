import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decideSafeFollowup, gitAdapter } from "./ci-safe-followup.mjs";
import type { CheckRunLike, SafeFollowupEvent, WorkflowRunLike } from "./ci-safe-followup.mjs";

/**
 * The safe-follow-up detector's fail-closed contract
 * (`scripts/ci-safe-followup.mjs`, run by CI's `changes` job).
 *
 * A `true` verdict lets the classifier skip lint, static checks, unit tests,
 * the engine suite and the build for the run, so a wrong `true` is a code
 * change reaching `main` on a green `verify` it never earned. These cases pin
 * the one qualifying shape and prove that removing any single condition —
 * event, history, path set, previous run, base, or the `verify` check — yields
 * `false` with a reason naming what fell back. A detector that reported `true`
 * from the run object alone, or from a run for another pull request at the
 * same sha, fails here.
 *
 * The decision is imported rather than spawned because it is the unit under
 * test and its adapters are injected; the one spawn below proves the other
 * half of the contract — the entry point exits 0 and writes `false` when git
 * cannot vouch for the history — which no import can show.
 */

const BEFORE = "a".repeat(40);
const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const OTHER_BASE = "d".repeat(40);
const PR = 358;
const SUITE = 9001;

const EVENT: SafeFollowupEvent = {
  name: "pull_request",
  action: "synchronize",
  baseRef: "main",
  beforeSha: BEFORE,
  headSha: HEAD,
  baseSha: BASE,
  prNumber: PR,
};

const GREEN_RUN: WorkflowRunLike = {
  id: 42,
  status: "completed",
  conclusion: "success",
  check_suite_id: SUITE,
  pull_requests: [{ number: PR, base: { sha: BASE, ref: "main" } }],
};

const GREEN_VERIFY: CheckRunLike = {
  name: "verify",
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
  check_suite: { id: SUITE },
};

interface Scenario {
  event?: Partial<SafeFollowupEvent>;
  ancestor?: boolean;
  changed?: string[];
  runs?: unknown;
  checks?: unknown;
  throws?: string;
}

function decide(scenario: Scenario = {}) {
  const runs = scenario.runs ?? [GREEN_RUN];
  const checks = scenario.checks ?? [GREEN_VERIFY];
  return decideSafeFollowup({
    event: { ...EVENT, ...scenario.event },
    git: {
      isAncestor: () => scenario.ancestor ?? true,
      changedFiles: () => scenario.changed ?? ["docs/testing.md"],
    },
    api: {
      workflowRuns: () => (scenario.throws ? Promise.reject(new Error(scenario.throws)) : Promise.resolve(runs)),
      checkRuns: () => Promise.resolve(checks),
    },
  });
}

describe("ci-safe-followup", () => {
  it("accepts a documentation follow-up to a green revision of the same pull request", async () => {
    const verdict = await decide({ changed: ["docs/testing.md", "README.md", ".github/ISSUE_TEMPLATE/bug.yml"] });
    expect(verdict).toEqual({ safe: true, reason: expect.stringContaining("3 documentation path(s)") });
  });

  it.each<[string, Scenario, RegExp]>([
    ["a push rather than a pull request", { event: { name: "push" } }, /event is push/],
    ["a ready-for-review flip rather than an update", { event: { action: "ready_for_review" } }, /not synchronize/],
    ["a promotion to prod", { event: { baseRef: "prod" } }, /prod/],
    ["a zero previous sha", { event: { beforeSha: "0".repeat(40) } }, /sha is missing/],
    ["a force push or rebase", { ancestor: false }, /not an ancestor/],
    ["an empty diff", { changed: [] }, /no paths changed/],
    ["a code path among the documentation paths", { changed: ["docs/testing.md", "apps/web/x.ts"] }, /apps\/web\/x\.ts/],
    ["a workflow change", { changed: [".github/workflows/ci.yml"] }, /workflow changed/],
    ["no previous run at the previous head", { runs: [] }, /no CI run for pull request #358/],
    ["a previous run for a different pull request", { runs: [{ ...GREEN_RUN, pull_requests: [{ number: 1, base: { sha: BASE } }] }] }, /no CI run for pull request #358/],
    ["a previous run that failed", { runs: [{ ...GREEN_RUN, conclusion: "failure" }] }, /completed\/failure, not success/],
    ["a previous run still in progress", { runs: [{ ...GREEN_RUN, status: "in_progress", conclusion: null }] }, /in_progress\/none/],
    ["a newer failed rerun ahead of the green one", { runs: [{ ...GREEN_RUN, conclusion: "cancelled" }, GREEN_RUN] }, /cancelled/],
    ["a base that moved since the previous run", { runs: [{ ...GREEN_RUN, pull_requests: [{ number: PR, base: { sha: OTHER_BASE } }] }] }, /base moved/],
    ["no verify check run on the previous head", { checks: [] }, /no verify check run/],
    ["a verify check run from another check suite", { checks: [{ ...GREEN_VERIFY, check_suite: { id: 1 } }] }, /no verify check run/],
    ["a verify check run from another app", { checks: [{ ...GREEN_VERIFY, app: { slug: "codecov" } }] }, /no verify check run/],
    ["a failed verify check run", { checks: [{ ...GREEN_VERIFY, conclusion: "failure" }] }, /verify on .* ended completed\/failure/],
    ["a workflow-run response of the wrong shape", { runs: { message: "Not Found" } }, /unexpected shape/],
    ["an API error", { throws: "HTTP 503" }, /lookup failed.*HTTP 503/],
  ])("falls back on %s", async (_name, scenario, reason) => {
    const verdict = await decide(scenario);
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toMatch(reason);
  });
});

describe("ci-safe-followup git adapter", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Git's default rename detection lists a rename only at its destination, so
  // a code file moved under docs/ would read as documentation-only. The
  // adapter must report both sides.
  it("lists both sides of a rename from a code path into a documentation path", () => {
    const dir = mkdtempSync(join(tmpdir(), "vesper-safe-followup-git-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-q");
    git("config", "user.email", "ci@vesper.local");
    git("config", "user.name", "ci");
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "x.ts"), "export const x = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "code");
    const before = git("rev-parse", "HEAD");
    mkdirSync(join(dir, "docs"), { recursive: true });
    renameSync(join(dir, "apps", "web", "x.ts"), join(dir, "docs", "x.md"));
    git("add", "-A");
    git("commit", "-q", "-m", "move");
    const head = git("rev-parse", "HEAD");
    expect(gitAdapter(dir).changedFiles(before, head).sort()).toEqual(["apps/web/x.ts", "docs/x.md"]);
  });
});

describe("ci-safe-followup entry point", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 and reports false when the previous head is unknown to the checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "vesper-safe-followup-"));
    dirs.push(dir);
    const output = join(dir, "output.txt");
    const stdout = execFileSync(process.execPath, [join(process.cwd(), "scripts", "ci-safe-followup.mjs")], {
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        EVENT_NAME: "pull_request",
        EVENT_ACTION: "synchronize",
        BASE_REF: "main",
        BEFORE_SHA: BEFORE,
        HEAD_SHA: HEAD,
        BASE_SHA: BASE,
        PR_NUMBER: String(PR),
        REPO: "ceponatia/vesper",
        GITHUB_TOKEN: "unused-history-check-fails-first",
        GITHUB_OUTPUT: output,
      },
    });
    expect(stdout).toMatch(/^Normal classification: .*not an ancestor/m);
    expect(readFileSync(output, "utf8")).toMatch(/^safe_followup=false$/m);
  });
});
