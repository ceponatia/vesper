# Retrieval eval harness

The measurement harness for memory retrieval quality
(`docs/developer-notes/character-chat-standalone.spec.md` §6.3 #6) — the precondition the
§6.3 work (the `FACT_MIN_SCORE` relevance floor, pinned force-include, per-query embedding
+ RRF fusion) is tuned against, and the **permanent regression harness for retrieval
changes**: run it before and after touching `src/server/memory/` retrieval code or the
`constants.ts` knobs.

It seeds chat-shaped fixture corpora (`fixtures.ts` — 1-on-1 romance-chat flavored, see
`docs/character-chat.md`) into **throwaway chat memory groups** (id prefix
`eval-retrieval-`) through the REAL write path (`addFacts` / `appendEpisode`), retrieves
through the REAL fused retrievers (`retrieveFactsFused` / `retrieveEpisodesFused`), scores
the results against per-fixture expectations, and **always deletes the scope again**
(`deleteFactsForScope` / `deleteEpisodesForScope` in a `finally`). The only residue is a
few `events` rows (`type: "retrieval"`, null session) — the same observability stream real
retrieval writes.

**Not wired into CI, ever.** The harness measures; a poor score is a signal
to tune floors/fusion, never a build failure. With a real embedder it makes a handful of
OpenRouter embedding calls (fractions of a cent).

## Run

```bash
pnpm eval:retrieval                    # all fixtures (needs DATABASE_URL, .env is loaded)
pnpm eval:retrieval --fixture pinned   # substring match on fixture id
pnpm eval:retrieval --dry-run          # print fixtures + the plan; no DB, no embeddings
```

Results print as a table and write to `data/eval/retrieval/results.json` (`data/` is
gitignored; override the directory with `EVAL_OUT`). The fixture set itself is guarded by
a pure vitest test (`fixtures.test.ts`, runs in `pnpm test`).

## What it measures

Per fixture, against `expectRelevant` / `expectExcluded` keys:

- **Fused recall / precision @k** — did the fused retrievers surface what a real chat turn
  would need (k = `FACT_RETRIEVAL_LIMIT` / `EPISODE_RETRIEVAL_LIMIT`)? Fixtures contain
  neutral filler facts on purpose, so precision < 1 is expected; watch it for regressions,
  not as an absolute bar.
- **Floor behavior** — every `expectExcluded` distractor that gets retrieved is a failure,
  reported with its reason: `floor` (should have scored under `FACT_MIN_SCORE` /
  `EPISODE_MIN_SCORE`) or `window` (an episode inside the `EPISODE_WINDOW` recency window,
  which must stay out structurally).
- **Pinned force-include** — pinned fixture facts (spec §6.4 "remember this") must surface
  even when dissimilar to every query.
- **Fused vs joined baseline** — each fixture also runs its queries newline-joined as ONE
  `retrieveFacts`/`retrieveEpisodes` call; `Δrec` (fused recall − joined recall) is the
  honest measure of what per-query embedding + RRF fusion (§6.3 #2) bought. Expect the
  delta on `multi-query-fusion`-style fixtures, ~0 on single-query ones.
- **Score matrix** (JSON only) — every seeded doc's best raw cosine across the queries,
  computed client-side with the same embedder. This is the floor-tuning payload: it shows
  the scores of *misses* too, which the floored retrieval path can't.

## Fixture coverage

| id | covers |
| --- | --- |
| `direct-recall` | (a) query names the fact |
| `paraphrase-recall` | (b) semantic match, no shared keywords |
| `distractor-rejection` | (c) off-topic facts must fall below the floor |
| `pinned-force-include` | (d) pinned fact dissimilar to every query still surfaces |
| `multi-query-fusion` | (e) two queries, two targets — fusion vs the diluted joined query |
| `episode-window-recall` | (f) old episode via RAG; in-window episodes stay out |
| `mixed-channels` | (a)+(f) facts and episodes over one scope with shared queries |

## Pseudo-embedding caveat (read this)

Without `OPENROUTER_API_KEY` (or with `AI_FAKE=1`) the app embeds with **hash-based
pseudo-vectors** (`src/server/ai/embeddings.ts`): similarity between them is noise, so
recall/precision/floor numbers are **meaningless**. The harness detects this, banners it
loudly, and labels the results JSON `"pseudo-embeddings — structural smoke only"`. Such a
run still validates the plumbing — seeding, pinned force-include (floor-exempt by
construction), the recency window, cleanup — but never tune a floor from it.

## Tuning FACT_MIN_SCORE from results

The spec calls for "a **measured** relevance floor"; `FACT_MIN_SCORE = 0.5` in
`src/server/memory/constants.ts` is the starting value pending this harness's numbers.
With a **real** embedder:

1. Run `pnpm eval:retrieval` and open `data/eval/retrieval/results.json`.
2. In each fixture's `scoreMatrix`, compare the `bestCosine` distributions of
   `expected: true` docs vs `excluded: true` distractors. The floor belongs in the gap:
   **below every expected doc you care about, above the distractor band.**
3. `distractorsPassed` with reason `floor` ⇒ the floor is too low (raise it toward the
   leaking distractor's `bestCosine`). Entries in `misses` whose `scoreMatrix.bestCosine`
   is *under* the floor ⇒ the floor is too high (a dropped fact costs more than a loose
   one — facts sit below the episodes' floor on purpose).
4. Change the constant, re-run, and keep the before/after `results.json` pair alongside
   the change. Add a fixture for any real-world miss that motivated the tuning — that's
   how the regression net grows.

The same procedure applies to `EPISODE_MIN_SCORE` via episode-bearing fixtures.
