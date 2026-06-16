# Phase 2 — follow-ups

Fixes and small improvements found in testing/play after
[phase-2-plan.md](phase-2-plan.md) shipped, per the repo convention:
dated entries with observation → investigation → verdict → proposed
fix. Feature-sized work goes to the next phase's plan, not here.

## 1. New acquaintance still reads "stranger" after a warm first meeting (2026-06-12)

**Observed.** In a live session: met Maya Rodriguez, the meeting went
well, exchanged phone numbers — the cast tab still shows her as a
stranger.

**Investigation** (dev DB, session `b2e84bgnsqg0bp1e7n2d87z1`, 7
turns). Maya has NPC↔NPC edges (friendly 47 with Dr. Green, both
directions — spawn-seeded from authored relationships, working as
built) but **no edge toward the player at all**. Across all seven
turns the simulant returned `affinityAdjustments: []` every time —
including turn 6, the number-exchange beat. Nothing was dropped or
clamped: zero `merge.affinity.*` diagnostics, zero `affinity_*` events.
The merge, clamp, seeding, stages, and UI all behaved correctly; the
upstream signal never fired.

**Verdict: both, in layers.**

1. *Mechanical failure (the real bug):* the simulant prompt
   (`engine/prompts/agents.ts`) says "Most turns: none" and **both**
   worked examples end with `affinityAdjustments: []`; the only
   non-empty inline example is high-drama ("covered her debt", +3). A
   model shaped that way under-fires on warm-but-ordinary beats — a
   friendly first meeting plus exchanged contact info should plausibly
   emit +1..2 and emitted nothing.
2. *Working-as-designed (the layer on top):* even when the signal
   fires, the label is intended to be sticky — clamp is ±5/turn and
   the stranger band spans −14..14, so a single pleasant meeting
   (+1..5) correctly stays "stranger"; acquaintance needs ~3 warm
   turns of accumulated evidence. And the cold-open warmth this scene
   wanted is exactly the **first-impression seed** (decision 43),
   deliberately deferred to the presence phase
   ([phase-3-plan.md](phase-3-plan.md)).

**Proposed fixes (follow-up-sized, not yet applied).**

- Reshape the simulant prompt: add one moderate-warmth worked example
  (good first meeting / exchanged contact info ⇒ `delta: 1–2`) and
  soften "Most turns: none" toward "emit only when words or deeds
  evidence a shift — small social warmth counts". One file, prompt
  structural test rides along.
- Optional UI nicety: distinguish *met* from *stage* on the cast card
  (`runtime.encounteredParticipantIds` already tracks encounters) so a
  fresh acquaintance-in-the-making doesn't read coldly as "stranger" —
  e.g. "stranger (just met)". Defer if the prompt fix alone feels
  right in play.
- Tuning watch, no action: if play data keeps showing the stranger
  band too wide for social arcs, the stage boundaries are registry
  data (`contracts/relationships/stages.ts`) and `affinity_stage`
  events now provide the evidence.

**Update (2026-06-12, entry 20):** probably the same root cause as the
hijab miss — provider-side constrained decoding returning hollow
objects — rather than prompt shaping. Re-test affinity emission in
play before applying the prompt reshape.

Status: **open (re-test after entry 20's fix before acting).**

## 2. "Thursday is two days from now" — suspected weekday math error (2026-06-12)

**Observed (as reported).** Maya agreed to coffee on Thursday; the game
day was believed to be Saturday; a few turns later the narrator called
Thursday "two days from now" — which would be wrong in either
direction read (Thursday is 5 days forward from Saturday, or 2 days
*back*).

**Investigation** (same session, `b2e84bgnsqg0bp1e7n2d87z1`).

- The world's `calendarStart` is 2025-10-14 07:30 and the session
  clock sits at +64 minutes — the current game day is **Tuesday,
  October 14, 2025**, not Saturday. No narration in the session
  mentions Saturday at all.
- The narrator receives the weekday authoritatively every turn: the
  turn context opens with `Current time:` via `formatGameClock`
  ("Tuesday, October 14, 2025 — 8:34am"), and rulebook rule 5 forbids
  contradicting it.
- Turn 7's actual line: "Maya's number. Thursday. That's still two
  days away." Tuesday → Thursday **is** two days. The model read the
  clock line and counted forward correctly.
- The world-tab clock card renders the same `formatGameClock` string,
  weekday included, so the UI and prompt agree.

**Verdict (revised same day): a real UI bug — but in the clock card,
not the narrator.** The first-pass verdict ("could not reproduce") was
wrong. The player's session page really did show **Saturday, June 1,
2024, 9:04am**: the status payload's `clock` object shipped
`{ minutes, display, delta }` but **not `calendarStart`**, and the
world tab recomputes the date client-side from
`clockMinutes + (status.calendarStart ?? DEFAULT_CALENDAR_START)` —
so every session silently rendered against the hardcoded default
calendar (June 1, 2024, 8:00am — a Saturday; 8:00 + 64 session minutes
= the observed 9:04am). The authored 2025 calendar was stored and used
correctly everywhere server-side, which is why the narrator (fed
`formatGameClock` from the real calendar) counted Tuesday → Thursday
correctly while the UI showed a different planet. Notably the client
parser and its tests already supported `clock.calendarStart` — only
the server never sent it: a silent contract mismatch masked by a
degraded default, the same failure class as the phase-1 `detailOf`
bug.

**Fix applied (2026-06-12).** `buildStatusPayload` now ships
`clock.calendarStart` from the world style
(`src/app/api/sessions/_shared/status-payload.ts`); regression test
asserts the field rides the payload. The world tab needed no change —
its parser was already waiting for the field. Gates green (typecheck,
749 pure, 81 integration).

**Improvement worth keeping anyway.**

- The weekday lives only in the small clock card; in long sessions
  it's easy to lose track of the game calendar. Cheap option: surface
  the weekday more prominently in the play header, or include it in
  the clock-delta toast when a turn crosses midnight.
- Optional hardening, near-free: one rulebook line — "when narrating a
  future named weekday, count forward from the Current time line" —
  guards the genuine hallucination risk this report worried about,
  even though it didn't occur here.

Status: **closed (fixed — payload now carries `calendarStart`); the
two improvement notes above remain open.**

## 3. Cast card shows no "thinks you're …" line for unmet NPCs (2026-06-12)

**Observed.** Dr. Green's cast card shows both lines ("Acquaintance
toward you" + "thinks you're acquaintance toward them"); Maya's shows
only "Stranger toward you" with no perceived line.

**Investigation.** Dr. Green has both player edges in
`participant_relationships` (feeling + perceived, acquaintance 25 —
spawn-seeded from his authored relationship, classifier-mirrored).
Maya has no player edges at all. In `cast-tab.tsx`,
`relationshipToPlayer` defaults a missing feeling edge to `"stranger"`
(rendered) but a missing perceived edge to `null` (line suppressed) —
the same absent data renders on one line and hides on the other,
despite the function's own "No edge = stranger" comment.

**Verdict: UI inconsistency, not engine logic.** Sparse-is-stranger is
the engine's explicit semantic in both directions (seeding, the future
first-impression rule); an NPC with no perceived row effectively
believes the player is a stranger toward them. The gap will recur in
normal play: feeling and perceived rows are written independently
(NPC-initiated warmth ⇒ feeling; the player's behavior ⇒ perceived),
so one-without-the-other is a common state.

**Ruling (2026-06-12, user).** Keep "Stranger toward you" alone for
strangers: while she's a stranger to you she can't plausibly think you
see her as anything else, so the perceived line is implied. Show the
perceived line once the pair is no longer mutually stranger — i.e.
hide it only when the feeling stage is stranger AND the perceived edge
is absent or stranger; if a perceived row says otherwise (the player
has been overtly warm while her feeling hasn't moved), it carries real
information and renders. A missing perceived row displays as
"stranger" when the line is shown.

Status: **closed (ruled + implemented with entry 4).**

## 4. Expandable cast cards (improvement, 2026-06-12)

**Request.** Clicking a cast card expands it in place to show the
character's whole inventory and the useful parts of their state;
clicking again collapses it; only one card expanded at a time
(accordion — expanding one collapses the other). UI-only, deliberately
taken as a phase-2 follow-up rather than deferred.

Status: **closed (implemented, 2026-06-12).** The expanded card shows
the full worn list including hidden layers (new `wornFull` status
field; `wardrobe` unchanged), held items, remaining time on timed
conditions (new `remainingMinutes`), and the character's location when
away from the player; entry 3's perceived-line rule shipped in the
same change (`components/play/cast-relationship.ts`).

## 5. Narrator scripts the player's half of conversations (2026-06-12)

**Observed.** Turn 13: the player wrote "I pick up my desk work phone
and dial the number to a detective I know…" — nothing more. The
narration invented the entire call: six full player dialogue lines
including new plot claims voiced *as the player* ("I traced the IP to
a PO box in Portland…", "I can have it in your inbox within the
hour"). Separately, the detective greeted the player as a distant
memory ("haven't heard your name since you were sixteen") despite the
input asserting "a detective I know".

**Investigation.** The embodied rulebook already forbade this (rules
3–4: never write dialogue for the player / no extra words in their
mouth) — this was model non-compliance, with two structural causes:
(1) the rules had no instruction for the *initiated-conversation* case
(a call with no supplied words), where a scene-completing model fills
both sides; (2) nothing enforced the rule — the continuity agent
listed "voicing the player" only under `driftNotes`, which feed back
nowhere (violations become next-turn corrections; driftNotes don't).
The cold-greeting half is the unbuilt emergent-cast system (entry 6):
the detective has no participant row, so no relationship can exist for
the narrator to honor — it invented a thin past instead.

**Fix applied (2026-06-12).** Two prompt changes, tested: embodied
rule 5 — when the player opens a conversation without supplying their
words, voice only the other side up to where the player would speak
next, end the turn, and wait; continuity rule 5 — invented player
dialogue IS a major violation (subject: player, claim: the invented
speech), so the merge folds it into next-turn correction directives.
`docs/prompts.md` updated. Watch in play: turns that end mid-call are
the intended behavior now.

Status: **closed (fixed); relationship-honoring waits on entry 6's
system.**

## 6. Named NPCs (Martha, Det. Campbell) never materialize (2026-06-12)

**Observed.** Characters introduced in play don't generate: Martha
earlier, the detective now. "I thought we did that yesterday."

**Verdict: not a regression — the system doesn't exist yet.** Dynamic
character introduction (director `castSignals` → provisional
participant row → async forge enrichment) is specced but unbuilt:
[dynamic-character-introduction-spec.phase3.md](dynamic-character-introduction-spec.phase3.md),
scheduled for phase 3. What shipped yesterday was its **phase 0 only**
(identity-conditioned ranges — a forge upgrade the future emergent
pipeline inherits), plus forge *relationship suggestions* for authored
cast. Until phases 1–2 of that spec land: a narrated NPC gets no
`session_participants` row, can't tag dialogue (Campbell's lines render
as plain narrator prose, no bubble), grounds facts by name only, has no
relationship edges (entry 5's cold greeting), and evaporates between
scenes — exactly the spec's problem statement. No action here; phase 3.

Status: **closed (working as currently scoped — phase-3 feature).**

## 7. Hidden clothing visible in expanded cast cards — dev-only (2026-06-12)

**Ruling (user).** The expanded card's hidden-layer display (italic,
"(hidden under other layers)") is useful in dev and stays for now —
but in production players must not see hidden clothing (no underwear
listed under pants). UI-only change when it comes: filter
`visibility === "hidden"` from the expanded list; state and the shared
`resolveWardrobeVisibility` resolution are unaffected. Noted in the
code (`cast-tab.tsx` Wearing section) and `docs/ui.md`.

Status: **open (deliberate — apply before production).**

## 8. `{{player}}` template token (improvement, 2026-06-12)

**Request.** A dynamic variable for authored text: `{{player}}`
resolves to the embodied character's display name per session; observer
sessions fill with something role-appropriate. Goal: embodiment-
agnostic authored content and easier backend handling of player
references.

**Implemented (2026-06-12).** Pure `src/lib/player-token.ts`
(case-insensitive, spacing-tolerant); substitution happens **once at
session-bundle load** (`bundle.ts`), so prompts, post-turn agents, and
the status-payload UI all see identical resolved text — plus one extra
fill for retrieval-tier lore hits, which reach the prompt via their own
pgvector query and bypass the bundle. Observer sessions (which spawn no
player participant) fill with **"the protagonist"** — names the story
role without asserting a present character, since the observer
rulebook says no player exists in scenes. Substituted: world
description, synopsis, style directives/guidance/norms, lore chunk
title+body, location descriptions, snapshot bio/personality/voice,
item descriptions/sensory. Never substituted (identifiers): all names,
`displayName`, schedule `locationName`. The world forge's premise and
lore prompts now instruct the model to write the literal token, so
generated worlds stay embodiment-agnostic. 19 new tests incl. an
embodied + observer integration pass.

**Future candidates** (excluded from the field contract for now):
faction descriptions, plot-anchor summaries, ambient sensory text,
schedule `activity`, image-pipeline prompts (read profiles outside the
bundle).

Status: **closed (implemented).**

## 9. Cast-card "Idle" → live off-screen activity (deferred design note, 2026-06-12)

**Request.** For dev/observer sessions, the cast card's activity line
should show what an off-screen character is currently doing — one
brief line ("speaking to a patient") — especially when they're not at
the player's location, fed in real time by the planned
follow-major-characters system.

**Assessment: fits the plan exactly — the surface already exists.**
The "Idle" text IS `ParticipantState.activity` (defaults to "idle");
the card renders it live from the status payload. It updates from two
sources today: simulant `activityUpdates` (on-screen scenes only) and
authored schedule entries — the merge already writes `entry.activity`
when a schedule tick moves an off-screen NPC, so a character with a
covering schedule entry shows "seeing patients" all shift. "Idle"
off-screen means no schedule entry covers the current minute (forge-
generated characters often have sparse or empty schedules — authoring
the schedule in the character editor fixes it today). The rich
per-moment one-liners arrive with the world-tick
([offscreen-simulation-spec.phase3.md](offscreen-simulation-spec.phase3.md)):
its `offscreenEvents` summaries are exactly this text — the spec now
carries a surface note to write each active character's latest summary
into `activity`, giving the tick a zero-cost live surface beyond the
planned Turn Inspector feed.

**Gating caveat (the "dev or Observer" scoping is load-bearing).** In
embodied production play, an absent character's live activity — and
the expanded card's "Currently at …" line — is player omniscience the
perception model forbids; both join the hidden-clothing display
(entry 7) as dev/observer-only surfaces to gate before production.

Status: **deferred to the off-screen simulation phase (spec note in
place); no action now.**

## 10. Visibility tiers — observer is not dev (clarification, 2026-06-12)

**Ruling (user).** Observer mode is a god-mode orchestrator role: the
user directs the world and characters never interact with them. It is
largely unfleshed and untested — maturing it is **feature-sized future
work** (a future phase's plan, not a follow-up). What's decided now is
the visibility model the gating work (entries 7 and 9) must use —
three tiers, not a dev/production boolean:

| Surface | Embodied (production) | Observer | Dev |
| --- | --- | --- | --- |
| Inventories incl. hidden layers | hide hidden layers (entry 7) | **show** (ruled) | show |
| Off-screen activity/location (entry 9) | hide (omniscience) | **show** (the entry-9 request was observer-scoped) | show |
| Turn Inspector, diagnostics | no | no | yes |

Other surfaces get per-surface rulings as they come up; default
ordering is embodied ⊂ observer ⊂ dev. Gating remains UI-only per
entry 7 (state and visibility resolution unaffected).

Status: **recorded; consumed by entries 7/9 when gating lands.
Observer-mode maturation: unscheduled future phase.**

## 11. Name-bound rulebook rules ("never speak for Brian") (proposal, 2026-06-12)

**Request (user).** Use the player's resolved name to make system-
prompt rules direct: "never speak for Brian Devereaux" instead of
"never speak for the player", so the model binds the prohibition to a
concrete entity.

**Assessment: feasible and useful.** Mechanically this is prompt-
builder input, not the `{{player}}` token (that resolves authored text
at bundle load; prompt builders are code and take parameters —
`StaticRulebookInput` already carries `npcNames`/`playerContext`).
Cache-safe: the name is session-stable, so the rulebook stays
byte-stable per session. Evidence it helps: turn 13's model knew the
player's name (invented "it's Brian Devereaux…") while violating the
role-phrased rule; models bind prohibitions to named entities better
than to roles. **Phrasing caveat:** the rulebook also demands the
opposite name behavior in prose ('address the player as "you", never
by name'; "never tag the player") — so bind the name to the
prohibitions ("The player is X. Address them only as 'you' — never by
name. Never write dialogue for X. Never tag [X].") so the raised
salience points at the don'ts. Observer mode unchanged.

**Sketch.** `playerName` into `StaticRulebookInput` → embodied
narration-mode rules + dialogue-tagging rule 4 interpolate it; a
"Player: <name>" line in the continuity agent's per-turn slice (its
system prompt stays a static const) so the invented-dialogue check
(entry 5) names its subject directly; structural tests updated.

Status: **open (awaiting go).**

## 12. Location editor: collapse, reorder, copy, link clarity (2026-06-12)

**Request.** Long location lists scroll forever — collapse cards to
title + tags; drag-and-drop ordering; a copy-location button (an hour
by hand for 6 similar rooms); plus confirm whether links are
bidirectional. Feature-sized asks from the same message (area
hierarchy, owner, time-banded ambients, per-location forge) went to
[location-design-spec.phase3.md](location-design-spec.phase3.md) with
their open questions restated in the phase-3 plan.

**Shipped (2026-06-12).** Map-tab cards collapse to name + tags +
scale·area hint (multiple open, new/copied cards start expanded);
drag-and-drop reordering with an accessible move-up/down fallback,
persisted via a new `world_locations.sort` column (migration
`0004_nosy_blazing_skull.sql`; reads ordered everywhere incl. spawn,
so sessions see authored order); copy button duplicating description,
tags, scale, area, ambient — never name (duplicate-save error),
`links`, or `locationId`/row id (would double-link library rows).
Interpretation flag: the request listed description as both copied and
defaulted — shipped **copied**. A copy saved while still unnamed is
dropped with a warn diagnostic (`…location_nameless`). Links:
confirmed **undirected at runtime** (merge adjacency + scene exits
match both orientations) — the editor now shows "Also connected from:
…" per card and refuses adding a link whose reverse already exists.

Status: **closed (implemented).**

## 13. Narrator enacted absent characters — presence enforcement v1 (2026-06-12)

**Observed (state-breaking).** The narrator wrote dialogue for Fatima
while she was one room away — unprompted, so `buildAbsenceNotice`
(which only fires on player input naming an absent NPC) never
triggered. No movement was recorded; story and state diverged ("you
talked to Fatima" vs "Fatima is not present").

**Diagnosis.** No guard existed against narrator-*initiated*
enactment: canonical blocks for all NPCs live in the cache-stable
rulebook, the turn context never said who was actually present, and
the continuity agent had no rule for it. This is the presence spec's
core problem statement; the full fix (channels, witness sets) is
phase 3 — but its prompt-side slice needed nothing from that
machinery.

**Fix applied (2026-06-12).** Three pieces, interim co-location
semantics: (1) a "Who is where" turn-context roster — Present /
Nearby (adjacent rooms, via the undirected link graph) / Elsewhere
(with location names); (2) a "Presence fidelity" rulebook block —
only Present characters act or speak; a Nearby character may join
same-turn ONLY via a narrated physical arrival before their first
line (the arrival is what the simulant records as the move); Elsewhere
characters may be discussed or quoted from memory but never enacted;
wanting someone is a setup, not a teleport (signal this turn, arrival
later); (3) continuity rule 6 — an enacted absent character is a
MAJOR violation, folded into next-turn corrections by the existing
merge path. The narrator roster anchors on the staged move target so
walking into an occupied room doesn't forbid its occupant from
speaking. Phase 3 replaces the roster's semantics with channels and
adds awareness blocks on top (spec status note updated).

**Reconcile semantics (clarified on review).** During the narration
itself nothing has moved — the narration is a script the post-turn
pipeline reifies: simulant extracts the depicted arrival as a
`movements` event, the merge validates it (adjacent ⇒ accepted) and
applies movements *before* stamping `witnessed_by` on facts/episodes,
so story and state converge at the turn boundary. The Nearby-only
exception mirrors the merge's adjacency validator exactly: arrivals
the narrator may write are precisely the ones reconciliation is
guaranteed to accept. Residual risk: a simulant failure (degraded
default = no movements) loses the move while the dialogue stands —
next turn's roster re-clamps the character, so it self-limits rather
than compounds.

**Tuning (2026-06-12, same day).** First live flags surfaced a false
positive: the player walked INTO Fatima's apartment and the auditor
flagged her ("no narrated arrival") even though the narrator rightly
treated her as Present. Root cause: the narrator's roster anchored on
the staged-move target (`promptLocationId`) while the continuity
agent's roster anchored on the pre-move player location — two
implementations of "where is the scene". Fixed by extracting ONE
shared helper, `stagedLocationAnchor` (merge.ts — enter intent +
adjacency + access check), now used by both pre-turn prompt assembly
and the post-turn audit; 3 pure tests pin it. Residual model-judgment
case (acceptable, watch in play): a threshold arrival ("she appears in
the doorway") that the auditor judges insufficient.

Status: **closed (fixed); full perception model remains phase 3.**

## 14. Player character duplicated when in the cast; naked when not (2026-06-12)

**Observed.** In greywater2: adding the character you intend to play
to the world's cast spawns him twice — "Brian Devereaux" (NPC) plus
"Brian Devereaux 2" (the player). Leaving him out of the cast and
picking him at session start avoids the duplicate, but he spawns with
no inventory — players are always naked as far as state is concerned.

**Investigation.** Both symptoms come from `engine/spawn.ts` having no
concept of "this cast member IS the player":

1. *Duplicate:* `materializeSession` built participants in two blind
   passes — all cast members, then the embodied player appended as a
   new row with no `characterId` overlap check. The `uniqueName()`
   collision helper then suffixed the second row (" 2").
2. *Naked:* the outfit-item lookup map (`loadWorldMaterial`) was built
   from **cast** `defaultOutfit` ids only, so a non-cast player's
   outfit ids all missed (each skipped with `spawn.outfit.missing`);
   world-placed items resolve holders via `world_items.cast_id`, which
   a non-cast player never has.
3. *Latent:* had the duplicate not existed, an in-cast player would
   have double-spawned outfit items — the worn-dedup check only ran
   for wearers with a `castId`.

**Fix applied (2026-06-12).** A player character that matches a cast
member's `character_id` is **promoted in place**: its cast row becomes
the player participant (`is_user`, role `player`, tier `major`),
keeping the `world_cast` linkage so placed items and outfit dedup
resolve to it; its authored cast placement beats the world's generic
player start (specific beats general). A non-cast player's
`defaultOutfit` ids now join the material's outfit-item lookup (player
seed loads before world material in both spawn and restart).
Relationship seeding (`relationship-seeds.ts`) learned the played
member: edges toward its display name count as toward-player (feeling
+ classifier perceived), and its own authored edges seed the NPC side
instead of player-owned rows (decision 41), explicit NPC edges still
winning. Covered by pure tests (played-member seeding rules) and two
int tests (in-cast promotion with items/relationships; non-cast outfit
seeding).

Status: **closed (fixed).**

## 14. Arriving characters' dialogue now renders as speaker bubbles (2026-06-12)

**Observed.** Dialogue for a character not present in the DB rendered
as plain prose inside the narration instead of the speaker-bubble UI
(avatar + distinct formatting) — even when the character was
legitimately arriving under entry 13's Nearby exception.

**Diagnosis.** The bubbles come from the segmenter parsing `[Name]`
tags, and the narrator's tag vocabulary was the **co-located NPC list
only** (`pipeline.ts` present filter) — an arriving character wasn't
in "using exactly one of: …", so the model obediently wrote her speech
untagged. The segmenter (always session-wide, liberal) would have
rendered the bubble fine; the prompt forbade the tag. Side effect of
the same wiring: the "static" rulebook's bytes changed on every player
move (present list changed), costing a prefix-cache miss per room
change.

**Fix applied (2026-06-12).** The tag vocabulary is now every session
NPC (session-stable ⇒ rulebook truly cache-stable across moves), with
tagging rule 5 making the gate explicit: "The list is who CAN be
tagged, not who may speak" — only Present characters, or a Nearby
character after their narrated arrival, per the Presence fidelity
rules. Presence gating thus lives entirely in the roster + rules +
continuity violation (entry 13), not in the name list.
docs/prompts.md's "conservative prompt / liberal parser" doctrine
updated accordingly. Unknown names (no participant row — e.g. emergent
characters pre-phase-3) still render as prose by design: the segmenter
only bubbles known cast.

Status: **closed (fixed).**

## 15. Deterministic dialogue gate: reject-and-retry for absent-cast dialogue (proposal, 2026-06-12)

**Request (user).** When the narrator writes dialogue for a name in
the cast list who is NOT present, reject the narration with a reason
and make it try again. Names NOT in the cast list are allowed as
plain narration dialogue (and later pipe into the emergent-NPC
generation method).

**Assessment.** The unknown-name half is already today's behavior and
the phase-3 plan: the segmenter only bubbles known cast, so unknown
speakers stay prose, and the director's `castSignals` (emergent-cast
spec phase 1) is the planned pipe into NPC generation. The
known-but-absent half is the right next layer — defense in depth:
prompt rules (entries 13/14) → **deterministic gate** → continuity
correction (post-hoc). It is detectable live: the segmenter emits
speaker segments mid-stream, so a tag whose speaker is listed
Elsewhere can abort generation at the moment it appears. Nearby
speakers pass the gate unconditionally (whether their arrival was
narrated first is prose-level — stays with the continuity check).

**Design sketch (single-retry, never wedge):** mid-stream gate in the
pipeline loop checks each speaker segment against Present ∪ Nearby;
violation ⇒ abort the stream, emit a client **reset** event (feed
clears the partial turn — new stream-protocol event + feed handling),
regenerate ONCE with the rejection appended ("your previous attempt
gave dialogue to X, who is Elsewhere — rewrite without enacting
them"), re-stream. A second violation is accepted with a warn
diagnostic (`narrative.presence.gate_failed`) and left to the
continuity correction — a degraded turn beats a failed one
(resilience.md). Costs: one extra narration call worst-case, visible
restart in the feed, stream-protocol + client changes, constants +
tests.

**Refinement (2026-06-12, user).** A watcher on the stream checking
names, stopping early — or worst case letting the stream finish but
hiding it and retrying immediately. Assessment: no watcher *agent* is
needed — the segmenter already parses speaker tags incrementally in
the pipeline loop, so the watcher is pure code per chunk (zero added
latency, zero model calls). Abort-at-the-violating-tag strictly beats
finish-then-hide: it saves the remaining generation time AND tokens.
Known gap either way: a tag gate cannot catch absent-cast dialogue
written as plain quoted prose (the style the live violations used);
with entry 14 legitimate speakers now get tagged, so a cheap
absent-name-near-quotes heuristic could flag (not block) prose cases,
with continuity as the net.

**Pre-turn agent considered (2026-06-12), passed over.** No LLM runs
between player input and the narrator today — pre-turn is retrievals +
deterministic checks only, keeping the critical path to first token
fast. A pre-turn checker can't solve this class anyway: the violations
are born from the narrator's own mid-generation choices, invisible to
any input-side check; the earliest interception is the mid-stream
gate above. If richer proactive LLM checking is ever wanted, the
idiomatic zero-latency slot is a fifth post-turn agent writing
next-turn constraints into the brief (the director already works this
way), not a blocking pre-turn call. **(Pass-over reversed 2026-06-14 —
see entry 16's update and
[pre-narrator-agents.spec.md](pre-narrator-agents.spec.md);
narrator-quality findings made the latency worth paying.)**

Status: **open (awaiting go — touches the streaming protocol and
feed UX).**

## 16. "This turn" binding digest atop the turn context (2026-06-12)

**Request (user).** A proactive guardrail: enumerate what the narrator
is allowed to do this turn, computed after the player's input, with
instructions not to deviate. (An LLM enumerator and a director-planned
turn were considered and passed over: the director's plan goes stale
the moment the player swerves — its brief stays advisory by design —
and a pre-turn LLM adds a blocking round-trip plus a hallucinated-plan
risk; see entry 15's pre-turn note.)

**Shipped (2026-06-12).** `scene.buildTurnDigest`: a compact
imperative digest rendered as the first block of the turn context —
"Voice freely: Maya." / "May bring in, but only via a narrated
physical arrival before their first line: Fatima (Apartment 102)." /
"Never enact — discuss or quote from memory only: Dr. Green (Clinic)."
/ the blocked-threshold line when staging refused a move. Pure
restatement of the authoritative blocks (shared `groupPresence` with
the roster; same staged anchor; never introduces facts), zero latency,
renders nothing when there is nothing to constrain. Models follow a
terse action list more reliably than they cross-reference six
authority blocks — this is the deterministic version of the
allowed-actions guardrail. 5 new tests; docs/prompts.md updated.

**Update (2026-06-14) — the digest is necessary but not sufficient; the
pre-narrator pass-over is reversed.** After further testing and development the
deterministic digest alone has proven inadequate to narrator quality. Observed
in play: the narrator **strays** from the constraints it is handed, and it
**re-raises story threads it has already brought up and resolved** — it narrates
as if a settled question is still open, despite resolved/archived threads being
dropped from its context every turn (turn-engine.md step 7 / story-threads.md).
That symptom is telling: the model is not reliably honoring the context it is
given, so a *purely deterministic, advisory* guardrail (a digest it can ignore)
is not enough. We now judge that a **pre-narrator system of some sort is
needed** — reversing the "passed over" stance of this entry and entry 15. Full
analysis, feasibility (latency is the real cost), and recommended build (a
latency-hidden "intake" agent growing into a before/during/after guardrail mesh)
in [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md).
Note the thread-repetition symptom argues for the *mesh*, not intake alone: an
input-side agent cannot stop the narrator mid-stream from re-opening a closed
thread — that wants the mid-stream gate (entry 15) and/or a post-turn fidelity
check too. Intake is the foundation, not the whole fix.

Status: **closed (implemented); the broader pre-narrator question is reopened
2026-06-14 — see pre-narrator-agents.spec.md.**

## 17. NPC inner notes — authorial interiority injection (2026-06-12)

**Request (user).** Players shouldn't narrate NPC feelings/thoughts
through their own input (the chatbot habit). Instead: pick an NPC on
the cast tab and inject a memory, thought, feeling, or belief — never
dialogue — processed by the memory/state machinery as a non-blocking
background task so the NPC carries it from the next turn.

**Shipped (2026-06-12).** `POST
/api/sessions/:id/participants/:participantId/inner-note` (202 +
jobId; player-participant rejected; rate-limited) → new `inner_note`
job on the same strictly-serial per-session queue as post_turn (never
interleaves a merge, never blocks play) → one `generateChecked`
extraction (never-dialogue/never-physical-events/this-character-only
rules, worked example) producing 1–4 interior facts + one guidance
line. Facts persist via the normal memory path: `canon: true`,
`witnessed_by: [the NPC] only` — interiority is theirs alone, exactly
what the phase-6 knowledge ledger will consume; confidence floored at
0.5 so the extraction gate can't drop an authored note. Guidance
appends "Author's note — Fatima: …" to `brief.characterNotes` for
guaranteed next-turn effect (facts alone retrieve probabilistically);
the brief's regeneration self-expires it while the facts carry the
long term. Degraded default (and demo mode): the note persists
verbatim as a single knowledge fact + guidance with a diagnostic —
the feature works with the model down. UI: "Inner note" section on
the expanded cast card. 16 pure + 4 integration tests; docs
(streaming-api, turn-engine, memory, ui) updated.

Status: **closed (implemented).**

## 18. Scene images: player-POV, co-located cast, visible wardrobe (2026-06-12)

**Request (user).** Scene generation was companion-biased; it should
compose from ANY NPCs at the player's location plus the recent
turn(s), know what they're wearing (outer hides inner, like the
avatar builder), and never show the player — the image is from the
player's eyes.

**Diagnosis.** Two mechanisms, no location awareness: a
`subject: "companion" | "player"` knob on scene-gen state (default
companion) and the scene_image handler picking the first
companion-role participant — an NPC in another room could be the
subject; a co-located non-companion never could.

**Shipped (2026-06-12).** The subject knob is deleted. The composer
context is built from state: every NPC co-located with the player
(structurally impossible to include the player or another room's
NPC), each with activity/posture, an appearance summary from resolved
attributes, and the occlusion-filtered visible outfit
(`resolveWardrobeVisibility` — hidden layers never reach image
prompts; the spec schema has no outfit field at all, outfits are
state-forced after generation); location + ambient + daylight-band
lighting; the last 2 turns' narration (budgeted). POV hard rule
(`SCENE_POV_RULE`) in both composer and render prompts: first-person
from the player's eyes, the player never appears. Reference
selection respects Venice's single-reference limit: focal character's
avatar → identity-locked edit with others described textually; no
focal avatar → fallback to a featured present NPC's avatar (info
diag) → text-to-image; empty room → location-only POV shot. Names the
composer invents are clamped to the roster with warn diagnostics.
Demo mode exercises the full path. ~16 new/updated tests; docs
(images.md rewritten; contracts/streaming-api/guide references to the
removed knob fixed).

Status: **closed (implemented).**

## 19. Hijab removal not detected in state (2026-06-12)

**Observed.** A two-turn arc — unpinning, then unwrapping Fatima's
hijab and setting it on the coffee table, narration confirming "The
hijab comes away in soft folds" and her hair revealed — produced no
state change: she still wears the Black Jersey Hijab.

**Investigation** (session `ejmr928h63ivlfrhno1c32yc`, turns 37–39).
Everything downstream was healthy: the worn instance existed ("Black
Jersey Hijab", worn=true — name resolution would have matched), the
simulant's item slice listed it ("worn by Fatima Al-Aqsi"), the
narration stated the completed removal. The simulant returned
`itemEvents: []` on both turns — zero diagnostics, nothing dropped.
Pure under-detection, the same failure class as the affinity silence
(entry 1): SIMULANT_SYSTEM had **no worked example of any clothing
change**, and its only clothing-adjacent teaching was cautionary
(rule 3: "she reaches for the coat is not wearing it"). Turns 37–38
correctly obeyed that caution (touching, fumbling with the pin); the
model then carried the caution into turn 39, where the act completed
in gradual, lyrical phrasing rather than direct verb-object form.

**Fix applied (2026-06-12).** The itemEvents bullet now teaches the
positive case: "Completed wardrobe changes matter most, however
gradual or tender the prose ('I unwrap her scarf and lay it on the
table' → remove + place). Fumbling with a garment is not removal;
finishing the act is." Budget intact (2566/2600); structural test
pins the wording. Note: this strengthens the same prompt that entry
1's still-open affinity reshape targets — if undress detection still
under-fires in play, the next lever is a full worked example, which
needs budget trimming elsewhere.

**Verdict revised (same day, entry 20).** The prompt example was kept
but was NOT the root cause: the live model extracted the removal
perfectly once provider-side constrained decoding was bypassed. See
entry 20.

Status: **closed (root cause was entry 20; prompt example retained).**

## 20. Structured-output degeneration: every agent was silently lobotomized (2026-06-12)

**Observed.** A fully explicit hijab removal (input AND narration both
stating it; "Her hijab comes away entirely, pooling on the couch arm")
still produced `itemEvents: []` — after entry 19's prompt fix.

**Investigation.** Live probes against the real model
(google/gemini-2.5-flash) with the production prompt: the
`generateChecked` path returned hollow output (empty itemEvents AND
empty activityUpdates, plus a bogus same-room movement) for mundane,
intimate, and clinically-reframed variants alike — so NOT content
refusal. The same model, same prompt, called as plain text ("respond
with only the JSON"): perfect extraction, `remove` + full activities.
Root cause: `generateChecked` used AI-SDK `Output.object`
(provider-side constrained JSON decoding), which degenerates on this
model — and because every agent schema defaults all fields, the
hollow objects validated cleanly and the repair/degrade ladder never
fired. **Hollow-but-valid is invisible to the resilience ladder.**
Every consumer was affected: simulant, archivist, continuity,
director, forge sections, scene composer, inner notes — this likely
also explains entry 1's affinity silence and turns of missing state
across sessions.

**Fix applied (2026-06-12).** `generateChecked` now generates plain
text with the JSON Schema rendered into the system message
(`z.toJSONSchema`), then extracts (`extractJsonObject` — fence/prose
tolerant, pure, tested) → `JSON.parse` → zod parse; malformed output
throws into the existing repair→degrade ladder, which is now the real
enforcement. Verified live: all three probe registers extract the
removal correctly with full activities. docs/resilience.md §3
updated. Watch item: "hollow-but-valid" remains structurally possible
from a lazy model — if it recurs, the counter is required-ish fields
or an emptiness heuristic + repair nudge.

Status: **closed (fixed — verified by live probe; play-test the
session).**

## 21. Intimate register: coat-drive interruptions + a self-input false positive (2026-06-12)

**Observed.** During a long kissing scene Fatima repeatedly brought up
a coat drive (turns 44/46/48); separately the continuity agent flagged
the narration for "the player tastes tea on Fatima's tongue" — which
the player's own input said — as invented player dialogue, putting a
nonsense correction directive into the brief.

**Investigation.** "Coat drive" is not a story thread (none exists) —
it arrives via facts/notes plus prose rule 6's demand that one NPC
action per turn be self-motivated: in a scene whose only "business"
is intimacy, the model reaches for the one errand it knows. The tea
flag was entry 5's rule 5 over-generalizing from speech to sensations.

**Fixes applied (2026-06-12).** Prose rule 10: "Match the scene's
emotional register: in intimate or emotionally charged beats, stay
inside the moment — no errands, reminders, logistics, or unrelated
topics from any character unless the player raises them first."
Continuity rule 5 gains: "Restating the player's typed words,
actions, or sensations is never invention" (budget 2595/2600). Both
pinned by structural tests. Broader intimate-gameplay work (proximity
tiers, engagement, exposure-mask staging) remains phase 3 — these are
the prompt-level patches.

Status: **closed (fixed — verify in play).**
