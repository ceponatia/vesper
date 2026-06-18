# Dynamic character introduction (emergent cast) — spec

Status: **draft for discussion** — nothing here is implemented. Companion doc:
[dynamic-character-introduction-brainstorm.phase3.md](dynamic-character-introduction-brainstorm.phase3.md)
(alternatives considered, open questions).

> **Implementation status (2026-06-12).** Phase 0
> (identity-conditioned ranges) is scheduled in
> [phase-2-plan.md](phase-2-plan.md) T11 — treat it as done when
> implementing phases 1–3 here. Relevant groundwork that already
> exists: `fillCoreVisualDefaults` (FNV-1a seeded, currently the
> uniform full-vocabulary pick this spec's phase 0 replaces) shipped
> with the working-phase-1 forge work. Phases 1–3 (provisional cast,
> async enrichment, polish) are not started.

## Problem

The narrator can already write anyone into a scene — a barmaid, a guard, the
innkeeper the player just addressed — but the world model never catches up.
The new character has no `session_participants` row, so:

- dialogue tagging can't attribute their speech (`[Name]` must match the
  present-NPC list);
- simulant events that reference them are dropped by the merge
  (`merge.participant.unresolved`);
- facts about them never ground to a `subject_id`;
- they have no wardrobe, meters, conditions, location, or follow score;
- they silently evaporate between scenes.

Goal: when play introduces a character, the state system adopts them — with a
lightweight sketch immediately, and a fully forged character a turn or two
later — without blocking or slowing the turn that introduced them.

## Design summary

```
turn N   narration introduces "Nessa, the harbor-watch sergeant"
         └─ director emits castSignals.introduce: [{ name, conceptNote, role }]
         └─ merge: gates pass → INSERT provisional session_participants row
                   + enqueue character_forge job (session-less, slow lane)
turn N+1 prompt renders Nessa from her provisional snapshot (sketch bio,
         empty attributes — sparse-is-correct); she tags dialogue, grounds
         simulant events, accrues facts like any participant
async    character_forge runs the existing forge with play-derived canon as
         hard constraints → enqueues adopt_cast_member (session queue, fast)
         → fill-empty-only merge into the participant snapshot + worn items
turn N+2 prompt renders the enriched snapshot — same code path as every
         other participant; nothing "swaps", a column got richer
```

The key deviation from the original sketch ("temporary context description,
then swap"): the interim representation is a **real provisional participant
row**, not a context blob. The provisional row makes the interim turns fully
functional (tagging, grounding, facts, movement), and the upgrade becomes a
snapshot enrichment instead of a context-assembly special case. Prompt
assembly needs almost no changes — it already renders participants from
snapshots, and a sparse snapshot is already a legal snapshot. Precedent:
`session_locations.emergent` already models exactly this for places.

## Detection: director `castSignals`

Mirror `threadSignals` on the director schema (single new field, no new
agent — see brainstorm §Detection for the alternatives):

```ts
castSignals: {
  introduce: [{
    name: string,            // display name as written in the narration
    conceptNote: string,     // 1–3 sentences: who they are, appearance/manner
                             //   AS ESTABLISHED BY THE NARRATION — no invention
    role: "npc",             // companions only via authoring, for now
    locationName?: string,   // defaults to the scene location
  }],
}
```

Director prompt addition (keep within the ~600-token agent budget): signal an
introduction only when the character is **named or directly interacted with**
and **plausibly recurring** — never for crowd texture ("dockworkers haul
crates"). The conceptNote must restate what the narration established, not
embellish.

Degraded default: `castSignals: { introduce: [] }` — folded into the existing
director fallback (previous brief carried forward ⇒ no introductions, which
is the safe direction).

### Merge gates (deterministic, in `engine/merge.ts`)

Every gate failure is a diagnostic + dropped signal, never an error:

1. **Dedup against participants**: case-insensitive display-name match, then
   alias match against snapshots, then `fuzzyResolveName` against participant
   names. Match ⇒ drop (`merge.cast.duplicate`).
2. **Dedup against the owner's library + world cast**: an exact/alias name
   match to a library character that belongs to this world's cast but wasn't
   materialized should never happen (spawn materializes all cast) — but a
   match against the *library at large* is a genuine "did you mean" case;
   v1 drops with a diagnostic naming the library row (see brainstorm §Library
   adoption for the richer option).
3. **Caps**: at most `MAX_INTRODUCTIONS_PER_TURN` (1) per turn and
   `MAX_EMERGENT_PARTICIPANTS` (12) per session (`engine/constants.ts`).
4. **Name hygiene**: run through the existing `uniqueName` discipline used at
   spawn.

## The provisional participant

Inserted inside the merge's single transaction (step 6½, after facts —
so this turn's facts about them ground next turn, not retroactively):

| Column | Value |
| --- | --- |
| `character_id` | `null` (already nullable — session-only identity) |
| `is_user` | false |
| `display_name` | from the signal, uniqued |
| `role` | `"npc"` |
| `snapshot` | `emptyCharacterProfile()` + `bio: conceptNote`, no attributes |
| `state` | `spawnParticipantState(style)` + `emergent` block (below) |
| `location_id` | resolved `locationName` (fuzzy) ?? scene location |
| `avatar_image_id` | `null` |

No schema migration: provenance lives in `ParticipantState` (contracts are
the extension point):

```ts
// contracts/state/participant-state.ts — optional, defaulted, parseOr-safe
emergent: z.object({
  status: z.enum(["provisional", "enriched", "failed"]),
  introducedAtTurn: z.number().int(),
  forgeJobId: z.string().optional(),
}).optional(),
```

Absent `emergent` ⇒ spawned-from-cast participant; old rows parse unchanged.

### What the prompt shows meanwhile

Nothing new is built — the existing machinery renders the sparse snapshot:

- **Static rulebook** canonical-facts block: name + bio (the conceptNote).
  Empty attributes render nothing (sparse-is-correct, same as a forged
  character whose non-core attributes were omitted). Note: inserting the
  participant changes the rulebook bytes ⇒ one prefix-cache miss. Accepted;
  it happens once per introduction.
- **Glance impressions**: first-encounter full impression fires via
  `runtime.encounteredParticipantIds` as usual; the renderer must tolerate an
  attribute-less profile (verify — likely already does, same sparse case).
- **Wardrobe visibility block**: zero worn instances. Add one provisional
  line — `"<Name>: clothing not yet tracked; stay consistent with prior
  narration"` — so the sole-authority rule doesn't read as "naked".
  This is the only prompt-side change of substance.

## The forge job (slow lane)

New job type `character_forge`, enqueued **without** `session_id` so it runs
off the per-session serial queue and never delays a turn (same lane as
`avatar`/`embed_refresh`). Payload: `{ sessionId, participantId, conceptNote,
introducedAtTurn }`.

The job:

1. Loads **canon**: the introducing turn's narration (and the turns since),
   all facts with `subject_id = participantId` (or matching `subject_name`),
   world `style` + `always`-tier lore + any lore chunks naming them, the
   location description, and the current provisional snapshot.
2. Calls `forgeCharacter` with a new optional `canon` field on
   `ForgeCharacterInput`; each section prompt gets a block:
   `"Established in play — treat as hard constraints, do not contradict:"`.
   `useFallbacks: false` (persisted without human review — same rule as
   world-save cast generation). Outfit suggestions must describe what the
   narration showed them wearing, matched against the library as usual.
   Core visuals the narration never stated fill through the
   identity-conditioned range mechanism (next section), not the blind
   seeded pick — the narration-derived identity anchors (heritage, age,
   gender, species) are exactly the inputs the range derivation wants.
3. Embeds nothing itself; enqueues `adopt_cast_member` **with** `session_id`
   (fast lane, serialized with merges) carrying the draft.

A forge failure marks `state.emergent.status = "failed"` + diagnostic and
stops. The provisional snapshot is valid indefinitely — degraded default,
not an error state. Retry = re-enqueue (idempotent; see below). Demo mode:
skip the forge entirely; provisional is the terminal state.

## Attribute derivation: identity-conditioned ranges

This piece is a **general forge upgrade**, not emergent-cast-specific — it
ships independently, improves the authoring-time character forge on its own,
and the emergent forge job simply inherits it. It replaces the failure mode
that motivated "no attribute seeding for provisionals": today, any core
visual the model leaves unset gets a **uniform** seeded pick from the full
`allowedValues` list (`fillCoreVisualDefaults`) — which is how a character
described as Latina can roll platinum-blonde hair.

### Design: derive ranges, then pick

Today's two tiers (model best-guess → blind seeded default) become three:

1. **Definite values** — unchanged: where the text states or strongly
   implies a value, the attribute agent emits it directly.
2. **Plausible ranges (new)** — for each `[CORE]` enum attribute it cannot
   pin down, the agent emits a *subset* of `allowedValues` that is plausible
   given the **identity anchors** it inferred from the text — heritage,
   apparent age, gender, species presentation (e.g. Latina ⇒
   `hair.color ∈ {brown, dark_brown, black}`; `sixties_plus` constrains
   apparent-age-correlated attributes). One schema field on the existing
   attribute section call — no second LLM call:

   ```ts
   ranges: [{ id: AttributeId, plausible: string[] }]   // ⊆ allowedValues
   ```

   Grounding (in `groundAttributeValues`' spirit): unknown ids and
   out-of-vocabulary members drop with a diagnostic
   (`forge.character.attributes.invalid_range_member`); an emptied range
   drops entirely.
3. **Seeded pick from the range** — `fillCoreVisualDefaults` keeps its exact
   mechanism (FNV-1a over `concept::attributeId`, deterministic, same input
   ⇒ same draft) but draws from the attribute's surviving range instead of
   the full vocabulary. No range for an unset core visual ⇒ today's
   full-vocabulary pick, with a diagnostic noting the unconstrained fall-through.

The model narrows; the seed decides. Plausibility comes from the model
(which read the text), variety and determinism stay with the seeded pick
(an LLM asked to "pick randomly" converges on brown/brown — the comment on
`fillCoreVisualDefaults` already records this).

### Identity anchors

The anchors are ordinary registry attributes, marked with a new optional
flag (`identityAnchor: true` on `attributeDefinitionSchema`) so the
attribute prompt can tell the model "infer these first; condition the
ranges on them". `identity.gender`, `identity.apparent_age`, and
`identity.species_presentation` exist; the heritage axis the user example
implies does not yet — add `identity.heritage` (free text, not enum:
real-world ethnicities and fantasy ancestries can't share a closed list;
see brainstorm §Heritage attribute). Registry edits only — no migration,
per the extension-point rule.

### Scaling with vocabulary expansion

The attribute vocabulary will grow substantially (much finer-grained
physical values). Ranges scale with it automatically: the model sees the
live `allowedValues` in every forge call, so a richer vocabulary yields
richer ranges with zero curated data to maintain — this is the main reason
ranges live in the model rather than in registry prior-tables (the
alternative is weighed in brainstorm §Where the priors live). Watch the
attribute prompt's token size as the vocabulary grows; if it gets heavy,
the range step is the natural place to split into its own call.

### Guardrail: physical plausibility only

Identity anchors may constrain **physical** attributes only — coloring,
features, build. Heritage must never feed personality, voice, behavior, or
role suggestions; ranges are soft priors that explicit text always
overrides ("a Latina with dyed silver hair" ⇒ definite value, no range);
and when the identity signal is weak the model is instructed to emit wide
ranges or none. These rules go in `ATTRIBUTES_SYSTEM` verbatim and the
worked examples should include a text-overrides-prior case.

## Adoption (fast lane, session queue)

`adopt_cast_member` runs between turns by construction (serial session
queue), so it cannot interleave with a merge. One transaction:

1. **Fill-empty-only snapshot merge** — deterministic, unit-testable, the
   same spirit as the merge reducer: a forge value lands only where the
   current snapshot field is empty. Play-derived data (the conceptNote bio,
   any attribute the simulant set via `attributeChanges` during the interim
   turns) always wins over forge invention. Exception: a forge `bio` may
   *append* to the conceptNote (it elaborates; it doesn't replace evidence).
2. **Worn item instances** from the outfit suggestions — only if the
   participant currently has zero worn instances (an interim turn may have
   dressed them via simulant events; if so, play won, skip). Placement CHECK
   constraints apply as everywhere.
3. `state.emergent.status = "enriched"`; diagnostics persisted on the job.

Idempotency: re-running adoption is a no-op (fill-empty against an enriched
snapshot fills nothing; worn-instances guard already trips).

The next turn's pre-turn assembly reads the enriched snapshot through the
normal path. There is no "drop the temporary context" step — the temporary
context *was* the snapshot, and it just got richer. Second (and final)
rulebook cache miss here.

## Edge cases

- **Rerun/edit of the introducing turn**: turn effects on participants are
  not reversed today (movements aren't either) — the emergent participant
  survives, consistent with existing semantics. If the re-narration never
  mentions them, they're an idle NPC; the session UI offers removal
  (phase 3). Facts about them retract/re-extract via the existing reconcile.
- **Restart**: re-materializes from the world ⇒ emergent participants vanish.
  Correct — restart is defined as a fresh spawn.
- **Forge completes mid-turn**: impossible to interleave — adoption is a
  session-queue job; the LLM-slow `character_forge` job touches no session
  state itself.
- **Player addresses an unnamed role** ("I ask the innkeeper for a room"):
  the narrator names/voices them; the director signals on the same turn if
  warranted. No special path.
- **Lore-anchored names** (narration introduces "Captain Mara" from lore):
  canon loading (forge step 1) pulls lore chunks naming her, so the forge is
  constrained by authored material. Detection/dedup is unchanged — lore
  characters have no participant row until introduced.

## Constants (engine/constants.ts)

```
MAX_INTRODUCTIONS_PER_TURN = 1
MAX_EMERGENT_PARTICIPANTS  = 12
```

## Testing

- **Pure**: castSignals schema + degraded default; merge gates (dup names,
  aliases, fuzzy, caps — each asserts the diagnostic code); fill-empty-only
  snapshot merge (forge never overwrites play data; bio appends); adoption
  idempotency; range grounding (out-of-vocabulary members dropped with
  diagnostic, emptied range dropped); range-constrained
  `fillCoreVisualDefaults` (pick ∈ range; same seed text ⇒ same pick;
  missing range falls through to full vocabulary + diagnostic; definite
  value beats range for the same id).
- **Integration**: introduce → provisional row exists with correct
  location/state → forge job → adopt job → enriched snapshot + worn
  instances; forge failure → `status: "failed"` + provisional snapshot still
  renders; restart wipes emergent participants; rerun keeps them.
- **Degradation tests assert fallback and diagnostic code** (resilience.md).

## Phasing

0. **Identity-conditioned ranges** — independent forge upgrade
   (`identity.heritage` + `identityAnchor` registry edits, range field on
   the attribute section, range-aware `fillCoreVisualDefaults`).
   *Shippable alone*, before any of the below: it fixes the
   implausible-defaults problem for the authoring forge today, and phase 2
   inherits it.
1. **Provisional cast** — director signal, merge gates, provisional row,
   wardrobe placeholder line. *Shippable alone*: named NPCs stop evaporating
   even before any forge runs.
2. **Async enrichment** — canon-constrained forge job + adoption job.
3. **Polish** — session-UI provenance badge ("sketch"), manual
   re-forge/remove actions, avatar generation for emergent NPCs,
   promote-to-library (see brainstorm).

Docs to update when implementing: `turn-engine.md` (lifecycle, merge order,
job types), `prompts.md` (wardrobe placeholder), `contracts.md`
(ParticipantState, `identityAnchor` flag, heritage attribute),
`authoring.md` (forge `canon` input, range-fill tiers), `memory.md` only if
fact grounding changes.
