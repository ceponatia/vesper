# `@vesper/contracts` — the shared foundation — slice 3

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 3

Give the two primitives both sides of the boundary need — diagnostics and
boundary parsing — one home, and delete the duplicate copy the image package
carries today. Shared mechanics are in
[monorepo-image-core.spec.md](monorepo-image-core.spec.md).

## Why this package, and why now

`packages/image-core/src/diagnostics.ts` re-declares `Diagnostic`,
`DiagnosticSeverity` and `DiagnosticSink` because the package must report
degradation without importing the app. Its own module comment calls the
duplication "deliberate and temporary" and names this slice as the resolution.

Two facts make it worth doing before slice 4 rather than after:

- **`diag` is a function, not a type.** The structural-interface trick that makes
  the duplicated `DiagnosticSink` work has no equivalent for a constructor. Any
  package that needs to *build* a diagnostic — which `image-replicate` does
  throughout — cannot use the current arrangement at all.
- **A second copy would be a third definition.** The drift test holds two
  declarations honest. It does not scale, and the failure mode is an inscrutable
  assignability error deep in a render path.

## Scope: exactly two primitives

**In:**

| From                           | Moves                                                    |
| ------------------------------ | -------------------------------------------------------- |
| `src/contracts/diagnostics.ts` | `Diagnostic`, `DiagnosticSeverity`, `DiagnosticSink`     |
| `src/contracts/diagnostics.ts` | The zod schema, `diag`, `DiagnosticCollector`, `teeSink` |
| `src/lib/parse.ts`             | `parseOr`, `parseOrNull`                                 |

**Out — and the discipline is the point.** This package does not become the
place things go when they are hard to place. It takes `zod` as its only
dependency and nothing that knows what a character, a chat, an image or a model
is. A foundation package that starts collecting whatever is convenient becomes
the coupling the boundary was built to prevent, with a friendlier name.

The name is `@vesper/contracts` per the target architecture. It does **not**
absorb `src/contracts/` wholesale — that folder holds Vesper's domain contracts
(attributes, meters, fact kinds, body locations), which are the game's core
vocabulary and belong to the application.

## Deletions this slice must make

An extraction that leaves the old definitions standing has added a package and
fixed nothing.

- `packages/image-core/src/diagnostics.ts` — deleted outright. `image-core`
  declares `@vesper/contracts` as a dependency and imports the three shapes.
- The `describe("diagnostic sink compatibility")` block in
  `src/contracts/images/identity-pack-boundary.test.ts` — deleted. It asserts
  two declarations stay assignable; after this slice there is one. The two
  boundary-parsing cases in that file stay and still pass.
- The stale `diagnostics.compat.test.ts` pointers in
  `packages/image-core/README.md` and the deleted module's comment go with them
  (hub spec §"Where diagnostics and boundary parsing live today").

## The import-churn decision

**Open question, owned by the plan.** It must be settled before the slice starts,
because it decides the shape of the diff and sets the precedent for every later
extraction.

The numbers: 230 files import `@/contracts` or `@/contracts/diagnostics`; 94
reference `parseOr`. Two options.

**Option A — the app's barrel re-exports the package.** `src/contracts/diagnostics.ts`
becomes `export * from "@vesper/contracts"`, and `src/lib/parse.ts` likewise.
No application file changes. The extraction diff is the package plus two
one-line files.

**Option B — repoint every importer.** The old paths stop existing. Roughly 300
files change their import lines.

**Recommended: Option A.** The root `CLAUDE.md` rule is against *compatibility
wrappers preserving legacy functionality* — code kept alive so callers need not
be updated. This is not that: `src/contracts/` is already the application's
barrel layer (`src/contracts/index.ts` exists and is how most of these 230 files
reach diagnostics at all), and a barrel re-exporting a package is publishing a
new home, not preserving an old API. Option B's 300-file diff carries real
review risk — a mechanical rewrite across the whole codebase is where an
unrelated change hides — for a benefit that is stylistic.

The condition that would make Option A wrong: if the re-export lets application
code keep importing things the package does not own, the barrel has become a
grab bag. Keep both re-export files to exactly the moved surface.

## Boundary parsing in the package

Once `parseOr` is available, `image-core` *may* own boundary parsing — but this
slice does not go looking for places to add it. The current arrangement (the
package owns schemas; the application parses at the trust boundary) is correct
for the identity-pack case and stays. The slice makes the primitive reachable;
a later change uses it where a package genuinely sits on a trust boundary.

`parseOr` pushes a `parse.boundary_failed` diagnostic with the caller's path,
and both existing cases in `identity-pack-boundary.test.ts` assert that code and
path. That behavior moves unchanged.

## Registration

Five files per the hub spec §"Adding a package": the manifest, `tsconfig.json`,
`vitest.config.ts`, `next.config.ts` `transpilePackages`, and the Dockerfile
manifest COPY. `pnpm-workspace.yaml` and `eslint.config.mjs` need no edit.

`packages/image-core/package.json` gains `"@vesper/contracts": "workspace:*"` as
a dependency, and imports it by name — never by path (hub spec
§"Package-to-package imports").

Update the root `CLAUDE.md` package inventory in the same change: it currently
reads "Today there is one package".

## Verification

- CI `verify` green.
- `grep -rn "interface Diagnostic\b" packages/ src/` returns exactly one hit.
- The two boundary-parsing cases in `identity-pack-boundary.test.ts` still pass;
  the compatibility case is gone rather than skipped.
- Nothing under `packages/` imports `@/` or climbs out with a relative path —
  the lint rule already proves this, and it is the reason a package can take the
  foundation as a dependency without weakening the boundary.
