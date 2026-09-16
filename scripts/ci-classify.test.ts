import { describe, expect, it } from "vitest";

import { classifyChanges } from "./ci-classify.mjs";

describe("CI path classification", () => {
  it("keeps documentation-only changes on the zero-install path", () => {
    expect(classifyChanges({ files: ["docs/testing.md"], eventName: "pull_request", baseRef: "main" })).toMatchObject({
      docs_only: true,
      docs: true,
      code: false,
      integration: false,
      build: false,
      docker: false,
    });
  });

  it("runs integration for authoring because test:engine owns authoring DB suites", () => {
    expect(classifyChanges({
      files: ["apps/web/src/server/authoring/library-relationships.ts"],
      eventName: "pull_request",
      baseRef: "main",
    }).integration).toBe(true);
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

  it("builds ordinary application source changes", () => {
    expect(classifyChanges({ files: ["apps/web/src/components/foo.tsx"], eventName: "pull_request", baseRef: "main" }).build).toBe(true);
  });

  it("does not start Docker validation for ordinary application source", () => {
    expect(classifyChanges({ files: ["apps/web/src/components/foo.tsx"], eventName: "pull_request", baseRef: "main" }).docker).toBe(false);
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
