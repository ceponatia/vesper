# `@vesper/contracts` — the shared foundation — slice 3

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 3

Implementation state: not started — next, now that Slice 2 has been built.

Give the small primitives that genuinely cross package boundaries one home, and
delete the temporary diagnostic copy in `image-core`. Shared mechanics are in
[monorepo-image-core.spec.md](monorepo-image-core.spec.md); package registration,
import integrity and runtime-target guardrails are already active from
[monorepo-image-core.spec.guardrails.md](monorepo-image-core.spec.guardrails.md).

## Why this package, and why now

`packages/image-core/src/diagnostics.ts` re-declares `Diagnostic`,
`DiagnosticSeverity` and `DiagnosticSink` because the package must report
degradation without importing the app. That duplication was intentionally
temporary.

A second package makes it time to remove it:

- **`diag` is executable behavior, not only a structural type.** A transport
  package that builds diagnostics needs one canonical function.
- **Three copies would defeat the point.** A compatibility test can hold two
  structural declarations honest; it is not a package architecture.

The existing `parseOr` / `parseOrNull` helpers also belong in the shared
foundation because they are generic trust-boundary behavior rather than game
domain vocabulary. `image-core` does not need them today. Moving them is a
deliberate pre-positioning decision for shared package boundaries, not a reason
to make the core parse application-owned data.

## Runtime target

`@vesper/contracts` is a **pure, browser/server-portable package**.

It may depend on runtime-neutral libraries such as `zod`, but it does not gain:

- Next/server framework dependencies;
- Node-only filesystem/crypto/network modules;
- persistence;
- ambient environment reads;
- clock/random behavior;
- Vesper game-domain vocabulary.

Its package-local TypeScript project must reflect that runtime instead of
borrowing the web application's Next plugin or `@/*` alias.

## Scope: exactly two primitive groups

### Diagnostics

Move from `src/contracts/diagnostics.ts`:

- `diagnosticSeveritySchema`;
- `DiagnosticSeverity`;
- `diagnosticSchema`;
- `Diagnostic`;
- `DiagnosticSink`;
- `DiagnosticCollector`;
- `teeSink`;
- `diag`.

### Defensive boundary parsing

Move from `src/lib/parse.ts`:

- `parseOr`;
- `parseOrNull`;
- the private issue-summary helper they require.

The package takes `zod` as its only third-party runtime dependency.

## What this package does not become

`@vesper/contracts` is **not** the new location for `src/contracts/` as a whole.
The application's contracts folder contains Vesper's game vocabulary —
attributes, meters, body locations, item visibility, species, facts and other
domain contracts. Those remain application-owned.

A rule of thumb:

- if a primitive can describe a chat, character or simulation concept, it
  probably stays in the application;
- if it is generic infrastructure for package/application boundaries, it may
  belong here;
- convenience alone is never a reason to move something into the foundation.

## Deletions this slice must make

An extraction that leaves the duplicate definitions in place has not completed
the job.

- Delete `packages/image-core/src/diagnostics.ts`.
- Delete the diagnostic assignability/compatibility test that exists only to
  keep two declarations synchronized.
- Remove stale comments pointing at the deleted compatibility arrangement.
- Replace application implementation files for diagnostics/parsing with narrow
  re-export barrels, not copied implementations.

## Import-churn ruling

**Ruling (2026-08-12): keep the application's existing import paths as narrow
re-export barrels.** Do not rewrite hundreds of application imports solely to
advertise the package move.

After the extraction:

```ts
// src/contracts/diagnostics.ts
export {
  DiagnosticCollector,
  diagnosticSchema,
  diagnosticSeveritySchema,
  diag,
  teeSink,
  type Diagnostic,
  type DiagnosticSeverity,
  type DiagnosticSink,
} from "@vesper/contracts";
```

and:

```ts
// src/lib/parse.ts
export { parseOr, parseOrNull } from "@vesper/contracts";
```

Use explicit exports rather than `export *`. These files are application-facing
barrels and should publish exactly the surfaces they owned before the move. They
must contain no implementation.

This is not a compatibility implementation shim: the application barrels remain
valid architectural entry points while the implementation gains a shared owner.

Package code imports `@vesper/contracts` directly. It never imports the
application barrels or the package through a filesystem/deep subpath.

## Public export surface

`@vesper/contracts` follows the monorepo's curated-root ruling:

- one public root code import path;
- explicit named exports for diagnostics and parsing;
- no root `export *`;
- no deep public code subpaths;
- no app-domain contract re-exports.

The small surface is intentional. A caller should be able to read
`packages/contracts/src/index.ts` and know the complete shared foundation.

## Boundary parsing behavior stays unchanged

`parseOr` and `parseOrNull` keep their existing semantics:

- accept an already-parsed unknown value or a JSON-looking string;
- attempt JSON decoding only for object/array-looking strings;
- never throw on schema rejection;
- return the supplied fallback / `null`;
- report `parse.boundary_failed` through the optional diagnostic sink;
- summarize rather than persist an entire zod error object.

Moving these functions must not widen where parsing happens. The application
continues to parse database/request/LLM boundaries where it already does. A
package adopts `parseOr` only when that package itself owns the trust boundary.

## Registration

Use the registration/integrity checklist from the hub and Slice 1 guardrails.
This package is not considered registered until all of these agree:

- `packages/contracts/package.json` with curated root exports and owned deps;
- `packages/contracts/tsconfig.json` with the universal runtime target;
- root `pnpm typecheck` includes the package project;
- root Vitest discovers its tests without application-global setup;
- `next.config.ts` lists it in `transpilePackages` if the web app imports it;
- Dockerfile copies its manifest before workspace install;
- the real-workspace/package-name CI smoke check resolves `@vesper/contracts`;
- `lint:package-boundaries` recognizes its allowed package-graph edges.

Do not add wildcard TypeScript/Vitest aliases. If a tool temporarily requires an
exact root-name mapping, normal workspace/package `exports` resolution still has
to be exercised separately in CI.

`packages/contracts/package.json` declares:

- `"name": "@vesper/contracts"`;
- `"version": "0.0.0"`;
- `"private": true`;
- `"type": "module"`;
- `zod` as its runtime dependency.

`packages/image-core/package.json` gains
`"@vesper/contracts": "workspace:*"` and imports diagnostics by exact package
root name.

The Slice 1 workspace checker must already be active before this package is
added, so a relative import from `image-core` into `packages/contracts` or an
application relative deep import into `contracts/src` fails rather than becoming
the precedent.

Update the root package inventory documentation in the implementation PR to say
there are two packages.

## Tests

### Diagnostics

Move or recreate the diagnostics unit coverage beside the package implementation.
The application should not maintain a second behavioral test suite for the same
functions merely because it re-exports them.

Delete the old bidirectional structural-assignability test; with one declaration
there is nothing left to compare.

### Boundary parsing

Move the parser unit coverage to `@vesper/contracts`. The existing
identity-pack-boundary cases that prove an application trust boundary emits
`parse.boundary_failed` remain application tests and continue importing through
the application barrel.

### Package independence

Foundation tests run in the package-scoped Vitest project already established by
Slice 1. They have no application setup, DB, env or Next dependency. The
package-local TypeScript project covers all package source/tests without the app
alias or Next plugin.

## Invariants

1. There is exactly one diagnostic contract definition.
2. `image-core` and future packages import diagnostics from
   `@vesper/contracts`, never from `src/contracts` or a filesystem/deep package
   path.
3. Application code may keep the existing diagnostics/parse paths only because
   those files are explicit re-export barrels with no implementation.
4. `@vesper/contracts` contains no Vesper domain vocabulary.
5. `@vesper/contracts` remains browser/server portable.
6. Parser behavior and diagnostic codes do not change during extraction.
7. `parseOr` is not introduced into new call sites merely because it became
   available to packages.
8. Package-to-package imports are by declared workspace dependency root name.
9. Package root exports remain explicit and curated.

## Verification

- CI `verify` is green for the Slice 3 PR.
- package-local typecheck and package-scoped tests are green;
- the real-workspace import smoke check resolves `@vesper/contracts` through its
  manifest/exports;
- `grep`/symbol search finds one implementation of `diag`,
  `DiagnosticCollector`, `parseOr` and `parseOrNull`;
- the old diagnostic compatibility test is deleted, not skipped;
- existing application boundary-parsing tests still assert their fallback and
  diagnostic code;
- `lint:package-boundaries` proves `image-core -> contracts` is an allowed,
  declared package dependency and rejects relative/deep-import alternatives;
- no file under `packages/contracts` imports the application, reads
  `process.env`, or introduces Node-only runtime dependencies.
