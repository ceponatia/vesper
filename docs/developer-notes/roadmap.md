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

Nothing mid-build right now — the auth + world-instances batch just shipped (see
**Shipped** below), which also closed security cluster A + the auth migration.
Next up is the rest of **Security hardening** (cluster B is a reachable-now OOM).

## Next (queued)

- **Security hardening** — [security-hardening.plan.md](security-hardening.plan.md).
  Remediation of the 2026-06-23 full-surface security scan. **Cluster A (gate
  `/api/dev/*`) and the auth migration already shipped** with the auth batch; what
  remains is the rest of the file-disjoint clusters, which run fully concurrently: B
  sharp decode limits (an **already-triggerable OOM** — the reachable-now item), C
  rate-limit the unthrottled paid-model/heavy-write routes, D security headers +
  narrow dev-origins, E request-body caps, F prompt-injection delimiting, G
  LLM-output array bounds, H Postgres bind/creds, I defense-in-depth lows. IDOR sweep
  / SQLi / SSRF / XSS / committed-secrets all came back **clean**; aside from B the
  remaining findings are latent-until-deploy.
- **Character chat — light state & embodied player** (draft brainstorm) —
  [character-chat-state.plan.md](character-chat-state.plan.md). Grow the sessionless
  1-on-1 chat from a stateless transcript into a light, state-aware quick chat that
  reuses the contracts (meters incl. **hygiene**, affinity, conditions) without the
  session engine, plus the **placeholder intake** for a future profile-level _player
  character_ the chat (and sessions) default to. Its reaction pulse reuses the shipped
  personality §6 likes/dislikes curve — chat is the cheapest testbed for that loop.
  Also delivers the embodied-player immersion fix (UX-audit P1). Menu of ideas; pick a
  v1 before promoting.
- **Mood — app-wide emotional state** (draft) — [mood.plan.md](mood.plan.md).
  Graduates the **event→mood table** deferred by the shipped `personality-and-state`
  (spec §4): generalizes mood movement beyond the lone social-reaction nudge (scene
  atmosphere, conditions, beats, presence) + a **labeled-emotion projection** so
  consumers get a discrete emotion, not just a `0–1` valence. Mood is a cross-app
  read (narrator, scene images, **avatar animations**, UI mood chip, chat) — built
  separately because it serves more than the avatar, and it unblocks the avatar's
  emotion read. Pairs with the deferred relationship/meter timeline.
- **Social-reaction cards** — plan
  [social-reaction-cards.plan.md](social-reaction-cards.plan.md) (draft). Importable
  **taboo / social-rule cards** (library content, reusable across worlds like items) that
  resolve deterministically with per-character **tag overrides**, feeding the personality
  §6 reaction seam and the witnessed-breach reactions. Replaces today's freeform
  `world.style.norms`. **Ready to build** — its only dependency, the personality §6
  `resolveSocialReaction(act, {…, cards})` resolution seam (which ships with `cards: []`),
  shipped 2026-06-18; this fills that argument. Can run in parallel with the mood slice.
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
