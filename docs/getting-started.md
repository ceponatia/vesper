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
| `STATE_MODEL` | `deepseek/deepseek-v4-flash` | Default for all `generateChecked` calls — the forge/authoring agents (in-session agents use `AGENT_MODEL`) |
| `TOOL_MODEL` | `deepseek/deepseek-v4-flash` | Scene composer (image pipeline) |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | 1536-dim embeddings |
| `IMAGE_MODEL` / `IMAGE_MODEL_FAST` | `black-forest-labs/flux.2-pro` / `…flux.2-flex` | Text-to-image |
| `VENICE_IMAGE_MODEL` | `qwen-image-2` | Venice uncensored text-to-image (portrait regenerate) |
| `VENICE_IMAGE_EDIT_MODEL` | `qwen-image-2-edit` | Reference editing (portrait variants + scene images) |
| `VENICE_SAFE_MODE` | `false` | Venice content filter toggle |
| `LOG_LEVEL` | `info` | Logger |

## Day-to-day

```bash
pnpm dev / build / start
pnpm test / test:watch / test:int / typecheck / lint     # see testing.md
pnpm db:generate                            # after editing src/server/db/schema.ts → review drizzle/ SQL
pnpm db:migrate
pnpm db:studio                              # drizzle studio
```

Vesper owns its local `vesper-postgres` container and `vesper_dev` database.
