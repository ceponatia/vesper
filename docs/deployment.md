# Deployment (Fly.io)

The dev build runs on **Fly.io** — a single always-on Machine running the Next.js
app, a **Fly Postgres** with **pgvector**, and a **Fly Volume** for image storage.
Chosen because this account has a **legacy Fly org** that predates the
"no free allowance for new orgs" change. (The earlier Hetzner + Tailscale plan is
superseded; Fly trades the Tailscale "private by default" posture for a public
`*.fly.dev` URL gated by Better Auth — see Security below.)

This is deliberately **not** serverless: the turn engine runs an in-process job
worker loop (`src/server/engine/jobs.ts`) and images are written to a local
filesystem (`DATA_ROOT`, `src/server/images/assets.ts`). Both need an always-on
Machine with a persistent volume — so `auto_stop_machines` must be **off**.

## Files

| File | Role |
| --- | --- |
| `Dockerfile` | App image (build + runtime). Keeps full deps so `pnpm db:migrate` works; no `pnpm prune`. |
| `.dockerignore` | Keeps `node_modules`/`.next`/`.env`/`data` out of the build context. |
| `fly.toml` | Machine + service config (managed in the Fly UI / repo — see recommended version below). |

## The Dockerfile (key choices)

- **No `pnpm prune --prod`.** Pruning re-runs the husky `prepare` hook *after*
  husky is removed (`husky: not found` → build fails) and also deletes `tsx`,
  which migrations need. `HUSKY=0` is set so the hook is a no-op regardless.
- **Full dependency tree at runtime** so `pnpm db:migrate` (runs via `tsx`) works
  from the release command.
- **Binds to `$PORT` (8080)** by calling `next` directly — the package.json
  `start` script hardcodes `-p 3200`, which would mismatch Fly's `internal_port`.
- `sharp` works from its prebuilt `@img/sharp-*` binary; the "Ignored build
  scripts: sharp" pnpm warning is benign.

## Recommended `fly.toml`

The generated file has three problems: it scales to zero (kills the worker), sets
256 MB RAM (can't boot Next), and runs no migrations. Use this instead:

```toml
app = 'vesper'
primary_region = 'iad'

[build]

[deploy]
  # Applies pending drizzle migrations before the new version goes live.
  release_command = "pnpm db:migrate"

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

1. **Postgres with pgvector.** Vesper uses `vector(1536)` columns + HNSW indexes.
   Create a Fly Postgres and ensure pgvector is available:
   ```
   fly postgres create --name vesper-db --region iad
   fly postgres connect -a vesper-db -c "CREATE EXTENSION IF NOT EXISTS vector;"
   fly postgres attach vesper-db -a vesper   # sets DATABASE_URL secret
   ```
   If the Fly Postgres image lacks pgvector, run a pgvector image instead
   (e.g. `pgvector/pgvector:pg17`) as a separate Fly app and set `DATABASE_URL`
   by hand. (The baseline migration `CREATE EXTENSION IF NOT EXISTS vector` also
   self-enables it when the role has permission.)
2. **Volume for images:**
   ```
   fly volumes create vesper_data --region iad --size 3 -a vesper
   ```
3. **Secrets** (these also silence the Better Auth build-time warnings):
   ```
   fly secrets set \
     BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
     BETTER_AUTH_URL="https://vesper.fly.dev" \
     OPENROUTER_API_KEY="..." \
     VENICE_API_KEY="..." \
     DATA_ROOT="/app/data" \
     DEV_PASSWORD="..." \
     -a vesper
   ```
4. **Seed the dev/admin credential** once Postgres is migrated:
   ```
   fly ssh console -a vesper -C "pnpm db:seed"
   ```

## Deploy

- **From GitHub** (the import you set up): push to `main` → Fly builds the
  Dockerfile on its remote builder and deploys.
- **From the CLI:** `fly deploy`.
- **If the remote builder returns `unauthorized`:** build locally and push —
  `fly deploy --local-only` (needs local Docker). Re-auth with `fly auth login`
  and confirm the app is in your legacy org (`fly orgs list`, `fly apps list`).

Migrations run automatically via `release_command` on every deploy. Author them
locally (`pnpm db:generate`, review SQL — see [database.md](database.md)), commit
the `drizzle/` files, and push; the server only ever runs the non-interactive
`pnpm db:migrate`.

## Security

The app is on the **public internet** at `https://vesper.fly.dev`, so access
control rests entirely on **Better Auth** ([auth.md](auth.md)) plus the `admin`
role and private entity `visibility`. For a dev build, **gate or disable open
email sign-up** so only accounts you approve can get in. (This is the tradeoff
versus the dropped Tailscale plan, where the app wasn't publicly reachable at
all. If you later want that posture back, Fly supports private networking /
a Tailscale sidecar.) Set strong, unique `BETTER_AUTH_SECRET` and `DEV_PASSWORD`.

## Troubleshooting

- **`husky: not found` during `pnpm prune --prod`** — the original build failure;
  fixed by dropping the prune + `HUSKY=0` (see Dockerfile).
- **`unauthorized` before the build starts** — auth, not the Dockerfile:
  `fly auth login`; confirm org/app ownership; or `fly deploy --local-only`.
- **Build-time `[Better Auth] Base URL is not set` / `default secret`** — benign
  warnings during static generation; they disappear once the secrets above are
  set (runtime).
- **Turbopack NFT "Encountered unexpected file" warnings** (`next.config.ts` →
  `assets.ts`) — benign; from `DATA_ROOT` filesystem access being traced.
- **App OOMs / restarts** — bump `[[vm]] memory`; 256 MB is far too small.
- **Images vanish after restart** — the `[[mounts]]` volume is missing or
  `DATA_ROOT` doesn't point at it.
