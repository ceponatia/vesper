# Render kernel extraction — slice 2

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 2

Move the profile compile step and the pure render planner into
`@vesper/image-core`, by inverting the three application dependencies that
currently hold them in `src/server/images`. Shared mechanics (registration
points, boundary rule, conventions) are in
[monorepo-image-core.spec.md](monorepo-image-core.spec.md).

## What moves

Two modules, split at their existing pure/IO seam.

### `src/server/images/render-profile.ts` — moves whole

Every export is pure once the two `../ai` imports are resolved
([below](#the-three-inversions)):

| Export                                                    | Note                          |
| --------------------------------------------------------- | ----------------------------- |
| `stableJson`, `sha256Hex`                                 | `node:crypto` only            |
| `TRIAL_FALLBACK_PREDICTION_MS`, `MAX_TRIAL_PREDICTION_MS` | Constants                     |
| `pinnedImageModelVersion`                                 | Pure over `ImageModel`        |
| `PromptReferenceBinding`                                  | Type                          |
| `CompileProfileRenderPlanInput` and result types          | Types                         |
| `compileProfileRenderPlan`                                | The compile step              |
| `profileRenderControlsHash`, its input type               | The configuration fingerprint |

Private helpers move with it: `referenceBindingCount`, `nonBlank`,
`compilePromptForStrategy` and its two arms, `resolvedNegativePrompt`,
`withResolvedSafetyChecker`.

### `src/server/images/render-intent.ts` — splits

**Moves** — the pure planner and its whole type surface:
`ImageRenderReference`, `ImageRenderIntent`, `PlannedImageRender`,
`PlannedControlReference`, `ImageRenderRefusal`, `PlanImageRenderResult`,
`planImageRender`, and the private `roleNames` / `compileBindings`.

**Stays** — the IO half, which is already thin by design:
`resolveIntentLora` (reads the LoRA library) and `renderImageIntent` (resolves,
plans, pushes diagnostics, calls the transport).

The seam already exists. `planImageRender` is pure today and
`renderImageIntent` is written as its thin IO wrapper — the module comment says
so, and `render-intent.test.ts:477` already records that "`planImageRender` is
pure, so it can only THREAD a binding". This slice makes the file boundary
match the seam that is already there.

### `reservedImageInputFields` — moves from the transport

`src/server/ai/replicate.ts:156` declares it, but it is a pure function of an
`ImageModel`'s declared fields — it belongs in the package's `capabilities/`
domain, not in a Replicate module. Both current callers keep working: the
transport imports it back by name, and the compile step stops reaching into
`../ai` for it.

Moving it now rather than in slice 4 is deliberate: it is one of the two things
blocking this slice, and leaving it behind would mean the compile step
imports the transport, which is the wrong direction permanently.

## The three inversions

### 1. `disableSafetyChecker()` — an environment read

`withResolvedSafetyChecker` calls it to resolve `disable_safety_checker` into
the effective model, so the fingerprint tracks the enforcement that will
actually apply rather than the row's placeholder. That property must survive;
only the *source* of the boolean changes.

Add a required field to `CompileProfileRenderPlanInput`:

```
/** Whether the provider's safety checker will be disabled for this render. */
safetyCheckerDisabled: boolean;
```

Callers pass `disableSafetyChecker()`. Make it **required**, not optional with a
default — a defaulted boolean here silently fingerprints the wrong enforcement
if a caller forgets, which is exactly the drift `withResolvedSafetyChecker`
exists to prevent. A required field makes the omission a compile error.

The key is still never *added* to a model that does not declare it; the guard
`if (!("disable_safety_checker" in model.extraInput))` moves unchanged.

### 2. `reservedImageInputFields` — an import direction

Move it to the package ([above](#reservedimageinputfields--moves-from-the-transport)).
No signature change.

### 3. `resolveImageLoraForRender` — a library read

**Already inverted.** `ImageRenderIntent.resolvedLora` exists and
`compileProfileRenderPlan` takes `resolvedLora` as an input; `resolveIntentLora`
does the read *before* planning and threads the binding in. Nothing to change —
the resolver simply stays in the application, on the correct side of the line.

The same is true of the model registry read. `ImageRenderIntent.profile` is a
`ResolvedImageProfile` the caller already looked up, for a reason the module
comment records (a lane must know its model before it reserves an image row).
The plan's slice-2 description called both of these blockers; the code shows
the inversion was done ahead of the extraction.

## What stays, and why

| Module                             | Why it stays                            |
| ---------------------------------- | --------------------------------------- |
| `render-intent.ts` (IO half)       | Reads the LoRA library, calls transport |
| `image-loras.ts`                   | Drizzle reads, `newId`                  |
| `models.ts`                        | Drizzle reads, `sharp`, transport call  |
| `identity-pack-trial.ts`           | Persistence, claims, job state          |
| `identity-trial-model-versions.ts` | Registry reads                          |

## Consumers to repoint

All become `@vesper/image-core` imports. None changes behavior.

- `src/server/images/render-intent.ts` — for the moved planner and types.
- `src/server/images/identity-pack-trial.ts` — imports `compileProfileRenderPlan`,
  `MAX_TRIAL_PREDICTION_MS`, `pinnedImageModelVersion`, `profileRenderControlsHash`,
  `sha256Hex`. It is the heaviest consumer and its compile call sites
  (`:1134`, `:2332`) each need the new `safetyCheckerDisabled` argument.
- `src/server/images/identity-trial-model-versions.ts` — `pinnedImageModelVersion`.
- `src/server/ai/replicate.ts` — `reservedImageInputFields`, now imported.
- `src/server/images/index.ts` / `internal.ts` — drop the moved re-exports.

**One cross-boundary composition to preserve.** `identity-pack-trial.ts:1456`
builds `STALE_CLAIM_MS` from `MAX_TRIAL_PREDICTION_MS` (moving to the package)
plus `REQUEST_TIMEOUT_MS` and `OUTPUT_TIMEOUT_MS` (staying in `replicate.ts`
until slice 4). That is fine — the application is allowed to compose values from
both — but the constant must keep its current value, since it sizes the window
that has to outlast a render.

## Target layout in the package

The compile step is the layer *between* capabilities and a provider call, and it
consumes `models/`, `capabilities/`, `references/`, `loras/` and
`render-intent/`. It gets its own domain folder rather than being appended to
one it depends on:

```
packages/image-core/src/
  capabilities/       + reservedImageInputFields
  render-intent/      + planImageRender and its types
  render-kernel/      compile-profile-plan.ts, controls-hash.ts, stable-json.ts
```

`planImageRender` joins the existing `render-intent/` folder — it is the planner
for the intent type that folder already owns, and splitting them would separate
a type from the only function that consumes it.

Add `render-kernel/index.ts` and re-export from `src/index.ts`, per the wide
barrel the package uses today (hub spec §"Export surface policy").

## Tests

Both suites move beside their subjects and keep asserting the same rules:

- `render-profile.test.ts` (546 lines) → `packages/image-core/src/render-kernel/`.
- `render-intent.test.ts` (699 lines) → splits the same way the module does. The
  cases exercising `planImageRender` move; any covering `renderImageIntent`'s
  diagnostics and LoRA resolution stay in the application.

**The env-stubbing cases get simpler, and that is the tell.**
`render-profile.test.ts` manipulates `process.env.REPLICATE_SAFE_MODE` directly
(`:105`, `:510`, `:515`, `:522`) to drive `withResolvedSafetyChecker`. After the
inversion those become a passed boolean, and the `delete process.env.…` cleanup
disappears. A test that still needs the environment after this slice means the
inversion is incomplete.

## Invariants this slice must not break

These are the properties the moved code exists to hold. A move that changes any
of them is a behavior change wearing a refactor's clothes.

1. **What is hashed is what is sent.** `profileRenderControlsHash` reads fields
   off the plan the same call produced. Adding a field to the payload without
   adding it to the hash is the drift this design prevents.
2. **The effective model is what counts.** `withReviewedImageQuality` runs before
   hashing, so the reviewed-quality seam cannot change the payload silently.
3. **`preparePromptForImageModel` idempotence.** It runs here and again in
   `renderWithModel`; the text hashed must stay byte-for-byte the text the
   provider receives.
4. **Production pins nothing and forces no budget.** `renderImageIntent`
   deliberately passes neither a version pin nor a forced timeout. The planner
   may *carry* an explicit pin from a controlled caller; it must not start
   applying one.
5. **Refusals are returned, never thrown.** All four `ImageRenderRefusal` codes
   stay returned values; the diagnostic is pushed by the application half.

## Verification

- CI `verify` green — the classifier runs the full gate set for `packages/*`.
- The two moved suites pass unchanged in substance; diffs should be imports,
  the `safetyCheckerDisabled` argument, and the removed env stubbing.
- `identity-pack-trial`'s recorded hashes are unchanged for an unchanged
  configuration. This is the highest-value check in the slice: a moved compile
  step that fingerprints differently invalidates every stored comparison. If a
  fixture-based hash assertion does not already exist in `render-profile.test.ts`,
  add one before moving the code, so the before/after is checkable.
