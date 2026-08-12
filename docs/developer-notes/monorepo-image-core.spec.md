# Monorepo migration — spec index and shared mechanics

Status: companion to [monorepo-image-core.plan.md](monorepo-image-core.plan.md)

This file owns what every slice needs and no single slice owns: how a package is
registered, how the boundary is enforced, what a package may export, and where
the shared primitives live today. One spec per remaining slice carries the rest.

## Spec index

| Spec                                                               | Slice | Owns                            |
| ------------------------------------------------------------------ | ----- | ------------------------------- |
| [spec.render-kernel.md](monorepo-image-core.spec.render-kernel.md) | 2     | Moving the profile compile step |
| [spec.foundation.md](monorepo-image-core.spec.foundation.md)       | 3     | `@vesper/contracts`             |
| [spec.replicate.md](monorepo-image-core.spec.replicate.md)         | 4     | `@vesper/image-replicate`       |
| [spec.apps-web.md](monorepo-image-core.spec.apps-web.md)           | 6     | The `apps/web` move             |

Slice 5 (vision) has no spec — see [The vision path](#the-vision-path-inventory).

## Implementation status

| Slice | State                    | Blocked by                      |
| ----- | ------------------------ | ------------------------------- |
| 1     | complete — 2026-08-12    | —                               |
| 2     | not started              | —                               |
| 3     | not started              | —                               |
| 4     | not started              | slices 2 and 3                  |
| 5     | not started, not planned | no pure surface exists          |
| 6     | not started              | an unnamed soak (open question) |

## Adding a package: the registration points

Packages ship TypeScript source with **no build step**. Three separate
resolvers therefore have to be told where the source is, and each is a distinct
failure if missed — `tsc` passing while Vitest cannot resolve the alias is the
normal way this goes wrong.

Five files change when a package is added:

| File                        | Add                                                   |
| --------------------------- | ----------------------------------------------------- |
| `packages/<n>/package.json` | Name, `private`, `type: module`, `exports`            |
| `tsconfig.json`             | A `paths` entry to `./packages/<n>/src/index.ts`      |
| `vitest.config.ts`          | The same mapping as a resolve alias                   |
| `next.config.ts`            | The name in `transpilePackages`                       |
| `Dockerfile`                | A manifest `COPY` beside the existing image-core line |

Two files need **no** change, and this is deliberate rather than luck:

- `pnpm-workspace.yaml` globs `packages/*`, so a new folder is picked up.
- `eslint.config.mjs` scopes the boundary rule to `packages/**/*.{ts,tsx}`, so a
  new package is governed from its first commit rather than from the commit
  where someone remembers to add it.

The CI classifier already counts `packages/*` as a code change
(`.github/workflows/ci.yml`), so a package-only PR runs the full gate set.

**The Dockerfile line is the one that is easy to miss and expensive to debug.**
The build copies manifests before sources to keep the install layer cacheable; a
package whose `package.json` is not copied fails `pnpm install --frozen-lockfile`
inside the image with a workspace-resolution error that says nothing about the
missing COPY.

### Package manifest shape

Follow `packages/image-core/package.json` exactly:

- `"name": "@vesper/<n>"`, `"version": "0.0.0"`, `"private": true`.
- `"type": "module"`.
- `"exports"` maps `"."` to `./src/index.ts` and `"./package.json"` to itself.
- Runtime dependencies are declared normally. `@types/node` is not needed for
  `Buffer` or `node:crypto` — the root's types reach the package through the
  shared `tsconfig`.

## The boundary rule, as enforced

`eslint.config.mjs` blocks two spellings under `packages/**`, and both matter
because they reach the same modules:

- Any `@/` alias import — `@/contracts`, `@/lib`, `@/server`, `@/app`.
- Any relative path that climbs out of the package — `../src/…`,
  `../../src/…`, `../../packages/…`.

The second is the one a naive alias-only rule misses, and it is the spelling an
agent reaches for when the alias fails.

Consequences a slice must design around, not work around:

- **No Vesper type appears in a package signature.** A function needing a
  character's appearance takes the prompt text or the resolved reference, never
  a `CharacterProfile`.
- **No persistence, no environment, no clock, no randomness.** A registry row
  arrives as a parsed value; the package never fetches one and never reads
  `process.env`. Node standard library that is *pure* is fine — `node:crypto`'s
  `createHash` is a function of its input, and `Buffer` already appears in
  package signatures (`provider-interface/failures.ts`,
  `identity/identity-pack-detector.ts`).
- **Diagnostics are reported, not collected.** The package takes a sink and
  pushes to it; it never owns a collector.

When a package appears to need something from the application there are exactly
two answers: pass the value in as an argument, or leave the code in the app.
Adding a third would put the game's simulation concepts underneath an image
library, which is the outcome the whole plan exists to avoid.

### Package-to-package imports

A package imports another **by name** (`@vesper/contracts`), never by path, and
declares it as a dependency in its own manifest. The dependency graph stays
acyclic and shallow: `image-replicate` → `image-core` → `contracts`.

`image-core` must not import `image-replicate`. If the core needs to invoke a
provider, it declares the interface and the application supplies the
implementation — the inversion that makes a second provider cheap.

## Export surface policy

**Open question, owned by the plan.** The decision is due before slice 3, whose
new package will set the precedent whichever way it goes.

Today `packages/image-core/src/index.ts` re-exports every domain barrel, and the
application imports `@vesper/image-core` rather than a deep path. That is why
slice 1's import churn was mechanical, and it is the property worth keeping.

The tension is real in both directions:

- A wide barrel means the package's public API is "everything", so nothing can be
  refactored without a potential ripple, and a reader cannot tell which exports
  are the intended entry points.
- Subpath exports (`@vesper/image-core/identity`) make the entry points explicit
  but multiply the registration burden — every subpath needs its own `exports`
  entry, `tsconfig` path, and Vitest alias, in three files that already drift.

The criterion to decide on: whether any domain has consumers **only** inside the
package. A domain the application never imports is internal, and publishing it
is the mistake worth fixing. A domain the application imports from a dozen call
sites is a genuine entry point, and hiding it behind a subpath buys nothing.

Until this is settled, new packages copy the wide barrel — one pattern, whatever
it is, beats two.

## Where diagnostics and boundary parsing live today

The duplication is deliberate, documented, and slice 3's whole subject.

- `src/contracts/diagnostics.ts` is the application's canonical owner. It carries
  `Diagnostic`, `DiagnosticSink`, the zod schema, `DiagnosticCollector`,
  `teeSink`, and `diag`.
- `packages/image-core/src/diagnostics.ts` re-declares `Diagnostic`,
  `DiagnosticSeverity` and `DiagnosticSink` structurally — the three shapes the
  package needs in order to *report* degradation — and nothing else.
- The package owns **no boundary parser**. `parseOr` lives in `src/lib/parse.ts`
  and stays there until slice 3.

Because `DiagnosticSink` is a one-method structural interface, the application's
collector satisfies the package's sink with no adapter. Drift is caught at
typecheck by the third `describe` block in
`src/contracts/images/identity-pack-boundary.test.ts`, which asserts assignability
in **both** directions.

> **Known stale pointer.** `packages/image-core/README.md` and the module comment
> in `packages/image-core/src/diagnostics.ts` both cite a
> `src/contracts/diagnostics.compat.test.ts` that does not exist; the check is in
> `identity-pack-boundary.test.ts`. The README is corrected; the `.ts` comment is
> a code change and rides the next PR to touch that file — slice 3 deletes the
> module outright.

## The vision path: inventory

The target architecture names `@vesper/image-vision`. This is what is actually
there, so the question does not have to be re-derived.

The path runs on **OpenRouter, not Replicate** — Replicate is generation and
editing only. Its entry point is `generateChecked` with an `images` option, and
`visionModelId()` (`src/server/ai/provider.ts`, `MODEL_DEFAULTS.vision`) is the
code-default model with no override layer. Two consumers:

| Consumer                                      | What it does                        |
| --------------------------------------------- | ----------------------------------- |
| `src/server/authoring/portrait-attributes.ts` | Portrait → closed-vocabulary traits |
| `src/server/engine/chat-vision.ts`            | Describes a message's attachments   |

Neither has a provider-neutral core worth a package:

- `portrait-attributes.ts` builds its output schema **from the attribute
  registry** at call time, and merges readings against a character draft. Take
  the registry away and there is no function left.
- `chat-vision.ts` is 94 lines: four constants, a system prompt, one
  `generateChecked` call, and a degradation to a fallback string. Its only
  non-Vesper content is the prompt text.
- What they genuinely share — `generateChecked`, `withGenerateTimeout`,
  `isDemoMode` — is the **general** model-call layer the narrator uses too. It
  belongs to a hypothetical `@vesper/ai`, not to an image package, and extracting
  it is not this plan's work.

**The condition that starts slice 5:** a third vision consumer arrives, or the
two existing ones are found to share a real contract — a common reading vocabulary,
a shared grounding step, a shared degradation policy worth stating once. Neither
holds today. Adding the package now would produce a folder holding a string
constant and a five-line schema, and would make the target diagram look complete
while delivering nothing.

Reference doc for this path: [docs/images/vision.md](../images/vision.md).

## Conventions every slice follows

- **One slice, one PR, `verify` green.** Validation is CI-only (root
  `CLAUDE.md`); never run the gates locally.
- **Tests move with the code they cover** and run in the ordinary `pnpm test`.
  A test that needs a database stays in the application by construction — if a
  moved test needs one, the wrong thing moved.
- **Behavior is unchanged at every slice.** These are extractions. A slice that
  wants to also fix a bug it uncovered files the bug separately; a moved module
  whose output changed cannot be reviewed as a move.
- **Prefer deletion to wrappers.** No compatibility shim preserves an old import
  path (root `CLAUDE.md`). A barrel that re-exports a package is not a shim —
  it publishes a new home — but it must be the app's own barrel, never a stub
  left behind for callers nobody updated.
