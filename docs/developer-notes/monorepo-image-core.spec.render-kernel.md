# Render kernel extraction — slice 2

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 2

Implementation state: not started — blocked on Slice 1 guardrail completion.

Move the profile compile step and the pure render planner into
`@vesper/image-core` by inverting the remaining application-owned facts rather
than letting the package read the application. Shared mechanics are in
[monorepo-image-core.spec.md](monorepo-image-core.spec.md); the prerequisite
workspace/runtime guardrails are in
[monorepo-image-core.spec.guardrails.md](monorepo-image-core.spec.guardrails.md).

`@vesper/image-core` remains browser/server portable. This slice therefore moves
pure compile/fingerprint **construction** but does not move the current
`node:crypto` SHA-256 execution into the package's public runtime graph.

## What moves

Two application modules split at seams that mostly already exist.

### `src/server/images/render-profile.ts` — pure kernel moves, Node hash wrapper stays

Move these runtime-neutral exports after the remaining environment/import
dependencies are inverted:

| Export / responsibility                                  | Target                                |
| -------------------------------------------------------- | ------------------------------------- |
| `stableJson`                                             | `@vesper/image-core`                  |
| deterministic controls-fingerprint serialization        | `@vesper/image-core`                  |
| `TRIAL_FALLBACK_PREDICTION_MS`, `MAX_TRIAL_PREDICTION_MS` | `@vesper/image-core`                |
| `pinnedImageModelVersion`                               | `@vesper/image-core`                  |
| `PromptReferenceBinding`                                | `@vesper/image-core`                  |
| `CompileProfileRenderPlanInput` and result types        | `@vesper/image-core`                  |
| `compileProfileRenderPlan`                              | `@vesper/image-core`                  |
| `sha256Hex`                                             | application/server                    |
| final `profileRenderControlsHash` SHA-256 wrapper       | application/server                    |

Private compile helpers move with the kernel: `referenceBindingCount`,
`nonBlank`, `compilePromptForStrategy` and its two arms,
`resolvedNegativePrompt`, and `withResolvedSafetyChecker`.

### Fingerprint split: package constructs, application hashes

Today `profileRenderControlsHash` both determines **what** represents the
configuration and performs the Node SHA-256 operation. Split those concerns
without changing the stored hash.

Add a runtime-neutral package helper, nameable along these lines:

```ts
export function profileRenderControlsFingerprintJson(
  input: ProfileRenderControlsFingerprintInput,
): string;
```

It returns the exact deterministic serialized string that the current
`profileRenderControlsHash` feeds to `sha256Hex` after all effective model,
controls, dropped-control, safety and timeout decisions have been made.

The application keeps the thin wrapper:

```ts
export function profileRenderControlsHash(input: ...): string {
  return sha256Hex(profileRenderControlsFingerprintJson(input));
}
```

The name of the package helper may differ if the implementation has a clearer
existing seam, but the ownership is fixed:

- package: deciding the fingerprint contents and deterministic serialization;
- application/server: Node SHA-256 execution;
- behavior: the final hash string remains byte-for-byte identical.

Do **not** solve the runtime-target problem by adding `node:crypto` to the
`image-core` public graph or by making `image-core` server-only. Existing
client-importable contracts already consume its runtime schemas.

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

| Module / responsibility            | Why it stays                                      |
| ---------------------------------- | ------------------------------------------------- |
| `render-intent.ts` (IO half)       | App runtime facts, LoRA read, transport           |
| SHA-256 hash wrapper               | Node-only execution; `image-core` stays universal |
| `image-loras.ts`                   | Drizzle reads, `newId`                            |
| `models.ts`                        | Drizzle reads, `sharp`, transport call            |
| `identity-pack-trial.ts`           | Persistence, claims, job state                    |
| `identity-trial-model-versions.ts` | Registry reads                                    |

## Consumers to repoint

Moved symbols become `@vesper/image-core` imports. Inventory exported symbol
usage before deleting old implementations/re-exports.

Known consumers:

- `src/server/images/render-intent.ts` — moved planner/types and compile helpers;
- `src/server/images/identity-pack-trial.ts` — compile helpers/constants and the
  application-owned final hash wrapper;
- `src/server/images/identity-trial-model-versions.ts` —
  `pinnedImageModelVersion`;
- `src/server/ai/replicate.ts` — `reservedImageInputFields`;
- application image barrels — re-export only application-owned wrappers that are
  still genuine application APIs; remove moved implementation exports.

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
    fingerprint-json.ts
    stable-json.ts
```

The application keeps its Node hashing helper/wrapper under the server image
layer.

Exact filenames may follow the existing package naming pattern, but ownership is
fixed:

- capability-derived reserved fields live under `capabilities`;
- normalized intent planning lives under `render-intent`;
- profile compilation and deterministic fingerprint construction live under
  `render-kernel`;
- SHA-256 execution stays application/server-side.

Add a `render-kernel/index.ts` for internal organization and expose only actual
application-facing symbols through the package's **explicit** curated root.
Do not create deep public subpath imports or add a root `export *`.

## Tests

### `render-profile.test.ts`

Move compile/fingerprint-construction cases beside `render-kernel`. Preserve all
existing behavior assertions. The environment-stubbing cases become ordinary
input cases:

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

### Golden fingerprint: two levels

Before moving the kernel, pin both:

1. the deterministic serialized fingerprint input;
2. the final SHA-256 hash currently stored/compared by the application.

After the move:

- package tests prove the serialized fingerprint input is identical;
- application tests prove `sha256Hex(serializedInput)` produces the identical
  final hash.

Do not regenerate either expected value merely because files moved.

### Browser-safety regression

Keep a small client-importable application fixture/module that imports an
existing runtime symbol from `@vesper/image-core` (for example one of the schemas
already consumed by client-safe contracts). The production Next build must stay
green after the render kernel moves.

This is specifically intended to catch a Node-only transitive dependency entering
the package root. Package unit tests alone cannot prove that browser graph.

### Package independence

Moved tests run under the package-scoped Vitest project established by Slice 1.
They neither import application test support nor depend on the app's global
AI/Replicate environment setup. The package-local TypeScript project must cover
all moved source/tests without the Next plugin or app alias.

## Invariants this slice must not break

1. **What is fingerprinted is what the compiler planned to send.** The package's
   fingerprint serialization reads the effective plan, including the supplied
   safety fact and all dropped controls.
2. **The final stored hash is unchanged.** Application SHA-256 wraps the exact
   package-owned serialization used before extraction.
3. **The effective model is what counts.** `withReviewedImageQuality` runs before
   compilation/fingerprinting.
4. **Prompt preparation remains byte-stable.** `preparePromptForImageModel`
   remains idempotent across the compile step and `renderWithModel`.
5. **Production still pins no version by default.** A production intent follows
   the model slug unless a controlled caller explicitly supplies `versionId`.
6. **Production still forces no timeout when the profile stores none.** The trial
   may compile/hash an explicit comparison budget without changing ordinary
   render timeout behavior.
7. **Refusals are returned, not thrown.** All existing render refusal codes and
   pre-spend behavior stay intact.
8. **The package reads no environment.** Runtime facts arrive as values.
9. **No database/library resolution moves into the package.** Registry and LoRA
   resolution stay application-owned.
10. **`image-core` remains browser/server portable.** No Node-only module enters
    its public runtime graph.

## Verification

- Slice 1's full guardrail gate is green before this PR begins.
- CI `verify` is green for the Slice 2 PR.
- Package-local typecheck covers the moved source without Next/app aliases.
- The moved suites pass with no package-side `process.env` stubbing or app setup.
- The golden fingerprint serialization and final SHA-256 hash are identical
  before and after extraction.
- The production build exercises a client-safe `@vesper/image-core` runtime
  import and remains green.
- Existing production intent tests still prove no automatic version pin and no
  forced timeout.
- A symbol inventory finds no live import of deleted application
  implementations after the move.
