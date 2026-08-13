# Monorepo follow-through — technical spec

Status: companion to [monorepo-simulation-core.plan.md](monorepo-simulation-core.plan.md)

The implementation contract for coding agents. Product scope, priority, and
open questions live in the plan; this document is how the decisions in it get
built. The first pass's guardrail spec
(`finished/monorepo-image-core.spec.guardrails.md`) remains the record of the
checker's original rules; this spec owns the changes to them.

## Scope

The workspace validation surface (root scripts, `vitest` configs,
`scripts/verify.sh` entry points), the boundary checker
(`scripts/check-workspace-imports.ts`) and resolution smoke check
(`scripts/check-package-resolution.ts`), the new `packages/simulation-core`
workspace, and the in-app splits of the image lifecycle files and simulation
stores. It leaves alone: the engine's durable stores' behavior, the database
schema, the chat pipeline/state/UI/client-API splits (owned by
[codebase-modularity.audit.md](codebase-modularity.audit.md)), and every
provider gateway.

## Implementation status

- **Slice 1 — package-owned validation:** built 2026-08-13 (PR #104). Root
  `typecheck`/`test` recurse; packages own their configs and scripts;
  `scripts/workspace-registration.test.ts` guards the Dockerfile COPYs and
  `transpilePackages`. `apps/web` owns `typecheck` but deliberately no `test`
  script — the `app`/`app-int` projects stay root-owned (repo-root cwd,
  `scripts/**` tripwires).
- **Slice 2 — declared subpath exports:** in progress.
- **Slice 3 — `@vesper/simulation-core` extraction:** not started; depends on
  slices 1–2.
- **Slice 4 — image lifecycle and store splits:** not started; runs after
  slice 3 so the store splits land on the post-extraction import graph.

## Slice 1 — package-owned validation

- Every workspace owns `"typecheck": "tsc -p tsconfig.json"`. The root
  `typecheck` checks its own tsconfig, then runs
  `pnpm -r --workspace-concurrency=1 run typecheck` (`-r` excludes the root
  workspace, so the script does not recurse into itself). Concurrency 1 is
  mandatory — the gates are serial by design on this machine.
- Every **package** owns a `vitest.config.ts` (node environment,
  `src/**/*.test.ts`, no aliases, no setup files) and a
  `"test": "vitest run"` script. The root `test` runs the root-owned suite,
  then `pnpm -r --workspace-concurrency=1 run test`; workspaces without a
  `test` script are skipped.
- The `app` / `app-int` projects stay in the **root** `vitest.config.ts` as a
  documented exception: they span `apps/web/src` **and** `scripts/`, several of
  their tests resolve source through `process.cwd()` (which must be the repo
  root), and they need the demo-mode setup file. Package projects never get an
  alias or setup file — a package test that leaned on the app's environment
  would prove the wrong thing.
- Invariant test (`scripts/workspace-registration.test.ts`, pure suite):
  enumerates workspace packages and asserts the registration points that stay
  deliberately explicit remain in sync — the Dockerfile `COPY` line per
  workspace manifest, and `transpilePackages` in `apps/web/next.config.ts`
  covering every `@vesper/*` dependency of the app. Registration points *not*
  asserted, because existing gates already self-enforce them: the layer policy
  (`package-layer-unknown` in `lint:package-boundaries`) and importability
  (`lint:package-resolution`).
- Adding a package after this slice means: the package's own manifest, tsconfig,
  vitest config and scripts; a layer rank + runtime in the checker policy;
  `transpilePackages`; the Dockerfile manifest `COPY`. Nothing else.

## Slice 2 — declared subpath exports

- The checker reads a package's **entire `exports` map**, not just `"."`. A
  code subpath import (`@vesper/x/foo`) is legal iff the target package
  declares `"./foo"` as an exact export entry resolving to an existing source
  file. `"./package.json"` remains metadata, not a precedent for code.
- **Exact entries only.** A `*` pattern in an exports key is a policy
  violation (its own rule code): a wildcard subpath surface is filesystem
  imports wearing a package name, and the public surface must be enumerated in
  the diff — the same philosophy as the root-barrel named-exports rule.
- The no-wildcard-barrel rule extends from the root export to **every declared
  code entry**: any published entry file must use named exports, not
  `export *`.
- A package may declare subpaths without declaring `"."`. Importing such a
  package by bare name still fails (`package-missing-root-export`); importing
  an undeclared subpath keeps failing (`package-code-subpath`, message updated
  to say "not a declared export").
- Layer direction, runtime, cycle, and dependency-ownership rules apply to
  subpath imports identically — the edge is package-to-package regardless of
  entry point.
- `scripts/check-package-resolution.ts` smoke-imports **every declared code
  entry** of every package, not just the root, so a stale exports map fails
  the `static` gate.
- The checker's own fixture-tree test suite
  (`scripts/check-workspace-imports.test.ts`) grows cases for: declared
  subpath passes; undeclared subpath fails; wildcard exports key fails;
  wildcard `export *` in a published subpath entry fails; subpath edge still
  subject to layer direction.

## Slice 3 — `@vesper/simulation-core`

- **Contents:** `apps/web/src/contracts/simulation/*` →
  `packages/simulation-core/src/contracts/*`; `apps/web/src/lib/simulation/*`
  → `packages/simulation-core/src/lib/*`. Tests move with their modules and
  run in the package's own vitest project (they are pure).
- **Manifest:** `@vesper/simulation-core`, universal runtime, dependencies
  `@vesper/contracts` + `zod` only. Layer rank **20 — deliberately equal to
  `@vesper/image-core`**, so neither image nor simulation package may import
  the other; both sit above `contracts` and below the applications.
- **Public surface:** per-module exact subpath exports —
  `./contracts/<module>` for each contract module, `./<module>` for each
  kernel module. The two wildcard `index.ts` barrels are deleted, not
  published; their ~42 barrel importers rewrite to per-module imports. App
  imports rewrite mechanically: `@/contracts/simulation/x` →
  `@vesper/simulation-core/contracts/x`, `@/lib/simulation/x` →
  `@vesper/simulation-core/x`. No compatibility re-export shims remain in the
  app.
- **Known seams**, resolved at extraction:
  - `lib/simulation/clock.ts` imports chat-lane clock vocabulary
    (`@/contracts/turns/chat-clock`, `@/lib/clock`). The package must not
    depend on the app: either the pure pieces it needs move into the package,
    or `clock.ts` (or the bridging part of it) stays in the app as
    orchestration. Decide by inspecting what its simulation-side consumers
    actually use; record the outcome here.
  - `lib/simulation/world-read.test.ts` and `world-beat.test.ts` import
    `@/lib/client/api` schemas — those are app-parity tests and stay on the
    app side rather than moving with the package.
  - Simulation test fixtures under `apps/web/src/test/sim-*.ts` move into the
    package (`src/test-support/`); if app-side tests also consume them, they
    are published as curated exact subpaths (e.g. `./testing/<fixture>`), and
    the test-support path keeps its test file-role classification.
- **Registration:** layer rank + runtime in the checker policy,
  `transpilePackages`, Dockerfile manifest `COPY`, package
  tsconfig/vitest/scripts per slice 1. `pnpm install` re-links the workspace
  (lockfile updates with the new importer).

### Slice 3 seam rulings

Recorded when the extraction lands.

## Slice 4 — image lifecycle and simulation store splits

Follow the split proposals in
[codebase-modularity.audit.md](codebase-modularity.audit.md) (they were drawn
from read line numbers; re-verify seams before cutting, since several files
have grown since the audit):

- `apps/web/src/server/images/identity-packs.ts` → modules along its existing
  section banners (store as the leaf; ensure/promotion/derive/read/manual/
  preparation/maintenance). The `registerIdentityPackMaintenance` module-load
  side effect must become an explicit import edge.
- `apps/web/src/server/images/identity-pack-trial.ts` → store / plan /
  execute / review.
- `apps/web/src/server/images/image-lab.ts` and
  `apps/web/src/server/images/prompts.ts` → per-family modules (the prompts
  split is the audit's lowest-risk cut).
- `apps/web/src/server/engine/simulation/`: extract the audit's R4 leaf
  modules (`body-rows`, `item-condition-store`, `material-rows`) to dissolve
  the three import cycles and the ~580 duplicated lines in
  `activity-store.ts`; then `body-store` → rows / reads / store,
  `household-store` → rows / lots / core.
- Constraints: modules stay inside the app; server modules keep communicating
  through their `index.ts` barrels; no new packages; `jscpd` and `lint:cycles`
  stay green; behavior is pinned by the existing pure and engine suites — no
  test rewrites beyond import paths and file moves.

## Persistence and resilience

No schema, migration, or trust-boundary changes anywhere in this plan — every
slice is structure-only. Existing diagnostics and `parseOr` boundaries move
with their modules unchanged.

## Fixtures and tests

- Slices 1–2: the checker's fixture-tree suite and the new registration
  invariant test, both in the pure suite.
- Slice 3: the moved simulation tests run in the package's vitest project;
  the engine integration suite (`pnpm verify engine`) must pass before the
  next deploy.
- Slice 4: no new fixtures; the existing image and engine suites pin
  behavior across the splits.
