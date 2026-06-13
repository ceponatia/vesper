# Multi-character sessions: presence, movement, off-screen life — brainstorm

Status: **resolved and split into specs** — this doc remains the
alternatives/rationale record. Decisions:
[multi-character-presence-and-movement-decisions.phase3.md](multi-character-presence-and-movement-decisions.phase3.md).
Specs (index + build order in
[multi-character-overview.phase3.md](multi-character-overview.phase3.md)):
[time-and-travel-spec.phase3.md](time-and-travel-spec.phase3.md) ·
[cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md) ·
[presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md) ·
[proximity-spec.phase3.md](proximity-spec.phase3.md) ·
[npc-movement-spec.phase3.md](npc-movement-spec.phase3.md) ·
[offscreen-simulation-spec.phase3.md](offscreen-simulation-spec.phase3.md) ·
[character-memory-spec.phase3.md](character-memory-spec.phase3.md).
Related: [dynamic-character-introduction-spec.phase3.md](dynamic-character-introduction-spec.phase3.md)
(emergent cast — how characters *enter* the system; these docs are about
how many of them *live* in it at once).

## Problem

Worlds will eventually carry a large cast of varying tiers — companions,
recurring NPCs, and simple characters (monsters, crowd, one-scene extras)
that don't need full narration. Sessions need:

1. **A presence model** — where every character is, and a hard rule for who
   appears in the player-facing narration: if the player cannot **see or
   hear** a character, that character is not narrated. Exception: remote
   channels (phone call, text message). Absent characters still get to
   change world state and accrue memories — they just do it off the page.
2. **Symmetric perception** — the same see/hear rule applied *to* NPCs:
   a character facing the sink does not know what the player did behind
   her back. The game records it; the character doesn't learn it unless a
   sense plausibly carried it. (Leave room for non-human senses later.)
3. **Realistic movement** — characters move about the map for *reasons*
   (schedules, needs, goals, social pull), not because an LLM was offered a
   list of adjacent rooms and picked one.
4. **Stay/follow/approach behavior** — grounded in actual interaction
   (dialogue or direct actions aimed at the character, not mere
   co-presence) and in affinity (friends approach and follow; strangers
   ignore the player absent a reason).

## What exists today (inventory)

More of this is built than it might seem — the gaps are specific:

- **Location tracking**: `session_participants.location_id`; simulant
  `movements` are validated against the adjacency graph in the merge
  (adjacent links only, invalid moves dropped with a diagnostic).
- **Follow scores** (`engine/scene.ts` → `computeFollowScores`):
  deterministic, computed pre-turn when the player moves. Terms:
  relationship warmth (count of `relationship` facts naming the NPC),
  interaction recency, activity stickiness (busy NPCs stay), whether the
  input addressed them, and a "wants to be alone" regex. Output is
  *guidance for the narrator*, not a hard rule.
- **Schedules**: `CharacterProfile.schedule` (minute-of-day windows →
  location + activity). Merge step 4 applies them to **off-screen** NPCs on
  clock advance; on-screen NPCs are never teleported; an explicit simulant
  movement wins over the schedule.
- **Presence**: implicitly co-location-with-player. There is no perception
  model, no remote channel, and no prompt-side hard rule excluding absent
  characters (the narrator just isn't given much about them).
- **Roles**: `companion | npc` (plus `player`). No tier concept.
- **Affinity**: does not exist as state. The follow-score warmth term
  (fact-count) is the only proxy — monotonic, can't go negative, can't
  distinguish "friend" from "enemy with a thick file".
- **Off-screen agency**: none. Off-screen NPCs snap to schedule locations;
  they perform no actions, change no state, learn nothing.

Two notable wrinkles in the existing behavior:

- **Schedule moves are teleports.** `merge.ts` sets `locationId` directly
  to the scheduled location — no path through the graph. Fine as a v0, but
  it means the player can never *catch someone in transit*, and a character
  can "move" through a locked door or across the map in one tick.
- **Follow recency may count co-presence as interaction.** The user rule is
  stricter: only dialogue or direct actions *targeting the character*
  count. Worth verifying what feeds `turnsSinceInteraction` and tightening
  it to intent-detected targets.

## Presence model: perceivability, not co-location

Make presence a **deterministic pre-turn computation** (alongside intent
detection and follow scores — no LLM), producing per-character presence
channels:

| Channel | Condition | Narrator rights |
| --- | --- | --- |
| `sight` | co-located with the player | full presence: appearance, actions, dialogue |
| `sound` | adjacent location + audibility (see below) | voice, noises, no visual detail ("you hear Mara arguing through the wall") |
| `comms` | active call/text link with the player | dialogue/messages only; no environment, no body language beyond what voice carries |
| `absent` | none of the above | **must not appear in narration at all** |

Enforcement is two-sided, consistent with how the engine already handles
narration/state divergence:

- **Prompt side**: the turn context lists present characters explicitly and
  carries a hard rule — characters not listed do not act, speak, or appear.
  (Today the canonical-facts block renders all participants; it should
  render absent participants' *identity* for continuity but flag them
  "not present — do not narrate".) Actually — simpler and stronger: only
  present characters get full canonical blocks; absent ones get nothing or
  a one-line roster. Less prompt, fewer temptations.
- **Continuity side**: a new violation class — `narrated_absent_character`.
  The continuity agent already receives the scene; give it the present list
  and let it flag ghosts. Violations fold into next-turn corrections as
  usual.

### Comms as a temporary presence link

A phone call/text thread is a **non-spatial presence edge**: a runtime
entry like `{ kind: "call" | "text", withParticipantId, since }` on session
runtime. While active, the remote character is `comms`-present: they can
speak, react, and *their* state agents treat the conversation as an event
they participated in — but the narrator gets only their channel-appropriate
slice. Opened/closed by simulant events (`itemEvents` already model device
use loosely; a small `commsEvents` field is cleaner). Gated by world style
and item availability — a medieval world has no phones, but a sending-stone
or familiar is the same mechanic with different flavor, so the *mechanism*
should be style-agnostic and the *availability* authored.

### NPC-initiated comms (the interruption problem)

Player-initiated calls/texts are easy — the player chose the moment.
NPC-initiated is the hard case: a character "deciding" to call mid-task
either hijacks the scene or gets silently swallowed. The way out is to
notice that an incoming call is **an offer, not an event** — the phone
ringing doesn't move the story; *answering* does. So:

- The world-tick (or a schedule entry like `calls the player, 21:00`) emits
  a `commsIntent: { fromName, kind: "call" | "text", urgency, gist }`. The
  merge queues it on session runtime — nothing happens to the current turn.
- **Texts are naturally async** and solve most of the problem by
  themselves: they arrive silently, a pending-messages line rides in the
  turn context ("Mara texted: *you home yet?*"), and the player reads/
  replies whenever. No interruption convention needed at all.
- **Calls** surface at the next turn boundary as woven narration — "your
  phone buzzes; Mara's name on the screen" — and the player answers,
  ignores, or silences *as their action*. An unanswered call rings out:
  it becomes a missed-call fact and, knowledge-ledger-wise, the caller
  *knows they were ignored* — which is exactly the texture that makes
  NPC-initiated contact feel real rather than scripted.
- **Urgency tiers** keep it from being noise: low ⇒ text instead; normal ⇒
  one ring-out, maybe a follow-up text; urgent (rare, plot-bearing, and
  arguably director-sanctioned rather than world-tick-invented) ⇒ the call
  repeats / the character escalates to showing up in person — which is just
  a social-drive move, already modeled.

The principle: **NPCs decide *to reach out*; the player decides *when the
story stops for it*.** The character's agency is preserved (they formed the
intent, they remember the outcome), the player's flow is never hijacked,
and a stack of missed calls after a long dungeon crawl is its own
storytelling.

### Audibility (the `sound` channel)

Suggest **phasing this in second**. Sight + comms cover the core rule; the
sound channel needs per-link audibility data on the location graph
(soundproof? open archway? how loud is the activity?) and a "loudness"
notion on activities. Worth designing the location-link schema so an
`audibility` field can be added later without migration pain, but v1 ships
without it. Counterpoint: eavesdropping is *delicious* gameplay (secrets +
the lore-unlock mechanic pair beautifully with overheard facts), so it
shouldn't slip far.

## Symmetric perception: what NPCs can detect

Everything above is player-centric — *who can the player perceive*. The
same model has to run the other direction: **what can each NPC see, hear,
or otherwise detect**. The canonical failure: an NPC faces the kitchen
sink, the player does something behind her back, and she *feels* it and
reacts. Prompting alone has not fixed this and won't — the narrator has no
information distinguishing "in the room" from "aware of it", so it defaults
to omniscience. The fix is the same as everywhere else in this engine: give
the model a deterministic fact instead of asking it to exercise restraint.

Note the granularity jump: the player-side channels above resolve at
*location* level (which room), but the kitchen-sink case is **within one
location** — same room, didn't perceive it. Locations have no geometry, so
this can't be line-of-sight math; it has to be an abstraction:

### Attention × salience

Two small vocabularies, one lookup:

- **NPC attention state** — derivable from state the engine already tracks
  (`activity`, `posture`), plus one new field, roughly:
  `engaged_with(target)` (conversing with someone, watching the player) /
  `absorbed(task)` (washing dishes, reading — the sticky activities the
  follow scorer already regexes) / `idle_alert` (default) /
  `asleep_or_impaired`.
- **Event salience** — every notable action gets a perceptibility profile,
  starting with two channels: `visual: obvious | subtle` and
  `audible: loud | quiet | silent`. Pocketing a key while her back is
  turned: subtle + silent. Shattering a plate: obvious + loud.

Attention is **derived** from `activity`/`posture` for v1 (decided — no
new per-turn writes; an explicit `attendingTo` field is deferred until
covert-watching scenarios matter). One adopted refinement: **perception
hints on objects/affordances**. We won't model where furniture sits in a
room, but the *kind* of object implies awareness — a kitchen sink usually
faces a wall or window, so "washing dishes" implies facing away from the
room; a bar faces the floor; a desk absorbs; a doorway position sees both
ways. An optional hint on the item/affordance definition
(`attention: absorbing | faces_away | outward | …`) sharpens the derived
attention state for free wherever it's authored, and defaults to neutral
where it isn't — same fill-in-as-needed economics as every other registry
vocabulary.

The witness check per event, per co-located NPC, is then a table lookup:
`absorbed` + behind-them + subtle/silent ⇒ not perceived; anything `loud` ⇒
perceived by everyone in the location (and adjacent ones, once the sound
channel ships); `engaged_with(player)` ⇒ perceives almost anything the
player does. Deterministic, testable, no vibes.

### Where it runs (this is the part prompting can't do)

The reason prompting failed: the narrator writes the player's action *and*
the NPC reactions in the same pass, so by the time anything could "check"
perception, the reaction is already on the page. So the check must run
**pre-turn, on the player's declared action**:

1. Intent detection (already deterministic, already classifies the input)
   gets a salience layer: sneak markers ("quietly", "while she's not
   looking", "behind her back"), action verbs with known loudness — produce
   the input's perceptibility profile. Default: **obvious** — sneaking must
   be declared (decided; it costs the player one word and reads as better
   fiction). One disambiguation rule (decided): **a stealth marker only
   counts as stealth when there's someone to conceal from** — a third
   party present, or an unaware NPC the action targets. "I quietly tell
   her…" during an intimate scene at `contact` proximity is intimacy, not
   a sneak attempt; the same words with her unaware mother in the room is.
   Concealment target present ⇒ stealth check; absent ⇒ the marker is just
   tone.
2. Cross with each present NPC's attention state → a per-NPC awareness
   block in the turn context: *"Mara — at the sink, back turned, absorbed:
   she does NOT perceive quiet actions behind her this turn; she WILL react
   to anything loud."* The narrator is no longer asked to be restrained; it
   is told what each character knows, which is the kind of instruction it
   actually follows.
3. Post-turn, the simulant tags its events with the same salience
   vocabulary (one small field), and the merge computes the **actual
   witness set** per event — which is exactly the `witnessed_by` stamp the
   per-character memory section needs. Perception is the write-side of the
   knowledge ledger: presence said *who was in the room*; perception says
   *who actually knows*.
4. Continuity gets the violation class it's been missing:
   `reacted_to_unperceived_event` — the agent receives the awareness blocks
   and flags any NPC who responded to something they couldn't have
   detected. Folds into next-turn corrections like every other violation.

**The game always knows; the character doesn't.** The fact is recorded
either way ("player took the key") — with `witnessed_by` empty or
player-only. That split is what enables real consequences later: Mara can't
react to the *taking*, but she can react to the key being *gone* the next
time she attends to the drawer — discovering the consequence, not the act.
(Deferred-discovery mechanics — diffing an object's state against when a
character last perceived it — are a v2+ riff, but the witnessed-by data
makes them possible.)

### Cross-location NPC perception (hearing through the wall)

Perception symmetry extends across locations too: the same link
`audibility` that lets the *player* hear Mara arguing through the wall lets
**Mara hear the player** — or hear another NPC — from the next room. No new
machinery: the witness-candidate set for a `loud` event is "co-located NPCs
+ NPCs in audibility-linked locations", the same table with one more row
source, and the resulting knowledge is `sound`-channel-shaped (they know a
crash happened and roughly who was yelling; they didn't *see* anything).

Honest assessment: rarely load-bearing, so it shouldn't drive the schema —
it ships whenever the sound channel ships, and until then `loud` stops at
the room boundary. But the specific use cases it unlocks are exactly the
ones worth designing toward when it lands: the neighbor who heard the
argument (and now *knows*, ledger-wise — gossip fuel), the guard who heard
glass break one room over and comes to check (a witnessed-event movement
drive — note that's the one drive that *requires* cross-location
perception to exist), and the NPC eavesdropping on the player as the
mirror of the player eavesdropping on them. Worth a line in the link
schema's design now precisely so none of these need a migration later.

### Extensible senses (a registry, eventually)

Sight and hearing with attention states cover v1, but the design should
leave the door open the usual way: a **detection-channel registry**
(`sight`, `hearing`, later `scent`, `tremorsense`, `empathic`, whatever a
world needs) and an optional per-character sense profile on
`CharacterProfile` (acuity per channel — a hound hears `quiet` as `loud`
and smells what no human notices; a construct never sleeps). Event salience
profiles grow a field per new channel. Registry data edits, no migrations,
per the extension-point rule. Don't build any non-human sense in v1 — just
don't hardcode `{visual, audible}` so deep that the third channel is a
rewrite.

## Proximity: the scale between "same room" and "touching"

The model so far resolves *which location* (presence) and *who noticed*
(perception). A third scale matters for intimacy, combat, whispering, and
staging in general: **how close two characters are**. It belongs in this
doc because it feeds both systems already designed here — proximity
modulates perception channels, and contact constrains movement — and
because the granular end lands on the body-location registry the engine
already has.

### Pair-proximity tiers

No geometry, so — same trick as attention — a small ordinal vocabulary,
tracked **per participant pair, scene-volatile** (unlike affinity, which is
durable; proximity resets when either party changes location):

`apart` (same room, default) → `near` (conversational) → `close`
(whisper/arm's reach) → `contact` (touching) → `entwined` (held,
grappling, intimate — disengaging is itself an action)

What each tier gates:

- **Perception acuity**: a whisper is `quiet` audible only at `close`+;
  at `contact`/`entwined`, `subtle` actions on *that partner* are always
  perceived (you notice what's done to you), and the future scent channel
  keys almost entirely off this scale — the foot-near-the-face example is
  scent salience scaling with the proximity of a specific body part to the
  perceiver's senses, which is the registry-channel mechanism doing its
  job at maximum granularity.
- **Movement constraint**: `contact`/`entwined` pins both parties. The
  movement scorer treats a pinned character as immobile; simulant
  `movements`/`activityUpdates` that contradict an engagement drop with a
  diagnostic (`merge.movement.engaged`) unless the same turn broke contact.
  Stronger, decided: **`entwined` is a hard movement lock** — you logically
  *cannot* change location while entwined, so a location change for an
  entwined participant is merge-invalid (same class as moving through a
  non-adjacent link) unless the turn's events include the disengage. Not
  guidance — an invariant, testable like the placement-exclusivity rule;
  and the narrator's awareness block says so plainly — *"Mara is lying
  back, her left foot in the player's hands: she does not get up, cross
  the room, or change position this turn without first disengaging, and
  disengaging is a narratable beat, not a silent teleport."* Same
  philosophy as everywhere: don't ask the narrator for restraint, hand it
  a fact.
- **Reach**: combat (weapon length vs tier), pickpocketing, handing
  someone an object, whispering out of others' earshot — all become "does
  the action's required tier match the current tier" checks.

### Location scale — what "apart" means here

Proximity tiers mean different things in different spaces: in a bedroom,
`apart` still supports easy conversation; on a location that is an entire
stretch of beach, `apart` can mean a silhouette down the shore. Rather
than geometry, give locations one ordinal **`scale`** field:

`intimate` (closet, car interior) → `room` (default) → `hall` (great
hall, warehouse, tavern floor) → `open` (street, plaza, courtyard) →
`expanse` (beach, fields, forest)

What it modulates — all lookups, no new mechanisms:

- **Conversation gating**: at `intimate`/`room`, any tier converses
  normally; at `hall`, `apart` means raised voices; at `open`/`expanse`,
  conversation needs `near`+ — shouting is a `loud` event everyone gets.
- **Perception at distance**: scale fixes a real hole — at `expanse`,
  co-location no longer guarantees the `sight` channel's full fidelity.
  Cheapest representation: one extra tier, **`distant`**, *only reachable
  at `open`/`expanse` scales* — visible as presence/silhouette, out of
  earshot for anything under `loud`, `subtle` actions imperceptible. At
  room scales the tier simply doesn't exist, so small locations pay no
  complexity for it.
- **Default pair proximity on entry**: walking into a bedroom where Mara
  is puts you at `near`; arriving at the beach where she's walking puts
  you at `distant`/`apart` — approach is then either an explicit beat or
  implied by the player's action ("I walk over to her"), via the same
  implicit-transition machinery.
- **Intra-location travel**: crossing an `expanse` costs minutes;
  scale supplies a default crossing cost so the clock moves when the
  player trudges the length of the beach (composes with §Time's
  resolution order as a travel-shaped duration).

When *not* to use scale: if different parts of a big place are
narratively distinct (the pier vs the dunes vs the boardwalk), that's
multiple locations with links — the existing tool. `scale` is for when
subdivision is overkill and the place is uniform; it should never become
a poor man's sub-location system. (Distinct from the `area` tag in §Time:
`area` groups *several* locations under one label for travel defaults and
prompt grouping; `scale` describes the size of *one*.) The forge can suggest scale from the
location description ("a vast stretch of beach" is not subtle), with
`room` as the safe default.

### Body-level engagement (the granular end)

`contact`/`entwined` can carry optional detail referencing the existing
body-location registry: `{ holderName, partnerName, part: bodyLocationId,
how }` — "player holds Mara's left foot". This is the wardrobe-coverage
pattern pointed at a new use: held parts are *occupied* (and imply
posture — a held foot means seated or lying, which constrains
`activityUpdates`), the same way placement exclusivity already reasons
about held/worn items. Don't over-model: one engagement list per pair,
not a physics rig — its job is to stop impossible narration and sharpen
sensory context, not simulate joints.

### Implicit transitions — the player never narrates approach

"I take her left foot into my hands" must just *work*: intent/simulant
infers the implied traversal (`apart → near → contact` + engagement) and
the merge applies it. Requiring "I move within range, I extend my hands,
I…" is the failure mode, not the feature. Mechanically this is the
existing shape — the simulant already emits state deltas inferred from
narration; proximity events (`proximityEvents: [{ a, b, toTier,
engagement? }]`) are one more small field, validated against the tier
ladder (no `apart → entwined` teleports without the narration actually
covering it — adjacent-tier steps, or multi-step when the narration
clearly spans it).

### Contested transitions (the dice-roll idea)

**Decided: score-first, randomness last** — a pure dice roll feels
arbitrary in a narrative game, and the engine's house style is
deterministic scores surfaced with reasons (follow scores are exactly
this). Also decided: combat isn't in the game yet, so v1 events are
almost all consensual — build the consenting-context factors now, flesh
out contested/combat factors when a combat system exists. A proximity
*advance attempt* gets a deterministic check from context factors:

- consenting context: affinity stage, current tier (already `close`?),
  scene mood (meters — arousal/stress), relevant facts and norms ⇒
  intimate advances between high-affinity characters at `contact` pass
  trivially — no roll worth mentioning;
- contested context (combat grab, unwelcome touch, pickpocket): opposed
  factors — target's attention state (absorbed targets are easier to
  grab), conditions, later combat stats when that system exists ⇒ the
  score lands in a band: clear success / clear failure / **genuinely
  uncertain**, and only the uncertain band gets a seeded roll (seeded like
  `fillCoreVisualDefaults` — same situation, same outcome; no
  `Math.random` vibes).

Outcome is surfaced as pre-turn guidance with reasons, narrator plays it
("she twists free — likely-resist: stranger, alert, hostile"), simulant
records what actually happened. The check mechanism is general enough
that combat reach/grapples later are the same code path with more factors
— design the factor list as extensible, build only the social/intimate
factors now.

## Off-screen life: simulation level-of-detail

The user goal — absent characters "still get to change world state, update
their memories" — cannot be a per-character LLM call every turn. With a
cast of 30, that's 30 extra agent calls per turn for characters the player
isn't even looking at. Borrow the open-world game answer: **LOD tiers**.

| LOD | Who | What runs per turn |
| --- | --- | --- |
| **live** | present characters (sight/sound/comms) | full pipeline as today: narration, simulant, facts |
| **active** | off-screen but warm: companions, recently-interacted NPCs, characters named in open story threads | a single batched **world-tick** agent call (below), every N game-minutes — not necessarily every turn |
| **background** | scheduled NPCs nobody is currently entangled with | deterministic only: schedule-driven movement (today's behavior, upgraded to traversal), meter drift |
| **dormant** | extras, unspawned monsters, one-scene characters | nothing until encountered |

Characters move between tiers by simple rules (interaction promotes;
turns-since-relevance demotes), with caps on the active set (e.g. 6–8) so
cost is bounded regardless of cast size.

### The world-tick agent

One batched call, same `generateChecked` discipline as the post-turn four:
input is the active-tier roster (location, activity, schedule, goals, top
meters, affinity edges to nearby characters) plus elapsed game time; output
is a small schema of off-screen events:

```ts
{
  offscreenEvents: [{
    participantName,
    kind: "action" | "social" | "move",
    summary,                  // one sentence, becomes their memory
    toLocationName?,          // for moves — validated like simulant moves
    withName?,                // for social — NPC↔NPC interaction
    driveCited,               // see Movement § — must name a real drive
  }]
}
```

Crucially this is **fire-and-forget relative to the turn**: it can run in
the slow lane (like `character_forge`) and merge at the next turn boundary.
A turn is never slower because the blacksmith had a busy afternoon.

### Affordance lists: the zero-inference floor

Off-screen activity doesn't strictly *need* inference at all: give
locations **affordance lists** — things a character may plausibly do there,
derived from the location itself, furniture/items present, other NPCs
present, and the character's own personality/preferences — and let the
backend pick weighted-random. "Reads by the window", "argues with the
cook", "restocks shelves". Deterministic, free, and never wrong in a way
anyone can disprove.

Preference is still inference (richer, situation-aware memories), but the
two compose rather than compete:

- **Affordances are the grounding vocabulary for the world-tick.** The
  agent picks *from* (or riffs *on*) the affordance list, the same way
  simulant moves must resolve to real locations — which turns "is this
  activity plausible?" from a judgment call into a lookup, exactly the
  propose-and-audit shape used everywhere else. An off-list activity needs
  a citable drive; otherwise it drops with a diagnostic.
- **Affordances are the austerity fallback**: demo mode, agent failure, or
  a per-world "cheap off-screen sim" setting all degrade to weighted-random
  affordance picks — a *degraded default* in the resilience.md sense, not a
  different system. The world stays alive, the memories just get plainer.
- They also feed movement drive #2 for free — the `seeks` affordance
  matching proposed in §Movement is the same vocabulary.

Where they live: an `affordances` tag list on locations (authored +
forge-suggested), composed at runtime with item-derived affordances
(a piano present adds "plays the piano") and filtered by character
personality/preference tags. Registry-flavored data, no migrations.

### Lazy backfill (the cheap alternative for the long tail)

For background/dormant characters, don't simulate at all — **backfill on
encounter**. When the player walks in on a character who hasn't been
simulated for hours, a catch-up step (or just the narrator, given schedule
+ last-known state + elapsed time) establishes what they've been doing.
This is how most games fake it, and players cannot tell the difference for
characters they weren't watching. The active tier exists precisely for the
characters where they *could* tell (the companion who said she'd run an
errand and should plausibly have done it).

## Per-character memory (NPCs as independent entities)

The original vision: every NPC is an independent entity with their own
memories, desires, preferences, and schedules. Schedules exist;
desires/preferences are profile fields away; **memory is the real gap**,
and it's the root of the most common failure in LLM games — memory
pollution, where every character somehow knows everything the context
window knows. The facts system today is global and subject-tagged: facts
are *about* someone, never *owned by* someone, and the narrator sees the
top-5 regardless of who present could actually know them. With one
companion this is invisible; with a cast it leaks ("how does the innkeeper
know about the cave?").

Two layers, mirroring the player-side episodic/semantic split that already
works:

1. **Knowledge ledger (semantic)** — facts gain *knowers*. A character
   knows a fact if they **perceived** the originating event (not merely
   shared the room — the symmetric-perception witness check above computes
   this per event), were told it (comms, social world-tick events, "catch
   you up" dialogue), or it's tagged common knowledge. Scene retrieval filters character-bound facts
   by what present characters actually know. Buys: secrets that hold,
   gossip propagation, alibis, and it composes with lore unlock tags.
2. **Character episodes (episodic, vector)** — per-character experience
   rows: `owner_participant_id`, summary text, embedding. Sources: turns
   they were present for (channel-appropriate — a `comms` participant
   remembers the conversation, not the room), world-tick `summary` events,
   and backfill summaries. Retrieved per-owner when the character is in a
   scene or being world-ticked, so their dialogue and choices draw on
   *their* history. All the infrastructure exists: pgvector, embedder
   isolation, the episode retrieval pattern — this is a new table plus an
   owner filter, not a new system.

**Pollution prevention is just the owner/knower filter at retrieval time.**
That's the whole trick: one query predicate, not an architecture. The hard
design choice is write-side cost:

- **Shared-event rows + knower links (recommended start)**: one memory row
  per event, linked to each witness. Cheap (no extra inference), and the
  retrieval filter alone kills cross-character pollution. Everyone present
  remembers the *same* text — slightly flat, but correct.
- **Per-witness perspective summaries**: each witness gets their own
  *colored* memory of the event ("she laughed at my joke" vs "I laughed to
  be polite") — the lush version, and what makes characters feel like
  people. Costs one inference per witness per event; reserve it for
  major-tier characters and emotionally significant events (big affinity
  deltas are a decent trigger), shared rows for everyone else. Tiering
  applies to memory fidelity exactly like it applies to simulation
  fidelity.

Phasing hedge, cheap enough to do immediately: **stamp `witnessed_by`
participant ids on every new fact and episode now**, write-only, unused by
retrieval — so the history exists the day the filter ships, instead of all
pre-existing memories being knower-less.

## Movement: drives first, destinations second

The user's sketch — score "how likely does X move to adjacent Y" and have
the LLM justify it, then validate the reason — has the right instinct
(reasons must be real) but the wrong order. Per-edge likelihood scoring is
combinatorial (every character × every adjacent room, most scores
meaningless), and an LLM asked to justify a choice it already made will
*always* produce a plausible-sounding reason — post-hoc validation of
free-text rationales is validating vibes with more vibes.

Invert it: **reasons generate candidate moves; nothing moves without a
drive.** Deterministic drive evaluation, in the merge or world-tick:

1. **Schedule** — upcoming entry within a lead-time window → move toward
   its location. (Becomes a drive instead of a teleport.)
2. **Needs** — meters past thresholds map to location affordances: low
   `energy` → home/bed, low `hygiene` → bath. The meter registry is already
   the extension point; add an optional `seeks` affordance hint per meter,
   and an `affordances` tag list on locations. Registry data edits, no
   migration — consistent with the extension-point rule.
3. **Goals/threads** — open story threads naming the character, or an
   authored `goals` field on the profile, can pin a destination ("watches
   the docks at night").
4. **Social** — high-affinity edge to a character at a known location →
   pull toward them. (Friends seek each other out; this is also how an NPC
   plausibly "happens to" show up where the player is.)
5. **Inertia** — the default. No drive above threshold ⇒ stay put. Most
   characters, most turns, don't move — staying must be the zero-cost
   default or the world churns.

Each drive emits `(destination, urgency, reason)`. Highest urgency above
threshold wins. The LLM's role shrinks to where it adds value:

- The **world-tick agent may propose** moves for active-tier characters in
  response to *narrative* developments no deterministic rule sees ("she
  overheard the threat and is fleeing") — but every proposal must cite a
  drive or event the validator can confirm (the thread exists, the meter is
  actually low, the event happened in a turn she was present for).
  Uncitable moves drop with a diagnostic (`merge.movement.unmotivated`) —
  exactly the propose-and-audit shape the merge already uses for item
  events and the emergent-cast spec uses for introductions.
- The **narrator** narrates arrivals/departures it's told about; it never
  decides them for non-present characters.

This is the same architecture as the existing follow scores — deterministic
score, LLM informed, guidance surfaced with reasons — extended from "follow
the player" to "move at all". Precedent holds.

### Traversal, not teleportation

Destination chosen by drive; **route = shortest path on the location
graph**, traversed over ticks at the link `travelMinutes` rate (§Time
below). Consequences worth
having: the player can pass someone in a corridor, see someone leaving,
follow someone, or find that the person "on their way" hasn't arrived yet.
Background-tier characters can keep cheap multi-hop teleports when the
player is far away (LOD applies to fidelity of *transit* too — nobody can
observe the difference); active-tier characters near the player traverse.

## Time: travel durations and action durations

Two halves of the same planned (not yet documented) **action-based timing
system**: a turn is one *narrative beat*, and the clock advances by however
long the beat actually took. A turn that walks across town passes 10
minutes; a turn that showers passes 20; a turn of conversation passes 1.
Today the clock advances via the simulant's `minutesAdvanced` (clamped
1–480) — an LLM *estimate* of elapsed time. The direction here is to make
the dominant cases **deterministic and authored**, with the estimate as the
fallback for everything else.

### Travel time on links

Locations stay single entities (no return of companion-app collections) —
`apartment-102-living-room`, `apartment-102-kitchen` — and the *link*
carries the cost. `world_links`/`session_links` rows currently hold just a
`label`; add:

```ts
travelMinutes: number   // default 1 — adjacent-room transitions
```

Living room → kitchen: 1 (sub-minute movement rounds to the turn minimum).
Apartment entrance → downtown office: 10–15 — still **one turn**, the clock
just jumps. Travel time is a link property, not a location property,
because the same place can be near one thing and far from another.

Knock-on effects, all good ones:

- The movement scorer gets a real cost input: a needs-drive can prefer the
  closer bath; a schedule drive knows when to *start walking* (lead time =
  path cost, computed instead of guessed).
- NPC traversal (§above) ticks along paths using the same numbers the
  player pays — symmetric world.
- Meter drift, condition expiry, and schedule windows all interact with big
  clock jumps correctly already (drift is `perHour × hours`).

Two representation refinements worth considering, short of collections:

- **An `area` tag on locations** (`"apartment-102"`, `"downtown"`) — *not*
  a container, just a label. Buys: default travel times (intra-area links
  default 1, inter-area links default higher unless authored), prompt
  grouping ("elsewhere in the building"), a sane map UI later, and a
  natural scope for the future `sound` channel. Cheap, optional, and it
  dies gracefully if unused.
- **No transit pseudo-locations** for v1. A 10-minute walk is a clock jump
  inside one turn, narrated as such; modeling "the street between" as a
  place the player occupies mid-turn adds state for no story. If a journey
  is long enough to *be* a scene (a day's ride), that's a real authored
  location ("the coast road"), not a mechanism.

### Action durations

Same idea, off the map: define **action events with durations** in the
backend so common multi-minute activities pass time without 20 turns of
narration or an LLM guess. A `shower` is one turn, 20 minutes.

Shape: a small **action-duration registry** (the registry pattern —
vocabulary as data, one file, no migrations):

```ts
{ id: "shower", minutes: 20, aliases: ["bathe", "wash up"], … }
{ id: "nap",    minutes: 90, … }
{ id: "meal",   minutes: 30, … }
```

Resolution order in the merge, replacing trust in the estimate where
something authored matched:

1. **Travel**: player moved ⇒ path cost from link `travelMinutes`.
2. **Registered action**: intent detection (which already classifies input
   deterministically) or the simulant's `activityUpdates` matches a
   registry entry ⇒ its duration.
3. **Simulant estimate**: everything else keeps today's `minutesAdvanced`
   (clamped) — conversations, freeform scenes, weirdness.
4. Compose by **max, not sum**, when several apply (decided — never
   double-counts overlapping activities; the undercount on true chains is
   small and one-directional).

Adjacent decision: a **soft cap on chained significant actions per turn**
(~2). "I go home and shower" is one beat; "…and then cook dinner" should
likely stop after the shower — a lot of world can happen in 30 minutes,
and the off-screen systems deserve a chance to interleave. Caveats
recorded: this may not matter in practice (tune in play before building
anything elaborate), and the classifier must not start calling every small
verb an "action" — only registered-duration events count toward the cap.

Registry durations can also drive **meter effects** (`shower` ⇒ hygiene
restored) instead of relying on the simulant to remember — same entry, one
more field. And affordance picks in the world-tick reuse the same
durations, so off-screen time spends at the same rate as on-screen time.

## Stay / follow / approach

`computeFollowScores` already implements most of the stay/follow rules; the
deltas to match the stated design:

- **Tighten "interaction"** to intent-detected targeting: dialogue directed
  at the character or direct actions on them. Being in the same room while
  the player talks to someone else or fiddles with scene objects must not
  feed the recency term.
- **Schedule-conflict term**: an active or imminent schedule entry
  elsewhere is strong stay/leave pressure that interaction warmth does not
  casually override. Skipping work for the player should require *high*
  affinity, and when it happens it's a narratable event ("she hesitates,
  then unties her apron") — surface it in the guidance so the narrator
  plays it, rather than silently zeroing the term.
- **Affinity gate**: below an acquaintance threshold, follow likelihood is
  capped near zero regardless of interaction count this scene — a stranger
  who chatted for two turns does not trail the player home — unless a drive
  supplies a concrete reason (guard escorting, guide hired, predator
  stalking). Drives can override the gate; small talk can't.
- **Approach scores** (new, symmetric case): when the player *enters* a
  location, who acknowledges/initiates? Same term structure run in the
  other direction — affinity, whether the character is busy, schedule,
  open threads involving the player. High → guidance "X greets the player /
  approaches"; low → "X ignores the player unless engaged". This is the
  "friends approach, strangers ignore" rule, and it's nearly free given the
  existing machinery.

## Affinity as first-class state

Fact-count warmth can't express dislike, can't cool off, and double-counts
chatty histories. Proposal:

- **Per-edge relationship state**, player↔NPC *and* NPC↔NPC (the latter is
  what makes off-screen social simulation and approach behavior among NPCs
  possible later): a scalar (−100..100) plus a derived **stage** from a
  registry — `hostile / wary / stranger / acquaintance / friendly / close /
  devoted` — per-world overridable, a data edit like every other registry.
  Stages, not raw numbers, go in prompts (narrators handle "friendly"
  better than "0.62") and gate behavior (the follow/approach thresholds).
- **Adjusted by the merge** from a small new agent field (likely on the
  simulant — it already watches "what happened": add
  `affinityAdjustments: [{ a, b, delta, reason }]`, delta clamped tiny per
  turn so relationships move at story speed, not whiplash). Seeded at spawn
  from authored relationships in the world cast.
- **Facts stay the texture**; affinity is the cheap scalar for scoring.
  "Knows the player lied about the locket" is a fact; the −15 it caused is
  affinity. Both retrieved, different jobs.
- **Storage**: a `participant_relationships` table (session-scoped pair
  rows) is cleaner than nesting a peer-id map inside `ParticipantState` —
  pairs are symmetric-ish, queryable for "who likes whom here", and the
  state blob shouldn't grow O(cast²).
- **Shape question**: single scalar vs axes (trust/attraction/respect/fear).
  Recommend single scalar + stage for v1 — axes are a *widening* later
  (add columns, derive stage differently), and facts already carry the
  nuance axes would. Going multi-axis day one means tuning four numbers
  nobody can observe yet.

## Character tiers

`role: companion | npc` is an authoring/POV distinction, not a simulation
one. Add an orthogonal **tier** controlling simulation depth and narration
weight:

| Tier | Examples | Gets |
| --- | --- | --- |
| `major` | companions, central NPCs | everything: full forge, wardrobe, meters, memory/knowledge, active-LOD eligibility, full glance blocks |
| `minor` | shopkeeps, recurring townsfolk | schedule + affinity + facts; sketch-level forge; background LOD; brief narration |
| `extra` | monsters, crowd, one-scene walk-ons | stat-line only (combat/threat info, a look, a manner); no wardrobe/meters/schedule; dormant until spawned; may be **template-instanced** ("wolf" ×3) rather than individually forged |

Tier is a ceiling, not a cage — the emergent-cast pipeline is exactly the
promotion path (an `extra` the player keeps engaging gets director-signaled
and forge-enriched into `minor`/`major`, the same enrichment flow as the
provisional-participant spec). Template-instanced extras are the one
genuinely new mechanism: a participant row per *instance* is probably still
right (they hold positions and conditions), but pointing at a shared
template snapshot instead of a forged one.

## Pushback — where this doc deviates from the prompt

Recorded per house style, since the request explicitly invited alternatives:

1. **Per-adjacent-edge move scoring → drive-based destination selection.**
   Scoring every edge invites motion noise and post-hoc reasons; drives
   make "why" structurally prior to "where". (§Movement.)
2. **"Validate the LLM's reason" → deterministic audit of cited drives.**
   Free-text reason validation by another LLM compounds noise; requiring
   moves to cite a checkable drive (schedule entry, meter state, thread,
   witnessed event) makes validation a lookup, in line with the merge's
   existing grounding philosophy. (§Movement.)
3. **"Off-screen characters update memories/state [implicitly: every
   turn]" → LOD tiers + one batched world-tick + lazy backfill.** The
   *experience* (a world that visibly moved while you were away) is
   preserved; the cost is bounded by the active-set cap, not cast size.
   (§Off-screen life.)
4. **Schedules as teleports → schedules as a drive feeding traversal**, so
   transit is observable and schedules/needs/goals compose in one scorer
   instead of being a separate teleport pass. (§Traversal.)

## Decisions

All of this doc's open questions were resolved 2026-06-11 — see
[multi-character-presence-and-movement-decisions.phase3.md](multi-character-presence-and-movement-decisions.phase3.md)
for the decision-of-record list. The nuances are folded into the sections
above (look for "decided").

## Still open

1. **Perception-hint vocabulary on objects/affordances** (from decision
   13): what's the right small set —
   `absorbing / faces_away / outward / neutral`? Does it live on the item
   definition, the affordance entry, or both?
2. **Chain-cap behavior** (from decision 9): when the player chains a
   third significant action, does the turn hard-stop after the second
   ("the shower runs long; evening settles in — what next?") or does the
   narrator compress the rest? Tune in play; may not matter.
3. **Affinity widening path** (from decision 5): when v2 adds axes, which
   come first (trust? attraction?) and what observed v1 failure would
   trigger it? Deliberately deferred until the scalar visibly falls short.
4. **District abstraction for large maps** (from decision 12): dev maps
   are 10–30 locations, ambition is 100+. The `area` tag is the seed —
   at what map size does the prompt need area-level rosters instead of
   location lists, and does the world-tick need per-area batching?
