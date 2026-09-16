import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { RESOURCE_ROUTE, resourceRouteHasAuthorizationEvidence } from "./check-route-authz";

const root = process.cwd();
const apiRoot = join(root, "apps", "web", "src", "app", "api");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name === "route.ts") files.push(full);
  }
  return files;
}

const candidates = walk(apiRoot)
  .map((file) => relative(root, file).replaceAll("\\", "/"))
  .filter((file) => RESOURCE_ROUTE.test(file));

console.log(`Full route-authorization scan examined ${candidates.length} resource-ID route(s).`);

// An empty inventory is a broken gate, not a clean repository: this release
// check exists because resource-ID routes exist, so a zero match means the API
// tree moved out from under `RESOURCE_ROUTE` and the scan is now inspecting
// nothing. Failing here keeps that from passing as a green release signal.
if (candidates.length === 0) {
  console.error(
    `No resource-ID routes matched ${RESOURCE_ROUTE.source} under ${relative(root, apiRoot).replaceAll("\\", "/")}.`,
  );
  console.error(
    "Update RESOURCE_ROUTE in scripts/check-route-authz.ts to the current API route layout; the authorization inventory verifies nothing until it matches again.",
  );
  process.exit(1);
}

const unsafe = candidates.filter((file) => {
  const source = readFileSync(join(root, file), "utf8");
  return !resourceRouteHasAuthorizationEvidence(file, source);
});

if (unsafe.length > 0) {
  console.error("Sensitive resource-ID routes contain bare withUser handlers with no recognized authorization evidence:");
  for (const file of unsafe) console.error(`  - ${file}`);
  process.exit(1);
}
