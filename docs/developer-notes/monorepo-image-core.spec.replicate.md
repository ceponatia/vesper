# `@vesper/image-replicate` — the transport package — slice 4

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 4

Put Replicate's transport behind its own package, so adding or characterizing a
model stops teaching the rest of the application that provider's vocabulary.
Shared mechanics are in [monorepo-image-core.spec.md](monorepo-image-core.spec.md).

**Blocked on slices 2 and 3.** Slice 3 supplies `diag`, which this code uses
throughout and which the structural-interface trick cannot provide. Slice 2 puts
the render kernel across the boundary, which is what proves the provider seam
has held still — writing this adapter first would fit it to a seam about to move.

## What moves

| Module                             | Lines | Content                        |
| ---------------------------------- | ----- | ------------------------------ |
| `src/server/ai/replicate.ts`       | 835   | Predictions, payloads, polling |
| `src/server/ai/replicate-probe.ts` | 443   | Version/schema probing         |

By then `reservedImageInputFields` has already left for `image-core` (slice 2),
so what remains in `replicate.ts` is genuinely transport: `hasReplicate`,
`disableSafetyChecker`, the payload builders (`buildRegistryModelInput`,
`overlayControlInput`), data-URL handling and its budget, `runRegistryImageModel`,
`runReplicatePreprocessor`, `unwrapReplicateImage`, `replicatePredictionTarget`,
and the timeout constants.

## What stays in the application

- **`src/server/ai/image-providers.ts`** — the four-line adapter that digs a real
  message out of an AI-SDK `APICallError`. It depends on `describeProviderError`
  in `src/server/ai/errors.ts`, which knows the AI-SDK's error shape; that is a
  *different* transport's vocabulary and does not belong in a Replicate package.
  Slice 1 already split this correctly — leave it split.
- **`src/server/images/models.ts`** — Drizzle reads, `sharp` cropping, and the
  call into the transport.
- Everything else in `src/server/ai/` — the OpenRouter provider, the narrator
  helpers, embeddings.

## The environment inversion

Four `process.env` reads block the move, and a package may not read the
environment (hub spec §"The boundary rule"):

| Line   | Reads                             | Used for                   |
| ------ | --------------------------------- | -------------------------- |
| `:27`  | `REPLICATE_API_TOKEN`             | `hasReplicate()`           |
| `:45`  | `REPLICATE_SAFE_MODE`             | `disableSafetyChecker()`   |
| `:796` | `REPLICATE_PREDICTION_TIMEOUT_MS` | Default prediction budget  |
| `:821` | `REPLICATE_API_TOKEN`             | The `Authorization` header |

**Resolve them into a config object the application constructs once**, rather
than threading four arguments through every call site:

```
export interface ReplicateConfig {
  apiToken: string | null;
  safetyCheckerDisabled: boolean;
  predictionTimeoutMs: number;
}
```

The application builds it from `process.env` at its own boundary and hands it to
the package. `hasReplicate()` becomes a property of the config rather than a
function that reads the world.

**Read the environment once, not per call.** Today `disableSafetyChecker()` is
called at send time (`replicate.ts:244`) and again during compilation
(slice 2's `safetyCheckerDisabled` argument). Those must agree — the render
kernel spec's invariant 1 depends on the value the fingerprint recorded being
the value that was sent. A single config resolved per request is how they stay
equal; two independent reads across a long-running prediction are how they
diverge.

## The provider interface

`image-core` already owns the provider-neutral half: attempt routing, reference
capacity (`fitReferences`), failure classification, provider-health semantics.
This slice's job is to make `image-replicate` an *implementation* of that seam
rather than a second place where routing decisions are made.

The dependency direction is fixed and one-way: `image-replicate` → `image-core`
→ `contracts`. `image-core` must never import `image-replicate`. Where the core
needs a provider invoked, it declares the interface and the application supplies
the implementation.

Do not build a general provider-plugin architecture here (plan §Non-goals). The
interface is shaped by the one provider in use; it earns an abstraction when a
second provider needs it.

## Consumers to repoint

`src/server/ai/index.ts` currently re-exports `./replicate` and
`./replicate-probe`. Both lines go, and importers move to
`@vesper/image-replicate`:

- `src/server/images/models.ts` — `runRegistryImageModel`, `RenderControlReference`.
- `src/server/images/identity-pack-trial.ts` — `REQUEST_TIMEOUT_MS`,
  `OUTPUT_TIMEOUT_MS` for `STALE_CLAIM_MS` (`:1456`), which must keep its value.
- Probe consumers in the admin/lab surfaces and `replicate-probe.test.ts`.

Grep both module names before starting; `src/server/ai/index.ts` is a wide
barrel, so some importers reach these symbols via `../ai` without naming the
file.

## Registration

Five files per the hub spec §"Adding a package". The manifest declares
`@vesper/image-core` and `@vesper/contracts` as workspace dependencies, plus
`zod` (`replicate.ts` uses it for response shapes).

Update the root `CLAUDE.md` package inventory and
`packages/image-core/README.md`'s note that transport "stays in `src/server/ai`
until then".

## Verification

- CI `verify` green.
- `grep -rn "process.env" packages/` returns nothing.
- `replicate.test.ts` and `replicate-probe.test.ts` move with their subjects.
  The `disableSafetyChecker()` env cases (`replicate.test.ts:168`, `:173`) become
  config-object cases; a test still reaching for `process.env` means the
  inversion is incomplete.
- A live render still works against the Fly deploy (`docs/deployment.md`) — this
  is the one slice where a config-threading mistake produces a package that
  typechecks, passes tests, and cannot authenticate. Verify a real generation,
  not just green CI.
