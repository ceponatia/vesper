import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The route-handler wrappers that carry the ownership (or admin/support) check
 * themselves, all exported from `apps/web/src/server/api/authz.ts`. A
 * resource-ID route mentioning none of them while using bare `withUser` is the
 * shape this gate rejects.
 *
 * Exported so `scripts/ownership-guardrail.test.ts` can cross-check it
 * against its own hand-maintained OWNER_ASSERTING_HELPERS list — see the
 * "keeps the two route-authz allow-lists distinct and live" test there for the
 * relationship between the two (they name different mechanisms and must stay
 * disjoint).
 */
export const APPROVED_ROUTE_AUTHZ_WRAPPERS = [
  "withOwnedChat",
  "withOwnedEntity",
  "withOwnerAdmin",
  "withOwnerAdminResource",
  "withOwnerAdminOwnedChat",
  "withCrossAccountSupport",
  "withAuthorizedResource",
] as const;

const approvedWrappers = new RegExp(String.raw`\b(${APPROVED_ROUTE_AUTHZ_WRAPPERS.join("|")})\b`);
// Anchored at the application workspace, not merely at `src/`: after the app
// moved to apps/web an unanchored pattern would still match by coincidence, and
// this gate has to fail loudly rather than keep working by accident.
const resourceRoute = /^apps\/web\/src\/app\/api\/.+\/\[[^/]+\]\/.*route\.ts$/;

/**
 * Paths whose CONTENT a range changed, from `git diff --name-status`.
 *
 * A pure rename (`R100`) is excluded, and that exclusion is the point: this gate
 * reads a file's source, so a file that only moved has already been judged
 * wherever it used to live. Without it, one repository-wide directory move
 * re-audits every route in the tree at once — which is what the `apps/web` move
 * did (2026-08-12), turning a per-change gate into a 30-route wall of findings
 * about code nobody had touched.
 *
 * A rename WITH edits (`R087`) still counts, under its destination path. So
 * does a copy of any score: `C100` puts existing content at a NEW path, and a
 * new route is exactly what this gate exists to read.
 */
export function contentChangedPaths(nameStatus: string): string[] {
  const files: string[] = [];
  for (const line of nameStatus.split("\n")) {
    if (line.trim() === "") continue;
    // Renames and copies are `<status>\t<source>\t<destination>`; everything
    // else is `<status>\t<path>`.
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[2]?.trim();
      if (destination !== undefined && destination !== "" && status !== "R100") files.push(destination);
      continue;
    }
    const path = fields[1]?.trim();
    if (path !== undefined && path !== "") files.push(path);
  }
  return files;
}

function changedFiles(): string[] {
  const explicitBase = process.env.ROUTE_AUTHZ_BASE;
  const candidates = explicitBase
    ? [`${explicitBase}...HEAD`]
    : ["origin/main...HEAD", "main...HEAD", "HEAD~1...HEAD"];

  for (const range of candidates) {
    try {
      // `-l0` lifts git's rename-detection limit. With it off, a diff larger
      // than the limit silently degrades renames into add+delete pairs, and
      // every moved file would come back as new content.
      const nameStatus = execFileSync(
        "git",
        ["diff", "--name-status", "--find-renames", "-l0", "--diff-filter=ACMR", range],
        { encoding: "utf8" },
      );
      return contentChangedPaths(nameStatus);
    } catch {
      // Try the next locally available base.
    }
  }
  throw new Error("could not determine a base revision for route authorization checks");
}

function main(): void {
  const unsafe: string[] = [];
  for (const path of changedFiles()) {
    if (!resourceRoute.test(path)) continue;
    const source = readFileSync(resolve(path), "utf8");
    if (/\bwithUser\b/.test(source) && !approvedWrappers.test(source)) unsafe.push(relative(process.cwd(), path));
  }

  if (unsafe.length > 0) {
    console.error("Sensitive resource-ID routes may not rely on bare withUser:");
    for (const path of unsafe) console.error(`  - ${path}`);
    console.error(
      "Use an owner-scoped wrapper, withOwnerAdminResource/withOwnerAdminOwnedChat, or withCrossAccountSupport.",
    );
    process.exit(1);
  }
}

// The check runs only when this file IS the process entry point (`pnpm
// lint:authz`). Importing it — which the guardrail test does, for the wrapper
// list above — must not shell out to git or call process.exit. Path comparison
// is case-insensitive because Windows hands back drive letters in either case.
const entryPoint = process.argv[1];
const isMain =
  entryPoint !== undefined &&
  resolve(entryPoint).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main();
