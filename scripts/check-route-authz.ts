import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The route-handler wrappers that carry the ownership (or admin/support) check
 * themselves, all exported from `src/server/api/authz.ts`. A resource-ID route
 * mentioning none of them while using bare `withUser` is the shape this gate
 * rejects.
 *
 * Exported so `src/server/api/ownership-guardrail.test.ts` can cross-check it
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
const resourceRoute = /src\/app\/api\/.+\/\[[^/]+\]\/.*route\.ts$/;

function changedFiles(): string[] {
  const explicitBase = process.env.ROUTE_AUTHZ_BASE;
  const candidates = explicitBase
    ? [`${explicitBase}...HEAD`]
    : ["origin/main...HEAD", "main...HEAD", "HEAD~1...HEAD"];

  for (const range of candidates) {
    try {
      return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", range], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
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
