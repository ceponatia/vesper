import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const approvedWrappers = /\b(withOwnedChat|withOwnedEntity|withAdmin|withAdminOwnedChat|withAuthorizedResource)\b/;
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

const unsafe: string[] = [];
for (const path of changedFiles()) {
  if (!resourceRoute.test(path)) continue;
  const source = readFileSync(resolve(path), "utf8");
  if (/\bwithUser\b/.test(source) && !approvedWrappers.test(source)) unsafe.push(relative(process.cwd(), path));
}

if (unsafe.length > 0) {
  console.error("Sensitive resource-ID routes may not rely on bare withUser:");
  for (const path of unsafe) console.error(`  - ${path}`);
  console.error("Use withOwnedChat, withOwnedEntity, withAdmin, withAdminOwnedChat, or withAuthorizedResource.");
  process.exit(1);
}
