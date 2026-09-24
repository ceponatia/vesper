#!/usr/bin/env node
// The application integration inventory policy — the one module the root
// Vitest configuration, the CI launcher (`scripts/ci-integration.mjs`) and the
// evidence verifier (`scripts/verify-integration-results.mjs`) share.
//
// It owns three facts and nothing else:
//
//   1. WHICH FILES ARE APPLICATION INTEGRATION SUITES. The universe U is every
//      `*.int.test.ts` under `apps/web/src/` or `scripts/` — the same include
//      contract the root `app-int` project always had. It is DISCOVERED, never
//      listed: an ordinary new suite belongs to U the moment it exists.
//      Package-owned tests (`packages/**`) keep their own configurations and
//      are not part of this gate.
//
//   2. WHICH SUITES MAY RUN WITH THE LEGACY SYNTHETIC-PLAYER CAPABILITY. L is
//      an explicit list of exact filenames, each with the reason it needs
//      `VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER`. Everything else is STRICT:
//      S = U − L. There is no directory or glob admission; a new suite that
//      needs the capability and is not listed fails its collection-time
//      precondition instead of quietly running without its claims.
//
//   3. HOW A PROCESS SELECTS ITS SLICE. `VESPER_INTEGRATION_MODE` is `strict`,
//      `legacy`, or `all` (unset). `all` is the unpartitioned census and
//      compatibility view that `pnpm test:int` keeps; the required CI executor
//      accepts only `strict` or `legacy`. An unknown mode is an error.
//
// Zero dependencies on purpose (like `scripts/check-docs.mjs`): the aggregate
// `verify` job runs the verifier, and with it this module, before any install.
//
// Usage: node scripts/integration-policy.mjs census [--json]
//   Reconciles `git ls-files` against the policy and prints the partition.
//   Exits 1 when the policy is inconsistent with the checkout.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POLICY_VERSION = 1;

/** The process-scoped selector read by the root Vitest configuration. */
export const INTEGRATION_MODE_ENV = "VESPER_INTEGRATION_MODE";

/** Every mode the configuration understands; unset means `all`. */
export const INTEGRATION_MODES = Object.freeze(["strict", "legacy", "all"]);

/** The modes the required CI executor may run. `all` is never a gate. */
export const CI_INTEGRATION_MODES = Object.freeze(["strict", "legacy"]);

/** The capability only legacy-mode processes may carry (see legacy-test-mode.ts). */
export const LEGACY_CAPABILITY_ENV = "VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER";

/** Repository roots whose integration suites form the application gate. */
export const APPLICATION_INTEGRATION_ROOTS = Object.freeze(["apps/web/src/", "scripts/"]);

/** The suffix that makes a file an application integration suite. */
export const APPLICATION_INTEGRATION_SUFFIX = ".int.test.ts";

/** The `app-int` project's include globs — the roots and suffix above, as Vitest reads them. */
export const APPLICATION_INTEGRATION_INCLUDE = Object.freeze(
  APPLICATION_INTEGRATION_ROOTS.map((root) => `${root}**/*${APPLICATION_INTEGRATION_SUFFIX}`),
);

const ACCOUNTLESS_PLAYER =
  "submits a `player` principal whose id names no account against a branch it seeded without a chat anchor";

/**
 * The audited legacy-fixture exceptions: exact repo-relative filenames, never
 * directories or globs, each with the reason it needs the capability. Every
 * file also passes `legacyPlayerMode: true` to `simulationSuiteHarness`, which
 * fails its collection unless the capability is on, so an entry here and the
 * file's own declaration must agree (`scripts/integration-policy.test.ts`).
 *
 * The capability admits ANY account-less player id on an unanchored branch, so
 * a suite belongs here when any of its expected outcomes needs such a command
 * to get past the authorization seam — an acceptance or a domain-level
 * rejection alike. A suite that asserts an authorization DENIAL never does.
 *
 * Shrinking this list is the fixture-migration path: a suite whose fixtures
 * move to real accounts and chat anchors leaves the list and runs strict.
 *
 * @type {ReadonlyArray<{ readonly file: string, readonly reason: string }>}
 */
export const LEGACY_INTEGRATION_EXCEPTIONS = Object.freeze(
  [
    ["apps/web/src/server/engine/sim-narrator.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal opens an engagement on the shared rollout branch`],
    ["apps/web/src/server/engine/simulation/activity-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal activity commands expected accepted`],
    ["apps/web/src/server/engine/simulation/body-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal body commands expected accepted`],
    ["apps/web/src/server/engine/simulation/branch-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: a playerPrincipal transfer expected accepted before forking`],
    ["apps/web/src/server/engine/simulation/cohort-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: "player-1" create_cohort expected to reach the domain unauthorized_principal rejection`],
    ["apps/web/src/server/engine/simulation/command-authz-legacy.int.test.ts", "proves the capability's own boundary: admits the account-less fixture on an unanchored branch, never a real account or an anchored branch"],
    ["apps/web/src/server/engine/simulation/commitment-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal commitment commands expected accepted`],
    ["apps/web/src/server/engine/simulation/engagement-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal engagement commands expected accepted`],
    ["apps/web/src/server/engine/simulation/gate3-corpus.int.test.ts", `${ACCOUNTLESS_PLAYER}: "player-1" corpus commands expected accepted or domain-rejected`],
    ["apps/web/src/server/engine/simulation/gate4-corpus.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal engagement opens expected accepted`],
    ["apps/web/src/server/engine/simulation/gate5-corpus.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal corpus commands expected accepted or domain-rejected`],
    ["apps/web/src/server/engine/simulation/gate6-corpus.int.test.ts", `${ACCOUNTLESS_PLAYER}: a playerPrincipal engagement open expected accepted`],
    ["apps/web/src/server/engine/simulation/household-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal household commands expected accepted`],
    ["apps/web/src/server/engine/simulation/knowledge-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal knowledge commands expected accepted`],
    ["apps/web/src/server/engine/simulation/lod-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: "player-1" commands expected accepted and domain-rejected`],
    ["apps/web/src/server/engine/simulation/memory-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal memory commands expected accepted`],
    ["apps/web/src/server/engine/simulation/move-together-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: a playerPrincipal engagement helper expected accepted`],
    ["apps/web/src/server/engine/simulation/narrative-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: a playerPrincipal engagement open expected accepted`],
    ["apps/web/src/server/engine/simulation/observation-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal observation commands expected accepted`],
    ["apps/web/src/server/engine/simulation/promotion-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal commands expected accepted or domain-rejected`],
    ["apps/web/src/server/engine/simulation/routine-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: a playerPrincipal engagement open expected accepted`],
    ["apps/web/src/server/engine/simulation/snapshot-reads.int.test.ts", `${ACCOUNTLESS_PLAYER}: a playerPrincipal engagement helper expected accepted`],
    ["apps/web/src/server/engine/simulation/social-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal social commands expected accepted or domain-rejected`],
    ["apps/web/src/server/engine/simulation/space-store.int.test.ts", `${ACCOUNTLESS_PLAYER}: playerPrincipal movement commands expected accepted`],
  ].map(([file, reason]) => Object.freeze({ file, reason })),
);

// ---------------------------------------------------------------------------
// Path predicates
// ---------------------------------------------------------------------------

/** Is `file` (repo-relative, forward slashes) an application integration suite? */
export function isApplicationIntegrationPath(file) {
  return (
    typeof file === "string" &&
    file.endsWith(APPLICATION_INTEGRATION_SUFFIX) &&
    APPLICATION_INTEGRATION_ROOTS.some((root) => file.startsWith(root)) &&
    !file.split("/").includes("node_modules")
  );
}

/**
 * Does `file` look like an integration test, whatever its extension or place?
 * Used only to find suites that would silently escape the gate — a
 * `.int.test.tsx`, a `.int.spec.ts`, or an `.int.test.ts` outside both roots.
 */
export function looksLikeIntegrationTest(file) {
  return /\.int\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** Package-owned tests keep their own configuration and are not this gate's. */
export function isPackageOwnedPath(file) {
  return file.startsWith("packages/");
}

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

/**
 * The integration mode for a process. Unset or empty means `all`; anything
 * outside {@link INTEGRATION_MODES} throws, so a typo can never select a
 * different slice than the one asked for.
 * @param {Record<string, string | undefined>} env
 */
export function resolveIntegrationMode(env) {
  const raw = env[INTEGRATION_MODE_ENV];
  if (raw === undefined || raw === "") return "all";
  if (!INTEGRATION_MODES.includes(raw)) {
    throw new Error(
      `${INTEGRATION_MODE_ENV}=${JSON.stringify(raw)} is not a known integration mode; expected one of ${INTEGRATION_MODES.join(", ")} (unset means all).`,
    );
  }
  return raw;
}

/**
 * Escape a literal repo-relative path so a glob engine matches exactly that
 * file. Mirrors tinyglobby's POSIX `escapePath` (the engine Vitest collects
 * with): Next route directories like `[chatId]` and `(group)` are glob syntax
 * otherwise.
 */
export function literalGlob(file) {
  return file.replace(/[()[\]{}*?|\\]|^!|[!+@](?=\()/g, "\\$&");
}

/**
 * The `app-int` project's include/exclude for a mode. Vitest does not pass a
 * command-line `--exclude` down to a project, so the partition is applied here,
 * inside the project configuration, from the same exception list the verifier
 * reads.
 * @param {"strict" | "legacy" | "all"} mode
 * @param {ReadonlyArray<{ file: string }>} [exceptions]
 */
export function integrationSelectionForMode(mode, exceptions = LEGACY_INTEGRATION_EXCEPTIONS) {
  const legacyGlobs = exceptions.map((entry) => literalGlob(entry.file));
  switch (mode) {
    case "all":
      return { include: [...APPLICATION_INTEGRATION_INCLUDE], exclude: [] };
    case "strict":
      return { include: [...APPLICATION_INTEGRATION_INCLUDE], exclude: legacyGlobs };
    case "legacy":
      return { include: legacyGlobs, exclude: [] };
    default:
      throw new Error(`unknown integration mode ${JSON.stringify(mode)}`);
  }
}

// ---------------------------------------------------------------------------
// Validation and partition
// ---------------------------------------------------------------------------

const GLOB_SYNTAX = /[*?{}!]/;

/**
 * Shape checks that need no filesystem: every entry names one exact
 * application integration file, once, with a reason.
 * @param {ReadonlyArray<{ file: unknown, reason: unknown }>} exceptions
 * @returns {string[]} problems, empty when valid
 */
export function validateLegacyExceptions(exceptions) {
  const problems = [];
  if (!Array.isArray(exceptions)) return ["legacy exceptions must be an array"];
  const seen = new Set();
  for (const [index, entry] of exceptions.entries()) {
    const file = entry?.file;
    const label = typeof file === "string" ? file : `entry ${index}`;
    if (typeof file !== "string" || file === "") {
      problems.push(`legacy exception ${index} has no file`);
      continue;
    }
    if (seen.has(file)) problems.push(`duplicate legacy exception: ${file}`);
    seen.add(file);
    if (file.startsWith("/") || file.startsWith("./") || file.split("/").includes("..") || file.includes("\\")) {
      problems.push(`legacy exception must be a plain repo-relative path: ${label}`);
    }
    if (GLOB_SYNTAX.test(file) || file.endsWith("/")) {
      problems.push(`legacy exception must name one exact file, not a pattern or directory: ${label}`);
    }
    if (!isApplicationIntegrationPath(file)) {
      problems.push(`legacy exception is not an application integration suite: ${label}`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
      problems.push(`legacy exception needs a reason: ${label}`);
    }
  }
  return problems;
}

/**
 * Reconcile tracked files with the include contract.
 * @param {ReadonlyArray<string>} tracked every tracked path (`git ls-files`)
 * @returns {{ universe: string[], misplaced: string[] }}
 */
export function reconcileTrackedIntegrationFiles(tracked) {
  const universe = [];
  const misplaced = [];
  for (const file of tracked) {
    if (isApplicationIntegrationPath(file)) universe.push(file);
    else if (looksLikeIntegrationTest(file) && !isPackageOwnedPath(file)) misplaced.push(file);
  }
  return { universe: sortedUnique(universe), misplaced: sortedUnique(misplaced) };
}

/**
 * Partition the universe into strict and legacy.
 *
 *   S ∩ L = ∅,  S ∪ L = U,  U ≠ ∅,  every exception names a member of U.
 *
 * @param {ReadonlyArray<string>} universe
 * @param {ReadonlyArray<{ file: string, reason: string }>} [exceptions]
 * @returns {{ strict: string[], legacy: string[], problems: string[] }}
 */
export function partitionIntegrationInventory(universe, exceptions = LEGACY_INTEGRATION_EXCEPTIONS) {
  const problems = validateLegacyExceptions(exceptions);
  const members = new Set(universe);
  if (members.size === 0) problems.push("the application integration universe is empty");
  if (members.size !== universe.length) problems.push("the application integration universe lists a file twice");
  const legacySet = new Set();
  for (const { file } of exceptions) {
    if (typeof file !== "string") continue;
    if (!members.has(file)) problems.push(`stale legacy exception (no such integration suite): ${file}`);
    else legacySet.add(file);
  }
  const strict = [...members].filter((file) => !legacySet.has(file)).sort();
  const legacy = [...legacySet].sort();
  return { strict, legacy, problems };
}

/** The files a mode owns, from a partition. `all` is the whole universe. */
export function inventoryForMode(mode, partition) {
  if (mode === "strict") return partition.strict;
  if (mode === "legacy") return partition.legacy;
  return [...partition.strict, ...partition.legacy].sort();
}

// ---------------------------------------------------------------------------
// Identity hashes
// ---------------------------------------------------------------------------

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sortedUnique(files) {
  return [...new Set(files)].sort();
}

/** A stable hash of everything that decides the partition. */
export function policyHash(exceptions = LEGACY_INTEGRATION_EXCEPTIONS) {
  return sha256(
    JSON.stringify({
      version: POLICY_VERSION,
      roots: APPLICATION_INTEGRATION_ROOTS,
      suffix: APPLICATION_INTEGRATION_SUFFIX,
      legacy: [...exceptions].map((entry) => entry.file).sort(),
    }),
  );
}

/** A stable hash of a file list, order-insensitive. */
export function inventoryHash(files) {
  return sha256([...files].sort().join("\n"));
}

// ---------------------------------------------------------------------------
// Census (git-backed)
// ---------------------------------------------------------------------------

/** Every tracked path in the checkout at `cwd`. */
export function trackedFiles(cwd) {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split("\0").filter((line) => line !== "");
}

/**
 * The reproducible census: tracked integration files reconciled against the
 * include contract and partitioned by the exception list.
 * @param {ReadonlyArray<string>} tracked
 */
export function integrationCensus(tracked, exceptions = LEGACY_INTEGRATION_EXCEPTIONS) {
  const { universe, misplaced } = reconcileTrackedIntegrationFiles(tracked);
  const partition = partitionIntegrationInventory(universe, exceptions);
  const problems = [
    ...partition.problems,
    ...misplaced.map((file) => `integration-looking file outside the application roots (it would never run): ${file}`),
  ];
  return {
    universe,
    strict: partition.strict,
    legacy: partition.legacy,
    misplaced,
    problems,
    policyHash: policyHash(exceptions),
    universeHash: inventoryHash(universe),
  };
}

/** The repository root this module lives in. */
export function repositoryRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function main(argv) {
  const [command, ...flags] = argv;
  if (command !== "census" || flags.some((flag) => flag !== "--json")) {
    console.error("usage: node scripts/integration-policy.mjs census [--json]");
    return 2;
  }
  const census = integrationCensus(trackedFiles(repositoryRoot()));
  if (flags.includes("--json")) {
    console.log(JSON.stringify(census, null, 2));
  } else {
    console.log(`application integration suites: ${census.universe.length}`);
    console.log(`  strict: ${census.strict.length}`);
    console.log(`  legacy: ${census.legacy.length}`);
    for (const file of census.legacy) console.log(`    ${file}`);
    console.log(`policy hash: ${census.policyHash}`);
    console.log(`universe hash: ${census.universeHash}`);
    for (const problem of census.problems) console.error(`problem: ${problem}`);
  }
  return census.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
