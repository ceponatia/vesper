# Vesper

LLM-powered roleplaying engine: forge worlds and characters (AI-drafted, human-owned), then play turn-based sessions where a narrative model writes the story while four parallel state agents — simulant, archivist, continuity, director — keep a persistent world model in sync: locations, wardrobe, meters, conditions, semantic facts, story threads, and generated imagery.

Ground-up rewrite of the original companion-app.

**Start here: [docs/getting-started.md](docs/getting-started.md). Architecture: [docs/README.md](docs/README.md).**

```bash
docker compose up -d postgres
pnpm install
cp .env.example .env     # add OPENROUTER_API_KEY (optional — demo mode works without)
pnpm db:create && pnpm db:migrate && pnpm db:seed
pnpm dev                 # http://localhost:3200
```
