# The `apps/web` move — slice 6

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 6

Move the Next.js application from the repository root into `apps/web`, giving
Vesper the conventional monorepo layout. Shared mechanics are in
[monorepo-image-core.spec.md](monorepo-image-core.spec.md).

This slice has the most disruption and the least architectural content in the
plan: it relocates files and rewrites configuration without changing a single
decision about what belongs where. That is why it is last.

## The gate

**Open question, owned by the plan.** "After a deliberate soak" is not a
condition anyone can check, and an uncheckable gate is how a slice either
happens too early or never happens at all. It needs a nameable event. Two
candidates, either sufficient:

- **A model is added or characterized entirely within the packages** — no
  application file changes to support it. That is the boundary doing the job it
  was drawn for.
- **Slice 4 completes without the provider seam moving** — the Replicate
  extraction fits the interface `image-core` already declares, rather than
  forcing a revision of it.

Until one holds, the boundary has not been tested by real work and moving 
the application proves nothing.

## Target layout

```
vesper/
├── apps/web/          src/, next.config.ts, postcss.config.mjs, tsconfig.json
├── packages/          contracts, image-core, image-replicate
├── drizzle/           migrations (stay at root — operational, not app code)
├── scripts/           (stay at root — see below)
├── docs/
├── Dockerfile, fly.toml, docker-compose.yml, docker/
└── package.json, pnpm-workspace.yaml, pnpm-lock.yaml
```

The judgement call is `scripts/` and `drizzle/`. **Both stay at the root.** They
are operational surfaces run against a deployment, not application source: the
seed and migration scripts are invoked over `fly ssh`, the engine evals are run
by CI and by hand, and `drizzle.config.ts` points at a schema path that becomes
`./apps/web/src/server/db/schema.ts`. Pushing them into `apps/web` would make
every runbook command in `docs/deployment.md` wrong for no gain.

## What has to change

Every one of these is a distinct failure if missed. This is the whole cost of
the slice.

### Resolution

- `apps/web/tsconfig.json` — `@/*` becomes `./src/*` relative to the new root;
  the package `paths` entries climb one more level.
- `vitest.config.ts` — either moves into `apps/web` or keeps root-relative
  aliases pointing at the new location. Moving it means `pnpm test` becomes a
  workspace-recursive script.
- `next.config.ts` — moves with the app; `transpilePackages` is unchanged.
- `eslint.config.mjs` — every `src/**` glob becomes `apps/web/src/**`. The
  `packages/**` boundary glob is unaffected. This file carries the module
  boundaries, the route-authz gate and the agent guardrails; a mis-rewritten
  glob silently disables a rule rather than failing, so diff it rule by rule.

### Build and deploy

- `Dockerfile` — the manifest COPY block gains `apps/web/package.json`, and the
  build and runtime stages change working directory. The build is heap-pinned to
  the Fly builder's 4 GB ceiling; keep that pin.
- `package.json` — the root becomes a workspace-scripts manifest, with `dev`,
  `build` and `start` delegating into `apps/web`. The ~60 other scripts (db,
  eval, sim, engine test shards) point at `scripts/` and mostly keep working;
  each one that names a `src/` path needs updating.
- `fly.toml` — check the build context and any path-bearing commands.
- `.github/workflows/ci.yml` — the classifier globs at line 92
  (`src/server/*|src/app/api/*|src/contracts/*|src/lib/simulation/*|…`) become
  `apps/web/src/...`. **A stale glob here fails open**: paths stop matching, the
  classifier decides nothing relevant changed, and jobs are skipped while
  `verify` still reports green. Verify by pushing a deliberate change to a
  formerly-matching path and confirming the expected jobs run.
- `husky` / `lint-staged` — the staged-file globs.
- `drizzle.config.ts` — the `schema` path.

### Documentation

Every doc citing a `src/…` path. `docs/README.md`, the reference docs under
`docs/images/`, `docs/resilience.md`, `docs/deployment.md`, the root `CLAUDE.md`
module-boundary rules, and `docs/developer-notes/CLAUDE.md`.

**Live docs and this plan's own specs get repointed; `finished/` does not**
(root `CLAUDE.md` archiving rule). Shipped plans keep their stale paths by
design.

## Sequencing

**One PR, not several.** A half-moved application does not build, so there is no
intermediate state worth reviewing. The compensating discipline is that the PR
must contain *only* the move: no renames, no cleanups, no "while I was in here".
A reviewer's only question should be whether each path rewrite is correct, and
anything else in the diff makes that unanswerable.

Rebase rather than merge if `main` moves underneath it — a merge commit across a
tree-wide file move produces a conflict resolution nobody can check.

## Verification

- CI `verify` green, **and** the classifier demonstrably still scopes correctly
  (see above — green alone does not prove this).
- `fly deploy -a vesper` succeeds and the deployed app serves a page; `fly status`
  shows the machine healthy.
- A real render works end to end on the deploy, exercising the full chain from
  application through both packages to the provider.
- `pnpm db:migrate` and `pnpm db:seed` still run over `fly ssh console`.
- Spot-check three or four of the operational scripts (`sim:advance`,
  `eval:engine-gate1`, an engine test shard) — these are the surfaces with no CI
  coverage, so a broken path is discovered months later otherwise.

## What this slice explicitly does not do

- Split `apps/web` further. One application, one folder.
- Extract more packages. The package set is whatever slices 2–4 produced.
- Change any module boundary. The ESLint rules move; they do not gain or lose
  members.
