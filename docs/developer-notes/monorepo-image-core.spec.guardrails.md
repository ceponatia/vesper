# Monorepo migration guardrails — Slice 1 completion

Status: required completion work for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) Slice 1

Implementation state: not started — blocks Slice 2.

This spec turns the monorepo boundary from an architectural intention into a
repository invariant. The first extraction proved that `@vesper/image-core` can
exist as a workspace package, but review found several ways a future change could
still make that boundary porous while lint, typecheck, or tests stayed green.

Slice 1 is not complete until the checks below are active. No additional image
code crosses into a package before then.

## The invariant: workspaces communicate only through declared public APIs

The repository has three kinds of workspace after the final move:

- the root operational workspace;
- application workspaces such as `@vesper/web`;
- reusable packages such as `@vesper/image-core`.

A filesystem path is not an API between those workspaces.

The rules are bidirectional:

1. A package cannot reach application/root code through a relative path or app
   alias.
2. An application, root script, or sibling package cannot reach inside another
   workspace through a relative filesystem path.
3. A workspace package is imported by its exact package name, not by a code
   subpath.
4. The import must be declared in the importing workspace's manifest.
5. The imported symbol must be part of the package's curated root export.

Examples that must fail:

```ts
// package -> app
import { db } from "../../../src/server/db";

// package -> sibling package by filesystem
import { diag } from "../../contracts/src/diagnostics";

// app -> package internal file
import { privateHelper } from "../../packages/image-core/src/lab/private-helper";

// package code subpath
import { privateHelper } from "@vesper/image-core/lab/private-helper";
import { privateHelper } from "@vesper/image-core/src/lab/private-helper";
```

The ordinary allowed spelling is:

```ts
import { sceneReferenceModeSchema } from "@vesper/image-core";
```

`./package.json` may remain an export only for tooling that actually reads
package metadata. It is not a precedent for code subpaths.

## One authoritative workspace-import checker

Replace the narrow "package escape" mental model with a repository
**workspace-import-integrity** checker. Keep the immediate ESLint restrictions
for fast editor feedback, but make this checker authoritative.

### Source forms it must inspect

Inspect import-like module specifiers in TypeScript/TSX across application,
package, and root-script source:

- `import ... from "..."`;
- side-effect imports;
- `export ... from "..."`;
- `export * from "..."`;
- type-position `import("...")`;
- dynamic `import("...")` when the argument is a string literal.

Non-literal dynamic imports inside a reusable package are rejected unless a
specific package requirement and finite allowed target set are documented. They
otherwise create an uninspectable dependency edge.

### Filesystem containment

For a relative specifier, compute the source workspace and normalized target. Use
`path.relative()`-style containment semantics rather than a raw string-prefix
check; `/packages/foo` must not be considered the parent of `/packages/foobar`.

If source and target belong to different workspaces, fail. This covers both
package escapes and consumers reaching into package internals.

The check does not need to resolve a `.ts` extension or `index.ts` to prove that
a path crosses a workspace root. It does need to handle repository paths
canonically. Either resolve real paths before comparing them or prohibit source
symlinks that can resolve outside their workspace; do not let a symlink turn an
apparently-contained path into an escape.

### Bare workspace package imports

For `@vesper/<name>`:

- the target workspace must exist;
- the specifier must equal an exported package entry point;
- application/runtime source uses the exact root package name unless the package
  has an explicitly approved metadata export;
- the importer declares the dependency in its nearest workspace manifest;
- runtime source cannot rely on `devDependencies`;
- a package should not import itself by name when a local relative import is the
  honest edge.

Any `@vesper/<name>/...` code subpath fails even if a bundler could resolve a
file there. Package `exports` remains a second line of defense, not the only one.

### All third-party imports are owned too

Dependency ownership is not special to workspace packages. For every bare
third-party import, locate the importing file's nearest workspace
`package.json`:

- runtime source requires the dependency in `dependencies`;
- tests/config/tool-only source may use `devDependencies`;
- Node built-ins (`node:*` and recognized built-ins) are exempt;
- a dependency existing somewhere in the pnpm install is not proof that the
  importing workspace owns it.

This rule matters most after `apps/web` moves: a web import must not keep working
only because the root operational package happens to install the same library.

### Package graph policy

Build the `@vesper/*` graph from manifests/imports and check both:

- **acyclicity**;
- **allowed direction**.

The intended graph through Slice 4 is:

```text
@vesper/image-replicate -> @vesper/image-core -> @vesper/contracts
@vesper/image-replicate ----------------------> @vesper/contracts
application/root tooling ---------------------> package layer
```

`image-core -> image-replicate` is invalid even though it would be acyclic. The
checker therefore needs a small explicit layer policy rather than relying only on
Madge's circular-import check.

Wire the checker into `lint:package-boundaries` and CI's static gate. The package
and dependency graph rules are part of that same command so there is one answer
to "is this workspace edge legal?".

## Curated root exports are enforced, not aspirational

Every reusable package has one deliberately curated code entry point.

- `packages/*/src/index.ts` uses explicit named exports.
- `export *` is forbidden in package root barrels.
- internal folder barrels may still use `export *` when that makes the package
  easier to read; they are not public merely because they exist.
- adding a new root export is a visible public-API change in the diff.

Add a lint/source rule for root barrels so a helper added to an internal domain
barrel cannot become public accidentally through a chain of wildcards.

During the Slice 1 correction, replace the existing
`packages/image-core/src/index.ts` wildcard surface with explicit exports based on
actual external consumers. Do not rename live exports as part of that cleanup.

## Package-local TypeScript projects start now

Do not wait for Slice 6 to discover whether a package only typechecks because the
root Next application lends it aliases, DOM libraries, generated types, or other
ambient configuration.

Before Slice 2:

- add `packages/image-core/tsconfig.json`;
- give every later package its own `tsconfig.json` when created;
- include all package source and package tests that are meant to typecheck;
- do not expose the application's `@/*` alias;
- do not inherit the Next TypeScript plugin;
- include only runtime libraries/types appropriate to that package;
- make root `pnpm typecheck` invoke/aggregate the package project as well as the
  existing app/root project.

Slice 6 may introduce a shared `tsconfig.base.json` and reorganize the aggregation
shape, but it does not become the first time package code is independently
checked.

A package-internal source file that no application imports must still be covered.
A green Next build is never accepted as package type coverage.

## Package tests stop inheriting application setup now

The current shared Vitest setup applies `src/test/setup.ts` to package tests. That
is intentionally temporary and is removed as part of Slice 1 completion rather
than Slice 6.

Use Vitest projects or an equivalent scoped configuration so:

- application tests keep `src/test/setup.ts`;
- `@vesper/image-core` tests run with no application setup;
- a future package receives only setup it explicitly owns;
- root script tests receive only root/tooling setup they need.

Package tests may still be launched from the repository root. "Independent" does
not mean a separate command developers have to remember; it means the package's
behavior is not established by another workspace's test environment.

## Prefer real workspace resolution over aliases

The repository currently maps workspace package names directly to source in root
TypeScript and Vitest configuration. Those aliases are convenient, but they can
hide a broken `package.json`, `exports` map, workspace link, or lockfile importer.

After package-local projects exist:

1. try resolving `@vesper/image-core` through normal pnpm/package `exports` in
   TypeScript and Vitest;
2. remove the package-name alias where normal workspace resolution works;
3. if a tool genuinely requires a mapping, keep it exact-root-only — never add a
   wildcard such as `@vesper/* -> packages/*/src`;
4. add a CI smoke check that imports each package by its public package name
   through the installed workspace, so manifest/exports wiring is exercised even
   when another tool has an alias.

No package is considered registered merely because an alias makes its source
reachable.

## Runtime targets are part of the package contract

Purity and runtime portability are separate questions.

### `@vesper/image-core`: universal/isomorphic

`@vesper/image-core` is imported today by client-importable application contracts
for runtime schemas. Keep it usable from both browser and server graphs.

Therefore package source reachable from its public root must not depend on
Node-only built-ins or server-only framework modules. In particular, moving the
render kernel must not make a client import of an existing image-core schema drag
`node:crypto` into the browser graph.

### `@vesper/contracts`: universal/isomorphic

The shared diagnostics/parsing foundation is likewise runtime-neutral. No Next,
Node-only IO, persistence, or ambient environment dependency enters it.

### `@vesper/image-replicate`: Node/server transport

The Replicate transport is deliberately server-only and may use server/network
primitives. Client-importable application layers are mechanically prohibited
from importing it.

### Browser-safety regression check

Keep at least one small build/type fixture in a client-importable application
surface that imports a designated runtime symbol from `@vesper/image-core`. The
production build must continue to accept that path after Slice 2. This catches a
Node-only transitive dependency that pure unit tests would not reveal.

## Consequence for Slice 2 hashing

`src/server/images/render-profile.ts` currently contains `sha256Hex` implemented
with `node:crypto`. Do not move that implementation into the universal
`@vesper/image-core` root graph.

Split **fingerprint construction** from **hash execution**:

- `image-core` owns the deterministic fingerprint payload/serialization derived
  from the compiled effective plan;
- the application keeps the thin Node SHA-256 wrapper that converts that stable
  payload into the existing hash string;
- existing application-facing `profileRenderControlsHash` behavior and stored
  values remain byte-for-byte compatible;
- package tests pin the fingerprint payload/serialization;
- an application regression test pins the final SHA-256 hash before and after
  extraction.

`stableJson` itself is runtime-neutral and may move if useful. `sha256Hex` stays
on the server/application side unless a later deliberate decision replaces it
with a proven runtime-neutral hashing implementation without changing stored
fingerprints.

This is an ownership correction, not permission to change the fingerprint.

## Adversarial tests for the guardrail

The boundary checker needs its own regression suite. At minimum include fixtures
for:

- package -> app alias import;
- package -> app relative escape;
- package -> sibling relative escape where the spelling never contains
  `packages`;
- app/root -> package relative deep import;
- `@vesper/image-core/internal` and `@vesper/image-core/src/...`;
- undeclared workspace dependency;
- workspace dependency incorrectly present only in `devDependencies` for runtime
  source;
- undeclared third-party dependency;
- test-only third-party dependency correctly declared in `devDependencies`;
- type imports and re-exports;
- literal dynamic import;
- prohibited non-literal package dynamic import;
- path-prefix trap (`foo` versus `foobar`);
- a package root barrel using `export *`;
- an intentionally legal internal relative import;
- an intentionally legal root package import.

The test suite should operate on temporary/fixture trees rather than relying on
there currently being no violations in production source; otherwise it proves
only the present repository state, not the checker semantics.

## Slice 1 completion gate

Slice 2 remains blocked until all of these are true:

- `lint:package-boundaries` checks cross-workspace relative paths in both
  directions;
- package code subpath imports are rejected;
- workspace and third-party dependency ownership is checked against the nearest
  manifest;
- package graph direction and cycles are checked;
- `image-core` has a package-local TypeScript project included in root
  typechecking;
- package tests no longer inherit application setup;
- package root wildcard exports are replaced and mechanically prohibited;
- package resolution has a real-workspace smoke check rather than relying only on
  source aliases;
- `image-core` is explicitly protected as browser/server portable;
- the guardrail fixture suite is green.

Only then is the first package boundary strong enough to serve as the template
for `@vesper/contracts` and `@vesper/image-replicate`.
