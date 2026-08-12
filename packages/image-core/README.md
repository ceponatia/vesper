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

**These rules are mechanically enforced, not conventions.** ESLint catches `@/`
and common relative climbs at editor latency, but spelling-based lint cannot
prove containment or stop a reverse deep import. `pnpm lint:package-boundaries`
resolves every import and owns the real answer: cross-workspace containment in
both directions, exact-name package imports, manifest dependency ownership,
package-graph direction and cycles, root-barrel wildcards, and this package's
browser/server portability. `pnpm lint:package-resolution` separately imports the
package by name through the installed workspace. Both run in CI's static gate;
the rules and their rationale are in
[the guardrails spec](../../docs/developer-notes/monorepo-image-core.spec.guardrails.md).

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
  execution stays at the application/server boundary. The rule is about what
  runs: naming a platform type at a provider seam (`Buffer` on
  `ProviderRenderResult.image`) is allowed, evaluating one (`Buffer.from`,
  `process.env`, `document`) is not. `src/contracts/state/scene-gen.ts` is the
  designated client-side fixture that keeps the production build honest about it.
- **Diagnostics are reported, not persisted.** The current package-local
  `DiagnosticSink` is a temporary structural copy of the application's
  diagnostic contract. Slice 3 replaces both declarations with
  `@vesper/contracts`; see
  [spec.foundation.md](../../docs/developer-notes/monorepo-image-core.spec.foundation.md).
- **Tests are package-contained.** They run through the repository's shared
  Vitest command, as the `image-core` project, and receive no application-global
  DB/env/test setup and no `@/` alias.
- **Typechecking is package-contained.** `tsconfig.json` here is the package's
  own project — no `@/*` alias, no Next plugin, `ES2022 + DOM` libraries — and
  root `pnpm typecheck` runs it alongside the app project.
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

Each folder may have an internal `index.ts` for reading/navigation, and those may
use `export *` — they are reading aids, not publication. The package has one
public code import path, `@vesper/image-core`, and the **root** `src/index.ts`
lists every public name explicitly. Adding an entry there is a public-API change
and should be read as one; adding an internal helper cannot publish it by
accident.

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
- Resolution runs through pnpm/package `exports`, not tool aliases: TypeScript,
  Vitest and Next all reach this package by name through the workspace link, and
  `pnpm lint:package-resolution` proves it in CI. If a tool ever needs a mapping
  again, keep it exact-root-only — never `@vesper/* -> packages/*/src`.
- Dependencies this package imports belong in **its** `package.json`, including
  test-only ones. `pnpm lint:package-boundaries` fails on anything reachable only
  through the root install.
- Tests live beside their subject and run without application-global setup.
- Validation follows the repository milestone-gate policy: code/config work is
  proven by ready-state CI `verify`; `pnpm gates:local` is permitted only as the
  explicit batch checkpoint described in root `CLAUDE.md`, never as an automatic
  per-task gate. Raw lint/type/test/verify commands remain banned locally.
