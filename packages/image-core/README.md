# @vesper/image-core

The provider-neutral image engine. Everything here answers a question about
**images**; nothing here knows that Vesper has characters, chats, a database, or
a Next.js application.

Plan and rationale: [monorepo-image-core.plan.md](../../docs/developer-notes/monorepo-image-core.plan.md).
How the application uses it: [docs/images/](../../docs/images/README.md).
Slice 1 enforcement: [monorepo-image-core.spec.guardrails.md](../../docs/developer-notes/monorepo-image-core.spec.guardrails.md).

## Boundary

**The contract is one-way in dependency direction and two-way in filesystem
encapsulation.** This package may not import application code, and consumers may
not bypass this package's public API by importing files under `packages/image-core`
directly.

No `@/contracts`, `@/lib`, `@/server`, `@/app` — no `@/` at all. Another
workspace package is imported by its package name and declared in this package's
manifest, never reached through a relative path.

Likewise, application/root/sibling-package code must not reach a helper through a
relative path such as `../../packages/image-core/src/...`. Cross-workspace code
imports use the exact curated root package entry point:

```ts
import { ... } from "@vesper/image-core";
```

Code subpaths such as `@vesper/image-core/src/...` or
`@vesper/image-core/internal` are not public APIs.

A relative import is forbidden when it resolves outside the current workspace,
even if its spelling never contains the literal word `packages`. This matters for
sibling-package escapes such as a path that normalizes into `packages/contracts`.
The same resolved-workspace check prevents app/root code from reaching inward by
filesystem path.

**Slice 1 enforcement is still being completed.** The first ESLint rule catches
`@/` and common relative climbs, but review found that spelling-based lint alone
cannot prove containment or prevent reverse deep imports. Before more extraction,
[the guardrails spec](../../docs/developer-notes/monorepo-image-core.spec.guardrails.md)
adds the authoritative workspace-import checker, manifest dependency ownership,
package graph direction/cycle checks, explicit root-export enforcement,
package-local typechecking, package-scoped tests, and adversarial checker tests.

The dependency direction is deliberate: the application depends on the package,
never the reverse. When code here appears to need something from the application,
one of two things is true — the value should be passed in as an argument, or the
code belongs in the application. Adding a back-reference would put the game's
simulation concepts underneath an image library.

Practical consequences:

- **Vesper types never appear in a signature.** A function that needs a
  character's appearance takes resolved prompt/reference data, not a
  `CharacterProfile`.
- **No persistence, network IO, ambient environment, clock or randomness.** A
  registry row arrives as a parsed value; the package never fetches one and never
  reads `process.env`.
- **Browser/server portable.** Existing client-importable application contracts
  consume runtime schemas from this package, so its public runtime graph may not
  pull in Node-only modules or Next/server-only framework code. Pure
  runtime-neutral utilities and deterministic arithmetic are fine; Node SHA-256
  execution stays at the application/server boundary.
- **Diagnostics are reported, not persisted.** The current package-local
  `DiagnosticSink` is a temporary structural copy of the application's
  diagnostic contract. Slice 3 replaces both declarations with
  `@vesper/contracts`; see
  [spec.foundation.md](../../docs/developer-notes/monorepo-image-core.spec.foundation.md).
- **Tests are package-contained.** They run through the repository's shared
  Vitest command but must not receive application-global DB/env/test setup.
- **Typechecking is package-contained.** Slice 1 gives this package its own
  TypeScript project without the application's `@/*` alias or Next plugin; root
  verification still aggregates it.
- **Dependencies are owned here.** A third-party or workspace dependency imported
  by package runtime source belongs in this package's manifest; reachability
  elsewhere in pnpm's install is not ownership.

## Layout

Read in this order — each layer consumes the one above it.

| Folder                | Owns                                                     |
| --------------------- | -------------------------------------------------------- |
| `capabilities/`       | Model declarations; binding controls to provider fields  |
| `models/`             | Registry row shape, per-task profiles, reviewed presets  |
| `loras/`              | LoRA definitions and render bindings                      |
| `render-intent/`      | What one render asks for, in one vocabulary               |
| `references/`         | Reference shapes, roles, and prompts that name them       |
| `identity/`           | Identity-pack schema, policy, crops, quality, trials      |
| `lab/`                | Advanced Image Lab contracts, recipes, instruction text   |
| `geometry/`           | Crop math                                                 |
| `provider-interface/` | Attempt routing and failure vocabulary                    |

Each folder may have an internal `index.ts` for reading/navigation. The package
has one public code import path, `@vesper/image-core`. The **root**
`src/index.ts` is a curated public surface and, once the Slice 1 correction
lands, uses explicit named exports rather than wildcard export chains. Adding an
internal helper must not publish it accidentally.

## What stays outside this package

The application still owns Vesper-specific image orchestration:

- character/chat/scene state translation;
- registry database reads;
- asset persistence and image rows;
- authorization and job ownership;
- gallery/queue/lifecycle behavior;
- runtime provider configuration;
- crop/save behavior tied to application storage;
- Node-only execution that is application infrastructure rather than image
  decision logic, such as the current SHA-256 fingerprint wrapper.

Replicate network transport and schema probing are planned for a separate
server-only `@vesper/image-replicate` package rather than being folded into this
core. That package is allowed to perform network IO but, like this one, may not
own Vesper state or read ambient application configuration.

## Working in here

- No production build artifact is emitted from this package; it exports
  TypeScript source and is consumed as a workspace dependency.
- Next transpiles it when consumed by the app, but package correctness is also
  checked through the package-local TypeScript project.
- Prefer real pnpm/package `exports` resolution over tool aliases. If a temporary
  exact-name alias remains for a tool, CI still exercises the installed workspace
  package by public name so the alias cannot hide broken manifest wiring.
- Tests live beside their subject and run without application-global setup.
- Validation is CI-only, as everywhere in this repo — code/config changes go
  through a PR and the repository gates rather than local `verify` runs.
