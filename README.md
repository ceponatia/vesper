# Vesper

Vesper is an LLM-powered, romance-first character roleplay app. You forge characters (AI-drafted, human-owned) and talk to them in character chat, where a narrative model plays the character and narrates the scene while a fan-out of parallel state agents keeps per-character state in sync: wardrobe, meters, conditions, semantic facts, relationship arc, and generated imagery.

> **Maturity:** Vesper is built to generate explicit, adult content and is intended for adults only.

## Features and surfaces

- **Character chat**, the core loop: talk to an AI character while background agents track its state and drive scene imagery.
- **Characters, personas, items, locations**: the entities a chat draws on, each with its own library and editor.
- **Gallery**: generated images across your characters and chats.
- **Social cards**: shareable character summary cards.
- **Worlds** (`/worlds`): the successor simulation engine, an event-sourced world model that provisions a fresh isolated world for each chat it creates.
- **Settings**: account settings plus admin-only benches for image models, the image lab, identity trials, the image generator, and narrator prompts.
- **Demo mode**: the app runs with no API keys configured, so narration is deterministic and images are placeholders until you add provider credentials.

## Tech stack

- **Framework:** Next.js 16 (App Router) + React 19, TypeScript
- **Package management:** pnpm workspace (`pnpm@10.12.1`, Node >= 22)
- **Database:** Postgres 17 + pgvector, via Drizzle ORM (SQL migrations, no `drizzle-kit push`)
- **Auth:** Better Auth (self-service sign-up is off by default)
- **Text models:** OpenRouter, plus Featherless for a narrator-only model lane
- **Image models:** Replicate, plus fal.ai (Qwen Image 3); models are registry rows managed from an admin page, not environment variables
- **Testing:** Vitest 4
- **CI/CD:** GitHub Actions on GitHub-hosted runners; production deploys to Fly, with Neon hosting the production database

## Quickstart

```bash
git clone https://github.com/ceponatia/vesper.git
cd vesper
pnpm install
cp .env.example .env        # add OPENROUTER_API_KEY and REPLICATE_API_TOKEN
                            #   (both required for a non-demo install; see Environment
                            #    in docs/getting-started.md)
docker compose up -d postgres
pnpm db:create              # verifies vesper_dev + pgvector extension
pnpm db:migrate
pnpm db:seed                # demo user + demo characters (and their credential)
pnpm dev                    # http://localhost:3200
```

No API keys? Everything still runs in **demo mode** (deterministic narrative, placeholder images).

See [docs/getting-started.md](docs/getting-started.md) for the full prerequisite list, every environment variable, and day-to-day commands.

## Repository layout

- `apps/web`: the Next.js application: routes, UI, database, engine, and the Vesper-specific image layer.
- `packages/contracts`: shared foundation, the diagnostic contract every workspace reports through, and the defensive parser trust boundaries read with.
- `packages/image-core`: provider-neutral image engine: model capabilities, profiles, render intent, references, identity packs, lab recipes, failure classification.
- `packages/image-models`: model-family adapters: the semantic feature vocabulary, the adapter composer, per-family prompt dialects and execution hints, and the adapter registry.
- `packages/image-replicate`: server-only Replicate transport: predictions, file uploads, output download, schema probing.
- `packages/image-sd`: Stable Diffusion implementation layer: versioned SD recipes, the Vesper-owned renderer input contract, training manifests, and evaluation fixtures.
- `packages/simulation-core`: the simulation domain: event/command contracts, identity derivation, the deterministic scheduler, and the pure kernels every projector and store replays through.
- `packages/text-models`: text-model adapters: the semantic sampling vocabulary, per-host wire dialects, the adapter composer, execution hints, and the adapter registry.
- `scripts/`: database, migration, and seed scripts; evals; simulation errands; maintenance helpers.
- `drizzle/`: generated SQL migrations (committed).
- `docs/`: architecture, setup, and system reference documentation.
- `docker/`: the local Postgres/pgvector image used by `docker compose up -d postgres`.
- `tools/`: standalone development tools (e.g. the image lab).
- `.agents/skills/` and `.claude/`: agent skills and roles used to develop Vesper (see Contributing).

## Development notes

- Run `pnpm` only from the repository root; `apps/web` has no `dev`, `build`, or `test` scripts of its own.
- `.env` lives at the repository root and is loaded by the root launcher `scripts/web.mjs`, which `pnpm dev` / `build` / `start` all go through. Do not add a second `.env` under `apps/web`.
- Common scripts: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:int`, `pnpm db:create`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:studio`.
- CI is the verification gate; there is no local pre-push gate. GitHub Actions runs lint, static checks, unit tests, engine integration, and a production build as applicable, and the aggregate `verify` check is required on `main` and `prod`.

## Contributing

Vesper is developed largely through AI coding agents following [AGENTS.md](AGENTS.md), which owns repository conventions, layer rules, and the git/delivery workflow. Read it and [docs/README.md](docs/README.md) before making changes.

Changes reach `main` through a branch and pull request (documentation-only changes may go directly to `main`), using conventional commits. GitHub Actions CI is the gate for every pull request.

## Documentation

- [docs/README.md](docs/README.md): documentation map and product framing
- [docs/getting-started.md](docs/getting-started.md): prerequisites, setup, environment variables
- [docs/architecture.md](docs/architecture.md): stack, directory layout, module boundaries, data flow
- [docs/deployment.md](docs/deployment.md): hosting on Fly.io, Neon, migrations, branch promotion
- [docs/testing.md](docs/testing.md): test strategy, layers, and the CI verification gate
- [docs/resilience.md](docs/resilience.md): the error-handling philosophy every module follows

## License

This project has not yet chosen a license.
