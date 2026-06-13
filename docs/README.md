# Vesper documentation

Vesper is an LLM-powered roleplaying engine: a web app where you forge worlds and characters (AI-drafted, human-edited), then play turn-based sessions in which a narrative model writes the story while a fan-out of parallel state agents keeps a persistent, queryable world model in sync — locations, wardrobe, meters, conditions, facts, story threads, and generated imagery.

It is a ground-up rewrite of the original companion-app. The premise is unchanged — dynamic state management, RAG memory, multi-agent parallel orchestration feeding facts to the narrative model — but every system is redesigned.

## Reading order

| Doc | What it covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Setup, env vars, database, running dev/tests |
| [architecture.md](architecture.md) | Stack, directory layout, module boundaries, data flow |
| [resilience.md](resilience.md) | The error-handling philosophy every module must follow |
| [contracts.md](contracts.md) | Attribute registry, body model, meters, conditions — and how to extend them |
| [database.md](database.md) | Drizzle schema, pgvector, migration workflow |
| [turn-engine.md](turn-engine.md) | The turn lifecycle: pre-turn assembly, narrative streaming, post-turn agent fan-out |
| [prompts.md](prompts.md) | Prompt architecture: static rulebook, turn context, caching, speaker tags |
| [memory.md](memory.md) | Episodes, semantic facts + supersedence, lore tiers, retrieval |
| [streaming-api.md](streaming-api.md) | HTTP API surface and the SSE turn-streaming protocol |
| [images.md](images.md) | Avatar generation, Venice reference editing, scene images, asset storage |
| [authoring.md](authoring.md) | AI-first world/character forges and manual-override editors |
| [ui.md](ui.md) | Pages, components, styling conventions |
| [testing.md](testing.md) | Test strategy and conventions |
| [guide/](guide/README.md) | Task-oriented manual pages (creating characters, items, worlds; running sessions) |

## Documentation rules

- One focused document per system. When a system changes, update its doc in the same change.
- Documents describe **patterns and invariants** ("how to add an attribute group", "what a post-turn agent may not do"), not line-by-line code walkthroughs.
- If a doc would exceed ~400 lines, split it.
