# Monorepo migration — spec index and shared mechanics

Status: companion to [monorepo-image-core.plan.md](monorepo-image-core.plan.md)

This file owns what every slice needs and no single slice owns: package
registration, workspace-import enforcement, dependency ownership, package graph
rules, public export policy, shared primitives, runtime-target conventions, and
the vision-path inventory. One spec per implementation slice carries the rest.

## Spec index

| Spec                                                                 | Slice | Owns                                      |
| -------------------------------------------------------------------- | ----- | ----------------------------------------- |
| [spec.guardrails.md](monorepo-image-core.spec.guardrails.md)         | 1     | Mechanical workspace/package boundaries  |
| [spec.render-kernel.md](monorepo-image-core.spec.render-kernel.md)   | 2     | Moving the profile compile step           |
| [spec.foundation.md](monorepo-image-core.spec.foundation.md)         | 3     | `@vesper/contracts`                       |
| [spec.replicate.md](monorepo-image-core.spec.replicate.md)           | 4     | `@vesper/image-replicate`                 |
| [spec.apps-web.md](monorepo-image-core.spec.apps-web.md)             | 6     | The `apps/web` move                       |

Slice 5 (vision) has no spec — see [The vision path](#the-vision-path-inventory).

## Implementation status

| Slice | State                                      | Blocked by                   |
| ----- | ------------------------------------------ | ---------------------------- |
| 1     | in progress — guardrail completion remains | —                            |
| 2     | not started                                | Slice 1 completion           |
| 3     | not started                                | Slice 2 by delivery order    |
| 4     | not started                                | Slices 2 and 3               |
| 5     | not started, not planned                   | no pure surface exists       |
| 6     | not started                                | Slice 4 seam-proving gate    |

## Adding a package before the `apps/web` move

Packages ship TypeScript source with **no build step**. A new package is not
registered merely because the root application can reach its source. Before
Slice 6, the following surfaces must agree:

| File/surface                  | Add or prove                                                   |
| ----------------------------- | -------------------------------------------------------------- |
| `packages/<n>/package.json`   | Name, `private`, `type: module`, curated exports, dependencies |
| `packages/<n>/tsconfig.json`  | Package-local type project with only allowed runtime context   |
| root `typecheck`              | Includes the package project and all package-internal source   |
| `vitest.config.ts`            | Discovers package tests without application-global setup       |
| `next.config.ts`              | Package name in `transpilePackages` when consumed by Next      |
| `Dockerfile`                  | Manifest copied before workspace install                       |
| workspace-resolution smoke    | Public package name resolves through installed workspace       |

`pnpm-workspace.yaml` already includes `packages/*`. The CI classifier already
counts `packages/*` as a code change, so a package-only PR runs the code gates.
The Slice 1 guardrail checker automatically covers every workspace package rather
than maintaining a package-name allow-list.

Root TypeScript/Vitest aliases are not package registration. Prefer normal pnpm
workspace/package `exports` resolution where the tools support it. If a tool
still requires an exact package-name mapping before Slice 6, keep it root-only
(`@vesper/foo`, never `@vesper/*` or `@vesper/foo/*`) and retain the real-workspace
CI smoke check so aliases cannot hide a broken manifest or lockfile.

Slice 6 reorganizes the root/web TypeScript hierarchy around a shared base but
does **not** introduce package-local typechecking or package test isolation for
the first time; those invariants already exist from Slice 1.

**The Dockerfile manifest copy is easy to miss and expensive to diagnose.** The
build copies manifests before sources to keep the install layer cacheable. A
workspace package whose `package.json` is absent at `pnpm install
--frozen-lockfile` fails with a workspace-resolution error rather than a useful
"manifest was not copied" message.

### Package manifest shape

Follow the current private-source-package convention unless a detail spec says
otherwise:

- `"name": "@vesper/<n>"`, `"version": "0.0.0"`, `"private": true`.
- `"type": "module"`.
- `"exports"` maps `"."` to `./src/index.ts`; `"./package.json"` may remain only
  for tooling that genuinely consumes metadata.
- No code subpaths are exported during this migration.
- Runtime dependencies are declared in the package that imports them.
- Test/config/tool-only dependencies may be `devDependencies` only when they
  never enter runtime source.
- Workspace dependencies use `"workspace:*"`.
- A workspace never relies on a package being reachable merely because pnpm made
  it available elsewhere in the install.

## Workspace boundary: contract and enforcement

The contract is stronger than a naming convention and works in both directions:

1. A workspace package never imports application/root implementation code.
2. A relative import never crosses from one workspace into another workspace.
3. Application/root code does not reach package internals by filesystem path.
4. Another workspace package is imported by its exact public package entry point
   and is declared in the importing workspace's manifest.
5. Bare third-party imports are likewise owned by the importing workspace.
6. The `@vesper/*` graph remains acyclic **and** follows the allowed layer
   direction.

The authoritative implementation is
[monorepo-image-core.spec.guardrails.md](monorepo-image-core.spec.guardrails.md).
The existing ESLint `@/` and zone bans remain for immediate file-level feedback;
they do not replace the resolved workspace checker.

### Why the first lint-only Slice 1 rule was insufficient

The original ESLint rule correctly rejects `@/...` and common relative climbs
that literally contain top-level names such as `src`, `scripts`, `drizzle` or
`packages`. It does **not** prove that every relative specifier stays inside the
current workspace. From `packages/image-core/src/...`, for example, a spelling
such as `../../contracts/src/...` can reach a sibling package without containing
a literal `packages` segment after the `..` components are normalized.

The inverse escape is equally important: application or root code could import a
file under `packages/image-core/src/...` relatively and bypass the package's
curated public API altogether.

Therefore the final guardrail resolves source/target workspace ownership rather
than pattern-matching import spelling.

### Import forms the checker owns

The checker covers:

- static imports and side-effect imports;
- re-exports;
- type-position `import("...")`;
- literal dynamic imports;
- non-literal dynamic imports in reusable packages, which are rejected unless a
  finite documented target set makes the dependency edge inspectable.

Cross-workspace containment uses canonical `path.relative()`-style semantics,
not raw string prefixes. Symlink escapes are either resolved before comparison or
prohibited in source workspaces.

### Dependency ownership

For every bare module import, locate the nearest workspace manifest.

- Runtime source requires the dependency in that workspace's `dependencies`.
- Tests/config/tool-only source may use `devDependencies`.
- Node built-ins are exempt.
- `@vesper/<name>` must name a real workspace package and an exported entry point.
- Runtime source may not import a workspace package that is only a
  `devDependency`.

This prevents the root install from masking missing ownership after `apps/web`
moves.

### Package graph policy

The intended graph after Slice 4 is shallow:

```text
@vesper/image-replicate -> @vesper/image-core -> @vesper/contracts
@vesper/image-replicate ----------------------> @vesper/contracts
application/root tooling ---------------------> package layer
```

`image-core` never imports `image-replicate`. `image-core -> image-replicate`
would be invalid even if Madge considered the graph acyclic, so
`lint:package-boundaries` carries an explicit layer-direction policy in addition
to cycle detection.

If a second provider later proves that an invocation interface is useful, add it
from the two real implementations. Do not create one in this refactor solely so
the architecture diagram can contain an "interface" box.

## Runtime targets and package purity

Do not collapse "pure" and "runs everywhere" into one rule.

### `@vesper/image-core`

`image-core` is a **pure, universal package**:

- no persistence or network IO;
- no ambient environment reads;
- no decision-logic clock/randomness;
- no Vesper application state;
- no Node-only module in the public runtime graph.

It is already imported by client-importable application contracts for runtime
schemas, so the browser/server portability requirement is intentional. Pure
runtime-neutral utilities and deterministic arithmetic are fine.

### `@vesper/contracts`

`contracts` is also **pure and universal**. It contains generic shared boundary
primitives only, with no Next/server/persistence/runtime-specific dependency.

### `@vesper/image-replicate`

`image-replicate` is a **Node/server transport package**. Network IO, timeouts and
polling are its job. What it may not own is Vesper application state or ambient
configuration. It receives a resolved config object and never reads
`process.env` itself.

Moving Replicate out of `src/server/**` must not accidentally make it
client-importable. When Slice 4 creates the package, client-importable
application layers are mechanically prohibited from importing it. After Slice 6,
rewrite those same zones to `apps/web/src/**`.

Do not add a Next-specific `server-only` dependency to the transport package
merely to compensate for a missing repository boundary.

## Export surface policy

**Ruling (2026-08-12): one curated root barrel, no code subpath proliferation.**

Consumers keep the ergonomic import:

```ts
import { ... } from "@vesper/image-core";
```

Package root `src/index.ts` files use **explicit named exports**. `export *` is
forbidden at the package root because otherwise adding a helper to an internal
domain barrel can silently publish it. Internal folder barrels may still use
wildcards when useful; only the package root defines the public code API.

Before a symbol is exported, inventory application/package consumers. A helper
or domain used only inside the package stays internal. A public API change during
this refactor is allowed only when it is a deletion of an export with **no
external consumer**. Do not rename or reshape live public symbols as part of an
extraction.

The package manifest exports only the root code entry point (plus package
metadata where genuinely needed). Imports such as
`@vesper/image-core/src/...` or `@vesper/image-core/internal` are guardrail
violations even if a tool could otherwise resolve them.

## Package-local typechecking and test independence

These are Slice 1 invariants, not Slice 6 cleanup.

Every reusable package has its own TypeScript project. It does not inherit the
application `@/*` alias, the Next plugin, or runtime libraries it does not own.
Root `pnpm typecheck` must cover every package source file, including internal
files no application currently imports.

Package tests may still run from the repository's shared Vitest command, but they
must not import application test support or receive application-global setup.
Use Vitest projects or equivalent scoped configuration so the app, packages and
root tooling receive only the setup they own.

Environment manipulation that exists solely for OpenRouter/Replicate application
tests is not part of an `image-core` test's contract.

## Diagnostics and boundary parsing before Slice 3

The duplication is deliberate and Slice 3 removes it.

- `src/contracts/diagnostics.ts` is the application's canonical owner today. It
  carries `Diagnostic`, `DiagnosticSink`, the zod schema,
  `DiagnosticCollector`, `teeSink`, and `diag`.
- `packages/image-core/src/diagnostics.ts` re-declares
  `Diagnostic`, `DiagnosticSeverity` and `DiagnosticSink` structurally — the
  three shapes the package currently needs to report degradation.
- `parseOr` / `parseOrNull` live in `src/lib/parse.ts`.

Because `DiagnosticSink` is structural, the application's collector satisfies
the package sink without an adapter. The existing compatibility test holds the
two declarations assignable until Slice 3 replaces both with one package-owned
contract.

`parseOr` is not currently needed by `image-core`; moving it is a deliberate
shared-foundation decision, not evidence that the core should start parsing
application boundaries. See the foundation spec.

## The vision path: inventory

The target architecture names `@vesper/image-vision`. This is what actually
exists today, so the question does not need to be re-derived.

The path runs on **OpenRouter, not Replicate**. Its entry point is
`generateChecked` with an `images` option, and `visionModelId()`
(`src/server/ai/provider.ts`, `MODEL_DEFAULTS.vision`) supplies the code-default
model. Two consumers exist:

| Consumer                                      | What it does                        |
| --------------------------------------------- | ----------------------------------- |
| `src/server/authoring/portrait-attributes.ts` | Portrait → closed-vocabulary traits |
| `src/server/engine/chat-vision.ts`            | Describes a message's attachments   |

Neither exposes a provider-neutral image core worth a package:

- `portrait-attributes.ts` builds its schema from the Vesper attribute registry
  and merges readings against a character draft.
- `chat-vision.ts` is a small game-facing prompt and one general model call with
  a fallback.
- What they genuinely share — `generateChecked`, `withGenerateTimeout`, and demo
  handling — is the general model-call layer the narrator also uses. A future
  extraction there would be an `@vesper/ai` concern, not an image package.

**The condition that starts Slice 5:** a third vision consumer arrives, or the
two existing consumers acquire a real shared contract such as a common reading
vocabulary, grounding step, or degradation policy. Until then, creating the
package would move names without moving ownership.

Reference doc for this path: [docs/images/vision.md](../images/vision.md).

## Conventions every slice follows

- **One slice, one PR, `verify` green.** Validation is CI-only (root
  `CLAUDE.md`); never run the gates locally.
- **Tests move with the code they cover.** A database-dependent test stays in the
  application; a supposedly moved pure test that still needs DB/app setup is a
  boundary smell to fix before moving it.
- **Behavior is unchanged at every extraction slice.** A bug uncovered by the
  move is filed or fixed separately unless correcting it is required to preserve
  the stated boundary itself.
- **Prefer deletion to wrappers.** No compatibility module preserves an old
  implementation location. An existing application barrel may re-export a
  package when that barrel is still the application-facing API; it must not hide
  dead implementation code.
- **Inventory by exported symbol, not only by module path.** Wide barrels mean a
  consumer may use provider/package symbols without naming the source module in
  its import text. Before deleting or moving a barrel export, search the exported
  names as well as the file path.
- **Exercise the package as a package.** At least one CI smoke path resolves each
  workspace package through its installed public name/exports rather than only
  through source aliases.
