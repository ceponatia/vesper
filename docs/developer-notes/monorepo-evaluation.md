# Should Vesper move to a monorepo?

Status: **analysis / recommendation** (2026-06-14). Evaluates converting the
single Next.js app into a pnpm workspace of packages, outlines the package grain
we'd use **if/when** we do, and specifies how boundaries would be enforced both
architecturally and in agent-facing `CLAUDE.md` files. Grounded in the current
import graph and in [aionchat](file:///home/brian/projects/aionchat)'s monorepo,
which is the user's working reference model. Parked in
[deferred.plan.md](deferred.plan.md) behind a trigger.

---

## Recommendation up front

**Do not split now. Harden the boundaries we already have, and pre-commit to a
*small, consumer-driven* split that we execute the moment a second deployable
appears.** Three reasons, in order of weight:

1. **We already ran this experiment and reverted it.** Per
   [architecture.md](../architecture.md), Vesper was collapsed *from a 12-package
   monorepo* because "every package served exactly one consumer." That condition
   **still holds today** — there is one deployable (the Next.js server). A split
   now would re-create the exact structure we deleted, and the first Explore pass
   on this very question produced a ~12-package outline that is precisely the
   abandoned shape. That is the trap to avoid.
2. **The boundaries a monorepo would enforce are already enforced — for free.**
   Verification of the current `src/` import graph found them essentially intact:
   - `contracts` and `lib` are pure; the only IO is a `process.env.LOG_LEVEL`
     read in `src/lib/log.ts` (server-only consumer, trivially gated).
   - **Zero** `@/server/*` imports from `components/` or non-API `app/` code.
   - **100%** barrel discipline — every cross-module server import goes through an
     `index.ts`; no deep reaches into another module's internals.
   - **Zero** cross-boundary relative imports; everything crosses via the `@/*`
     alias.
   A workspace would add build/wiring machinery (per-package `package.json`,
   `workspace:*` graph, Turbo, possibly `dist` builds) to *enforce* what code
   review + the `@/` alias + barrels already deliver at near-zero cost.
3. **It raises agent-confusion in the near term, the opposite of the goal.**
   Today the rule set is five lines in `CLAUDE.md` and one path alias. A split
   mid-flight through phase 4 means every boundary-crossing import is rewritten
   (`@/server/...` → `@vesper/engine`), agents must learn the package map, and the
   payoff is deferred. We'd pay the confusion cost up front for a benefit we don't
   yet need.

This is **not** "monorepos are bad." It's "the split must be paid for by a second
consumer, and we don't have one yet." The section below defines exactly what flips
the decision.

---

## The decision gate — what makes the split worth it

Adopt the moment **any one** of these becomes real (most likely first is bolded):

- **A second deployable that shares the engine.** Phase 4 ("the world moves") is
  the probable source: if offscreen simulation
  ([offscreen-simulation-spec.phase3.md](offscreen-simulation-spec.phase3.md)) or
  the scheduled-arrivals tick
  ([scheduled-arrivals.spec.md](scheduled-arrivals.spec.md)) graduate
  from inline post-turn jobs into a **standalone background worker / cron
  process**, then `engine` + `memory` + `db` + `ai` suddenly have *two* consumers
  (the web request path and the worker). That is the canonical monorepo trigger —
  shared code behind two independent entry points.
- **A published or cross-project shared core.** If we decide the pure
  `contracts` (+ pure `lib`) layer should be consumed by a sibling app
  (reverie/aionchat lineage) or shipped as an SDK, it needs a package identity.
  *Caveat:* Vesper is a deliberate fork meant to diverge, so re-sharing with
  reverie may be counter to the fork's purpose — weigh before treating this as a
  driver.
- **A second app surface** (e.g. a separate admin/ops UI, a mobile client) that
  reuses `components` or `lib/client`.
- **CI typecheck/test time becomes a real cost** and isolating the pure core to
  test it independently (aionchat's `pnpm validate` per package) would materially
  speed it up. Unlikely at 336 files / ~48k LOC; revisit at multiples of that.

Until one fires, the correct action is the **interim hardening** below, not a
split.

---

## Interim hardening — **done (2026-06-14)**

The conventions are now *checks* that survive without a workspace:

1. **ESLint boundary rule — done.** Three `no-restricted-imports` config blocks in
   `eslint.config.mjs` (disjoint file globs, so no override conflicts) encode the
   four rules architecture.md states:
   - `src/contracts/**` and `src/lib/**` may not import `@/server`, `@/app`,
     `@/components`.
   - `src/components/**` and `src/app/**` (excluding `src/app/api/**`) may not
     import `@/server`.
   - cross-`server`-module imports must target a barrel (`@/server/<module>`),
     not a deep path.
   Shipped at `error` with zero violations (one test deep-import was barrel-ized).
   Notably, this is the one thing **aionchat's monorepo lacks** (it relies on
   docs + the build graph). For an agent-driven codebase a hard lint error is the
   clearest possible signal, and we get it *without* the workspace.
2. **Purity gate — done.** `log.ts` (the only `process.env` read in `lib`, used
   only by server code) moved `src/lib/log.ts` → `src/server/log.ts`; `src/lib` is
   now provably pure and the future package boundary is clean.
3. **`contracts ↔ lib` relationship — clarified.** It is **bidirectional edges,
   not a true cycle**: `lib/parse.ts` → `@/contracts/diagnostics`, and
   `contracts/world` / `contracts/perception` → `@/lib/clock`; there is no
   lib→contracts→lib loop. When we split, folding pure `lib` into `core` alongside
   `contracts` dissolves both edges intra-package.

The eventual split is now a mechanical move of already-clean, lint-guarded
folders, not a refactor.

---

## The package grain — *when* we split

Split by **consumer / deployable**, not by folder. The lesson from both our own
abandoned 12-package repo **and** aionchat's graveyard of empty stub packages
(`api`, `auth`, `db`, `ui`, `utils`, `web`, `mobile`, … all 0 files) is the same:
**scaffolding packages ahead of a consumer produces dead structure.** Create a
package only when a second thing imports it.

Target shape — **4 packages, created lazily in this order:**

```
packages/
  core/      @vesper/core     pure: contracts/ + lib/ (zero IO). Consumed by everyone.
  engine/    @vesper/engine   server domain: db, ai, engine, memory, images,
                              authoring, auth, api. Depends on core. NO React, NO Next.
apps/
  web/       @vesper/web      the Next.js app: app/ + components/ + lib/client.
                              Depends on engine (server-side) + core.
  worker/    @vesper/worker   FUTURE — the trigger. Background world-simulation /
                              scheduled-arrival ticks. Depends on engine + core,
                              NOT web. Its existence is what justifies the split.
```

Rationale for this grain specifically:

- **`core` is the one package with a real multi-consumer case today** — `web`,
  `engine`, the future `worker`, and `scripts/` all import contracts/lib. Folding
  the pure `lib` into `core` alongside `contracts` **dissolves the `contracts↔lib`
  cycle** internally (it becomes intra-package) instead of forcing a third
  `diagnostics` micro-package.
- **`engine` stays one package, not seven.** The import graph shows `engine`,
  `memory`, `images`, `ai` are near-standalone leaves and `db` is the shared hub;
  there is no second consumer that wants `memory` *without* `engine`. Splitting
  server into per-folder packages is the 12-package mistake. One `engine` package
  with the existing `index.ts` barrels as its public surface is right.
- **`worker` is the whole point.** It is the second consumer of `engine` that
  makes the `web`/`engine` seam load-bearing. Before it exists, `engine` could
  equally live inside `web` — which is why we wait.

Explicitly **rejected**: a package per `src/server/*` folder; an `api-client`/
`ui`/`utils` package with no second consumer; anything that exists "for symmetry."

---

## How boundaries get enforced (architectural + agent-facing)

Two layers, matching aionchat's model but adding the lint check it omits.

### Architectural — the dependency graph makes wrong imports impossible

- **`workspace:*` deps only flow downhill.** `core` declares no workspace deps;
  `engine` depends on `core`; `web`/`worker` depend on `engine` + `core`. A file
  in `core` *cannot* import `engine` because `engine` isn't in its `package.json`
  — the resolver fails. This converts "convention" into a compile/resolve error,
  which is strictly stronger than today's review-time rule.
- **Consume packages as raw TS via `transpilePackages`, not `dist`.** aionchat
  builds each package with `tsc → dist/` because its consumer is a CLI. Next.js
  can consume workspace packages as source via `next.config` `transpilePackages`
  + an `exports` field pointing at `src/index.ts`. This avoids a build step in the
  edit loop, keeps HMR fast, and sidesteps the dist/server-component friction. Use
  `dist` builds only for a package a non-Next consumer needs ahead of the app
  (e.g. `worker` may want `core` prebuilt — decide then).
- **Per-package `tsconfig`** with its own `paths` so the pure `core` can't even
  name a server type. Skip TypeScript **project references** (`composite`) unless
  CI build time demands it — aionchat doesn't use them and Turbo's `^build`
  ordering covers the same need more simply.
- **Turbo (or pnpm `-r`) for fan-out** — `build`/`lint`/`typecheck`/`test` with
  `dependsOn: ["^build"]`, exactly aionchat's pipeline. A root `pnpm validate`
  = lint + typecheck + test across the graph.
- **Keep the ESLint boundary rule from interim hardening** as belt-and-suspenders
  for the within-`engine` barrel discipline (which `package.json` deps can't
  express, since it's intra-package).

### Agent-facing — `CLAUDE.md` per package + a root map

Mirror aionchat's per-package `AGENTS.md` discipline, but in `CLAUDE.md` (Vesper's
agent-doc of record; keep the existing root `AGENTS.md`/`CLAUDE.md` pair):

- **Root `CLAUDE.md`** gains a one-line-per-package map with the **import
  direction** stated as law, e.g.:
  > `core` ← `engine` ← (`web` | `worker`). Never import uphill. `web` is the
  > only package with React/Next; `core` is the only package importable from a
  > browser; nothing imports `web`.
- **`packages/core/CLAUDE.md`**, **`packages/engine/CLAUDE.md`**,
  **`apps/web/CLAUDE.md`**, **`apps/worker/CLAUDE.md`** — each ≤ ~40 lines, same
  template aionchat uses, with three mandatory sections:
  1. **Purpose** (2–3 lines).
  2. **May import / must NOT import** — explicit allow/deny list of sibling
     packages and forbidden categories (`core`: no IO, no fetch, no `node:*`, no
     `process.env`; `engine`: no React, no Next, no DOM; `web`: server code only
     through `engine`'s barrel, never reach into its internals).
  3. **Owns / does not own** — what lives here vs. belongs elsewhere (the
     registries live in `core`; prompt/agent orchestration in `engine`; route
     handlers stay thin in `web`).
- **Place each `CLAUDE.md` at the package root** so the harness loads the right
  one by working directory — an agent editing `packages/core` sees core's rules,
  not the app's. This is the single biggest "don't confuse the agent" win of the
  whole move: the rules become *local and unambiguous* instead of a global list
  the agent must mentally scope.

The combination — `package.json` deps (resolve error) + ESLint paths (lint error)
+ per-package `CLAUDE.md` (agent guidance) — is defense in depth: an agent is
*told* the rule, *linted* on it, and *can't resolve* a violation even if it tries.

---

## Migration cost, when triggered

Mostly mechanical, but not free:

- **Import rewrites.** Every boundary-crossing `@/...` import changes to a package
  specifier (e.g. `@/server/engine` → `@vesper/engine`). The web/api layer alone
  has ~110 `@/server` imports. A codemod over the `@/` alias makes this scripted,
  not hand-done.
- **Within-package imports stay `@/*`** (each package keeps a local alias), so only
  the crossings move.
- **Test wiring** — `vitest.config.ts` per package (or a workspace vitest project
  config); the `*.int.test.ts` Postgres suite lives with `engine`.
- **DB workflow unchanged** — `drizzle/` + `schema.ts` move into `engine`; the
  `pnpm db:*` scripts re-home there. The migration self-enable line (CLAUDE.md)
  must be preserved through the move.
- **No behavior change, no schema change.** This is a packaging refactor; it should
  land as its own commit with green typecheck + full test run, ideally when no
  large feature is mid-flight.

---

## Bottom line

The codebase is *ready* for a monorepo — boundaries are clean enough that the
split is mechanical. It just isn't *justified* yet, because there's one consumer.
Do the interim hardening now (lint rule + purity gate), watch for the
second-deployable trigger (most likely a phase-4 simulation worker), and when it
fires, execute the **4-package, consumer-driven** split above — not the 12-package
shape we already discarded, and not aionchat's stub-package sprawl. Enforce it with
the dependency graph first and per-package `CLAUDE.md` second, so the structure
guides agents instead of confusing them.
