import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listWorkspacePackages } from "./check-workspace-imports";

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
 * So this check does what a consumer does: import each package BY NAME through
 * the installed workspace, with no alias in the picture, and confirm that the
 * module it gets back is the package source and actually exports something.
 */

interface ResolutionFailure {
  readonly packageName: string;
  readonly problem: string;
}

async function checkPackage(
  repoRoot: string,
  pkg: { name: string; dir: string; rootExport: string | null },
): Promise<ResolutionFailure | null> {
  if (pkg.rootExport === null) {
    return { packageName: pkg.name, problem: 'package.json declares no "." export, so consumers have no entry point.' };
  }
  if (!existsSync(join(pkg.dir, pkg.rootExport))) {
    return { packageName: pkg.name, problem: `the "." export points at ${pkg.rootExport}, which does not exist.` };
  }

  let resolved: Record<string, unknown>;
  try {
    resolved = (await import(pkg.name)) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { packageName: pkg.name, problem: `importing it by name failed: ${detail}` };
  }

  const exported = Object.keys(resolved).filter((key) => key !== "default" && key !== "__esModule");
  if (exported.length === 0) {
    return { packageName: pkg.name, problem: "it resolved but exports nothing, so the entry point is not wired to the source." };
  }

  console.log(`  ${pkg.name} → ${relative(repoRoot, join(pkg.dir, pkg.rootExport))} (${exported.length} exports)`);
  return null;
}

async function main(): Promise<void> {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packages = listWorkspacePackages(repoRoot);
  if (packages.length === 0) {
    console.error("No workspace packages found — pnpm-workspace.yaml or the package manifests are misconfigured.");
    process.exit(1);
  }

  console.log("Resolving workspace packages by public name:");
  const failures: ResolutionFailure[] = [];
  for (const pkg of packages) {
    const failure = await checkPackage(repoRoot, pkg);
    if (failure !== null) failures.push(failure);
  }

  if (failures.length > 0) {
    console.error("\nWorkspace package resolution failed:");
    for (const failure of failures) console.error(`  - ${failure.packageName}: ${failure.problem}`);
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
