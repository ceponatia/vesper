# Codebase review — the Opus-era diff (vesper vs reverie)

Status: **findings record** (2026-07-02). The durable output of a five-agent
review of everything written since the fork from reverie. Remediation is
batched: batch 1 (correctness & security) is planned in
[codebase-review.plan.md](codebase-review.plan.md); batches 2–4 graduate to
their own `<topic>.plan.md` as they're picked up (see the batch map). Findings
here carry ids (A1…, B1…, C1…) so plans can cite them; file:line references
were verified 2026-07-02 and may drift — re-verify when implementing.

## Method & verdict

Vesper forked from reverie (`~/projects/reverie`, fully Fable-built, frozen at
"fable model no longer available"). Every diff since `50f6387 Initial commit:
Vesper` — 678 files, ~129k insertions (~41k in `src/`), 173 commits through
`87f740d` — is Opus-4.8-era work. Five parallel review agents each read one
area (prompts · turn engine · contracts · server/API · UI) against the reverie
baseline and the system docs; the two highest-stakes findings (A1, A2) were
independently re-verified against the code before this doc was written.

**Verdict: no systemic drift.** parseOr discipline, degraded defaults with
diagnostics, auth/ownership coverage on every route, module boundaries, and
roadmap hygiene all held. The prompt work *improved* on reverie (shape
profiles, presence rules, proportionate reaction). The recurring debt shape is
**patterns re-instantiated by copy instead of extracted** — the chat lane
forked the session lane's machinery; the editor scaffold exists 4×, the poll
loop 6×, the owned-entity lookup ~10× — plus a short list of real bugs, three
of which silently disable designed gameplay systems.

## Batch map

| Batch | Scope | Findings | Plan |
| --- | --- | --- | --- |
| 1 — Correctness & security | Confirmed bugs + the security trio + small client fixes | §A, §B | [codebase-review.plan.md](codebase-review.plan.md) (**shipped — 2026-07-02**) |
| 2 — Prompt intelligence | Session-lane voice/personality, content framing, craft rules, schema matches, forge | §C | unplanned — needs `<topic>.plan.md` when active |
| 3 — Chat-lane consolidation | Route→engine extraction, shared machinery, `docs/character-chat.md` | §D | unplanned |
| 4 — Dedup & cleanup sweep | Server helpers, UI hooks/primitives, contracts registry consolidation, dead code | §E | unplanned |

---

## A. Correctness bugs (batch 1)

- **A1 — Condition→mood never fires in sessions.** The standing-shift table
  (`src/contracts/mood/events.ts` `CONDITION_MOOD_BASELINE_SHIFTS`) and the
  tipsy/flustered emotion-tint sets (`src/contracts/mood/projection.ts:91`)
  key on `c.id`, but the merge assigns conditions `id: newId()`
  (`merge/phases/conditions.ts:51`) with the semantic word in `label`. The
  sibling maps (`conditions/catalog.ts`, `perception/darkness.ts`) correctly
  match by normalized label. The contract tests mask the bug by setting
  `id === label`. Fix: shared normalized-label key helper; realistic ids in
  tests. (Structural fix — fold all condition tables into the catalog — is E-K1.)
- **A2 — Authored taboo cards die after chat turn 1.** `saveChatState`'s
  guarded first-exchange insert and its `on conflict … do update set`
  (`src/server/engine/chat-state.ts` ~:600) omit `outfit`, `outfit_exposed`,
  and `active_social_cards`, which `persistChatState` does write. A fresh
  chat's first exchange creates the row with DB default `[]`, silently
  discarding the cards `seedChatState` seeded from `profile.socialCards`. No
  diagnostic; int tests don't cover the path.
- **A3 — The `taste` exposure axis resets every turn.** The director's schema
  carries `taste` (`contracts/turns/agent-results.ts:206`, `.catch("none")`),
  but the prompt never mentions it — axis doc line (`prompts/agents.ts:89`),
  prior-brief render (:286), and all four examples omit it — so it parses to
  `"none"` each turn and intimate-scene taste permission flickers.
- **A4 — Malformed JSON → "generate everything".** The batch image routes
  (`app/api/items/images/route.ts:25`, `locations/images/route.ts:25`) discard
  the constructed 400 (`body.ok ? { ids } : undefined`) and proceed with no id
  scope — queueing paid renders for every missing entity up to `MAX_BATCH`.
- **A5 — One bad trait entry rejects a whole character profile.**
  `traitValueSchema.source` (`contracts/personality/traits/value.ts:15`) lacks
  the leaf `.catch()` resilience.md §3 requires; the array embeds bare in
  `characterProfileSchema`, so a single malformed entry degrades the entire
  profile to fallback at the JSONB boundary. `attributeValueSchema`
  (`attributes/value.ts:25`, Fable-era) has the same gap.
- **A6 — Chat POST has no concurrency guard.** Two in-flight exchanges both
  load state, both drift the clock, both run pulse+archivist; the finalizer
  upserts land last-write-wins (`app/api/characters/[id]/chat/route.ts:93`).
  The session lane treats this as a hard invariant (CAS `ready→narrating` +
  per-session queue, `pipeline.ts:153`, tested); chat has nothing.
- **A7 — Memory-write failure discards pulse state.** `finalizeChatState`
  (`chat-state.ts:543`) runs `writeChatMemory` (a throwing DB write) *before*
  `saveChatState`; a throw aborts the finalizer and the exchange's
  affinity/mood/mindNote/clock changes are lost with only a route-level log.
- **A8 — Chat summary fold enqueue race.** Check-then-insert dedupe
  (`chat-summary.ts:162`) + immediately-executing detached jobs
  (`jobs.ts:196`) allow two concurrent folds for the same chat — a paid
  double-LLM-call race (idempotent-by-recompute, so no corruption).
- **A9 — Chat Clear is five sequential deletes, no transaction**
  (`chat/route.ts:283`) — a crash mid-way leaves a half-cleared conversation.
- **A10 — Client-side small fixes.** `meterPips` hardcodes thresholds
  duplicating `contracts/meters/registry.ts` (`character-chat.tsx:518` —
  registry edits silently desync the chat strip); the entity-library search
  debounce keeps its timer in `useState` (stale closure → duplicate fetches,
  no unmount cleanup; `entity-library.tsx:239`); the image lightbox is
  `aria-modal` with no Tab trap despite the shared `useFocusTrap`
  (`image-lightbox.tsx:33`); `saveChatModel` fires unguarded PATCH-per-pick
  (out-of-order persistence; `character-edit-page.tsx:85`).

## B. Security (batch 1)

- **B1 — Seed provisions a repo-committed default password.**
  `ensureDevCredential` (`scripts/db-seed.ts:318`, `server/auth/dev.ts:15`)
  writes a real Better Auth credential (`DEV_PASSWORD ?? "vesper-dev-password"`)
  usable through the **public** sign-in surface; `/api/dev/impersonate`
  correctly 404s in production but the credential doesn't depend on it. Guard
  the seed in production.
- **B2 — `BETTER_AUTH_SECRET` passes through unchecked** (`auth.ts:78`); if
  missing, Better Auth silently uses its built-in dev secret — forgeable
  session cookies. Hard-fail at boot in production.
- **B3 — Model ids unvalidated server-side.** `narrativeModelId`/`agentModelId`
  (`server/ai/provider.ts:138/:157`) are trim-or-default despite doc comments
  claiming curated ids; the chat POST `model` param and `characterPatchSchema.chatModel`
  flow through the same way. Any authenticated user can bill arbitrary
  OpenRouter slugs to the deployment key. Make the resolvers strict.
- **B4 — `dev/me` gate order** (`app/api/dev/me/route.ts:8`): `withUser` runs
  before the production 404, revealing route existence and diverging from the
  other dev routes.

## C. Prompt intelligence (batch 2)

The prompt architecture (byte-stable rulebook / volatile turn context, the
presence rule suite, eval-ruled shape profiles, agent worked examples,
untrusted-span fencing, the image-prompt pipeline) is good — don't rework it.
The wins are gaps:

- **C1 — Session narrator never sees authored `personality`/`voice` prose**
  (highest payoff, M). `buildCanonicalFactsBlock` (`scene.ts:706`) emits only
  name/age/species/bio; only the chat lane reads the prose. Fix: a cached
  "Cast voices" block in `buildStaticRulebook` (session-stable ⇒
  prefix-cache-safe), fenced, per NPC: voice + ~300-char personality excerpt.
  Proposal already written: [unconsumed-character-prose.md](unconsumed-character-prose.md).
- **C2 — Session lane lacks the chat lane's content license + no-refusal rule**
  (S). Port `CONTENT_FRAMING` (`character-chat.ts:302`) and a prose rule
  ("never break narration to refuse/caution/moralize/disclaim; hesitation is
  the character's in-world choice, in their voice") into the static rulebook
  (`narrative.ts:183`).
- **C3 — No intimate-scene craft guidance in either lane** (S/M). Exposure
  rules gate *what senses may be described*, nothing governs *how to write the
  scene*. Add a small volatile block on the existing intimate gate
  (`scene.ts:779`): staged escalation held to the player's pace; body/clothing
  continuity turn-to-turn; intimate disposition drives initiative; concrete
  sensation over florid abstraction; desire in the dialogue (fragments,
  breath). Orthogonal to the queued intimacy-notes plan (content, not craft).
- **C4 — No dialogue-craft rule in either lane** (S). Rule 5 asks for
  quantity; add one rule per lane: speech-like dialogue (contractions,
  fragments, interruptions, subtext), distinct per-character rhythm, silence
  as an answer. Pairs with C1.
- **C5 — Intake few-shots teach omitting the `focus` planner** (S). Examples
  B/C/E (`prompts/intake.ts:51`) carry no `focus`; the `.optional()` field
  silently degrades Phase-3 shaping. Add focus to every example or a "always
  emit for in-character turns" rule.
- **C6 — Chat archivist says "three fields", lists four** (S).
  `chat-archivist.ts:13` — and the worked example omits `attributeChanges`, so
  the attribute-proposer under-fires. Fix the count + add a haircut micro-example.
- **C7 — Forge prompts are genre-neutral in a romance-first product** (M).
  `character-forge.ts:263`, `world-forge.ts:643/:156`: ask for attraction
  behavior (how they flirt/deflect/signal), voice notes ending in 1–2 sample
  dialogue lines, and 1–2 cast members with clear romance potential — steers,
  not mandates.
- **C8 — Wording/noise fixes** (all S): "Recent story (style and voice only)"
  mislabels archivist summaries as the voice reference (`narrative.ts:362` +
  authority-order line — relabel "summary recall, never a style model");
  `RESPONSE_CONTRACT` rules 1/3 near-duplicates (`narrative.ts:131`); mangled
  perceived-affinity line "believes {player} is cherished-warm toward her/him"
  (`scene.ts:1150`); exposure escape hatch "unless this turn's events change
  them" invites self-escalation (`narrative.ts:308` — narrow to
  player-initiated contact); collapse the 5-line all-default exposure block to
  one line; split the ~90-word CHAT_RULES rule 2; chat-summary rule 5
  addresses "you" in a third-person summary (`chat-summary.ts:23`);
  `STYLE_SUFFIX` hard-codes "beauty portrait, flattering" for every character
  (`images/prompts.ts:52` — drop "beauty" or gate a neutral variant); chat
  pulse classifier is the only agent prompt with no worked example
  (`chat-state.ts` prompt / `prompts/chat-state.ts:23`); volatile disposition
  overlays sit mid-prompt in the chat lane breaking the cacheable prefix on
  band changes (`character-chat.ts:366` — low urgency).

## D. Chat-lane consolidation (batch 3)

The chat lane grew feature-by-feature into a parallel mini-pipeline without
the consolidation pass the session pipeline got:

- **D1 — Orchestration lives in the route, not the engine** (M–L, the
  highest-leverage structural fix). The 360-line chat POST owns summary load,
  verbatim window, fold trigger, persona resolution, drift, RAG recall, prompt
  build, opening-beat branching, finalizer wiring — the session lane's routes
  delegate to `submitTurn`. Extract `submitChatMessage(...)` into the engine
  (a `chat-pipeline.ts` beside `character-chat.ts`); it's also the natural
  home for A6's concurrency guard.
- **D2 — Forked session-lane machinery** (each S–M): the §6 reaction sequence
  exists twice (`chat-state.ts:309` `applyChatPulse` vs
  `merge/phases/reactions.ts:28` — already drifted: no touch-welcomeness
  fallback, no reaction beat; extract one pure `evaluateActReaction` in
  `contracts/personality`); the timeout-race-abort helper twice
  (`intake.ts:69` vs `chat-generate.ts:12` — belongs in `server/ai` beside
  `generateChecked`); the drain-despite-disconnect SSE wrapper twice
  (`chat/route.ts:312` vs `sessions/_shared/sse.ts:42`).
- **D3 — No system doc.** Chat is a "primary feature" (~2,300 engine lines, 4
  job types, its own memory scope + state machine + RAG) absent from
  `docs/README.md`/`turn-engine.md`, and engine file headers cite plan docs
  now archived into `finished/`. Write `docs/character-chat.md` (lifecycle
  mirroring turn-engine.md); repoint the headers.
- **D4 — Job hygiene** (M): the chat scene route reuses type `scene_image` on
  the no-heartbeat `startJob` path while the engine registers a `scene_image`
  handler on the heartbeat/poison-cap runner — a process death pins the
  api-side row `running` forever (`avatar-seed.ts:14` documents the gap).
  Distinct `chat_scene_image` type and/or a global detached-row sweep in
  `startRecoverySweep`.

## E. Dedup & cleanup sweep (batch 4)

**Contracts:**

- **E-K1 — Condition vocabulary scattered across four files**
  (`conditions/catalog.ts`, `perception/darkness.ts`, `mood/events.ts`,
  `mood/projection.ts`) — adding one condition is a four-file edit, violating
  the one-registry-file invariant. Fold `senseEffects`, `moodBaselineShift`,
  and an emotion-tint tag into `CONDITION_CATALOG` rows; consumers read
  fields. (Fixes A1 structurally; A1's keying fix comes first in batch 1.)
- **E-K2 — Concept sets duplicated outside the concept registry:**
  `SURPRISE_CONCEPTS`/`FLIRT_CONCEPTS` verbatim in `mood/projection.ts:87` and
  `avatar/derive.ts:53`; `TOUCH_CONCEPTS` hardcodes a concept id
  (`mood/events.ts:39`); `avatar/derive.ts:48` `BEAT_MIN_MAGNITUDE` mirrors
  mood's constant by hand. Add flags to `interactionConcepts` (precedent:
  `polarity`, `intimate`) or export shared sets.
- **E-K3 — Inert `modulates` metadata on traits** (`traits/types.ts:16`) —
  declared as the coupling hook, never read; `modulation.ts` hardcodes trait
  ids instead. Wire it or delete it.
- **E-K4 — Dead code:** `species/targets.ts` (164 lines + test, zero callers —
  delete per project rule, update `docs/contracts/body.md`); `MoodEvent` union
  (`mood/events.ts:21`, zero consumers); `conceptIdsInFamily`,
  `dispositionTagIds`, `TraitRegistry.resolveLexicon` (undocumented dead
  helpers); engine constants `CHAT_PULSE_EVERY_N`, `FUZZY_RESOLVE_MIN` (the
  live threshold is `server/memory`'s `FUZZY_MIN_SCORE`).
- **E-K5 — Structure:** split the ~160-line fuzzy inference out of
  `species/registry.ts` (273 lines) into `species/infer.ts`; alias
  `AttributeParseResult` to the generic `RegistryParseResult` it duplicates
  (`attributes/registry.ts:6`); move stage-rank helpers from
  `mood/affinity.ts` to `relationships/stages.ts`; small repeated
  trait-reader closures in `modulation.ts`.

**Server/API:**

- **E-S1 — `findOwned(kind, id, userId)` helper** to collapse ~10 hand-rolled
  ownership lookups (`findCharacter`, `ownsItem`, `ownsLocation`, `findCard`,
  `loadOwnedCharacter`, + inline copies across avatar/portraits/chat-scene
  routes); sessions' `_shared/access.ts` is the good precedent.
- **E-S2 — `venice.ts` triplicates its fetch/parse block** (:70/:129/:182)
  with an `as`-cast at exactly the external-API trust boundary — one
  `postVeniceImage` helper + zod parse.
- **E-S3 — Item/location image routes are copy-paste twins** (batch +
  per-entity) — a shared handler factory halves four files (and would have
  applied A4's fix once).
- **E-S4 — Misc:** `promoteVariant` errors string-matched to pick 404-vs-409
  (`portraits/[imageId]/promote/route.ts:20` — return a structured code); a
  `readOptionalBody` helper to kill the only two inline `JSON.parse` sites
  (`worlds/[id]/duplicate`, `worlds/[id]/sessions`); JSONB `as`-casts in
  `images/entity.ts:99/:119` → `parseOrNull`; defense-in-depth owner-scoping
  applied unevenly across session writes (pick a policy); `isUniqueViolation`
  has no production caller; rate-limit buckets never evict idle keys.

**UI:**

- **E-U1 — `useEntityEditor` hook** — the ~100-line editor-page scaffold
  (async load + draft seed + dirty generation + save/toast + delete dialog +
  skeletons) is quadruplicated across character/item/location/social-card
  editor pages (jscpd corroborates). The single best-leverage client refactor.
- **E-U2 — `usePollWhile` hook** — the poll-while-pending loop
  (interval + latest-ref + cleanup + ad-hoc caps) is hand-rolled six times
  (portrait-studio, entity-image-studio, chat SceneStrip, entity-library,
  world-detail, scene-tab).
- **E-U3 — Shared primitives:** one `ModelSelect` (world-tab's
  `NarratorSelect`/`AgentSelect` are 95% twins + the chat-tab dropdown); a
  `ChipToggle`/`CollapsibleSection` (attribute-picker repeats both 3–4×); one
  `Segmented` control with arrow-key roving focus (entity-library, composer,
  item-editor — the ARIA roles currently promise keyboard semantics they
  don't deliver); a `SectionTitle` (41 repeats of the same class stack, two
  private variants); `presentNpcs()` exported from `cast-relationship.ts`
  (co-location rule triplicated in composer/scene-tab/session-avatar).
- **E-U4 — Client data layer consolidation:** `use-session.ts`
  `editMessage`/`deleteMessage` hand-roll fetch while `api.ts`'s
  `apiPatch`/`apiDelete` sit unused; `arrayOf` defined 3× (+ the
  `.nullish().catch(null)` idiom ~8× in inspector-tab) → small
  `lib/client/schema-helpers.ts`; character-chat's hand-rolled seed-once
  should use `draft-seed.ts`.
- **E-U5 — Oversized files with clean seams:** `world-editor.tsx` (1216
  lines, five tabs → `worlds/editor/*-tab.tsx`); `character-chat.tsx` (839
  lines, seven components → extract `chat-scene-strip.tsx`,
  `chat-message.tsx`). Style nits: auth form `&&`-rendering + all errors
  under the Password field; inspector's default-selected turn never
  auto-loads; `MOBILE_QUERY` dead export.

**Engine (non-chat):**

- **E-E1 — `scene.ts` is ~1,500 lines / ~15 builder concerns** — the next
  `merge.ts`; same decomposition medicine (`scene/` folder) when appetite
  allows (L, not urgent — all builders pure and tested).
- **E-E2 — `errorText` exists as ~14 private copies** (two new, one named
  `errText`) — one-liner for `src/lib`, fix opportunistically.
- **E-E3 — "items in scope" computed three ways** (`pipeline.ts:510`,
  `merge/grounding.ts:100`, `prompts/agents.ts:296`) — export one helper from
  `grounding.ts`.
- **E-E4 — Stale comments:** `chat/route.ts:41` "No session, pipeline, or
  RAG" (it does RAG now); two references to the deleted `engine/merge.ts`;
  `pipeline.ts:944/:959` parse the same `intentBrief` twice (hoist one
  `parseOr`).

**Docs:**

- **E-D1 — `docs/developer-notes/CLAUDE.md` documents `gpt-review/` and
  `user-guidance/` folders that don't exist in vesper** (reverie-local,
  gitignored there) — prune so agents stop being told to read phantom folders.
- **E-D2 —** [unconsumed-character-prose.md](unconsumed-character-prose.md) and
  [ideas-feedback.md](ideas-feedback.md) partially predate shipped work
  (personality sliders now reach prompts; audit C1 closed at `scene.ts:752`) —
  annotate or trim when C1's fix ships.

## F. What checked out clean

- **Boundaries:** `@openrouter` confined to `server/ai`; no deep server
  imports; components never touch `server/*`; contracts/lib purity holds (no
  IO/env/Date.now anywhere in `src/contracts`).
- **Resilience:** no raw `JSON.parse` in engine scope; every LLM/JSONB
  boundary through `parseOr`/`generateChecked` with degraded defaults +
  diagnostic codes asserted in tests (A5 is the one leaf-`.catch` gap).
- **Auth:** every route through `withUser`/`withRoute`; dev routes 404 in
  production; ownership checks on every write reviewed; error envelope +
  status conventions uniform across eras.
- **DB:** hot paths indexed (chat owner/character, memory scopes, HNSW); no
  N+1s on request paths; migrations linear with the pgvector baseline intact.
- **Process:** roadmap/plan/spec discipline was followed throughout the Opus
  era; A/B experiments were properly closed out (the `focus` planner is kept
  by the recorded 2026-06-29 ruling — not vestigial).
- **Registry refactor** (`buildRegistryCore` + provenance) genuinely improved
  on reverie; the 22-file personality / 19-file species decompositions mirror
  the attributes convention and are **not** over-fragmented.
