# Tracked state

What a conversation carries between exchanges: the per-character state row and the
chat-wide scenario, the boundary a retake rolls back to, the persistent emotional weather,
and the character's drives. The systems that hang off individual fields have their own
pages — [wardrobe.md](wardrobe.md), [scene-memory.md](scene-memory.md),
[plans.md](plans.md), [body-state.md](body-state.md).

## The two stores

Tracked state is **split in two**: what belongs to
ONE character lives on their state row; what belongs to the CONVERSATION lives on the
chat row as the shared **scenario**.

**Per character** — one `character_chat_state` row per **(chat, participant)**, PK
`(chat_id, character_id)`: the full meter registry, the two relationship axes
(relationship-model v2: `regard` −100..100, the volatile feeling axis; `familiarity`
0..100, the moments+time ratchet with its
`familiarity_scene_gain` budget — trickle capped at `acquainted`, archivist facts push
past it, reset on a time skip) plus the authored `relationship_record` texture
(kind/history/`presented` mask/looming — `contracts/relationships/record.ts`),
self-expiring conditions, the `mindNote`, the **structured wardrobe**
(`worn_item_ids` — the worn item-definition ids seeded from the active preset; `outfit_preset_id`
— which named look is on; `outfit` as the free-text overlay/legacy fallback;
`outfit_exposed` retained but authoritative only on the free-text path — computed from coverage
otherwise; see [wardrobe.md](wardrobe.md)), the anti-repetition `surfacedCues` bands, the RAG carry-overs (`memoryQueries`,
`open_loops` — the archivist's ≤3 "unfinished business" phrases, re-emitted in full each
exchange so resolved loops fall off); persisted narrative `attributeOverlays`;
persisted narrative `trait_overlays` (bounded personality
evolution: `source:"narrative"` trait shifts the archivist proposes only at relationship
milestones, clamped one band from the authored value, guarded to `developable` traits —
resolved on top of the authored traits at prompt build, editable/rollback-safe); the
`voice_exemplars` ring (≤5 distinctly in-voice lines the
archivist picks ≤1 of per exchange, rendered as the "How you sound" few-shots past the
events-only summary horizon; `lastMemoryTrace.characterSlip` is the one-turn
character-consistency corrective);
`lastPulseTrace` / `lastMemoryTrace`), the relationship arc (`relationship_history` — a
≤200 sample ring `{at, clockMinutes, regard, band, familiarity}` appended when either
axis moved; `milestones` — ≤100 of
`first_exchange` / `stage_up` / `stage_down` / `familiarity_up` / `strong_reaction` / `player_marked`),
`callback_history` (the memory-callback anti-repeat ring ≤20 — see [initiative.md](initiative.md) §Memory callbacks),
`body_surface` (per-body-location surface wetness, marks and deposits — see [body-state.md](body-state.md)),
`feeling` (the persistent feeling + bruise — see §Emotional weather), `selfie_history`
(the selfie-send ring ≤20 behind the offer cooldown — see [images.md](images.md) §Selfies), `drives` (the
runtime desires & secrets — see §Drives), and `presence`/`quiet_exchanges`
([multi-character.md](multi-character.md) §Multi-character).

**Chat-wide** — the **scenario** on `character_chats` (`ChatScenario`;
`loadChatScenario`/`saveChatScenario` in `engine/chat-state/store.ts` and `seedChatScenario`
in `engine/chat-state/seed.ts`,
seeded at creation from the PRIMARY's profile — premise from `playerRelationship.note`,
house rules from their own cards — then preset-overlaid and author-owned): the
`premise`, the SETTING-wide `active_social_cards` (one rule set for every member —
per-character divergence rides character **tags** flipping the reaction, never
per-character rule lists), `scene_auto` (`"off" | "milestones"` — text with headroom,
never a boolean), `scene_model`, `scene_memory` (the accumulating narrator-imagined
setting — see [scene-memory.md](scene-memory.md)), `environment` + `affordance_cues` (the
scene's weather and what the affordance read has already said about it — see
[body-state.md](body-state.md) and [affordance-cues.md](affordance-cues.md)), `scene`
(jsonb, migration 0093 — the scene/body-relations
owner's `SceneState`: posture, coarse proximity/facing, support, and the housed
active-contact projection; chat-wide because proximity is a fact about a pair; parsed by
the scene module's own total `parseSceneState`, absent ⇒ empty scene; the durable
provenance is the `chat_contact_events` ledger — the projection is its replayable cache,
gated by `CHAT_CONTACT_ACTIONS`; its sibling `chat_permission_events` ledger (migration
0096, `CHAT_ROMANTIC_PERMISSION`) carries the directional `romantic_touch` grants with NO
stored projection at all — the standing-grant state is folded on read from the
guard-pruned rows, see [physical-legs.md](physical-legs.md)), `supporting_cast` (recurring named side characters — see
[supporting-cast.md](supporting-cast.md) §Supporting cast), `plans` (tracked commitments
that come due on the story clock — see [plans.md](plans.md)), the time model (`clock_minutes` — **one** story timeline
for the whole roster; away members skip meter decay, never fork the clock;
`skip_history` ring ≤50; one-shot `pending_skip_note`; one-shot **`pending_meanwhile_note`**
+ **`meanwhile_pass_at_minutes`** — the meanwhile pass's narrator line and its
cumulative-gate origin / idempotency CAS, migration 0050), the **story-calendar anchor**
(`calendar_start` jsonb, migration 0049 — minute 0 of the chat =
this date+time; `parseOr` heals `{}`/bad rows to `CHAT_DEFAULT_CALENDAR_START` = Jan 1,
8:00am; author-editable via `ChatStateEdit.calendarStart` from the clock card, and
rebasing is safe because nothing stores derived dates), and `pre_exchange_scenario`
(the rollback anchor's chat-wide half).

## The story clock

The calendar derivations are pure in
`contracts/turns/chat-clock.ts` (`chatGameTime`/`timeOfDayFor`/`formatStoryMoment`/
`chatMomentLabel` over `lib/clock.ts`'s Date-backed `resolveGameTime` — real month
lengths, leap years, true weekday alignment). **Time-model constants**:
`CHAT_TICK_MINUTES = 1` (one exchange ≈ one story minute — skips are the
primary time mover), while meter pacing stays exchange-keyed via
`CHAT_METER_DRIFT_MINUTES = 4`; feelings decay per exchange; conditions and plan windows
stay story-real minutes.

Beside the scenario the chat row also
carries `milestones_seen_at` (migration 0043) — the marker seen-cursor
([initiative.md](initiative.md) §Initiative), stamped on conversation open, deliberately outside `ChatScenario`
(it is a UI cursor, not fiction state — never snapshot/rolled back).

`upsertChatState` is the **one** state-row column-list source shared by the guarded
(mid-exchange) and unguarded (author-edit) writers; `editChatState` is ONE patch surface
over both stores (`ChatStateEdit` — per-character fields write the target's row,
chat-wide fields write the scenario) and `chatStateSnapshot(state, scenario)` in
`engine/chat-state/readout.ts` merges
them back into the client's back-compat snapshot shape. State is inspected/edited
through the per-character **Character sheet** and the chat-wide **Scenario** modal
([ui/conversation.md](../ui/conversation.md)).

Finalization and per-member settlement use the focused owners described in
[post-turn.md](post-turn.md) §Finalization owners.

## Retake rollback boundary

A retake is a roster-wide transaction boundary, not a primary-character convenience.
Every `(chat_id, character_id)` row carries its own `pre_exchange_state`; the shared
scenario carries `pre_exchange_scenario`. Before a regenerate or accepted rerun drifts
anything, the pipeline restores every roster member from that same exchange boundary.
After settle, each member's new state and its next rollback anchor use the same
prompt-message existence guard. This covers the full stored state — meters, relationship
axes and history, conditions, feeling, drives, wardrobe, memory queries, open loops,
milestones, callbacks, presence and whereabouts — so a discarded group take cannot survive
through a non-primary row.

`loadPreExchangeState` is three-valued: a recorded `{}` is the
**first-exchange sentinel** (no prior state → the regenerate re-seeds from the
authored defaults, exactly as the live first exchange did), a real state rolls back to
it, and a **missing** row degrades to no-rollback with `chat_state.snapshot.missing`.
`loadPreExchangeScenario` treats `{}` the same way (keep the live scenario).

Only the latest exchange can be rerun in place — its reply as sole successor, or no
successors at all when the reply never persisted (a failed stream; the failure-popup
retry). The no-successor rerun restores nothing: that exchange never settled, so the
live state is already the pre-exchange state and the stored anchor belongs to the
exchange before it. Reaching farther back requires a conversation branch because one
snapshot cannot reconstruct every intervening state; the API rejects that request
before transcript mutation with `rerun_requires_branch`.

The persistence owners are `chat-state/store.ts` for full-row reads and writes,
`chat-state/snapshots.ts` for pre-exchange anchors and rollback, `chat-state/edit.ts`
for explicit edits, and `chat-state/surface-transfer.ts` for atomic transfer settlement.
Guarded writes retain the prompting-message predicate; unguarded manual writes remain
separate. Transfer settlement locks that message before writing, passes one transaction
handle to both sides and their actual rollback anchors, and upserts each distinct
character before its targeted snapshot update.

## Emotional weather

Emotional weather (owner rulings 2026-07-11) is three layers over the meter-derived mood,
all in the pure `engine/chat-feeling.ts`:

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
  hurt→worse-reads→more-hurt cannot spiral); a **warmth streak** (consecutive rising
  samples in `relationship_history`) compounds gains up to ×1.5; a **bruise** — a
  strong drop landing at warm-or-better regard — halves gains for ~10 exchanges
  (ruled). A classified **`apologize`** act (an interaction concept distinct from
  `reassure`: comfort is not repair) that isn't disliked halves
  the bruise's remaining life. A scaled nonzero delta never rounds to zero, the ±5
  clamp is re-applied last, and the trace records `regardScale` + the applied feeling
  for the state tools.
- **Reply pacing** (UI-only, `lib/chat-pacing.ts` + `use-chat-exchange.ts`): the
  client holds the "…" bubble before revealing streamed tokens — cold regard ≈700ms,
  the middle ≈250ms, warm none; a standing dark feeling adds ≈500ms, a bright one
  trims; capped at 1.2s and purely presentational (tokens buffer, nothing is lost;
  any held text flushes on settle/stop/failure). The snapshot carries `feeling` to
  the client for this.

Rollback-safe like everything else: `feeling` rides `storedChatStateSchema`, so
"another take" restores the pre-exchange weather exactly.

## Drives (desires & secrets)

The character's motive force
(owner rulings 2026-07-11): ≤3 authored wants on `profile.drives`
(`contracts/personality/drives.ts` — `want`/`why`/`secrecy: open|guarded|secret` +
an optional `revealBand`), seeded into `character_chat_state.drives` (migration
0035) with runtime `progress`/`revealed`/`resolved`.

- **Prompt law** (`buildDrivesSection`, volatile tail): open drives steer; `guarded`
  never volunteers (comes out only if asked/earned); a `secret` below its reveal
  band is **protected with a full lie license** (ruled) — scoped hard: "the lying is
  for THIS secret only; in everything else you are as honest as you ever are". The
  default gate for an unbanded secret is **familiarity ≥ familiar** (ruled); at/above
  the gate the block flips to an invited reveal ("a big beat — don't force it").
- **Archivist field** `driveUpdates`: progress/reveal/resolve on existing drives,
  matched by exact `want` (the prompt lists them, secrets marked); a degraded
  archivist keeps prior drives. A newly-revealed secret lands a **`secret_shared`
  milestone** (panel glyph ❖, and a prime memory-callback boost); the
  spoken reveal files as an ordinary extracted fact (ruled — no special wiring).
- **Panel** (ruled): the Relationship panel's "What they want" lists open wants +
  revealed secrets only; guarded/unrevealed drives stay invisible until play
  surfaces them. State tools/`ChatStateEdit` expose the full set (inspector-grade).
- **Authoring**: the character forge's profile leg drafts
  drives (concept-led, **≤1 secret** — ruled; `groundDrives` validates reveal
  bands against the band vocabulary and demotes extra secrets to `guarded`); the
  editor's Disposition tab carries the **"Desires & secrets" card**
  (`components/characters/drives-editor.tsx` — want/why/secrecy + a reveal-gate
  picker on secrets). Forge-the-rest fills drives **additively up to the 3-cap**
  (ruled — authored drives never change); a Disposition re-draft re-derives them
  wholesale ([authoring/in-sheet-forge.md](../authoring/in-sheet-forge.md)).
