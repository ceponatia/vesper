# @vesper/image-core

The provider-neutral image engine. Everything here answers a question about
**images**; nothing here knows that Vesper has characters, chats, a database, or
a Next.js application.

Plan and rationale: [monorepo-image-core.plan.md](../../docs/developer-notes/monorepo-image-core.plan.md).
How the application uses it: [docs/images/](../../docs/images/README.md).

## Boundary

**The contract is one-way: this package may not import application code.** No
`@/contracts`, `@/lib`, `@/server`, `@/app` — no `@/` at all. Another workspace
package is imported by its package name and declared in this package's manifest,
never reached through a relative path.

A relative import is also forbidden when it resolves outside
`packages/image-core`, even if its spelling never contains the literal word
`packages`. This matters for sibling-package escapes such as a path that
normalizes into `packages/contracts`.

**Known enforcement gap:** the first Slice 1 ESLint rule catches `@/` and common
relative climbs whose text names top-level directories, but it does not yet prove
containment for every possible sibling-package relative path. The correction is
the remaining Slice 1 work in
[monorepo-image-core.spec.md](../../docs/developer-notes/monorepo-image-core.spec.md):
a resolved-path package-boundary check becomes authoritative before more code is
extracted. Until that lands, the boundary above is the required contract, but
lint alone is not proof of every relative spelling.

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
  reads `process.env`. Pure Node standard-library functions such as hashing are
  fine.
- **Diagnostics are reported, not persisted.** The current package-local
  `DiagnosticSink` is a temporary structural copy of the application's
  diagnostic contract. Slice 3 replaces both declarations with
  `@vesper/contracts`; see
  [spec.foundation.md](../../docs/developer-notes/monorepo-image-core.spec.foundation.md).
- **Tests are package-contained.** They may run through the repository's shared
  Vitest command, but package behavior must not depend on application DB/env/test
  setup.

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

Each folder has an `index.ts`. The package has one public root import path,
`@vesper/image-core`. The root barrel is being treated as a **curated public
surface**, not as a promise that every internal helper is public; the exact
policy and migration rule are in the monorepo hub spec.

## What stays outside this package

The application still owns Vesper-specific image orchestration:

- character/chat/scene state translation;
- registry database reads;
- asset persistence and image rows;
- authorization and job ownership;
- gallery/queue/lifecycle behavior;
- runtime provider configuration;
- crop/save behavior tied to application storage.

Replicate network transport and schema probing are planned for a separate
server-only `@vesper/image-replicate` package rather than being folded into this
core. That package is allowed to perform network IO but, like this one, may not
own Vesper state or read ambient application configuration.

## Working in here

- No production build artifact is emitted from this package; it exports
  TypeScript source and is consumed as a workspace dependency.
- Before the final `apps/web` move, Next transpiles it, root TypeScript resolves
  it through the workspace mapping, and the shared Vitest runner discovers its
  tests.
- The final monorepo layout gives packages their own TypeScript projects while
  keeping a root repository test/typecheck entry point.
- Tests live beside their subject.
- Validation is CI-only, as everywhere in this repo — code/config changes go
  through a PR and the repository gates rather than local `verify` runs.
