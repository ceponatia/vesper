# Relationship model v2 — familiarity × regard

Status: active (build started 2026-07-07 — slices 1–4 done: contracts; the
state/schema growth + the `affinity`→`regard` rename and migration 0028; the
composed prompt block + disposition contrast + axis-contrast eval fixtures; the
player-edge UI — record editor with live law preview, state-tools texture, panel
2D plot. Scenario presets still author the single legacy stage and seed through
the bridge — band pickers fold into the matrix slice. Next: the substrate plan
(multi-character-chat.plan.md), then slice 6 (the matrix); scoped,
expanded, and **settled** 2026-07-07, every open question ruled and folded into
its section below. The multi-character substrate this plan's matrix slice
depends on is its own plan:
[multi-character-chat.plan.md](multi-character-chat.plan.md).)

## Problem

The relationship model is one scalar (`affinity` −100..100 →
`contracts/relationships/stages.ts`, eleven ordered stages) that conflates two
independent things:

- **Knowledge** — how well two people know each other (stranger ↔ knows them deeply)
- **Feeling** — how they feel about each other (hostile ↔ devoted)

The conflation is baked into the stage _order_: `acquaintance` (+15..32) sits
numerically above `cool` (−35..−15), so "an acquaintance she's cool toward" is
unrepresentable — and so is enemies-to-lovers, the canonical romance arc, on a
romance-first product. The failing case that motivated this: _"these two have known
each other for 20 years so are quite familiar, but she dislikes him — or at least
pretends to."_ Nothing in `{stage: id}` can say that, and at chat cold-start there
is no history or memory for the narrator to infer it from; the authored state is
all it gets.

## Design sketch

### Two stored axes, headroom for a third

| Axis                    | Motion                                                                             | Bands (working)                                                                                                                             | Governs                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Familiarity**         | slow ratchet (you can't un-know someone)                                           | `strangers → introduced → acquainted → familiar → deeply-known`                                                                             | address rights (first name/nicknames), what can be assumed/referenced, disclosure _ceiling_, how well they read the other |
| **Regard**              | volatile — this is today's `affinity` once familiarity-flavored stages are evicted | today's ladder minus `stranger`/`acquaintance`: `hostile → wary → cool → neutral → friendly → warm → close → cherished → devoted → smitten` | warmth of tone, _desire_ to initiate, patience/benefit of the doubt, escalation floor                                     |
| **Attraction** (future) | —                                                                                  | not built in v2                                                                                                                             | romantic/sexual pull distinct from platonic regard — what enemies-to-lovers actually runs on                              |

Band vocabularies **settled 2026-07-07** (owner): these names/counts are the v2
registries — 10 regard bands, 5 familiarity bands.

Store the per-target relationship as a small **record** (jsonb), not bare columns,
so attraction later is a field addition, not a migration (forward-compatible-schema
preference). The record also carries authored narrative texture that does the
cold-start work:

```ts
{
  familiarity: bandId,          // knowledge axis (also mirrored as a scalar for the ratchet)
  regard: number,               // the affinity scalar, renamed to regard everywhere (ruling in §Dynamics)
  kind?: string,                // the label both would use: "coworkers of 20 years", "her ex-husband"
  history?: string,             // one line of shared past: "he left town without a word; she rebuilt alone"
  presented?: {                 // the mask, when how they PERFORM differs from what they feel
    lean: "masks-warmth" | "masks-dislike",  // enum first (owner ruling 2026-07-07); absent ⇒ honest
    note?: string,              // optional flavor: "icily civil", "syrupy-sweet in public"
  },
  // attraction?: number        // reserved — deferral confirmed 2026-07-07, field addition when it lands
}
```

`presented` covers both directions of "pretends to": `masks-warmth` — performed
disdain over real warmth (tsundere) — and `masks-dislike` — performed courtesy
over contempt (the professional mask). **Ruled 2026-07-07: enum first** so the
engine can key composition off the lean; the optional `note` colors the render;
absent means honest, the overwhelming default. The sessions lane's `perceived`
edge (belief about the other's feeling) is a different concept and stays as-is.

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

- **Openness = min(familiarity ceiling, regard willingness).** "You _could_ finish
  his sentences, but you _won't_ give him anything" — the line one scalar can't say.
- **Address**: familiarity grants the register; regard decides whether it's spoken
  warmly or used as a weapon.
- **Initiative**: familiarity makes initiating _easy_ (no social risk); regard makes
  it _wanted_. Familiar + cold = initiates freely but only transactionally.
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
   disposition tags' existing `warmth` lean seeds _unseeded_ relationships (aloof ⇒
   slightly negative starting regard, sunny ⇒ slightly positive). Where strangers
   start comes from disposition; where specific people are comes from the record.
2. **Disposition styles the expression of regard, never its value.** Stoic + warm
   regard = fondness through acts, not words; sunny + cool regard = cheerfully
   distant. Generalizes `stageDispositionOverlays`, re-keyed to the regard band.
3. **Divergence is stated explicitly — the contrast is the characterization.** When
   regard's sign disagrees with disposition's lean, emit one line: _"You are curt
   with people generally; Mara is one of the few exceptions — around her, the guard
   drops."_ Don't leave the trope for the model to infer from two distant blocks.

### Dynamics

- **Regard**: existing machinery untouched — reaction pulse, milestones, history
  samples. **Rename ruling (2026-07-07, owner delegated): bite the bullet.**
  `affinity` renames to `regard` everywhere in slice 2 — column, API fields,
  pulse, milestones, panel. One concept, one name: keeping the old word invites
  conflation with the single-scalar meaning it no longer has; the sweep is
  mechanical and `pnpm verify` catches every ripple. ⚠ The column rename will
  trip `db:generate`'s interactive rename-vs-create prompt — that step is run by
  the owner (CLAUDE.md rule), not pushed through by an agent.
- **Familiarity**: stored scalar, author-seeded, ratcheted by lived interaction —
  **ruled 2026-07-07: moments + time.** Two fuels: a slow trickle from exchanges
  spent together, **capped at `acquainted`** (time alone never makes you
  `familiar`), plus larger ticks when the archivist records a real disclosure or
  shared experience (fact extraction / episode closes — the note-taker we already
  run). A **per-scene cap** keeps one intense night from taking strangers to
  deeply-known in a single sitting. Never decays (staleness is a non-goal for v2).
- **Kind floor — ruled 2026-07-07: warn, never override.** When the authored
  `kind` and the familiarity band disagree, the authoring UI nudges ("'her
  brother' usually implies at least familiar") but the authored value always
  stands — amnesia and estranged-at-birth stories stay authorable.
- **Milestones** split by axis: regard keeps stage_up/down; familiarity ratchets get
  their own kind ("She let you in").

### UI

- **Authoring** (character Chat tab "Starting Relationship" / cast editor): two band
  selects + `kind` + `history` + `presented`, with a **live one-sentence preview of
  the exact law block the narrator will read** — authors see the render, not an
  abstraction.
- **Matrix visual**: a small 2D plot (familiarity x, regard y), named corner regions
  (_old enemy_, _estranged_, _beloved_, _instant chemistry_); region label replaces
  today's single stage chip (or two chips). **Ruled in (2026-07-07, owner
  delegated)**: the labels stay — they give an at-a-glance read of a 2D position
  that two band words don't, and they live in the same sparse combo table as
  `comboNotes`, so they're data, not code.
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
   relationship is a property of a pair _in a story_ — the same two library
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
- **NPC↔NPC records are static authored texture in v2** (confirmed 2026-07-07) —
  no reaction pulse, no milestones, no familiarity ratchet between NPCs. Evolution
  rides the archivist for free: relationship-kind facts ("Maya no longer trusts
  Rhett") are already extracted and retrieved, so lived shifts reach the narrator
  through memory while the authored record stays the cold-start law. Pair dynamics
  get built once, in the session refactor, for both lanes.
- **Library-level defaults — ruled 2026-07-07.** The character editor gains a
  **Relationships tab**: define default edges once against other library
  characters (and the player — the tab absorbs today's "Starting Relationship"
  control), stored library-side in a `character_relationships` table keyed
  `(from_character_id, to_character_id)` with FK cascade, so deleting a character
  never leaves dangling edges (a table, not a profile field, for exactly that
  reason). Creating a conversation seeds its matrix from these defaults for every
  roster pair; the in-chat matrix menu overrides or adds per-conversation on
  top — the same default-vs-override shape as `playerRelationship` today.

### Multi-character chat substrate → own plan

The matrix needs conversations that hold more than one character. That substrate
is its own plan now (split ruled 2026-07-07):
**[multi-character-chat.plan.md](multi-character-chat.plan.md)** — roster,
per-character state rows, narrative presence + activity recency, the one-block
ensemble prompt frame, player-owns-himself narration authority, referenced-only
reaction pulse, tier-1 memory retrieval, and frozen away-state. This plan's
matrix slice depends on it; the presence × salience tiers below are the
relationship-injection half of that plan's detail budget and stay here.

### What the narrator sees when — presence × salience tiers

The injection problem: naming an absent character in the prompt pressures the
narrator to include them. The rule that defuses it: **edge injection is reactive —
triggered by the transcript, never anticipatory** — so an edge line can't cause the
introduction it colors; by the time the narrator sees it, the fiction already
surfaced the name.

| Tier | Condition                                                                 | What renders                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Present + recently active                                                 | Full identity/state block + full composed pair law blocks for every present pair (character↔player **and** character↔character — escalation floors included, same builder)                                              |
| 2    | Present + quiet (no action/mention for K exchanges)                       | Compressed: one-line state, one-line relationship summaries                                                                                                                                                             |
| 3    | Away + salient (mentioned within the window, or edge flagged **looming**) | A compact conditional edge line — _"If Mara comes up: …"_ — plus the **don't-teleport guard**: _she is not with you; you may show what she's doing where she is, but never merge her into the player's scene uninvited_ |
| 4    | Away + silent                                                             | Nothing. The narrator can't be tempted by what it can't see                                                                                                                                                             |

- **Looming (per-edge, opt-in flag).** For the absent person whose absence _is_ the
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
5. **Multi-character chat substrate** — now its own plan:
   [multi-character-chat.plan.md](multi-character-chat.plan.md) (needs slices 1–3;
   creation groundwork shipped 2026-07-07 — details there). Slice 6 depends on it.
6. **The matrix**: `character_chat_relationships` table, matrix menu (shared cell,
   mirrored stances, asymmetric toggle, live two-direction preview), the character
   editor's library-defaults **Relationships tab** + creation-time seeding,
   reactive + looming injection with the don't-teleport guard.
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

None — every question raised in the 2026-07-07 review is ruled and folded into
its section above: band vocabularies (settled), the `affinity` → `regard` rename
(bite the bullet, §Dynamics), the moments+time familiarity ratchet and the
warn-only kind floor (§Dynamics), the `presented` enum lean (§record sketch),
the attraction axis (deferred, field reserved), quadrant labels (ruled in, §UI),
library-level default edges (Relationships tab, §The matrix), NPC↔NPC dynamics
static in v2 (confirmed, §The matrix). The substrate-side rulings — one-block
ensemble prompt frame, referenced-only reaction pulse, tier-1 memory retrieval,
away-state freeze — are recorded in
[multi-character-chat.plan.md](multi-character-chat.plan.md).
