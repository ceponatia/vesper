# Monorepo migration guardrails — Slice 1 completion

Status: required completion work for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) Slice 1

Implementation state: complete — 2026-08-12 (PR #96), with one correction landing
in the Slice 2 PR: see the export-curation ruling below.

This spec turns the monorepo boundary from an architectural intention into a
repository invariant. The first extraction proved that `@vesper/image-core` can
exist as a workspace package, but review found several ways a future change could
still make that boundary porous while lint, typecheck, or tests stayed green.

Slice 1 is not complete until the checks below are active. No additional image
code crosses into a package before then.

## What is built

| Guardrail                  | Lives in                                                          |
| -------------------------- | ----------------------------------------------------------------- |
| Workspace import integrity | `scripts/check-workspace-imports.ts` (`lint:package-boundaries`)  |
| Checker regression suite   | `scripts/check-workspace-imports.test.ts`                         |
| Real-workspace resolution  | `scripts/check-package-resolution.ts` (`lint:package-resolution`) |
| Editor-latency subset      | `eslint.config.mjs` (subpath ban, root-barrel `export *` ban)     |
| Explicit public surface    | `packages/image-core/src/index.ts`                                |
| Package TypeScript project | `packages/image-core/tsconfig.json`                               |
| Package-scoped tests       | `vitest.config.ts` (`app` / `app-int` / `image-core` projects)    |
| Browser-safety fixture     | `src/contracts/state/scene-gen.ts` + its test                     |

Both new checks run in CI's static gate and in `pnpm verify`.

### Rulings this build settled

- **`Buffer` stays in the package's type surface.** Two provider seams name it
  where image bytes cross them (`ProviderRenderResult.image`,
  `IdentityFaceDetector.detect`). The package project therefore carries
  `"types": ["node"]`, and that concession is type-space only: the checker's
  `universal-runtime-global` rule rejects *evaluating* `Buffer`, `process`,
  `document` or `window` in package runtime source, so a type annotation stays
  legal while `Buffer.from(...)` does not. Converting these seams to
  `Uint8Array` is a provider-API change, not a guardrail, and was left alone.
- **`lib` is `["ES2022", "DOM"]`, not the Next lib set.** DOM is the only
  TypeScript library declaring the web-standard globals a universal package may
  use — `URL` is the one in play — and browser-only globals are rejected by the
  rule above rather than by the lib list.
- **The layer policy pre-declares packages that do not exist yet.**
  `@vesper/contracts` and `@vesper/image-replicate` already carry ranks and
  runtime targets, so Slices 3 and 4 inherit a decided position instead of
  inventing one at extraction time. An unranked `@vesper/*` workspace fails the
  check the moment it appears.
- **`diagnostics.ts` IS public, and the first curation got that wrong.** The
  export list was derived by scanning `import { … } from "@vesper/image-core"`
  statements, which does not see an inline `import("@vesper/image-core").X` type
  reference — and `src/contracts/images/identity-pack-boundary.test.ts` has one,
  deliberately, to assert that the package's diagnostic shape and the
  application's stay assignable in both directions. Dropping `DiagnosticSink`
  broke typecheck and the production build, and PR #96 was merged with that
  `verify` red. The root exports `Diagnostic`, `DiagnosticSeverity` and
  `DiagnosticSink` again, and Slice 3 removes them along with the temporary copy.
  The lesson for the next curation: a public surface is proven by typecheck, not
  by a regex over import statements — trim it, then run the gate before merging.
- **Package tests own their own tooling.** `vitest` is a devDependency of
  `packages/image-core` — reachability through the root install is not ownership,
  and the dependency-ownership rule is what proves it.
- **Vitest CLI `--exclude` does not reach projects.** Vitest passes only a fixed
  set of CLI options down to a project's config, and `include`/`exclude` are not
  among them. The unit/integration split therefore moved into `vitest.config.ts`
  as the `app` and `app-int` projects, and `pnpm test` / `pnpm test:int` select
  projects instead of filtering filenames. The path-filtered `test:engine*`
  scripts are unchanged: positional filters still apply across projects.

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

The narrow "package escape" mental model is replaced by a repository
**workspace-import-integrity** checker, `scripts/check-workspace-imports.ts`. The
ESLint restrictions remain for fast editor feedback; this checker is the
authoritative one, and it takes a repository root plus a policy so its own tests
can run it over fixture trees.

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

A lint/source rule covers root barrels so a helper added to an internal domain
barrel cannot become public accidentally through a chain of wildcards: ESLint
rejects `ExportAllDeclaration` in `packages/*/src/index.ts`, and the boundary
checker rejects it independently from the `exports` map's `"."` target.

`packages/image-core/src/index.ts` now lists 311 explicit exports, derived from
the names application source actually imports; no live export was renamed. Names
the application never imported — the package's internal `DiagnosticSink` among
them — are no longer public.

## Package-local TypeScript projects start now

Do not wait for Slice 6 to discover whether a package only typechecks because the
root Next application lends it aliases, DOM libraries, generated types, or other
ambient configuration.

The rule for every package, starting with `packages/image-core/tsconfig.json`:

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

The shared Vitest setup used to apply `src/test/setup.ts` to package tests. Vitest
projects replace it, as part of Slice 1 rather than Slice 6, so that:

- application tests keep `src/test/setup.ts`;
- `@vesper/image-core` tests run with no application setup;
- a future package receives only setup it explicitly owns;
- root script tests receive only root/tooling setup they need.

Package tests may still be launched from the repository root. "Independent" does
not mean a separate command developers have to remember; it means the package's
behavior is not established by another workspace's test environment.

## Prefer real workspace resolution over aliases

The repository used to map workspace package names directly to source in root
TypeScript and Vitest configuration. Those aliases are convenient, but they can
hide a broken `package.json`, `exports` map, workspace link, or lockfile importer.

Both aliases are gone: `@vesper/image-core` resolves through the workspace link
and the package's `exports` map in TypeScript, in Vitest, and in the Next build.
The standing rules are:

1. resolve a package through normal pnpm/package `exports` wherever it works;
2. if a tool genuinely requires a mapping, keep it exact-root-only — never add a
   wildcard such as `@vesper/* -> packages/*/src`;
3. keep the CI smoke check that imports each package by its public package name
   through the installed workspace, so manifest/exports wiring is exercised even
   if a tool later needs an alias again.

The root TypeScript project excludes `packages/` so package files are covered by
the package project rather than incidentally by the app's. Files the application
imports are still pulled into the app program as dependencies; the package
project is what covers the rest.

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

At least one small build/type fixture in a client-importable application surface
imports a designated runtime symbol from `@vesper/image-core`. The production
build must continue to accept that path after Slice 2. This catches a Node-only
transitive dependency that pure unit tests would not reveal.

`src/contracts/state/scene-gen.ts` is that fixture: it is client-importable and
consumes `sceneReferenceModeSchema` as a runtime value. `scene-gen.test.ts` pins
both facts — that the import is a runtime import rather than a type-only one, and
that the schema still behaves — so removing the last client-side import of the
package cannot quietly remove the guarantee.

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

`scripts/check-workspace-imports.test.ts` is the checker's regression suite. Each
case builds a throwaway repository, breaks exactly one thing, and asserts the
rule that fires; the legal trees must come back with no violations at all. It
covers, at minimum, fixtures for:

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

It also covers an escape laundered through a symlink, a package importing itself
by name, a package with no `"."` export, an unranked `@vesper/*` workspace, a
manifest-only graph cycle, and the universal-runtime rules in both directions
(a Node built-in and a server-only module rejected; a platform type in an
annotation accepted).

The test suite operates on temporary fixture trees rather than relying on there
currently being no violations in production source; otherwise it would prove only
the present repository state, not the checker semantics.

## Slice 1 completion gate

Slice 2 was blocked until all of these were true. Every line is met as of
2026-08-12.

- ✅ `lint:package-boundaries` checks cross-workspace relative paths in both
  directions, on resolved real paths;
- ✅ package code subpath imports are rejected;
- ✅ workspace and third-party dependency ownership is checked against the nearest
  manifest;
- ✅ package graph direction and cycles are checked;
- ✅ `image-core` has a package-local TypeScript project included in root
  typechecking;
- ✅ package tests no longer inherit application setup;
- ✅ package root wildcard exports are replaced and mechanically prohibited;
- ✅ package resolution has a real-workspace smoke check rather than relying only
  on source aliases;
- ✅ `image-core` is explicitly protected as browser/server portable;
- ✅ the guardrail fixture suite exists and its cases are green.

The boundary is now strong enough to serve as the template for
`@vesper/contracts` and `@vesper/image-replicate`.

## Adding a package after this

A new workspace package needs, in the same change: its `package.json` (name,
`"."` export, its own dependencies), a `tsconfig.json` plus a line in root
`pnpm typecheck`, a Vitest project if it has tests, a rank and runtime target in
the checker's layer policy, `transpilePackages` in `next.config.ts`, and a
manifest `COPY` line in the Dockerfile. The checker fails on the missing layer
rank, and the resolution smoke check fails on a missing or broken `exports` map,
so the two easiest omissions are caught rather than discovered in a build.
