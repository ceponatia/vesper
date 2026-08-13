#!/usr/bin/env node
// The one way the Next application is launched from the repository root.
//
// Two repository-root facts have to survive the app living in apps/web, and
// this launcher is the single place that establishes both (
// monorepo-image-core.spec.apps-web.md §"Environment ownership" and
// §"Persistent image storage and process working directory"):
//
//   1. DATA_ROOT. `dataRoot()` falls back to `<cwd>/data`, and Next runs with
//      apps/web as its project directory, so an unset DATA_ROOT would start
//      resolving to apps/web/data and the existing image library would look
//      empty. The absolute repository default is set here, before Next starts.
//      An already-set DATA_ROOT always wins — that is how Fly pins /app/data.
//   2. The repository .env. Next loads .env from its own project directory, so
//      after the move it would no longer see the root file that root scripts
//      also read. It is loaded here instead of in next.config.ts, because
//      `next start` does not execute next.config.ts (it reads the build's
//      required-server-files.json) — a config-file loader would silently cover
//      dev and miss production.
//
// Existing environment variables always take precedence over the .env file.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const webDir = path.join(repoRoot, "apps", "web");

process.env.DATA_ROOT ??= path.join(repoRoot, "data");

const rootRequire = createRequire(path.join(repoRoot, "package.json"));
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  const { config } = rootRequire("dotenv");
  config({ path: envFile, override: false, quiet: true });
}

// Resolve Next from the web workspace rather than the repository root: `next`
// is a dependency of @vesper/web, so root node_modules has no copy of it.
const webRequire = createRequire(path.join(webDir, "package.json"));
const nextBin = webRequire.resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  cwd: webDir,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
