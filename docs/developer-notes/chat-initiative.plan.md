# Chat initiative — the character reaches out first

Status: **next** (planned 2026-07-11, from the character-chat & schema engagement
review — seven-plan batch at the top of [roadmap.md](roadmap.md) §Next; effort
**L**)

The character only ever responds — the biggest engagement gap in the lane.
Every piece already exists in fragments: the `open` exchange kind (synthetic
cue, no player line), `open_loops`, the skip note's "a life meanwhile" license,
the `*Name: …*` comms grammar, and the shipped §8.4 v1 **"has something to
say"** marker (open-loops-keyed, tap → cued continue beat via `/chat/:id?say=1`
— see
[finished/character-chat-standalone.spec.md](finished/character-chat-standalone.spec.md)
§8.4). This plan grows §8.4 v1 into real initiative while staying inside the
standing rulings: **D8** (no wall-clock in the fiction) and **D3** (wall-clock
absence is deliberately not a trigger) — initiative anchors to reopen/skip
events the player causes, and generation stays player-triggered (no background
generation, no push; a notification lane is out of scope here).

## Design (slices in build order)

1. **Reopen opener.** The pickup strip gains "See what she's been up to" (and
   each skip chip can imply it): an `open`-kind exchange whose cue seeds from
   the open loops + drives (once shipped) + the pending skip note. Register:
   comms-first (texted `*Name: …*` lines) when the premise/scene implies the
   two are apart, in-scene otherwise — the cue states which. The pulse is
   skipped (no player act, same as `continue`); memory and provenance are
   ordinary.
2. **Marker upgrade.** Extend the §8.4 derivation beyond open loops: the
   unseen-milestone seen-cursor column §8.4 declined as not-yet-justified
   (revisit is now justified), plus an optional real-time-since-last-exchange
   threshold as a **UI-only** nudge — an affordance, never fiction; the opener
   still decides in-fiction what the gap was via the skip the player picks.
   Hub-card badge + the existing one-tap banner reuse.
3. **Life-event beat.** A small structured call at opener time mints ONE
   offscreen event consistent with persona, drives, `schedule`, and scene
   memory ("my sister called", "the interview moved up") — filed as a fact
   (becomes `perceived` once told) and woven into the opener. No-repeat ring +
   caps; degrades to loop-only openers with a diagnostic.
4. **Daily rhythm.** Light authoring for the write-orphaned `profile.schedule`
   (a forge section + a simple day-part editor card — rows, not a timetable
   grid) so meanwhile-lines, openers, and life events can draw on it ("just got
   off shift"). Chat-side consumption only; the session movement engine already
   reads the field.
5. **Selfie attach** (after [chat-selfies.plan.md](chat-selfies.plan.md)): a
   warm opener may attach one — the "thinking of you" photo, the strongest
   reopen hook.

## Guards

- The opener is one ordinary exchange: exchange lock held, 409 `chat_busy`
  semantics, watchdogs, persist guards — nothing new.
- One opener per reopen, never stacked; the marker can't re-fire until a new
  loop/milestone lands.
- The life-event agent must invent only offscreen texture, never rewrite shared
  state (no meter/regard writes — flavor + one fact).

## Open questions

- Should the opener advance the chat clock like a normal exchange
  (`CHAT_TICK_MINUTES`)? Lean yes — it's a beat.
- Badge honesty: is real-time-since-last-exchange acceptable as a UI-only
  signal given D3, or should the marker stay loops/milestones-only? Owner call.
- Life-event generation: inline leg at opener time (lean — it needs the chosen
  skip amount) vs a detached job minting into state on reopen.

## Cross-links

- [character-drives.plan.md](character-drives.plan.md) — drives give openers
  and life events their material; sequence drives first if possible.
- [chat-selfies.plan.md](chat-selfies.plan.md) — slice 5's attach hook.
- [multi-character-chat.plan.md](multi-character-chat.plan.md) — openers stay
  primary-participant-only until the ensemble frame lands.
