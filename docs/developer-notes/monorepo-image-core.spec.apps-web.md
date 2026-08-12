# The `apps/web` move — slice 6

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 6

Implementation state: not started — blocked on Slice 4 completing without a core/app/provider seam redesign.

Move the Next.js application from the repository root into `apps/web` without
changing application behavior, package ownership, persistent storage, or the
operational commands that still run from the repository root. Shared package
mechanics are in [monorepo-image-core.spec.md](monorepo-image-core.spec.md).

This slice is deliberately last because it changes many paths while adding
almost no architectural value by itself. It should be reviewed as a migration,
not as an opportunity to redesign unrelated code.

## Gate

**Ruling (2026-08-12): Slice 6 starts only after Slice 4 lands without requiring
a redesign of the core/app/provider seam.**

Specifically, the gate is satisfied when:

- `@vesper/image-core` owns planning/compile behavior;
- the application owns Vesper orchestration and runtime configuration;
- `@vesper/image-replicate` owns Replicate transport/probing;
- the Slice 4 implementation did not have to reverse those dependency
  directions or move game state into a package to work.

A new model being added entirely within the package layer is useful evidence but
is not required once this stronger provider-extraction gate has been met.

## Target layout

```text
vesper/
├── apps/
│   └── web/
│       ├── package.json
│       ├── src/
│       ├── next.config.ts
│       ├── postcss.config.mjs
│       └── tsconfig.json
├── packages/
│   ├── contracts/
│   ├── image-core/
│   └── image-replicate/
├── scripts/
├── drizzle/
├── docs/
├── tsconfig.base.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.mjs
├── .jscpd.json
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── Dockerfile
├── fly.toml
└── docker-compose.yml
```

`drizzle/` and `scripts/` stay at the root. They are operational surfaces used by
CI, local tooling and Fly release/SSH commands. Moving them under the web app
would turn a directory cleanup into an operational rewrite.

## Workspace membership

The current workspace explicitly lists `.` and `packages/*`. The app move must
also add `apps/*`:

```yaml
packages:
  - "."
  - "apps/*"
  - "packages/*"
```

Do not remove `.`. The root remains a real workspace package because it owns
operational scripts and repository tooling.

The lockfile must show a separate importer for `apps/web`. A successful local
file move without a corresponding workspace/lockfile importer is not a complete
monorepo migration.

## Package manifests and dependency ownership

### `apps/web/package.json`

Create a real private application package, for example:

```json
{
  "name": "@vesper/web",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

Its dependencies must include everything application source imports at runtime,
including the workspace packages and web/server libraries such as Next, React,
Drizzle, Sharp, Better Auth, AI SDK/provider packages and zod where still used.

Do not rely on a dependency merely because the root happens to install it.
Workspace package ownership should match import ownership.

### Root `package.json`

The root becomes the operational/tooling package:

- repository-level `dev`, `build`, `start`, lint, test and typecheck commands;
- DB/migration/seed scripts;
- eval/simulation scripts;
- CI helper tooling;
- dev dependencies used by those commands;
- runtime dependencies directly imported by root `scripts/` where those scripts
  execute independently of the app package.

Do not aggressively deduplicate dependencies during this move. If both a root
script and the web app genuinely import `drizzle-orm`, for example, both package
manifests may declare it. Removing duplicates is a later cleanup after the move
has proven stable.

Root `dev`, `build` and `start` delegate to the web application while preserving
the repository's existing ports and deployment behavior.

## TypeScript project structure

The current root `tsconfig.json` does three jobs at once:

- Next app configuration;
- repo-wide type coverage for `packages/**`;
- alias/type resolution for root `scripts/`.

Moving that file wholesale into `apps/web` would leave packages and scripts
without the project that currently owns them. Slice 6 therefore creates an
explicit project hierarchy.

### Root `tsconfig.base.json`

Own shared compiler options only:

- target/lib/module/moduleResolution;
- strictness flags;
- noEmit/isolatedModules as appropriate;
- common interop/JSON options.

Do not put the Next plugin or app alias in the shared base.

### `apps/web/tsconfig.json`

Extends the base and owns:

- Next's TypeScript plugin;
- JSX configuration;
- Next-generated type includes;
- `@/* -> ./src/*`;
- package source mappings only if workspace package resolution alone is
  insufficient for the no-build source exports.

### Package-local `tsconfig.json`

Each package gets a local project extending the base and including only its
source/tests. Pure packages do not inherit the Next plugin, DOM assumptions they
do not need, or the application's `@/*` alias.

This makes the package boundary visible to TypeScript/ESLint rather than relying
on one giant root project forever.

### Root `tsconfig.json`

Keep a root workspace/scripts project. It must continue to cover root
`scripts/**` and give them the application alias they currently use, rewritten
to:

```json
"@/*": ["./apps/web/src/*"]
```

It may also act as the repository aggregation project, or the root `typecheck`
script may explicitly check web/packages/scripts projects. Either way,
`pnpm typecheck` must still cover:

- every app source file;
- every package source file, including package-internal files no app currently
  imports;
- every root TypeScript script.

A green Next build is not a substitute for this coverage.

## Vitest and test setup

Keep `vitest.config.ts` at the repository root as the workspace-wide runner.
Moving it into `apps/web` would make package and root-script tests secondary to
the app for no benefit.

Update its paths:

- app test includes move from `src/**` to `apps/web/src/**`;
- `@` resolves to `apps/web/src`;
- package test discovery remains under `packages/*/src/**`;
- script test discovery remains under `scripts/**`.

### Isolate application setup from package tests

The current runner applies `src/test/setup.ts` to every test, including package
tests. That setup mutates AI/provider environment state and is application test
support, not part of `image-core` or `contracts`.

After the move, configure Vitest projects (or an equivalent scoped setup) so:

- application tests use `apps/web/src/test/setup.ts`;
- package tests run without application setup unless a package explicitly owns
  its own setup;
- root script tests receive only the setup they actually need.

Do not preserve a global app setup merely because it makes the migration diff
smaller. Package test independence is one of the reasons for the monorepo.

## ESLint and package boundaries

Keep the root `eslint.config.mjs`. Rewrite application globs from `src/**` to
`apps/web/src/**` rule by rule.

The package boundary block remains `packages/**`, including the resolved-path
`lint:package-boundaries` check introduced by the Slice 1 correction.

Also carry forward the Slice 4 server-only restriction for
`@vesper/image-replicate` into the new app paths.

A stale ESLint glob is dangerous because it usually fails open. Review every
zone, not only search/replace the string `src/`.

## Repository tools with hard-coded app paths

Do a repo-wide inventory of live path assumptions before moving files. Do not
limit the checklist to the files remembered when this spec was written.

Known required updates include:

- `package.json` script arguments that name `src/...` tests/modules;
- `scripts/check-route-authz.ts`, whose route regex names `src/app/api`;
- `lint:cycles` / madge roots and TypeScript config;
- `.jscpd.json`, whose scan paths currently include root `src`;
- `vitest.config.ts` includes, alias and app setup path;
- `drizzle.config.ts` schema path;
- `.github/workflows/ci.yml` classifier globs;
- VS Code workspace/debug paths;
- any root scripts with direct `../src/...` imports;
- live reference/working docs that cite current application paths.

Use a repository search for `src/`, `./src`, `../src`, and path-specific regular
expressions/config keys, then classify every hit as:

- live path to rewrite;
- historical `finished/` documentation to leave untouched;
- prose example that remains valid;
- unrelated string.

This inventory is part of implementation, not optional cleanup.

## `jscpd` and silent coverage loss

`.jscpd.json` currently scans `src` and `packages`. After the move it must scan:

```json
"path": ["apps/web/src", "packages"]
```

plus any existing intended script coverage if that policy changes separately.

Do not accept a green `jscpd` result until the app path is visibly present in its
configured scan roots; otherwise the move can make the check silently stop
looking at most of the application.

## CI classifier

Rewrite the classifier paths from root `src/**` to `apps/web/src/**`, preserving
the meaning of each class:

- code;
- integration/DB/API-sensitive;
- successor-engine-sensitive;
- config/workspace changes.

A stale classifier path fails open: jobs skip and aggregate `verify` can still be
green. Verification therefore requires more than a successful workflow. In the
Slice 6 PR, make a deliberate changed file under a path that formerly triggered
each important class and confirm the expected jobs are scheduled.

Package-only changes must continue to trigger the full code/static/unit/build
set as they do before the move.

## Environment ownership

Keep `.env.example` and the developer's local `.env` at the repository root.
Root scripts and the web app share the same provider/database/auth settings, so
moving the env file into `apps/web` would either duplicate secrets or break root
operational commands.

The web launcher/config must load the repository-root env deliberately rather
than assuming Next will discover a parent `.env` after the project directory
moves. Use one explicit root-env loading path and document it in
`docs/getting-started.md` during the implementation.

The Fly deployment remains environment/secret-driven and is unaffected by local
`.env` placement.

## Persistent image storage and process working directory

This is a release blocker, not a cleanup detail.

`src/server/images/paths.ts` currently falls back to:

```ts
path.join(process.cwd(), "data")
```

Fly mounts the persistent image volume at `/app/data`, and the deployment also
supports an explicit `DATA_ROOT=/app/data` secret. Changing the runtime working
directory to `/app/apps/web` without preserving or explicitly setting
`DATA_ROOT` would make the app look under `/app/apps/web/data` and make the
existing image library appear missing.

### Required behavior

- **Fly/runtime:** keep the volume mount at `/app/data` and make the runtime use
  `DATA_ROOT=/app/data` explicitly. Do not depend on process CWD for persistent
  production storage.
- **Docker:** keep the runner's repository root as `/app`; do not change the
  global runtime `WORKDIR` merely because the Next project lives under
  `apps/web`. Invoke the web app explicitly from that root. Set/preserve
  `DATA_ROOT=/app/data` in the runner environment so the invariant survives
  future command changes too.
- **Local dev:** an unset `DATA_ROOT` must still resolve to the same repository
  `data/` directory used before the move. The root web launcher must establish
  that absolute default before delegating if the Next app execution changes
  process CWD.

The implementation may use a small root launcher/config helper to establish the
canonical repo root and env once. Do not scatter `../../data` literals through
app code or scripts.

### Required regression checks

Before merging Slice 6, prove:

- with local `DATA_ROOT` unset, the resolved data root is the repository's
  existing `data/` directory;
- with `DATA_ROOT=/app/data`, it remains exactly `/app/data` regardless of the
  web project directory;
- an existing stored image row/file remains readable after the deployed move;
- creating a new render writes beside the existing images on the same Fly
  volume.

## Docker build and runtime

Keep the build context at the repository root.

Manifest/install stage must copy:

- root `package.json` / lockfile / workspace file;
- `apps/web/package.json`;
- every workspace package manifest.

Then run one root `pnpm install --frozen-lockfile`.

The build may call the root delegating `pnpm build` or filter the web package
explicitly; it must still use the existing 4 GB Node heap ceiling.

At runtime:

- keep `/app` as the operational root;
- keep the full dependency tree, since release-time DB migration still uses root
  tooling;
- invoke Next for `apps/web` explicitly rather than assuming root is the Next
  project;
- preserve `$PORT`/host behavior;
- preserve `DATA_ROOT=/app/data`.

Do not rely on root `node_modules/next` after dependency ownership moves to
`apps/web`; invoke the binary from the web workspace or another explicit
workspace-safe path.

## Fly release command and operational scripts

`fly.toml` keeps the release command at the root operational layer. Prefer an
explicit workspace-root spelling such as:

```text
pnpm -w db:migrate
```

so a future command/CWD change cannot accidentally run an app-local script of the
same name.

The following must keep working from the repository root and over `fly ssh` as
applicable:

- `db:migrate`;
- `db:seed`;
- `db:generate` / Drizzle schema discovery;
- `sim:advance`;
- `eval:engine-gate1`;
- representative engine test shards;
- image eval scripts that import app/package code.

Root scripts with direct relative imports such as `../src/...` are rewritten to
`../apps/web/src/...`; scripts using the `@/` alias rely on the root TypeScript
project's updated mapping.

## Next/postcss application config

Move `next.config.ts` and `postcss.config.mjs` into `apps/web` because they belong
to the web app.

`next.config.ts` keeps:

- security headers;
- server external packages;
- all workspace packages in `transpilePackages`;
- allowed dev origins;
- Turbopack cache choice.

Any root-env loading needed by the new project location is added here or through
the one root launcher path described above; do not create competing env loaders.

## Documentation

Update live docs and instructions that describe current paths, including at
least:

- `docs/README.md`;
- `docs/architecture.md`;
- `docs/getting-started.md`;
- `docs/testing.md`;
- `docs/deployment.md`;
- image reference docs under `docs/images/`;
- root `CLAUDE.md`;
- `docs/developer-notes/CLAUDE.md`;
- this monorepo topic family.

Do not rewrite `docs/developer-notes/finished/**` solely because the app moved;
those files preserve the paths of the work they documented when it shipped.

## Sequencing

One PR. A half-moved application has no useful intermediate state.

The PR contains only migration-required work:

- file moves;
- workspace/package manifests;
- path/config rewrites;
- TypeScript/test/tool project separation required by the new layout;
- environment/storage preservation required to keep behavior unchanged;
- documentation path updates.

No unrelated renames, refactors or feature fixes.

Rebase rather than merging `main` into the branch if the tree moves underneath
this PR. A merge conflict spread across a repository-wide directory move is much
harder to review than a rebased path rewrite.

## Verification

### CI

- aggregate `verify` green;
- classifier demonstrably schedules the expected jobs for moved app paths;
- package-only changes still classify as code;
- TypeScript covers app, packages and root scripts;
- package tests run without app-global setup;
- `jscpd` visibly scans `apps/web/src`.

### Local/repository command shape

Without running the heavy gates locally, inspect/CI-test that root scripts still
resolve their moved imports and aliases. Spot-check representative operational
commands in the deployed environment where the runbook already expects them.

### Fly deployment

- `fly deploy -a vesper` succeeds;
- release migration succeeds from the root command;
- `fly status -a vesper` shows the machine healthy;
- the app serves a page;
- an existing stored image still loads from the mounted volume;
- a real new image render succeeds and writes to the same volume;
- a real Replicate model probe still succeeds;
- `pnpm -w db:migrate` and `pnpm -w db:seed` work over `fly ssh console`.

### Operational spot checks

Run representative non-CI-covered root commands after deploy, including:

- `sim:advance`;
- `eval:engine-gate1`;
- one engine test shard or equivalent resolution check;
- one image eval script that crosses root script -> app/package imports.

## What this slice explicitly does not do

- Split `apps/web` into more applications.
- Extract additional packages.
- Change image/game ownership decisions made by Slices 1–4.
- Rework the provider seam.
- Change persistent image-storage semantics.
- Move `scripts/` or `drizzle/` under the web app.
- Deduplicate root/web dependencies beyond what is necessary to make ownership
  explicit.
