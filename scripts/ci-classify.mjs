#!/usr/bin/env node

import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A path is documentation iff:
//   - it ends with `.md` (anywhere in the tree, not only under `docs/`); or
//   - it starts with `.github/ISSUE_TEMPLATE/` or `.github/PULL_REQUEST_TEMPLATE`; or
//   - it starts with `docs/`, its extension is one of DOCS_DIR_EXTENSIONS, and
//     its basename is not a test/spec file.
// A test or executable input does not become documentation merely by moving
// under `docs/`: `docs/foo.test.ts`, `docs/tools/x.mjs`, `docs/a.json`, and
// `docs/run.sh` are all code.
const DOCS_DIR_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".yaml", ".yml", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const TEST_OR_SPEC_BASENAME = /\.(test|spec)\./;

export function isDocumentationPath(file) {
  if (file.endsWith(".md")) return true;
  if (file.startsWith(".github/ISSUE_TEMPLATE/") || file.startsWith(".github/PULL_REQUEST_TEMPLATE")) return true;
  if (!file.startsWith("docs/")) return false;
  if (!DOCS_DIR_EXTENSIONS.has(path.extname(file))) return false;
  return !TEST_OR_SPEC_BASENAME.test(path.basename(file));
}

function any(files, predicate) {
  return files.some(predicate);
}

function matches(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(prefix));
}

export function classifyChanges({ files, eventName = "", baseRef = "", safeFollowup = false }) {
  if (eventName === "workflow_dispatch") {
    return {
      docs_only: false,
      docs: true,
      code: true,
      integration: true,
      engine: true,
      build: true,
      docker: true,
      safe_followup: false,
    };
  }

  if (safeFollowup) {
    return {
      docs_only: true,
      docs: true,
      code: false,
      integration: false,
      engine: false,
      build: false,
      docker: false,
      safe_followup: true,
    };
  }

  const promotion = eventName === "pull_request" && baseRef === "prod";
  const docs = promotion || any(files, isDocumentationPath);
  const code = promotion || any(files, (file) => !isDocumentationPath(file));
  const docsOnly = !promotion && files.length > 0 && files.every(isDocumentationPath);

  const workflowChanged = any(files, (file) => file.startsWith(".github/workflows/"));

  // Every ready, non-documentation code change requires the complete
  // integration gate: `code` (computed above) already covers a promotion and
  // fails closed to `true` for any path that isn't documentation, including
  // auth, chat, memory, test-only, script-only, CI-policy-only and unknown
  // paths. There is no narrower prefix carve-out here anymore — the Gate 1
  // benchmark (`engine`, below) stays the only narrower gate.
  const integration = code;

  const engine =
    promotion ||
    workflowChanged ||
    any(files, (file) => {
      if (matches(file, [
        "apps/web/src/server/engine/chat-",
        "apps/web/src/server/engine/prompts/chat-",
        "apps/web/src/server/engine/prompts/character-chat",
      ])) return false;
      return matches(file, [
        "apps/web/src/server/engine/",
        "apps/web/src/lib/simulation/",
        "packages/simulation-core/",
        "scripts/eval/engine-gate1/",
      ]);
    });

  // A production build is cheap enough to be useful on application/package
  // source changes, and it catches module-resolution failures that lint/tests
  // cannot. Documentation-only PRs remain zero-install.
  const build =
    promotion ||
    workflowChanged ||
    any(files, (file) => matches(file, [
      "apps/web/src/",
      "packages/",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig",
      "apps/web/package.json",
      "apps/web/tsconfig.json",
      "apps/web/next.config.",
      "scripts/web.mjs",
    ]));

  const docker =
    promotion ||
    workflowChanged ||
    any(files, (file) =>
      file === "Dockerfile" ||
      file === ".dockerignore" ||
      file.startsWith("docker/") ||
      file.startsWith("docker-compose") ||
      file === "package.json" ||
      file === "pnpm-lock.yaml" ||
      file === "pnpm-workspace.yaml" ||
      file === "apps/web/package.json" ||
      file.startsWith("packages/") && file.endsWith("/package.json"),
    );

  return {
    docs_only: docsOnly,
    docs,
    code,
    integration,
    engine: engine && integration,
    build,
    docker,
    safe_followup: false,
  };
}

function writeOutputs(outputPath, result) {
  for (const [key, value] of Object.entries(result)) {
    appendFileSync(outputPath, `${key}=${value}\n`);
  }
}

function main(env) {
  const files = readFileSync(env.CHANGED_FILES_FILE ?? "changed-files.txt", "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const result = classifyChanges({
    files,
    eventName: env.EVENT_NAME ?? "",
    baseRef: env.BASE_REF ?? "",
    safeFollowup: env.SAFE_FOLLOWUP === "true",
  });
  console.log(JSON.stringify({ files, result }, null, 2));
  if (env.GITHUB_OUTPUT) writeOutputs(env.GITHUB_OUTPUT, result);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env);
}
