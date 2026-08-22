# @vesper/simulation-core

The simulation domain: what a world is made of, what may happen in it, and the
pure functions that decide. It knows nothing about a database, a route, a
request, or a model provider — hand it a view of state and a command and it
returns events, or an honest refusal.

| Folder            | Owns                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `src/contracts/`  | Branded identities, command/event envelopes, projection schemas   |
| `src/lib/`        | The pure kernels every projector, store and replay runs through   |
| `src/test-support/` | Envelope, space and material fixtures the suites share          |

Design and rationale: [engine.spec.md](../../docs/developer-notes/engine.spec.md).
Current contracts, in prose: [docs/engine/](../../docs/engine/README.md).
The extraction that produced this package:
[monorepo-simulation-core.spec.md](../../docs/developer-notes/monorepo-simulation-core.spec.md).

## Why it exists

The simulation is the clearest case of the repository's own bar for a package: a
subsystem worth reading on its own that already runs without knowing there is a
database, a route, or a game around it. Every rule in here was written to be
called from a replay driver as readily as from a live turn, and the two halves
had already separated in practice — the pure half in `contracts/simulation` and
`lib/simulation`, the durable half in `server/engine/simulation`. The package
makes that seam a boundary a tool can check rather than a habit.

Its layer rank is **equal to `@vesper/image-core`**, which is the architectural
statement: neither may import the other. A render must not reach into world
state, and the simulation must not learn what a provider can draw. The
application sits above both and is the only place they meet.

## Public surface

There is **no root export**. The package publishes one **exact subpath per
module** and nothing else:

- `@vesper/simulation-core/contracts/<module>` — the contracts;
- `@vesper/simulation-core/<module>` — the kernels;
- `@vesper/simulation-core/testing/<fixture>` — the two fixtures application
  suites also build inputs with.

That is deliberate. The two `export *` index barrels this domain used to have
put roughly 1,700 names behind one specifier, so a module's real dependencies
were invisible and a client component could pull the whole simulation into its
bundle by importing one helper. Per-module entries make every dependency legible
in the import line, and adding one is a visible line in the manifest diff.

## Determinism

Two rules the whole domain rests on:

- **No ambient inputs.** No clock, no randomness, no environment, no IO. Story
  time and draw indices arrive as arguments; `deterministicDrawUnit` derives its
  randomness from world seed + branch + stream + index.
- **Persisted digests never move.** The two sha256 identities — the scheduler's
  draw material and the provisioning stamp that names a world — hash through
  `@noble/hashes` rather than `node:crypto`, because a browser/server portable
  package may not import a Node built-in. `src/sha256-parity.test.ts` pins byte
  and hex equality against `node:crypto` for the exact material each call site
  builds, including multi-byte UTF-8, because those digests are already in the
  database. The checksum in `src/lib/hash.ts` is the repository-wide FNV-1a from
  `@vesper/contracts`, for the same one-implementation reason.

## Boundary

The rules are the workspace's, not this package's — see
[the guardrails spec](../../docs/developer-notes/finished/monorepo-image-core.spec.guardrails.md)
and `packages/image-core/README.md` §Boundary for the full statement. In short:

- no `@/` imports and no relative path climbing out of this package; consumers
  likewise may not reach in by filesystem path or undeclared subpath;
- **browser/server portable.** `zod`, `@vesper/contracts` and `@noble/hashes`
  are the only runtime dependencies. No Next, no Node-only built-ins, no
  persistence, no `process.env`;
- every published entry file lists named exports; `export *` is rejected there;
- its TypeScript project is its own — no `@/*` alias, no Next plugin, and
  `"types": []`;
- its Vitest project is its own too, with no application setup and no alias, so
  a test here proves something about the simulation rather than about Vesper's
  configuration. The root `typecheck`/`test` scripts reach both by recursing
  over the workspace.

`pnpm lint:package-boundaries` and `pnpm lint:package-resolution` enforce all of
that in the `static` gate of `pnpm verify`.

## What stayed in the application

Three things, each because it is application orchestration rather than
simulation rule:

- **`apps/web/src/server/engine/simulation/`** — the durable stores. They own
  transactions, locks and rows; they call in here for every decision.
- **`apps/web/src/lib/simulation/clock.ts`** — the story clock and the calendar
  bridge. Rendering a `storySecond` as "Day 3 · 10:04am" is presentation, and it
  shares its band thresholds and 12-hour formatting with the chat lane's
  calendar. No kernel in this package reads it; they all work in raw seconds.
- **`apps/web/src/lib/simulation/world-beat.ts` and the Engine Comparison analyzer
  (`shadow-parity.ts`, historical internal filename)** — a transcript line and a
  two-lane comparison report. Both are surfaces the application renders, and
  both stamp their output through that clock.
