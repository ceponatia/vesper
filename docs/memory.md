# Memory & RAG

`src/server/memory/` — three memory systems share one embedding space (1536-dim, the code-default embedding model in `server/ai/provider.ts` `MODEL_DEFAULTS`, pgvector cosine). All retrieval calls run in the pre-turn parallel fan-out.

## Memory keying — sessions vs character chat

`facts` and `episodes` serve **two** clients, distinguished by a `MemoryScope` discriminated union (`memory/scope.ts`), never a bare session id:

- **session** (`{ kind: "session", sessionId }`) — the turn lane. Rows key on `session_id` (FK → `sessions`, cascade).
- **chat** (`{ kind: "chat", groupId }`) — a chat **memory group** (character-chat-standalone.spec.md §1.3). Rows key on `chat_memory_group_id`. A group is carried by `chat_participants.memory_group_id`: conversations created as "continue our shared history" share the character's existing group (the relationship remembers across conversations), "fresh start / AU" conversations mint their own island — and in a future group chat each participant keeps their own group.

`session_id` and `chat_memory_group_id` are both nullable; a `*_scope_exactly_one` CHECK enforces that **exactly one** keying is set. Every `addFacts` / `appendEpisode` / `retrieve*` / `recentEpisodes` / `deleteEpisodeForTurn` takes a scope; `memoryScopeWhere(table, scope)` builds the filter and `memoryScopeValues(scope)` the insert columns. Use `sessionScope(id)` / `chatScope(groupId)` at call sites. Chat specifics: no `turns` table, so `sourceTurnId` stays null — chat provenance is **`source_message_id`** (the assistant reply the memory was extracted from, spec §4.3): editing/deleting a line or "another take" retracts facts + deletes the episode via `reconcileMessageMemory` (a status flip for facts, never a row delete). Episodes use a per-group exchange ordinal (`latestEpisodeNumber(scope) + 1`) as `turn_number`; subjects resolve name-only (no participant rows). The chat lane's own pre/post-turn wiring (retrieve → archivist-lite → write) lives in `engine/chat-memory.ts`; deleting a conversation purges its group via `deleteFactsForScope` / `deleteEpisodesForScope` **only when no other conversation references the group** (`engine/chat-pipeline.ts` `deleteChat`).

## Episodes (episodic memory)

One row per turn: the archivist's 2–4 sentence summary, embedded. Serves two needs:
- **Narrative window**: the last 4 episode summaries are always in the turn context (recency).
- **RAG recall**: older episodes retrieved by similarity (top 5, min raw cosine `EPISODE_MIN_SCORE` = 0.3 — measured, see §Tuning knobs) against `brief.memoryQueries + player input` — each query embedded and retrieved separately, then RRF-fused (`retrieveEpisodesFused`; see §Fused retrieval).

If the archivist failed, a synthetic episode (first ~300 chars of narration) keeps the window contiguous — flagged with a diagnostic.

## Semantic facts

Declarative long-term knowledge (`facts` table, taxonomy in [contracts/facts.md](contracts/facts.md)). Every row carries `origin` (`"extracted"` — the archivist default — `"player"` for "remember this" notes, `"dev"` for inspector edits), a `pinned` flag (see §Pinned facts), and a `channel` (see §Fact channel — the RAG visibility fence). Lifecycle:

1. **Extraction**: archivist emits `FactDraft[]` with confidence; drafts under 0.4 are dropped.
2. **Grounding**: subjects resolve to participant/location/item rows by name where possible (`subject_id`); unresolved subjects keep `subject_name` only.
3. **Supersedence**: before insert, search active facts with the new fact's embedding (top 3, cosine ≥ 0.86) — same subject + similarity ⇒ old row marked `superseded`, `superseded_by_id` linked. Subject identity **prefers `subject_id` equality** when both sides carry one (differing ids block supersedence even on a name match — two "Twin"s are two entities; matching ids pass across a rename); either side missing an id falls back to case-insensitive `subject_name` equality. **Pinned asymmetry (invariant)**: an `extracted` draft can never supersede a pinned player/dev fact — only a `player`/`dev` draft can retire one; pinned facts supersede others freely. The embedding lives on the row, so superseded facts drop out of retrieval automatically (`status = 'active'` filter) with zero orphan-cleanup machinery.
4. **Retrieval**: active facts by similarity with a **relevance floor** — `FACT_MIN_SCORE` = 0.25 on the best raw cosine, pinned rows exempt — then the top 5, merged (session lane) with the director's curated `characterNotes` into a single deduped ≤8-item facts channel for the narrator (one list, not three competing ones). Pinned facts are **force-included ahead of the top-k** (cap `PINNED_FACT_CAP` = 8, newest first, no embedder filter — a pinned row is retrieved even unembedded, reported with the honest "not scored" 0).
5. **Edit reconciliation**: facts sourced from an edited/rerun turn (or, chat lane, an edited/deleted/regenerated assistant message via `source_message_id`) are `retracted` (not deleted — audit trail), and re-extracted from the new narration. Pinned player facts carry no message anchor, so message reconciliation never reaps them.

Facts and episodes carry `witnessed_by`: as of phase 3 (presence & perception v1) this is the **perception-based witness set** computed each turn from attention × salience — `[player, ...perceivers]`, the NPCs who actually perceived a salient action this turn, not everyone co-located (see [perception.md](perception.md)). The stamp is now real perception. The knowledge-ledger **consumer** (per-character episodes / fact knowers reading the stamp, [developer-notes/character-memory-spec.phase3.md](developer-notes/finished/character-memory-spec.phase3.md)) is still phase 6 — for now the set is written truthfully and waits on its reader. Facts also carry `canon` (default true) — reserved for the lies/beliefs model, ignored by retrieval for now.

### Fact channel — the RAG visibility fence

Every fact carries a **`channel`** (text, default `perceived`; NOT a pg enum — forward-compatible-schema preference) recording *how the knowledge was established*, so the archivist's mind-reading backdoor stays closed: without it, a fact extracted from the player's private thoughts (*"she'd never talk to a dork like me"*) returns later in the narrator's "What you know … treat as true" block and the character "knows" something she never perceived (player-input-perception.plan.md slice 6). Vocabulary (`contracts/facts/taxonomy.ts`):

| Channel | Established through | Reaches the narrator? |
| --- | --- | --- |
| `perceived` | Quoted speech / a visible action or expression the character saw or heard | **Yes** — renders as established knowledge, exactly as before |
| `private` | The player's unspoken inner thoughts (a `*…*` span, or judged semantically) | **No** — excluded from narrator-bound retrieval entirely (owner ruling 2026-07-09: no intuition-grade "you sense…" framing) |
| `ooc` | `((out-of-character))` direction — generally not stored at all | **No** — never enters in-world memory |

- **Where the fence lives — retrieval, not render.** `queryFactCandidates` + `selectPinnedFacts` (`memory/facts.ts`) filter to `NARRATOR_VISIBLE_FACT_CHANNELS` (= `["perceived"]`) in SQL **before** the top-k `LIMIT`, so non-perceived facts never reach the narrator prompt **and** never eat a retrieval-cap slot. Both lanes' narrator retrieval (`retrieveFactsFused` → chat `buildMemorySection` and session `preTurnRetrieve`) inherit it; `buildMemorySection` itself is unchanged (it only ever receives perceived facts). The **pulse and the dev inspector** read facts through other paths (`listFactsForScope`) and still see every channel — the inspector labels each fact with its channel.
- **Filed by the archivist — both lanes.** Each lane's archivist tags every fact's channel: quoted/visible ⇒ `perceived`, thought-derived ⇒ `private`, OOC ⇒ skip. When the player used sigils, a parser-derived hint rides along so the classification is deterministic; without sigils it judges semantically. The hint is the shared `channelHint` (`prompts/notation.ts`, over the shared `@/lib/message-spans` parser) — the chat archivist (`prompts/chat-archivist.ts`) and the **session** archivist (`prompts/agents.ts` `ARCHIVIST_SYSTEM` + `buildArchivistPrompt`) both call it, so neither clones the sigil parse (player-input-perception.plan.md slice 7 closed the session half; the session extractor no longer writes the bare `perceived` default). The session's `channelHint` phrase generalizes over the whole cast ("no character in the scene perceived it") where chat names its one character.
- **Degraded default `perceived`, with a diagnostic.** `parseFactChannel` (the trust-boundary parser) degrades an *unknown* channel to `perceived` with a `parse.boundary_failed` diagnostic at both the write (`addFacts`) and read (`listFactsForScope`) boundaries; an *absent* channel (the session lane, existing rows migrated by `0029`) degrades silently. Failing to `perceived` is the safe direction: a misclassification surfaces a real perception, never mutes one.

### Pinned facts (player "remember this")

`POST /api/chats/:chatId/remember` (spec §6.4, D15) writes a normal fact through `addFacts` — so embedding, supersedence, and scope delete all just work — marked `pinned: true`, `origin: "player"`, confidence 1, **no message anchor**. Pinned rows are force-included ahead of every retrieval's top-k, exempt from the relevance floor, and protected by the supersedence asymmetry above; only the player (another sufficiently-similar remember) or a dev inspector edit retires one. The dev inspector can also pin/unpin any fact (`origin: "dev"` on its own creations).

### Authored interior facts (NPC inner notes)

A player can author an interior note for an NPC (cast card → "Inner note"): a memory, feeling, or belief — never dialogue. The `inner_note` job ([turn-engine.md](turn-engine.md) §Jobs) extracts 1–4 interior facts bound to that NPC (subject = the NPC, `canon: true`) and inserts them through the standard `addFacts` path (embedded, supersedence-checked) with `witnessed_by` set to **that NPC alone** — interiority is theirs, which is exactly the witness set the knowledge ledger will consume. The extraction's guidance line is appended to the session brief's `characterNotes` so the very next turn reflects the note (facts alone retrieve probabilistically); the brief regenerates each merge, so the guidance self-expires while the facts carry the long term. With the model down (or in demo mode) the note degrades to one verbatim `knowledge` fact plus verbatim guidance, with diagnostics.

## Fused retrieval (multi-query RRF)

Both lanes retrieve facts + episodes with **per-query embedding + reciprocal-rank fusion** (`retrieveFactsFused` / `retrieveEpisodesFused`; pure math in `memory/fusion.ts`): each query — the carried `memoryQueries` plus the player input — is embedded and retrieved independently, then candidates fuse by `Σ 1/(RRF_K + rank)` (`RRF_K` = 60), so appearing in several lists beats one slightly-better rank. The relevance floors apply to each hit's **best raw cosine** across queries, never the RRF number. Every fused hit carries its `sources` (which queries surfaced it) — threaded into the chat lane's `ChatMemoryTrace.retrievedDetail` for the inspector, and logged on the `retrieval` event. The session lane's `preTurnRetrieve` runs the same fused path (lore stays single-query over the joined text). A query-embedding failure degrades with `memory.facts.embed_failed` / `memory.episodes.embed_failed` / `memory.queries.embed_failed` — facts to the pinned-only result, episodes to `[]`.

**One embed per turn** (`memory/query-embeddings.ts`, chat-agent-improvements.plan.md slice 3). A turn's retrieval legs all search the SAME texts, but each used to batch-embed them itself: the fact leg, the episode leg, every ensemble member's pair of legs, and the chat lane's memory-callback picker (whose anti-echo anchor IS the player's input) — 2–3 round-trips for one text set, on the **pre-reply** path the player actually waits on. Callers now embed the whole set once via `QueryEmbeddings.embed` (trimmed + deduped) and pass the cache to each leg; a leg given no cache still embeds its own, so one-off callers (the eval harness) are unchanged. The cache holds pgvector literals by query text — never a partial vector, so a failed embed simply yields "no vector" and each leg takes its existing degraded path.

## Lore (authored world knowledge)

`lore_chunks` per world, embedded at save time. Injection tiers:

| Tier | When injected |
| --- | --- |
| `always` | Static rulebook (counts against its ~1500-token lore budget; sorted by `sort`) |
| `scene` | Turn context when tags match the scene (location tags, present character ids) |
| `retrieval` | Eligibility pre-filter runs **first** (tag/visibility/unlock match), then top 3 by similarity (min 0.72) over the eligible pool — gating never starves retrieval of chunks that were both eligible and relevant |

(The old app called these tiers A/B/C; the names here are `always`/`scene`/`retrieval` everywhere.)

`visibility: "secret"` chunks are excluded everywhere until unlocked: a maintenance pass after each turn matches fact tags against `unlock_tags` — **exact match, case-insensitive, one matching fact suffices** — and adds chunk ids to `session.runtime.unlockedLoreIds`. Near-miss tags log a `lore_unlock_miss` event for debugging, and the world editor has a manual unlock toggle per chunk. This is the progression mechanic — author secrets, gate them on discovered facts.

## Library search embeddings

`characters/locations/items/social_cards.search_embedding` power fuzzy name resolution (merge-reducer grounding, forge dedup, library search). Refreshed by an `embed_refresh` job on create/update — a stale embedding degrades search, never correctness (exact-name match is tried first).

## Embedder isolation

Every embedding row records its `embedder` (model id, or `"pseudo"` for demo mode's deterministic hash-based 1536-dim vectors). All similarity queries filter on the current embedder, so pseudo and real vectors — or two different real models after an embedding-model change — never compare against each other. The failure mode of switching embedders mid-session is reduced recall (old rows stop matching), never corrupted thresholds; an `embed_refresh` job re-embeds a session's rows on demand.

## Tuning knobs

All thresholds (`0.86` supersede, `0.72` lore, `0.3` episodes, `0.25` facts, `0.75` fuzzy-resolve) live in `memory/constants.ts` with comments on observed behavior. The relevance floors are **measured, not guessed**: `pnpm eval:retrieval` (`scripts/eval/retrieval/`, see its README — never wired into `verify`) seeds fixture corpora through the real write path and scores the real fused retrievers; its first live-embedder run showed relevant paraphrases at 0.27–0.35 (facts) / 0.35–0.51 (episodes) with distractors < 0.2, retuning `FACT_MIN_SCORE` 0.5→0.25 and `EPISODE_MIN_SCORE` 0.55→0.3. Re-run the harness before touching a floor. When tuning, log `events` rows (`type: "retrieval"`) carry queries, candidates, raw + RRF scores, and per-hit sources — the Turn Inspector renders them.
