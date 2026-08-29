# Vesper

LLM-powered romance roleplaying game: forge characters (AI-drafted, human-owned), then talk to them in **character chat**, where a narrative model plays the character and narrates the scene while a fan-out of parallel state agents keeps per-character state in sync: wardrobe, meters, conditions, semantic facts, relationship arc, and generated imagery. Alongside it runs the **successor simulation engine**, an event-sourced world model whose chats are created through the `/worlds` front door.

A fork of reverie, same core engine. Reverie is a broadly-scoped roleplaying engine that *can* host romantic and adult play among many modes; Vesper narrows the aim to intimate, character-driven romance and exists for focused development on mature, adult scenarios. (Reverie is itself a ground-up rewrite of the original companion-app.)

> **Maturity:** Vesper is built to generate explicit, adult content and is intended for adults only.

**Start here: [docs/getting-started.md](docs/getting-started.md). Architecture: [docs/README.md](docs/README.md).**

```bash
docker compose up -d postgres
pnpm install
cp .env.example .env     # add OPENROUTER_API_KEY (optional — demo mode works without)
pnpm db:create && pnpm db:migrate && pnpm db:seed
pnpm dev                 # http://localhost:3200
```
