# The affordance read and its cues

What the lane can honestly say about how a body currently looks and moves, derived from the
committed state in [body-state.md](body-state.md) and the wardrobe in
[wardrobe.md](wardrobe.md). The read is a pure function of that committed state plus its own
cue memory; the narrator-facing half is one attention-only prompt block.

## Cue memory

**`character_chats.affordance_cues`** (`AffordanceCueState`): what the affordance read
has already offered the narrator, and in which band — the garment `cues` precedent. It
sits on the SCENARIO because the read is a pure function of committed state plus this
memory (`engine/chat-affordances.ts` `buildChatAffordanceRead`), so restoring both from
one anchor is what makes a retake reproduce the identical read rather than resolving
against later weather. Written when the read reaches the prompt; with the narration flag
off it rides through untouched (never cleared).

## Narration

Behind `CHAT_AFFORDANCE_CUES` (default off):
the pipeline takes the read from the committed **pre-fan-out** cut — the drifted state
row, the ticked scenario, and the wardrobe rows that turn already resolved — and projects
`read.cues` into at most two short factual clauses ("Wren's auburn hair has separated into
damp, clinging strands, still wet from the rain") via `engine/chat-affordance-cues.ts`.
They render as one **attention-only** prompt block after the garment cue block; there is
deliberately no affordance digest, because the appearance they decorate is already
authoritative in the Attributes section. Cue projection is the one place `hair.color` is
read — it is excluded from the domain's required attributes so it can never move a band.
The block is primary-character-only (it leans on the one Attributes section this prompt
carries), and `previewChatPrompt` re-derives it read-only, so opening the inspector never
spends the repeat gate. With the flag off nothing is computed at all and the prompt is
byte-identical (int-tested by splicing the ON block back out).

## What the adapter answers and what it refuses

The adapter reports what this lane can honestly answer and refuses the rest:
arrangement/wetness/coverage/wind are owned, while **contact, body motion and
contamination are `unavailable`** — so hair-to-skin adhesion is suppressed by the shared
core before its resolver can read an empty contact list as "nothing is touching", and no
impulse event is ever synthesized. Unknown coverage (no wardrobe read at all) fails
closed: the whole hair read goes silent rather than assuming an uncovered head.

**Coverage constrains what moves; perception only says what an eye reaches.** Worn
headwear maps the `hair` location to exposure `hinted` — opaque *or* sheer — because the
wardrobe's per-location coverage is already partial (`coveredFraction` 0.9 for an opaque
cover, precisely because ends and fringe hang out) and an ordinary hat, cap or hood
genuinely leaves some of the location readable. Mapping opaque to `hidden` would have the
two layers contradicting each other and would suppress *every* hair observation under a
hat, including ones coverage does not damp. Genuinely total concealment (a wrapped
headscarf, a hijab) is a finer signal than the per-location boolean, and the wardrobe
input carries it: the resolved hair-occlusion band beside the coverage rows
(`ChatAffordanceWardrobe.hairOcclusion`,
[../contracts/items/README.md](../contracts/items/README.md) §Hair occlusion). At `full`
the read is `hidden` at `coveredFraction` 1, whatever the outermost row's opacity, and
every hair observation is suppressed with `affordance.perception.hidden` — no hair
affordance cue and no hair visual detail reaches the narrator, and the physical-guidance
coverage fence sees an enclosed head. `partial`, `none` and an absent band leave the
opacity mapping above in force; the gate itself fails closed for an unlisted location
(`unknown`).

## The garment domain

The garment domain rides the same adapter and the same flag. Its wardrobe
normalization lives in `engine/chat-garment-affordances.ts`: worn garment instances, their
blueprint snapshots' materials, presentation-aware per-part coverage, and the condition
gradient's wetness — integrated forward to the story clock *lazily and without writing
back*, so building a prompt can never dry a garment. It answers three reads —
material-dependent wet surface behavior, effective opacity, and wet cling — and refuses the
rest honestly:

- **`contacts` is omitted entirely**, because no lane records garment *fit* and the ruled
  establishment law only lets a `fitted`/`tight` garment claim body contact from wardrobe
  truth. Wet cling is therefore suppressed by the core with `affordance.input.unavailable`,
  exactly as hair adhesion is.
- **`focus` is omitted**, so the domain's closed default blocks every intimate cue
  (`intimate_gated`); the chat lane has no narrative-focus or consent owner.
- An **unmodelled** wardrobe means the domain is not run at all — unknown coverage, never a
  bare body.

The read also produces the final **effective-coverage read** (opaque/hinted/exposed per body
location, with contributing garment evidence), and that answer is **captured** onto
`ChatGarmentStore.coverage` rather than recomputed by each consumer — so it rides
`pre_exchange_scenario` with the garments it describes and a retake restores both or
neither. See [../contracts/items/visibility.md](../contracts/items/visibility.md) §Effective coverage.

## Two narrator cue blocks, one boundary

`CHAT_GARMENT_CUES` owns garment *state and its
changes* (a placket that came open, a rolled sleeve, the condition band, mud, a tear);
`CHAT_AFFORDANCE_CUES` owns the current derived *visual effect* of that state (water beading
or darkening, opacity, cling). They overlap only at garment wetness, so with both flags on
the pipeline passes the garment ids the wardrobe block already spoke about and the affordance
projection drops its surface line for them.

## The developer preview

`/chat/:id/inspector` (admin-only) shows the whole staircase
read-only — source inputs → structural profile → mechanics → observations or suppression
reason → perception filtering → selected cue, per domain — computed on demand from the
stored cut and storing nothing (`engine/chat-affordance-preview.ts`; it never persists
`nextCues`, so looking cannot spend the repeat gate). It deliberately ignores the feature
flag and reports its state instead: the question it exists to answer is "why did this cut
say nothing?", which matters most while the flag is off. It does not cover the recognition
line in [visual-memory.md](visual-memory.md).
