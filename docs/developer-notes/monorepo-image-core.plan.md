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

The fix is a real boundary, not a folder rename: a workspace package the
application depends on, which cannot depend on the application back.

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

## What the owner gets

Nothing changes on screen. This is developer-facing work, and its result is
measured in how the next image change goes.

- **A subsystem you can read on its own.** `packages/image-core` is the image
  engine with no game in it: what a model can do, which references a render may
  carry and in what role, how a prompt is compiled for a profile, what an
  identity pack is and when it is usable, what a failure message means.
- **A boundary a mistake cannot cross quietly.** The package may not import
  application code at all — not by the app's alias and not by a relative path
  climbing out of the package, because both spellings reach the same modules.
  Either one fails `pnpm lint`, so the separation stays true without anyone
  policing it in review.
- **Faster, narrower model experimentation.** Adding or characterizing a model
  touches the package and its tests, not the app.
- **A cheaper future split.** If the image engine ever becomes its own product,
  the expensive part — deciding what it owns — is already done.

## Boundaries

### In scope

- Turning the repository into a pnpm workspace, with the Next.js application
  staying at the repo root for now.
- Extracting `@vesper/image-core` and moving into it only code that already
  operates without knowing there is a database or a Next.js app.
- A lint rule that fails the build when a package imports application code.
- Repointing every application import at the package's public API, and keeping
  the tests that moved with the code they cover.

### Non-goals

- **Moving the application to `apps/web`.** A later, separate step — combining
  it with the first extraction would mix a path-alias, Docker, CI and test
  reshuffle into the work of finding the subsystem boundary.
- **`@vesper/image-replicate` and `@vesper/image-vision`.** Both are wanted;
  neither is created until the core's interface has settled under real use.
  Replicate transport (prediction creation and polling, provider input
  serialization, output retrieval, version pins, model-specific input mapping)
  stays in `src/server/ai` until then.
- **Extracting `@vesper/contracts`.** Named in the target shape, not built here.
  See [Open questions](#open-questions).
- **Moving Vesper-specific image code.** Character scenes, identity-pack
  lifecycle, asset persistence, the gallery, the chat scene queue, portrait
  routes, the model registry's database rows, authorization, job ownership and
  cost accounting stay in the application. Translating world state into an
  image request is application work; `renderCharacterSceneImage` is the clearest
  example and stays put.
- **A separate repository.** Deferred behind the conditions below.

### When a separate repository would be justified

Any one of: another application wants to consume it; image processing becomes
independently deployed; it needs compute scaling separate from the game; its API
stabilizes enough that the app talks to it through a small public contract; it
develops its own release cadence; it is worth open-sourcing or distributing; or
it becomes useful without importing anything from the game. None hold today.

## Slices

- **Slice 1 — the workspace exists and the image core is a package.**
  Status: complete — 2026-08-12. The repository is a pnpm workspace,
  `@vesper/image-core` holds the demonstrably pure image code, the boundary is
  lint-enforced against both spellings of an app import, and every application
  import points at the package's public API.

- **Slice 2 — the render kernel joins the package.** Status: queued.
  `render-intent.ts` and `render-profile.ts` are the compile step every lane now
  goes through, and both are nearly pure — what holds them back is that they
  reach the model registry and the LoRA library through database-backed
  lookups. Inverting those two reads (the caller resolves the row; the package
  compiles the plan) moves the kernel across.

- **Slice 3 — Replicate transport becomes `@vesper/image-replicate`.**
  Status: blocked on slice 2. Only worth doing once the core's provider
  interface has held still through a real model addition, so the adapter is
  written against a settled seam rather than the current one.

- **Slice 4 — the application moves to `apps/web`.** Status: queued behind a
  deliberate soak. The conventional monorepo shape, taken only after the
  package boundary has run long enough to prove it was drawn in the right place.

## Where the work stands

This plan has no spec yet and owns its own slice status until it grows one.
Slice 1's design decisions are recorded in
[packages/image-core/README.md](../../packages/image-core/README.md) §Boundary —
the package's own contract with the application — and in the module comments the
extraction touched.

## What moved, and what did not

The test applied to every candidate: does it already run without knowing there
is a database, a route, a character, a chat, or a simulation engine?

Moved — the package's domains, one folder each:

| Folder                 | Owns                                                      |
| ---------------------- | --------------------------------------------------------- |
| `capabilities/`        | What a model declares; binding controls to real fields     |
| `models/`              | Registry row shape, per-task profiles, reviewed presets    |
| `loras/`               | LoRA definitions and render bindings                       |
| `render-intent/`       | What one render asks for, in one vocabulary                |
| `references/`          | Reference shapes, roles, and the prompts that name them    |
| `identity/`            | Identity packs: schema, policy, cropping, quality, trials  |
| `lab/`                 | Advanced Image Lab contracts, recipes, instruction text    |
| `geometry/`            | Crop math                                                  |
| `provider-interface/`  | Attempt routing, reference capacity, failure vocabulary    |

Stayed, and why:

- **`prompts.ts`** — pure, but it is pure *Vesper*: attributes, species, garment
  visibility, body locations, world profiles. It composes the game's state into
  image-facing text, which is application work by definition.
- **`viewer-body.ts`** — reads the game's item-visibility model.
- **`identity-packs.ts`, `identity-pack-trial.ts`, `image-lab.ts`,
  `character-scene.ts`, `scene.ts`, `assets.ts`, `avatar.ts`, `variants.ts`,
  `upload.ts`** — all persistence, ownership, job state and event logging.
- **`replicate.ts`, `replicate-probe.ts`** — transport, awaiting slice 3.

One module was split rather than moved: the provider seam. The classification
rules and attempt routing are in the package; what stayed in `src/server/ai` is
the four-line adapter that digs a real message out of an AI-SDK `APICallError`,
because only a transport knows that error shape.

## Success criteria

- `pnpm lint` fails on an app import added anywhere under `packages/`, whether
  it is written as `@/server/db` or as `../../../src/server/db`.
- The application's image behavior is unchanged: the same suites cover the same
  rules, moved next to the code they test, and CI's `verify` is green.
- A developer can read `packages/image-core` start to finish and never need to
  know what a chat is.

## Open questions

- **Where do `Diagnostic` and `parseOr` live?** Both are generic, pure, and used
  by the whole application; the package needs the first and will eventually want
  the second. Today the package declares its own structural `Diagnostic` /
  `DiagnosticSink` and owns no boundary parser, with a compile-time
  compatibility check in `src/contracts/images/identity-pack-boundary.test.ts`
  to catch drift. The alternative is a small `@vesper/contracts` package that
  both depend on. Resolving this is a precondition for slice 3, which will want
  the same primitives.
  Detail: [packages/image-core/src/diagnostics.ts](../../packages/image-core/src/diagnostics.ts).
- **Does the package publish a curated surface or a wide barrel?** Its root
  barrel currently re-exports every domain, which is why the application's
  import churn was mechanical. Whether some domains should stay behind subpath
  exports is worth deciding before a second package copies the pattern.
