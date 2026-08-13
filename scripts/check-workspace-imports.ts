import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Workspace import integrity — the authoritative monorepo boundary check
 * (docs/developer-notes/monorepo-image-core.spec.guardrails.md).
 *
 * ESLint's `no-restricted-imports` still runs in the editor for fast feedback,
 * but it can only judge how an import is SPELLED. This checker judges where an
 * import RESOLVES and who is allowed to own it, which is what the boundary
 * actually means:
 *
 *   0. a relative path resolves to a file that exists;
 *   1. a relative path may not cross a workspace root, in either direction;
 *   2. a workspace package is imported by its exact name, never by code subpath;
 *   3. every bare import is declared in the importing workspace's own manifest;
 *   4. the `@vesper/*` graph is acyclic AND flows one way through the layers;
 *   5. a package root barrel publishes named exports, never a wildcard;
 *   6. a universal package's runtime source stays out of the Node-only graph.
 *
 * It is deliberately dependency-free apart from the TypeScript parser, and it
 * takes a repository root plus a policy so its own test suite can run it over
 * throwaway fixture trees rather than over this repository's current state.
 */

export type PackageRuntime = "universal" | "server";

export interface WorkspacePolicy {
  /** Package-name scope that marks a workspace-internal package. */
  readonly scope: string;
  /** Import prefix the application uses for its own source (`@/…`). */
  readonly applicationAlias: string;
  /**
   * Workspaces that ARE the application rather than a package it consumes.
   * The repository root is always one of them (it owns the operational
   * scripts); `apps/web` joined it when the Next app moved out of the root.
   * An application workspace may spell `@/…`, sits at `applicationLayer`, and
   * is never judged as a package — so it needs no layer rank and publishes no
   * curated root export.
   */
  readonly applicationWorkspaces: readonly string[];
  /**
   * Layer rank per workspace package. An import is legal only from a HIGHER
   * rank to a LOWER one, so `image-core -> image-replicate` fails even though
   * it would be acyclic. Packages that do not exist yet are listed on purpose:
   * the rank is the architectural decision, and making it up at extraction time
   * is how a boundary drifts.
   */
  readonly layers: Readonly<Record<string, number>>;
  /** Rank of the application/root workspace — above every package. */
  readonly applicationLayer: number;
  /** Runtime target each package promises its consumers. */
  readonly runtimes: Readonly<Record<string, PackageRuntime>>;
  /** Third-party modules that pull a server-only graph behind them. */
  readonly serverOnlyModules: readonly string[];
  /**
   * Globals that belong to exactly one runtime. A universal package may not
   * evaluate them: `process`/`Buffer` do not exist in a browser, `document`/
   * `window` do not exist on a server.
   */
  readonly singleRuntimeGlobals: readonly string[];
}

export const VESPER_WORKSPACE_POLICY: WorkspacePolicy = {
  scope: "@vesper",
  applicationAlias: "@/",
  applicationWorkspaces: ["@vesper/web"],
  layers: {
    "@vesper/contracts": 10,
    "@vesper/image-core": 20,
    "@vesper/image-replicate": 30,
  },
  applicationLayer: 100,
  runtimes: {
    "@vesper/contracts": "universal",
    "@vesper/image-core": "universal",
    "@vesper/image-replicate": "server",
  },
  serverOnlyModules: ["next", "sharp", "pg", "drizzle-orm", "better-auth", "replicate", "server-only"],
  singleRuntimeGlobals: ["process", "Buffer", "require", "__dirname", "__filename", "document", "window", "localStorage", "navigator"],
};

export type BoundaryRule =
  | "cross-workspace-path"
  | "unresolved-relative-path"
  | "package-application-alias"
  | "package-code-subpath"
  | "package-missing-root-export"
  | "unknown-workspace-package"
  | "workspace-self-import"
  | "undeclared-dependency"
  | "runtime-dependency-in-dev"
  | "package-layer-unknown"
  | "package-layer-direction"
  | "package-graph-cycle"
  | "root-barrel-wildcard"
  | "package-dynamic-import"
  | "universal-runtime-dependency"
  | "universal-runtime-global";

export interface BoundaryViolation {
  /** Repository-relative, POSIX-separated. */
  readonly file: string;
  readonly line: number;
  readonly rule: BoundaryRule;
  readonly specifier: string | null;
  readonly message: string;
}

interface Manifest {
  readonly name: string;
  readonly dependencies: ReadonlyMap<string, string>;
  readonly devDependencies: ReadonlyMap<string, string>;
  readonly rootExport: string | null;
}

interface Workspace {
  /** Absolute, symlink-resolved. */
  readonly dir: string;
  readonly manifest: Manifest;
  readonly isRoot: boolean;
}

type FileRole = "runtime" | "test" | "tooling";

interface ImportRef {
  /** `null` for a dynamic import whose argument is not a string literal. */
  readonly specifier: string | null;
  readonly line: number;
  readonly typeOnly: boolean;
  readonly wildcardExport: boolean;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/**
 * How a bundler completes a relative specifier. Broad on purpose: this list
 * decides only whether an import points at SOMETHING, and a missing entry would
 * turn a legal import into a false failure.
 */
const RESOLUTION_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

/**
 * Does this resolved path name a file anything could load? TypeScript also lets
 * an ESM-style `./x.js` specifier mean `./x.ts`, so that rewrite is tried too —
 * this answers "does the import point at something", and being generous here
 * only ever costs a missed report, never a false failure.
 */
function resolvesToFile(target: string): boolean {
  const candidates = [target];
  const tsRewrite = target.replace(/\.(js|jsx|mjs|cjs)$/, "");
  if (tsRewrite !== target) candidates.push(tsRewrite);
  return candidates.some((candidate) => RESOLUTION_SUFFIXES.some((suffix) => existsSync(`${candidate}${suffix}`)));
}

/**
 * Directories that never hold workspace source. `drizzle` and `docs` are
 * generated/prose, `.next` and `coverage` are build output, and `node_modules`
 * is where the workspace links itself — walking into it would compare a package
 * against its own symlink.
 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".claude",
  ".husky",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "docs",
  "drizzle",
  "screenshots",
]);

const NODE_BUILTINS = new Set(builtinModules);

// ---------------------------------------------------------------------------
// Manifests and workspace discovery
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asDependencyMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, range] of Object.entries(asRecord(value))) {
    if (typeof range === "string") out.set(name, range);
  }
  return out;
}

/**
 * The one code entry point a package publishes. Only the `"."` condition counts:
 * `./package.json` exists so tooling can read metadata and is deliberately not a
 * precedent for code subpaths.
 */
function readRootExport(exportsField: unknown): string | null {
  if (typeof exportsField === "string") return exportsField;
  const record = asRecord(exportsField);
  const root: unknown = record["."];
  if (typeof root === "string") return root;
  const conditions = asRecord(root);
  for (const condition of ["import", "default", "require"]) {
    const target: unknown = conditions[condition];
    if (typeof target === "string") return target;
  }
  return null;
}

function readManifest(dir: string): Manifest | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const record = asRecord(parsed);
  const name = record.name;
  return {
    name: typeof name === "string" ? name : "",
    dependencies: asDependencyMap(record.dependencies),
    devDependencies: asDependencyMap(record.devDependencies),
    rootExport: readRootExport(record.exports),
  };
}

/**
 * Read the `packages:` list out of pnpm-workspace.yaml. pnpm's own membership
 * rules are the ones that matter here, so the checker reads them rather than
 * guessing from the directory layout.
 */
function readWorkspacePatterns(repoRoot: string): string[] {
  const file = join(repoRoot, "pnpm-workspace.yaml");
  if (!existsSync(file)) return ["."];

  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const entry = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (entry?.[1] !== undefined) {
      patterns.push(entry[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    if (line.trim() !== "" && /^\S/.test(line)) inPackages = false;
  }
  return patterns.length > 0 ? patterns : ["."];
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function expandWorkspacePattern(repoRoot: string, pattern: string): string[] {
  if (pattern.includes("**")) {
    throw new Error(`pnpm-workspace.yaml pattern "${pattern}" uses ** — this checker supports literal segments and *.`);
  }
  let directories = [repoRoot];
  for (const segment of pattern.split("/")) {
    if (segment === "" || segment === ".") continue;
    const next: string[] = [];
    for (const directory of directories) {
      if (segment === "*") {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) next.push(join(directory, entry.name));
        }
      } else {
        const candidate = join(directory, segment);
        if (isDirectory(candidate)) next.push(candidate);
      }
    }
    directories = next;
  }
  return directories;
}

function loadWorkspaces(repoRoot: string): Workspace[] {
  const byDir = new Map<string, Workspace>();
  for (const pattern of readWorkspacePatterns(repoRoot)) {
    for (const directory of expandWorkspacePattern(repoRoot, pattern)) {
      const dir = realpathSync(directory);
      if (byDir.has(dir)) continue;
      const manifest = readManifest(dir);
      if (manifest === null) continue;
      byDir.set(dir, { dir, manifest, isRoot: dir === repoRoot });
    }
  }
  // Deepest first, so "the workspace owning this file" is a first match.
  return [...byDir.values()].sort((a, b) => b.dir.length - a.dir.length);
}

/**
 * An application workspace owns Vesper itself rather than a library Vesper
 * consumes: the repository root (operational scripts, repository tooling) and
 * `apps/web` (the Next application). They share the `@vesper` scope with the
 * packages, so membership is declared by name, not inferred from it.
 */
function isApplicationWorkspace(workspace: Workspace, policy: WorkspacePolicy): boolean {
  return workspace.isRoot || policy.applicationWorkspaces.includes(workspace.manifest.name);
}

/**
 * The workspace packages a consumer may import by name. `scripts/check-package-resolution.ts`
 * uses this so the resolution smoke check covers every package automatically.
 */
export function listWorkspacePackages(
  repoRoot: string,
  policy: WorkspacePolicy = VESPER_WORKSPACE_POLICY,
): Array<{ name: string; dir: string; rootExport: string | null }> {
  return loadWorkspaces(realpathSync(repoRoot))
    .filter((workspace) => !isApplicationWorkspace(workspace, policy) && workspace.manifest.name.startsWith(`${policy.scope}/`))
    .map((workspace) => ({
      name: workspace.manifest.name,
      dir: workspace.dir,
      rootExport: workspace.manifest.rootExport,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function contains(directory: string, candidate: string): boolean {
  if (directory === candidate) return true;
  const rel = relative(directory, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Resolve symlinks in the longest existing prefix of a path. A source file that
 * is a symlink into another workspace would otherwise look contained: the
 * spelling stays inside the package while the real file does not.
 */
function canonicalize(target: string): string {
  const trailing: string[] = [];
  let current = target;
  for (;;) {
    if (existsSync(current)) return join(realpathSync(current), ...trailing.reverse());
    const parent = dirname(current);
    if (parent === current) return target;
    trailing.push(basename(current));
    current = parent;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function collectSourceFiles(workspace: Workspace, workspaces: readonly Workspace[]): string[] {
  const nestedRoots = new Set(workspaces.filter((other) => other.dir !== workspace.dir).map((other) => other.dir));
  const files: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || nestedRoots.has(path)) continue;
        walk(path);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(path);
    }
  };

  walk(workspace.dir);
  return files.sort();
}

/**
 * Which dependency field may own this file's imports. Tests and tooling are
 * allowed to reach for `devDependencies`; anything that can end up in a running
 * app is not.
 */
function classifyFile(workspace: Workspace, file: string): FileRole {
  const rel = toPosix(relative(workspace.dir, file));
  const testPath =
    /\.test\.tsx?$/.test(rel) ||
    rel.startsWith("src/test/") ||
    rel.includes("/test-support/") ||
    rel.includes("/fixtures/");
  if (testPath) return "test";
  if (rel.startsWith("scripts/") || /^[^/]+\.config\.[cm]?[jt]sx?$/.test(rel)) return "tooling";
  return "runtime";
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function isFullyTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (clause.name !== undefined || bindings === undefined || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function collectImports(file: string, source: string): ImportRef[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const refs: ImportRef[] = [];

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const push = (node: ts.Node, specifier: string | null, typeOnly: boolean, wildcardExport = false): void => {
    refs.push({ specifier, line: lineOf(node), typeOnly, wildcardExport });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node, node.moduleSpecifier.text, isFullyTypeOnly(node.importClause));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const wildcard = node.exportClause === undefined || ts.isNamespaceExport(node.exportClause);
      push(node, node.moduleSpecifier.text, node.isTypeOnly, wildcard);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const reference = node.moduleReference.expression;
      if (ts.isStringLiteral(reference)) push(node, reference.text, false);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        push(node, argument.literal.text, true);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) push(node, argument.text, false);
      else push(node, null, false);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return refs;
}

/**
 * A `Buffer` in a type annotation compiles to nothing and cannot break a
 * browser; `Buffer.from(...)` can. This separates the two so a universal
 * package may keep naming a platform type at a provider seam while it is still
 * barred from evaluating one.
 */
function isEvaluatedReference(node: ts.Identifier): boolean {
  const parent: ts.Node | undefined = node.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent)) return false;
  if ((parent as { name?: ts.Node }).name === node) return false;
  const typeContext =
    ts.isTypeReferenceNode(parent) ||
    ts.isTypeQueryNode(parent) ||
    ts.isTypeOperatorNode(parent) ||
    ts.isTypePredicateNode(parent) ||
    ts.isExpressionWithTypeArguments(parent) ||
    ts.isImportTypeNode(parent);
  return !typeContext;
}

function collectGlobalReferences(file: string, source: string, names: readonly string[]): Array<{ name: string; line: number }> {
  const banned = new Set(names);
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: Array<{ name: string; line: number }> = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && banned.has(node.text) && isEvaluatedReference(node)) {
      found.push({ name: node.text, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

// ---------------------------------------------------------------------------
// Specifier classification
// ---------------------------------------------------------------------------

function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.slice(0, 2).join("/");
  return segments[0] ?? specifier;
}

function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(packageNameOf(specifier));
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

interface PackageEdge {
  readonly from: string;
  readonly to: string;
  readonly file: string;
  readonly line: number;
}

export function checkWorkspaceImports(
  repoRootInput: string,
  policy: WorkspacePolicy = VESPER_WORKSPACE_POLICY,
): BoundaryViolation[] {
  const repoRoot = realpathSync(repoRootInput);
  const workspaces = loadWorkspaces(repoRoot);
  const byName = new Map(workspaces.filter((workspace) => workspace.manifest.name !== "").map((w) => [w.manifest.name, w]));
  const violations: BoundaryViolation[] = [];
  const edges: PackageEdge[] = [];

  const report = (file: string, line: number, rule: BoundaryRule, specifier: string | null, message: string): void => {
    violations.push({ file: toPosix(relative(repoRoot, file)), line, rule, specifier, message });
  };

  const workspaceOf = (path: string): Workspace | null =>
    workspaces.find((workspace) => contains(workspace.dir, path)) ?? null;

  const isApplication = (workspace: Workspace): boolean => isApplicationWorkspace(workspace, policy);

  const isPackageWorkspace = (workspace: Workspace): boolean =>
    !isApplication(workspace) && workspace.manifest.name.startsWith(`${policy.scope}/`);

  const rankOf = (workspace: Workspace): number | null => {
    if (isApplication(workspace)) return policy.applicationLayer;
    const rank = policy.layers[workspace.manifest.name];
    return rank ?? null;
  };

  for (const workspace of workspaces) {
    const name = workspace.manifest.name;

    // A package that no layer policy mentions has no defined position in the
    // graph, so no import of it can be judged. Deciding its rank is the point.
    if (isPackageWorkspace(workspace) && policy.layers[name] === undefined) {
      report(
        join(workspace.dir, "package.json"),
        1,
        "package-layer-unknown",
        name,
        `${name} has no layer rank. Add it to the workspace layer policy in scripts/check-workspace-imports.ts before anything imports it.`,
      );
    }

    // The curated root export is the whole public surface, so it may not be a
    // wildcard: a helper added to an internal barrel would become public
    // without appearing in the diff.
    if (isPackageWorkspace(workspace) && workspace.manifest.rootExport !== null) {
      const barrel = join(workspace.dir, workspace.manifest.rootExport);
      if (existsSync(barrel) && SOURCE_EXTENSIONS.some((extension) => barrel.endsWith(extension))) {
        for (const ref of collectImports(barrel, readFileSync(barrel, "utf8"))) {
          if (ref.wildcardExport) {
            report(
              barrel,
              ref.line,
              "root-barrel-wildcard",
              ref.specifier,
              `A package root barrel lists its public API explicitly. Replace "export * from ${JSON.stringify(ref.specifier ?? "")}" with named exports (internal folder barrels may still use export *).`,
            );
          }
        }
      }
    }

    for (const [dependency] of [...workspace.manifest.dependencies, ...workspace.manifest.devDependencies]) {
      if (dependency.startsWith(`${policy.scope}/`)) {
        edges.push({ from: name, to: dependency, file: join(workspace.dir, "package.json"), line: 1 });
      }
    }

    const runtime = isApplication(workspace) ? "server" : (policy.runtimes[name] ?? "server");

    for (const file of collectSourceFiles(workspace, workspaces)) {
      const role = classifyFile(workspace, file);
      const source = readFileSync(file, "utf8");
      const refs = collectImports(file, source);

      if (runtime === "universal" && role === "runtime") {
        for (const global of collectGlobalReferences(file, source, policy.singleRuntimeGlobals)) {
          report(
            file,
            global.line,
            "universal-runtime-global",
            global.name,
            `${name} is browser/server portable, so its runtime source may not evaluate "${global.name}" — that global exists on only one side. Naming a platform type in an annotation is still fine.`,
          );
        }
      }

      for (const ref of refs) {
        const specifier = ref.specifier;

        if (specifier === null) {
          // A computed dynamic import inside a package is an edge nothing can
          // inspect — neither this checker nor a reader.
          if (!isApplication(workspace)) {
            report(
              file,
              ref.line,
              "package-dynamic-import",
              null,
              "A workspace package may not use a dynamic import with a computed specifier; the dependency edge has to stay inspectable.",
            );
          }
          continue;
        }

        // --- application alias -------------------------------------------
        if (specifier.startsWith(policy.applicationAlias)) {
          if (!isApplication(workspace)) {
            report(
              file,
              ref.line,
              "package-application-alias",
              specifier,
              `Workspace packages are standalone: "${specifier}" reaches into the application. Take the value as an argument, or leave the code in the app.`,
            );
          }
          continue;
        }

        // --- relative / absolute paths -----------------------------------
        if (isRelative(specifier) || isAbsolute(specifier)) {
          const bare = specifier.replace(/[?#].*$/, "");
          const target = canonicalize(isAbsolute(bare) ? bare : resolve(dirname(file), bare));
          const targetWorkspace = workspaceOf(target);
          if (targetWorkspace?.dir !== workspace.dir) {
            const targetName = targetWorkspace?.manifest.name ?? "outside every workspace";
            report(
              file,
              ref.line,
              "cross-workspace-path",
              specifier,
              `A filesystem path is not an API between workspaces: this resolves into ${targetName}. Import the target workspace by its package name and declare the dependency.`,
            );
          } else if (!resolvesToFile(target)) {
            // A relative path that lands nowhere. This is the shape a directory
            // move leaves behind — `../src/server/db` still points inside its
            // own workspace after the app moves to apps/web, so no boundary
            // rule fires and the break only surfaces in typecheck (which is
            // exactly what the 2026-08-12 move produced, in both directions).
            report(
              file,
              ref.line,
              "unresolved-relative-path",
              specifier,
              `"${specifier}" resolves to nothing. If the target moved to another workspace, import it by package name (or, for the application, through its alias) rather than repairing the path.`,
            );
          }
          continue;
        }

        const packageName = packageNameOf(specifier);

        // --- Node built-ins ------------------------------------------------
        if (isNodeBuiltin(specifier)) {
          if (runtime === "universal" && role === "runtime" && !ref.typeOnly) {
            report(
              file,
              ref.line,
              "universal-runtime-dependency",
              specifier,
              `${name} is browser/server portable, so its runtime source may not import the Node built-in "${specifier}". Keep the Node-only execution on the application side and take the result as an argument.`,
            );
          }
          continue;
        }

        // --- workspace packages -------------------------------------------
        if (packageName.startsWith(`${policy.scope}/`)) {
          if (specifier !== packageName) {
            report(
              file,
              ref.line,
              "package-code-subpath",
              specifier,
              `${packageName} publishes one curated entry point. Import "${packageName}" itself — code subpaths are not public API.`,
            );
            continue;
          }
          if (packageName === name) {
            report(
              file,
              ref.line,
              "workspace-self-import",
              specifier,
              `${name} imports itself by package name; use a relative import inside the package.`,
            );
            continue;
          }
          const target = byName.get(packageName);
          if (target === undefined) {
            report(file, ref.line, "unknown-workspace-package", specifier, `No workspace publishes ${packageName}.`);
            continue;
          }
          if (target.manifest.rootExport === null) {
            report(
              file,
              ref.line,
              "package-missing-root-export",
              specifier,
              `${packageName} declares no "." export, so it has no public entry point to import.`,
            );
            continue;
          }
          const targetRank = policy.layers[packageName];
          const sourceRank = rankOf(workspace);
          if (targetRank === undefined) {
            report(
              file,
              ref.line,
              "package-layer-unknown",
              specifier,
              `${packageName} has no layer rank in the workspace layer policy, so this edge cannot be judged.`,
            );
          } else if (sourceRank !== null && sourceRank <= targetRank) {
            report(
              file,
              ref.line,
              "package-layer-direction",
              specifier,
              `${name} may not import ${packageName}: the layer policy puts ${packageName} above or beside it, and the package graph flows one way.`,
            );
          }
          edges.push({ from: name, to: packageName, file, line: ref.line });
        }

        // --- runtime target of a universal package -------------------------
        if (runtime === "universal" && role === "runtime" && !ref.typeOnly && policy.serverOnlyModules.includes(packageName)) {
          report(
            file,
            ref.line,
            "universal-runtime-dependency",
            specifier,
            `${name} is browser/server portable, so its runtime source may not depend on the server-only module "${packageName}".`,
          );
        }

        // --- dependency ownership ------------------------------------------
        const inDependencies = workspace.manifest.dependencies.has(packageName);
        const inDevDependencies = workspace.manifest.devDependencies.has(packageName);
        if (!inDependencies && !inDevDependencies) {
          report(
            file,
            ref.line,
            "undeclared-dependency",
            specifier,
            `"${packageName}" is not declared in ${name || "this workspace"}'s package.json. Reachability elsewhere in the pnpm install is not ownership.`,
          );
        } else if (!inDependencies && role === "runtime" && !ref.typeOnly) {
          report(
            file,
            ref.line,
            "runtime-dependency-in-dev",
            specifier,
            `"${packageName}" is runtime code here but is declared only in devDependencies of ${name || "this workspace"}.`,
          );
        }
      }
    }
  }

  violations.push(...findGraphCycles(edges, repoRoot));
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Package-graph cycles. The layer policy already makes a cycle between two
 * known packages impossible, so this is the independent check that catches a
 * cycle the policy did not anticipate — including one declared purely in
 * manifests, with no import written yet.
 */
function findGraphCycles(edges: readonly PackageEdge[], repoRoot: string): BoundaryViolation[] {
  const adjacency = new Map<string, PackageEdge[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }

  const violations: BoundaryViolation[] = [];
  const reported = new Set<string>();
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const edge of adjacency.get(node) ?? []) {
      const next = edge.to;
      if (state.get(next) === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(next)), next].join(" -> ");
        if (!reported.has(cycle)) {
          reported.add(cycle);
          violations.push({
            file: toPosix(relative(repoRoot, edge.file)),
            line: edge.line,
            rule: "package-graph-cycle",
            specifier: next,
            message: `The workspace package graph has a cycle: ${cycle}.`,
          });
        }
        continue;
      }
      if (state.get(next) === undefined) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };

  for (const node of adjacency.keys()) {
    if (state.get(node) === undefined) visit(node);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatViolations(violations: readonly BoundaryViolation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line}  [${v.rule}]  ${v.message}`).join("\n");
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = checkWorkspaceImports(repoRoot);
  if (violations.length === 0) {
    console.log("Workspace import integrity: OK");
    return;
  }
  console.error(`Workspace boundary violations (${violations.length}):`);
  console.error(formatViolations(violations));
  console.error(
    "\nWorkspaces communicate only through declared public APIs — see docs/developer-notes/monorepo-image-core.spec.guardrails.md.",
  );
  process.exit(1);
}

// Only run when this file IS the process entry point, so the test suite can
// import the checker without shelling out or calling process.exit.
const entryPoint = process.argv[1];
const isMain =
  entryPoint !== undefined && resolve(entryPoint).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main();
