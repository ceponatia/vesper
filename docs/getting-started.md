# Getting started

## Prerequisites

- Node ≥ 22 (developed on 24), pnpm 10
- Vesper's local Postgres container: `docker compose up -d postgres` from this folder (pgvector/pg17 on port 5435)

## Setup

```bash
cd vesper
pnpm install
cp .env.example .env        # add OPENROUTER_API_KEY and REPLICATE_API_TOKEN
                            #   (both required for a non-demo install — see Environment)
docker compose up -d postgres
pnpm db:create              # verifies vesper_dev + pgvector extension
pnpm db:migrate
pnpm db:seed                # demo user + demo characters (and their credential)
pnpm dev                    # http://localhost:3200
```

No API keys? Everything still runs in **demo mode** (deterministic narrative, placeholder images) — see [resilience.md](resilience.md) §6.

> **UI testing runs against the Fly deploy, not this local server.** To verify a UI
> change, deploy it (`fly deploy -a vesper`) and drive `https://vesper.fly.dev` — see
> [deployment.md](deployment.md) and [CLAUDE.md](../CLAUDE.md). The local `pnpm dev` +
> Postgres above remain for code/test iteration. (On the Fly production build the
> `/api/dev/*` routes 404, so sign in at `/sign-in` rather than using `impersonate`.)

## Environment

> **`.env` lives at the repository root, and every command reads it from there.**
> The Next app is a workspace under `apps/web`, so Next would otherwise look for
> `.env` in its own project folder and find nothing. There is exactly one loader:
> the root launcher `scripts/web.mjs`, which `pnpm dev` / `build` / `start` all go
> through. It reads the root `.env` (existing environment variables always win)
> and then starts Next with `apps/web` as the project directory. Root scripts
> (`db:*`, `sim:*`, `eval:*`) read the same file through `dotenv` directly. Do not
> add a second `.env` under `apps/web`.

> **Models are not env-configurable.** The chat narrator model is chosen in
> code (`lib/narrative-models.ts`) or per-character in the UI; the post-turn agent
> models (`lib/agent-models.ts`), the scene-composer/tool model, and the embedding
> model default purely in code (`server/ai/provider.ts` `MODEL_DEFAULTS`). Image
> models are rows in the `image_models` registry, managed from the admin-only
> `/settings/image-models` page ([images/providers.md](images/providers/README.md)) — the
> `REPLICATE_*` variables below configure the one image backend, never model choice.

> **Tool-model candidate — `aion-labs/aion-3.0`.** Added to the narrator list
> (`lib/narrative-models.ts`) as **Aion 3.0**, it is notable beyond its narrator
> role: per OpenRouter's `supported_parameters` it advertises `tools` +
> `tool_choice` (function/tool calling) and `response_format` (structured JSON) —
> unlike most narrator picks. That makes it a candidate for the **tool model**
> (`MODEL_DEFAULTS.tool` — the leg that needs reliable structured calls) and for
> the post-turn agent list (`lib/agent-models.ts`). The scene composer is no
> longer downstream of either: it has its own seam and its own curated list
> (`lib/composer-models.ts`), settled by an A/B run. Tool-calling **reliability in our pipeline is unverified**
> (Aion is a multi-model roleplay/storytelling system on the GLM family, and
> OpenRouter's advertised params don't guarantee behavior) — **test with it before
> promoting it to a tool/agent role.** Context 131K, $3/$6 per 1M in/out.

- **`DATABASE_URL`** — app database. Default
  `postgresql://vesper:vesper_dev_password@localhost:5435/vesper_dev`.
- **`OPENROUTER_API_KEY`** — text models + embeddings; no default. Leave it unset to
  run in demo mode (deterministic narrative, placeholder images). It serves every text
  leg except the handful of narrator rows below that name a different provider.
- **`FEATHERLESS_API_TOKEN`** — the **narrator-only** second text provider; no default.
  Featherless serves community Hugging Face merges that no OpenRouter vendor hosts, and
  only rows in the narrator list may name it (`lib/narrative-models.ts`) — agents, the
  scene composer, embeddings and vision stay OpenRouter-only. Absent ⇒ a Featherless
  narrator pick falls back to the lane default and logs `ai.chat_narrative_model`; the
  stored pick survives, so setting the token later restores it with no re-choosing.
- **`REPLICATE_API_TOKEN`** — **the image backend**; no default. Every image (avatars,
  portrait variants, chat scenes, item/location shots) renders through Replicate
  ([images/providers.md](images/providers/README.md)). Absent outside demo mode ⇒ every render fails the
  row with `REPLICATE_API_TOKEN not configured`.
- **`REPLICATE_PREDICTION_TIMEOUT_MS`** — prediction deadline; default `300000` (5m),
  clamped to 30s–30m. Sent as Replicate's `Cancel-After` **and** used as this client's poll
  cutoff, so both expire together.
- **`REPLICATE_SAFE_MODE`** — Replicate safety-checker toggle; default `false`. Only sent to
  models whose schema declares the input.
- **`BETTER_AUTH_SECRET`** — **required**, no default. Signs sessions/cookies
  ([auth/README.md](auth/README.md)); generate with `openssl rand -base64 32`.
- **`BETTER_AUTH_URL`** — app origin (OAuth callbacks + CSRF origin check). Default
  `http://localhost:3200`.
- **`GOOGLE_/GITHUB_/DISCORD_CLIENT_ID`** + **`_SECRET`** — OAuth providers; no default. A
  provider is enabled only when **both** are set; absent ⇒ off.
- **`ALLOW_SIGNUP`** — sign-up gate; default `false` (off). Email/OAuth/magic-link
  registration is disabled unless `true` ([auth/sign-in.md](auth/sign-in.md)).
- **`BETTER_AUTH_TRUSTED_ORIGINS`** — comma-separated extra allowed origins (CSRF); no
  default. Needed for LAN dev, e.g. `http://<lan-ip>:3200`.
- **`RESEND_API_KEY`** / **`SMTP_URL`** — names **reserved** for a future magic-link email
  sender; no default. **Inert in v1** — no code reads them and setting one enables nothing
  ([auth/sign-in.md](auth/sign-in.md)).
- **`DEV_PASSWORD`** — dev/QA password the seed sets on the Player + uxtest admin for
  `POST /api/dev/impersonate`; default `vesper-dev-password`. Local dev only — the endpoint
  404s on the production Fly build.
- **`LOG_LEVEL`** — logger level; default `info`.

> Magic-link sign-in has no implemented email transport in v1, so it is
> **dev-only**: locally the link is written to the server console (grep
> `auth.magic_link`) and that is how you complete the sign-in, while a production
> build drops the plugin entirely rather than log a live sign-in URL. Production
> turns on only when a real sender is registered in `apps/web/src/server/auth/magic-link.ts`
> — never by setting an env var ([auth/sign-in.md](auth/sign-in.md)).

## Day-to-day

```bash
pnpm dev / build / start
pnpm test / test:watch / test:int / typecheck / lint     # individual runs — see testing.md
pnpm test:int:strict                        # strict form of test:int — an unreachable DB fails
                                            #   instead of skipping (testing.md §Strict integration mode)
pnpm db:generate                            # after editing apps/web/src/server/db/schema.ts → review drizzle/ SQL
pnpm db:migrate
pnpm db:studio                              # drizzle studio
```

> **CI is the verification gate.** GitHub Actions runs on AWS CodeBuild managed
> runners (`.github/workflows/ci.yml`); the aggregate `verify` status check is
> required on `main` and `prod`, so a PR merges only when it is green. There are
> no local git hooks — commits and pushes run nothing — and no local gate:
> push the branch and let CI validate. Before a deploy, run the full CI
> dispatch: `gh workflow run CI --ref main`.
> See [testing.md](testing.md) and [deployment.md](deployment.md).

Vesper owns its local `vesper-postgres` container and `vesper_dev` database.
