# `@vesper/contracts` — the shared foundation — slice 3

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 3

Implementation state: not started — queued behind Slice 2 by delivery order.

Give the small primitives that genuinely cross package boundaries one home, and
delete the temporary diagnostic copy in `image-core`. Shared mechanics are in
[monorepo-image-core.spec.md](monorepo-image-core.spec.md).

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
application barrels.

## Public export surface

`@vesper/contracts` follows the monorepo's curated-root ruling:

- one public root import path;
- explicit exports for diagnostics and parsing;
- no deep public subpaths;
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

Before Slice 6, use the shared registration points from the hub spec:

- `packages/contracts/package.json`;
- root `tsconfig.json` package mapping;
- root `vitest.config.ts` package mapping;
- `next.config.ts` `transpilePackages`;
- Dockerfile manifest copy.

`packages/contracts/package.json` declares:

- `"name": "@vesper/contracts"`;
- `"version": "0.0.0"`;
- `"private": true`;
- `"type": "module"`;
- `zod` as its runtime dependency.

`packages/image-core/package.json` gains
`"@vesper/contracts": "workspace:*"` and imports diagnostics by package name.

The Slice 1 package-boundary checker must already be active before this package
is added, so a relative import from `image-core` into `packages/contracts` fails
rather than becoming the precedent.

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

Foundation tests have no application setup, DB, env or Next dependency. They run
under the shared repository test command but are fully package-contained.

## Invariants

1. There is exactly one diagnostic contract definition.
2. `image-core` and future packages import diagnostics from
   `@vesper/contracts`, never from `src/contracts`.
3. Application code may keep the existing diagnostics/parse paths only because
   those files are explicit re-export barrels with no implementation.
4. `@vesper/contracts` contains no Vesper domain vocabulary.
5. Parser behavior and diagnostic codes do not change during extraction.
6. `parseOr` is not introduced into new call sites merely because it became
   available to packages.
7. Package-to-package imports are by declared workspace dependency name.

## Verification

- CI `verify` is green for the Slice 3 PR.
- `grep`/symbol search finds one implementation of `diag`,
  `DiagnosticCollector`, `parseOr` and `parseOrNull`.
- The old diagnostic compatibility test is deleted, not skipped.
- Existing application boundary-parsing tests still assert their fallback and
  diagnostic code.
- `lint:package-boundaries` proves `image-core -> contracts` is a declared
  package dependency rather than a relative escape.
- No file under `packages/contracts` imports the application or reads
  `process.env`.
