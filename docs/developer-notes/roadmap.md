# Roadmap

The single ordered index of development plans. **Order here is the only place
priority lives** — reprioritizing is a one-line move, never a file rename (see
`CLAUDE.md` → working-docs convention, and [deferred.plan.md](deferred.plan.md)
§"Plan docs: drop hard phase numbers").

Status legend: **draft** (not settled) · **next** (queued) · **active** (in
progress) · **shipped — <date>** · **parked**.

> Order is priority, top-down. Each entry links its plan; the plan links its
> spec/detail.

## To be Planned

This section is for the product owner to add ideas for features and improvements. AI agents
must _not_ add anything to this section. AI agents _may_ remove items from this section once
they have incorporated them into the roadmap below and either created a new plan or updated
an existing plan that will include this work.

_(Currently empty — the two character-chat ideas that were here graduated to plans on
2026-06-30; see the top of **Next** below.)_

## Active (building now)

Nothing mid-flight. The last item — **Character chat — state as a narration system** —
shipped (see **Shipped**). Next build is the top of **Next** below — the character-chat
primary-feature arc (gated on its memory-keying decision) — or the decision-gated avatar
upgrade lanes (Rive reusable rig, then R3F/VRM 3D) — author's call.

## Next (queued)

- **Character chat as a primary feature** —
  [character-chat-primary.plan.md](character-chat-primary.plan.md) (draft). The big arc: make
  chat function like the session lane for a *single* character with no location entities (location
  via narration only) — **RAG long-term memory** (facts + episodes) atop the existing window +
  rolling summary, **mutable-attribute + fuller state tracking**, and an **expanded dev debug
  modal**. Load-bearing open question: key chat memory by minting a synthetic session row vs.
  widening `facts`/`episodes` to `(ownerId, characterId)`.
- **Intimacy notes** — [intimacy-notes.plan.md](intimacy-notes.plan.md) · spec
  [intimacy-notes.spec.md](intimacy-notes.spec.md) (draft). Third species/heritage
  note (`intimacy`) + per-character disposition, surfaced to the narrator only at
  the intimate exposure tier. Standalone — builds on the shipped species note split +
  the phase-4 exposure mask; feeds mood's intimacy-beat inputs but doesn't gate them.
- **Visual world map** — [world-map.plan.md](world-map.plan.md). Slice 1 (read-only
  force-directed graph) shipped 2026-06-18; slices 2–3 (editable layout, play-screen
  minimap) remain — optional polish on a feature already delivering its core value.
- **World simulation ("the world moves")** — the former "phase 5" cluster, not yet
  started; specs drafted: [movement-authority.spec.md](movement-authority.spec.md),
  [scheduled-arrivals.spec.md](scheduled-arrivals.spec.md),
  [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md). A major future pillar —
  needs a `world-simulation.plan.md` when it becomes active.
- **RAG improvements** — [RAG-improvements.plan.md](RAG-improvements.plan.md)
  (draft; seven retrieval ideas under evaluation — the least-settled item here).

## Someday / parking lot

Unpromoted ideas live in [deferred.plan.md](deferred.plan.md): the relationship &
meter timeline (UX-audit #4), the full **NPC-puppeting** system
([npc-puppeting.deferred.md](npc-puppeting.deferred.md) — only Slice 2's deflection
directive shipped), comms expansions, item acquisition during play, the remaining
UX-audit deferrals (transcript export #8, scene-image pin #9, first-run tour #10,
production-build perf pass §5), observer / god-mode POV, monorepo split (permanently
deferred), and companion-role-as-romance-eligibility (park, don't build).

## Shipped (historical record — newest first; see each plan for detail)

- **Character chat — state as a narration system** —
  [character-chat-state-narration.plan.md](character-chat-state-narration.plan.md) · spec
  [character-chat-state-narration.spec.md](character-chat-state-narration.spec.md), 2026-06-30.
  The chat narrator now **enacts** the tracked `character_chat_state` instead of listing it:
  condition→attribute overlays (a designed-but-unbuilt seam, guarded so a condition can't rewrite
  an inherent attribute), graded meter cues with a **band-change anti-repetition gate** (new
  `surfaced_cues` column, migration `0017`) so a state is marked once when it *shifts* then rides as
  coloring, render-time **disinhibition** (intoxication lowers inhibition/guardedness/composure),
  soft social-card framing (theme not severity), a regex-first **one-turn intent cue**
  (`engine/chat-intent.ts`), a **state-aware chat scene image** (`visualStateNote` + overlays), and a
  "State → narration" debug readout. Owner decisions D1–D7 recorded in the spec; `pnpm verify` green
  (1620 tests). Graduated the deferred state-aware chat scene image.
- **Character-chat model persists per character** — docs [ui.md](../ui.md) (chat tab),
  2026-06-30. The Chat tab's narrator dropdown now saves the pick to a new
  `characters.chatModel` scalar on change (mirrors `worlds.narrativeModel`; migration
  `drizzle/0016`) — value hoisted to `character-edit-page.tsx` so it survives the tab
  unmounting, resolved through `resolveChatModelId` (unknown/empty ⇒ chat default), and
  kept off both the resettable `character_chat_state` row and the editor's profile draft.
- **Mood-reactive avatars — slice 3 (auto-asset gen + in-session play)** —
  [avatar-3d.plan.md](avatar-3d.plan.md) §"Slice 3 — finalized design" · spec
  [avatar-3d.spec.md](avatar-3d.spec.md), 2026-06-30. Automated the per-character **expression
  frame set** (all 11 `EmotionLabel`s, seeded at avatar-ready via a new `avatar_seed` engine
  job + lazy-gen on demand through `POST …/avatar/expressions`, identity-locked Venice edits,
  cached forever) so the **whole unbounded cast** is expressive — `server/images/avatar-expressions.ts`
  (Venice concurrency semaphore + negative-cache that retries transient failures but tombstones
  content rejections; **Model-B** delete-on-face-change instead of a clone-breaking
  `sourceImageId` filter). Plus a **live standing companion avatar in session play** (Scene tab):
  per-participant `avatarCue` on the status payload, a **stable** focal (companion→tier→id), and a
  one-shot **reaction beat** sourced from the merge — `planReactionAffinity` now emits a
  `ReactionBeat` on both the carded branch **and** the un-carded **touch** branch (the romance
  beats), threaded additively to `agentResults.reaction` and fired once via a mount-baseline
  guard. Two adversarial workflows (design + impl review) gated it; no migration. **Deferred:**
  pose frames, touch reactions in the narrator line, a global detached-job recovery sweep. Decision-gated
  upgrade lanes remain (Rive rig, then R3F/VRM 3D; voice deferred).
- **Character chat — opportunistic sensory cues** —
  [character-chat-sensory.plan.md](character-chat-sensory.plan.md), 2026-06-29. Prompt-only: a
  closeness-gated **"Sensory cues"** block surfaces `presentation.scent_baseline` (via `sensoryCues`
  in `prompts/character-chat.ts`) _only when the beat earns it_ — promoted out of the flat Attributes
  list, exposure-mask hint dropped, plus a `CHAT_RULES` rule (one cue on closeness/notice/intimacy,
  never forced or listed). Voice stays an always-on Attributes line; intimate scent/taste gated out
  (`isIntimateAttributeCategory`). Tests + a `chat-sensory-closeness` eval fixture + an opt-in
  `sensoryRelevant` deterministic metric. Escalation (one-turn chat "beat cue" wrapper) deferred.
- **Narrator prompt focus — Phase-3 focus A/B (planner does not earn its keep)** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) · eval
  [narrator-prompt-focus.eval-results.md](finished/narrator-prompt-focus.eval-results.md) §Run 3, 2026-06-29. Ran the
  gated `--axis focus` A/B (fresh focus-on vs `--no-focus` pair, pairwise re-judge by
  `gemini-3.1-pro-preview`): the intake `focus` planner is a **53/47 wash** vs the free Phase-2 derivation
  (50/50 on byte-identical controls; it _lost_ `onBeat`/`noUnrequestedLogistics` and risked over-reaction on
  GLM). Ruling: **don't build the deferred character-chat focus analogue**; keep but don't grow the
  zero-cost session planner. (Live OpenRouter spend — 36 generations + 17 judge calls.)
- **Narrator prompt focus — eval rulings (profile + reasoning)** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) · eval
  [narrator-prompt-focus.eval-results.md](finished/narrator-prompt-focus.eval-results.md), 2026-06-29. Turned eval
  Run 2 into code: the shape profile is now a **per-lane resting default** (`NARRATION_LANE_DEFAULTS` —
  session `concise_immersive`, chat `aggressive_concise`), resolving the global-vs-per-lane tension the
  per-model split exposed (the dev toggle still force-overrides both lanes); and `narrativeProviderOptions`
  gained a **per-model reasoning knob** (`NARRATOR_REASONING` — Aion 2.0 `effort:low`, GLM 5.2 `effort:low`,
  Owl Alpha `enabled:false`), applied to both lanes. Decision 1 re-ruled from "global-only"; tests + dev
  toggle ("Default (per-lane)" state) updated. No-spend (rulings already had the data).
- **Personality enactment — sliders & age drive dialogue/action** —
  [personality-enactment.plan.md](personality-enactment.plan.md), 2026-06-28. Made the authored
  trait **sliders** (and the new real age) actually steer how characters talk and act: character-chat
  now **surfaces the sliders at all** (it never did) as a binding Disposition block; the session
  disposition block + a new Prose rule shift from "stay consistent" to **enact**; the **director**
  agent gets present-character disposition so its next-turn steer fits temperament. Shared
  `dispositionBands` renderer; age/life-stage characterization rule (the `character-age-field` follow-up).
- **Character real age vs apparent age** —
  [character-age-field.plan.md](character-age-field.plan.md), 2026-06-28. New free-text
  `profile.age` (basic info) split from the visual `identity.apparent_age` attribute: the
  **narrator** reads real age (`formatAge` — canonical facts + character-chat identity), the
  **portrait studio** keeps apparent age, and **scene image generators drop it**
  (`characterAppearanceSummary` skips it) so renders lean on the avatar reference. Wired through
  editor, forge, fixtures + seed.
- **Narrator prompt focus & proportionate reaction — behavioral eval harness** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-28. `pnpm eval:narration`
  (`scripts/eval/narration/`) — assembles **real** prompts (the shipped builders) for six golden
  scenarios, sweeps (scenario × model × shape profile × reasoning), streams via OpenRouter, and reports
  deterministic metrics (paragraphs / segments / distinct speakers / tokens / TTFT / latency / provider)
  - an LLM-judge rubric. `--no-focus` is a Phase-2-vs-Phase-3 A/B; `--dry-run` inspects prompts with no
    spend; conservative defaults. Never in `pnpm verify` / CI. Automates the interim eval + probes P1–P3.
- **Narrator prompt focus & proportionate reaction — Phase 3** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. The structured
  narration-focus planner, built in the **preferred intake-schema-extension form** (no new LLM
  leg): an optional `focus` sub-object on `IntentBrief` (`primaryResponse` / `reactionScale` /
  `allowedNewTopic` / `suggestedShape`) the intake agent emits, consumed by `buildResponseShape` to
  enrich the "## Response shape" steers — finer beat verb, explicit new-topic license, an optional
  `Shape:` line. `.optional()` (absent ⇒ deterministic Phase-2 derivation); the **authored reaction
  band always overrides** the planner's `reactionScale`. Built ahead of the interim-eval gate on
  direct instruction.
- **Narrator prompt focus & proportionate reaction — Phase 2** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. Added the
  deterministic, restatement-only **"Response shape"** line to the turn context (right after the
  digest): per-turn **current-beat** (stay on the input; new topic only via a Direction/thread),
  **reaction-scale** (absence of a strong band → "ordinary, don't escalate"; weak → "small";
  strong → defer to `## Reaction`), and **speaker-focus** (only addressed-and-present NPCs answer)
  steers. Pure `buildResponseShape` (no new LLM call); the primary-reaction verdict is evaluated
  **once** (`evaluatePrimaryReaction`) and shared with the `## Reaction` line so they can't
  disagree. Built ahead of the interim-eval gate on direct instruction.
- **Narrator prompt focus & proportionate reaction — Phase 1** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. Killed the
  `3–5 paragraphs` floor for hot-swappable narration **shape profiles** (`concise_immersive`
  default + `aggressive_concise`, a global dev A/B knob with a dev-only `POST /api/dev/narration-shape`
  toggle in the Inspector); added response-first + proportionate-reaction + multi-party-restraint
  rules to the session rulebook and `CHAT_RULES` (both lanes), leaning on the existing `## Reaction`
  band; self-motivated NPC initiative kept for living-world texture; authored Style directives
  override. Phases 2–3 + eval remain in Next.
- **Mood-reactive avatars — slices 1–2 (cue contract + chat PoC)** —
  [avatar-3d.plan.md](avatar-3d.plan.md) · spec [avatar-3d.spec.md](avatar-3d.spec.md), 2026-06-27.
  The renderer-neutral `contracts/avatar/` cue contract + pure `deriveAvatarCue` (read over the shipped
  Mood projection + social-reaction beat + posture + atmosphere, serialized onto the chat snapshot), and
  a CSS-keyframe `SpriteAvatarRenderer` + standing companion panel mounted in character-chat —
  breathing/drift/crossfade + one-shot reaction beats over the existing portrait, with ~5 hand-seeded
  Lysandra expression frames (`scripts/seed-avatar-expressions.ts`). Implementation deviated from the
  spec (no Zustand/XState/`motion` dep yet; manifest = `portrait_variant` rows tagged
  `meta.avatarExpression`; blink deferred) — recorded in the plan. **Slice 3** (auto-asset gen for the
  unbounded cast) stays in Next.
- **Merge reducer decomposition — all 5 slices** —
  [merge-decomposition.plan.md](finished/merge-decomposition.plan.md) · spec
  [merge-decomposition.spec.md](finished/merge-decomposition.spec.md), 2026-06-27. The 2655-line
  `engine/merge.ts` is fully decomposed: a `merge/` folder behind the `WorkingState` ADT
  (dirty-tracking owned internally, `no-restricted-syntax` gate), the pure resolution toolkit
  in `grounding.ts`, one `phases/*.ts` file per phase, the orchestrator (`PhaseContext` + an
  ordered `PHASES` list) in `plan.ts`, the lone DB-write transaction in `apply.ts`, and a
  narrowed public barrel. Behavior-preserving (MergePlan + every DB write byte-identical;
  189 pure + 13 integration tests green).
- **Character chat — scenario setup modal** —
  [character-chat-scenario.plan.md](finished/character-chat-scenario.plan.md), 2026-06-27. The chat tab's
  Starting Relationship + Scenario controls fold into one **Scenario setup** modal (sibling of State
  tools), grown into a no-session test harness: a per-chat **active social-card** set (seeded from the
  character's own cards, then authoritative — the pulse resolves against it) so taboos/rules are
  testable without a world/session, plus a free-text **starting outfit** + an **exposed** toggle that
  drive chat scene images — **detaching the structured clothing** the chat can't equip (`defaultOutfit`
  stays for avatar/portrait/sessions). Three new `character_chat_state` columns (`outfit`,
  `outfit_exposed`, `active_social_cards`; migration 0015). Also added the `foot_contact` interaction
  concept earlier the same arc so the foot-fetish card triggers precisely.
- **Social-reaction cards — library-reuse UI** —
  [social-reaction-cards.plan.md](finished/social-reaction-cards.plan.md) §"Deferred slice", 2026-06-26.
  The `social_cards` library finally gets its surface: `social_card` wired into the shared
  library machinery (`ShareableKind`/`LibraryKind`, clone, owner-or-public reads, semantic
  search), full CRUD at `/api/social-cards` (+ `/clone`), a `/social-cards` page + standalone
  **card builder** (with a live reaction preview, reusing the shared `SocialCardFields`),
  **Import from / Save to library** on the inline editor (snapshot-copy both ways via
  `cardFromLibraryParts`), and the **public discovery gallery** — the deferred `searchLibraryIds`
  `scope` query, debuted on cards (the auth.plan.md "public browse gallery + clone UI entry point"
  deferral graduates here; other shareable kinds pass `scope` through but their list API still
  ignores it — the fast-follow). Int-tested (scope/clone/visibility) + pure snapshot test.
- **Prod branch + promotion workflow** —
  [deployment.md](../deployment.md) §"Branch model & promotion", 2026-06-26. Long-lived
  protected `prod` branch on the existing `origin` remote (dev stays `main`). New CI
  (`.github/workflows/ci.yml`) runs `pnpm verify` on PRs/pushes to both branches; `prod`
  protection requires the `verify` check + a PR (force-push/delete blocked, enforced for
  admins). A `workflow_dispatch` "Promote dev → prod" button
  (`.github/workflows/promote.yml`) opens the `main → prod` PR. Prod **deploy** is
  intentionally not wired yet (needs a prod Fly app + Neon prod DB + `FLY_API_TOKEN`).
- **Social-reaction cards — engine + inline authoring** —
  [social-reaction-cards.plan.md](finished/social-reaction-cards.plan.md), 2026-06-25. Importable
  **taboo / social-rule cards** (`contracts/personality/cards.ts`) that resolve a classified
  social act to a `SocialReaction` riding the §6 curve — one `severity` → tier → ramped
  intensity, with per-tag override flips (the foot-fetish enjoy). Wired into all three
  reaction call sites (session merge, pre-narration line, world-less chat); **world cards**
  live inline on `worldStyle.socialCards`, **character cards** on `CharacterProfile.socialCards`
  (both snapshot arrays riding the live-read cascade — no join/instance tables). The
  continuity agent's freeform `normBreaches` was re-pointed to `cardBreaches`, with
  `planCardBreachReactions` folding **per-witness affinity** through the curve + directives —
  the freeform `world.style.norms` surface is fully removed. Forge proposes a starter card
  set; the world editor + character Disposition tab author cards inline. Deferred: the
  `social_cards` **library-reuse UI** (CRUD/page/import-picker/clone — table shipped, still
  in Next).
- **Scene atmosphere — scene-tone producer** —
  [scene-atmosphere.plan.md](scene-atmosphere.plan.md) · spec
  [scene-atmosphere.spec.md](scene-atmosphere.spec.md), 2026-06-24. Built the producer the mood
  core slice was missing: the **director** emits an optional `atmosphere` enum (one field, no
  new leg); `resolveAtmosphere` carries it onto the brief (sticky — director tone, else the
  prior, with an intimate-frame floor to `romantic`); the drift loop feeds it to the already-
  built `atmosphereMoodBaselineShift` for NPCs co-located with the player (a tense room settles
  a present character lower, composure-damped). Unblocks mood's last v1 input; later serves the
  avatar's `environment.atmosphere`. Deferred: authored location tone, status surfacing, a
  danger→`tense` floor.
- **Mood — app-wide emotional state** (complete) —
  [mood.plan.md](finished/mood.plan.md) · spec [mood.spec.md](finished/mood.spec.md),
  2026-06-24. A new `src/contracts/mood/` module: the locked **11-label `EmotionLabel`**,
  the pure/total **`deriveEmotionLabel`** projection (a derived activation axis × valence +
  affinity + conditions, with a transient reaction beat), and the **event→mood table** split
  into impulse (one-time) vs standing (baseline-shift) modes. **Welcome/unwelcome touch**
  (affinity-stage gated + preference override), the **condition→mood baseline shift**, and the
  **scene-atmosphere baseline shift** (its producer is the sibling Shipped entry above) are
  wired into the engine merge; a shared **`MoodChip`** surfaces the label on both the cast card
  and the character-chat strip. Mood's own scope is done; the two leftover ideas live in other
  plans — the relationship/meter timeline ([deferred.plan.md](deferred.plan.md) #4) and the
  avatar's projection consumption (Mood-reactive avatars, in Next).
- **Character chat — light state** —
  [character-chat-state.plan.md](finished/character-chat-state.plan.md) · spec
  [character-chat-state.spec.md](finished/character-chat-state.spec.md), 2026-06-24. The
  sessionless 1-on-1 chat is now state-aware: a `character_chat_state` row (full meter
  set, affinity, conditions, mindNote, premise, chat clock), a free time-drift spine
  (within-visit decay + between-visit recovery toward rested, **no affinity decay**),
  affinity seeded from a new authored `playerRelationship` profile field, a per-chat
  **premise** (chat-only scenario), and a cheap reaction pulse that reuses the
  personality §6 curve to move affinity/mood + refresh the mindNote (degrades to
  drift-only). Surfaced as a prompt "Current state" + scenario block, a `GET/PATCH/POST
…/chat/state` API, a status strip + stage-change toast + premise bar, and three
  reset scopes (all/chat/state). **Slice 4** added the texture (arousal-from-intimate,
  action chips, light conditions) and test-bed affordances (a **state-tools modal**
  with the last-turn debug trace, and the **Prompt Character** opening beat). Only the
  state-aware chat scene image was deferred → [deferred.plan.md](deferred.plan.md).
- **Default player character** — [player-character.plan.md](player-character.plan.md),
  2026-06-23. A `/settings` page (reached from the nav account menu) where the user sets
  a light default player character — name + short persona on `users.playerPersona`,
  read through the single `resolvePlayerPersona` resolver and threaded into character
  chat so a character greets the player by name (closes the faceless-player UX-audit P1).
  Inline-blob storage; graduates to a real library character later via the same resolver.
- **Security hardening** — [security-hardening.plan.md](finished/security-hardening.plan.md),
  2026-06-23. Closed the full-surface scan: image-decode pixel/format/length limits
  (OOM fix), rate limits on every paid-model/heavy-write route, security headers +
  narrowed dev-origins, request-body caps, prompt-injection fencing, LLM-output array
  bounds, Postgres localhost bind + cred guard, and seven defense-in-depth lows.
  Deferred: origin/CSRF (covered by Better Auth); `script-src` nonce tightening.
- **Auth & entity visibility** — [auth.plan.md](finished/auth.plan.md) · ref
  [auth.md](../auth.md), 2026-06-23. Better Auth accounts (401 on no session, no
  auto-mint) + a private/public visibility seam with copy-on-use cloning. Also closed
  security cluster A + the auth migration. Deferred: the public browse gallery + clone
  UI entry point — **graduated 2026-06-26 for social cards** (the `searchLibraryIds` `scope`
  query + clone CTA; see the Social-reaction cards library-reuse entry above); characters /
  locations / items pass `scope` through but their list API still ignores it (fast-follow).
- **World instances — copy cascade** —
  [world-instances.plan.md](finished/world-instances.plan.md), 2026-06-23. Worlds hold
  snapshot copies of entities instead of live library FKs, so deletes never break copies.
- **Character chat — rolling background summary** —
  [character-chat-summary.plan.md](character-chat-summary.plan.md), 2026-06-21. A
  watermark-anchored running summary gives the 1-on-1 chat memory past its 40-turn window.
- **Scene images — multi-reference & providers** —
  [scene-images.plan.md](finished/scene-images.plan.md) · spec
  [scene-images.spec.md](finished/scene-images.spec.md), 2026-06-19. Provider-capability
  layer + `image_references` table; Venice/Qwen multi-edit (Flux removed).
- **Attribute mutability & change-path integrity** —
  [attribute-mutability.plan.md](attribute-mutability.plan.md) · spec
  [attribute-mutability.spec.md](attribute-mutability.spec.md), 2026-06-19. Enforced the
  `mutability` invariant at the merge boundary + a shared value-vocabulary module.
- **Personality & evolving state** —
  [personality-and-state.plan.md](finished/personality-and-state.plan.md) · spec
  [personality-and-state.spec.md](finished/personality-and-state.spec.md), 2026-06-18.
  All five slices: the authored **likes/dislikes loop** (intake concept-tags a player's
  act; a deterministic affinity-aware curve decides the reaction), the puppet guardrail,
  atomic personality **traits** + scaling + lexicon, the **mood** valence meter +
  mood↔affinity coupling, and affinity trait-coupling + widened stages. Left as their own
  plans: the **event→mood table** (→ Mood), the **card layer** (→ Social-reaction cards),
  and the full NPC-puppeting system (deferred).
- **UX-audit remediation** — [ux-audit.plan.md](ux-audit.plan.md), 2026-06-18. Triaged the
  end-to-end audit: world-forge intake fields, forge-canon reconciler, artwork progress,
  contrast theme, session-lock window.
- **Visual world map (Slice 1)** — [world-map.plan.md](world-map.plan.md), 2026-06-18.
  Read-only force-directed location graph (slices 2–3 still in Next).
- **Non-human species & body features** —
  [non-human-species.plan.md](finished/non-human-species.plan.md) · spec
  [non-human-species.spec.md](finished/non-human-species.spec.md), 2026-06-18. 8-species
  catalog + wings/horns/tail morphology across image-gen + editors.
- **Character chat — sessionless 1-on-1** —
  [character-chat.plan.md](finished/character-chat.plan.md), 2026-06-17. Talk to a library
  character directly (no world/session/RAG) to tune its voice; Chat tab + scene + Gallery.
- **Phase 4 — the body model** — [phase-4-plan.md](finished/phase-4-plan.md), 2026-06-14.
  Intimate anatomy, sensory, species scaffolding.
- **Phase 3 — presence & perception v1** — [phase-3-plan.md](finished/phase-3-plan.md).
- **Phase 2** — [phase-2-plan.md](finished/phase-2-plan.md).
- **Phase 1 — foundation** — [phase-1-plan.md](finished/phase-1-plan.md) (+
  [multi-character-phase-1-plan.md](finished/multi-character-phase-1-plan.md)).
