# Monorepo migration — the image engine as the first package

Status: active (started 2026-08-12)

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
internal.

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
- **A boundary that is mechanically checked.** A package cannot reach application
  code or another package through a relative-path escape; another package is a
  declared dependency imported by name. The first package extraction exposed a
  gap in the initial lint-only check, so closing that gap is the remaining work
  in Slice 1 before more code crosses the boundary.
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
- Closing the remaining package-boundary enforcement gap before further
  extraction.
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

Status: in progress — extraction landed 2026-08-12; boundary-enforcement repair remains.

The workspace and `@vesper/image-core` package exist and application imports
point at its public API. Review found one important hole in the first guardrail:
a relative import can still escape into a sibling package without matching the
current lint pattern. Before more code moves, the boundary becomes a resolved
path check rather than a spelling check, and package-to-package imports are
required to name a declared workspace dependency.

### Slice 2 — the render kernel joins the package

Status: blocked on Slice 1's boundary-enforcement repair.

Every kind of image the app makes — a portrait, a scene, a variant, a lab
experiment — passes through one step that turns "what this render wants" into
the exact instructions a provider is handed. Most stateful lookups are already
outside that step. The remaining application-owned inputs are deployment facts,
such as the current safety setting, plus one provider-field helper that belongs
in the core package.

The caller supplies those facts explicitly. The compile step and its
configuration fingerprint can then run with no database and no environment in
the process, while production keeps the same output and timeout/version behavior.

### Slice 3 — the shared foundation becomes `@vesper/contracts`

Status: queued behind Slice 2 — unblocks Slice 4.

The image package currently carries a temporary copy of the diagnostic shapes it
needs to report degradation. A tiny shared package gives diagnostics one owner
and also houses the existing defensive boundary parser for packages that need to
read untrusted data. The parser is deliberately pre-positioned shared
infrastructure; moving it does not mean `image-core` must start parsing data it
does not own.

The application keeps its existing diagnostics and parse import paths as narrow
re-export barrels, avoiding a mechanical rewrite across hundreds of files.

### Slice 4 — Replicate transport becomes `@vesper/image-replicate`

Status: blocked on Slices 2 and 3.

The code that talks to Replicate — probing model schemas, starting predictions,
uploading references, polling, downloading results and handling Replicate's
errors — moves behind its own package. The application keeps ownership of secrets
and deployment settings and creates one configured Replicate runtime for the
process, so the safety value recorded during planning is the value used when the
provider call is made.

This package is server-only from the application's point of view. UI and other
client-importable layers are mechanically prevented from importing it.

### Slice 5 — the vision path

Status: blocked — nothing provider-neutral to move yet.

"Images" now means two directions: making a picture, and a model looking at one.
The second path is live — it reads a portrait into character attributes, and it
describes photos a player attaches to a chat — but both consumers are still
mostly game concepts. What they share underneath is the general model-call layer
the narrator also uses, which is not an image concern.

A vision package starts only when a third consumer arrives, or the existing two
are found to share a genuine contract such as a common reading vocabulary,
grounding step, or degradation policy. Until then, an empty package would make
the diagram prettier without making the code easier to own.

### Slice 6 — the application moves to `apps/web`

Status: blocked on Slice 4 completing without a core/app/provider seam redesign.

Only after the provider extraction proves the package boundary does the Next.js
application move under `apps/web`. This is a path and workspace migration, not a
new architecture pass. The move explicitly preserves the things a green web
build can miss: root operational scripts, package typechecking, test discovery,
CI path classification, local environment loading, the Fly release command, and
the existing image-storage location.

The repository root remains the operational workspace root. `scripts/`,
`drizzle/`, deployment files and shared tooling stay there; only the web
application moves.

## Where the work stands

Technical detail lives in [monorepo-image-core.spec.md](monorepo-image-core.spec.md),
which indexes one spec per remaining slice and owns their implementation status.
The package's current contract with the application is
[packages/image-core/README.md](../../packages/image-core/README.md) §Boundary.

| Spec                                                               | Covers           | State   |
| ------------------------------------------------------------------ | ---------------- | ------- |
| [spec.md](monorepo-image-core.spec.md)                             | Shared mechanics | revised |
| [spec.render-kernel.md](monorepo-image-core.spec.render-kernel.md) | Slice 2          | revised |
| [spec.foundation.md](monorepo-image-core.spec.foundation.md)       | Slice 3          | revised |
| [spec.replicate.md](monorepo-image-core.spec.replicate.md)         | Slice 4          | revised |
| [spec.apps-web.md](monorepo-image-core.spec.apps-web.md)           | Slice 6          | revised |

Slice 5 has no spec by design — the hub spec carries its inventory and the
condition that would start it.

## Success criteria

- A package-relative import that resolves outside its own package fails the
  repository gate, including sibling-package and repo-root escapes.
- Every `@vesper/*` package import is by package name and is declared in the
  importing package's manifest.
- Client-importable application code cannot import the Replicate transport
  package.
- The application's image behavior is unchanged at every extraction slice: the
  same rules and refusal paths remain covered, and the production build remains
  green.
- A developer can read and exercise `packages/image-core` without importing
  application code or depending on application test setup.
- The compile step that decides what a provider is sent can be exercised, and
  its configuration fingerprint checked, with no database or environment read
  inside the package.
- Exactly one definition of the diagnostic contract exists in the repository.
- After the Replicate extraction, one real render and one real model probe both
  succeed using the configured package.
- Moving to `apps/web` does not change the persistent image path, break root DB
  or eval scripts, narrow CI by accident, or leave package source outside
  TypeScript/test coverage.

## Open questions

None. The remaining choices are implementation mechanics owned by the companion
specs; the package surface, foundation re-export policy, and Slice 6 gate are
settled above.
