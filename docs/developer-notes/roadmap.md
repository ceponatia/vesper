# Roadmap

The single ordered index of development plans. **Order here is the only place
priority lives** — reprioritizing is a one-line move, never a file rename (see
`CLAUDE.md` → working-docs convention, and [deferred.plan.md](deferred.plan.md)
§"Plan docs: drop hard phase numbers").

Status legend: **draft** (not settled) · **next** (queued) · **active** (in
progress) · **shipped — <date>** · **parked**.

> Order is priority, top-down. Each entry links its plan; the plan links its
> spec/detail.

## Active (building now)

Nothing mid-build right now — the **Mood** arc just finished in full (the projection +
`EmotionLabel`, welcome/unwelcome touch, condition + scene-atmosphere baseline shifts,
and the mood chip on the cast card + chat strip; see **Shipped**), and its docs are
archived to `finished/`. Its two leftover ideas live in **other** plans — the
relationship/meter timeline ([deferred.plan.md](deferred.plan.md) #4) and the avatar's
consumption of the projection (the **Mood-reactive avatars** plan below). **Social-reaction
cards** then shipped its core engine + inline authoring (2026-06-25; see Shipped), leaving
only its library-reuse UI slice in **Next**.

## Next (queued)

- **Social-reaction cards (library-reuse UI)** — plan
  [social-reaction-cards.plan.md](social-reaction-cards.plan.md) (shipped core; one slice
  remains). The card engine + inline authoring shipped 2026-06-25 (see Shipped). The
  deferred slice: the **`social_cards` library** reuse surface — CRUD API, standalone
  library page, cross-world import picker, per-character attach-from-library, and clone
  (the table exists; inline authoring + forge proposals already deliver the core value).
- **Mood-reactive avatars** (draft feasibility) —
  [avatar-3d.plan.md](avatar-3d.plan.md) · notes
  [avatar-3d.notes.md](avatar-3d.notes.md) · spec [avatar-3d.spec.md](avatar-3d.spec.md).
  Silent **anime, 2D-first** character avatar that emotes in real time off the
  character's mood ("Grok companions, but more sophisticated"). Verdict: **feasible** —
  the "rich reaction" engine **already shipped** (`personality-and-state`: `mood` meter,
  `deriveMoodDescriptor`, likes/dislikes curve), so the avatar mostly _renders_ existing
  state, and runtime animation is **procedural + token-free** (one-time per-character
  asset gen; the turn only _selects_ a cue — no per-turn image/video gen). v1 = layered
  sprites + `motion` behind a renderer-neutral `AvatarDirector`/`AvatarCue` contract (Rive
  rig + R3F/VRM as later upgrade lanes). **Last of the "bring characters to life" arc** —
  consumes **Mood**'s labeled-emotion projection and lands first on the **character-chat**
  surface, so it sequences after both. Lead open Q: sprite exact-identity-but-less-fluid
  vs a Rive reusable rig (artist + identity cap) for the unbounded user-created cast.
  Voice deferred. Exploratory.
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

- **Prod branch + promotion workflow** —
  [deployment.md](../deployment.md) §"Branch model & promotion", 2026-06-26. Long-lived
  protected `prod` branch on the existing `origin` remote (dev stays `main`). New CI
  (`.github/workflows/ci.yml`) runs `pnpm verify` on PRs/pushes to both branches; `prod`
  protection requires the `verify` check + a PR (force-push/delete blocked, enforced for
  admins). A `workflow_dispatch` "Promote dev → prod" button
  (`.github/workflows/promote.yml`) opens the `main → prod` PR. Prod **deploy** is
  intentionally not wired yet (needs a prod Fly app + Neon prod DB + `FLY_API_TOKEN`).
- **Social-reaction cards — engine + inline authoring** —
  [social-reaction-cards.plan.md](social-reaction-cards.plan.md), 2026-06-25. Importable
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
  UI entry point.
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
