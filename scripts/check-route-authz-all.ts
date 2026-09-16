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

const unsafe = candidates.filter((file) => {
  const source = readFileSync(join(root, file), "utf8");
  return !resourceRouteHasAuthorizationEvidence(file, source);
});

console.log(`Full route-authorization scan examined ${candidates.length} resource-ID route(s).`);

if (unsafe.length > 0) {
  console.error("Sensitive resource-ID routes contain bare withUser handlers with no recognized authorization evidence:");
  for (const file of unsafe) console.error(`  - ${file}`);
  process.exit(1);
}
