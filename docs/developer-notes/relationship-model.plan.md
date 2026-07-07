# Relationship model v2 — familiarity × regard

Status: draft (scoped 2026-07-07 from an owner design conversation; not settled —
open questions below need rulings before this becomes buildable slices)

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

## Slices (rough)

1. **Contracts**: familiarity + regard band registries, composed law builder,
   old-stage → (familiarity, regard) mapping table, comboNotes seam. Pure + tested.
2. **State & authoring schema**: `character_chat_state` grows the record (jsonb +
   familiarity scalar); `profile.playerRelationship` grows from `{stage, note}` to
   the record shape (self-healing `.catch`es; old `stage` maps via the table).
3. **Prompt**: law-block rewrite + disposition-contrast line + skip-note re-key;
   eval fixtures (below).
4. **UI**: authoring control + preview, state tools, relationship panel 2D.
5. **(Later) Sessions lane**: `participant_relationships` + authored cast edges gain
   the record; bond classifier's mutual-bond keywords map to familiarity defaults.

**Eval tie-in**: the enactment measurement harness (top of Next) is the instrument —
add paired-contrast fixtures per axis: same regard / different familiarity, same
familiarity / different regard, mask vs no mask. Bar: the blind judge distinguishes
"familiar but hostile" from "stranger but hostile".

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
