#!/usr/bin/env node
// Native Vitest planning for one application integration batch.
//
// `vitest list --filesOnly` does not apply `--shard` (sharding happens only
// when a run executes), so the launcher cannot read a shard's expected files
// from the CLI. This script asks Vitest itself instead: it loads the root
// configuration exactly as a run would — `VESPER_INTEGRATION_MODE` selects the
// slice inside the `app-int` project — lists the project's test files, and
// hands them to the configured sequencer's own `shard()`. Nothing here
// reimplements file discovery or the shard split.
//
// Usage (the launcher runs it in a child process with a controlled environment):
//   VESPER_INTEGRATION_MODE=<mode> node scripts/integration-plan.mjs --out=<file> [--shard=<i>/<n>]
// Writes { mode, files, shardFiles } with repo-relative, sorted paths.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createVitest } from "vitest/node";
import { repositoryRoot, resolveIntegrationMode } from "./integration-policy.mjs";

async function plan(shard) {
  const root = repositoryRoot();
  // What `vitest list` sets before it creates the instance.
  process.env.TEST = "true";
  process.env.VITEST = "true";
  process.env.NODE_ENV ??= "test";
  const mode = resolveIntegrationMode(process.env);
  const vitest = await createVitest("test", {
    root,
    config: path.join(root, "vitest.config.ts"),
    project: ["app-int"],
    run: true,
    watch: false,
    ...(shard === undefined ? {} : { shard }),
  });
  try {
    const specs = await vitest.getRelevantTestSpecifications();
    const relative = (spec) => path.relative(root, spec.moduleId).split(path.sep).join("/");
    const files = specs.map(relative).sort();
    let shardFiles = files;
    if (shard !== undefined) {
      const Sequencer = vitest.config.sequence.sequencer;
      shardFiles = (await new Sequencer(vitest).shard([...specs])).map(relative).sort();
    }
    return { mode, files, shardFiles };
  } finally {
    await vitest.close();
  }
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: "string" }, shard: { type: "string" } },
  strict: true,
  allowPositionals: false,
});
if (values.out === undefined) {
  console.error("usage: node scripts/integration-plan.mjs --out=<file> [--shard=<i>/<n>]");
  process.exit(2);
}
const result = await plan(values.shard);
mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
writeFileSync(path.resolve(values.out), `${JSON.stringify(result, null, 2)}\n`);
