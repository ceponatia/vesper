import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type PackageExport, type WorkspacePackage, listWorkspacePackages } from "./check-workspace-imports";

/**
 * Real-workspace resolution smoke check
 * (docs/developer-notes/monorepo-image-core.spec.guardrails.md §"Prefer real
 * workspace resolution over aliases").
 *
 * TypeScript and Vitest can both be told where a package's source lives. That
 * convenience hides exactly the failures that matter here: a `package.json`
 * with no `exports` map, an `exports` target pointing at a file that no longer
 * exists, a workspace link pnpm never created, a lockfile importer that was
 * never updated. A tool alias would resolve all four of them anyway, and the
 * break would surface in the Docker build instead.
 *
 * So this check does what a consumer does: import each declared entry BY ITS
 * PUBLIC SPECIFIER through the installed workspace, with no alias in the
 * picture, and confirm that the module it gets back is the package source and
 * actually exports something. Every entry is exercised, not only `"."` — a
 * package that publishes exact subpaths has as many public front doors as it
 * declares, and an entry nobody loads is where a stale target hides.
 *
 * It runs from the repository root, which is why the root manifest declares
 * every `@vesper/*` package even when no root script imports one directly:
 * being resolvable from here is the thing under test, and a package the root
 * cannot resolve is a failure this check must report rather than skip.
 */

interface ResolutionFailure {
  /** The public specifier that failed — `@vesper/x`, or `@vesper/x/sub`. */
  readonly specifier: string;
  readonly problem: string;
}

async function checkEntry(repoRoot: string, pkg: WorkspacePackage, entry: PackageExport): Promise<ResolutionFailure | null> {
  const specifier = `${pkg.name}${entry.subpath}`;

  if (!existsSync(join(pkg.dir, entry.target))) {
    return { specifier, problem: `the "${entry.key}" export points at ${entry.target}, which does not exist.` };
  }

  let resolved: Record<string, unknown>;
  try {
    resolved = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { specifier, problem: `importing it by name failed: ${detail}` };
  }

  const exported = Object.keys(resolved).filter((key) => key !== "default" && key !== "__esModule");
  if (exported.length === 0) {
    return { specifier, problem: `it resolved but exports nothing, so the "${entry.key}" entry is not wired to the source.` };
  }

  console.log(`  ${specifier} → ${relative(repoRoot, join(pkg.dir, entry.target))} (${exported.length} exports)`);
  return null;
}

async function main(): Promise<void> {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packages = listWorkspacePackages(repoRoot);
  if (packages.length === 0) {
    console.error("No workspace packages found — pnpm-workspace.yaml or the package manifests are misconfigured.");
    process.exit(1);
  }

  console.log("Resolving every declared workspace package entry by its public specifier:");
  const failures: ResolutionFailure[] = [];
  for (const pkg of packages) {
    if (pkg.entries.length === 0) {
      failures.push({ specifier: pkg.name, problem: "package.json declares no code exports, so consumers have no entry point." });
      continue;
    }
    for (const entry of pkg.entries) {
      const failure = await checkEntry(repoRoot, pkg, entry);
      if (failure !== null) failures.push(failure);
    }
  }

  if (failures.length > 0) {
    console.error("\nWorkspace package resolution failed:");
    for (const failure of failures) console.error(`  - ${failure.specifier}: ${failure.problem}`);
    console.error("\nRun `pnpm install` and check the package's exports map; a tool alias must not be the reason imports work.");
    process.exit(1);
  }
  console.log("Workspace package resolution: OK");
}

const entryPoint = process.argv[1];
const isMain =
  entryPoint !== undefined && resolve(entryPoint).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
