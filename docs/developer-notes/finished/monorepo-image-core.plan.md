# Monorepo migration — the image engine as the first package

Status: shipped — 2026-08-12. Every slice is delivered and accepted. The
deployed verification passed on `vesper.fly.dev`: the existing image library
still reads from the Fly volume, a real render (`demo: false`, Replicate) wrote
beside it, a real model probe returned a fresh schema, and the root database
commands still run from the workspace root over `fly ssh`.

Nothing was left over. Slice 5 closed as a decision rather than a package — no
provider-neutral vision surface exists to extract, and the condition that would
reopen it is recorded in the spec index. Two follow-ups the move surfaced are
tracked outside this plan: 30 pre-existing resource-ID routes that the
incremental route-authorization gate has never inspected, and the root/`apps/web`
dependency duplication the migration deliberately left in place.

Outcome: A developer can open the image engine on its own — read it, test it,
and change how a model is driven — without the rest of the app in front of them,
so that a change to how pictures are made stops requiring the whole codebase in
your head.

## Why

The image code stopped being a feature and became a subsystem. It now carries a
provider-capability layer, per-model profiles and a registry, reference planning
by role, identity packs, LoRA handling, scene composition, an admin-only
experimental lab, control fixtures, evaluation tooling, storage lifecycle, and
several distinct generation and editing workflows. The lab alone is effectively
an experimental image product living inside the game.

Two problems follow from that size in one flat `src/`:

- **Nothing stops the layers mixing.** Provider-neutral concepts — attempt
  routing, reference capacity, failure classification — sit in the same folder
  as code that reads a character's garment exposure out of the database. Both
  are "images", so both are equally reachable, and the boundary only exists in
  whoever is reading at the time.
- **Reading any of it means loading all of it.** A developer changing how a
  control map binds to a provider field has the chat pipeline, the simulation
  engine, and the wardrobe model in scope, because everything is one program.

The fix is a real boundary, not a folder rename: workspace packages that the
application may depend on, but which cannot quietly reach back into the
application.

**Owner ruling (2026-08-12): the 2026-06-16 permanent deferral of the monorepo
split is reversed.** That ruling was correct for its question — packaging for
its own sake, gated on a second deployable. This is a different question. The
image subsystem outgrew the folder, and the trigger is legibility of one
subsystem, not deployment topology. `deferred.plan.md` no longer carries the
entry.

**Owner ruling (2026-08-12): package boundary now, repository boundary later.**
A separate `vesper-images` repository would immediately have to decide whether
it owns character profiles, garment exposure, the image database schema,
diagnostics, identity-pack records, visual state and chat scene references.
Owning them makes the game's simulation concepts depend on an image library;
not owning them makes the image repository depend heavily on the game. Neither
direction is attractive, and a monorepo package needs neither answer today — it
forces the hard architectural problem to be solved first, which is what would
make a future repository split cheap. See [Non-goals](#non-goals) for the
conditions that would change this.

**Owner ruling (2026-08-12): packages keep one curated root import.** Consumers
continue to import `@vesper/image-core` rather than a tree of subpaths, but the
root stops meaning "everything in the folder is public." Only entry points the
application actually consumes are exported; package-internal helpers stay
internal. Root package barrels use explicit exports; wildcard root exports are
not allowed to enlarge the public surface accidentally.

**Owner ruling (2026-08-12): workspace boundaries work both ways.** A package may
not escape into the application or another package by relative path, and the
application/root scripts/another package may not reach into a package through a
filesystem path. Cross-workspace code imports use the target package's declared
public entry point and a declared dependency. Package `exports` are defense in
depth, not the only thing protecting internals.

**Owner ruling (2026-08-12): packages prove independence before more extraction.**
Package-local TypeScript projects and package-scoped test setup are Slice 1 work,
not something deferred until the final `apps/web` move. A package is not treated
as independent while it still typechecks only because the root Next project lends
it aliases/types or its tests inherit application-global setup.

**Owner ruling (2026-08-12): runtime target is part of the package contract.**
`@vesper/image-core` and `@vesper/contracts` remain browser/server portable;
`@vesper/image-replicate` is deliberately server-only. The render-kernel move
must therefore not drag Node-only dependencies such as `node:crypto` into the
public `image-core` graph used by client-importable contracts.

**Owner ruling (2026-08-12): application barrels may re-export the shared
foundation.** Moving diagnostics and boundary parsing does not justify a
hundreds-file import rewrite. The existing application barrels remain the
application-facing homes and re-export only the primitives the shared package
owns.

**Owner ruling (2026-08-12): the `apps/web` move waits for the provider seam to
prove itself.** Slice 6 starts only after the Replicate extraction lands without
forcing a redesign of the boundary between the image core, the application, and
the provider transport.

## What the owner gets

Nothing changes on screen. This is developer-facing work, and its result is
measured in how the next image change goes.

- **A subsystem you can read on its own.** `packages/image-core` is the image
  engine with no game in it: what a model can do, which references a render may
  carry and in what role, how a prompt is compiled for a profile, what an
  identity pack is and when it is usable, what a failure message means.
- **A boundary that is mechanically checked.** Cross-workspace relative imports
  fail in either direction; deep package code subpaths fail; dependencies must
  belong to the workspace that imports them; and the package graph is checked
  for both cycles and forbidden direction.
- **A package that is independently typechecked and tested.** `image-core` does
  not borrow Next's project configuration or the application's global Vitest
  setup to prove that it works.
- **Faster, narrower model experimentation.** Adding or characterizing a model
  changes the provider-neutral package and, where needed, the provider package;
  game-specific scene and persistence code stays out of the way.
- **A cheaper future split.** If the image engine ever becomes its own product,
  the expensive part — deciding what it owns — is already done.

## Boundaries

### In scope

- Keeping the repository as a pnpm workspace, with the Next.js application at
  the repo root until the final slice.
- Extracting `@vesper/image-core` and moving into it only code that operates
  without knowing there is a database or a Next.js app.
- Completing the Slice 1 workspace-import, dependency-ownership, export-surface,
  package-typecheck and package-test guardrails before further extraction.
- Repointing application imports at package public APIs, and keeping tests with
  the code they cover.
- Moving the render kernel — the compile step every image lane goes through —
  across the same boundary by handing it the deployment-owned facts it needs.
- A tiny shared foundation for diagnostics and defensive boundary parsing.
- Replicate transport behind its own package, with environment and deployment
  configuration still owned by the application boundary.
- The conventional `apps/web` layout last, after the package/provider seam has
  been proven by real use.

### Non-goals

- **Moving Vesper-specific image code.** Character scenes, identity-pack
  lifecycle, asset persistence, the gallery, the chat scene queue, portrait
  routes, the model registry's database rows, authorization, job ownership and
  cost accounting stay in the application. Translating world state into an
  image request is application work; `renderCharacterSceneImage` is the clearest
  example and stays put.
- **Removing all image code from the web application.** The final shape still
  has an application-owned image layer. It translates Vesper state into image
  requests, persists assets, owns jobs and authorization, and calls the packages.
- **A general plugin architecture for providers.** The provider seam is shaped
  by the providers actually in use. A general plugin framework earns its place
  only when a second provider needs one.
- **Publishing any package.** Everything stays private to this workspace. No
  versioning, changelogs, or independent release cadence.
- **A separate repository.** Deferred behind the conditions below.

### When a separate repository would be justified

Any one of: another application wants to consume it; image processing becomes
independently deployed; it needs compute scaling separate from the game; its API
stabilizes enough that the app talks to it through a small public contract; it
develops its own release cadence; it is worth open-sourcing or distributing; or
it becomes useful without importing anything from the game. None hold today.

## Slices

### Slice 1 — the workspace exists and the image core is a package

Status: complete — 2026-08-12 (landed in PR #96; one typecheck defect it carried
is fixed in the Slice 2 PR).

The workspace and `@vesper/image-core` package exist and application imports
point at its public API. Review found that the first lint-only boundary was too
narrow: a relative path can escape a package without matching the spelling rule,
and consumers could still bypass the package root through filesystem deep
imports.

The full guardrail described in
[monorepo-image-core.spec.guardrails.md](monorepo-image-core.spec.guardrails.md)
is now in place, and it is what the rest of the migration is built on:

- resolved cross-workspace path enforcement in both directions;
- exact public package imports rather than code subpaths;
- workspace and third-party dependency ownership by nearest manifest;
- package graph cycle **and layer-direction** enforcement;
- explicit package root exports;
- a package-local TypeScript project included in root typechecking;
- package tests isolated from application-global setup;
- a real-workspace resolution smoke check so aliases cannot hide broken manifests;
- explicit browser/server portability for `image-core`;
- adversarial tests for the guardrail itself.

Two commands carry it — `pnpm lint:package-boundaries` for import integrity and
`pnpm lint:package-resolution` for real-workspace wiring — and both run in CI's
static gate.

**The slice merged with a red `verify`.** Trimming the package's public exports
to what the application imports missed one inline type reference, so typecheck
and the production build failed on a single missing export. Nothing about the
guardrail itself was wrong, and the fix rides with Slice 2; the detail is in
[the guardrails spec](monorepo-image-core.spec.guardrails.md) and
[the render-kernel spec](monorepo-image-core.spec.render-kernel.md).

### Slice 2 — the render kernel joins the package

Status: complete — 2026-08-12 (landed in PR #97 with a green `verify`).

Every kind of image the app makes — a portrait, a scene, a variant, a lab
experiment — passes through one step that turns "what this render wants" into
the exact instructions a provider is handed. Most stateful lookups are already
outside that step. The remaining application-owned inputs are deployment facts,
such as the current safety setting, plus one provider-field helper that belongs
in the core package.

The caller supplies those facts explicitly. The compile/planning logic can then
run with no database and no environment in the process while production keeps
the same output and timeout/version behavior.

Because `image-core` remains browser/server portable, the Node SHA-256 execution
currently used for render-control fingerprints stays in the application. The
package owns deterministic fingerprint payload construction/serialization; the
application applies the existing SHA-256 wrapper so stored hashes remain
byte-for-byte compatible. The Slice 2 spec carries the exact split.

### Slice 3 — the shared foundation becomes `@vesper/contracts`

Status: complete — 2026-08-12 (landed in PR #98 with a green `verify`).

The image package carried a temporary copy of the diagnostic shapes it needs to
report degradation. A tiny shared package gives diagnostics one owner and also
houses the defensive boundary parser, for packages that need to read untrusted
data. That parser is deliberately pre-positioned shared infrastructure; its being
available does not mean `image-core` starts parsing data it does not own.

The application keeps its existing diagnostics and parse import paths as narrow
re-export barrels, so no mechanical rewrite across hundreds of files was needed.

### Slice 4 — Replicate transport becomes `@vesper/image-replicate`

Status: complete — 2026-08-13 (PR #99; a real render and a real model probe both
succeeded on the deploy).

The code that talks to Replicate — probing model schemas, starting predictions,
uploading references, polling, downloading results and handling Replicate's
errors — moves behind its own package. The application keeps ownership of secrets
and deployment settings and creates one configured Replicate runtime for the
process, so the safety value recorded during planning is the value used when the
provider call is made.

This package is server-only from the application's point of view. UI and other
client-importable layers are mechanically prevented from importing it.

### Slice 5 — vision extraction decision

Status: complete — evaluated 2026-08-12; no extraction warranted.

"Images" now means two directions: making a picture, and a model looking at one.
The second path is live — it reads a portrait into character attributes, and it
describes photos a player attaches to a chat — but both consumers are still
mostly game concepts. What they share underneath is the general model-call layer
the narrator also uses, which is not an image concern.

No `@vesper/image-vision` package is created. Reconsider that package only when
at least two vision consumers demonstrably share a meaningful provider-neutral
visual-understanding contract or implementation — for example a common reading
vocabulary, grounding or provenance step, uncertainty/occlusion handling,
multi-image ordering, model capability negotiation, or degradation policy. A
third consumer is neither required nor sufficient by itself. Until such a seam
exists, an image-vision package would move names without moving ownership.

### Slice 6 — the application moves to `apps/web`

Status: complete — 2026-08-12. Its gate was met:
Slice 4 landed and was accepted without forcing a redesign of the
core/app/provider seam — the provider-neutral plan and result types were the
seam, and nothing in `image-core` had to change to support the transport
package.

Only after the provider extraction proves the package boundary does the Next.js
application move under `apps/web`. This is a path and workspace migration, not a
new architecture pass. The move explicitly preserves the things a green web
build can miss: root operational scripts, package typechecking, test discovery,
CI path classification, local environment loading, the Fly release command, and
the existing image-storage location.

The repository root remains the operational workspace root. `scripts/`,
`drizzle/`, deployment files and shared tooling stayed there; only the web
application moved.

The path audit covered more than literal `src/` strings: CWD-dependent
filesystem paths, `import.meta.url`/relative resource lookup, ignore files,
generated-output locations and other repository-root assumptions were each
classified. Two of them mattered enough to change how the app starts. The
persistent image directory is resolved from the repository, not from wherever
Next happens to be running, so the existing image library cannot appear empty
after the move; and the repository's `.env` is still the one environment file,
loaded before Next starts rather than discovered by it. Both live in a single
root launcher that every way of starting the app goes through. Next-aware ESLint
is pinned to `apps/web` and a test fails if that pin drifts.

## Where the work stands

Technical detail lives in [monorepo-image-core.spec.md](monorepo-image-core.spec.md),
which indexes one spec per remaining slice and owns their implementation status.
The package's current contract with the application is
[packages/image-core/README.md](../../packages/image-core/README.md) §Boundary.

| Spec                                                               | Covers             | State               |
| ------------------------------------------------------------------ | ------------------ | ------------------- |
| [spec.md](monorepo-image-core.spec.md)                             | Shared mechanics   | revised             |
| [spec.guardrails.md](monorepo-image-core.spec.guardrails.md)       | Slice 1 completion | complete 2026-08-12 |
| [spec.render-kernel.md](monorepo-image-core.spec.render-kernel.md) | Slice 2            | complete 2026-08-12 |
| [spec.foundation.md](monorepo-image-core.spec.foundation.md)       | Slice 3            | complete 2026-08-12 |
| [spec.replicate.md](monorepo-image-core.spec.replicate.md)         | Slice 4            | complete 2026-08-13 |
| [spec.apps-web.md](monorepo-image-core.spec.apps-web.md)           | Slice 6            | complete 2026-08-12 |

Slice 5 has no detail spec by design — the hub spec records the completed
no-extraction decision and the evidence that would justify reopening it.

## Success criteria

- A relative import that crosses workspace boundaries fails regardless of which
  side originates it, including sibling-package, repo-root and app-to-package
  deep-import escapes.
- Package code subpaths such as `@vesper/image-core/src/...` or
  `@vesper/image-core/internal` fail; consumers use the curated public root.
- Every workspace and third-party import is owned by the nearest workspace
  manifest with the correct runtime/test dependency class.
- The `@vesper/*` graph is both acyclic and consistent with the intended layer
  direction.
- Package root barrels cannot use wildcard exports to publish internal helpers
  accidentally.
- `packages/image-core` is independently typechecked and tested without the Next
  app project or application-global Vitest setup establishing its behavior.
- Real workspace/package `exports` resolution is exercised in CI rather than
  hidden entirely behind TypeScript/Vitest aliases.
- `@vesper/image-core` remains importable from a client-safe application surface
  after the render kernel moves; Node-only hashing does not enter its public
  runtime graph.
- Client-importable application code cannot import the Replicate transport
  package.
- The application's image behavior is unchanged at every extraction slice: the
  same rules and refusal paths remain covered, and the production build remains
  green.
- The compile step that decides what a provider is sent can be exercised with no
  database or environment read inside the package; fingerprint serialization is
  package-owned and the final stored SHA-256 value remains unchanged.
- Exactly one definition of the diagnostic contract exists in the repository.
- After the Replicate extraction, one real render and one real model probe both
  succeed using the configured package.
- Moving to `apps/web` does not change the persistent image path, break root DB
  or eval scripts, narrow CI by accident, leave package source outside
  TypeScript/test coverage, or silently change another CWD-relative filesystem
  path.

## Open questions

None. The remaining choices are implementation mechanics owned by the companion
specs; import integrity, runtime targets, package test/typecheck independence,
public export policy, foundation re-export policy, and the Slice 6 gate are
settled above.