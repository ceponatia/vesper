import { describe, expect, it } from "vitest";

import { classifyChanges, isDocumentationPath } from "./ci-classify.mjs";
import type { CiClassification } from "./ci-classify.mjs";

describe("CI path classification: per-file gate selection", () => {
  it.each<[string, string[], Partial<CiClassification>]>([
    ["auth changes require the full integration gate", ["apps/web/src/server/auth/credential-guard.ts"], { code: true, integration: true }],
    ["chat engine glue is excluded from the narrow engine gate but not integration", ["apps/web/src/server/engine/chat-garments.ts"], { integration: true, engine: false }],
    ["chat system prompts are excluded from engine but not integration", ["apps/web/src/server/engine/prompts/chat-system.ts"], { integration: true, engine: false }],
    ["character-chat prompts require integration", ["apps/web/src/server/engine/prompts/character-chat.ts"], { integration: true }],
    ["memory changes require the full integration gate", ["apps/web/src/server/memory/retrieve.ts"], { integration: true }],
    ["reference-extraction changes require the full integration gate", ["apps/web/src/server/reference-extraction/x.ts"], { integration: true }],
    ["integration test scripts require integration", ["scripts/trial/romantic-contact/driver.int.test.ts"], { integration: true }],
    ["the classifier's own source requires integration", ["scripts/ci-classify.mjs"], { integration: true }],
    ["the integration results verifier script requires integration", ["scripts/verify-integration-results.mjs"], { integration: true }],
    ["the integration policy script requires integration", ["scripts/integration-policy.mjs"], { integration: true }],
    ["ordinary component source requires integration but not docker", ["apps/web/src/components/foo.tsx"], { integration: true, docker: false }],
    ["chat contracts require integration", ["apps/web/src/contracts/chat/x.ts"], { integration: true }],
    ["an unrecognized path fails closed to code and integration", ["some/unknown/path.xyz"], { code: true, integration: true }],
    ["a preflight hook change requires integration", [".claude/hooks/preflight.py"], { integration: true }],
    ["engine/simulation source requires both integration and the narrow engine gate", ["apps/web/src/server/engine/simulation/space-store.ts"], { integration: true, engine: true }],
    ["simulation-core package source runs the narrow engine gate", ["packages/simulation-core/src/lib/x.ts"], { engine: true }],
    ["authoring source requires integration (test:engine no longer exempts it)", ["apps/web/src/server/authoring/library-relationships.ts"], { integration: true }],
    ["a deleted path still counts as code", ["apps/web/src/server/auth/removed.ts"], { integration: true }],
    ["a rename out of code into docs (--no-renames reports both sides)", ["apps/web/src/server/auth/x.ts", "docs/x.md"], { docs: true, code: true, integration: true, docs_only: false }],
    ["a test file under docs/ is code, not documentation", ["docs/foo.test.ts"], { code: true, integration: true, docs_only: false }],
    ["a script under docs/ is code, not documentation", ["docs/tools/check.mjs"], { code: true, docs_only: false }],
    ["a yaml document under docs/ is documentation-only", ["docs/openapi/chats.yaml"], { docs_only: true, integration: false }],
    ["documentation-only changes stay zero-install", ["docs/testing.md"], { docs_only: true, code: false, integration: false, build: false, docker: false }],
    ["a root README is documentation-only", ["README.md"], { docs_only: true, integration: false }],
    ["an issue template is documentation-only", [".github/ISSUE_TEMPLATE/bug.yml"], { docs_only: true }],
  ])("%s", (_name, files, expected) => {
    expect(classifyChanges({ files, eventName: "pull_request", baseRef: "main" })).toMatchObject(expected);
  });

  it("runs every expensive gate when the workflow itself changes", () => {
    expect(classifyChanges({ files: [".github/workflows/ci.yml"], eventName: "pull_request", baseRef: "main" })).toMatchObject({
      code: true,
      integration: true,
      engine: true,
      build: true,
      docker: true,
    });
  });

  it("validates Docker packaging changes", () => {
    expect(classifyChanges({ files: [".dockerignore"], eventName: "pull_request", baseRef: "main" }).docker).toBe(true);
  });

  it("forces all gates for prod promotions", () => {
    expect(classifyChanges({ files: ["docs/testing.md"], eventName: "pull_request", baseRef: "prod" })).toMatchObject({
      docs_only: false,
      docs: true,
      code: true,
      integration: true,
      engine: true,
      build: true,
      docker: true,
    });
  });

  it("forces all gates for manual verification", () => {
    expect(classifyChanges({ files: [], eventName: "workflow_dispatch", baseRef: "" })).toMatchObject({
      docs: true,
      code: true,
      integration: true,
      engine: true,
      build: true,
      docker: true,
    });
  });

  it("preserves the safe documentation follow-up fast path", () => {
    expect(classifyChanges({
      files: ["docs/testing.md"],
      eventName: "pull_request",
      baseRef: "main",
      safeFollowup: true,
    })).toMatchObject({
      docs_only: true,
      docs: true,
      code: false,
      integration: false,
      engine: false,
      build: false,
      docker: false,
      safe_followup: true,
    });
  });
});

describe("isDocumentationPath", () => {
  it.each<[string, boolean]>([
    ["docs/a.md", true],
    ["docs/openapi/x.yaml", true],
    ["docs/img/p.png", true],
    // Ends with `.md`, so the first rule matches regardless of the
    // test/spec-shaped basename; the test/spec exclusion only applies to the
    // docs/-prefix-plus-extension rule for non-`.md` extensions.
    ["docs/a.test.md", true],
    ["docs/a.test.ts", false],
    ["docs/a.spec.yaml", false],
    ["docs/x.mjs", false],
    ["docs/x.json", false],
    ["apps/web/README.md", true],
    ["apps/web/src/a.ts", false],
  ])("isDocumentationPath(%s) -> %s", (file, expected) => {
    expect(isDocumentationPath(file)).toBe(expected);
  });
});
