# Deployment (Fly.io)

The dev build runs on **Fly.io** — a single always-on Machine running the Next.js
app and a **Fly Volume** for image storage — with **Neon** (serverless Postgres
with **pgvector**) as the database. Fly was chosen because this account has a
**legacy Fly org** that predates the "no free allowance for new orgs" change;
Neon hosts the DB rather than a Fly Postgres app (the app reaches it through the
`DATABASE_URL` secret). (The earlier Hetzner + Tailscale plan is superseded; Fly
trades the Tailscale "private by default" posture for a public `*.fly.dev` URL
gated by Better Auth — see Security below.)

This is deliberately **not** serverless: the turn engine runs an in-process job
worker loop (`apps/web/src/server/engine/jobs.ts`) and images are written to a local
filesystem (`DATA_ROOT`, `apps/web/src/server/images/assets.ts`). Both need an always-on
Machine with a persistent volume — so `auto_stop_machines` must be **off**.

## Files

| File            | Role                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `Dockerfile`    | App image (build + runtime). Keeps full deps so `pnpm db:migrate` works; no `pnpm prune`. |
| `.dockerignore` | Keeps `node_modules`/`.next`/`.env`/`data` out of the build context, at every depth.      |
| `fly.toml`      | Machine + service config (managed in the Fly UI / repo — see recommended version below).  |

## The Dockerfile (key choices)

- **No `pnpm prune --prod`.** Pruning deletes `tsx`, which the release-command
  migrations need at runtime.
- **Full dependency tree at runtime** so `pnpm db:migrate` (runs via `tsx`) works
  from the release command.
- **Binds to `$PORT` (8080)** by calling the root launcher (`node scripts/web.mjs
  start`) directly — the package.json `start` script hardcodes `-p 3200`, which
  would mismatch Fly's `internal_port`.
- **`/app` stays the workspace root, not the Next project.** The app lives at
  `/app/apps/web`, and the launcher runs Next there while `/app` remains the
  process root — which is what keeps the volume at `/app/data` and the root
  release/SSH commands working. Every workspace manifest (including
  `apps/web/package.json`) is copied before `pnpm install`, or `workspace:*`
  resolves against nothing.
- **`DATA_ROOT=/app/data` is set in the runner stage**, not inferred from the
  working directory. The fallback in `dataRoot()` is `<cwd>/data`, so stating it
  explicitly is what stops a future change to how the app is started from
  repointing the image library.
- `sharp` works from its prebuilt `@img/sharp-*` binary; the "Ignored build
  scripts: sharp" pnpm warning is benign.
- **`NODE_OPTIONS=--max-old-space-size=4096` on the build step**, inline so the
  runner never inherits a heap cap it does not need. The app is past Node's
  default old-space ceiling; raise this number if the build worker starts
  aborting again (see Troubleshooting).

## Recommended `fly.toml`

The generated file has three problems: it scales to zero (kills the worker), sets
256 MB RAM (can't boot Next), and runs no migrations. Use this instead:

```toml
app = 'vesper'
primary_region = 'iad'

[build]

[deploy]
  # Applies pending drizzle migrations before the new version goes live.
  # `-w` pins it to the WORKSPACE ROOT script, never an app-local one.
  release_command = "pnpm -w run db:migrate"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false      # MUST stay up — in-process job worker
  auto_start_machines = true
  min_machines_running = 1         # never scale to zero
  processes = ['app']

[[mounts]]
  source = "vesper_data"          # persistent image storage (DATA_ROOT)
  destination = "/app/data"

[[vm]]
  memory = '2gb'                  # 1gb is the floor; 256mb OOMs immediately
  cpu_kind = 'shared'
  cpus = 1
```

## One-time setup

1. **Postgres with pgvector (Neon).** Vesper uses `vector(1536)` columns + HNSW
   indexes. Create a Neon project (pgvector ships with Neon), then point the Fly
   app at it by hand:
   ```
   # In the Neon console: create a project, copy its connection string, then:
   fly secrets set DATABASE_URL="postgresql://…neon.tech/…?sslmode=require" -a vesper
   ```
   There is no Fly Postgres app — the DB lives entirely on Neon. pgvector is
   enabled by the baseline migration (`CREATE EXTENSION IF NOT EXISTS vector`),
   which `pnpm db:migrate` runs automatically on deploy.
2. **Volume for images:**
   ```
   fly volumes create vesper_data --region iad --size 3 -a vesper
   ```
3. **Secrets** (runtime-only — the Docker build never sees them):
   ```
   fly secrets set \
     BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
     BETTER_AUTH_URL="https://vesper.fly.dev" \
     OPENROUTER_API_KEY="..." \
     DATA_ROOT="/app/data" \
     DEV_PASSWORD="..." \
     -a vesper
   ```
   `REPLICATE_API_TOKEN` is **required for image generation** and set separately —
   every image render routes through Replicate
   ([images/providers/README.md](images/providers/README.md)), and without it every render
   outside demo mode fails the image row:
   ```
   fly secrets set REPLICATE_API_TOKEN="..." -a vesper
   ```
   `FEATHERLESS_API_TOKEN` is **optional** and narrator-only. It is needed on the
   deployment only to run the narrator rows served by Featherless
   ([getting-started.md](getting-started.md) §Environment); without it those rows
   fall back to the lane's default narrator and everything else is unaffected:
   ```
   fly secrets set FEATHERLESS_API_TOKEN="..." -a vesper
   ```
4. **Seed the dev/admin credential** once Postgres is migrated:
   ```
   fly ssh console -a vesper -C "pnpm db:seed"
   ```

## Deploy

Deploys are **manual** — pushing to GitHub does **not** auto-deploy (there is no
Fly↔GitHub integration firing; every release so far has been a hand-run
`fly deploy`). So a `git push` ships nothing on its own — run the deploy after.

- **First, verify `main` — with the full CI dispatch.** Run
  **`gh workflow run CI --ref main`** and wait for green (`gh run watch`). A
  dispatch runs every gate unconditionally ([testing.md](testing.md) §The
  verification gate). That matters because PR CI runs the production build only
  when the build surface itself moves — the dispatch is what guarantees the
  release candidate compiles before Fly does, so a build that would exhaust the
  Fly builder fails in CI first (see Troubleshooting).
- **Deploy the same tree CI validated.** `fly deploy` ships your working tree,
  not a git ref — deploy from a clean `main` checkout at the commit the
  dispatch ran against.
- **From the CLI:** `fly deploy -a vesper` — Fly builds the Dockerfile on its
  remote builder, runs the `release_command` (`pnpm -w run db:migrate`) against Neon,
  then cuts the Machine over to the new version. Verify with `fly status -a vesper`.
- **If the remote builder returns `unauthorized`:** build locally and push —
  `fly deploy --local-only` (needs local Docker). Re-auth with `fly auth login`
  and confirm the app is in your legacy org (`fly orgs list`, `fly apps list`).

Migrations run automatically via `release_command` on every deploy. Author them
locally (`pnpm db:generate`, review SQL — see [database/README.md](database/README.md)), commit
the `drizzle/` files, and push; the server only ever runs the non-interactive
`pnpm db:migrate`.

## Branch model & promotion (dev → prod)

Two long-lived branches on the **same** `origin` remote (`ceponatia/vesper`) —
there is no second remote:

| Branch | Role              | How it updates                                                                                                                                             |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main` | **dev** (default) | Your normal workflow. Push here as always; deploying dev is a separate **manual** `fly deploy` after testing — pushing to GitHub does **not** auto-deploy. |
| `prod` | **production**    | **Protected.** No direct pushes — code arrives only via a pull request from `main`, gated on the required green `verify` status check.                     |

Day-to-day is unchanged: keep committing to and pushing `main`. `prod` only ever
moves through a **promotion PR**.

**To promote dev → prod:**

1. **Open the promotion PR.** Either Actions tab → **"Promote dev → prod"** →
   *Run workflow* (opens a `main → prod` PR for you), or locally:
   `gh pr create --base prod --head main`.
2. **Require the promotion PR's full CI run to pass.** A PR whose base is `prod`
   forces every CodeBuild gate, engine integration and production build included,
   regardless of changed paths. The required aggregate `verify` check is the
   release-candidate gate for the promotion itself.
3. **Merge** the PR. That's the only way commits reach `prod`.

If the promoted commit will also be deployed to Fly, still run the deliberate
`gh workflow run CI --ref main` pre-deploy dispatch described above and deploy the
same clean tree it validated. Promotion-PR CI and pre-deploy CI serve different
checkpoints; neither is a local wrapper.

**Protection on `prod`** (set via `gh api .../branches/prod/protection`):

- Pull request required before merging (0 required approvals — solo repo; GitHub
  won't let you approve your own PR, so requiring one would lock you out).
- **Required status check: `verify`** — the aggregate result of the
  CodeBuild-runner CI workflow. A promotion PR (base `prod`) always runs the
  full suite, engine and build included, so the check is meaningful on exactly
  the PR it guards. `main` requires the same check, without admin enforcement,
  so direct documentation pushes still work.
- Force-pushes and branch deletion blocked.
- **Enforced for admins too** — even the owner merges via a PR. For a
  genuine emergency, toggle protection off in the GitHub UI
  (Settings → Branches), merge, and turn it back on; it's a deliberate act, not
  an accident.

**`prod` is a code branch, not an environment.** Merging to `prod` moves code and
nothing else: no workflow deploys from it, and there is no separate prod Fly app
or prod database. Deploying is the manual `fly deploy -a vesper` above, run from
a checkout of the branch being shipped, and `vesper` is the one app it targets.

## Security

The app is on the **public internet** at `https://vesper.fly.dev`, so access
control rests entirely on **Better Auth** ([auth/README.md](auth/README.md)) plus the `admin`
role and private entity `visibility`. For a dev build, **gate or disable open
email sign-up** so only accounts you approve can get in. (This is the tradeoff
versus the dropped Tailscale plan, where the app wasn't publicly reachable at
all. If you later want that posture back, Fly supports private networking /
a Tailscale sidecar.) Set strong, unique `BETTER_AUTH_SECRET` and `DEV_PASSWORD`.

## Troubleshooting

- **`archive/tar: unknown file mode ?rwxr-xr-x` while transferring build
  context** — a Windows junction reached the tar. `.dockerignore` patterns are
  anchored at the context root unless they start with `**/`, so a bare
  `node_modules/` excluded only the top-level install and left every
  `packages/*/node_modules` — which pnpm fills with junctions — in the context.
  The patterns are `**/`-prefixed for that reason; a new ignore entry for
  anything that can exist per-package needs the same prefix.
- **`unauthorized` before the build starts** — auth, not the Dockerfile:
  `fly auth login`; confirm org/app ownership; or `fly deploy --local-only`.
- **Build-time `[Better Auth] Base URL is not set` / `default secret`** — benign
  warnings during static generation; they disappear once the secrets above are
  set (runtime).
- **Turbopack NFT "Encountered unexpected file" warnings** (`next.config.ts` →
  `assets.ts`) — benign; from `DATA_ROOT` filesystem access being traced.
- **App OOMs / restarts** — bump `[[vm]] memory`; 256 MB is far too small.
- **Build fails with `Next.js build worker exited ... SIGABRT` and a
  `FatalProcessOutOfMemory` V8 stack** — the BUILDER ran out of JS heap, which is
  a different failure from the app OOMing. Read the exit signal: V8's own
  `OOMErrorHandler`/`FatalProcessOutOfMemory` + SIGABRT means the process hit
  Node's `--max-old-space-size` ceiling, whereas the kernel's OOM killer exits
  137 with no V8 stack. The Dockerfile raises the ceiling to 4096 MB on the build
  step; if it recurs the app simply grew again, so raise that number (and only if
  exit 137 appears instead, give the builder more RAM rather than more heap).
- **Images vanish after restart** — the `[[mounts]]` volume is missing or
  `DATA_ROOT` doesn't point at it.
- **React error #418 (hydration mismatch) in the console on loads right after a
  deploy** — deploy skew, not an app bug: a browser with cached assets from the
  previous build straddles the Machine cutover, React logs #418, discards the
  server HTML, and client-renders — the page still works. It self-heals and has
  never reproduced outside the few minutes around a cutover — warm-cache,
  hard-reload, and CDP cache-disabled loads across several pages on a settled
  build were all clean. Don't chase it unless it appears on a settled build.
