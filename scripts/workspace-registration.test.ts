import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listWorkspacePackages } from "./check-workspace-imports";

/**
 * The registration points that stay EXPLICIT, and therefore need a tripwire.
 *
 * Most of the work of adding a workspace package is now discovery rather than
 * registration: `pnpm typecheck` and `pnpm test` recurse over the workspace
 * (`pnpm -r`), so a package that owns the matching script is picked up by the
 * gates without being named anywhere at the root. Two places genuinely cannot
 * work that way, because the tool reading them has no access to pnpm's
 * workspace graph:
 *
 *   - the **Dockerfile** copies every workspace manifest before
 *     `pnpm install --frozen-lockfile`. A missing COPY resolves the new
 *     package's `workspace:*` edges against nothing, and the failure appears in
 *     a Fly build minutes later — the slowest possible feedback in this repo.
 *   - **`apps/web/next.config.ts` `transpilePackages`** names each package Next
 *     must compile from TypeScript source. A missing entry breaks only the
 *     production build, and only for the routes that reach the package.
 *
 * Both fail late and neither fails in a way that names the cause, so they are
 * asserted here instead.
 *
 * Deliberately NOT asserted, because an existing gate already self-enforces
 * them by walking the workspace:
 *
 *   - the layer rank + runtime target in the policy in
 *     `check-workspace-imports.ts` — `pnpm lint:package-boundaries` reports
 *     `package-layer-unknown` for any package the policy does not mention.
 *   - the `exports` map and the workspace link — `pnpm lint:package-resolution`
 *     imports every declared entry of every package by its public specifier
 *     (a `"."` root export is not required — simulation-core publishes only
 *     subpaths) and fails on a dead target, an unresolvable entry, or a
 *     package that declares no entries at all.
 *
 * This suite reads the files as text on purpose. Executing `next.config.ts`
 * would drag Next's config machinery into the pure test project, and the
 * Dockerfile has no runtime to execute at all.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Repository-relative, POSIX-separated — the spelling both files use. */
function repoRelative(dir: string): string {
  return path.relative(repoRoot, dir).split(path.sep).join("/");
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readDependencies(manifestPath: string): Record<string, string> {
  const parsed = JSON.parse(readRepoFile(manifestPath)) as { dependencies?: Record<string, string> };
  return parsed.dependencies ?? {};
}

/**
 * `listWorkspacePackages` returns the packages a consumer may import, which
 * excludes the application workspaces by design. The Dockerfile has to copy
 * those manifests too, and `apps/web` is the only one that is not the
 * repository root (whose `package.json` is copied by the first COPY line).
 */
const APPLICATION_WORKSPACE = "apps/web";

const packageDirectories = listWorkspacePackages(repoRoot).map((pkg) => repoRelative(pkg.dir));
const workspaceDirectories = [...packageDirectories, APPLICATION_WORKSPACE];

describe("Dockerfile workspace manifests", () => {
  const dockerfile = readRepoFile("Dockerfile");
  const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");

  it("finds the install step the manifests must precede", () => {
    expect(installIndex).toBeGreaterThan(-1);
    expect(packageDirectories.length).toBeGreaterThan(0);
  });

  it.each(workspaceDirectories)("copies %s/package.json before installing", (directory) => {
    const copyIndex = dockerfile.indexOf(`COPY ${directory}/package.json`);

    expect(
      copyIndex,
      `Dockerfile has no "COPY ${directory}/package.json" line — pnpm would resolve its workspace:* dependencies against nothing.`,
    ).toBeGreaterThan(-1);
    expect(copyIndex, `the COPY of ${directory}/package.json must come before pnpm install.`).toBeLessThan(installIndex);
  });
});

describe("next.config.ts transpilePackages", () => {
  /**
   * Set equality, not containment, in both directions: a missing entry breaks
   * the production build, and a leftover entry names a package that no longer
   * exists, which is the same registration drift read backwards.
   */
  it("lists exactly the @vesper packages the app depends on", () => {
    const config = readRepoFile(`${APPLICATION_WORKSPACE}/next.config.ts`);
    const declared = Object.keys(readDependencies(`${APPLICATION_WORKSPACE}/package.json`))
      .filter((name) => name.startsWith("@vesper/"))
      .sort();

    const arrayLiteral = /transpilePackages:\s*\[([^\]]*)\]/.exec(config)?.[1];
    expect(arrayLiteral, "next.config.ts declares no transpilePackages array").toBeDefined();

    const listed = [...(arrayLiteral ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "").sort();

    expect(declared.length).toBeGreaterThan(0);
    expect(listed).toEqual(declared);
  });
});
