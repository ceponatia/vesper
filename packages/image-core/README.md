# @vesper/image-core

The provider-neutral image engine. Everything here answers a question about
**images**; nothing here knows that Vesper has characters, chats, a database, or
a Next.js application.

Plan and rationale: [monorepo-image-core.plan.md](../../docs/developer-notes/monorepo-image-core.plan.md).
How the application uses it: [docs/images/](../../docs/images/README.md).

## Boundary

**The package may not import application code.** No `@/contracts`, no `@/lib`,
no `@/server`, no `@/app` — no `@/` at all, and no relative path that climbs out
of the package either (`../../../src/server/db` reaches the same module and would
otherwise match no alias glob). `eslint.config.mjs` fails the build on both
spellings, which is what makes this a boundary rather than a folder with a
different name. Another package is imported by its name, never by path.

The rule is one-directional and deliberate: the application depends on the
package, never the reverse. When the package appears to need something from the
application, one of two things is true — the value should be passed in as an
argument, or the code wanting it belongs in the application. There is no third
answer, and adding one would put the game's simulation concepts underneath an
image library.

Practical consequences:

- **Vesper types never appear in a signature.** A function that needs a
  character's appearance takes the prompt text or the resolved reference, not a
  `CharacterProfile`.
- **No persistence, no IO, no clock, no randomness.** A registry row arrives as
  a parsed value; the package never fetches one.
- **Diagnostics are reported, not collected.** `DiagnosticSink` here is a
  one-method structural interface the application's collector already satisfies
  (see `src/diagnostics.ts` for why the type is declared twice). The two
  declarations are held assignable in both directions by
  `src/contracts/images/identity-pack-boundary.test.ts`; a `@vesper/contracts`
  package collapses them into one
  ([spec.foundation.md](../../docs/developer-notes/monorepo-image-core.spec.foundation.md)).

## Layout

Read in this order — each layer consumes the one above it.

| Folder                | Owns                                                       |
| --------------------- | ---------------------------------------------------------- |
| `capabilities/`       | What a model declares; binding controls to real fields      |
| `models/`             | Registry row shape, per-task profiles, reviewed presets     |
| `loras/`              | LoRA definitions and render bindings                        |
| `render-intent/`      | What one render asks for, in one vocabulary                 |
| `references/`         | Reference shapes, roles, and the prompts that name them     |
| `identity/`           | Identity packs: schema, policy, cropping, quality, trials   |
| `lab/`                | Advanced Image Lab contracts, recipes, instruction text     |
| `geometry/`           | Crop math                                                   |
| `provider-interface/` | Attempt routing, reference capacity, failure vocabulary     |

Each folder has an `index.ts`; `src/index.ts` re-exports all of them, and the
application imports `@vesper/image-core` rather than a deep path.

## Working in here

- No build step. The package exports TypeScript source; Next transpiles it
  (`transpilePackages`), `tsc` resolves it through a `tsconfig` path, and
  Vitest through an alias.
- Tests live beside their subject and run in the repo's ordinary `pnpm test`.
- Validation is CI-only, as everywhere in this repo — open a PR rather than
  running the gates locally (root `CLAUDE.md`).
