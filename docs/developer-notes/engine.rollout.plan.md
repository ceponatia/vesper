# Successor engine — migration and rollout

Status: **active** (queued 2026-07-21 by owner instruction — the same ruling
that resequenced Gate 7 behind this work: _"schedule the migration and rollout,
with Gate 7 as an optional todo after migration and rollout is completed and
tested."_ — and started the same day once the owner resolved all four opening
questions; see §Resolved rulings).

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
5. **R4 — shadow mode under chat.** Status: **active — 2026-07-22**
   (re-planned the same day against post-R3 drift; owner rulings below).
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
   Exit: an agreed shadow-parity report over a fixed comparison corpus;
   every divergence either fixed or ruled intentional.
6. **R5 — domain-by-domain authority migration.** `successor_authoritative` one
   domain at a time (candidate order: time/clock → space/presence → bodies &
   meters → items/wardrobe → knowledge/memory → relationships), each with dual
   writes through its invariant window, fixture comparison, and a rollback
   window before the next domain starts. **The time/clock domain expands the
   R3 slice-4 clock work into full calendar integration (ruling 17):** a
   calendar anchor on the world config maps `storySecond` → weekday/date
   (superseding the legacy `CalendarStart`/`clockMinutes` lane as the one
   time authority), the slice-4 presentation seam upgrades to render it
   (prose and chip say "Monday morning", not just "Day 3"), and **optional
   player control is the domain's product surface**: time advances naturally
   through play, or the player skips N minutes / hours / days — the slice-4
   `advance_time` admission graduating from bounded skip to the domain's
   authoritative time control, with chat's pickup/skip affordances migrating
   onto it. `successor_rag_eligibility` flips when
   the knowledge domain lands. The chat lane's meter-economy/body-needs plans
   (roadmap Next) port through the Gate 5 contracts here rather than being
   built twice. Exit per domain: dual writes stopped, legacy write path
   removed, invariants green for the declared window.
7. **R6 — cleanup and legacy retirement.** Delete the migrated adapters, the
   dual-write shims, and the superseded world/session-model code paths the
   migration obsoletes (the long-anticipated deprecation — remove, don't wrap).
   Exit: one authority per world, no dead lanes, docs/README system map updated.

**Completed and tested** means: R0–R6 exited, the five repo gates green
throughout, the shadow-parity report accepted, at least one owner-run live eval
recorded, and the internal test world + one migrated chat world stable on Fly.

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
