# Plans, promises, and off-screen life

Commitments the fiction strikes come due on the story clock, and the cast keeps living
between visits. Both are chat-wide scenario state, so both roll back with a retake.

## Plans & promises

"Come over Friday", "I'll text you after my shift" — a commitment
becomes tracked state that comes DUE on the story clock. The frame is: *the story makes a
commitment → the system records it deterministically → the clock makes it come due → the
narration honors it.*

- **Storage** (`contracts/turns/chat-plans.ts` `ChatPlan`): a chat-wide list on the
  scenario (`character_chats.plans` jsonb, migration 0048; `parseOr`'d empty at the load
  boundary) — plans belong to the CONVERSATION like `scene_memory`/`supporting_cast`.
  `{ id, what, participants[], where?, when, status, struckAtMinutes }`, capped
  (`CHAT_PLANS_MAX = 16` total; `CHAT_PLANS_OPEN_MAX = 8` open — oldest-out; resolved
  plans keep a short callback ring). Rolls back with `pre_exchange_scenario` (ruled —
  fiction state, so a regenerated reply that struck a plan never double-mints; **unlike**
  the accrete-only supporting cast).
- **`when`** is coarse and keyed to `clock_minutes`, never the wall clock: the
  archivist proposes a day-offset + day-part (`morning`/`afternoon`/`evening`/`night`,
  reusing the schedule vocabulary) or `unscheduled`; the fold resolves it to an absolute
  `targetMinutes` + a stored relative fallback label (`resolvePlanWhen` — day boundaries
  come from the calendar anchor, real midnight, not `clock % 1440`). Unscheduled plans
  never go missed. **Display labels are calendar-derived at render time**
  (`describePlanWhen(when, {nowMinutes, calendarStart})` /
  `SalientPlan.whenLabel` — "tomorrow evening" inside a day, the bare weekday
  ("Friday evening") 2–6 days out, the date ("Friday the 12th, evening") at 7+ —
  never stored, so editing the anchor rebases every label).
- **`status`** — `kept`/`canceled` are archivist-recognized, `missed` is **deterministic**
  (the archivist may never propose it); *imminent* / *due now* / *just missed* are DERIVED
  pure at prompt-build time (`derivePlanSalience` vs the clock), never stored. The fold
  runs `mergeChatPlans` (upsert by normalized `what`) then `advancePlans` — an overdue
  upcoming plan involving the PLAYER becomes `missed`, an overdue NPC↔NPC plan is assumed
  `kept` unless the meanwhile pass resolves it otherwise. A time skip is the main mover
  (1-minute ticks barely move the clock; the 30/180/540/4320-minute skips give it teeth).
- **Consequences** land through existing machinery: the just-resolved plans reach the
  reaction pulse's `commitmentsDue` context so a stood-up character proposes `hurt`
  (ruled — model-mediated, no deterministic regard penalty); a kept/missed plan
  involving the player mints a `plan_kept`/`plan_missed` milestone (callback-boosted like
  `secret_shared`); the hub marker + reopen opener surface near plans (see
  [initiative.md](initiative.md)); and the ensemble arrival/exit license moves people in
  and out of the scene (see [multi-character.md](multi-character.md)). Editing/inspection:
  the **Plans** card (`ChatStateEdit.plans`, chat-wide half — [api.md](api.md)).

## Off-screen life (whereabouts + the meanwhile pass)

- **`character_chat_state.whereabouts`** (text ≤120, migration 0050): where an AWAY
  member is, as a phrase — written by the archivist presence read's optional `where`
  on away transitions and refreshed by the meanwhile pass; rendered in the ensemble's
  away/salient lines. A **present** member with a non-empty whereabouts "just got
  back" — the tail renders a one-turn came-from license and the post-exchange fold
  clears it. Author-correctable (`ChatStateEdit.whereabouts`).
- **The meanwhile pass** (`engine/chat-meanwhile.ts`): a detached `chat_meanwhile` job
  fired from the skip route when cumulative skipped time since the last pass crosses
  one story day (`armMeanwhilePass`). One archivist-class call over the fenced
  ensemble dossier proposes ≤3 developments; deterministic folds: **facts to every
  involved member's own memory group** (two names = a relationship fact to both —
  members know different things), drive progress notches (reveal/resolve stripped),
  supporting-cast detail/whereabouts accretion, NPC↔NPC plan outcomes (replacing the
  assume-kept default above), away whereabouts refreshes, and the one-shot
  `pending_meanwhile_note`. Degrades to an ordinary skip; scenario folds are guarded
  (marker CAS + the skip note still standing) so a racing exchange is never clobbered.
