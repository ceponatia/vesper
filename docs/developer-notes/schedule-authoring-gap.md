# The schedule read/write asymmetry — authored routines with no author

Status: **analysis / proposal** (2026-06-15). Supplement to
[character-schema-audit.md](finished/character-schema-audit.md) finding **C3**.
`CharacterProfile.schedule` is consumed by the off-screen NPC movement system and
is the field two phase specs build on — yet **nothing writes it**. It can only
ever be `[]`, which means the routine-driven movement it powers never fires for
any real character.

## The consumer (live, and load-bearing for planned work)

The merge schedule tick walks every off-screen NPC to match their authored
routine each turn (`engine/merge.ts:1715-1749`):

```ts
const entry = scheduleEntryAt(participant.snapshot.schedule, jitteredMinute, gameTime.weekdayIndex);
if (!entry) continue;
const target = resolveSessionLocation(entry.locationName, bundle.locations);
…
participant.locationId = target.id;
participant.state.activity = entry.activity;
```

`scheduleEntryAt` (`merge.ts:689`) handles midnight-wrapping windows and weekday
masks. Two specs lean on this directly:

- **scheduled-arrivals.spec.md** §"Schedule tick" cites
  `merge.ts:1715-1749` + `scheduleEntryAt` and describes
  `ParticipantSnapshot.schedule` as the NPC's *"authored daily routine"* / its
  *"recurring weekly windows."*
- **offscreen-simulation-spec.phase3.md** states *"off-screen activity comes only
  from authored schedule entries (the merge already writes `entry.activity` on
  schedule …)"* and that absent characters *"snap to schedule slots."*

So the engine and the roadmap both treat authored schedules as a real input.

## The producer (none)

- **Forge** — the profile section emits no schedule (`character-forge.ts`
  produces bio/personality/voice/aliases/tags, never `schedule`).
- **Editor** — the character editor has no schedule control
  (`components/characters/character-editor.tsx`; the attribute picker only
  touches attributes/body-config).
- **Create API / draft** — `characterProfileSchema` defaults `schedule` to `[]`
  and the create body accepts a raw `profile`, but no client path constructs a
  non-empty schedule; `characterDraftSchema` carries the field with no UI behind
  it.

Net: `profile.schedule` is structurally always `[]` → `scheduleEntryAt` always
returns `null` → the schedule tick is a no-op for every character. The off-screen
routine system, and the phase-5 spec written against it, depend on a field that
the product cannot populate.

## Why it matters

- The "the world keeps moving" promise (off-screen simulation, scheduled
  arrivals) is core to the multi-character direction, and its **only deterministic
  input** today is authored schedules. With no authoring, the feature can't be
  exercised, tested with real data, or demonstrated in a seeded world.
- It is a silent dead end: the code looks complete and the specs reference it, so
  the gap is invisible until someone asks "why does no NPC ever follow a routine?"

## A design wrinkle that shapes the fix: schedules name *world* locations

`schedule[].locationName` is resolved at runtime against the **session's**
locations (`resolveSessionLocation(entry.locationName, bundle.locations)`). But
`schedule` lives on the **library character** (`CharacterProfile`), which is
world-agnostic and can be cast into many worlds. So a schedule authored on a
library character references location names that may exist in one world and not
another. This is the reason a naïve "add a schedule tab to the character editor"
is wrong: it would invite authors to write routines against locations that don't
exist where the character is actually played.

This points the fix toward **world-cast context**, where the character is placed
into a world with a known location set.

## Solutions

### A. Author schedules at the world-cast level (recommended)

Add schedule authoring to the **world editor's cast/placement UI**, where the
world's locations are known and selectable by name (the same place start-location
and relationships are set). Mechanically the schedule still rides
`CharacterProfile`/the spawn snapshot, but the editor would offer the world's
locations as the `locationName` options, so entries resolve at play time.

Open sub-question: does the value live on the library `CharacterProfile` (a
world-agnostic default that may dangle in other worlds) or as a **world-local
override** (parallel to how `world_locations.overrides` and cast relationships are
world-scoped)? A world-local schedule is the cleaner model given the
location-name binding; it would be a small addition to `world_cast` or the cast
draft rather than the character profile. This is the main design decision.

### B. A library-character schedule editor (simpler, leakier)

Add the schedule form to the character editor anyway, accepting that
`locationName`s are free text the author must keep consistent with whatever world
the character lands in. Cheapest to build; matches where `scheduleEntrySchema`
already conceptually lives; but reintroduces the dangling-location problem and
relies on `merge.schedule.unknown_location` diagnostics to catch mismatches at
runtime. Acceptable as an interim if world-cast authoring (A) is too big now.

### C. Forge-inferred starter routines (additive, later)

Have the forge propose a simple routine from the concept ("a harbor-master" →
docks daytime, home evening). Only useful *after* A/B exists, and it inherits the
location-binding problem (the forge doesn't know the target world's locations), so
it would emit generic place phrases that must be reconciled at placement. Low
priority.

### D. If routines aren't wanted yet — decouple and say so

If authored routines are not a near-term goal, document `schedule` as a
deferred/unwired field and make the schedule tick's dependence on it explicit, so
the phase-5 spec doesn't silently assume an unpopulatable input. Honest minimum;
leaves the feature parked rather than half-alive.

## Recommended path

Resolve the **storage question first** (library default vs. world-local override
— lean world-local, given the location-name binding), then build authoring in the
world-cast UI (A). If that's out of scope short-term, ship B with the runtime
`unknown_location` diagnostic as the guard, and note the migration to A. Either
way, update `scheduled-arrivals.spec.md` and
`offscreen-simulation-spec.phase3.md` to point at the now-real authoring path.

## Test plan

- **Integration**: a cast member with an authored schedule entry covering the
  current minute, played in that world, is relocated off-screen to the entry's
  location and gets its `activity`; an entry whose `locationName` doesn't resolve
  emits `merge.schedule.unknown_location` and is skipped (already the behavior —
  add a test so it's pinned).
- **Round-trip**: authoring → save → spawn snapshot carries the schedule;
  weekday-mask and midnight-wrap windows behave (extend `scheduleEntryAt` tests
  with authored data rather than fixtures).

## Open questions

- **Storage: library profile vs. world-local override?** (the core decision —
  lean world-local).
- **Where in the UI** — world-cast row expander, or a dedicated schedule editor?
- **Day mask UX** — expose the `days[]` weekday mask, or start daily-only and add
  masks later?
