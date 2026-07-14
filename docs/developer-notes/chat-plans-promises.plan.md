# Chat plans & promises — commitments that come due

Status: **next** (planned 2026-07-14, from the world-sim carry-forward review —
the chat descendant of the retired `scheduled-arrivals.spec.md`. The spec gets
written when this goes active; this plan records the design intent and rulings
needed before then.)

## Goal

Characters constantly strike commitments in the fiction — "come over Friday,"
"I'll text you after my shift," "dinner at the pier at sunset" — and today the
app forgets them the moment they're said. The closest thing we track is the
archivist's `open_loops` (≤3 fuzzy "unfinished business" phrases), which has no
who/when and never comes **due**.

Build a tracked **plans** system:

- the archivist recognizes a plan when the fiction strikes, changes, or cancels
  one;
- the engine stores it with a rough *when* on the story clock;
- the narrator is told when a plan is imminent / happening now / just missed —
  and nothing more (no standing list dumped every turn);
- keeping or breaking it lands on the relationship through machinery that
  already exists (the pulse + emotional weather's bruise, milestones, the hub's
  "has something to say", the reopen opener).

Why this is the right next chat feature:

- **It's the romance genre's beat structure.** Dates and promises are what an
  arc *is made of*; a character who remembers the date you made — and is hurt
  when you skip past it — is the single most life-like behavior we can add.
- **It gives time skips teeth.** Skipping time is currently cosmetic; with
  plans, skipping past Friday *means* something.
- **Test-bed value** (`CLAUDE.md` direction): it rehearses the core world-sim
  pattern on the lane that will survive — *the story makes a commitment → the
  system records it deterministically → time makes it come due → the narration
  honors it*. This is scheduled-arrivals reborn without the location model.

## Shape (sketch — the spec owns the final schema)

A new chat-wide list on the scenario (plans belong to the CONVERSATION, like
`scene_memory` and `supporting_cast`): `contracts/turns/chat-plans.ts`,
`ChatPlan { id, what, participants[], where?, when?, status, struckAtMinutes }`
with hard caps and `parseOr` degraded-empty at the load boundary.

- **`participants`** — names, drawn from: the player, roster members, and
  supporting-cast members. A plan may omit the player entirely (an NPC↔NPC
  plan — see §Ensemble below).
- **`when`** — coarse on purpose, keyed to `clock_minutes` (never the wall
  clock — D3/D8 hold): an exact story-clock target, or a day-offset + day-part
  ("tomorrow evening", reusing the schedule authoring's day-part vocabulary),
  or **unscheduled** ("sometime", "soon") — unscheduled plans never go missed;
  they linger as intentions and eventually age out.
- **`status`** — `upcoming | kept | missed | canceled` stored; *imminent* and
  *due now* are *derived*, pure, at prompt-build time from `when` vs the
  clock (a time skip is the main mover; the derivation composes with the
  one-shot `pending_skip_note` — "you skipped past Friday's dinner").

## Build slices

### Slice 1 — substrate (recognize, store, surface)

- The contracts module + the scenario column (jsonb; migration).
- A new extraction field `plans`: propose new plans / status changes **only
  from what the fiction established** (both input registers count —
  storyteller-authored narrator-input plans are canon). Merge accrete + update
  by id/normalized `what`; caps; degraded proposal = no-op. Prompt guidance:
  a concrete commitment (who + roughly when) files as a **plan**; `open_loops`
  keeps only fuzzy unfinished business — never both for the same beat.
  **Landing (updated 2026-07-14):** [chat-agent-improvements.plan.md](chat-agent-improvements.plan.md)
  shipped, so this is **one new field module** in
  `server/engine/prompts/chat-extractors.ts` (instruction + context block + rules
  + example value + `armed`), added to the **character tracker** leg's key list —
  commitments are that leg's business, and it already carries `openLoops`, so the
  plan-vs-loop distinction lives in one sheet. Its schema is one field on
  `chatArchivistSchema` (the legs are `pick`s of it, so the leg schema follows for
  free), and its fold goes beside the others in `finalizeChatState`. No new agent
  call, no monolith surgery.
- The pure due-ness derivation + a compact volatile-tail **Plans** block (both
  frames): only what matters this turn — due/imminent/just-missed plus at most
  a couple of upcoming — with directives per state (anticipation before, the
  event when due, the fallout when just missed). Silent when nothing is near.

### Slice 2 — consequences & initiative

- **The pulse sees it**: just-missed plans reach the reaction pulse's context
  so a stood-up character's feeling proposal is informed (`hurt`, cause = the
  plan); the existing curve + bruise machinery does the rest. Kept plans are
  warm material the same way. (Lean: consequences stay **model-mediated** via
  the pulse — no deterministic regard penalty; see Open question C.)
- **Milestones**: a kept or missed significant plan can mint a milestone (see
  Open question D for kind naming) — callback-boosted like `secret_shared`, so
  "remember our first real date" emerges for free from the callback system.
- **Hub + opener**: the "has something to say" derivation gains plan reasons
  (an imminent or just-missed plan outranks open loops); `buildInitiativeCue`
  gets open plans as first-class material ("is tonight still on?" / the cold
  open after being stood up, worded by regard band as usual).

### Slice 3 — ensemble & supporting cast (see §Ensemble)

- Participants resolved against roster + supporting cast; group plans.
- The **arrival license**: a due plan involving an *away* roster member makes
  them salient with an explicit narrated-arrival license (the plan IS the
  reason they show up) — the presence law's don't-teleport guard gets its one
  principled exception. Symmetrically, a due plan *not* involving the player
  licenses a present member's exit ("her shift starts").
- NPC↔NPC plans tracked and resolved (default + meanwhile-pass hook — see
  Open question E and the sibling plan).

### Slice 4 — UI

- A compact **Plans** card in the desktop aside / Roster sheet (below
  Supporting Cast): open plans with status glyphs, "+ Add plan," a lightbox
  editor (what/who/when/status + Remove) for manual seeding and corrections —
  author-curated like the supporting cast; saves via the chat-wide
  `ChatStateEdit` half; 409 `chat_busy` while a reply streams.

## Ensemble & supporting cast (the NPC-management angle)

Plans are the first system where the cast's *own* social lives get structure:

- **Group plans** — a plan lists any mix of player, roster members, and
  supporting cast ("dinner with Nyx and her sister Mira"). Due-ness and the
  narrator directives are shared; **consequences are per-character** — each
  stood-up participant reacts through their own state row (their own pulse,
  feeling, milestone), so skipping a group dinner can bruise two relationships
  differently depending on each regard.
- **Arrivals and exits become motivated** — presence transitions stop being
  purely player-narrated: the fiction's own commitments pull people into and
  out of the scene, which is exactly the texture "the world moves" was after.
- **NPC↔NPC plans** — plans that don't include the player ("Nyx and Kira are
  going shopping Saturday") are tracked the same. When the player skips past
  one, it resolves off-screen and becomes conversation material and an
  archivist **relationship fact** between the pair (the shipped v2 pattern:
  lived shifts reach the narrator through facts; the matrix stays authored).
  With [chat-offscreen-life.plan.md](chat-offscreen-life.plan.md)'s meanwhile
  pass shipped, that pass decides how the unwitnessed plan went; before it,
  a default applies (Open question E).
- **Supporting cast participate** — a cast member in a plan's participants
  ties into their `whereabouts`/details accretion, giving minor characters
  scheduled comings and goings without ever becoming roster entities.

## Open questions

- **A. `when` representation** — exact clock target vs day-offset + day-part
  vs both; how a day-part window converts to a due/missed boundary in minutes.
- **B. Rollback semantics** — ride the `pre_exchange_scenario` snapshot like
  `scene_memory` (a regenerated reply that minted a plan must not double-mint)
  vs accrete-exempt like `supporting_cast`. Lean: **snapshot** — plans are
  fiction state, not author curation.
- **C. Consequence mediation** — pulse-mediated only (lean: the model sees the
  miss and the curve moves feelings; ambiguous misses stay ambiguous) vs a
  deterministic regard penalty on `missed` (predictable but misfire-prone).
- **D. Milestone kinds** — new `plan_kept` / `plan_missed` kinds (clearer
  panel glyphs, callback boosting) vs riding `strong_reaction`. Lean: new
  kinds — the list is designed to grow.
- **E. Unwitnessed-plan default** — an NPC↔NPC plan skipped past with no
  meanwhile pass: assume kept unless the fiction later says otherwise (lean),
  or leave unresolved until referenced.
- **F. Caps & history** — open-plan cap (~8?), and whether resolved plans keep
  a short ring (useful callback material) or convert to ordinary
  facts/episodes and leave the list.

## Not in scope

- **Real time / push.** Nothing reads the wall clock and nothing generates in
  the background (D3/D8 stand). A plan comes due when the *story* clock
  reaches it, and the character speaks of it when the *player* next acts.
- **Session-lane port** — the pattern is being proven here; the successor
  model inherits it.
- **A calendar UI** — the Plans card is a light list, not a scheduling
  surface.

## Docs to update when implementing

`character-chat/state.md` (the plans list + due-ness), `character-chat/pipeline.md`
(archivist field, pulse context), `character-chat/initiative.md` (plan reasons
in the marker + opener), `character-chat/multi-character.md` (arrival/exit
licenses, NPC↔NPC plans), `prompts.md` (the Plans block), `character-chat/api.md`
(ChatStateEdit + panel saves).
