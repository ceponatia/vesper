import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BoundaryRule,
  type BoundaryViolation,
  type WorkspacePolicy,
  VESPER_WORKSPACE_POLICY,
  checkWorkspaceImports,
  listWorkspacePackages,
} from "./check-workspace-imports";

/**
 * The boundary checker's own regression suite.
 *
 * Every case builds a throwaway repository rather than asserting against this
 * one. Running the checker over production source only proves that today's
 * source happens to be clean — it proves nothing about the SEMANTICS, and a
 * checker that silently stopped catching escapes would still report OK. These
 * fixtures assert the rules directly: each violating tree must fail with a
 * specific rule, and the legal trees must come back completely empty.
 */

const POLICY: WorkspacePolicy = {
  scope: "@vesper",
  applicationAlias: "@/",
  applicationWorkspaces: ["@vesper/web"],
  layers: { "@vesper/foundation": 10, "@vesper/core": 20, "@vesper/corex": 20, "@vesper/transport": 30 },
  applicationLayer: 100,
  runtimes: {
    "@vesper/foundation": "universal",
    "@vesper/core": "universal",
    "@vesper/corex": "universal",
    "@vesper/transport": "server",
  },
  serverOnlyModules: ["next"],
  singleRuntimeGlobals: ["process", "Buffer", "document", "window"],
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * A legal repository: an app, two packages, one internal relative import, one
 * root package import. Every case below starts here and breaks exactly one
 * thing, so a failure names the rule under test rather than fixture drift.
 */
const BASE: Record<string, string> = {
  "pnpm-workspace.yaml": 'packages:\n  - "."\n  - "packages/*"\n',
  "package.json": json({
    name: "app",
    dependencies: { "@vesper/core": "workspace:*", zod: "^4.4.3" },
    devDependencies: { vitest: "^4.1.8" },
  }),
  "src/app.ts": 'import { thing } from "@vesper/core";\n\nexport const used = thing;\n',
  "src/app.test.ts": 'import { expect } from "vitest";\n\nexport const check = expect;\n',
  "packages/core/package.json": json({
    name: "@vesper/core",
    exports: { ".": "./src/index.ts", "./package.json": "./package.json" },
    dependencies: { zod: "^4.4.3" },
    devDependencies: { vitest: "^4.1.8" },
  }),
  "packages/core/src/index.ts": 'export { thing } from "./thing";\n',
  "packages/core/src/thing.ts": 'import { z } from "zod";\n\nexport const thing = z.string();\n',
  "packages/core/src/thing.test.ts": 'import { expect } from "vitest";\n\nexport const check = expect;\n',
  "packages/foundation/package.json": json({ name: "@vesper/foundation", exports: { ".": "./src/index.ts" } }),
  "packages/foundation/src/index.ts": "export const base = 1;\n",
};

const roots: string[] = [];

function tree(overrides: Record<string, string> = {}, removals: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "vesper-boundary-"));
  roots.push(root);
  const files = { ...BASE, ...overrides };
  for (const path of removals) delete files[path];
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

function check(overrides: Record<string, string> = {}, removals: readonly string[] = []): BoundaryViolation[] {
  return checkWorkspaceImports(tree(overrides, removals), POLICY);
}

function rules(violations: readonly BoundaryViolation[]): BoundaryRule[] {
  return violations.map((violation) => violation.rule);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace import integrity", () => {
  it("accepts a repository whose workspaces talk only through public APIs", () => {
    expect(check()).toEqual([]);
  });

  it("rejects a package reaching into the application by alias", () => {
    const violations = check({ "packages/core/src/thing.ts": 'import { db } from "@/server/db";\n\nexport const thing = db;\n' });
    expect(rules(violations)).toEqual(["package-application-alias"]);
  });

  it("rejects a package escaping to the application by relative path", () => {
    const violations = check({
      "packages/core/src/thing.ts": 'import { used } from "../../../src/app";\n\nexport const thing = used;\n',
    });
    expect(rules(violations)).toEqual(["cross-workspace-path"]);
  });

  it("rejects a sibling-package escape whose spelling never contains 'packages'", () => {
    const violations = check({
      "packages/core/src/thing.ts": 'import { base } from "../../foundation/src/index";\n\nexport const thing = base;\n',
    });
    expect(rules(violations)).toEqual(["cross-workspace-path"]);
    expect(violations[0]?.specifier).toBe("../../foundation/src/index");
  });

  it("rejects the application reaching into package internals by relative path", () => {
    const violations = check({
      "src/app.ts": 'import { thing } from "../packages/core/src/thing";\n\nexport const used = thing;\n',
    });
    expect(rules(violations)).toEqual(["cross-workspace-path"]);
  });

  it("rejects a relative path that resolves to nothing", () => {
    // The shape a directory move leaves behind: the path still points inside
    // its own workspace, so no boundary rule fires, and without this the break
    // surfaces only in typecheck.
    expect(
      rules(check({ "src/app.ts": 'import { gone } from "./moved/away";\n\nexport const used = gone;\n' })),
    ).toEqual(["unresolved-relative-path"]);
  });

  it("accepts the shapes a bundler resolves: extensionless, index, assets, query suffixes", () => {
    expect(
      check({
        "src/app.ts":
          'import "./styles.css?inline";\nimport { one } from "./folder";\nimport { two } from "./sibling.js";\n\nexport const used = [one, two];\n',
        "src/styles.css": ".a{}\n",
        "src/folder/index.ts": "export const one = 1;\n",
        "src/sibling.ts": "export const two = 2;\n",
      }),
    ).toEqual([]);
  });

  it("rejects an escape laundered through a symlink that points out of the package", () => {
    const root = tree({ "packages/core/src/thing.ts": 'import { used } from "./outside/app";\n\nexport const thing = used;\n' });
    symlinkSync(join(root, "src"), join(root, "packages/core/src/outside"));
    expect(rules(checkWorkspaceImports(root, POLICY))).toEqual(["cross-workspace-path"]);
  });

  it("does not treat a package as the parent of a same-prefixed sibling", () => {
    const prefixTrap = {
      "packages/corex/package.json": json({
        name: "@vesper/corex",
        exports: { ".": "./src/index.ts" },
        dependencies: { "@vesper/foundation": "workspace:*" },
      }),
      "packages/corex/src/index.ts": 'export const extra = 1;\n',
    };
    // `packages/core` must not contain `packages/corex`, so corex's own files are
    // legal and a corex -> core relative path is still an escape.
    expect(check(prefixTrap)).toEqual([]);
    const violations = check({
      ...prefixTrap,
      "packages/corex/src/index.ts": 'import { thing } from "../../core/src/thing";\n\nexport const extra = thing;\n',
    });
    expect(rules(violations)).toEqual(["cross-workspace-path"]);
  });

  it("rejects package code subpaths even when a bundler could resolve them", () => {
    for (const specifier of ["@vesper/core/internal", "@vesper/core/src/thing"]) {
      const violations = check({ "src/app.ts": `import { thing } from "${specifier}";\n\nexport const used = thing;\n` });
      expect(rules(violations)).toEqual(["package-code-subpath"]);
    }
  });

  it("rejects an undeclared workspace dependency", () => {
    const violations = check({
      "packages/core/src/thing.ts": 'import { base } from "@vesper/foundation";\n\nexport const thing = base;\n',
    });
    expect(rules(violations)).toEqual(["undeclared-dependency"]);
  });

  it("rejects a workspace dependency that runtime source has only in devDependencies", () => {
    const violations = check({
      "package.json": json({
        name: "app",
        dependencies: { zod: "^4.4.3" },
        devDependencies: { "@vesper/core": "workspace:*", vitest: "^4.1.8" },
      }),
    });
    expect(rules(violations)).toEqual(["runtime-dependency-in-dev"]);
  });

  it("rejects an undeclared third-party dependency", () => {
    const violations = check({
      "packages/core/src/thing.ts": 'import { sharp } from "sharp";\n\nexport const thing = sharp;\n',
    });
    expect(rules(violations)).toEqual(["undeclared-dependency"]);
  });

  it("accepts a test-only third-party dependency declared in devDependencies", () => {
    expect(check({ "packages/core/src/thing.test.ts": 'import { it } from "vitest";\n\nexport const check = it;\n' })).toEqual([]);
  });

  it("inspects type imports and re-exports, not just value imports", () => {
    expect(rules(check({ "src/app.ts": 'export type { Thing } from "../packages/core/src/thing";\n' }))).toEqual([
      "cross-workspace-path",
    ]);
    expect(rules(check({ "src/app.ts": 'export * from "../packages/core/src/thing";\n' }))).toEqual(["cross-workspace-path"]);
    expect(rules(check({ "src/app.ts": 'import type { Thing } from "@vesper/core/src/thing";\n' }))).toEqual([
      "package-code-subpath",
    ]);
    expect(rules(check({ "src/app.ts": "export type Used = import(\"../packages/core/src/thing\").Thing;\n" }))).toEqual([
      "cross-workspace-path",
    ]);
  });

  it("inspects a dynamic import with a literal specifier", () => {
    const violations = check({
      "src/app.ts": 'export const load = async () => import("../packages/core/src/thing");\n',
    });
    expect(rules(violations)).toEqual(["cross-workspace-path"]);
  });

  it("rejects a computed dynamic import inside a package", () => {
    const violations = check({
      "packages/core/src/thing.ts": "export const load = async (name: string) => import(name);\n",
    });
    expect(rules(violations)).toEqual(["package-dynamic-import"]);
  });

  it("rejects a wildcard export in a package root barrel but allows one internally", () => {
    expect(rules(check({ "packages/core/src/index.ts": 'export * from "./thing";\n' }))).toEqual(["published-entry-wildcard"]);
    expect(
      check({
        "packages/core/src/index.ts": 'export { thing } from "./domain";\n',
        "packages/core/src/domain/index.ts": 'export * from "./thing";\n',
        "packages/core/src/domain/thing.ts": "export const thing = 1;\n",
      }, ["packages/core/src/thing.ts", "packages/core/src/thing.test.ts"]),
    ).toEqual([]);
  });

  it("rejects an import that runs against the layer direction", () => {
    const violations = check({
      "packages/foundation/package.json": json({
        name: "@vesper/foundation",
        exports: { ".": "./src/index.ts" },
        dependencies: { "@vesper/core": "workspace:*" },
      }),
      "packages/foundation/src/index.ts": 'import { thing } from "@vesper/core";\n\nexport const base = thing;\n',
    });
    expect(rules(violations)).toContain("package-layer-direction");
  });

  it("rejects a package the layer policy does not rank", () => {
    const violations = check({
      "packages/mystery/package.json": json({ name: "@vesper/mystery", exports: { ".": "./src/index.ts" } }),
      "packages/mystery/src/index.ts": "export const mystery = 1;\n",
    });
    expect(rules(violations)).toEqual(["package-layer-unknown"]);
    expect(violations[0]?.file).toBe("packages/mystery/package.json");
  });

  it("rejects a cycle declared purely in manifests", () => {
    const violations = check({
      "packages/core/package.json": json({
        name: "@vesper/core",
        exports: { ".": "./src/index.ts" },
        dependencies: { zod: "^4.4.3", "@vesper/foundation": "workspace:*" },
        devDependencies: { vitest: "^4.1.8" },
      }),
      "packages/foundation/package.json": json({
        name: "@vesper/foundation",
        exports: { ".": "./src/index.ts" },
        dependencies: { "@vesper/core": "workspace:*" },
      }),
    });
    expect(rules(violations)).toContain("package-graph-cycle");
  });

  it("rejects a package that imports itself by name", () => {
    const violations = check({
      "packages/core/src/thing.ts": 'import { other } from "@vesper/core";\n\nexport const thing = other;\n',
    });
    expect(rules(violations)).toEqual(["workspace-self-import"]);
  });

  it("rejects an import of a package with no public entry point", () => {
    const violations = check({
      "package.json": json({
        name: "app",
        dependencies: { "@vesper/foundation": "workspace:*", zod: "^4.4.3" },
        devDependencies: { vitest: "^4.1.8" },
      }),
      "src/app.ts": 'import { base } from "@vesper/foundation";\n\nexport const used = base;\n',
      "packages/foundation/package.json": json({ name: "@vesper/foundation" }),
    });
    expect(rules(violations)).toEqual(["package-missing-root-export"]);
  });

  it("keeps a universal package out of the Node-only and server-only graph", () => {
    expect(
      rules(
        check({
          "packages/core/src/thing.ts": 'import { createHash } from "node:crypto";\n\nexport const thing = createHash;\n',
        }),
      ),
    ).toEqual(["universal-runtime-dependency"]);

    const serverOnly = check({
      "package.json": json({
        name: "app",
        dependencies: { "@vesper/core": "workspace:*", zod: "^4.4.3" },
        devDependencies: { vitest: "^4.1.8" },
      }),
      "packages/core/package.json": json({
        name: "@vesper/core",
        exports: { ".": "./src/index.ts" },
        dependencies: { zod: "^4.4.3", next: "^16.3.0" },
        devDependencies: { vitest: "^4.1.8" },
      }),
      "packages/core/src/thing.ts": 'import { NextResponse } from "next/server";\n\nexport const thing = NextResponse;\n',
    });
    expect(rules(serverOnly)).toEqual(["universal-runtime-dependency"]);
  });

  it("lets a universal package name a platform type but not evaluate one", () => {
    expect(check({ "packages/core/src/thing.ts": "export interface Thing { bytes?: Buffer }\n" })).toEqual([]);
    expect(rules(check({ "packages/core/src/thing.ts": 'export const thing = Buffer.from("x");\n' }))).toEqual([
      "universal-runtime-global",
    ]);
    expect(rules(check({ "packages/core/src/thing.ts": "export const thing = process.env.MODE;\n" }))).toEqual([
      "universal-runtime-global",
    ]);
    expect(rules(check({ "packages/core/src/thing.ts": "export const thing = () => document.title;\n" }))).toEqual([
      "universal-runtime-global",
    ]);
    // A property named after a global, and a test file, are both fine.
    expect(check({ "packages/core/src/thing.ts": "export const thing = { process: 1 }.process;\n" })).toEqual([]);
    expect(check({ "packages/core/src/thing.test.ts": 'export const dir = process.cwd();\n' })).toEqual([]);
  });

  it("does not mistake a local named after a global for the global", () => {
    // A domain word that collides with a single-runtime global — `window` is an
    // ordinary noun in scheduling code. A parameter, a destructured binding, an
    // import and a hoisted declaration all shadow the global.
    expect(
      check({
        "packages/core/src/thing.ts": [
          'import { window } from "./vocabulary";',
          "",
          "export function opens(window: { start: number }): number {",
          "  return window.start;",
          "}",
          "",
          "export function closes({ document }: { document: { end: number } }): number {",
          "  return document.end;",
          "}",
          "",
          "export const late = (): number => process();",
          "",
          "function process(): number {",
          "  return window.start;",
          "}",
          "",
          "export const other = window;",
          "",
        ].join("\n"),
        "packages/core/src/vocabulary.ts": "export const window = { start: 0 };\n",
      }),
    ).toEqual([]);
    // Shadowing inside one function does not license the real global elsewhere.
    expect(
      rules(
        check({
          "packages/core/src/thing.ts":
            "export function inner(window: number): number {\n  return window;\n}\n\nexport const outer = window.name;\n",
        }),
      ),
    ).toEqual(["universal-runtime-global"]);
  });

  it("allows the application to use Node built-ins and its own alias", () => {
    expect(
      check({
        "src/app.ts": 'import { createHash } from "node:crypto";\nimport { thing } from "@/lib/thing";\n\nexport const used = [createHash, thing];\n',
        "src/lib/thing.ts": "export const thing = 1;\n",
      }),
    ).toEqual([]);
  });

  it("lists the workspace packages a consumer may import by name", () => {
    const root = tree();
    expect(listWorkspacePackages(root, POLICY).map((pkg) => pkg.name)).toEqual(["@vesper/core", "@vesper/foundation"]);
  });
});

/**
 * Declared subpath exports.
 *
 * What makes `@vesper/core/thing` public is the MANIFEST declaring `"./thing"`.
 * A file existing at that path is not the question and never was — that is the
 * filesystem import the whole boundary exists to reject — so these cases pin
 * both halves: an exact declared entry is ordinary public API, and everything
 * around it (undeclared subpaths, wildcards, dead targets, metadata) still
 * fails.
 */
describe("declared subpath exports", () => {
  /** The BASE core package with a different `exports` map. */
  function coreManifest(exportsMap: Record<string, unknown>): Record<string, string> {
    return {
      "packages/core/package.json": json({
        name: "@vesper/core",
        exports: exportsMap,
        dependencies: { zod: "^4.4.3" },
        devDependencies: { vitest: "^4.1.8" },
      }),
    };
  }

  const SUBPATH = coreManifest({ ".": "./src/index.ts", "./thing": "./src/thing.ts", "./package.json": "./package.json" });

  it("accepts an import of a declared subpath", () => {
    expect(
      check({ ...SUBPATH, "src/app.ts": 'import { thing } from "@vesper/core/thing";\n\nexport const used = thing;\n' }),
    ).toEqual([]);
  });

  it("reads an entry declared through import/default conditions", () => {
    expect(
      check({
        ...coreManifest({
          ".": { import: "./src/index.ts" },
          "./thing": { types: "./src/thing.ts", default: "./src/thing.ts" },
        }),
        "src/app.ts": 'import { thing } from "@vesper/core/thing";\n\nexport const used = thing;\n',
      }),
    ).toEqual([]);
  });

  it("puts a subpath edge through the layer rules like any other package edge", () => {
    // The proof that a legal subpath import still RECORDS its package edge: the
    // checker used to bail out of this branch before the rank comparison, so a
    // subpath would have been the one import shape that escaped the layers.
    const violations = check({
      ...SUBPATH,
      "packages/foundation/package.json": json({
        name: "@vesper/foundation",
        exports: { ".": "./src/index.ts" },
        dependencies: { "@vesper/core": "workspace:*" },
      }),
      "packages/foundation/src/index.ts": 'import { thing } from "@vesper/core/thing";\n\nexport const base = thing;\n',
    });
    expect(rules(violations)).toContain("package-layer-direction");
    expect(rules(violations)).not.toContain("package-code-subpath");
  });

  it("still demands dependency ownership for a subpath import", () => {
    const violations = check({
      "packages/foundation/package.json": json({
        name: "@vesper/foundation",
        exports: { ".": "./src/index.ts", "./base": "./src/base.ts" },
      }),
      "packages/foundation/src/base.ts": "export const base = 1;\n",
      "packages/core/src/thing.ts": 'import { base } from "@vesper/foundation/base";\n\nexport const thing = base;\n',
    });
    expect(rules(violations)).toEqual(["undeclared-dependency"]);
  });

  it("rejects a subpath the package does not declare", () => {
    const violations = check({
      ...SUBPATH,
      "src/app.ts": 'import { other } from "@vesper/core/internal";\n\nexport const used = other;\n',
    });
    expect(rules(violations)).toEqual(["package-code-subpath"]);
    expect(violations[0]?.message).toContain("not a declared export");
  });

  it("never treats ./package.json as a code entry", () => {
    const violations = check({
      ...SUBPATH,
      "src/app.ts": 'import meta from "@vesper/core/package.json";\n\nexport const used = meta;\n',
    });
    expect(rules(violations)).toEqual(["package-code-subpath"]);
  });

  it("rejects a wildcard in an exports key or in an entry target", () => {
    const wildcardKey = check(coreManifest({ ".": "./src/index.ts", "./*": "./src/*.ts" }));
    expect(rules(wildcardKey)).toEqual(["package-wildcard-export"]);
    expect(wildcardKey[0]?.file).toBe("packages/core/package.json");

    const wildcardTarget = check(coreManifest({ ".": "./src/index.ts", "./thing": "./src/*.ts" }));
    expect(rules(wildcardTarget)).toEqual(["package-wildcard-export"]);
  });

  it("rejects a declared entry whose target does not exist", () => {
    const violations = check(coreManifest({ ".": "./src/index.ts", "./gone": "./src/gone.ts" }));
    expect(rules(violations)).toEqual(["package-export-unresolved"]);
    expect(violations[0]?.file).toBe("packages/core/package.json");
  });

  it("holds every published entry to named exports, not only the root", () => {
    const violations = check({
      ...coreManifest({ ".": "./src/index.ts", "./domain": "./src/domain/index.ts" }),
      "packages/core/src/domain/index.ts": 'export * from "./helper";\n',
      "packages/core/src/domain/helper.ts": "export const helper = 1;\n",
    });
    expect(rules(violations)).toEqual(["published-entry-wildcard"]);
    expect(violations[0]?.file).toBe("packages/core/src/domain/index.ts");
  });

  it("lets a package publish subpaths without publishing a root export", () => {
    const noRoot = coreManifest({ "./thing": "./src/thing.ts" });
    // BASE's application imports the package by bare name, which is now nothing.
    expect(rules(check(noRoot))).toEqual(["package-missing-root-export"]);
    expect(
      check({ ...noRoot, "src/app.ts": 'import { thing } from "@vesper/core/thing";\n\nexport const used = thing;\n' }),
    ).toEqual([]);
  });

  it("rejects a subpath self-import", () => {
    const violations = check({
      ...SUBPATH,
      "packages/core/src/thing.ts": 'import { self } from "@vesper/core/thing";\n\nexport const thing = self;\n',
    });
    expect(rules(violations)).toEqual(["workspace-self-import"]);
  });

  it("reports every declared entry, so the resolution check smoke-imports them all", () => {
    const core = listWorkspacePackages(tree(SUBPATH), POLICY).find((pkg) => pkg.name === "@vesper/core");
    expect(core?.entries).toEqual([
      { key: ".", subpath: "", target: "./src/index.ts" },
      { key: "./thing", subpath: "/thing", target: "./src/thing.ts" },
    ]);
  });
});

/**
 * A non-root APPLICATION workspace — `apps/web` after the slice 6 move. It
 * carries the `@vesper` scope like every package, so nothing but the policy's
 * `applicationWorkspaces` list distinguishes them, and getting that wrong is
 * silent in both directions: judged as a package it would fail on every `@/`
 * import it has, and judged as an application a real package would escape the
 * layer and runtime rules entirely.
 */
describe("a non-root application workspace", () => {
  const APP: Record<string, string> = {
    "pnpm-workspace.yaml": 'packages:\n  - "."\n  - "apps/*"\n  - "packages/*"\n',
    "package.json": json({ name: "root", devDependencies: { vitest: "^4.1.8" } }),
    "apps/web/package.json": json({
      name: "@vesper/web",
      dependencies: { "@vesper/core": "workspace:*", zod: "^4.4.3" },
      devDependencies: { vitest: "^4.1.8" },
    }),
    "apps/web/src/app.ts":
      'import { createHash } from "node:crypto";\nimport { thing } from "@vesper/core";\nimport { local } from "@/lib/local";\n\nexport const used = [createHash, thing, local];\n',
    "apps/web/src/lib/local.ts": "export const local = 1;\n",
  };

  it("may use its own alias, Node built-ins and the packages it declares", () => {
    expect(checkWorkspaceImports(tree(APP, ["src/app.ts", "src/app.test.ts"]), POLICY)).toEqual([]);
  });

  it("is still held to dependency ownership and package entry points", () => {
    const violations = checkWorkspaceImports(
      tree(
        {
          ...APP,
          "apps/web/package.json": json({ name: "@vesper/web", devDependencies: { vitest: "^4.1.8" } }),
          "apps/web/src/app.ts": 'import { thing } from "@vesper/core/src/thing";\n\nexport const used = thing;\n',
        },
        ["src/app.ts", "src/app.test.ts"],
      ),
      POLICY,
    );
    expect(rules(violations)).toEqual(["package-code-subpath"]);
  });

  it("may not be reached from a package, in either spelling", () => {
    const alias = checkWorkspaceImports(
      tree(
        { ...APP, "packages/core/src/thing.ts": 'import { local } from "@/lib/local";\n\nexport const thing = local;\n' },
        ["src/app.ts", "src/app.test.ts"],
      ),
      POLICY,
    );
    expect(rules(alias)).toEqual(["package-application-alias"]);

    const path = checkWorkspaceImports(
      tree(
        {
          ...APP,
          "packages/core/src/thing.ts": 'import { local } from "../../../apps/web/src/lib/local";\n\nexport const thing = local;\n',
        },
        ["src/app.ts", "src/app.test.ts"],
      ),
      POLICY,
    );
    expect(rules(path)).toEqual(["cross-workspace-path"]);
  });

  it("is not treated as a package: no layer rank, no curated root export", () => {
    const root = tree(APP, ["src/app.ts", "src/app.test.ts"]);
    expect(listWorkspacePackages(root, POLICY).map((pkg) => pkg.name)).toEqual(["@vesper/core", "@vesper/foundation"]);
    expect(rules(checkWorkspaceImports(root, POLICY))).not.toContain("package-layer-unknown");
  });
});

describe("the shipped Vesper policy", () => {
  it("ranks every package it declares a runtime target for", () => {
    expect(Object.keys(VESPER_WORKSPACE_POLICY.runtimes).sort()).toEqual(Object.keys(VESPER_WORKSPACE_POLICY.layers).sort());
  });

  it("keeps the image core below the provider transport and above the shared foundation", () => {
    const { layers } = VESPER_WORKSPACE_POLICY;
    expect(layers["@vesper/contracts"]).toBeLessThan(layers["@vesper/image-core"] ?? 0);
    expect(layers["@vesper/image-core"]).toBeLessThan(layers["@vesper/image-replicate"] ?? 0);
    expect(VESPER_WORKSPACE_POLICY.applicationLayer).toBeGreaterThan(layers["@vesper/image-replicate"] ?? 0);
  });
});
