# Vesper documentation

Vesper is an LLM-powered romance roleplaying game: a web app where you forge characters (AI-drafted, human-edited) and talk to them in **character chat** — a narrative model plays the character and narrates the scene while a fan-out of parallel state agents keeps per-character state in sync (wardrobe, meters, conditions, facts, relationship arc, and generated imagery). Alongside it runs the **successor simulation engine**, an event-sourced world model reached through the `/worlds` front door.

It is a fork of reverie — itself a ground-up rewrite of the original companion-app — and shares reverie's lineage: dynamic state management, RAG memory, and multi-agent parallel orchestration feeding facts to the narrative model. The difference is focus. Reverie is a broadly-scoped roleplaying engine — it *can* host romantic and adult play, but as one mode among many. Vesper forks that engine to develop in a single direction: intimate, character-driven romance, optimized for mature, adult scenarios. Freed from staying general-purpose, the systems behind those scenarios — relationship and affinity progression, per-sense exposure gating, intimacy staging, and uncensored imagery — are first-class here and free to evolve as the product's core rather than incidental features.

**Direction (owner).** Vesper runs **two lanes**. The **character-chat** lane
(`docs/character-chat/`) is the sessionless conversation surface the successor engine grew out of,
and the **successor simulation engine** (`apps/web/src/server/engine/simulation` + the `sim_*`
tables; reference in [engine/](engine/README.md)) is the event-sourced world model whose successor
chats are born via the `/worlds` front door. There is no third lane: new interaction, state and
narration patterns are proven in chat first, and a mechanism the two lanes share has **one**
implementation neither may re-fork.

## Reading order

| Doc                                               | What it covers                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [getting-started.md](getting-started.md)          | Setup, env vars, database, running dev/tests                                                                                                  |
| [architecture.md](architecture.md)                | Stack, directory layout, module boundaries, data flow                                                                                         |
| [resilience.md](resilience.md)                    | The error-handling philosophy every module must follow                                                                                        |
| [contracts/](contracts/README.md)                 | Attribute registry, body model, meters, conditions — and how to extend them                                                                   |
| [database/](database/README.md)                   | Drizzle schema, pgvector, migration workflow, indexes and transactional invariants                                                            |
| [character-chat/](character-chat/README.md)       | The chat lane: exchange pipeline, prompt architecture, tracked state, supporting cast & narrator input, initiative, the ensemble, images, API |
| [engine/](engine/README.md)                       | The successor simulation engine: kernel and events, world, minds, bodies and materials, LOD, boundaries, operations                           |
| [engine-comparison/](engine-comparison/README.md) | The two-lane comparison harness: provisioning, playtesting, and recorded rulings                                                              |
| [memory.md](memory.md)                            | Episodes, semantic facts + supersedence, fused retrieval — chat-scoped                                                                        |
| [streaming-api.md](streaming-api.md)              | HTTP API surface (library, chat, auth, pagination)                                                                                            |
| [auth/](auth/README.md)                           | Accounts (Better Auth), session resolution, and the entity-visibility / copy-on-use authorization seam                                        |
| [images/](images/README.md)                       | Image suite: providers, asset registry, pipelines, identity packs, vision input                                                               |
| [image-models/](image-models/README.md)           | Image-model behavior package: semantic features, Qwen family adapters, composer/registry, plus provider-model reference                       |
| [text-models/](text-models/README.md)             | Text-model behavior package: sampling vocabulary, host dialects, composer/registry, execution hints and quirks                                |
| [image-generator/](image-generator/README.md)     | The Image Generator: admin raw prompt/model bench — one-off runs against any registered model, immutable run records, hidden outputs          |
| [image-lab/](image-lab/README.md)                 | The Advanced Image Lab: evidence-bearing experiment kinds, control fixtures, and lab constraints                                              |
| [authoring/](authoring/README.md)                 | AI-first character forge and manual-override editors                                                                                          |
| [ui/](ui/README.md)                               | Pages, components, styling conventions                                                                                                        |
| [testing.md](testing.md)                          | Test strategy and conventions                                                                                                                 |
| [deployment.md](deployment.md)                    | Hosting the dev build online: Fly.io (Dockerfile, fly.toml, pgvector, volume, push-to-deploy, migrations)                                     |
| [guide/](guide/README.md)                         | Task-oriented manual pages (creating characters, items, locations, social cards)                                                              |
| [decisions/](decisions/README.md)                 | Architecture decision records — the contested calls that would otherwise be re-litigated                                                      |

## Documentation rules

- **Invoke the `vesper-docs` skill before editing anything under `docs/`** (`.claude/skills/vesper-docs/`). It owns the authoring law this page does not: the routing table (issue vs reference page vs ADR), the reference-page shape, the no-dynamic-state rule, the canonical-owner rule, the conversation-residue guardrail, the table formatting rules, a validation checklist, and copyable templates. This page owns the tree — the reading-order table above, one-doc-per-system, and promotion.
- **These docs say what is true now.** Present tense, no rollout plans, no history. Anything phrased "will", "planned", or "once we" is work state and belongs in a GitHub issue on the [Vesper Development board](https://github.com/users/ceponatia/projects/7), not in a document. Dates are dynamic state too, and the skill's no-dynamic-state rule owns both the banned list and the only three kinds of line that may carry one — that list is stated there alone, never re-derived here or on any other page.
- **A reference doc contains the information it needs.** Never defer a page's substance to a document the reader has to go find — state it here.
- **Do not name a retired working document at all** (owner ruling 2026-08-27), as a link or as plain text: the `docs/developer-notes/` tier is deleted, so `` `<feature>.plan.md` `` names nothing a reader can open while still reading as though it were authoritative. If a rule came from one, state the rule. The same goes for a bare `§N` section number, which cited that tier's specs — a `§` survives only where the sentence names a document that still exists, as in a `docs/resilience.md §2` citation. Git history is the archive.
- **Tables are formatted for the raw `.md`, not just the rendered page** — every row one physical line, pipes aligned in the source. Full rules: the skill.
- One focused document per system. When a system changes, update its doc in the same change. A new **top-level** area gets its row in the reading-order table above in that same change; every top-level area under `docs/` appears there, and nothing appears there that is absent from the tree. A page added inside a promoted folder is indexed by that folder's own `README.md`, not here.
- Documents describe **patterns and invariants** ("how to add an attribute group", "what a post-turn agent may not do"), not line-by-line code walkthroughs.
- **Promote a doc to a folder when it outgrows one file.** A system doc starts as `docs/<system>.md`. When it would exceed ~400 lines, promote it to `docs/<system>/`: a `README.md` index (one-paragraph intro + a reading-order table linking the parts + any whole-system checklist) plus one file per sub-topic, named after the sub-topic — or, where the doc mirrors a code tree, after the code subfolder it covers (see `contracts/`, which mirrors `apps/web/src/contracts/`). Keep each part well under ~400 lines; if a part outgrows that, it is itself a candidate for promotion. The folder's row in this table points at `docs/<system>/README.md`. On promotion, repoint every inbound link to the new part files.
