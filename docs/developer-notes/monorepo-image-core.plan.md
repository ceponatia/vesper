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
  staying at the repo root until the final slice.
- Extracting `@vesper/image-core` and moving into it only code that already
  operates without knowing there is a database or a Next.js app.
- A lint rule that fails the build when a package imports application code.
- Repointing every application import at the package's public API, and keeping
  the tests that moved with the code they cover.
- Moving the render kernel — the compile step every image lane goes through —
  across the same boundary, by having callers supply what it used to look up.
- A small shared foundation package for the two primitives both sides need: a
  way to report degradation, and a way to read untrusted data without throwing.
- Replicate transport behind its own package, once the seam it plugs into has
  held still through real use.
- The conventional `apps/web` layout, last, after the boundary has soaked.

### Non-goals

- **Moving Vesper-specific image code.** Character scenes, identity-pack
  lifecycle, asset persistence, the gallery, the chat scene queue, portrait
  routes, the model registry's database rows, authorization, job ownership and
  cost accounting stay in the application. Translating world state into an
  image request is application work; `renderCharacterSceneImage` is the clearest
  example and stays put.
- **A general plugin architecture for providers.** The provider interface is
  shaped by the providers actually in use. It gains an abstraction when a second
  provider needs it, not in anticipation.
- **Publishing any package.** Everything stays private to this workspace. No
  versioning, no changelogs, no release cadence.
- **A separate repository.** Deferred behind the conditions below.

### When a separate repository would be justified

Any one of: another application wants to consume it; image processing becomes
independently deployed; it needs compute scaling separate from the game; its API
stabilizes enough that the app talks to it through a small public contract; it
develops its own release cadence; it is worth open-sourcing or distributing; or
it becomes useful without importing anything from the game. None hold today.

## Slices

### Slice 1 — the workspace exists and the image core is a package

Status: complete — 2026-08-12.

The repository is a pnpm workspace, `@vesper/image-core` holds the demonstrably
pure image code, the boundary is lint-enforced against both spellings of an app
import, and every application import points at the package's public API.

### Slice 2 — the render kernel joins the package

Status: next.

Every kind of image the app makes — a portrait, a scene, a variant, a lab
experiment — passes through one step that turns "what this render wants" into
the exact instructions a provider is handed. That step is nearly all rules and
arithmetic, and it is the piece a developer most often needs to reason about on
its own, because it decides what the provider actually sees.

Two things hold it on the application side, and both are lookups rather than
logic: it asks the database for the settings of the model being run, and it asks
the library for the style weights a render selected. Neither is a decision the
step makes; both are facts it is handed. When the caller does those lookups and
passes the answers in, the whole compile step crosses — and the fingerprint that
says whether two experiments really ran the same configuration crosses with it,
which is what makes controlled comparisons checkable without a database.

### Slice 3 — the shared foundation becomes `@vesper/contracts`

Status: queued — unblocks slice 4.

Two small things are needed on both sides of the boundary: a way for code to
report that it degraded rather than failed, and a way to read data from an
untrusted source without crashing the request. Today the image package carries
its own copy of the first and does without the second entirely, kept honest by a
test that fails if the two copies ever drift.

That works, and it does not scale to a second package. A small shared foundation
gives both one home, and the duplicate copy and its drift test are deleted in
the same change. It is deliberately tiny — these two primitives and nothing
else — because a foundation package that starts collecting whatever is
convenient becomes the thing the boundary was built to prevent.

### Slice 4 — Replicate transport becomes `@vesper/image-replicate`

Status: blocked on slices 2 and 3.

The code that actually talks to Replicate — starting a prediction, waiting for
it, reading the result back, handling that provider's particular errors and
version pinning — is the last large piece of the engine still mixed in with the
app's own server code. Behind its own package, adding or characterizing a model
stops teaching the rest of the app that provider's vocabulary.

It waits on the two slices above for a concrete reason rather than tidiness: it
needs the shared foundation to report degradation, and it should be written
against a provider seam that has already held still while the render kernel
moved through it. Writing the adapter first would mean fitting it to a seam that
is about to change.

### Slice 5 — the vision path

Status: blocked — nothing provider-neutral to move yet.

"Images" now means two directions: making a picture, and a model looking at one.
The second path is live — it reads a portrait into character attributes, and it
describes photos a player attaches to a chat — and the target architecture names
a package for it.

An inventory says it is not time. Both consumers are almost entirely game
concepts (the attribute vocabulary; a chat message's attachments), and what they
share underneath is the general model-call layer the narrator also uses, which is
not an image concern at all. A package extracted today would hold a system prompt
and a fallback string. It becomes real work when a third consumer arrives, or
when the two existing ones are found to share a genuine contract; until then the
honest answer is that the target shape has a slot with nothing in it. The
inventory is recorded so nobody has to redo it.

### Slice 6 — the application moves to `apps/web`

Status: queued behind a deliberate soak.

The conventional monorepo shape, taken only after the package boundary has run
long enough to prove it was drawn in the right place. This is the slice with the
most disruption and the least architectural content — it moves files and
rewrites configuration without changing a single decision about what belongs
where — so it is deliberately last, and it is worth nothing until the boundary
above it has been tested by real work.

## Where the work stands

Technical detail lives in [monorepo-image-core.spec.md](monorepo-image-core.spec.md),
which indexes one spec per remaining slice and owns their implementation status.
The package's own contract with the application is
[packages/image-core/README.md](../../packages/image-core/README.md) §Boundary.

| Spec                                                               | Covers           | State  |
| ------------------------------------------------------------------ | ---------------- | ------ |
| [spec.md](monorepo-image-core.spec.md)                             | Shared mechanics | living |
| [spec.render-kernel.md](monorepo-image-core.spec.render-kernel.md) | Slice 2          | ready  |
| [spec.foundation.md](monorepo-image-core.spec.foundation.md)       | Slice 3          | ready  |
| [spec.replicate.md](monorepo-image-core.spec.replicate.md)         | Slice 4          | ready  |
| [spec.apps-web.md](monorepo-image-core.spec.apps-web.md)           | Slice 6          | ready  |

Slice 5 has no spec by design — the hub spec carries its inventory and the
condition that would start it.

## Success criteria

- `pnpm lint` fails on an app import added anywhere under `packages/`, whether
  it is written as `@/server/db` or as `../../../src/server/db`.
- The application's image behavior is unchanged at every slice: the same suites
  cover the same rules, moved next to the code they test, and CI's `verify` is
  green.
- A developer can read `packages/image-core` start to finish and never need to
  know what a chat is.
- The compile step that decides what a provider is sent can be exercised, and
  its configuration fingerprint checked, with no database in the process.
- Exactly one definition of a diagnostic exists in the repository.

## Open questions

- **Does the package publish a curated surface or a wide barrel?** Its root
  barrel currently re-exports every domain, which is why the application's
  import churn was mechanical. Whether some domains should stay behind subpath
  exports is worth deciding before a second package copies the pattern, since
  whatever slice 3 does will be the precedent.
  Detail: [spec.md](monorepo-image-core.spec.md) §"Export surface policy".
- **Does the app's contracts barrel re-export the foundation, or do 230 files
  change their imports?** Re-exporting keeps the diff small and matches what the
  barrel already is; repointing is the only way the old path stops existing.
  This is a one-time decision that sets how every later extraction is done.
  Detail: [spec.foundation.md](monorepo-image-core.spec.foundation.md)
  §"The import-churn decision".
- **What soak does slice 6 wait on?** "Long enough to prove the boundary" is not
  a condition anyone can check. It needs a nameable event — a model added
  entirely within the package, or the Replicate extraction completing without
  the seam moving.
  Detail: [spec.apps-web.md](monorepo-image-core.spec.apps-web.md) §"The gate".
