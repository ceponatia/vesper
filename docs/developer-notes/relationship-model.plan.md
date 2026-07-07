# Relationship model v2 — familiarity × regard

Status: draft (scoped 2026-07-07 from an owner design conversation; expanded the
same day with owner rulings on per-pair records, multi-character chat, and
absent-character injection — remaining open questions below still need rulings
before this becomes buildable slices)

## Problem

The relationship model is one scalar (`affinity` −100..100 →
`contracts/relationships/stages.ts`, eleven ordered stages) that conflates two
independent things:

- **Knowledge** — how well two people know each other (stranger ↔ knows them deeply)
- **Feeling** — how they feel about each other (hostile ↔ devoted)

The conflation is baked into the stage *order*: `acquaintance` (+15..32) sits
numerically above `cool` (−35..−15), so "an acquaintance she's cool toward" is
unrepresentable — and so is enemies-to-lovers, the canonical romance arc, on a
romance-first product. The failing case that motivated this: *"these two have known
each other for 20 years so are quite familiar, but she dislikes him — or at least
pretends to."* Nothing in `{stage: id}` can say that, and at chat cold-start there
is no history or memory for the narrator to infer it from; the authored state is
all it gets.

## Design sketch

### Two stored axes, headroom for a third

| Axis | Motion | Bands (working) | Governs |
| --- | --- | --- | --- |
| **Familiarity** | slow ratchet (you can't un-know someone) | `strangers → introduced → acquainted → familiar → deeply-known` | address rights (first name/nicknames), what can be assumed/referenced, disclosure *ceiling*, how well they read the other |
| **Regard** | volatile — this is today's `affinity` once familiarity-flavored stages are evicted | today's ladder minus `stranger`/`acquaintance`: `hostile → wary → cool → neutral → friendly → warm → close → cherished → devoted → smitten` | warmth of tone, *desire* to initiate, patience/benefit of the doubt, escalation floor |
| **Attraction** (future) | — | not built in v2 | romantic/sexual pull distinct from platonic regard — what enemies-to-lovers actually runs on |

Store the per-target relationship as a small **record** (jsonb), not bare columns,
so attraction later is a field addition, not a migration (forward-compatible-schema
preference). The record also carries authored narrative texture that does the
cold-start work:

```ts
{
  familiarity: bandId,          // knowledge axis (also mirrored as a scalar for the ratchet)
  regard: number,               // the existing affinity scalar, renamed in concept only
  kind?: string,                // the label both would use: "coworkers of 20 years", "her ex-husband"
  history?: string,             // one line of shared past: "he left town without a word; she rebuilt alone"
  presented?: string,           // the mask: how they PERFORM it when it differs from what they feel
  // attraction?: number        // reserved
}
```

`presented` covers both directions of "pretends to": performed disdain over real
warmth (tsundere) and performed courtesy over contempt (professional mask). The
sessions lane's `perceived` edge (belief about the other's feeling) is a different
concept and stays as-is.

### What the LLM sees — the composed law block

`buildRelationshipLawSection` becomes a composition of the two band profiles plus
the authored texture. Target render for the motivating example:

```
Relationship with Daniel (this governs your behavior; never recite it):
- History: you have known each other for twenty years — estranged childhood
  friends. He left town without a word; you rebuilt without him.
- Familiarity (deeply-known): first names and old nicknames are yours to use; you
  can reference shared history freely and read his moods at a glance.
- Regard (cool): you dislike him — his charm reads as smugness to you. You give
  him nothing you don't have to; familiarity is not warmth.
- Outwardly: you keep it icily civil. The dislike shows in what you don't say —
  and old warmth flickers through when you're caught off guard.
- Escalation: [keyed to REGARD; premise-wins + disinhibition-never-raises +
  values-trump exceptions unchanged from D11]
```

Composition rules (the heart of the design):

- **Openness = min(familiarity ceiling, regard willingness).** "You *could* finish
  his sentences, but you *won't* give him anything" — the line one scalar can't say.
- **Address**: familiarity grants the register; regard decides whether it's spoken
  warmly or used as a weapon.
- **Initiative**: familiarity makes initiating *easy* (no social risk); regard makes
  it *wanted*. Familiar + cold = initiates freely but only transactionally.
- **Escalation floor moves to the regard axis** (later regard × attraction). A
  20-year acquaintance she despises entertains nothing; a stranger with chemistry
  can flirt.

Mechanics stay cheap and registry-shaped: two band-profile tables (~5 familiarity +
~10 regard entries) replace today's 11 stage profiles — composition happens in
prose assembly, so no M×N explosion. A sparse `comboNotes` table keyed by
(familiarityBand, regardBand) covers the handful of special corners
(familiar × hostile = "the intimate enemy — you know exactly where to cut").
Block stays in the §9 stable prefix; re-renders only on band change.

### Disposition interplay

1. **Disposition is the default; the relationship record is the exception.**
   Disposition answers "how do you treat people you have no feelings about". The
   disposition tags' existing `warmth` lean seeds *unseeded* relationships (aloof ⇒
   slightly negative starting regard, sunny ⇒ slightly positive). Where strangers
   start comes from disposition; where specific people are comes from the record.
2. **Disposition styles the expression of regard, never its value.** Stoic + warm
   regard = fondness through acts, not words; sunny + cool regard = cheerfully
   distant. Generalizes `stageDispositionOverlays`, re-keyed to the regard band.
3. **Divergence is stated explicitly — the contrast is the characterization.** When
   regard's sign disagrees with disposition's lean, emit one line: *"You are curt
   with people generally; Mara is one of the few exceptions — around her, the guard
   drops."* Don't leave the trope for the model to infer from two distant blocks.

### Dynamics

- **Regard**: existing machinery untouched — reaction pulse, milestones, history
  samples; the `character_chat_state.affinity` column can keep its name.
- **Familiarity**: stored scalar, author-seeded, ratcheted by lived interaction.
  Signal source is the memory system we already have: archivist fact extraction /
  episode closes tick it up — "how well you know someone" *is* accumulated shared
  history. Never decays (staleness is a non-goal for v2).
- **Milestones** split by axis: regard keeps stage_up/down; familiarity ratchets get
  their own kind ("She let you in").

### UI

- **Authoring** (character Chat tab "Starting Relationship" / cast editor): two band
  selects + `kind` + `history` + `presented`, with a **live one-sentence preview of
  the exact law block the narrator will read** — authors see the render, not an
  abstraction.
- **Matrix visual**: a small 2D plot (familiarity x, regard y), named corner regions
  (*old enemy*, *estranged*, *beloved*, *instant chemistry*); region label replaces
  today's single stage chip (or two chips).
- **State tools modal**: both scalars + mask editable (dev-override philosophy
  unchanged). Relationship panel chart becomes two lines — volatile regard over a
  slow familiarity ramp.
- Pair-matrix authoring (NPC↔NPC) is its own surface — see §"The matrix" below.

## Per-pair relationships & multi-character chat

Owner rulings, 2026-07-07 (settled — not open questions):

1. **The record is pair-scoped, not player-only.** The same
   `{familiarity, regard, kind, history, presented}` record describes any directed
   character→character edge, so authors can define how two NPCs behave toward one
   another.
2. **Chat is the proving ground; sessions are earmarked.** The matrix ships and gets
   tested in the basic Chat lane; the sessions lane changes **nothing now** — the
   design below is recorded for the session-chat refactor.
3. **No primary/supporting hierarchy.** Characters in a chat are full characters
   loaded into a single conversation (2–4 typical). Not everything sessions track —
   no locations, inventory, exposure — just narrative **presence** plus an activity
   recency signal.
4. **Relationships are authored per conversation, not on the character.** A
   relationship is a property of a pair *in a story* — the same two library
   characters can be exes in one conversation and strangers in an AU. The authoring
   surface is a matrix menu inside the chat.
5. **Absent-character injection is reactive + looming** (see §"What the narrator
   sees when").
6. **Authoring is shared-cell; storage is fully directed.** One matrix cell per
   pair, but the rows underneath are directional from day one — "A loves B, B
   secretly resents A" must be a data state, never a schema change.

### The matrix — storage and authoring

- **Directed rows, mirrored authoring.** New table `character_chat_relationships`
  keyed `(chat_id, from_character_id, to_character_id)`, record jsonb — the chat
  analogue of `participant_relationships`, record-shaped from day one. The matrix
  UI presents **one cell per pair**: `kind` + `history` are shared (written to both
  rows identically); the stances (`familiarity`, `regard`, `presented`) show two
  columns, mirrored by default behind an "asymmetric" toggle. This halves authoring
  for the common symmetric case while keeping full directionality underneath —
  the same explicit-wins spirit as `relationship-seeds.ts`'s implied reverse edge.
- **Player edges stay where they are (v2).** The character→player record lives on
  `character_chat_state` (slice 2) so the pulse/milestone/panel machinery is
  untouched; the matrix menu is one surface reading/writing both stores (the player
  is a column in the grid). Unifying everything into one edge store is a
  session-refactor concern, not a v2 one.
- **NPC↔NPC records are static authored texture in v2** — no reaction pulse, no
  milestones, no familiarity ratchet between NPCs. Evolution rides the archivist
  for free: relationship-kind facts ("Maya no longer trusts Rhett") are already
  extracted and retrieved, so lived shifts reach the narrator through memory while
  the authored record stays the cold-start law. Pair dynamics get built once, in
  the session refactor, for both lanes.

### Multi-character chat substrate (prerequisite, chat lane)

The matrix needs conversations that can hold more than one character. This is a
real scope expansion of the chat lane — [docs/character-chat.md](../character-chat.md)'s
"deliberately not a session: no multi-character cast" line gets amended when this
ships — but a bounded one:

- **Roster.** A conversation gains N library characters (UI add/remove). Each gets
  its own `character_chat_state` row — the `(chat_id, character_id)` PK was keyed
  for exactly this. Roster of 1 = today's chat, byte-identical prompt (no
  regression to the shipped product).
- **Presence, not location.** One narrative flag per character: **present**
  (sharing the player's scene) or **away** (offstage, living their life). That is
  the only "location" tracked. NPC↔NPC co-presence away from the player is
  narrative flavor, not state.
- **Activity recency.** Per character, the last exchange in which they were
  *mentioned, acted, or were spoken to* — this drives the per-character detail
  budget in the prompt (below). Updates are deterministic-first: display-name +
  `profile.aliases` regex over the player input and the reply (the
  `chat-intent.ts` pattern); the chat archivist confirms presence transitions
  post-turn; a roster panel exposes manual present/away toggles (dev-override
  philosophy).
- **Narration authority: the player owns himself.** When no character is present,
  the narrator writes ONLY what the away characters are doing — never the player's
  own actions or location. Player: *"I'm in my bedroom getting changed for our
  date"* → narrator: *"Sabrina stands in front of her mirror, fussing over her
  hair…"*. When characters are present, the existing shared-scene rules apply.
- **Prompt frame.** More than one character shifts the reply voice from
  "you are X" toward a scene narrator over the roster (the cutaway example above is
  third person). Exact framing is an open question below; the hard constraint is
  that roster-of-1 conversations keep today's prompt unchanged.

### What the narrator sees when — presence × salience tiers

The injection problem: naming an absent character in the prompt pressures the
narrator to include them. The rule that defuses it: **edge injection is reactive —
triggered by the transcript, never anticipatory** — so an edge line can't cause the
introduction it colors; by the time the narrator sees it, the fiction already
surfaced the name.

| Tier | Condition | What renders |
| --- | --- | --- |
| 1 | Present + recently active | Full identity/state block + full composed pair law blocks for every present pair (character↔player **and** character↔character — escalation floors included, same builder) |
| 2 | Present + quiet (no action/mention for K exchanges) | Compressed: one-line state, one-line relationship summaries |
| 3 | Away + salient (mentioned within the window, or edge flagged **looming**) | A compact conditional edge line — *"If Mara comes up: …"* — plus the **don't-teleport guard**: *she is not with you; you may show what she's doing where she is, but never merge her into the player's scene uninvited* |
| 4 | Away + silent | Nothing. The narrator can't be tempted by what it can't see |

- **Looming (per-edge, opt-in flag).** For the absent person whose absence *is* the
  story (the estranged brother): the edge rides in the prompt unmentioned, framed
  as interiority ("he weighs on you"), same don't-teleport guard. Everyone else
  waits for the transcript to name them.
- **Salience window.** A tier-3 line persists for K mention-free exchanges, then
  drops (K small, ~3; tune in eval).
- **Cache placement.** Present-pair law blocks join the **stable prefix**,
  re-rendering on roster/presence/band change — the same license as today's
  stage-crossing re-render (prefix-byte-stability test grows those cases).
  Tier-2 compression and tier-3 salience lines are **volatile tail**.
- **Token budget.** 4 characters + player = 10 pairs worst case, but only present
  pairs get full blocks and tier 2 compresses the quiet ones; the matrix being
  bounded (ruling 3) is what keeps this affordable.

### Sessions — earmark only (no changes now)

Recorded for the session-chat refactor:

- **Existing render gap (found 2026-07-07):** spawn seeds NPC↔NPC `feeling` edges
  into `participant_relationships` in both directions
  (`server/engine/relationship-seeds.ts`), but `buildRelationshipBlock`
  (`server/engine/scene.ts`) only renders edges **toward the player** — authored
  NPC↔NPC feelings never reach the session narrator today. The refactor should
  render pair blocks for **co-present** pairs.
- The same presence × salience tiers port over, with one upgrade: sessions have an
  intake agent, so "thinking/talking about an absent character" can come from the
  intent brief instead of regex.
- The record shape rides slice 7; the bond classifier's mutual-bond keywords map to
  familiarity defaults.

## Slices (rough)

1. **Contracts**: familiarity + regard band registries, composed law builder,
   old-stage → (familiarity, regard) mapping table, comboNotes seam — plus the
   **directed pair-record schema** (one contract shared by the player edge, the
   chat matrix, and later the sessions lane). Pure + tested.
2. **State & authoring schema**: `character_chat_state` grows the record (jsonb +
   familiarity scalar); `profile.playerRelationship` grows from `{stage, note}` to
   the record shape (self-healing `.catch`es; old `stage` maps via the table).
3. **Prompt**: law-block rewrite + disposition-contrast line + skip-note re-key;
   eval fixtures (below).
4. **UI (player edge)**: authoring control + preview, state tools, relationship
   panel 2D.
5. **Multi-character chat substrate**: roster (conversations hold N characters),
   per-character state rows, presence flag + activity recency, prompt reframe for
   roster > 1, narration-authority rule, salience-tiered detail budget. Needs 1–3.
   Big enough that it likely becomes its own `<topic>.plan.md` when sequenced —
   this plan then depends on it rather than containing it.
   *Creation groundwork shipped 2026-07-07*: the New-conversation dialog multi-selects
   up to 4 characters and `POST /api/chats` takes `characterIds` (one
   `chat_participants` row each, sort 0 = primary, per-character memory groups,
   auto-title "A & B"); the exchange pipeline still runs 1-on-1 against the
   primary — extra participants are inert until this slice.
6. **The matrix**: `character_chat_relationships` table, matrix menu (shared cell,
   mirrored stances, asymmetric toggle, live two-direction preview), reactive +
   looming injection with the don't-teleport guard.
7. **(Later) Sessions lane — earmark only**: `participant_relationships` + authored
   cast edges gain the record; co-present pair rendering closes the
   `buildRelationshipBlock` NPC↔NPC gap; intake-driven salience; bond classifier's
   mutual-bond keywords map to familiarity defaults.

**Eval tie-in**: the enactment measurement harness (top of Next) is the instrument —
add paired-contrast fixtures per axis: same regard / different familiarity, same
familiarity / different regard, mask vs no mask. Bar: the blind judge distinguishes
"familiar but hostile" from "stranger but hostile". Multi-character fixtures once
slice 5 exists: an asymmetric-mask pair scene (A warm to B, B performing courtesy
over resentment); an away-mention (the edge colors the gossip without the character
appearing); an alone-player cutaway (the narrator writes the away characters, never
the player's own actions).

## Open questions

- **Band vocabularies**: are the working band names/counts right? Regard keeps 10 of
  today's 11 for romance-ladder granularity; familiarity proposes 5.
- **Rename or not**: keep the `affinity` column/API names meaning "regard", or bite
  the rename bullet in the same change (ripples: reaction pulse, panel, milestones)?
- **Familiarity ratchet source**: archivist-driven (facts/episodes), exchange-count
  driven, or both? And does authored `kind` imply a familiarity floor (a "sibling"
  can't be `strangers`)?
- **`presented` mask**: free text only, or also a coarse enum lean (e.g. `honest` /
  `masks-warmth` / `masks-dislike`) the engine could key off later?
- **Attraction axis**: confirm deferred, and confirm the escalation floor stays
  regard-only until it lands (premise-wins already covers AU intimacy).
- **Quadrant labels**: charming or clutter? (UI-only decision, cheap either way.)
- **Multi-character prompt frame** (slice 5): roster > 1 clearly needs third-person
  narration (the cutaway ruling implies it) — full scene-narrator voice like
  sessions, or an ensemble frame that keeps a focal character's interiority per
  exchange? Affects how much of the shipped chat craft-rule work ports directly.
- **Reaction pulse scope in multi-character chats**: run it for every present
  character each exchange (cost scales with roster), or only for characters the
  player's input addressed/acted toward?
- **Memory retrieval fan-out**: per-character RAG legs per exchange (cost ×
  roster), a shared retrieval over the union of the roster's memory groups, or
  retrieval only for tier-1 (recently active) characters?
- **Away-character drift**: do meters keep decaying on the chat clock while a
  character is away, or freeze until they re-enter? (Pure math either way — pick
  whichever reads better on re-entry.)
- **Library-level default pair edges**: `playerRelationship` is a library default
  the conversation seeds from — should character↔character pairs get the same (a
  default edge authored once for a duo who always appear together, overridable per
  conversation), or is the matrix strictly per-conversation? Rulings say *don't
  hard-code on characters*; a seed-default is weaker than hard-coding but adds an
  authoring surface.
- **NPC↔NPC dynamics static in v2**: confirm the scope cut (archivist facts carry
  evolution; pair pulse/milestones wait for the session refactor).
- **Slice 5 as its own plan**: split the multi-character substrate into its own
  `<topic>.plan.md` + roadmap line when this work is sequenced?
