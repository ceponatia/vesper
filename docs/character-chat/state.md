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
`body_surface` (per-body-location surface wetness — see [body-state.md](body-state.md)),
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
setting — see §Scene memory), `environment` + `affordance_cues` (the scene's weather and
what the affordance read has already said about it — see
[body-state.md](body-state.md)), `scene` (jsonb, migration 0093 — the scene/body-relations
owner's `SceneState`: posture, coarse proximity/facing, support, and the housed
active-contact projection; chat-wide because proximity is a fact about a pair; parsed by
the scene module's own total `parseSceneState`, absent ⇒ empty scene; the durable
provenance is the `chat_contact_events` ledger — the projection is its replayable cache,
gated by `CHAT_CONTACT_ACTIONS`), `supporting_cast` (recurring named side characters — see
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

Only the latest exchange can be rerun in place — its reply as sole successor, or no
successors at all when the reply never persisted (a failed stream; the failure-popup
retry). The no-successor rerun restores nothing: that exchange never settled, so the
live state is already the pre-exchange state and the stored anchor belongs to the
exchange before it. Reaching farther back requires a conversation branch because one
snapshot cannot reconstruct every intervening state; the API rejects that request
before transcript mutation with `rerun_requires_branch`.


## Wardrobe

Since chat-wardrobe-parity (2026-07-14) the chat lane carries **structured worn state**,
not one free-text string. A conversation holds `worn_item_ids` (the worn
item-definition ids, seeded from the active outfit preset), `outfit_preset_id` (which named
look is on), the repurposed free-text `outfit` (an overlay for narrated-but-unowned garments —
"a borrowed hoodie" — and the legacy fallback), and the retained `outfit_exposed` flag.

- **The seam.** `resolveChatWardrobe` (`engine/chat-wardrobe.ts`) is the ONE place worn state
  becomes what downstream reads — a rendered garment phrase (via `wardrobeOutfitText`,
  occlusion-filtered + subtype-led) plus **coverage-computed exposure** (via the shared
  wardrobe classifier `exposedRegions`, [../contracts/items.md](../contracts/items.md)) — reusing the
  shared renderers, never re-forking them. The narrator prompt (`promptStateSlice`), the scene
  image (`queueChatScene` → `renderCharacterSceneImage`'s `exposure` override), and the
  `chat_look` key all read it. When `worn_item_ids` is empty the seam falls back to the
  free-text path (`outfit` + the manual `outfit_exposed`), self-healing the moment a preset
  switch / equip populates the worn list (**migration**: legacy chats stay on the free-text
  path until re-dressed — no sweep).
- **The overlay carries coverage.** Garment nouns in the free-text `outfit` resolve to real
  coverage rows (`contracts/items/garment-noun-coverage.ts`, [../contracts/items.md](../contracts/items.md)
  §Coverage from garment nouns) and reach `exposedRegions` — and ONLY `exposedRegions`, never
  occlusion, cues, or the affordance read, which stay real items. Structured, they can only
  ADD cover: the fix for a modelled thong plus an overlay reading "pale lavender gown"
  computing `torso: "bare"` and putting chest anatomy in the scene prompt. On the **free-text**
  path they are the whole wardrobe, and the precedence is: an exposure claim still wins
  (`outfit_exposed`, or a modelled actor wearing nothing — a stated bare has to beat any garment
  noun still sitting in the text it describes), then the named garments answer PER REGION
  ("wearing only a red thong" is pelvis-covered and torso-bare, which the old all-or-nothing
  fallback could not express), then the covered default. A noun the text itself DENIES or
  DISPLACES ("without a shirt", "the gown pooled at her waist") contributes nothing to begin
  with, so the flag is the backstop rather than the only guard. Text naming no clothing — or
  naming only garments that answer for neither intimate region, like a hat — keeps that
  default: an unmodelled wardrobe is unknown, not nude.
- **Archivist changes.** The archivist's `outfit` field (`contracts/turns/chat-archivist.ts`)
  drives two grammars, folded by `foldOutfitProposal` in `finalizeChatState`: a whole-outfit
  `description` naming an authored preset ("her work clothes" → the Work preset) seeds the worn
  list from it, an unmatched description over a MODELLED wardrobe replaces it **only when the
  proposal's verbatim `changeEvidence` is present in this exchange's text, classifies as an
  asserted, completed change, AND is attributable to the wardrobe's owner**
  (`outfitChangeEvidenceValidated` — grounded + asserted + owner-attributed). Owner ruling
  2026-08-01: nouns cannot tell a same-head change like "a black silk shirt" over a worn cotton
  shirt from a paraphrase, nor an alias "t-shirt"-for-"tee" from a new garment, so only the
  exchange SAYING the outfit changed replaces — and only for the owner it says it about. The
  **assertion** half is the pure `classifyOutfitChangeQuote`
  (`contracts/items/outfit-change-evidence.ts`): negated, modal, conditional, questioned,
  commanded, quoted, incomplete, hypothetical, habitual or idiomatic non-events all keep the
  wardrobe, and a wardrobe verb must put a garment in its object window ("takes off her jacket",
  never "takes off for work"). It returns the ONE sentence that asserted, which is the text the
  **attribution** half then reads. Attribution is **bounded, not coreference**: the owner's
  name/alias anywhere in that sentence carries it, possessives included (the actor need not be
  the owner — "Mara pulls off Sabrina's jacket" is SABRINA's evidence); a sentence naming only
  another participant never does; the player additionally takes first person in their own line
  and second person in the reply; 1-on-1 scenes stay lenient about third-person and markerless
  clauses; and ensemble scenes **fail closed** on a bare pronoun, so one character's change
  clause cannot license another's replacement. An exposure claim skips the gate entirely.
  Lacking validated evidence the structured list is kept
  (`chat_wardrobe.outfit_restatement`; a narrator paraphrase — even one naming no garment,
  like "sleeves shoved past her elbows" — is not a wardrobe action), and the diagnostic
  message names any garment identities the kept description mentioned that no worn item
  accounts for (the `contracts/items/garment-nouns.ts` registry: canonical
  plural/alias/compound identities; telemetry here, and the identity gate in `matchGarment`'s
  delta matching). With nothing structured worn there is nothing to protect and the
  free-text replacement runs as before — and garment-level
  `removed`/`added` fold through the pure `applyWornGarmentChanges` (contracts) against the
  loaded worn items + the character's preset pool — a removed garment drops its id, an
  unmatched added garment rides the overlay (both degrade with a diagnostic, never fail the
  turn). The ensemble members' **personal pass** runs the same two description rungs through
  the pure `settleEnsembleMember` ([multi-character.md](multi-character.md) §Multi-character):
  a whole-look description naming an authored preset re-seeds their worn list exactly like the
  primary (parity closed 2026-08-01) and never reaches the gate, an unmatched one replaces a
  modelled worn list only past validated evidence (scoped to THAT member — on a roster of two
  or more, only their own name in the clause licenses it) or an exposure claim, and otherwise the list
  is kept with `chat_wardrobe.ensemble_outfit_restatement` — a bare message, since naming the
  description's unworn garments needs an item load and that fold is pure. Garment-level
  `removed`/`added` remain the primary's IO-backed path. Rollback-safe: `worn_item_ids`/`outfit_preset_id` ride `storedChatStateSchema`.
- **Editing.** The Character sheet's per-slot equip/remove editor + preset switcher
  (`components/characters/chat-wardrobe-editor.tsx` — [ui.md](../ui.md) §The conversation
  page).

### The garment store — instances under the projection

Since clothing-state-graph slices 0–4 (2026-07-27,
[clothing-state-graph.plan.md](../developer-notes/clothing-state-graph.plan.md) · audit:
[clothing-state-graph.audit.md](../developer-notes/clothing-state-graph.audit.md)) the worn
lists above are a **derived projection** of a deeper truth: the chat-wide garment store on
`ChatScenario.garments` (`character_chats.garments` jsonb, migration 0090). Each worn
definition materializes lazily — on the next state write, never on read — into a
**garment instance**: a content-hash-deduplicated blueprint snapshot (sparse part graph
from its category template, rescoped so node coverage equals the definition's coverage
exactly), a locus (`worn`/`held`/`wardrobe`/`scene`/`gone` — a `scene` garment stays at its
snapshotted place name across scene moves, promotion ruling R3), typed **presentation**
(closures, rolls, tucks, displacement; 0 = fastened → 1 = open), and a **condition** state
(fixed-point wetness/cleanliness/crease/wear base vector + per-part regional overrides +
located deposits and damage marks, integrated lazily to story minutes — only wetness moves
autonomously, drying at a material-scaled rate via the shared `lib/fixed-point.ts` kernel).

- **One dispatcher.** Every mutation is a typed `GarmentOperation` through
  `applyGarmentOperations` (contracts) — transfers, five presentation ops, five condition
  ops — validated against the blueprint's behavior bindings; rejections are stable
  `garment_op.*` diagnostics, never throws. The state route PATCH accepts
  `garmentOperations`; the state-tools sheet queues them per part.
- **One read.** Per-part effective coverage (baseline minus subtraction-only behavior
  deltas, `garment-effective-coverage.ts`) feeds the rewritten visibility resolver — the
  same resolution the narrator exposure gate and image prompts consume. Bands (with ±500
  hysteresis) surface in `garmentReadout`; raw fixed point never leaves the server.
- **Rollback for free.** The store rides the `pre_exchange_scenario` blob, so retakes
  restore blueprints, loci, presentation, and gradients byte-identically (int-tested).
- **`outfit_exposed` demoted.** Authoritative only for unmodelled actors (no instances);
  a modelled actor's exposure always derives from coverage.
- **The extraction lane** (slice 5): the archivist proposes typed garment operations
  over opaque handles the prompt enumerates (`mara.shirt.sleeve_left` — ~200 tokens
  for a 2-actor scene), resolved and applied through the dispatcher in fiction order;
  unresolved handles drop with diagnostics, ad-hoc garments mint from category
  templates (ruling R2), and the old free-text fold runs only as a degraded bridge
  (`chat_garments.legacy_outfit_bridge`) — currently still the path for ensemble
  members beyond the primary. Per-exchange traces surface in the admin inspector.
- **Narration** (slice 6, behind `CHAT_GARMENT_CUES`, default OFF until the tuning
  run): an authoritative per-actor digest (placement + structural presentation, bands
  only) plus at most two ranked, perception-gated garment cues with repeat-key
  gating; the cue/band memory lives at `ChatGarmentStore.cues` so it rides the same
  rollback anchor as the store. The `chat_look` refresh now triggers on a pre/post
  garment fingerprint comparison (worn set, structural bands, wet-and-above,
  deposit/damage presence) regardless of the flag.
- **Still to come** (plan slices 7–8): the successor adapter and the
  body-affordance integration.

### The player's wardrobe

The **player** has one too (persona-library.plan.md slice 8) — "she pulls your shirt over
your head" is a state change, not just prose. It lives on `character_chats.player_state`
(a `ChatPlayerState` jsonb: `personaId`, `wornItemIds`, `seeded`, `outfitPresetId`,
`overlay`) rather than `character_chat_state`, because there is one player and many roster
characters. That placement also puts it inside the `pre_exchange_scenario` rollback
snapshot for free, so "another take" can't leave the player undressed by a discarded beat.

- **Structured-only, no manual flag.** A persona is a library entity with real outfit
  presets, so `resolvePlayerWardrobe` (the character seam's twin in `chat-wardrobe.ts`)
  always computes exposure from coverage. There is deliberately no `exposed` toggle: it
  would be a hole through the scene-image gate that decides whether the viewer's anatomy
  renders (scene-pov-embodiment.plan.md). Their `overlay` carries garment-noun coverage on
  the same terms as the character's (§Wardrobe) — additive over worn items, and the read of
  last resort when nothing resolved and the player was never stripped.
- **`seeded` breaks a real ambiguity.** An empty worn list means *"not dressed yet"* before
  seeding and *"stripped"* after it. Unseeded, `playerWornIds` resolves the persona's
  default preset — so a fresh chat, or a persona whose wardrobe was never authored, doesn't
  read as naked. The flag flips on the first actual change, so the seed materializes on a
  write rather than as a side effect of a read.
- **One archivist field, both directions.** `playerOutfit` (`description`/`removed`/`added`,
  no `exposed`) rides the **shared continuity leg** — never the per-member personal pass,
  where several ensemble members would each propose changes to the one player's clothes.
  The archivist reads the whole exchange, so the player writing "I pull my shirt off" and
  the character doing it are the same event to it. `foldPlayerOutfitProposal` reuses
  `applyWornGarmentChanges` verbatim against the **persona's** preset pool, and carries the
  same change-evidence gate as the character fold (grounded, asserted **and** owner-attributed)
  — tested against `playerWornIds` (so the default preset is protected before seeding too;
  `chat_wardrobe.player_outfit_restatement`) and owner-scoped to the PLAYER: first person
  attributes in the player's own line, second person in the reply, and the wrong half does not
  (first person in the reply is the character speaking).
- **Switching persona resets the wardrobe** (`seeded: false`) — the worn list described the
  person who was wearing it.


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
   — see [prompts.md](prompts.md) §Character-chat reply discipline & scene memory); the time
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


## Scene environment & body surface

Moved to [body-state.md](body-state.md) — the scene's weather and body-surface wetness, the affordance read and its cues, recognition, and the narrator's physical guidance.


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
