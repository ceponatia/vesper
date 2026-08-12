# Render kernel extraction — slice 2

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 2

Implementation state: not started — blocked on the Slice 1 package-boundary correction.

Move the profile compile step and the pure render planner into
`@vesper/image-core` by inverting the remaining application-owned facts rather
than letting the package read the application. Shared mechanics (registration,
boundaries, export policy and package rules) are in
[monorepo-image-core.spec.md](monorepo-image-core.spec.md).

## What moves

Two application modules split at seams that mostly already exist.

### `src/server/images/render-profile.ts` — moves whole

Every export is pure after the remaining environment/import dependencies are
inverted:

| Export                                                    | Note                          |
| --------------------------------------------------------- | ----------------------------- |
| `stableJson`, `sha256Hex`                                 | `node:crypto` only            |
| `TRIAL_FALLBACK_PREDICTION_MS`, `MAX_TRIAL_PREDICTION_MS` | Constants                     |
| `pinnedImageModelVersion`                                 | Pure over `ImageModel`        |
| `PromptReferenceBinding`                                  | Type                          |
| `CompileProfileRenderPlanInput` and result types          | Types                         |
| `compileProfileRenderPlan`                                | The compile step              |
| `profileRenderControlsHash`, its input type               | Configuration fingerprint     |

Private helpers move with it: `referenceBindingCount`, `nonBlank`,
`compilePromptForStrategy` and its two arms, `resolvedNegativePrompt`, and
`withResolvedSafetyChecker`.

### `src/server/images/render-intent.ts` — splits

**Moves** — the pure planning half and its type surface:

- `ImageRenderReference`;
- `ImageRenderIntent`;
- `PlannedImageRender`;
- `PlannedControlReference`;
- `ImageRenderRefusal`;
- `PlanImageRenderResult`;
- `planImageRender`;
- private `roleNames` / `compileBindings`.

**Stays in the application** — orchestration and IO:

- `resolveIntentLora`, because it reads the LoRA library;
- `renderImageIntent`, because it resolves application-owned runtime facts,
  reports diagnostics and invokes `renderWithModel`.

The seam already exists in behavior. This slice makes the file/package boundary
match it.

### `reservedImageInputFields` — moves from the Replicate module

`src/server/ai/replicate.ts` currently declares it, but the function is a pure
calculation over an `ImageModel`'s declared fields. It belongs in
`image-core/capabilities`, not in a network transport.

Both current users then import the one package-owned definition: the compile
step uses it before accepting provider overrides, and the Replicate transport
uses it before overlaying provider-shaped controls.

## The remaining inversions

The earlier plan text described the model registry and LoRA library as blockers.
They are no longer blockers: callers already resolve the profile/model and LoRA
binding before planning. The remaining issues are the safety setting and the
reserved-field helper.

### 1. The safety setting becomes an explicit runtime fact

`withResolvedSafetyChecker` currently calls `disableSafetyChecker()`, which
reads `REPLICATE_SAFE_MODE`. A pure package cannot do that.

Add a required field to `CompileProfileRenderPlanInput`:

```ts
export interface CompileProfileRenderPlanInput {
  // existing fields...
  safetyCheckerDisabled: boolean;
}
```

The value remains required even for a model that does not expose the provider
field. Forgetting a deployment-owned enforcement fact must be a compile error,
not a silent default. `withResolvedSafetyChecker` keeps the existing guard: it
only replaces the value when the model's `extraInput` already declares
`disable_safety_checker`; it never invents an unsupported provider field.

### 2. `planImageRender` also receives runtime facts separately from intent

The safety value must reach the production planner too. Do **not** add it to
`ImageRenderIntent`: an intent describes what the render wants, not how this
process is configured.

Introduce a separate pure input:

```ts
export interface ImageRenderRuntimeFacts {
  safetyCheckerDisabled: boolean;
}

export function planImageRender(
  intent: ImageRenderIntent,
  runtime: ImageRenderRuntimeFacts,
): PlanImageRenderResult;
```

`planImageRender` passes `runtime.safetyCheckerDisabled` into
`compileProfileRenderPlan`.

Application callers resolve the current fact at the application boundary and
pass it in:

- `renderImageIntent` resolves it immediately before planning;
- controlled Image Lab paths that call `planImageRender` directly pass it;
- identity-pack trial compile call sites pass it directly to
  `compileProfileRenderPlan`.

Search the symbol `planImageRender`, not only `render-intent.ts`, before changing
the signature; the Image Lab has direct planning paths.

This keeps the package pure without teaching the intent type about deployment.

### 3. The model registry and LoRA reads are already inverted

`ImageRenderIntent.profile` already carries a `ResolvedImageProfile`, so the
planner does not load a registry row. That is correct: lanes need the resolved
model before they reserve an image row and record its model metadata.

`ImageRenderIntent.resolvedLora` and `CompileProfileRenderPlanInput.resolvedLora`
already carry a binding judged against the library/model/version/task. The
application's `resolveIntentLora` performs the read before planning. Keep that
seam.

### 4. `reservedImageInputFields` moves without a signature change

Move the helper to `packages/image-core/src/capabilities/` and import it from
`@vesper/image-core` in the transport. Do not duplicate the reserved-field list
inside the kernel.

## Safety parity across Slice 2 and Slice 4

Slice 2 removes environment reads **from the core package**, but the Replicate
transport still owns its current environment read until Slice 4. That means the
compile path and send path temporarily obtain the same setting from the same
process environment through two application-side calls, matching today's
behavior.

Do not claim Slice 2 has created a single runtime configuration snapshot. Slice
4 closes that remaining seam by resolving Replicate configuration once for the
process and handing the same safety value to both planning and sending.

The Slice 2 tests must prove the package uses the boolean it was handed and no
longer reads or stubs `process.env`. Slice 4 adds the stronger compile/send
single-source guarantee.

## What stays, and why

| Module                             | Why it stays                            |
| ---------------------------------- | --------------------------------------- |
| `render-intent.ts` (IO half)       | App runtime facts, LoRA read, transport |
| `image-loras.ts`                   | Drizzle reads, `newId`                  |
| `models.ts`                        | Drizzle reads, `sharp`, transport call  |
| `identity-pack-trial.ts`           | Persistence, claims, job state          |
| `identity-trial-model-versions.ts` | Registry reads                          |

## Consumers to repoint

Moved symbols become `@vesper/image-core` imports. Inventory exported symbol
usage before deleting the old re-exports.

Known consumers:

- `src/server/images/render-intent.ts` — moved planner/types and compile helpers;
- `src/server/images/identity-pack-trial.ts` —
  `compileProfileRenderPlan`, `MAX_TRIAL_PREDICTION_MS`,
  `pinnedImageModelVersion`, `profileRenderControlsHash`, `sha256Hex`;
- `src/server/images/identity-trial-model-versions.ts` —
  `pinnedImageModelVersion`;
- `src/server/ai/replicate.ts` — `reservedImageInputFields`;
- application image barrels — remove re-exports of implementations that moved.

`identity-pack-trial.ts` has direct compile calls that each gain the required
`safetyCheckerDisabled` value.

**Cross-boundary composition to preserve:** `STALE_CLAIM_MS` is built from
`MAX_TRIAL_PREDICTION_MS` plus Replicate request/output timeout constants. The
application may compose package and transport constants; the resulting window
must keep exactly its current value until Slice 4 deliberately changes the
transport ownership.

## Target layout in `@vesper/image-core`

```text
packages/image-core/src/
  capabilities/
    ...
    reserved-image-input-fields.ts
  render-intent/
    render-intent.ts
    plan-image-render.ts
  render-kernel/
    compile-profile-plan.ts
    controls-hash.ts
    stable-json.ts
```

Exact filenames may follow the existing package naming pattern, but ownership is
fixed:

- capability-derived reserved fields live under `capabilities`;
- normalized intent planning lives under `render-intent`;
- profile compilation/fingerprinting lives under `render-kernel`.

Add a `render-kernel/index.ts` and expose the application-facing symbols through
the curated package root. Do not create deep public subpath imports.

## Tests

### `render-profile.test.ts`

Move the suite beside `render-kernel`. Preserve all existing behavior assertions.
The environment-stubbing cases become ordinary input cases:

```ts
compileProfileRenderPlan({
  // ...
  safetyCheckerDisabled: true,
});
```

No package test manipulates `REPLICATE_SAFE_MODE` after the move.

### `render-intent.test.ts`

Split with the implementation:

- cases for `planImageRender` and its refusals move into the package;
- cases for LoRA resolution, diagnostics and `renderImageIntent` stay in the app.

All package planner calls supply `ImageRenderRuntimeFacts` explicitly.

### Golden fingerprint

Before moving the kernel, make sure a fixture pins the complete controls hash for
an unchanged configuration. Run that same fixture after the move. The expected
hash must not be regenerated merely because files moved.

If an existing fixture already pins the hash, reuse it. If not, add the assertion
before moving the implementation so the before/after comparison is meaningful.

### Package independence

Moved tests must neither import application test support nor depend on the app's
global AI/Replicate environment setup. The shared root Vitest runner may execute
them; their behavior must be package-contained.

## Invariants this slice must not break

1. **What is hashed is what the compiler planned to send.**
   `profileRenderControlsHash` reads the effective plan, including the supplied
   safety fact and all dropped controls.
2. **The effective model is what counts.** `withReviewedImageQuality` runs before
   compilation/fingerprinting.
3. **Prompt preparation remains byte-stable.** `preparePromptForImageModel`
   remains idempotent across the compile step and `renderWithModel`.
4. **Production still pins no version by default.** A production intent follows
   the model slug unless a controlled caller explicitly supplies `versionId`.
5. **Production still forces no timeout when the profile stores none.** The trial
   may compile/hash an explicit comparison budget without changing ordinary
   render timeout behavior.
6. **Refusals are returned, not thrown.** All existing render refusal codes and
   pre-spend behavior stay intact.
7. **The package reads no environment.** Runtime facts arrive as values.
8. **No database/library resolution moves into the package.** Registry and LoRA
   resolution stay application-owned.

## Verification

- Slice 1's package-boundary gate is green before this PR begins.
- CI `verify` is green for the Slice 2 PR.
- The moved suites pass with no package-side `process.env` stubbing.
- The golden controls hash is identical before and after extraction.
- Existing production intent tests still prove no automatic version pin and no
  forced timeout.
- A symbol inventory finds no live import of the deleted application
  implementations after the move.
