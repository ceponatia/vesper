# Monorepo migration — spec index and shared mechanics

Status: companion to [monorepo-image-core.plan.md](monorepo-image-core.plan.md)

This file owns what every slice needs and no single slice owns: package
registration, package-boundary enforcement, package-to-package dependency rules,
public export policy, shared primitives, and the vision-path inventory. One spec
per remaining implementation slice carries the rest.

## Spec index

| Spec                                                               | Slice | Owns                            |
| ------------------------------------------------------------------ | ----- | ------------------------------- |
| [spec.render-kernel.md](monorepo-image-core.spec.render-kernel.md) | 2     | Moving the profile compile step |
| [spec.foundation.md](monorepo-image-core.spec.foundation.md)       | 3     | `@vesper/contracts`             |
| [spec.replicate.md](monorepo-image-core.spec.replicate.md)         | 4     | `@vesper/image-replicate`       |
| [spec.apps-web.md](monorepo-image-core.spec.apps-web.md)           | 6     | The `apps/web` move             |

Slice 5 (vision) has no spec — see [The vision path](#the-vision-path-inventory).

## Implementation status

| Slice | State                                              | Blocked by                         |
| ----- | -------------------------------------------------- | ---------------------------------- |
| 1     | in progress — boundary correction remains         | —                                  |
| 2     | not started                                        | Slice 1 correction                 |
| 3     | not started                                        | Slice 2 by delivery order          |
| 4     | not started                                        | Slices 2 and 3                     |
| 5     | not started, not planned                           | no pure surface exists             |
| 6     | not started                                        | Slice 4 seam-proving gate          |

## Adding a package before the `apps/web` move

Packages ship TypeScript source with **no build step**. While the Next.js app
remains at the repository root, five registration points have to agree about a
new package:

| File                        | Add                                                   |
| --------------------------- | ----------------------------------------------------- |
| `packages/<n>/package.json` | Name, `private`, `type: module`, exports, dependencies |
| `tsconfig.json`             | A path entry to the package's root source export       |
| `vitest.config.ts`          | The same package mapping for the shared test runner    |
| `next.config.ts`            | The package name in `transpilePackages`                |
| `Dockerfile`                | Its manifest beside the other workspace manifests      |

`pnpm-workspace.yaml` already includes `packages/*`. The CI classifier already
counts `packages/*` as a code change, so a package-only PR runs the code gates.
Slice 6 replaces this temporary root-app registration shape with explicit
application and package TypeScript projects; do not copy the pre-Slice-6 shape
blindly after the app has moved.

**The Dockerfile manifest copy is easy to miss and expensive to diagnose.** The
build copies manifests before sources to keep the install layer cacheable. A
workspace package whose `package.json` is absent at `pnpm install
--frozen-lockfile` fails with a workspace-resolution error rather than a useful
"manifest was not copied" message.

### Package manifest shape

Until Slice 6 introduces package-local tooling configuration, follow the current
`packages/image-core/package.json` shape unless a detail spec says otherwise:

- `"name": "@vesper/<n>"`, `"version": "0.0.0"`, `"private": true`.
- `"type": "module"`.
- `"exports"` maps `"."` to `./src/index.ts` and `"./package.json"` to itself.
- Runtime dependencies are declared in the package that imports them.
- Workspace dependencies use `"workspace:*"`.
- A package never relies on an undeclared sibling workspace dependency just
  because pnpm made it reachable somewhere in `node_modules`.

## Package boundary: contract and enforcement

The contract is stronger than a naming convention:

1. A workspace package never imports application code.
2. A relative import from one package never resolves outside that package's own
   directory.
3. Another workspace package is imported by its package name and is declared in
   the importing package's manifest.
4. The package graph remains one-way and acyclic.

### Known gap in the first Slice 1 guardrail

The current ESLint rule correctly rejects `@/...` and common relative climbs
that literally contain top-level names such as `src`, `scripts`, `drizzle` or
`packages`. It does **not** prove that every relative specifier stays inside the
current package. From `packages/image-core/src/...`, for example, a spelling such
as `../../contracts/src/...` can reach a sibling package without containing a
literal `packages` segment after the `..` components are normalized.

That means the package extraction is real, but the claim that lint alone proves
the complete boundary is not yet true. Closing this is the remaining work in
Slice 1 and blocks Slice 2.

### Required correction: resolve paths, do not pattern-match spellings

Add a repository package-boundary check that inspects import-like module
specifiers under `packages/*/src/**/*.{ts,tsx}` and resolves relative specifiers
from the importing file.

The checker must cover static forms TypeScript source can use to name another
module:

- `import ... from "..."` and side-effect imports;
- `export ... from "..."`;
- type imports such as `import("...")` in type positions;
- dynamic `import("...")` when the argument is a string literal.

For a relative specifier, normalize `path.resolve(dirname(source), specifier)`.
The normalized target must remain strictly inside the importing
`packages/<name>/` directory. The check does not need to guess an extension or
index file to establish containment; the normalized path is enough. A target
outside the package fails whether it reaches `src/`, another package, a root
script, a config file, or any other repository path.

For a bare `@vesper/<name>` import:

- the referenced workspace package must exist;
- it must not be a relative-path spelling of that package;
- the importer must declare it in `dependencies` (or `devDependencies` only for
  test/tool-only use that never enters runtime source);
- ordinary source should not import its own package by name when a local relative
  import is sufficient.

The existing ESLint `@/` ban stays because it gives immediate file-level
feedback. The resolved-path checker is the authoritative escape check.

Wire the checker into repository verification as `lint:package-boundaries` and
run it in the CI static gate beside cycle/authz/type checks. A future package is
not considered registered until this check covers it automatically through the
`packages/*` glob.

### Purity versus transport packages

Do not apply one impossible definition of "package purity" to every package.

- `@vesper/contracts` and `@vesper/image-core` are **pure packages**: no
  persistence, network IO, ambient environment reads, clock reads, or randomness
  in their decision logic. Pure Node standard-library functions such as hashing
  are fine.
- `@vesper/image-replicate` is a **transport package**: network IO, timeouts and
  polling are its job. What it may not own is Vesper application state or ambient
  configuration. It receives a resolved config object and never reads
  `process.env` itself.

This distinction replaces the overly broad earlier rule that said no package
could perform IO.

### Server-only provider transport

Moving Replicate out of `src/server/**` must not accidentally make it
client-importable. When Slice 4 creates `@vesper/image-replicate`, extend the
application's import guardrails so these layers cannot import it:

- `src/components/**`;
- non-route `src/app/**`;
- `src/contracts/**`;
- `src/lib/**`.

After Slice 6, rewrite those same zones to `apps/web/src/**`. Server modules,
route handlers and root operational scripts may use the configured application
adapter where appropriate. Do not add a Next-specific `server-only` dependency
to the transport package merely to compensate for a missing repository boundary.

## Package-to-package imports

A package imports another **by name**, never by path, and declares it in its own
manifest. The intended graph after Slice 4 is shallow:

```text
@vesper/image-replicate -> @vesper/image-core -> @vesper/contracts
                                      \-------> @vesper/contracts (where needed)
```

`image-core` never imports `image-replicate`. The core does not need to invent a
provider-plugin framework to preserve this direction: it produces provider-ready
planning data, the application owns orchestration, and the configured transport
consumes the model/request data it is handed.

If a second provider later proves that an invocation interface is useful, add it
from the two real implementations. Do not create one in this refactor solely so
the architecture diagram can contain an "interface" box.

## Export surface policy

**Ruling (2026-08-12): one curated root barrel, no subpath proliferation.**

Consumers keep the ergonomic import:

```ts
import { ... } from "@vesper/image-core";
```

but `src/index.ts` is not permission to publish every helper in every folder.
Before a domain is re-exported, inventory application/package consumers. The root
barrel exports only symbols or domain barrels that are genuine package entry
points. A helper or domain used only inside the package is internal and stays out
of `src/index.ts`.

This preserves the property that made Slice 1's import churn mechanical without
creating three parallel alias/exports registrations for every subpath. It also
sets the precedent for `@vesper/contracts` and `@vesper/image-replicate`: one
public root, deliberately curated.

A public API change during this refactor is allowed only when it is a deletion of
an export with **no external consumer**. Do not rename or reshape live public
symbols as part of an extraction.

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

## Test independence

Package tests may run from the repository's shared Vitest command, but a pure
package test must not import application test support or require application
setup to establish its behavior. Environment manipulation that exists solely for
OpenRouter/Replicate application tests is not part of an `image-core` test's
contract.

Slice 6 makes this separation explicit in the workspace test configuration so
moving the app's `src/test/setup.ts` cannot silently become a package test
dependency.

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
