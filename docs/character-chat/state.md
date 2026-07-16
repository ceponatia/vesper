# Tracked state

What a conversation carries between exchanges: the per-character state row and the
chat-wide scenario, the narrator-imagined setting (scene memory), the persistent
emotional weather, and the character's drives.

## Tracked state

Tracked state is **split in two** (followups rulings 8–9, 2026-07-12): what belongs to
ONE character lives on their state row; what belongs to the CONVERSATION lives on the
chat row as the shared **scenario**.

**Per character** — one `character_chat_state` row per **(chat, participant)**, PK
`(chat_id, character_id)`: the full meter registry, the two relationship axes
(relationship-model v2: `regard` −100..100, the volatile feeling axis that was
`affinity`; `familiarity` 0..100, the moments+time ratchet with its
`familiarity_scene_gain` budget — trickle capped at `acquainted`, archivist facts push
past it, reset on a time skip) plus the authored `relationship_record` texture
(kind/history/`presented` mask/looming — `contracts/relationships/record.ts`),
self-expiring conditions, the `mindNote`, the **structured wardrobe** (chat-wardrobe-parity:
`worn_item_ids` — the worn item-definition ids seeded from the active preset; `outfit_preset_id`
— which named look is on; `outfit` repurposed as the free-text overlay/legacy fallback;
`outfit_exposed` retained but authoritative only on the free-text path — computed from coverage
otherwise; see §Wardrobe), the anti-repetition `surfacedCues` bands, the RAG carry-overs (`memoryQueries`,
`open_loops` — the archivist's ≤3 "unfinished business" phrases, re-emitted in full each
exchange so resolved loops fall off; persisted narrative `attributeOverlays`;
persisted narrative `trait_overlays` (character-fidelity slice 10 — bounded personality
evolution: `source:"narrative"` trait shifts the archivist proposes only at relationship
milestones, clamped one band from the authored value, guarded to `developable` traits —
resolved on top of the authored traits at prompt build, editable/rollback-safe); the
`voice_exemplars` ring (character-fidelity slice 8 — ≤5 distinctly in-voice lines the
archivist picks ≤1 of per exchange, rendered as the "How you sound" few-shots past the
events-only summary horizon; `lastMemoryTrace.characterSlip` is the one-turn
character-consistency corrective, slice 9);
`lastPulseTrace` / `lastMemoryTrace`), the relationship arc (`relationship_history` — a
≤200 sample ring `{at, clockMinutes, regard, band, familiarity}` appended when either
axis moved; `milestones` — ≤100 of
`first_exchange` / `stage_up` / `stage_down` / `familiarity_up` / `strong_reaction` / `player_marked`),
`callback_history` (the memory-callback anti-repeat ring ≤20 — see [initiative.md](initiative.md) §Memory callbacks),
`feeling` (the persistent feeling + bruise — see §Emotional weather), `selfie_history`
(the selfie-send ring ≤20 behind the offer cooldown — see [images.md](images.md) §Selfies), `drives` (the
runtime desires & secrets — see §Drives), and `presence`/`quiet_exchanges`
([multi-character.md](multi-character.md) §Multi-character).

**Chat-wide** — the **scenario** on `character_chats` (`ChatScenario`;
`loadChatScenario`/`saveChatScenario`/`seedChatScenario` in `engine/chat-state.ts`,
seeded at creation from the PRIMARY's profile — premise from `playerRelationship.note`,
house rules from their own cards — then preset-overlaid and author-owned): the
`premise`, the SETTING-wide `active_social_cards` (one rule set for every member —
per-character divergence rides character **tags** flipping the reaction, never
per-character rule lists), `scene_auto` (`"off" | "milestones"` — text with headroom,
never a boolean), `scene_model`, `scene_memory` (the accumulating narrator-imagined
setting — see §Scene memory), `supporting_cast` (recurring named side characters — see
[supporting-cast.md](supporting-cast.md) §Supporting cast), `plans` (tracked commitments
that come due on the story clock — see §Plans & promises), the time model (`clock_minutes` — **one** story timeline
for the whole roster, D3/D8; away members skip meter decay, never fork the clock;
`skip_history` ring ≤50; one-shot `pending_skip_note`; one-shot **`pending_meanwhile_note`**
+ **`meanwhile_pass_at_minutes`** — the meanwhile pass's narrator line and its
cumulative-gate origin / idempotency CAS, migration 0050,
[chat-offscreen-life.spec.md](../developer-notes/chat-offscreen-life.spec.md)), the **story-calendar anchor**
(`calendar_start` jsonb, migration 0049 — chat-clock-calendar: minute 0 of the chat =
this date+time; `parseOr` heals `{}`/bad rows to `CHAT_DEFAULT_CALENDAR_START` = Jan 1,
8:00am; author-editable via `ChatStateEdit.calendarStart` from the clock card, and
rebasing is safe because nothing stores derived dates), and `pre_exchange_scenario`
(the rollback anchor's chat-wide half). The calendar derivations are pure in
`contracts/turns/chat-clock.ts` (`chatGameTime`/`timeOfDayFor`/`formatStoryMoment`/
`chatMomentLabel` over `lib/clock.ts`'s Date-backed `resolveGameTime` — real month
lengths, leap years, true weekday alignment). **Time-model constants** (chat-clock-calendar,
2026-07-15): `CHAT_TICK_MINUTES = 1` (one exchange ≈ one story minute — skips are the
primary time mover), while meter pacing stays exchange-keyed via
`CHAT_METER_DRIFT_MINUTES = 4` (drift per exchange unchanged by the tick drop; feelings
already decay per exchange; conditions and plan windows stay story-real minutes). Beside the scenario the chat row also
carries `milestones_seen_at` (migration 0043) — the marker-v2 seen-cursor
([initiative.md](initiative.md) §Initiative), stamped on conversation open, deliberately outside `ChatScenario`
(it is a UI cursor, not fiction state — never snapshot/rolled back).

`upsertChatState` is the **one** state-row column-list source shared by the guarded
(mid-exchange) and unguarded (author-edit) writers; `editChatState` is ONE patch surface
over both stores (`ChatStateEdit` — per-character fields write the target's row,
chat-wide fields write the scenario) and `chatStateSnapshot(state, scenario)` merges
them back into the client's back-compat snapshot shape. State is inspected/edited
through the per-character **Character sheet** and the chat-wide **Scenario** modal
([ui.md](../ui.md) §The conversation page).


## Retake rollback boundary

A retake is a roster-wide transaction boundary, not a primary-character convenience.
Every `(chat_id, character_id)` row carries its own `pre_exchange_state`; the shared
scenario carries `pre_exchange_scenario`. Before a regenerate or accepted rerun drifts
anything, the pipeline restores every roster member from that same exchange boundary.
After settle, each member's new state and its next rollback anchor use the same
prompt-message existence guard. This covers the full stored state—meters, relationship
axes and history, conditions, feeling, drives, wardrobe, memory queries, open loops,
milestones, callbacks, presence and whereabouts—so a discarded group take cannot survive
through a non-primary row. A missing member anchor degrades explicitly with
`chat_state.snapshot.missing`.

Only the latest exchange can be rerun in place. Reaching farther back requires a
conversation branch because one snapshot cannot reconstruct every intervening state;
the API rejects that request before transcript mutation with `rerun_requires_branch`.


## Wardrobe

Since chat-wardrobe-parity (2026-07-14) the chat lane carries **structured worn state** at
full session parity, not one free-text string. A conversation holds `worn_item_ids` (the worn
item-definition ids, seeded from the active outfit preset), `outfit_preset_id` (which named
look is on), the repurposed free-text `outfit` (an overlay for narrated-but-unowned garments —
"a borrowed hoodie" — and the legacy fallback), and the retained `outfit_exposed` flag.

- **The seam.** `resolveChatWardrobe` (`engine/chat-wardrobe.ts`) is the ONE place worn state
  becomes what downstream reads — a rendered garment phrase (via `wardrobeOutfitText`,
  occlusion-filtered + subtype-led) plus **coverage-computed exposure** (via the session
  classifier `exposedRegions`, [../contracts/items.md](../contracts/items.md)) — reusing the
  session renderers, never re-forking them. The narrator prompt (`promptStateSlice`), the scene
  image (`queueChatScene` → `renderCharacterSceneImage`'s `exposure` override), and the
  `chat_look` key all read it. When `worn_item_ids` is empty the seam falls back to the
  free-text path (`outfit` + the manual `outfit_exposed`), self-healing the moment a preset
  switch / equip populates the worn list (**migration**: legacy chats stay on the free-text
  path until re-dressed — no sweep).
- **Archivist changes.** The archivist's `outfit` field (`contracts/turns/chat-archivist.ts`)
  drives two grammars, folded by `foldOutfitProposal` in `finalizeChatState`: a whole-outfit
  `description` naming an authored preset ("her work clothes" → the Work preset) seeds the worn
  list from it, an unmatched description is a free-text replacement, and garment-level
  `removed`/`added` fold through the pure `applyWornGarmentChanges` (contracts) against the
  loaded worn items + the character's preset pool — a removed garment drops its id, an
  unmatched added garment rides the overlay (both degrade with a diagnostic, never fail the
  turn). Rollback-safe: `worn_item_ids`/`outfit_preset_id` ride `storedChatStateSchema`.
- **Editing.** The Character sheet's per-slot equip/remove editor + preset switcher
  (`components/characters/chat-wardrobe-editor.tsx` — [ui.md](../ui.md) §The conversation
  page).


## Scene memory

Chat locations are **narrator-imagined** (not world entities — the lane has no locations,
presence, or wardrobe state), so nothing kept an established setting consistent. `scene_memory`
(one jsonb column on the CHAT row — the shared scenario, one imagined setting for the whole
roster; `contracts/turns/chat-scene-memory.ts` `ChatSceneMemory`) is an accumulating,
forward-compatible memory: `{ current?, places: [{ name, details[], connections[] }] }`
(`timeOfDay` was removed by chat-clock-calendar — time derives from the story clock, never
the archivist)
with hard caps (≤12 places, ≤8 details/place, ≤6 connections, length caps) and a `parseOr`
degraded default (empty memory) at the load boundary. It is maintained **deterministic-first**,
then reconciled by the archivist:

1. **Pre-prompt (movement).** `detectSceneMovement` (`engine/chat-intent.ts`, regex-first) reads a
   movement/arrival in the player's input ("I follow her to the kitchen", "we head outside") and
   the route calls `switchScenePlace` to switch `current` (minting a stub place on first mention)
   **before** the prompt builds, so this turn's Scene injection is right. "Just changed" = a new
   current place this turn, or a pending time skip.
2. **Injection.** The prompt builder renders the compact **Scene** block in the volatile tail
   (current place + details + connections + a directive that flips on "just changed"
   — see [prompts.md](../prompts.md) §Character-chat reply discipline & scene memory); the time
   of day rides the separate binding **Story time** line (`storyMoment`, derived from
   `clock_minutes` + `calendar_start`), so the narrator reads the same clock the clock card shows. On the
   conversation's **first exchange** (no assistant reply yet, not an opening beat) the memory is
   empty and "just changed" can't fire, so the tail instead renders a one-turn **first-exchange
   scene directive** (`firstExchange`, 2026-07-10): establish the scene once, narration-forward
   (sight plus one other sense), drawn from the scenario and the player's message — the movement
   path's own directive wins when a first-message move minted a place.
3. **Post-turn (reconcile).** The archivist's optional `scene` field (current-place confirmation,
   new place details/connections — ONLY what the fiction established, lenient
   parse; never the time of day) is merged onto the pre-turn memory in `finalizeChatState` via `mergeSceneMemory` (dedupe
   + caps, oldest-out; the current place is never evicted). A degraded/empty proposal is a no-op —
   the memory only ever accretes what the fiction established.
4. **Background sketch (chat-scene-fidelity slice 2b).** After the state write, a current place
   without a `sketch` enqueues a detached `chat_scene_sketch` job (`chat-scene-sketch.ts`, deduped
   per chat like the summary fold): a small agent (`prompts/chat-scene-sketch.ts`) expands the
   place into a 2–4 sentence visual sketch — every established detail incorporated, only
   compatible texture invented — written back onto `ScenePlace.sketch` via an optimistic CAS on
   the raw `scene_memory` jsonb (deliberately NOT the exchange lock, so it can never 409 a send;
   a lost race re-fires while the sketch stays absent). Consumed by the narrator's Scene block
   (`- Setting (fixed reference): …`) and the scene image's `room` (below).

**Reset.** Scene memory rides the ordinary chat resets: the row is on `character_chat_state`, whose
`(chat_id)` FK cascades on `deleteChat` (the one destructive verb), so a hard delete clears it with
the transcript/summary/memory; **archive** leaves it intact by design; and "another take"
(regenerate) rolls it back with the rest of the state via the `pre_exchange_state` snapshot
(`scene_memory` is in `storedChatStateSchema`), so a regenerated exchange never double-accretes.


## Emotional weather

Emotions used to be meter-derived and reactive-only — a strong beat's deltas started
decaying on the next tick, and regard moved on a flat ±5/turn clamp with no history.
Emotional weather ([developer-notes/emotional-weather.plan.md](../developer-notes/finished/emotional-weather.plan.md),
owner rulings 2026-07-11) adds three layers, all in the pure `engine/chat-feeling.ts`:

- **Persistent `feeling`** (`character_chat_state.feeling` jsonb): the pulse proposes a
  label (the locked 11-label `EmotionLabel`) + cause when an exchange lands a beat that
  should persist; intensity derives deterministically from the curve's move (the model
  never numbers, same contract as `playerAct`). It decays **per exchange** (≈6–7
  exchanges from full), softens more slowly over time skips (`CHAT_FEELING_SKIP_STEPS` —
  moments barely dent it, days clear it), and a `"neutral"` proposal explicitly clears
  it (the pulse sees the standing feeling in its prompt, so resolution is informed). In
  the prompt it **composes** with the meter mood descriptor (ruled: baseline weather +
  the front passing through — "subdued and withdrawn right now — and deeply sad about
  the broken promise") on the Current-state line and the response-shape mood pin.
- **Regard momentum**: `scaleRegardDelta` modifies the curve's move — the standing
  feeling biases magnitude (ruled: damped, valence × intensity × ±10% max, amplifying
  deltas that agree with the feeling and damping those that fight it — hard-capped so
  hurt→worse-reads→more-hurt can't spiral); a **warmth streak** (consecutive rising
  samples in `relationship_history`) compounds gains up to ×1.5; a **bruise** — a
  strong drop landing at warm-or-better regard — halves gains for ~10 exchanges
  (ruled). A classified **`apologize`** act (new interaction concept, a registry data
  edit — distinct from `reassure`: comfort is not repair) that isn't disliked halves
  the bruise's remaining life. A scaled nonzero delta never rounds to zero, the ±5
  clamp is re-applied last, and the trace records `regardScale` + the applied feeling
  for the state tools.
- **Reply pacing** (UI-only, `lib/chat-pacing.ts` + `chat-conversation.tsx`): the
  client holds the "…" bubble before revealing streamed tokens — cold regard ≈700ms,
  the middle ≈250ms, warm none; a standing dark feeling adds ≈500ms, a bright one
  trims; capped at 1.2s and purely presentational (tokens buffer, nothing is lost;
  any held text flushes on settle/stop/failure). The snapshot carries `feeling` to
  the client for this.

Rollback-safe like everything else: `feeling` rides `storedChatStateSchema`, so
"another take" restores the pre-exchange weather exactly.


## Plans & promises

Commitments the fiction strikes — "come over Friday", "I'll text you after my shift" —
become tracked state that comes DUE on the story clock
([developer-notes/chat-plans-promises.plan.md](../developer-notes/chat-plans-promises.plan.md)
· [.spec.md](../developer-notes/chat-plans-promises.spec.md)): the chat descendant of the
retired scheduled-arrivals spec, without the location model. The frame — *the story makes a
commitment → the system records it deterministically → the clock makes it come due → the
narration honors it.*

- **Storage** (`contracts/turns/chat-plans.ts` `ChatPlan`): a chat-wide list on the
  scenario (`character_chats.plans` jsonb, migration 0048; `parseOr`'d empty at the load
  boundary) — plans belong to the CONVERSATION like `scene_memory`/`supporting_cast`.
  `{ id, what, participants[], where?, when, status, struckAtMinutes }`, capped
  (`CHAT_PLANS_MAX = 16` total; `CHAT_PLANS_OPEN_MAX = 8` open — oldest-out; resolved
  plans keep a short callback ring). Rolls back with `pre_exchange_scenario` (ruling B —
  fiction state, so a regenerated reply that struck a plan never double-mints; **unlike**
  the accrete-only supporting cast).
- **`when`** (ruling A) is coarse and keyed to `clock_minutes`, never the wall clock: the
  archivist proposes a day-offset + day-part (`morning`/`afternoon`/`evening`/`night`,
  reusing the schedule vocabulary) or `unscheduled`; the fold resolves it to an absolute
  `targetMinutes` + a stored relative fallback label (`resolvePlanWhen` — day boundaries
  come from the calendar anchor, real midnight, not `clock % 1440`). Unscheduled plans
  never go missed. **Display labels are calendar-derived at render time**
  (chat-clock-calendar: `describePlanWhen(when, {nowMinutes, calendarStart})` /
  `SalientPlan.whenLabel` — "tomorrow evening" inside a day, the bare weekday
  ("Friday evening") 2–6 days out, the date ("Friday the 12th, evening") at 7+ —
  never stored, so editing the anchor rebases every label).
- **`status`** — `kept`/`canceled` are archivist-recognized, `missed` is **deterministic**
  (the archivist may never propose it); *imminent* / *due now* / *just missed* are DERIVED
  pure at prompt-build time (`derivePlanSalience` vs the clock), never stored. The fold
  runs `mergeChatPlans` (upsert by normalized `what`) then `advancePlans` — an overdue
  upcoming plan involving the PLAYER becomes `missed`, an overdue NPC↔NPC plan is assumed
  `kept` (ruling E, the default until the meanwhile pass). A time skip is the main mover
  (1-min ticks barely move the clock; the 30/180/540/4320-min skips give it teeth).
- **Consequences** land through existing machinery: the just-resolved plans reach the
  reaction pulse's `commitmentsDue` context so a stood-up character proposes `hurt`
  (ruling C — model-mediated, no deterministic regard penalty); a kept/missed plan
  involving the player mints a `plan_kept`/`plan_missed` milestone (callback-boosted like
  `secret_shared`); the hub marker + reopen opener surface near plans (see
  [initiative.md](initiative.md)); and the ensemble arrival/exit license moves people in
  and out of the scene (see [multi-character.md](multi-character.md)). Editing/inspection:
  the **Plans** card (`ChatStateEdit.plans`, chat-wide half — [api.md](api.md)).

## Off-screen life (whereabouts + the meanwhile pass)

The cast keeps living between visits (chat-offscreen-life — rulings in
[the spec](../developer-notes/chat-offscreen-life.spec.md)):

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
  supporting-cast detail/whereabouts accretion, NPC↔NPC plan outcomes (replacing
  ruling E's assume-kept default), away whereabouts refreshes, and the one-shot
  `pending_meanwhile_note`. Degrades to an ordinary skip; scenario folds are guarded
  (marker CAS + the skip note still standing) so a racing exchange is never clobbered.

## Drives (desires & secrets)

The character's motive force
([developer-notes/character-drives.plan.md](../developer-notes/character-drives.plan.md),
owner rulings 2026-07-11): ≤3 authored wants on `profile.drives`
(`contracts/personality/drives.ts` — `want`/`why`/`secrecy: open|guarded|secret` +
an optional `revealBand`), seeded into `character_chat_state.drives` (migration
0035) with runtime `progress`/`revealed`/`resolved`.

- **Prompt law** (`buildDrivesSection`, volatile tail): open drives steer; `guarded`
  never volunteers (comes out only if asked/earned); a `secret` below its reveal
  band is **protected with a full lie license** (ruled) — scoped hard: "the lying is
  for THIS secret only; in everything else you are as honest as you ever are". The
  default gate for an unbanded secret is **familiarity ≥ familiar** (ruled); at/above
  the gate the block flips to an invited reveal ("a big beat — don't force it").
- **Archivist 8th field** `driveUpdates`: progress/reveal/resolve on existing drives,
  matched by exact `want` (the prompt lists them, secrets marked); a degraded
  archivist keeps prior drives. A newly-revealed secret lands a **`secret_shared`
  milestone** (new kind — panel glyph ❖, and a prime memory-callback boost); the
  spoken reveal files as an ordinary extracted fact (ruled — no special wiring).
- **Panel** (ruled): the Relationship panel's "What they want" lists open wants +
  revealed secrets only; guarded/unrevealed drives stay invisible until play
  surfaces them. State tools/`ChatStateEdit` expose the full set (inspector-grade).
- **Authoring** (shipped 2026-07-12): the character forge's profile leg drafts
  drives (concept-led, **≤1 secret** — ruled; `groundDrives` validates reveal
  bands against the band vocabulary and demotes extra secrets to `guarded`); the
  editor's Disposition tab carries the **"Desires & secrets" card**
  (`components/characters/drives-editor.tsx` — want/why/secrecy + a reveal-gate
  picker on secrets). Forge-the-rest fills drives **additively up to the 3-cap**
  (ruled — authored drives never change); a Disposition re-draft re-derives them
  wholesale ([authoring.md](../authoring.md) §Character sheet forge).

