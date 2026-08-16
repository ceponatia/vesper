# Monorepo follow-through — self-validating workspaces and the simulation package

Status: shipped — 2026-08-14. All four slices built 2026-08-13 with every local
gate, the engine suite, and the production build passing; the 2026-08-13
deploys carried the extraction and splits, and the owner verified the deployed
app serves chats unchanged (2026-08-14). No leftovers queued: further package
extractions stay banned until a real boundary earns one (this plan's standing
non-goal), and the remaining giant-file splits stay with
[codebase-modularity.audit.md](../codebase-modularity.audit.md).

Outcome: A developer can drop a new code package into the repository and every
check, build, and deployment picks it up automatically — and the
world-simulation code now lives in such a package — so that growing the
simulation engine stops growing the web application it used to live inside.

## Why

The first monorepo pass ([finished/monorepo-image-core.plan.md](../finished/monorepo-image-core.plan.md))
moved the application to `apps/web` and extracted the image engine into
packages, but it left three frictions behind:

- **The workspace does not scale by itself.** The root scripts name every
  package by hand — adding one means editing the root typecheck chain, the root
  test runner, and remembering every other registration point. The package list
  is written in five places and only convention keeps them agreeing.
- **A package may publish exactly one entry point.** The boundary rules allow
  importing a package only by its bare name. That fits the image packages,
  whose surface is one curated barrel, but the simulation domain is dozens of
  focused modules — forcing them through a single barrel would either create a
  monster export list or push consumers back to deep filesystem imports.
- **The simulation domain still lives inside the web app**, though nothing
  about it is web-specific: its contracts and kernels are pure, and the app
  consumes them the same way it consumes the image engine. Meanwhile several
  application files have grown past the point where they can be read whole.

## What the owner gets

- **Adding a package is dropping a folder.** A new package brings its own
  checks with it; the repository-wide gate finds them without anyone editing
  root files. The few registration points that must stay hand-written (the
  Docker build's manifest list, the app's compile list) are guarded by a test
  that fails when they fall out of sync.
- **Packages can publish more than one entry point.** A package declares which
  of its modules are public, consumers import exactly those, and the boundary
  gate still rejects any import that reaches into undeclared internals.
- **The simulation domain is a package.** `@vesper/simulation-core` holds the
  engine's pure contracts and kernels; the web app keeps only its durable
  stores and orchestration and consumes the package one-way, like any other.
- **The biggest image and simulation files read in one sitting.** The image
  lifecycle files and the simulation stores split along their existing seams,
  inside the app, without inventing new packages to hold the pieces.

## Boundaries

### In scope

The four slices below: package-owned validation, declared subpath exports in
the boundary checker, the `@vesper/simulation-core` extraction, and the
application-side splits of the image lifecycle files and simulation stores.

### Non-goals

- **No further package extractions after `simulation-core`.** The next
  subsystem earns a package through a real dependency or runtime boundary — a
  second consumer, a separate deploy target — never through tidiness. This is
  the plan's standing rule, not a queued slice.
- **Durable simulation stores and Vesper orchestration stay in the app.** The
  package holds what is pure; everything that touches the database or the
  provider gateways remains `apps/web` code.
- **The other giant files stay where they are for now.** The chat pipeline,
  chat state, database schema, chat UI, and client API splits remain owned by
  [codebase-modularity.audit.md](../codebase-modularity.audit.md) for a later
  plan; the schema split in particular needs a human migration check this plan
  does not attempt.
- **No behavior changes.** Every slice is structure-only; the app on Fly
  behaves identically before and after.

## Slices

- **Slice 1 — every workspace validates itself.** Status: complete — 2026-08-13. Each
  workspace owns its typecheck and test scripts; the root orchestrates them
  recursively instead of naming packages; an invariant test guards the
  registration points that stay explicit.
- **Slice 2 — the boundary checker understands declared entry points.**
  Status: complete — 2026-08-13. A package may declare public subpaths; imports of declared
  subpaths pass, filesystem and undeclared deep imports still fail, and the
  resolution smoke check covers every declared entry.
- **Slice 3 — the simulation domain becomes `@vesper/simulation-core`.**
  Status: complete — 2026-08-13. The pure simulation contracts and kernels move out of the
  app into one package with per-module entry points; the app's imports are
  rewritten and its stores stay behind.
- **Slice 4 — the giant image and simulation-store files split along their
  seams.** Status: complete — 2026-08-13. The image lifecycle files and the four biggest
  simulation stores become focused modules inside the app, following the
  split proposals the modularity audit already drew.

## Where the work stands

- **[monorepo-simulation-core.spec.md](monorepo-simulation-core.spec.md)** —
  complete 2026-08-13; all four slices built and accepted with the plan
  2026-08-14.

## Success criteria

- A throwaway package added with its own scripts is exercised by the verify
  gate with no root edits; deleting it leaves nothing stale behind.
- An import of a declared package subpath passes the boundary gate; an
  undeclared deep import of the same package still fails it.
- `apps/web/src` contains no simulation contracts or kernels; the full gate
  set and the production build pass; the deployed app serves successor chats
  unchanged.
- Each targeted image and store file lands as modules a reader can hold — no
  successor module near the old size — with the existing test suites passing
  unchanged.

## Open questions

None open — the decisions this work needed are recorded in the spec.

## Technical companion

[monorepo-simulation-core.spec.md](monorepo-simulation-core.spec.md) —
orchestration shape, checker semantics, package layout, split maps.
