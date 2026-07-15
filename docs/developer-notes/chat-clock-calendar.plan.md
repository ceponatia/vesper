# Chat clock & calendar — story time the player can see

Status: **shipped — 2026-07-15** (planned, ruled, and built the same day; owner
request during the off-screen-life feasibility review. Owner rulings recorded
inline in §Design; no separate spec. What shipped: the pure calendar contract
(`contracts/turns/chat-clock.ts` — `CHAT_DEFAULT_CALENDAR_START`, `timeOfDayFor`,
`formatStoryMoment`, `chatMomentLabel`, tested) + the `calendar_start` column
(migration 0049, `parseOr`-healed, editable via `ChatStateEdit.calendarStart`);
`CHAT_TICK_MINUTES` 4 → 1 with meter pacing preserved via the new
`CHAT_METER_DRIFT_MINUTES = 4` (feelings were already exchange-keyed; conditions
and plan windows stay story-real); the binding **Story time** tail line in both
frames with `scene_memory.timeOfDay` removed outright (contract + extractor +
scene-image consumers now derive from the clock); real-weekday plan labels
derived at render time (`describePlanWhen` ctx / `SalientPlan.whenLabel`,
`resolvePlanWhen` day boundaries on real midnight); real weekdays in
`rhythmOutfitPatch`; the skip note + toast naming the landing; and the desktop
**right aside** with the clock card + skip chips + anchor editor
(`chat-clock-card.tsx`), mirrored into the phone Roster sheet, with landing
tooltips on the pickup strip. `CHAT_SKIP_MINUTES` moved onto the skip contract.
**Leftover:** Open question C (further right-aside tenants) stays open — the
surface is now there. Migration 0049 applies to Neon on the next deploy.)

## Goal

The chat lane has a real story clock (`character_chats.clock_minutes` — every
exchange ticks it, every skip advances it, plans come due on it) but the player
never sees it: no UI surface renders it, the skip toast is a generic "Time
passes…" with no indication of where you landed, and even the narrator's sense
of time comes from a **free-text archivist field** (`scene_memory.timeOfDay`)
that is decoupled from the clock the skips move. Result: skipping time is a
leap in the dark, so the feature goes unused.

Make story time **legible and coherent**:

- a **clock + calendar panel** in a new desktop **right aside** (the transcript
  is a centered `max-w-3xl` column; the right gutter is empty real estate) —
  day, weekday, date, time of day;
- **skip feedback that names the landing** ("Now: Friday evening") in the toast
  and on the pickup-strip chips;
- **one authoritative time**: the narrator reads the same clock the panel
  shows, so what the player sees and what the story says never disagree.

## What already exists (the good news)

The full calendar model is already built, pure, and session-proven in
`src/lib/clock.ts`: `resolveGameTime()`, `formatGameClock()` ("Friday, June 1,
2024 — 8:00am"), `WEEKDAYS`/`MONTHS`, `daylightBand()`, and
`DEFAULT_CALENDAR_START` (2024-06-01 08:00). It just isn't anchored for chats —
`seedChatScenario` seeds `clockMinutes: 0` with no `calendarStart`, and the
chat pipeline never calls any of it. This plan is mostly **wiring, not
invention**.

## Design

### 1. Anchor the chat clock (`calendarStart` on the scenario)

Add `calendarStart` to `chatScenarioSchema` / `seedChatScenario`
(`chat-state.ts`), defaulting to `DEFAULT_CALENDAR_START`; `parseOr` degraded
default at the load boundary. Minute 0 of the chat = the anchor moment.
Derivations then come free from `lib/clock.ts` — no new time math.

**Ruling (owner, 2026-07-15): `calendarStart` is author-editable** — an edit
surface on the chat-wide `ChatStateEdit` half (a "story starts on…" control,
natural home: the clock card / chat settings), not a seed-only default.
Editing rebases the whole timeline display (plan labels, weekday-masked
schedules) since stored minutes are anchor-relative — cheap and safe because
nothing stores derived dates.

**Ruling (owner, 2026-07-15): the per-exchange tick drops to 1 minute**
(`CHAT_TICK_MINUTES` 4 → 1) as the default. Ordinary conversation then barely
moves the clock and **skips become the primary time mover**, which is the
point of the whole feature. Anything keyed to clock minutes (feeling decay,
condition expiry, plan salience windows, familiarity/meter gain pacing) sees
4× slower drift per exchange — **re-evaluating those decay/gain constants is
part of this plan's scope** (owner, 2026-07-15; tracked on the roadmap entry).

**Ruling (owner, 2026-07-15): weekdays lock to a real simulated calendar;
the default anchor is January 1 at 8:00am.** `resolveGameTime` is already
`Date.UTC`-backed — real month lengths, leap years, true weekday↔date
alignment — so a real calendar costs nothing and no simplified
30-day-month model is needed (the owner's "doesn't have to match real
years" concession is unnecessary; we get real years for free). The chat
lane gets its own default constant (e.g. `CHAT_DEFAULT_CALENDAR_START` =
Jan 1, 08:00 of the fixed default year — the Date math requires *a* year;
the display can omit it), leaving the session lane's June-1
`DEFAULT_CALENDAR_START` untouched. A player-set `calendarStart` overrides
the default (editable-anchor ruling above).

Fix the existing weekday hack while here: `rhythmOutfitPatch`
(`chat-state.ts:864`) approximates weekday as `floor(clockMinutes/1440) % 7`
for schedule `days` masks; with an anchor it becomes the real weekday.

### 2. The right aside (new desktop surface)

A new `<aside>` on the right edge of the main row in
`chat-conversation.tsx` (mirror of the left aside: `hidden lg:flex`, w-52/xl
w-64), first tenant the **Clock card**:

- weekday + date ("Friday, June 5"), story-day counter ("Day 3"), time +
  day-part ("2:10pm — afternoon"), optionally a daylight glyph
  (`daylightBand`);
- the **time-skip chips live here too** (Later / Next morning / Days later) —
  the control sits next to the display that makes it legible, right where the
  question "what time is it?" gets answered;
- mobile: a compact clock line in the Roster sheet header (and/or the
  `StatusStrip`) — no new sheet.

`clockMinutes` is already on `ChatStateSnapshot` and in scope in the
conversation component (the Plans panel consumes it today).

### 3. Skip feedback names the landing

`skipTime` already receives the post-skip snapshot; format the new moment into
the toast ("Time passes… It's now Friday evening.") and render each pickup-chip
target ("Next morning (Sat 8am)"). The skip stops being a leap in the dark.

### 4. One authoritative time (prompt coherence)

Render a clock-derived time line into the volatile tail (both frames) —
"It is Friday afternoon, June 5" — so the narrator and the panel agree.

**Ruling (owner, 2026-07-15): `timeOfDay` becomes the derived block-of-time
shorthand, not a free-text field.** The archivist stops writing
`scene_memory.timeOfDay`; instead a pure helper (e.g.
`timeOfDayFor(clockMinutes)`) maps the clock onto the canonical day-part
blocks and that enum is the shorthand code and prompts use everywhere — the
Scene block's "Time of day" line, the rhythm line, plan `when` day-parts,
skip-landing labels. One vocabulary to rule them: `SCHEDULE_DAY_PARTS`
(`world/profile.ts` — morning/afternoon/evening/night with start minutes) is
already shared by schedules and plans, so it wins; `lib/clock.ts`'s separate
daylight bands (dawn/day/dusk/night) stay session-only unless a glyph wants
them. The archivist free-text field is removed, not wrapped (this app drops
legacy).

This is also the grounding [chat-offscreen-life.plan.md](chat-offscreen-life.plan.md)
§4's rhythm line needs ("it's mid-morning; she'd normally be at the café" —
the day-part must come from the clock, not from free text).

### 5. Plan labels get real days

**Ruling (owner, 2026-07-15): yes — real weekdays.** `buildWhenLabel`
(`contracts/turns/chat-plans.ts`) switches from relative labels ("in 3 days,
morning") to anchored ones ("Friday morning"), matching how the fiction talks
about plans. Detail: within 6 days out the bare weekday is unambiguous; at 7+
days include the date ("Friday the 12th"). Today/tomorrow keep their natural
words. The archivist's coarse day-offset + day-part proposal grammar is
unchanged — only the resolved label changes.

## Cost note

No new model calls anywhere — this is schema + pure derivation + UI + one
volatile-tail line. The tail line is a few tokens per turn.

## Open questions

A, B, D, E were ruled by the owner on 2026-07-15 — rulings are recorded inline
in §Design above (editable anchor; `timeOfDay` = derived day-part shorthand,
archivist field removed; real weekdays in plan labels; 1-minute default tick).
Remaining:

- **C. Right-aside tenants** — clock + skip chips first; what else moves or
  lands there (scene card? meters?)? Lean: clock-only v1, the surface is the
  point.

## Not in scope

- **Wall-clock time** — D3/D8 stand; the calendar maps *story* minutes to
  dates, nothing reads real time.
- **Session-lane changes** — sessions already have this via `worldStyle.calendarStart`.
- **A scheduling/calendar UI** — the panel displays time; plans keep their own
  card.

## Docs to update when implementing

`character-chat/state.md` (calendarStart, clock semantics),
`character-chat/pipeline.md` (the tail time line), `prompts.md` (Scene block /
timeOfDay authority change), `character-chat/api.md` (snapshot/edit surface if
it changes), `frontend.md` (the right aside).
