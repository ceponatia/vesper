# Per-character memory — spec

Status: **draft for discussion**. Part of the multi-character split — see
[multi-character-overview.phase3.md](multi-character-overview.phase3.md); rationale in
the brainstorm §Per-character memory. Decision 3 applies.

## Problem

Facts are global and subject-tagged: *about* someone, never *owned by*
someone. The narrator sees the top-5 regardless of who present could know
them — the classic LLM-game pollution where every character knows
everything. The vision: NPCs as independent entities with their own
memories, vector-recallable, never cross-contaminating.

## Design

Two layers, mirroring the existing episodic/semantic split:

### Knowledge ledger (semantic)

Facts gain *knowers*: a join table `fact_knowers (factId, participantId,
source: witnessed | told | common, sinceTurn)`. A character knows a fact
if they **perceived** the originating event (the witness sets from
presence-and-perception-spec — not mere co-location), were **told** it,
or it's **common** knowledge. Scene retrieval filters character-bound
facts by what present characters actually know.

**Start now** (decision 3): stamp `witnessed_by` on every new fact,
write-only, before any retrieval filtering exists — history accrues from
day one.

### Character episodes (episodic, vector)

`character_episodes (ownerParticipantId, text, embedding, sourceTurnId |
sourceTick)`. Sources: turns they perceived (**channel-shaped** — a
comms participant remembers the conversation, not the room), world-tick
`summary` events, backfill summaries. Retrieved per-owner when the
character is present or being world-ticked. Infrastructure is all
existing: pgvector, embedder isolation, the episode retrieval pattern.

### Write policy (decision 3)

- **Default: shared-event rows + knower links** — one memory row per
  event, linked to each witness. No extra inference; the retrieval
  filter alone kills pollution.
- **Perspective memories**: per-witness colored rewrites ("I laughed to
  be polite") only for **major-tier** characters at **significant
  moments** — trigger heuristic: |affinity delta| ≥ threshold on the
  event. Memory fidelity tiers like simulation fidelity.

## Gaps & opportunities

> **Rulings 2026-06-11** (details: decisions 19–23 in the
> [decisions doc](multi-character-presence-and-movement-decisions.phase3.md)):
> lies = `canon` flag on facts; stale beliefs = knower links stick to
> fact versions (no auto-migration on supersedence); telling = archivist
> `disclosures`; lore gets knower scopes, shipping with the ledger; no
> PC ledger (player = reader). Still open below: retrieval cost
> measurement, prompt-side separation discipline, consolidation,
> salience weighting.

- **The facts table assumes truth; characters can be told lies.** This is
  the deepest gap in the whole multi-character effort. A "fact" a
  character was told may be false — the player lies to Mara, one NPC
  deceives another. The current model has no way to store "Mara believes
  X" where X is not canon. Options: a `canon: boolean` flag on facts
  (false ⇒ pure belief, excluded from the narrator's truth channel,
  included in believers' knowledge), or a separate beliefs structure.
  The flag is probably enough — but it must be decided **before** the
  ledger ships, because every told-entry implicitly takes a position on
  it. Deception is also a feature players will actively attempt; today
  the system would canonize their lie as world truth.
- **Stale beliefs — supersedence is global, knowledge isn't.** When a
  fact is superseded ("the shop moved"), knowers of the old fact who
  never perceived the update still believe the old version. Per-knower
  links pointing at fact *versions* (the supersedence chain already
  exists with `superseded_by_id`!) turn this from a bug into a feature:
  characters acting on outdated information is a dramatic-irony engine
  no LLM game has. Cheap-ish: the knower link just doesn't migrate to
  the new fact automatically — a character updates only when they
  perceive/are-told the new state. Strongly recommend designing the
  ledger this way from the start.
- **"Told" detection is unsolved.** When the player says "Mara, the
  mayor's been stealing", a fact transfers — detected how? Proposal: the
  archivist gains `disclosures: [{ factText, toldToNames }]` (it already
  extracts facts from dialogue; attributing the audience is the same
  read). Imperfect detection is acceptable (missed disclosure = the
  character is a little forgetful — degraded, not broken), but the field
  must exist or *nothing* can be told, and the ledger only ever fills
  via witnessing.
- **NPCs know none of the world's lore.** Lore tiers (`always/scene/
  retrieval`) gate what the *narrator* sees for the *player's*
  progression — no notion of which characters know which lore. The
  innkeeper should know local history; the secret cult chunk should be
  known to cultists. Needs a knower scope on lore chunks (`all | tags |
  characterIds | none`), folded into the same recall filter. Without
  this, the ledger governs play-generated knowledge while authored
  knowledge stays omniscient — half a fix.
- **Retrieval cost scales with present majors.** Per-NPC episode
  retrieval for a scene with three majors is 3+ extra similarity
  queries per turn. Mitigations: one batched query (`owner IN (...)`),
  retrieve only for characters with dialogue-bearing roles this turn,
  cap per-owner K small (3?). Pre-turn fan-out absorbs latency; cost is
  the watch item. Measure before optimizing, but design the query
  batched.
- **Prompt-side knowledge separation is its own discipline.** Injecting
  per-character memories means the prompt now contains things *only one
  character knows* — and the narrator must not leak Mara's private
  memory through Tom's mouth. Needs per-character context blocks with an
  explicit framing rule, and ideally a continuity check (knowledge
  leak = a new violation class: character states a fact they're not a
  knower of). The whole point of the ledger is enforced *at this seam* —
  if prompts blur it, the data model was for nothing.
- **No forgetting, no consolidation.** Fine for v1 — but a 500-turn
  session gives majors hundreds of episode rows; retrieval quality
  degrades as near-duplicates accumulate. The existing episode pattern
  (recency window + RAG) transfers; a later consolidation pass
  (summarize old low-salience memories, like human memory does) is the
  natural shape. Note and defer.
- **Emotional salience could weight retrieval.** Perspective memories
  already key off affinity swings; storing that salience score and
  boosting retrieval by it (people remember what *mattered*) is nearly
  free and makes recalled memories feel right rather than merely
  relevant. Small opportunity, large feel.
- **The player character has no ledger — confirm that's intended.** The
  player reads the screen; their knowledge is the reader's. But "your
  character wouldn't know that" gameplay (amnesia, secrets from the PC)
  would need a PC ledger. Recommend explicitly out of scope; record it
  so it's a decision, not an oversight.

## Testing

Pure: knower-filter retrieval (non-knower facts excluded); witnessed vs
told vs common sourcing; perspective-trigger threshold; channel-shaped
episode content (comms vs sight). Degradation: missing knower data on
old facts ⇒ treated as common (pre-ledger rows must not vanish from
recall) + diagnostic. Integration: witness set → knower rows in one
merge; disclosure → told-entry; superseded fact leaves stale believers
(once versioned links land); per-owner retrieval isolation under the
embedder-isolation rules.

## Docs to update when implementing

`memory.md` (the whole ledger + character episodes), `contracts.md`
(fact knower/canon fields, disclosures), `turn-engine.md` (archivist
schema, merge knower writes), `prompts.md` (per-character knowledge
blocks), `database.md` (new tables).
