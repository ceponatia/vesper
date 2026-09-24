import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_LEGACY_CAPABILITY_ENV,
  INTEGRATION_MODE_ENV as WORKER_MODE_ENV,
  LEGACY_ENGINE_TEST_PLAYER_ENV,
} from "@/server/test-support";
import {
  APPLICATION_INTEGRATION_INCLUDE,
  INTEGRATION_MODE_ENV,
  LEGACY_CAPABILITY_ENV,
  LEGACY_INTEGRATION_EXCEPTIONS,
  integrationCensus,
  integrationSelectionForMode,
  literalGlob,
  partitionIntegrationInventory,
  policyHash,
  reconcileTrackedIntegrationFiles,
  resolveIntegrationMode,
  trackedFiles,
  validateLegacyExceptions,
} from "./integration-policy.mjs";

/**
 * The application integration policy (#638): one discovered universe, an
 * explicit legacy-fixture exception list, and a strict remainder.
 */

const REASON = "submits the legacy synthetic player against unanchored branches";
const legacy = (file: string) => ({ file, reason: REASON });

const TRACKED = [
  "apps/web/src/server/api/authz-matrix.int.test.ts",
  "apps/web/src/server/engine/simulation/space-store.int.test.ts",
  "apps/web/src/app/api/chats/[chatId]/sim-routing.int.test.ts",
  "scripts/trial/romantic-contact/driver.int.test.ts",
  "apps/web/src/server/api/quota.test.ts",
  "packages/simulation-core/src/lib/space.test.ts",
  "docs/testing.md",
];

describe("mode selection", () => {
  it.each([
    [{}, "all"],
    [{ [INTEGRATION_MODE_ENV]: "" }, "all"],
    [{ [INTEGRATION_MODE_ENV]: "all" }, "all"],
    [{ [INTEGRATION_MODE_ENV]: "strict" }, "strict"],
    [{ [INTEGRATION_MODE_ENV]: "legacy" }, "legacy"],
  ])("resolves %j to %s", (env, mode) => {
    expect(resolveIntegrationMode(env)).toBe(mode);
  });

  it.each(["STRICT", "strict ", "legacy-only", "none"])("rejects the unknown mode %j", (value) => {
    expect(() => resolveIntegrationMode({ [INTEGRATION_MODE_ENV]: value })).toThrow(/not a known integration mode/);
  });

  it("partitions the project selection without a whole-directory admission", () => {
    const exceptions = [legacy("apps/web/src/server/engine/simulation/space-store.int.test.ts")];
    expect(integrationSelectionForMode("all", exceptions)).toEqual({ include: [...APPLICATION_INTEGRATION_INCLUDE], exclude: [] });
    expect(integrationSelectionForMode("strict", exceptions)).toEqual({
      include: [...APPLICATION_INTEGRATION_INCLUDE],
      exclude: ["apps/web/src/server/engine/simulation/space-store.int.test.ts"],
    });
    expect(integrationSelectionForMode("legacy", exceptions)).toEqual({
      include: ["apps/web/src/server/engine/simulation/space-store.int.test.ts"],
      exclude: [],
    });
  });

  it("treats Next route directories literally in configuration patterns", () => {
    expect(literalGlob("apps/web/src/app/api/chats/[chatId]/sim-routing.int.test.ts")).toBe(
      "apps/web/src/app/api/chats/\\[chatId\\]/sim-routing.int.test.ts",
    );
    expect(literalGlob("apps/web/src/app/(site)/@modal/x.int.test.ts")).toBe("apps/web/src/app/\\(site\\)/@modal/x.int.test.ts");
    expect(integrationSelectionForMode("legacy", [legacy("apps/web/src/app/api/chats/[chatId]/sim-routing.int.test.ts")]).include).toEqual([
      "apps/web/src/app/api/chats/\\[chatId\\]/sim-routing.int.test.ts",
    ]);
  });
});

describe("legacy exception validation", () => {
  it("accepts exact application integration files with reasons", () => {
    expect(validateLegacyExceptions([legacy("apps/web/src/server/engine/simulation/space-store.int.test.ts")])).toEqual([]);
  });

  it.each<[string, { file: unknown; reason: unknown }[], RegExp]>([
    ["a duplicate", [legacy("apps/web/src/a.int.test.ts"), legacy("apps/web/src/a.int.test.ts")], /duplicate legacy exception/],
    ["a glob", [legacy("apps/web/src/server/engine/simulation/*.int.test.ts")], /one exact file/],
    ["a directory", [legacy("apps/web/src/server/engine/simulation/")], /one exact file/],
    ["a pure unit test", [legacy("apps/web/src/server/api/quota.test.ts")], /not an application integration suite/],
    ["a package-owned file", [legacy("packages/simulation-core/src/a.int.test.ts")], /not an application integration suite/],
    ["a parent escape", [legacy("apps/web/src/../x.int.test.ts")], /plain repo-relative path/],
    ["an absolute path", [legacy("/apps/web/src/a.int.test.ts")], /plain repo-relative path/],
    ["a missing reason", [{ file: "apps/web/src/a.int.test.ts", reason: "" }], /needs a reason/],
    ["a missing file", [{ file: undefined, reason: REASON }], /has no file/],
  ])("rejects %s", (_label, exceptions, problem) => {
    expect(validateLegacyExceptions(exceptions).join("\n")).toMatch(problem);
  });
});

describe("universe and partition", () => {
  it("reconciles tracked files and ignores package-owned and pure tests", () => {
    expect(reconcileTrackedIntegrationFiles(TRACKED)).toEqual({
      universe: [
        "apps/web/src/app/api/chats/[chatId]/sim-routing.int.test.ts",
        "apps/web/src/server/api/authz-matrix.int.test.ts",
        "apps/web/src/server/engine/simulation/space-store.int.test.ts",
        "scripts/trial/romantic-contact/driver.int.test.ts",
      ],
      misplaced: [],
    });
  });

  it("flags an integration-looking file that the application gate would never run", () => {
    const { misplaced } = reconcileTrackedIntegrationFiles([
      "apps/web/src/server/api/x.int.test.tsx",
      "apps/web/src/server/api/y.int.spec.ts",
      "apps/web/test/z.int.test.ts",
      "packages/image-core/src/w.int.test.ts",
    ]);
    expect(misplaced).toEqual(["apps/web/src/server/api/x.int.test.tsx", "apps/web/src/server/api/y.int.spec.ts", "apps/web/test/z.int.test.ts"]);
  });

  it("admits a newly added ordinary suite under either root to strict mode without editing a list", () => {
    const census = integrationCensus(
      [...TRACKED, "apps/web/src/server/brand-new/feature.int.test.ts", "scripts/brand-new.int.test.ts"],
      [legacy("apps/web/src/server/engine/simulation/space-store.int.test.ts")],
    );
    expect(census.problems).toEqual([]);
    expect(census.strict).toContain("apps/web/src/server/brand-new/feature.int.test.ts");
    expect(census.strict).toContain("scripts/brand-new.int.test.ts");
    expect(census.legacy).toEqual(["apps/web/src/server/engine/simulation/space-store.int.test.ts"]);
  });

  it("keeps strict and legacy disjoint and complete", () => {
    const universe = reconcileTrackedIntegrationFiles(TRACKED).universe;
    const { strict, legacy: legacyFiles, problems } = partitionIntegrationInventory(universe, [
      legacy("apps/web/src/server/engine/simulation/space-store.int.test.ts"),
    ]);
    expect(problems).toEqual([]);
    expect(strict.filter((file) => legacyFiles.includes(file))).toEqual([]);
    expect([...strict, ...legacyFiles].sort()).toEqual(universe);
  });

  it("reports a stale exception and an empty universe", () => {
    expect(partitionIntegrationInventory([], [legacy("apps/web/src/gone.int.test.ts")]).problems).toEqual([
      "the application integration universe is empty",
      "stale legacy exception (no such integration suite): apps/web/src/gone.int.test.ts",
    ]);
  });

  it("hashes the policy by its exception set, not by list order", () => {
    const a = legacy("apps/web/src/a.int.test.ts");
    const b = legacy("apps/web/src/b.int.test.ts");
    expect(policyHash([a, b])).toBe(policyHash([b, a]));
    expect(policyHash([a])).not.toBe(policyHash([a, b]));
  });
});

describe("the checked-in policy against this checkout", () => {
  const root = process.cwd();
  const census = integrationCensus(trackedFiles(root));

  it("reconciles every tracked application integration suite with no problems", () => {
    expect(census.problems).toEqual([]);
    expect(census.universe.length).toBeGreaterThan(0);
    expect(census.legacy.length).toBe(LEGACY_INTEGRATION_EXCEPTIONS.length);
  });

  it("lists exactly the suites that declare the legacy synthetic-player opt-in", () => {
    // Code lines only: a comment that mentions the option is not a declaration.
    const declares = (file: string) =>
      readFileSync(path.join(root, file), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .some((line) => !/^(\/\/|\/\*|\*)/.test(line) && /\blegacyPlayerMode:\s*true\b/.test(line));
    expect(census.legacy.filter((file) => !declares(file))).toEqual([]);
    expect(census.strict.filter(declares)).toEqual([]);
  });

  it("names the capability and mode variables the same way in every owner", () => {
    expect(LEGACY_CAPABILITY_ENV).toBe(LEGACY_ENGINE_TEST_PLAYER_ENV);
    expect(INTEGRATION_LEGACY_CAPABILITY_ENV).toBe(LEGACY_ENGINE_TEST_PLAYER_ENV);
    expect(WORKER_MODE_ENV).toBe(INTEGRATION_MODE_ENV);
  });
});
