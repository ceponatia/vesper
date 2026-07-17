# Chat off-screen life — the cast moves between visits

Status: **shipped — 2026-07-15** (planned 2026-07-14, from the world-sim
carry-forward review; built the day after both prerequisites —
[chat-plans-promises.plan.md](chat-plans-promises.plan.md) and
[chat-clock-calendar.plan.md](chat-clock-calendar.plan.md) — landed. Rulings A–F
+ the settled build shape (including the one deliberate deviation from the §2
build note: the pass is a sibling module in the field library's *style*, not a
literal library leg — the library is single-subject) are in
[chat-offscreen-life.spec.md](chat-offscreen-life.spec.md). What shipped: the
`chat-meanwhile` contract + pure folds; the detached `chat_meanwhile` job at
qualifying skips (cumulative ≥1-day gate, marker-CAS idempotency, skip-note
guard); per-member fact routing to involved members' own memory groups;
`whereabouts` (column, presence-read `where`, meanwhile refresh, away/salient
rendering, one-turn return license); supporting-cast whereabouts accretion;
NPC↔NPC plan outcomes replacing ruling E's default; the one-shot meanwhile note
composing with the skip note; grounded skip-note/opener material + the rhythm
line in ordinary turns; migration 0050. **Leftovers:** none structural — the
session lane and cast promotion stay out of scope as planned.)

## Goal

When the player reopens a conversation, the opener's "a life meanwhile" license
already invites ONE small concrete thing from the character's life since — but
it is improvised fresh each time, connected to nothing, and exists only for the
primary on the opener path. Away roster members freeze (by design) and return
with no account of themselves; supporting cast have a `whereabouts` field but
no life.

Make off-screen time **grounded, persistent, and ensemble-wide**:

- what happened off-screen draws on what the story already knows — daily
  rhythm, drives, supporting cast, open plans — instead of free invention;
- what a character says happened **sticks** (facts) and can **develop** (the
  audition she mentioned gets a result);
- a big time skip advances the whole cast's lives a notch — including
  **NPC↔NPC interactions** — so returning after "two weeks" feels like two
  weeks, and the ensemble reads as people who kept existing.

This is the second half of the world-sim carry-forward: plans & promises makes
commitments come due; this plan makes the *rest* of off-screen life real.

## Design

### 1. Grounded meanwhile material (prompt plumbing, no new model calls)

The initiative cue's life-meanwhile license currently grounds on the
daily-rhythm line alone; the `pending_skip_note` path on ordinary exchanges
grounds on even less — `chatSkipNote` licenses its meanwhile line against
nothing but "the scenario and your personality" (`formatScheduleRhythm` feeds
only the initiative cue today).
Feed them the rest of what's already tracked: active non-secret drives (her
projects ARE her life), the supporting cast list (names + relations +
whereabouts — the sister is who she'd have seen), and open plans. Improvised
life beats then attach to established story instead of minting strangers, and
the archivist's existing extraction persists them as facts for free.

### 2. The meanwhile pass (one small model call at big skips)

When a time skip crosses a threshold (deterministic gate — e.g. ≥ one story
day), run **one** archivist-class agent over the whole ensemble: given each
member's rhythm, drives, whereabouts, the supporting cast, the relationship
matrix pairs, and open plans (fenced, so it builds on canon instead of
contradicting it), propose **1–3 concrete off-screen developments** total:

_Build note (updated 2026-07-14, after [chat-agent-improvements.plan.md](chat-agent-improvements.plan.md)
shipped): the meanwhile pass is **another leg composed from the extraction field
library** (`server/engine/prompts/chat-extractors.ts`) — a `meanwhile` leg whose
key list reuses the existing `facts` / `driveUpdates` / `cast` modules (plus the
`plans` module that landed with plans & promises) with a different role sentence and
its own context blocks. The folds it needs (`addFacts`, `applyDriveUpdates`,
`mergeSupportingCast`) already exist and are already shared. Do NOT hand-write a
fourth extractor prompt._

- a member's life beat consistent with her rhythm ("closed the café alone
  Tuesday; the espresso machine died");
- a **drive progress notch** ("heard back about the commission");
- a supporting-cast beat (detail/whereabouts accretion — "Mira started her
  new job");
- an **NPC↔NPC interaction** (see §Ensemble) filed as a relationship fact;
- an outcome for a plan **not involving the player** (kept/missed — the
  plans list updates).

Everything folds deterministically into existing sinks: facts to the
witnesses' memory groups, `driveUpdates`-shaped progress, `mergeSupportingCast`
accretion, plan status updates. The narrator gets a **one-shot meanwhile
note** composing with the pending skip note — one line of texture, never an
exposition dump; the rest waits in memory for retrieval. Degrades to nothing
(an ordinary skip) on failure, with a diagnostic.

**D3-safe by construction**: the pass runs only at a player-triggered moment
(the skip), never on a timer, and never reads the wall clock. Lean placement:
a detached job at skip time (the `chat_scene_sketch` pattern — CAS write,
never able to 409 a send), with the next exchange proceeding on grounded
improvisation if the job hasn't landed.

### 3. Whereabouts & returning with a life

- Away roster members get a light **whereabouts** note (state row), maintained
  by the archivist's presence read and the meanwhile pass ("away — at her
  studio finishing the commission"). The ensemble prompt's away/salient lines
  render it, so "where is everyone" stops being narrator guesswork — the
  background-NPC management seam without a location model.
- A presence transition back to **present** grounds the return: the member's
  rhythm, whereabouts, and any meanwhile developments ride the volatile tail
  for that turn, licensing "just came from" texture and making the return a
  beat instead of an apparition.

### 4. Rhythm in ordinary turns (the small garnish)

`formatScheduleRhythm` currently renders only in the initiative cue. Give
ordinary exchanges one compact rhythm line per present member (and it grounds
away whereabouts), so time-of-day fits routine ("it's mid-morning; she'd
normally be at the café") and a skip lands in a believable part of her day.
Prompt-budget-cheap; anti-repetition rides the existing surfaced-cues pattern
if it proves noisy.

## Ensemble & supporting cast (the NPC-management angle)

The meanwhile pass is deliberately **cast-wide** — it is the chat lane's
"world tick":

- **NPCs interact with each other off-screen.** Roster pairs (grounded by
  their matrix record: kind/history/stances) and roster × supporting-cast
  pairs can have developments ("Nyx and Kira actually went shopping; Kira
  overshared about you"). These file as **relationship facts** — the shipped
  v2 pattern (lived shifts reach the narrator through archivist facts; the
  authored matrix is never machine-edited). The player discovers them in
  conversation, which is exactly how off-screen social life should surface.
- **Away members live, present members remember.** Development facts file to
  the involved members' memory groups, so each character knows their own week
  — and knows *different things*, which the per-member memory legs already
  support.
- **Supporting cast stay minor but persistent** — their lives advance through
  detail/whereabouts accretion only (caps enforced); the pass never promotes
  them toward roster weight.
- **Bounds**: ≤3 developments per skip regardless of skip size; length caps;
  never contradicting fenced canon; secrets stay secret (the drives law owns
  reveals — the pass may progress a secret drive, never expose it).

## Cost note

One archivist-class call per qualifying big skip, plus modestly larger opener
/ skip-note prompts. Player-triggered, capped, degradable — no standing spend.

## Feasibility notes (code review, 2026-07-15)

A pre-active trace against the shipped code. The plan is feasible and unblocked
(plans & promises landed with the NPC↔NPC hook pointing here), but the build
note understates four pieces of net-new work:

1. **The field library is single-subject; the meanwhile pass is ensemble-wide.**
   Every `ExtractorField` instruction closure bakes in one `ctx.characterName`
   (one `drives` list, one subject), so the `meanwhile` leg cannot literally
   reuse the `facts`/`driveUpdates`/`cast` key list — a cast-wide pass needs a
   new **composite meanwhile field** whose proposed developments each carry a
   subject/pair binding, with the fold dispatching each development to the
   existing sinks. Reuse the *folds* and the *library assembly machinery*
   (role/blocks/rules), not the single-subject instructions. (The alternative —
   per-member fan-out of the personal leg — breaks the one-call cost budget and
   can't see NPC↔NPC pairs.)
2. **Per-member fact routing is new plumbing.** `writeChatMemory` today fans
   the *same* aggregate out to all *present* witnesses; "each member knows
   different things" (and away members receiving their own week) needs a
   targeted write — fact → involved members' memory groups, including away
   members, who currently never receive writes.
3. **Whereabouts is net-new end to end**: no column on `character_chat_state`
   (presence is bare `present|away`), the archivist `cast` proposal schema
   carries no `whereabouts`, and `mergeSupportingCast` never writes it — the
   stored supporting-cast field is author-set only today.
4. **The scene-sketch CAS doesn't map 1:1.** It CAS-writes one jsonb column;
   the meanwhile pass writes many sinks across two tables plus `addFacts`
   (which is the async embed+transaction memory path, not a pure fold). The
   never-409 property carries over, but idempotency should key off the
   `SkipRecord` (e.g. a per-skip marker / `guardMessageId`-style guard), not a
   value CAS.
5. **Threshold lumpiness (feeds Open Q A):** skip amounts are a fixed enum
   (`moments` 30 / `hours` 180 / `overnight` 540 / `days` 4320 minutes), so a
   literal ≥1-story-day (1440) gate arms on `days` only — `overnight` reads as
   "the next morning" but is 540 min. Consider gating on cumulative minutes
   since the last pass, or arming `overnight` by label semantics.

## Open questions

- **A. Threshold & scaling** — what skip size arms the pass (one story day?);
  do longer skips get more/weightier developments or the same 1–3?
- **B. Placement** — detached job at skip time (lean) vs inline in the skip
  POST (`POST …/time-skip` — simpler, adds latency to a quick action) vs next
  exchange pre-turn (rejected lean: first-token latency, the intake lesson).
- **C. Whereabouts storage** — a new small column on `character_chat_state`
  vs riding `mindNote`. Lean: its own field (forward-compatible; the ensemble
  prompt reads it directly).
- **D. Matrix nudges** — should the pass ever propose bounded NPC↔NPC band
  shifts? Lean: **no for v1** — facts only, consistent with the shipped
  matrix ruling; revisit if facts prove too weak to move scenes.
- **E. Meanwhile-note size** — one composed line (lean) vs a small block when
  multiple developments landed; how much reaches the narrator vs memory-only.
- **F. Opener overlap** — when a meanwhile pass already ran for the gap, the
  opener's improvised life-meanwhile license should prefer (or be limited to)
  the pass's developments — same-beat dedupe needs a rule.

## Not in scope

- **Wall-clock time / background timers** — D3/D8 stand; off-screen life keys
  to the story clock and player-triggered moments only.
- **A location model** — whereabouts is a phrase, not an entity; chat places
  stay narrator-imagined in scene memory.
- **Cast promotion** — promote-to-character stays deferred with the
  supporting-cast plan's other leftovers.
- **The session lane** — carried by the successor model when the test-bed
  direction settles.

## Docs to update when implementing

`character-chat/state.md` (whereabouts, meanwhile folds),
`character-chat/pipeline.md` (the skip-time job), `character-chat/initiative.md`
(grounded material + dedupe rule), `character-chat/multi-character.md`
(whereabouts in the away/salient lines, NPC↔NPC development facts),
`prompts.md` (meanwhile note + rhythm line), `character-chat/api.md` (if the
skip surface changes).
