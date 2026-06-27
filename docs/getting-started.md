# Getting started

## Prerequisites

- Node ≥ 22 (developed on 24), pnpm 10
- Vesper's local Postgres container: `docker compose up -d postgres` from this folder (pgvector/pg17 on port 5435)

## Setup

```bash
cd vesper
pnpm install
cp .env.example .env        # add OPENROUTER_API_KEY (and VENICE_API_KEY for image editing)
docker compose up -d postgres
pnpm db:create              # verifies vesper_dev + pgvector extension
pnpm db:migrate
pnpm db:seed                # demo user, starter world ("Harbor House"), sample cast
pnpm dev                    # http://localhost:3200
```

No API keys? Everything still runs in **demo mode** (deterministic narrative, placeholder images) — see [resilience.md](resilience.md) §6.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://vesper:vesper_dev_password@localhost:5435/vesper_dev` | App database |
| `OPENROUTER_API_KEY` | — | All text models + embeddings + text-to-image |
| `VENICE_API_KEY` | — | Reference image editing |
| `NARRATIVE_MODEL` | `aion-labs/aion-2.0` | Default narrator for new worlds (per-world override at creation) |
| `AGENT_MODEL` | `deepseek/deepseek-v4-flash` | In-session agents (intake + post-turn); per-world override from the World tab |
| `STATE_MODEL` | `google/gemini-2.5-flash` | Default for all `generateChecked` calls — the forge/authoring agents (in-session agents use `AGENT_MODEL`) |
| `TOOL_MODEL` | `google/gemini-2.5-flash` | Scene composer (image pipeline) |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | 1536-dim embeddings |
| `VENICE_IMAGE_MODEL` | `qwen-image-2` | Venice uncensored text-to-image (avatars, entity images, scene t2i fallback) |
| `VENICE_IMAGE_EDIT_MODEL` | `qwen-image-2-edit` | Single-reference editing (portrait variants + scene images) |
| `VENICE_MULTI_EDIT_MODEL` | `qwen-edit-uncensored` | Multi-reference editing (`/image/multi-edit`, ≤3 refs) |
| `VENICE_SAFE_MODE` | `false` | Venice content filter toggle |
| `BETTER_AUTH_SECRET` | — | **Required.** Signs sessions/cookies ([auth.md](auth.md)); `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `http://localhost:3200` | App origin (OAuth callbacks + CSRF origin check) |
| `GOOGLE_/GITHUB_/DISCORD_CLIENT_ID`+`_SECRET` | — | OAuth providers — a provider is enabled only when **both** are set; absent ⇒ off |
| `DEV_PASSWORD` | `vesper-dev-password` | Dev/QA: password the seed sets on the Player + uxtest admin for `POST /api/dev/impersonate` |
| `LOG_LEVEL` | `info` | Logger |

> Magic-link sign-in has no email transport in v1 — the dev fallback **logs the link** to the server console (grep `auth.magic_link`).

## Day-to-day

```bash
pnpm dev / build / start
pnpm test / test:watch / test:int / typecheck / lint     # see testing.md
pnpm db:generate                            # after editing src/server/db/schema.ts → review drizzle/ SQL
pnpm db:migrate
pnpm db:studio                              # drizzle studio
```

Vesper owns its local `vesper-postgres` container and `vesper_dev` database.
