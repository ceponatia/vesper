# Memory & RAG

`apps/web/src/server/memory/` — memory systems share one embedding space (1536-dim, the code-default embedding model in `server/ai/provider.ts` `MODEL_DEFAULTS`, pgvector cosine). Retrieval runs in the chat lane's pre-reply parallel fan-out.

## Memory keying — the chat memory group

`facts` and `episodes` are keyed by a `MemoryScope` (`memory/scope.ts`), never a bare id. It is a **one-armed** discriminated union — `{ kind: "chat", groupId }` — kept a union so a second scope (library/global) is an additive arm, not a signature change:

- **chat** — a chat **memory group**. Rows key on `chat_memory_group_id`. A group is carried by `chat_participants.memory_group_id`: conversations created as "continue our shared history" share the character's existing group (the relationship remembers across conversations), "fresh start / AU" conversations mint their own island — and in a group chat each participant keeps their own group.

Every `addFacts` / `appendEpisode` / `retrieve*` / `recentEpisodes` / `deleteEpisodeForTurn` takes a scope; `memoryScopeWhere(table, scope)` builds the filter and `memoryScopeValues(scope)` the insert columns; use `chatScope(groupId)` at call sites. There is no `turns` table, so `sourceTurnId` stays null — chat provenance is **`source_message_id`** (the assistant reply the memory was extracted from): editing/deleting a line or "another take" retracts facts + deletes the episode via `reconcileMessageMemory` (a status flip for facts, never a row delete). Episodes use a per-group exchange ordinal (`latestEpisodeNumber(scope) + 1`) as `turn_number`; subjects resolve name-only (no participant rows). The lane's own pre/post-turn wiring (retrieve → extraction legs → write) lives in `engine/chat-memory.ts`; deleting a conversation purges its group via `deleteFactsForScope` / `deleteEpisodesForScope` **only when no other conversation references the group** (`engine/chat-delete.ts` `deleteChat`).

## Episodes (episodic memory)

One row per turn: the archivist's 2–4 sentence summary, embedded. Serves two needs:
- **Narrative window**: the last 4 episode summaries are always in the turn context (recency).
- **RAG recall**: older episodes retrieved by similarity (top 5, min raw cosine `EPISODE_MIN_SCORE` = 0.3 — measured, see §Tuning knobs) against the last exchange's carried `memoryQueries` + player input — each query embedded and retrieved separately, then RRF-fused (`retrieveEpisodesFused`; see §Fused retrieval).

If the memory-scribe leg failed, a synthetic episode (first ~300 chars of the reply) keeps the window contiguous — flagged with a diagnostic.

## Semantic facts

Declarative long-term knowledge (`facts` table, taxonomy in [contracts/facts.md](contracts/facts.md)). Every row carries `origin` (`"extracted"` — the archivist default — `"player"` for "remember this" notes, `"dev"` for inspector edits), a `pinned` flag (see §Pinned facts), and a `channel` (see §Fact channel — the RAG visibility fence). Lifecycle:

1. **Extraction**: the memory-scribe leg emits `FactDraft[]` with confidence; drafts under 0.4 are dropped.
2. **Grounding**: subjects resolve to library rows by name where possible (`subject_id`); unresolved subjects keep `subject_name` only.
3. **Supersedence**: before insert, search active facts with the new fact's embedding (top 3, cosine ≥ 0.86) — same subject + similarity ⇒ old row marked `superseded`, `superseded_by_id` linked. Subject identity **prefers `subject_id` equality** when both sides carry one (differing ids block supersedence even on a name match — two "Twin"s are two entities; matching ids pass across a rename); either side missing an id falls back to case-insensitive `subject_name` equality. **Pinned asymmetry (invariant)**: an `extracted` draft can never supersede a pinned player/dev fact — only a `player`/`dev` draft can retire one; pinned facts supersede others freely. The embedding lives on the row, so superseded facts drop out of retrieval automatically (`status = 'active'` filter) with zero orphan-cleanup machinery.
4. **Retrieval**: active facts by similarity with a **relevance floor** — `FACT_MIN_SCORE` = 0.25 on the best raw cosine, pinned rows exempt — then the top 5 as the narrator's facts channel (capped at 8). Pinned facts are **force-included ahead of the top-k** (cap `PINNED_FACT_CAP` = 8, newest first, no embedder filter — a pinned row is retrieved even unembedded, reported with the honest "not scored" 0).
5. **Edit reconciliation**: facts sourced from an edited/deleted/regenerated assistant message (via `source_message_id`) are `retracted` (not deleted — audit trail), and re-extracted from the new reply. Reconciliation follows the **exchange**, not the anchored row: an edited or deleted PLAYER line retracts and re-extracts the reply that followed it, because that reply's extraction read the player's half too — a player line no reply has answered yet has no derivative to reconcile. Pinned player facts carry no message anchor, so message reconciliation never reaps them.

Facts and episodes carry `witnessed_by` — in the chat lane, the character who was in the exchange (the reply's speaker); it is `[]` for authored/global rows. `witnessEligibilityWhere(column, viewpoint)` can filter retrieval to rows whose witness array contains a given viewpoint plus empty-array rows, in SQL **before** cosine ordering, pinned selection, recency ordering, and LIMIT — corrupted non-array metadata is denied rather than crashing or leaking. Facts also carry `canon` (default true) — reserved for the lies/beliefs model.

### Fact channel — the RAG visibility fence

Every fact carries a **`channel`** (text, default `perceived`; NOT a pg enum — forward-compatible-schema preference) recording *how the knowledge was established*, so the archivist's mind-reading backdoor stays closed: without it, a fact extracted from the player's private thoughts (*"she'd never talk to a dork like me"*) returns later in the narrator's "What you know … treat as true" block and the character "knows" something she never perceived. Vocabulary (`contracts/facts/taxonomy.ts`):

| Channel     | Established through                                                         | Reaches the narrator?                                                                                                       |
| ----------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `perceived` | Quoted speech / a visible action or expression the character saw or heard   | **Yes** — renders as established knowledge                                                                                  |
| `private`   | The player's unspoken inner thoughts (a `*…*` span, or judged semantically) | **No** — excluded from narrator-bound retrieval entirely (owner ruling 2026-07-09: no intuition-grade "you sense…" framing) |
| `ooc`       | `((out-of-character))` direction — generally not stored at all              | **No** — never enters in-world memory                                                                                       |

- **Where the fence lives — retrieval, not render.** `queryFactCandidates` + `selectPinnedFacts` (`memory/facts.ts`) filter to `NARRATOR_VISIBLE_FACT_CHANNELS` (= `["perceived"]`) in SQL **before** the top-k `LIMIT`, so non-perceived facts never reach the narrator prompt **and** never eat a retrieval-cap slot. Narrator retrieval (`retrieveFactsFused` → `buildMemorySection`) inherits it. The **pulse and the dev inspector** read facts through other paths (`listFactsForScope`) and still see every channel — the inspector labels each fact with its channel.
- **Filed by the memory scribe.** The extraction leg tags every fact's channel: quoted/visible ⇒ `perceived`, thought-derived ⇒ `private`, OOC ⇒ skip. When the player used sigils, a parser-derived hint rides along so the classification is deterministic; without sigils it judges semantically. The hint is `channelHint` (`prompts/notation.ts`, over the shared `@/lib/message-spans` parser), which the chat archivist (`prompts/chat-archivist.ts`) calls so it never clones the sigil parse.
- **Degraded default `perceived`, with a diagnostic.** `parseFactChannel` (the trust-boundary parser) degrades an *unknown* channel to `perceived` with a `parse.boundary_failed` diagnostic at both the write (`addFacts`) and read (`listFactsForScope`) boundaries; an *absent* channel degrades silently. Failing to `perceived` is the safe direction: a misclassification surfaces a real perception, never mutes one.

### Pinned facts (player "remember this")

`POST /api/chats/:chatId/remember` writes a normal fact through `addFacts` — so embedding, supersedence, and scope delete all just work — marked `pinned: true`, `origin: "player"`, confidence 1, **no message anchor**. Pinned rows are force-included ahead of every retrieval's top-k, exempt from the relevance floor, and protected by the supersedence asymmetry above; only the player (another sufficiently-similar remember) or a dev inspector edit retires one. The dev inspector can also pin/unpin any fact (`origin: "dev"` on its own creations).

## Fused retrieval (multi-query RRF)

The chat lane retrieves facts + episodes with **per-query embedding + reciprocal-rank fusion** (`retrieveFactsFused` / `retrieveEpisodesFused`; pure math in `memory/fusion.ts`): each query — the carried `memoryQueries` plus the player input — is embedded and retrieved independently, then candidates fuse by `Σ 1/(RRF_K + rank)` (`RRF_K` = 60), so appearing in several lists beats one slightly-better rank. The relevance floors apply to each hit's **best raw cosine** across queries, never the RRF number. Every fused hit carries its `sources` (which queries surfaced it) — threaded into `ChatMemoryTrace.retrievedDetail` for the inspector, and logged on the `retrieval` event. A query-embedding failure degrades with `memory.facts.embed_failed` / `memory.episodes.embed_failed` / `memory.queries.embed_failed` — facts to the pinned-only result, episodes to `[]`.

**One embed per turn** (`memory/query-embeddings.ts`). A turn's retrieval legs all search the SAME texts — the fact leg, the episode leg, every ensemble member's pair of legs, and the memory-callback picker (whose anti-echo anchor IS the player's input) — and this is the **pre-reply** path the player waits on, so embedding them per leg would cost 2–3 round-trips for one text set. Callers embed the whole set once via `QueryEmbeddings.embed` (trimmed + deduped) and pass the cache to each leg; a leg given no cache embeds its own, so one-off callers (the eval harness) need no cache. The cache holds pgvector literals by query text — never a partial vector, so a failed embed simply yields "no vector" and each leg takes its degraded path.

## Library search embeddings

`characters/locations/items/social_cards.search_embedding` power fuzzy name resolution (merge-reducer grounding, forge dedup, library search). Refreshed by an `embed_refresh` job on create/update — a stale embedding degrades search, never correctness (exact-name match is tried first).

## Embedder isolation

Every embedding row records its `embedder` (model id, or `"pseudo"` for demo mode's deterministic hash-based 1536-dim vectors). All similarity queries filter on the current embedder, so pseudo and real vectors — or two different real models after an embedding-model change — never compare against each other. The failure mode of switching embedders mid-conversation is reduced recall (old rows stop matching), never corrupted thresholds; an `embed_refresh` job re-embeds a conversation's rows on demand.

## Tuning knobs

All thresholds (`0.86` supersede, `0.3` episodes, `0.25` facts, `0.75` fuzzy-resolve) live in `memory/constants.ts` with comments on observed behavior. The relevance floors are **measured, not guessed**: `pnpm eval:retrieval` (`scripts/eval/retrieval/`, see its README — never wired into `verify`) seeds fixture corpora through the real write path and scores the real fused retrievers; its first live-embedder run showed relevant paraphrases at 0.27–0.35 (facts) / 0.35–0.51 (episodes) with distractors < 0.2, retuning `FACT_MIN_SCORE` 0.5→0.25 and `EPISODE_MIN_SCORE` 0.55→0.3. Re-run the harness before touching a floor. When tuning, `events` rows (`type: "retrieval"`) carry candidates, raw + RRF scores, and per-hit sources; the queries themselves are player-authored text, so they ride the row's development-only content and are absent in production ([database/README.md](database/README.md) §Operational tables).
