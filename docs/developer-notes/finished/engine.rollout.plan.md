# Successor engine — migration and rollout

Status: **shipped — 2026-07-22** (queued 2026-07-21 by owner instruction — the
same ruling that resequenced Gate 7 behind this work: _"schedule the migration
and rollout, with Gate 7 as an optional todo after migration and rollout is
completed and tested."_ — started the same day once the owner resolved all four
opening questions, and exited the next: R0–R2 on 2026-07-21, R3–R6 on
2026-07-22. Completion note: the named R5 leftovers stay recorded in their
slices — the Relationship PANEL still reads legacy, familiarity's floor+volume
mapping is deliberately crude, shadow renders skip admission/recall, sim-side
exposure/coverage semantics + worn-item transfer commands, integrate-on-read
display drift, and scene-exit choreography for language-driven departures. The
chat lane's meter-economy/body-needs plans still port through the Gate 5
contracts, queued in roadmap §Next. Gate 7 stays optional and owner-gated, now
unblocked by this exit.)

Companion to [engine.plan.md](engine.plan.md) (whose §"Migration and rollout"
this plan turns into scheduled, sliced work) and successor to the closed
foundation gates 0–6 ([engine.gate6.dual-lod.md](engine.gate6.dual-lod.md)
closed 2026-07-21). Normative contracts stay in the
[engine.spec.md](engine.spec.md) §-index; this plan owns delivery sequence only.

## Why this plan exists

The foundation is complete but **dormant**: as of 2026-07-21 zero files outside
`src/server/engine/simulation` and its tests consume the sim stores. There is no
API surface submitting sim commands, no authoring UI, no live narrator call —
every seam (§19.3 deliberator, §22–23 narrator boundary) is built and
stub-exercised with zero model calls by design. "Functional" today means the
suites prove the physics; nobody can play in it. This plan closes that gap: the
engine becomes the world authority under the live product, per the
chat-as-test-bed direction (`CLAUDE.md`) — chat leads, lanes stay separate until
unification is proven, and the deprecated world/session model is ultimately
replaced rather than preserved.

## Ground rules (carried from engine.plan.md, unchanged)

- Authority is assigned **per world or branch by feature flag**, never per row:
  `legacy_chat` · `successor_shadow` · `successor_authoritative` ·
  `successor_narrative_view` · `successor_rag_eligibility`.
- Rollback selects the previous authority flag or branch; events stay immutable;
  rebuildable projections/embeddings may be dropped and regenerated.
- Rerender = new prose from the same committed cut; retake = fork; no in-place
  rewind leaves later state behind.
- One narrator call per turn, zero routine state-agent calls, at most one
  deliberator call — the §"Latency and model-call budget" holds in production
  exactly as in the corpus.
- Remove obsolete adapters and superseded legacy code as domains migrate — no
  indefinite compatibility layers (repo rule: delete, don't deprecate).

## Build order

The IDs describe order, not PR numbers; each slice stays reviewable on its own.
R0–R2 are prerequisites for everything after; R3–R5 are the rollout proper; R6
is the cleanup that makes the migration real.

1. **R0 — merge `engine` → `main`.** Status: **shipped — 2026-07-21.** `main`
   merged into `engine` (one `roadmap.md` conflict, resolved), five gates green
   on the merged tree (3 111 pure + 467 int), `main` fast-forwarded to the
   merge commit (engine contained main, so no second merge), and Fly deployed
   at machine version 93 — migrations 0056–0080 live on Neon, app unchanged.
   The long-lived `engine` branch retires here — later slices ride ordinary
   feature branches off `main`.
2. **R1 — authority flags and the internal test world.** Status: **shipped —
   2026-07-21.** `contracts/simulation/authority.ts` (the four ordered lanes +
   orthogonal RAG flag, `consultsSuccessor`/`successorIsAuthoritative`
   helpers); three columns on `character_chats` (migration 0081, additive:
   `engine_authority` default `legacy_chat`, `successor_rag_eligibility`,
   `sim_branch_id` FK SET NULL); the one read/flip seam
   (`server/engine/chat-authority.ts` — parseOr fail-closed reads, flips
   atomic with an `engine_authority_changed` audit row in the app `events`
   table, no-op flips audit nothing); the audited admin dial
   (`GET|PATCH /api/admin/engine-authority/[chatId]`, 404-hidden for
   non-admins, owner-scoped). The standing internal test world
   (`rollout-world.ts`, FIXED ids `rollout-test-world`/`rollout-test-branch`,
   idempotent — found, never re-seeded): two zones + link, four-actor cast at
   mixed LODs (Ana event+meals, Ben event, Riven dormant, Mara default-exact),
   a 200-person cohort, bread for the meal routine; `pnpm sim:seed` /
   `pnpm sim:advance -- --days N` wrap it locally and over Fly SSH (the drain
   loops the bounded seam to convergence). Verified locally: seed → 8 pending
   alarms; one story-day → 5 triggers drained, 3 routine decisions
   (eat_meal + 2× begin_sleep). The action catalog deliberately waits for R3.
   3 new int cases (`test:rollout-r1`, in CI); 3 111 pure + 470 int green.
   **Fly-side exit verified 2026-07-21** (machine v94): `pnpm sim:seed` over
   SSH provisioned the world on Neon (8 pending alarms), and
   `pnpm sim:advance -- --days 3` drained three story-days — 19 triggers
   fired, 9 routine decisions, one converged call, zero model calls — the
   corpus behavior running on production infrastructure. Admission wiring landed
   2026-07-21 (post-slice-3, owner ask — mobile testability): the ordinary
   chat send endpoint forks a PLAIN send through `runSimChatExchange` when
   the chat's authority flag says so — the one place the lanes meet, under
   the same per-chat exchange lock as the legacy pipeline (taken only for
   routed chats; the reply returns in the client's plain-text stream shape
   and the transcript refetch shows both lines). Open/continue/action-beat/
   regenerate/rerun kinds, attachments, and chips stay legacy — a successor
   retake is a branch fork, never an in-place rerender (recorded boundary,
   rides R5). The `/sim-turn` route remains as the thin headless wrapper
   over the same core. First live mobile play (owner, 2026-07-21) surfaced
   the follow-up now fixed: the player's message never reached the narrator
   (background-only prose) — the utterance + a bounded dialogue tail are now
   presentation-lane prompt sections with the attempt-not-outcome guard
   (lawful per the LLM-interpret-language decision + the small-talk license;
   no state path touched, every invariance suite unchanged). **Named
   follow-on — input admission:** a deterministic/small-model leg mapping
   player language onto the typed legal command set BEFORE the turn
   prepares (the plan's "deterministic input admission" budget line), so
   "I hand her the keepsake" executes a real transfer instead of being
   portrayed as an attempt. Belongs early in R5's migration work. Next at
   the time: **R2**.
3. **R2 — the live narrator over the committed cut.** Status: **shipped —
   2026-07-21** (leftover below). `renderCommittedCut`
   (`server/engine/sim-narrator.ts`): load the persisted, hash-verified cut →
   `buildCutRenderPrompt` (pure §22-boundary serializer in
   lib/simulation/presentation.ts) → ONE model call (Aion 3.0 default via
   `resolveChatModelId`; injectable seam so tests run zero live calls; demo
   mode degrades to a deterministic compliant render) → §23.1
   `parseNarratorResult` → §23.2 `auditPresentation` → ruling-8 hidden retry
   from the SAME cut → withhold cleanly after the retry (nothing presented,
   nothing reverted) → on ≥1 enacted effect/proposal,
   `confirm_narrator_result` (system principal, hash-derived idempotent
   command id — rerenders replay it, one speech act ever). Int-proven
   (`test:rollout-r2`, in CI): accept + confirm (a real
   `speech_act_delivered`), hidden retry, clean withhold with row-count
   invariance, rerender-creates-nothing, deterministic bridging.
   **Live exit verified 2026-07-21**: `pnpm sim:render-turn` ran one full
   narrated turn on the internal test world — Aion 3.0 via AionLabs, ONE
   narrator call, audit verdict `accept`, zero diagnostics, ~32s model
   latency (Aion 3.0 reasoning; worth watching against the p95 budget).
   Leftover: the live §19.3 deliberator factory (`PrepareTurnDeliberation`
   remains stub-only; the deterministic fallback governs departures) trails
   into R3, where the play loop first needs it. The first real model call
   in the successor lane: one narrator leg rendering a persisted NarrativeCut
   (presentation-only — `successor_narrative_view`), the §23.1 trust boundary
   and §23.2 structural auditor running against live output, ruling-8 hidden
   retry, `confirm_narrator_result` arming real effects, and the §19.3
   deliberator live behind its budget and deterministic fallback. Model
   routing per ruling 4: Aion 3.0 default, resolved through the shared
   `NARRATIVE_MODELS` picker. The
   owner-gated paired eval rides here ([deferred.plan.md](deferred.plan.md)
   §Owner-gated live eval runs — the Gate 4/5/6 deferred quality checks become
   runnable against this leg on request). Exit: a full narrated turn against the
   internal test world within the latency/model-call budget, degradation paths
   observed live (a failed render withholds, never corrupts).
4. **R3 — the product surface.** Status: **EXITED — 2026-07-22** (slices 1–3 —
   2026-07-21; slice 4 + the live-session fix — 2026-07-22). Exit arc run
   live on Fly (owner ruling: driven via the sim-command API in the owner's
   test chat; owner's own live sessions covered the conversational play):
   end scene → **move** to the square (in_transit honored — a mid-travel
   send refused with the §14.4 public face "They are on the move right
   now", the player line kept, the popup explaining) → arrival
   **witnessed** (co-located with Ben + Riven) → walk home → **talk** (a
   full narrated turn, world-clock colored) → **give** (the keepsake
   transferred in world truth) → **sleep** (rest's full-attention claim;
   mid-rest move refused `activity_conflict`) → **off-screen world life**
   (three bounded advances drained travel arrivals + the rest; head
   sequence 31 → 46, standing rhythms re-armed). No new UI was built for
   typed commands — the API routes were the stated minimum; a player
   command UI rides the successor surface later. Slice 1, *the successor turn
   route*: chat's exchange machine (`submitChatMessage`, ~2 000 lines of
   streaming pipeline) stays untouched — the lanes-separate rule applied to
   code. Instead a parallel, non-streaming route
   (`POST /api/chats/[chatId]/sim-turn`) serves chats whose authority is
   `successor_narrative_view` with a linked `simBranchId`: player text in →
   `prepareEngagementTurn` (span per ruling 1, viewpoint = the player's
   mapped actor, live deliberation joins here — the R2 leftover) →
   `renderCommittedCut` → the prose persisted into the ordinary transcript
   (reuse `persistAssistantReply`) and returned. v1 actor mapping is two
   fields on the admin authority dial (player actor id + primary character
   actor id; the rollout world's Mara/Ana). Slice 1 shipped: migration 0082
   (`sim_player_actor_id` / `sim_primary_actor_id` on `character_chats`),
   the mapping threaded through the authority contract, seam, and admin
   dial, and `POST /api/chats/[chatId]/sim-turn` — gated 409 unless
   authority ≥ `successor_narrative_view` with branch + both actors mapped;
   player line into the transcript, find-or-open the standing scene
   (stable hash-derived open command), prepare → render live → prose
   persisted via `persistAssistantReply` with cut/model/attempt metadata;
   a withheld render is a clean 503 with no assistant line (ruling 8).
   Gates green (3 111 pure + 471 int). Slice-1 leftover: a dedicated
   sim-turn int test rides slice 2 alongside command admission. Slice 2
   shipped: `POST /api/chats/[chatId]/sim-command` — typed admissions
   (`move` · `end_scene` · `give_item` · `start_activity`) under the player
   principal via the shared `requireSimChat` gate; refusals return the §14.4
   PUBLIC face (code, public reason, legal alternatives — proven live by the
   claim-law refusal of moving mid-rest). The R2 leftover landed:
   `buildLiveDeliberation` (threshold 10 000, budget 1, 4s timeout,
   deterministic fallback) wired into the sim-turn's prepare. The rollout
   world gained the `rollout-action-rest` catalog entry and Mara's keepsake
   (fresh seeds only — Fly's standing world needs a delete + reseed to pick
   them up). Slice-1 leftover closed: `test:rollout-r3` (in CI) runs the
   full arc — gate 409 → flip → turn into the transcript (AI_FAKE fallback
   render) → not-held refusal → keepsake handover → end scene → rest →
   blocked move. Gates green (3 111 pure + 472 int). Slice 3 shipped —
   the admin sim family (404-hidden, storyteller principal):
   `POST /api/admin/sim/worlds` provisions a NEW world declaratively through
   the real durable seeders in dependency order (each section validated by
   its own seeder's contract — no second schema to drift; existing worldId =
   409, never a mutation); `GET /api/admin/sim/[branchId]` is the authoring
   status read (clock, cast with locus + LOD, cohorts, pending alarms);
   `POST /api/admin/sim/[branchId]/command` is the tool palette — audited
   `relocate` (ruling 4), §27.2 `promote` from a cohort, the `assign_lod`
   dial, conserved `adjust_cohort` (overdraw = structured public refusal),
   and the bounded `advance` drain. Int-proven end to end
   (`sim-admin.int.test.ts`, in the CI glob): provision → promote "Odell"
   out of the crowd → relocate → dial → adjust → advance a story-day →
   status snapshot confirming every effect (3 111 pure; engine+rollout
   28 files / 207 tests). Live-session fix (2026-07-22): a second chat
   mapped to the same actor pair was refused `participant_already_engaged`
   on every send — the "standing scene" was derived per chat, so find-or-open
   could never *find* across chats — and the failure was invisible (the
   player line only persisted after the open gate, and the ZWSP heartbeat
   marked the reply "received", muting the failure popup). Now: engagement
   identity belongs to the actor pair — `findStandingEngagement` resolves the
   pair's live co-present engagement by participants, opens (head-scoped
   command id, so re-opening after end_scene works too) only when none
   stands, and `end_scene` ends the resolved engagement; the player line
   persists before the scene gate; the client strips the heartbeat before
   counting received bytes, so a refusal shows the ordinary failure popup
   with the §14.4 public reason. **Slice 4 — world-clock parity (shipped —
   2026-07-22; ruling 17).** Live finding: narration colored
   time from transcript prose ("afternoon light" against a morning world
   clock) because the cut prompt renders raw story-seconds
   (`STORY SPAN: second 183600…`) — illegible as time-of-day, so the model
   reads the only legible signal, the dialogue tail — while the header chip
   shows the *legacy* chat clock (`clockMinutes`/`calendarStart` via
   `/state`), unrelated to the branch's `storySecond`. Three clock surfaces,
   no shared truth. The patch (presentation-lane only; authority stays
   `successor_narrative_view`):
   1. *Sim clock seam* — a pure `src/lib/simulation` helper mapping
      `storySecond` → story day index, hh:mm, daylight band (reusing
      `to12Hour`/`daylightBand` from `src/lib/clock.ts`), rendering
      "Day 3 · 10:04am · morning". No weekday/month invention — the full
      calendar anchor is R5's (ruling 17).
   2. *Narrator prompt* — `buildCutRenderPrompt` adds a legible
      `WORLD CLOCK:` line from `cut.fromStorySecond` plus a truth-wins rule:
      light/meals/fatigue color follow the world clock; when the RECENT
      TRANSCRIPT implies a different time of day, the clock wins — shift
      naturally, never lampshade the correction (same pattern as the
      never-imitate-voicing note).
   3. *Header chip parity* — for a sim-routed chat the once-per-open
      envelope carries the branch clock (display-only read) and the strip
      renders it instead of the legacy clock; legacy chats unchanged.
   4. *Player time control parity* — a new `sim-command` kind
      (`advance_time`, bounded minutes/hours/days under the player
      principal): closes the standing scene as `participant_choice` when
      one is open (matching the legacy "Later →" wrap-and-pick-up
      semantics), then runs the bounded advance drain the storyteller
      `advance` already uses; the chat skip affordances (clock card /
      pickup strip) submit it for sim-routed chats, with landing labels
      from the slice-4 clock seam. Build detail to settle in the slice:
      per-skip bound and whether the pickup strip's named skips
      (Later / Next morning / Days later) map by daylight band.
   As shipped: the seam is `src/lib/simulation/clock.ts` (storyClockAt +
   the three formatters; `daylightBandAtMinute` extracted in
   `src/lib/clock.ts` so both lanes share the band thresholds); the
   envelope field is `simClock` (the branch's raw storySecond — the client
   derives the label); the legacy `/time-skip` route 409s for a routed
   chat so the lanes can never double-advance; skips kept the fixed
   CHAT_SKIP_MINUTES amounts (band-mapped named skips deferred to R5's
   calendar work). Tests: pure (clock seam; the prompt carries the WORLD
   CLOCK line and the truth-wins rule), int (advance_time completes the
   standing rest via the drain, the state envelope carries the world
   clock, the next send opens fresh, and the legacy skip lane refuses).
   Gates green (3 120 pure + 474 int). Exit unchanged:
   a human plays a scene in the internal test world on Fly. Minimum playable seam **inside the existing
   character chat UI at `/chat/`** (ruling 1 — no standalone play page): API
   routes that admit player commands into the successor
   (movement, activities, engagement open/close, item transfer), the play loop
   driving `prepareEngagementTurn` → narrator → confirm, and admin-grade
   authoring surfaces (reusing library patterns) for topology, cohorts, rhythms,
   and action definitions. Storyteller tools (relocate, promote-from-cohort,
   LOD dial) surface here too. Exit: a human plays a scene in the internal test
   world on Fly — moves, talks, sleeps, is witnessed — with world life
   continuing off-screen.
5. **R4 — shadow mode under chat.** Status: **EXITED — 2026-07-22**
   (owner marked the tests done and the report agreed: the scripted
   corpus ran clean twice — local AI_FAKE and live Aion 3.0 on Fly — its
   one finding was fixed the same day rather than ruled around, verdict
   triage was proven through both API and the admin screen, and the
   Shadow Parity screen remains available for ongoing played-session
   comparison at any time. Re-planned earlier the same day against
   post-R3 drift; owner rulings below.)
   `successor_shadow` chats run the LEGACY pipeline unchanged; after each
   plain-send exchange settles, a fire-and-forget shadow leg computes the
   successor's view of the same turn against a linked mirror branch with
   **no effects on the chat lane** (the mirror world is the successor's own
   state and may advance). Divergences are recorded rows, not failures —
   this slice exists to find contract gaps before authority moves.
   **Drift corrections vs the original text (written pre-R3):** the lanes
   now meet at exactly one seam (the chat send route's authority fork), so
   shadow hooks a post-settle callback there, plain sends only — the same
   admission scope as the view lane. "Events, projections" have no chat
   counterpart; the comparable domains are **prose** (legacy reply vs a
   successor render from the same utterance + tail), **presence** (roster
   presence vs mirror loci/engagement), **meters** (comparable via the
   ruling-15 parity substrate), and **clock deltas** (the two clocks are
   incommensurate absolutes after slice 4 — legacy `clockMinutes` skips
   mirror onto the branch as advances; only deltas compare). Scene identity
   is pair-based (`findStandingEngagement`), never chat-derived.
   **Owner rulings (2026-07-22):** the comparison corpus runs on the
   owner's own account (amending ruling 2's uxtest-worlds wording — see
   §39), recreating or reusing the standing test worlds; the shadow leg
   DOES render successor prose per exchange because it runs detached and
   adds no perceived turn latency (had that not held, deterministic-only +
   a deferred rethink was the fallback); divergences persist in a
   queryable `sim_shadow_divergences` table (chat, message, domain, legacy
   value, successor value, verdict) with an admin read + verdict surface,
   so the exit report is computed, and "ruled intentional" is a durable row
   verdict. Shadow renders skip live deliberation (deterministic fallback
   only — comparison prose doesn't justify a second model call class).
   **Slice 1 shipped — 2026-07-22:** the `onSettled` pipeline signal (fires
   on every settled exchange; the route gates it to shadowed plain sends),
   `sim-shadow.ts` (keyed-lock guarded, never-throw: prose render from the
   same utterance + pre-exchange tail, presence vs the pair's standing
   engagement, meters via ruling 15, raw clock captures), the
   `sim_shadow_divergences` table (migration 0083), the legacy time-skip
   mirror onto the branch clock, and
   `GET|PATCH /api/admin/sim/shadow/[chatId]` for listing + durable
   verdicts. Int-proven (AI_FAKE, `sim-shadow.int.test.ts`) and
   live-smoked on Fly on the owner's account: same player line, two
   worlds side by side — the legacy lane's authored New-Year's-morning
   scene vs the successor's Day 3 · 2:40pm afternoon render; transcript
   untouched (2 lines), legacy latency unaffected (~32s own model call),
   a clock verdict ruled `intentional` through the API.
   **The successor front door — shipped 2026-07-22 (owner ask + three
   rulings):** the `/worlds` nav slot is repurposed as the successor
   engine's front door. `POST /api/successor-chats` spins up a complete
   successor chat in one call — an ordinary character chat, a FRESH
   starter world per chat (`starter-world.ts`: home + square a 5-min walk
   apart, the player and the character's actors named automatically, a
   neighbor at the square, a keepsake, a rest action; isolation is the
   point — no two chats share a standing scene), and the audited flip to
   `successor_narrative_view` with both actors mapped. `GET` lists the
   caller's successor chats with each world's clock. Open to all
   signed-in users (ruling: every account on this deployment is a dev;
   sign-up is closed), capped at 25 worlds per user. The new Worlds page
   (`successor-worlds-page.tsx`) is the form + list; the **legacy
   world-model UI was deleted the same day** (ruling: index/forge/
   detail/edit pages, `components/worlds/*`, the library's worlds
   entity, the dashboard's worlds section — the world-model ENGINE code
   survives until R6's cleanup; the session wizard's dead forge CTA now
   points at Worlds). Int-proven end to end (`successor-chats.int.test`:
   provision → route → a full sim turn through the ordinary send → list
   with world clock). Gates green
   (3 120 pure + 477 int). **Slice 2 shipped — 2026-07-22:** the fixed
   corpus (`pnpm sim:shadow-corpus`, versioned in
   `scripts/sim/shadow-corpus.ts` as `shadow-corpus-v1`: four plain sends
   + one mid-corpus "hours" skip on a fresh shadow chat, every detached
   leg awaited so a run is deterministic and complete when it prints),
   the pure scale-aware analyzer (`lib/simulation/shadow-parity.ts`:
   clock DELTAS within ±2 min, meters normalized 0..1 within ±0.15 per
   shared key, recorder-judged presence/prose, ruled rows out of
   findings, malformed rows skipped never thrown), and the computed
   report at `GET /api/admin/sim/shadow/[chatId]/report`. First local
   corpus run (AI_FAKE): clock parity CLEAN across all steps including
   the mirrored skip; presence + prose clean; one real finding —
   **`intoxication`, `mood`, `stress` are tracked chat-side but not
   instantiated on the mirror actor** (ruling 15's registry-data seam:
   the rollout world seeds only arousal/energy/hygiene). Gates green
   (3 124 pure + 477 int). First LIVE corpus run on Fly (real Aion 3.0,
   8 model calls) matched the local run exactly — clock/presence/prose
   clean, same single meters finding. **Finding triaged — owner ruled
   "fix" (2026-07-22):** stress/intoxication/mood joined
   `bodyMeterRegistryV1` (semantics ported from the chat registry:
   stress decays toward calm, intoxication metabolizes to sober, mood is
   a valence returning to its 0.5 keel; prompt-hint thresholds stay
   chat-side). Body initialization became **additive** — an
   already-seeded body initializes only its MISSING registry meters
   (`existingMeterKeys` replaces the boolean; a fully-covered body still
   rejects `body_already_initialized`) — so a grown registry upgrades
   standing worlds lawfully through the event log; `seedRolloutTestWorld`
   runs that ensure pass (registry-stamped command ids) on its
   found-world path, meaning `pnpm sim:seed` is the upgrade command.
   Corpus re-run after the fix: **zero findings** — all six meters
   shared and within tolerance — and the LIVE Fly re-run (real Aion 3.0
   after `pnpm sim:seed` upgraded the standing world's bodies in place)
   confirmed it: 16 rows, clock/presence/prose/meters all clean,
   `findings: []`. **Slice 3 shipped — 2026-07-22: the admin Shadow
   Parity screen** (owner ask — no raw API calls to review):
   `/admin/shadow` lists every chat with recorded rows (open/total
   counts, via the new `GET /api/admin/sim/shadow` index);
   `/admin/shadow/[chatId]` renders the computed report card (findings,
   verdict tallies, per-domain summaries), the exchanges grouped
   newest-first with prose pairs side by side, and per-row verdict
   buttons (open / intentional / fixed). Client layer
   `lib/api-shadow.ts` (forgiving schemas, admin bundle kept out of the
   player module); reached from the account menu's admin-only "Shadow
   parity" item; enforcement stays the 404-hidden API family. Remaining
   for exit: owner-played shadowed sessions on Fly and the owner
   agreeing the report — now both doable entirely in the browser.
   Exit: an agreed shadow-parity report over a fixed comparison corpus;
   every divergence either fixed or ruled intentional.
6. **R5 — domain-by-domain authority migration.** Status: **EXITED —
   2026-07-22** (all seven slices shipped the same day; the owner closed
   the remaining domain and the exit together — see slice 7 below).
   **Re-framed (owner ruling 2026-07-22, correcting pre-front-door
   drift):** nobody migrates in place anymore — successor chats are BORN
   successor (the Worlds front door) and legacy chats stay legacy until
   R6 retires that lane. R5's real work is that successor chats are
   HYBRIDS: the sim owns time/scene/narration while the strip's
   mood/regard chips, wardrobe, meters, action chips, relationships, and
   memory still read legacy chat-state rows. Each R5 domain makes the
   successor authoritative for successor chats, surface by surface
   (time/clock → space/presence → bodies & meters → items/wardrobe →
   knowledge/memory → relationships). Dual writes are dropped; the R4
   shadow substrate is the comparison harness; rollback stays the
   authority flag. `successor_rag_eligibility` flips when the knowledge
   domain lands; the chat lane's meter-economy/body-needs plans port
   through the Gate 5 contracts here rather than being built twice.
   **Slice 1 shipped — 2026-07-22: the time/clock domain (ruling 17's
   full calendar).** A nullable `calendar_start` on `sim_worlds`
   (migration 0084; the DATE of story day zero — presentation config,
   edited in place, never through the event log: it re-labels history).
   The whole integration is ONE adapter (`storyCalendarParams`:
   storySecond 0 = the anchor date's midnight ⇒ `{clockMinutes: s/60,
   start: anchor@00:00}`), after which every legacy Gregorian formatter
   is correct verbatim — zero new date math. Anchored worlds render
   "Monday, June 1 — 8:01am (morning)" in the narrator's WORLD CLOCK
   line (presentation input on the render conversation; shadow renders
   too), "Mon · 8:01am" in the strip chip, the full date in the clock
   card, and calendar landings on skip previews; unanchored worlds keep
   "Day N". The clock card's "story starts on…" editor returns for
   successor chats (`PATCH /api/successor-chats/[chatId]`, date-only,
   nullable to clear); starter worlds default to Monday, June 1 2026.
   `readSimChatClock` (né readSimChatStorySecond) now carries
   `{storySecond, calendarStart}`. **Slice 2 shipped — 2026-07-22: input
   admission** (the R1 leftover, owner-ruled next). Deterministic by the
   budget line (zero extra model calls): `admitPlayerCommand`
   (`lib/simulation/input-admission.ts`) matches the player's UNQUOTED,
   first-person sentences against the world's ACTUAL legal surface —
   items the player holds (give/hand/pass), zones that exist
   (go/walk/head + kind-derived words), catalog rest actions
   (rest/sleep/lie down) — admitting at most ONE command per turn,
   silence over cleverness (a wrong admission is a real world write).
   Wired into `runSimChatExchange` AFTER the scene resolves so claim law
   judges in context: an ACCEPTED command executes durably under the
   player principal and the narrator gets a "PLAYER ACTION — already
   EXECUTED in world truth" section (portray as done, never an attempt);
   a REFUSED one feeds the cut's §14.4 `failurePresentations` and the
   refusal is narrated lawfully (resting or walking off mid-scene fights
   the engagement's attention claim — correct, and the scene-exit
   choreography for language-driven departures is the named leftover for
   a later admission pass; shadow renders skip admission for now). Int:
   "I smile and hand her the keepsake" moves the REAL item to the
   primary actor; a refused rest still renders a turn. Gates green
   (3 126 pure + 480 int). **Slices 3+4 shipped — 2026-07-22: the
   presence and meters surfaces** (`sim-surfaces.ts` — the read seams the
   chat envelopes call for ROUTED chats instead of legacy chat-state
   rows; legacy and shadow lanes untouched). Slice 3, presence/space:
   the transcript envelope's roster presence for the PRIMARY comes from
   the mirror's `sim_physical_loci` — co-located ⇒ present, in transit
   or another zone ⇒ away (with a zone-kind whereabouts phrase held for
   the roster panel's later use). Slice 4, bodies & meters: the state
   envelope's meters come from the ruling-15 substrate (fixed-point
   /10 000 onto the chat's 0..1 scale) merged over the drifted legacy
   record BEFORE `chatStateSnapshot` derives — so the mood chip and
   meter pips now derive from world truth with zero UI changes.
   Integrate-on-read for display (drift since last write) is the named
   refinement. Int-proven: storyteller relocation flips the roster to
   "away"; a world-truth hygiene write shows in the envelope where
   legacy would still show the seed. Gates green (3 126 pure +
   480 int). **Slice 5 shipped — 2026-07-22: items/wardrobe.** The
   substrate already modeled worn items (locusKind `worn` + slotKey), so
   the port is direct: the successor-chats POST resolves the character's
   authored default outfit through the SAME wardrobe seam the chat seed
   uses (`seedChatState` → `loadChatWardrobe`) and provisioning births
   the garments as items WORN by the primary actor (slot keys from
   coverage, index-uniqued); `readSimChatOutfit` serves the worn names
   slot-ordered, and both the transcript roster's outfit and the state
   envelope's `outfitLabel` read it for routed chats ("" = honestly
   nothing worn; legacy/shadow untouched). Exposure/coverage semantics
   sim-side and worn-item transfer commands are the named leftovers.
   Int-proven: two authored garments become two worn world items and
   surface in both envelopes. **Slice 6 shipped — 2026-07-22:
   knowledge/memory (owner rulings: full embeddings now; build the
   summarizer now; inline bounded drain).** The §24 machinery was
   complete but disconnected — nothing drained the index outbox in
   production and the narrator never queried. Now each routed exchange
   (gated on `successor_rag_eligibility`, which the front door flips
   TRUE at birth — the R1 flag finally lands): a bounded inline drain
   (live embedder; `pseudoEmbed` + embedder-isolation keep every test at
   zero calls), the utterance embedded, `queryMemoryDocuments` for the
   PLAYER viewpoint (perception-partitioned by construction), and the
   epistemic-labeled results ride a new "VIEWPOINT MEMORY" prompt
   section — context, never new facts, degrading to absent on any
   failure. Conversational continuity: the legacy fold summarizer is
   reused UNCHANGED (`enqueueChatSummary` after each settle — the job
   self-dedupes and no-ops below its trigger; the transcript is the
   ordinary chat lane's), its rolling summary rides a "CONVERSATION SO
   FAR" section, and the dialogue tail widened 6 → 12. Pre-slice
   successor chats keep recall OFF until their flag flips via the dial.
   Shadow renders skip recall/summary (leftover with admission).
   Int-proven: rag-eligible at birth; the give-transfer's events project
   into `sim_memory_documents` through the inline drain. Gates green
   (3 128 pure + 480 int). A live find rode this slice: the narrator
   echoed the output contract's placeholder verbatim and the §23.2 audit
   accepted it — the audit now treats template echoes as empty prose
   (rerender → ruling-8 retry → clean withhold). **Slice 7 shipped —
   2026-07-22: relationships — and the R5 exit.** The §21 ledger is the
   chip's truth for routed chats: `readSimChatRelationship` folds the
   directional dyad through `deriveRelationshipRead` (authored-prior
   weights honored) and maps trust/attraction/resentment onto the
   −100..100 regard scale (monotone, documented, tunable; the ±3 000
   strong band ≈ ±75); familiarity = an authored-prior floor (40) plus
   lived dyad evidence. The front door seeds an AUTHORED starting
   relationship as an `authored_prior` entry pair weighted to round-trip
   the authored regard through the read (trust 36r + attraction 8r);
   no authored record ⇒ an honest-empty ledger and the legacy seed keeps
   the chip until evidence accumulates. The state envelope overrides
   regard/familiarity before the snapshot derives, so bands and copy
   follow world truth with zero UI changes. §21's time decay applies to
   the prior too (history fades against lived evidence — embraced, and
   the tests assert bands, not exact scalars). Leftovers named for
   later: the Relationship PANEL (sparkline/milestones) still reads
   legacy; familiarity's floor+volume mapping is deliberately crude.
   Int-proven: the warm prior reads back in-band; a recorded
   affection_shown MOVES the chip where the frozen legacy seed could
   not. Gates green (3 129 pure + 480 int). **R5 exit:** every planned
   domain (time/clock, input admission, presence/space, bodies & meters,
   items/wardrobe, knowledge/memory, relationships) is
   successor-authoritative for successor chats' surfaces, each proven by
   int arcs and live sessions on Fly; legacy and shadow lanes untouched
   throughout, rollback remaining one authority-flag flip. Next: **R6 —
   cleanup and legacy retirement.** `successor_rag_eligibility` flips when
   the knowledge domain lands. The chat lane's meter-economy/body-needs plans
   (roadmap Next) port through the Gate 5 contracts here rather than being
   built twice. Exit per domain: dual writes stopped, legacy write path
   removed, invariants green for the declared window.
7. **R6 — cleanup and legacy retirement.** Status: **shipped — 2026-07-22 —
   and the plan EXITS.** The long-anticipated deprecation, executed as
   deletion (remove, don't wrap) the day R5 exited. Scope ruling applied:
   what retired is the world/SESSION model — the legacy CHAT lane is a live
   product lane, not a dead one, and stays under its `legacy_chat` flag.
   Code: 155 files removed by inventory — the session pages + API
   (`app/sessions`, `api/sessions`, `api/worlds`), the play UI and session
   wizard, the session turn pipeline (`engine/pipeline.ts`, `merge/`, the
   session prompts and state agents, intake/intent/scene/movement/spawn/
   recovery/bundle/demo), legacy world CRUD + world forge, memory's
   `preTurnRetrieve` + world-lore lane, session contracts (`perception/`,
   `actions/registry`, `world/access`, session-runtime/brief/
   participant-state, turns/{agent-results,intent-brief,inner-note,
   stream}), orphaned lib (cast-tiers, player-token, world-graph-layout,
   the session SSE client), and the legacy eval scripts. Exactly ONE live
   cross-lane coupling existed — `NARRATIVE_TEMPERATURE`, relocated into
   `engine/constants.ts`; three small shapes were rehomed into their chat
   consumers (`scheduleEntryAt`, `attributeChangeSchema`, the
   attention-hint enum) and `instrumentation.ts` retired outright (chat
   registers its job handlers at import). Database: migration 0085 drops
   the 14 legacy tables (worlds/world_*/lore_chunks/sessions/session_*/
   item_instances/participant_relationships/turns/turn_messages) and the
   five `session_id` columns (episodes/facts/images/jobs/events); memory
   scope became a one-armed chat union (future scopes additive);
   `logEvent`/job enqueues lost their session params; the library's
   Worlds facet, items' world placements, gallery's session/world views,
   and the dead session render path in `images/scene.ts` went with them.
   Docs: the system map + the mixed system docs rewritten to the two-lane
   reality; the session-lane docs (turn-engine, perception, story-threads,
   world/session guides, contracts perception/turns) deleted; chat's
   prompt architecture re-homed at `docs/character-chat/prompts.md`; both
   CLAUDE.md state notes updated. Gates green after the drop: lint ·
   cycles · typecheck · 2 356 pure · jscpd · 415 int. Deployed to Fly
   (machine v114) with a pre-deploy Neon safety branch
   (`pre-r6-legacy-drop`) so the dropped tables' data outlives the 6h
   PITR window; verified live — legacy tables absent on Neon,
   `/sessions` + `/api/worlds` 404 while authenticated, dashboard/
   Worlds/Gallery render clean. Exit met: one authority per world (the
   per-chat authority flags are the only lanes), no dead lanes,
   docs/README system map updated.

**Completed and tested** meant: R0–R6 exited, the five repo gates green
throughout, the shadow-parity report accepted, at least one owner-run live eval
recorded, and the internal test world + one migrated chat world stable on Fly.
All hold as of 2026-07-22 — the R4 parity report closed at zero findings with
every divergence fixed or ruled, the owner's live played sessions on Fly
through R3–R5 are the recorded live evals (the deeper owner-gated eval spend
stays parked in [deferred.plan.md](deferred.plan.md)), and the internal rollout
world plus the owner's standing successor chats run live on machine v114.

## After completion — Gate 7 (optional, owner ruling 2026-07-21)

[Gate 7 — institutions and macro simulation](engine.gate7.institutions.md)
is explicitly sequenced **after** this plan completes and is tested, and stays
**optional**: admit a package (employers, markets, weather, law, factions…)
only when a world type and scenario corpus justify it, per that doc's
declaration checklist. Nothing in R0–R6 depends on Gate 7; nothing in Gate 7
may begin before R6 exits without a new owner ruling.

## Resolved rulings (owner, 2026-07-21)

All four opening questions were answered the day the plan was queued:

1. **First player surface — the existing character chat system at `/chat/`.**
   R3 builds no standalone play page: chat IS the surface, per the test-bed
   direction. The successor play loop lands under the chat UI for flagged
   worlds.
2. **Shadow comparison corpus — the UX-test account's worlds** (the dedicated
   `uxtest-main@vesper.local` worlds, e.g. Tsukikage Onsen). No player-owned
   world is shadowed. **Amended (owner, 2026-07-22, R4 kickoff):** the corpus
   runs on the owner's own account's test chats instead — the original wording
   named world-model worlds (the deprecated lane), but R4 is shadow under
   *chat*, and by kickoff the owner's account already carried the standing
   successor test chats. Test worlds may be recreated or reused as needed; the
   never-shadow-organic-play intent stands (dedicated test chats only).
3. **R5 domain order — author's call, sequenced by dependency.** The owner
   expects fast iteration; the order in R5 stands unless a dependency proves
   otherwise mid-build.
4. **Narrator model — Aion 3.0 (`aion-labs/aion-3.0`) first**, keeping the
   curated `NARRATIVE_MODELS` picker (`src/lib/narrative-models.ts`) so any
   accepted model can be chosen — the successor narrator leg resolves through
   the same list chat uses. Side ask landed with this ruling: **Grok 4.5
   (`x-ai/grok-4.5`) added to the accepted list.**
