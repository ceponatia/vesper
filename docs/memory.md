# Memory & RAG

`src/server/memory/` — three memory systems share one embedding space (1536-dim, OpenRouter `EMBEDDING_MODEL`, pgvector cosine). All retrieval calls run in the pre-turn parallel fan-out.

## Episodes (episodic memory)

One row per turn: the archivist's 2–4 sentence summary, embedded. Serves two needs:
- **Narrative window**: the last 4 episode summaries are always in the turn context (recency).
- **RAG recall**: older episodes retrieved by similarity (top 5, min score 0.55) against `brief.memoryQueries + player input`.

If the archivist failed, a synthetic episode (first ~300 chars of narration) keeps the window contiguous — flagged with a diagnostic.

## Semantic facts

Declarative long-term knowledge (`facts` table, taxonomy in [contracts.md](contracts.md)). Lifecycle:

1. **Extraction**: archivist emits `FactDraft[]` with confidence; drafts under 0.4 are dropped.
2. **Grounding**: subjects resolve to participant/location/item rows by name where possible (`subject_id`); unresolved subjects keep `subject_name` only.
3. **Supersedence**: before insert, search active facts with the new fact's embedding (top 3, cosine ≥ 0.86) — same `subject_name` (case-insensitive) + similarity ⇒ old row marked `superseded`, `superseded_by_id` linked. The embedding lives on the row, so superseded facts drop out of retrieval automatically (`status = 'active'` filter) with zero orphan-cleanup machinery.
4. **Retrieval**: top 5 active facts by similarity, merged with the director's curated `characterNotes` into a single deduped ≤8-item facts channel for the narrator (one list, not three competing ones).
5. **Edit reconciliation**: facts sourced from an edited/rerun turn are `retracted` (not deleted — audit trail), and re-extracted from the new narration.

Facts and episodes carry `witnessed_by`: the participant ids co-located with the player at write time. **Interim semantics, write-only** — nothing reads it yet; the knowledge ledger ([developer-notes/character-memory-spec.phase3.md](developer-notes/character-memory-spec.phase3.md)) refines it to perception-based witness sets and starts consuming it. Facts also carry `canon` (default true) — reserved for the lies/beliefs model, ignored by retrieval for now.

### Authored interior facts (NPC inner notes)

A player can author an interior note for an NPC (cast card → "Inner note"): a memory, feeling, or belief — never dialogue. The `inner_note` job ([turn-engine.md](turn-engine.md) §Jobs) extracts 1–4 interior facts bound to that NPC (subject = the NPC, `canon: true`) and inserts them through the standard `addFacts` path (embedded, supersedence-checked) with `witnessed_by` set to **that NPC alone** — interiority is theirs, which is exactly the witness set the knowledge ledger will consume. The extraction's guidance line is appended to the session brief's `characterNotes` so the very next turn reflects the note (facts alone retrieve probabilistically); the brief regenerates each merge, so the guidance self-expires while the facts carry the long term. With the model down (or in demo mode) the note degrades to one verbatim `knowledge` fact plus verbatim guidance, with diagnostics.

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

`characters/locations/items.search_embedding` power fuzzy name resolution (merge-reducer grounding, forge dedup, library search). Refreshed by an `embed_refresh` job on create/update — a stale embedding degrades search, never correctness (exact-name match is tried first).

## Embedder isolation

Every embedding row records its `embedder` (model id, or `"pseudo"` for demo mode's deterministic hash-based 1536-dim vectors). All similarity queries filter on the current embedder, so pseudo and real vectors — or two different real models after an `EMBEDDING_MODEL` change — never compare against each other. The failure mode of switching embedders mid-session is reduced recall (old rows stop matching), never corrupted thresholds; an `embed_refresh` job re-embeds a session's rows on demand.

## Tuning knobs

All thresholds (`0.86` supersede, `0.72` lore, `0.55` episodes, `0.75` fuzzy-resolve) live in `memory/constants.ts` with comments on observed behavior. When tuning, log `events` rows (`type: "retrieval"`) carry query, candidates, and scores — the Turn Inspector renders them.
