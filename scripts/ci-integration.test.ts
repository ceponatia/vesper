import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCLI } from "vitest/node";
import { describe, expect, it } from "vitest";
import {
  buildChildEnv,
  buildVitestArgs,
  checkPlan,
  databaseTarget,
  describeEnvironment,
  parseLauncherArgs,
  parseShard,
} from "./ci-integration.mjs";

/**
 * The CI integration launcher (#638): inputs, database target, the Vitest
 * argument array, the child environment, and the plan cross-check. Execution
 * itself is proven by CI's evidence verifier, not here.
 */

const ROOT = process.cwd();

describe("launcher arguments", () => {
  it("accepts a CI mode and shard", () => {
    expect(parseLauncherArgs(["--mode=strict", "--shard=2/2"])).toEqual({
      mode: "strict",
      shard: { index: 2, count: 2 },
      out: "integration-evidence",
    });
    expect(parseLauncherArgs(["--mode=legacy"]).shard).toEqual({ index: 1, count: 1 });
  });

  it.each<[string, string[], RegExp]>([
    ["the unpartitioned all mode", ["--mode=all", "--shard=1/2"], /--mode must be one of strict, legacy/],
    ["a missing mode", ["--shard=1/2"], /--mode must be one of/],
    ["an unknown option", ["--mode=strict", "--exclude=apps/web/src/x.int.test.ts"], /Unknown option/],
    ["a narrowing filter", ["--mode=strict", "apps/web/src/server/api"], /Unexpected argument/],
    ["an absolute evidence directory", ["--mode=strict", "--out=/tmp/evidence"], /relative directory/],
    ["an escaping evidence directory", ["--mode=strict", "--out=../evidence"], /relative directory/],
  ])("rejects %s", (_label, argv, message) => {
    expect(() => parseLauncherArgs(argv)).toThrow(message);
  });

  it.each([["0/2"], ["3/2"], ["1-2"], ["1/17"], [""], ["1/2/3"]])("rejects the shard %j", (text) => {
    expect(() => parseShard(text)).toThrow(/--shard/);
  });
});

describe("database target", () => {
  it("names a mode database on the local compose server without recording credentials", () => {
    const target = databaseTarget("postgresql://vesper:secret@localhost:5435", "vesper_ci_strict");
    expect(target).toEqual({
      adminUrl: "postgresql://vesper:secret@localhost:5435/postgres",
      url: "postgresql://vesper:secret@localhost:5435/vesper_ci_strict",
      name: "vesper_ci_strict",
      host: "localhost:5435",
    });
  });

  it.each<[string, string, string, RegExp]>([
    ["a remote host", "postgresql://u:p@db.example.neon.tech", "vesper_ci_strict", /non-local/],
    ["a URL that already names a database", "postgresql://u:p@localhost:5435/vesper_dev", "vesper_ci_strict", /must not name a database/],
    ["a database outside vesper_ci_*", "postgresql://u:p@localhost:5435", "vesper_dev", /outside vesper_ci_/],
    ["a non-postgres URL", "mysql://u:p@localhost:3306", "vesper_ci_strict", /postgres URL/],
    ["garbage", "not a url", "vesper_ci_strict", /not a valid URL/],
  ])("refuses %s", (_label, server, name, message) => {
    expect(() => databaseTarget(server, name)).toThrow(message);
  });
});

describe("Vitest invocation", () => {
  const args = buildVitestArgs({ shard: { index: 1, count: 2 }, reportFile: "/tmp/report.json", passWithNoTests: false });

  it("passes the project and shard as options, with no separator and no filter", () => {
    expect(args).not.toContain("--");
    expect(args.slice(0, 3)).toEqual(["exec", "vitest", "run"]);
    const { filter, options } = parseCLI(["vitest", ...args.slice(2)]);
    expect(filter).toEqual([]);
    expect([options.project ?? []].flat()).toEqual(["app-int"]);
    expect(options.shard).toBe("1/2");
    expect(options.fileParallelism).toBe(false);
    expect(options.passWithNoTests).toBeUndefined();
  });

  it("demonstrates the #638 defect: after a -- separator the options never reach the parser", () => {
    const broken = ["vitest", "run", "--no-file-parallelism", "apps/web/src/server/engine/simulation", "--", "--project=app-int", "--shard=1/2"];
    const { options } = parseCLI(broken);
    expect([options.project ?? []].flat()).toEqual([]);
    expect(options.shard).toBeUndefined();
  });

  it("allows an empty shard only when the whole mode is smaller than the shard count", () => {
    expect(buildVitestArgs({ shard: { index: 2, count: 2 }, reportFile: "r.json", passWithNoTests: true })).toContain("--passWithNoTests");
  });

  it("keeps the curated engine command inside the integration project", () => {
    const scripts = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    const engine = scripts["test:engine"];
    expect(engine).toMatch(/^vitest run --project=app-int --no-file-parallelism /);
    expect(engine).not.toMatch(/\s--\s/);
  });

  it("runs both modes from the workflow with one shard count everywhere and no separator", () => {
    const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).not.toMatch(/test:engine\s+--\s/);
    expect(workflow).toContain("name: integration (${{ matrix.shard }}/2)");
    expect(workflow).toContain("shard: [1, 2]");
    expect(workflow).toContain("INTEGRATION_SHARDS: 2");
    expect(workflow).toContain("node scripts/ci-integration.mjs --mode=strict --shard=${{ matrix.shard }}/${{ env.INTEGRATION_SHARDS }}");
    expect(workflow).toContain("node scripts/ci-integration.mjs --mode=legacy --shard=${{ matrix.shard }}/${{ env.INTEGRATION_SHARDS }}");
    expect(workflow).toContain("node scripts/verify-integration-results.mjs --evidence=integration-evidence --shards=2");
    expect(workflow).not.toMatch(/VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER/);
  });
});

describe("child environment", () => {
  const base = {
    PATH: "/usr/bin",
    VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER: "1",
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://someone@prod.example/vesper",
  };

  it("strips an inherited legacy capability from a strict child", () => {
    const env = buildChildEnv(base, { mode: "strict", databaseUrl: "postgresql://u:p@localhost:5435/vesper_ci_strict" });
    expect(env).not.toHaveProperty("VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER");
    expect(env).not.toHaveProperty("NODE_ENV");
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      VESPER_INTEGRATION_MODE: "strict",
      REQUIRE_INTEGRATION_DB: "true",
      DATABASE_URL: "postgresql://u:p@localhost:5435/vesper_ci_strict",
    });
    expect(describeEnvironment(env)).toEqual({ integrationMode: "strict", legacyCapability: "absent", requireIntegrationDb: true });
  });

  it("grants the capability only to a legacy child", () => {
    const env = buildChildEnv({ PATH: "/usr/bin" }, { mode: "legacy", databaseUrl: "postgresql://u:p@localhost:5435/vesper_ci_legacy" });
    expect(env).toMatchObject({ VESPER_INTEGRATION_MODE: "legacy", VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER: "1" });
    expect(describeEnvironment(env).legacyCapability).toBe("enabled");
  });

  it("never mutates the parent environment", () => {
    const parent = { ...base };
    buildChildEnv(parent, { mode: "strict", databaseUrl: "postgresql://u:p@localhost:5435/vesper_ci_strict" });
    expect(parent).toEqual(base);
  });
});

describe("plan cross-check", () => {
  const census = {
    universe: ["apps/web/src/a.int.test.ts", "apps/web/src/b.int.test.ts", "scripts/c.int.test.ts"],
    strict: ["apps/web/src/a.int.test.ts", "scripts/c.int.test.ts"],
    legacy: ["apps/web/src/b.int.test.ts"],
  };
  const universePlan = { mode: "all" as const, files: census.universe, shardFiles: census.universe };
  const shard = { index: 1, count: 2 };

  it("accepts a plan that agrees with the census", () => {
    const modePlan = { mode: "strict" as const, files: census.strict, shardFiles: ["scripts/c.int.test.ts"] };
    expect(checkPlan({ mode: "strict", census, universePlan, modePlan, shard })).toEqual([]);
  });

  it.each<[string, { universe?: string[]; files?: string[]; shardFiles?: string[]; mode?: "strict" | "legacy" | "all" }, RegExp]>([
    ["an undiscovered tracked suite", { universe: ["apps/web/src/a.int.test.ts", "scripts/c.int.test.ts"] }, /not discovered by Vitest: apps\/web\/src\/b/],
    ["an untracked discovered file", { universe: [...census.universe, "apps/web/src/stray.int.test.ts"] }, /untracked or unexpected integration file/],
    ["a legacy file in the strict inventory", { files: [...census.strict, "apps/web/src/b.int.test.ts"] }, /strict inventory wrongly contains apps\/web\/src\/b/],
    ["a strict file left out", { files: ["scripts/c.int.test.ts"] }, /strict inventory is missing apps\/web\/src\/a/],
    ["a shard file outside the inventory", { shardFiles: ["apps/web/src/b.int.test.ts"] }, /outside the strict inventory/],
    ["a duplicated plan entry", { shardFiles: ["scripts/c.int.test.ts", "scripts/c.int.test.ts"] }, /more than once/],
    ["a plan made in the wrong mode", { mode: "legacy" }, /the plan ran in mode legacy/],
  ])("rejects %s", (_label, change, problem) => {
    const modePlan = {
      mode: change.mode ?? ("strict" as const),
      files: change.files ?? census.strict,
      shardFiles: change.shardFiles ?? ["scripts/c.int.test.ts"],
    };
    const universe = { ...universePlan, files: change.universe ?? census.universe };
    expect(checkPlan({ mode: "strict", census, universePlan: universe, modePlan, shard }).join("\n")).toMatch(problem);
  });
});
