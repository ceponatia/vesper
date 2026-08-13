# The `apps/web` move — slice 6

Status: detail for [monorepo-image-core.plan.md](monorepo-image-core.plan.md) slice 6

Implementation state: built 2026-08-12 — awaiting the deployed verification below (existing image loads, new render writes to the same volume, root commands over `fly ssh`).

Move the Next.js application from the repository root into `apps/web` without
changing application behavior, package ownership, persistent storage, or the
operational commands that still run from the repository root. Shared package
mechanics are in [monorepo-image-core.spec.md](monorepo-image-core.spec.md), and
the workspace import/dependency guardrails already exist by this point from
[monorepo-image-core.spec.guardrails.md](monorepo-image-core.spec.guardrails.md).

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

## Implementation record

The move landed on 2026-08-12. The layout, manifests, TypeScript projects,
Vitest projects, ESLint zones, jscpd roots, CI classifier, Docker/Fly wiring and
reference documentation are all as described below, with the differences and
rulings recorded here rather than by rewriting the sections they came from.

**`@vesper/web` is an application workspace, not a package.** It carries the
`@vesper` scope like every package, so the boundary checker cannot tell them
apart by name. `WorkspacePolicy` gained `applicationWorkspaces`, and the checker
now asks "is this an application?" everywhere it previously asked "is this the
repository root?" — for the `@/` alias, the layer rank, the runtime target, the
computed-dynamic-import ban and the package listing. Getting this wrong is silent
in both directions, so `scripts/check-workspace-imports.test.ts` gained a
fixture repository with a non-root application workspace that asserts all four
behaviours.

**Root scripts keep `@/` and gain nothing else.** Root `tsconfig.json` maps
`@/*` to `./apps/web/src/*`, which is what `tsx` reads at runtime, so the
existing root-script → application edge is unchanged in kind and still the only
one. A relative path into `apps/web` remains a `cross-workspace-path` violation.

**The root manifest declares every `@vesper/*` package.** `lint:package-resolution`
imports each package by name *from the repository root*, so a package the root
cannot resolve is exactly the failure the check exists to report.
`@vesper/contracts` is therefore a root devDependency even though no root script
imports it.

**One launcher owns the two repository-level facts.** `scripts/web.mjs` is the
only way the app starts (`pnpm dev` / `build` / `start`, and the Docker `CMD`).
It sets `DATA_ROOT` to the repository's `data/` when unset, loads the
repository-root `.env` (existing variables win), resolves Next from the
`apps/web` workspace, and runs it with `apps/web` as the project directory.

The env loader is deliberately NOT in `next.config.ts`: `next start` reads the
build's `required-server-files.json` rather than executing the config, so a
config-file loader would cover dev and silently miss production. The spec's
"added here or through the one root launcher path" is resolved to the launcher.

**`scripts/**` tests stay in the `app` Vitest project.** The spec anticipated a
separate script project with only root/tooling setup. In practice those tests are
the repository's tripwire tests — they scan application source and import
`@/server/test-support` — so they need the application alias and the same
demo-mode setup as the code they inspect. Package isolation, which is what that
rule exists to protect, is unaffected.

**The Vitest run root stays the repository root.** Several tripwire tests locate
source as `process.cwd()` plus a repo-relative path, and keeping the run root
where it was is what preserves their meaning; their literal paths were re-rooted
at `apps/web/src/…`, including the `repoRelative()` allow-lists in
`image-internal-callers.test.ts` and `ownership-guardrail.test.ts`.

**`.dockerignore` needed `**/` on three more patterns.** `.next/`,
`*.tsbuildinfo` and `next-env.d.ts` are anchored at the context root, so all
three stopped matching the moment the Next project moved — a local dev build
would have shipped into the image.

**Root dependency ownership moved with the code.** `next`, `react`, `react-dom`,
`better-auth`, `ai`, `@openrouter/ai-sdk-provider`, `@paralleldrive/cuid2`,
Tailwind and the React types are now owned by `apps/web`; the root keeps what its
scripts import (`drizzle-orm`, `pg`, `sharp`, `zod`, the workspace packages) plus
its tooling. Root `node_modules/next` no longer exists, which is why the Docker
`CMD` boots through the launcher rather than a root binary path.

**Next-aware ESLint is pinned explicitly.** `settings.next.rootDir` is
`apps/web`, and `scripts/next-eslint-scope.test.ts` asserts both that the Next
rules resolve for an application file and that the module-boundary zones still
match under the moved path — the failure this guards is a green lint run that
quietly stopped applying to the app.

**The route-authorization gate now ignores pure renames.** `lint:authz` reads a
changed file's source, and a repository-wide move makes every file "changed" —
so the move turned a per-change gate into a wall of 30 findings about routes
nobody had touched. `changedFiles()` switched to `git diff --name-status
--find-renames -l0` and drops `R100` entries; a rename that also edited the file
still counts. (`-l0` matters: above git's default rename limit a large diff
silently degrades renames into add+delete pairs, and every moved file would come
back as new content.) Those 30 routes are pre-existing and unexamined — the gate
has only ever inspected newly-touched routes — and auditing them is security
work, not migration work.

**One dead root-assumption file was deleted.** `dbsetup.js` — unreferenced `fly
launch` scaffolding that ran `npx next build` against the current directory —
was surfaced by the path audit as broken by the move. Nothing in `package.json`,
`Dockerfile` or `fly.toml` calls it, so it was removed rather than re-rooted.

**Documentation scope.** The reference tier (`docs/` outside
`developer-notes/`), the root `CLAUDE.md`, the package READMEs and this topic
family were re-rooted. Other working docs keep the paths they were written with,
for the same reason `finished/` does: they record work as it stood, `grep`
still finds them, and rewriting a year of plans buys tidiness at the cost of a
very large diff.

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

The Slice 1 workspace-import checker now treats `apps/web` as a workspace root
automatically. Cross-workspace relative imports remain forbidden after the move;
root scripts that legitimately need application behavior use the application's
public/approved import path rather than turning `../apps/web/src/...` into a new
general convention. Existing root operational scripts that still require direct
application source during this migration are explicitly inventoried exceptions
and should be reduced rather than silently normalized.

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

Do not rely on a dependency merely because the root happens to install it. The
workspace dependency checker established in Slice 1 is updated to recognize
`apps/web/package.json` as the nearest manifest and must fail if web source uses a
bare dependency the web package does not own.

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

Package-local TypeScript projects already exist before Slice 6. This slice
reorganizes the root/application hierarchy around the new path; it does not make
packages independently typechecked for the first time.

### Root `tsconfig.base.json`

Create a shared base for compiler options that truly apply across projects:

- target/module/moduleResolution;
- strictness flags;
- noEmit/isolatedModules as appropriate;
- common interop/JSON options.

Do not put the Next plugin, the app alias, or browser/server runtime libraries in
the shared base merely for convenience. Each project owns the environment it
actually targets. Existing package-local projects are adjusted to extend this
base without gaining new ambient capabilities.

### `apps/web/tsconfig.json`

Extends the base and owns:

- Next's TypeScript plugin;
- JSX configuration;
- Next-generated type includes;
- browser/DOM libraries required by the application;
- `@/* -> ./src/*`;
- package source mappings only if normal workspace/package `exports` resolution
  is demonstrably insufficient.

Do not introduce a wildcard `@vesper/* -> ../../packages/*/src` path mapping. The
real-workspace resolution smoke check from Slice 1 remains authoritative against
manifest/export drift.

### Package-local `tsconfig.json`

Keep each package-local project and move only shared compiler settings into the
base. `@vesper/image-core` and `@vesper/contracts` remain universal packages;
`@vesper/image-replicate` remains Node/server. None inherits the Next plugin or
application `@/*` alias.

### Root `tsconfig.json`

Keep a root workspace/scripts project or solution project. Root `pnpm typecheck`
must still cover:

- every app source file;
- every package source file, including package-internal files no app currently
  imports;
- every root TypeScript script.

If project references are used, make the dependency direction match the
workspace layer policy. A green Next build is not a substitute for repository
TypeScript coverage.

## Vitest and test setup

Keep `vitest.config.ts` at the repository root as the workspace-wide runner.
Package/app setup isolation already exists from Slice 1; preserve that separation
while rewriting paths.

Update:

- app test includes from `src/**` to `apps/web/src/**`;
- the application `@` alias to `apps/web/src`;
- the app project's setup path to `apps/web/src/test/setup.ts`;
- package test discovery under `packages/*/src/**` without application setup.

`scripts/**` tests stay in the `app` project — they are application tripwires and
need its alias and setup (see [Implementation record](#implementation-record)).

Do not collapse the projects back into one global setup simply because the path
move makes a single configuration shorter, and do not move the runner's root off
the repository root: tripwire tests locate source through `process.cwd()`.

## ESLint and package boundaries

Keep the root `eslint.config.mjs`. Rewrite application globs from `src/**` to
`apps/web/src/**` rule by rule.

Carry forward:

- the workspace-import/dependency guardrail from Slice 1;
- package root export enforcement;
- the Slice 4 server-only restriction for `@vesper/image-replicate`;
- all current application zone rules, rewritten to the moved path.

A stale ESLint glob is dangerous because it usually fails open. Review every
zone, not only search/replace the string `src/`.

### Tell Next-aware ESLint where the app moved

Once the Next application is no longer at the repository root, configure the
Next ESLint settings/root so `eslint-config-next` resolves `apps/web` as the
application rather than assuming the repository root is the Next project. Keep
that location explicit in the root flat config and cover it in lint verification.

A green ESLint run that silently stopped applying Next-specific rules to the web
application is a migration failure.

## Repository path and working-directory audit

Do a repo-wide inventory of live path assumptions before moving files. Do not
limit the checklist to files remembered when this spec was written, and do not
limit the search to strings containing `src/`.

### Source/config path spellings

Search and classify at least:

- `src/`, `./src`, `../src` and path-specific regular expressions;
- package.json script arguments naming app tests/modules;
- `scripts/check-route-authz.ts` route regexes;
- `lint:cycles` / Madge roots and TypeScript config paths;
- `.jscpd.json` scan roots;
- Vitest includes, aliases and setup paths;
- Drizzle schema/config paths;
- `.github/workflows/ci.yml` classifier globs;
- VS Code workspace/debug paths;
- live reference/working docs that cite current application paths.

### CWD and filesystem assumptions

Also search and classify:

- every `process.cwd()`;
- `import.meta.url`, `__dirname`-style repo-relative resource resolution, and
  `path.resolve`/`path.join` calls that assume a repository/application root;
- direct filesystem reads/writes with relative paths;
- generated output/cache/report directories;
- `.gitignore` and `.dockerignore` entries whose meaning changes when `.next`,
  generated files, or app assets move;
- Docker/Fly commands that assume the Next project is the current directory;
- scripts that infer repo root by a fixed number of `..` segments.

For each hit, classify it as:

- live path/root assumption to rewrite or make explicit;
- intentional workspace-root behavior to preserve and regression-test;
- historical `finished/` documentation to leave untouched;
- prose example that remains valid;
- unrelated string.

This inventory is part of implementation, not optional cleanup. The persistent
image path below is one known high-risk case, not the only CWD-sensitive path to
check.

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
set as they do before the move. `apps/web` manifest/config changes must also
trigger the same config/integration-sensitive classes that equivalent root app
changes trigger today.

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

Any other CWD-sensitive path found by the repository audit receives an equivalent
before/after assertion or an explicit reason it is unaffected.

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

The Docker install/build is part of the real-workspace resolution proof: it must
not depend on TypeScript/Vitest source aliases to make workspace package imports
work.

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

For root scripts that currently import application source directly, inventory the
edge before rewriting it. If it is genuinely an operational app dependency,
make the exception explicit and keep it covered by the workspace boundary
policy; do not broadly exempt `scripts/** -> apps/web/src/**` relative imports.

## Next/postcss application config

Move `next.config.ts` and `postcss.config.mjs` into `apps/web` because they belong
to the web app.

`next.config.ts` keeps:

- security headers;
- server external packages;
- all workspace packages in `transpilePackages` that still require source
  transpilation;
- allowed dev origins;
- Turbopack cache choice.

Root-env loading is NOT added here. It lives in the one root launcher, because
`next start` reads the build's `required-server-files.json` instead of executing
this file — a loader here would cover dev and silently miss production. Do not
create a competing env loader.

Keep the Next project root explicit everywhere that tool resolution depends on
it: launcher/build command, ESLint Next settings, generated types, and any build
cache/output assumptions.

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
- TypeScript/test/tool project re-rooting required by the new layout;
- environment/storage/CWD preservation required to keep behavior unchanged;
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
- TypeScript covers app, packages and root scripts through their intended
  projects;
- package tests remain isolated from app-global setup;
- workspace/dependency/import-direction guardrails remain green with `apps/web`
  as a workspace;
- real package-name/exports resolution smoke checks remain green;
- Next-aware ESLint rules demonstrably apply to `apps/web`;
- `jscpd` visibly scans `apps/web/src`.

### Path/CWD audit

- every live `src/` path assumption is classified;
- every `process.cwd()` and equivalent repo-root/filesystem assumption is
  classified;
- `.gitignore` / `.dockerignore` still cover intended generated/runtime data;
- no check becomes green merely because its old scan root disappeared.

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
- one image eval script that crosses root tooling -> application/package
  boundaries.

## What this slice explicitly does not do

- Split `apps/web` into more applications.
- Extract additional packages.
- Change image/game ownership decisions made by Slices 1–4.
- Rework the provider seam.
- Change persistent image-storage semantics.
- Move `scripts/` or `drizzle/` under the web app.
- Deduplicate root/web dependencies beyond what is necessary to make ownership
  explicit.
