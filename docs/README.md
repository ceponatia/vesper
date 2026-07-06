# Vesper documentation

Vesper is an LLM-powered romance roleplaying game: a web app where you forge worlds and characters (AI-drafted, human-edited), then play turn-based sessions with an AI companion in which a narrative model writes the story while a fan-out of parallel state agents keeps a persistent, queryable world model in sync — locations, wardrobe, meters, conditions, facts, story threads, and generated imagery.

It is a fork of reverie — itself a ground-up rewrite of the original companion-app — and shares reverie's full engine: dynamic state management, RAG memory, and multi-agent parallel orchestration feeding facts to the narrative model. The difference is focus. Reverie is a broadly-scoped roleplaying engine — it *can* host romantic and adult play, but as one mode among many. Vesper forks that engine to develop in a single direction: intimate, character-driven romance, optimized for mature, adult scenarios. Freed from staying general-purpose, the systems behind those scenarios — relationship and affinity progression, per-sense exposure gating, intimacy staging, and uncensored imagery — are first-class here and free to evolve as the product's core rather than incidental features.

## Reading order

| Doc | What it covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Setup, env vars, database, running dev/tests |
| [architecture.md](architecture.md) | Stack, directory layout, module boundaries, data flow |
| [resilience.md](resilience.md) | The error-handling philosophy every module must follow |
| [contracts/](contracts/README.md) | Attribute registry, body model, meters, conditions — and how to extend them |
| [database.md](database.md) | Drizzle schema, pgvector, migration workflow |
| [turn-engine.md](turn-engine.md) | The turn lifecycle: pre-turn assembly, narrative streaming, post-turn agent fan-out |
| [character-chat.md](character-chat.md) | The sessionless chat lane: exchange pipeline, tracked state, relationship & in-game time, chat memory, jobs, API |
| [prompts.md](prompts.md) | Prompt architecture: static rulebook, turn context, caching, speaker tags |
| [memory.md](memory.md) | Episodes, semantic facts + supersedence, lore tiers, retrieval |
| [story-threads.md](story-threads.md) | Thread kinds, lifecycle, semantic dedup, accumulated developments, the detail modal |
| [perception.md](perception.md) | Presence channels, the attention × salience witness matrix, awareness blocks, darkness, comms |
| [streaming-api.md](streaming-api.md) | HTTP API surface and the SSE turn-streaming protocol |
| [auth.md](auth.md) | Accounts (Better Auth), session resolution, and the entity-visibility / copy-on-use authorization seam |
| [images.md](images.md) | Avatar generation, Venice reference editing, scene images, asset storage |
| [authoring.md](authoring.md) | AI-first world/character forges and manual-override editors |
| [ui.md](ui.md) | Pages, components, styling conventions |
| [testing.md](testing.md) | Test strategy and conventions |
| [deployment.md](deployment.md) | Hosting the dev build online: Fly.io (Dockerfile, fly.toml, pgvector, volume, push-to-deploy, migrations) |
| [guide/](guide/README.md) | Task-oriented manual pages (creating characters, items, worlds; running sessions) |

## Documentation rules

- One focused document per system. When a system changes, update its doc in the same change.
- Documents describe **patterns and invariants** ("how to add an attribute group", "what a post-turn agent may not do"), not line-by-line code walkthroughs.
- **Promote a doc to a folder when it outgrows one file.** A system doc starts as `docs/<system>.md`. When it would exceed ~400 lines, promote it to `docs/<system>/`: a `README.md` index (one-paragraph intro + a reading-order table linking the parts + any whole-system checklist) plus one file per sub-topic, named after the sub-topic — or, where the doc mirrors a code tree, after the code subfolder it covers (see `contracts/`, which mirrors `src/contracts/`). Keep each part well under ~400 lines; if a part outgrows that, it is itself a candidate for promotion. The folder's row in this table points at `docs/<system>/README.md`. On promotion, repoint active inbound links to the new part files; leave historical `finished/`/`phase-N` docs as-is.
