# Roadmap

The single ordered index of development plans. **Order here is the only place
priority lives** — reprioritizing is a one-line move, never a file rename (see
`CLAUDE.md` → working-docs convention).

Status legend: **draft** (not settled) · **next** (queued) · **active** (in
progress) · **awaiting acceptance** (built in full, waiting on a trial, review,
or flag enable) · **shipped — <date>** (the whole plan delivered and accepted) ·
**parked**.

> **One entry is one item: a bold title, its links, and a hook of at most a
> sentence.** Slice histories, shipped dates, owner rulings, and the argument
> behind a dependency belong in the plan and its specs — an entry names a
> blocker, never explains it. Each plan carries its own `Status:` line; this
> index does not restate it.
>
> A plan leaves this file only when the **whole** plan is done, at which point it
> moves to `finished/` and earns one line in
> [roadmap.shipped.md](roadmap.shipped.md). Shipping a slice never removes an
> entry — it may only correct a hook that has stopped being true.

## Active (building now)

- **Monorepo migration — the image engine as the first package** —
  [plan](monorepo-image-core.plan.md) · [spec index](monorepo-image-core.spec.md)
  — `@vesper/image-core` is extracted and its boundary is now mechanically
  enforced in both directions, with the package independently typechecked and
  tested; the render-kernel extraction begins once that gate is green in CI.

- **Image model capabilities — profiles, shared controls, and richer workflows** —
  [plan](image-model-capabilities.plan.md) ·
  [spec](image-model-capabilities.spec.md) — task profiles beneath each model,
  now reached by every render through the shared intent (slice 2), choosing which
  references survive by role rather than by position and routing control images
  to the inputs a model declares (slices 3 and 9), with the curated LoRA library
  built and awaiting its first style trial (slice 6); remaining are reference
  preparation and parallel uploads, reproducibility, version promotion, curated
  profiles and image sets.

- **Image identity packs — durable owner-scoped face references** —
  [plan](image-identity-packs.plan.md) · [spec](image-identity-packs.spec.md) —
  each character's canonical portrait compiled into a revisioned pack; dark
  behind `IMAGE_IDENTITY_PACK_REFERENCES` until the paid trial runs, then
  render-lane consumption, which the shared render intent has now unblocked.

- **Qwen advanced image subsystem — controlled composition experiments** —
  [plan](qwen-advanced-image-subsystem.plan.md) ·
  [spec](qwen-advanced-image-subsystem.spec.md) — an admin-only lab comparing
  control-mapped Qwen edits against ordinary output; Stages 0–6 are closed and
  accepted, and Stage 7's promotion is ruled — two-character chat scenes,
  edge-controlled portrait variants and a reviewed style LoRA graduate to the
  ordinary lanes, while depth control and identity finishing stay admin tooling
  behind plans that have not started.

- **Romantic contact affordances — foot-first grounded contact** —
  [plan](romantic-contact-affordances.plan.md) ·
  [spec index](romantic-contact-affordances.spec.md) — the affectionate tier is
  live for players and the shadow measurement window is open; next is reviewing
  the window and taking the cost ruling every later item waits on.

- **Constraint-first narrator physical guidance** —
  [plan](narrator-physical-guidance.plan.md) ·
  [spec](narrator-physical-guidance.spec.md) — scoped consistency constraints,
  false-premise fences and mandatory action outcomes, live in production; slice 4
  needs a design decision, slices 5–6 need instruments that don't exist.

## Next (queued, in dependency order)

**Unblocked today — only scheduling gates these:** data lifecycle, capabilities
slice 3, visual state, scene composition slices 1–2, the shadow-measurement
enable, resilience closures, `ConfirmDialog`, clothing slice 7, and wiring the
affordance layer to the scene owner.

- **Data lifecycle — chat-scoped deletion, retention sweeps, intentional image
  orphans** — [plan](data-lifecycle.plan.md) · [audit](data-lifecycle.audit.md) —
  chat-flow data gets a real `chat_id` FK and dies with its chat, with images the
  one deliberate survivor so the Gallery keeps them.

- **Visual state and attention** — [plan](visual-state.plan.md) ·
  [spec](visual-state.spec.md) — one lane-neutral projection over the existing
  appearance, wardrobe, body-condition and scene owners, keeping identity,
  presentation, current state and body language separate for narrator, image and
  inspector digests; its image slice is unblocked now that references carry roles.

- **Scene image composition — camera, facing, and intimate staging** —
  [plan](scene-composition.plan.md) · [spec](scene-composition.spec.md) — the
  shot follows the fiction: a character with her back to the player renders
  from behind, intimate moments stage the act from the player's vantage;
  prompt-only, with committed scene facts overriding inference where they
  exist.

- **Image render quality — per-model prompts, negative steering, and face
  fidelity** — [plan](image-render-quality.plan.md) ·
  [spec](image-render-quality.spec.md) — the content and tuning companion to the
  capabilities plan; past slice 1 it needs the control transports of capabilities
  slices 3–4, a paid tuning trial, and the face-repair model decision.

- **Body-attribute visual affordances — remainder** —
  [plan](body-attribute-affordances.plan.md) — `chat-affordances.ts` still
  doesn't read the scene owner, which is all that keeps hair adhesion and garment
  cling silent; the successor adapter waits on the successor lane.

- **Clothing state graph — remainder** — [plan](clothing-state-graph.plan.md) ·
  [audit](clothing-state-graph.audit.md) — slice 7 maps the contracts onto
  successor items and is blocked on nothing; the `CHAT_GARMENT_CUES` tuning run
  now needs owner spend and a verdict, not an instrument.

- **Codebase efficiency — correctness and measured-response tranche** —
  [disposition](codebase-efficiency.audit.md#review-disposition-and-owner-rulings--2026-07-30)
  · [resilience](resilience-closures.plan.md) ·
  [confirm dialog](editor-scaffold.plan.md) ·
  [command hot path](sim-command-shell.plan.md) ·
  [chat latency](chat-reply-latency.plan.md) — ordered: resilience closures →
  `ConfirmDialog` alone → the cheap hot-path set → chat pre-reply latency after a
  repeated baseline.

- **Chat meter economy — the body on the story clock** —
  [plan](chat-meter-economy.plan.md) · [spec](chat-meter-economy.spec.md) —
  hygiene, arousal, energy and sleep driven by the story clock instead of
  exchange counts; a chat-lane build, not an engine port.

- **Chat body needs — satiation, hydration, and needs that push** —
  [plan](chat-body-needs.plan.md) — the three asked-for meters plus the needs →
  initiative channel; depends on the meter economy landing first.

- **Successor world engine — Gate 7: optional institutions & macro simulation** —
  [gate 7](engine.gate7.institutions.md) — employers, schools, markets, law and
  weather admitted only as declared packages; unblocked, but explicitly optional
  and opens only on the owner's call.

- **Character schema improvements — facial realism + engine-shaped contracts** —
  [plan](character-schema.plan.md) — a descriptive `face.attractiveness`
  attribute replacing the portrait studio's hardcoded beauty bias, plus the
  template fields the engine can consume; owes a `character-schema.spec.md` split.

- **Spatially controlled scene images — pose, depth, and character identity** —
  [plan](spatial-scene-images.plan.md) — one validated 3D spatial frame driving
  pose/depth/segmentation controls; the Qwen lab's Stage 0 probe answered its
  gate-0 spike's central question in the affirmative, so the spike folds into
  that evidence and this plan's distinct value is producing controls from a
  validated spatial frame.

- **RAG improvements — remainder** — [plan](RAG-improvements.plan.md) — the
  presence half of the relevance floor, witness gating on a real viewpoint, and
  RAG-as-history; all three stay near-worthless until multi-character
  conversations are the normal case.

- **At-rest encryption — user chat content unreadable on Neon** —
  [plan](at-rest-encryption.plan.md) — app-side AES-256-GCM envelopes over
  transcripts, memory rows and derived sinks, with the key in Fly secrets; gated
  on owner ruling D1 (whether embeddings are encrypted too).

- **World engine refactor — the unowned catalog** —
  [plan](world-engine-refactor.plan.md) — an umbrella, never a build item; the
  **salience bus**, a **composed scene frame** and the environment core are the
  last named seams to promote out, after which it archives.

- **Codebase efficiency — later consolidation sequence** —
  [disposition](codebase-efficiency.audit.md#review-disposition-and-owner-rulings--2026-07-30)
  · [command shell](sim-command-shell.plan.md) ·
  [fork registry](sim-fork-registry.plan.md) ·
  [client safety](client-type-safety.plan.md) ·
  [library routes](library-route-registry.plan.md) ·
  [editor scaffold](editor-scaffold.plan.md) ·
  [contracts](contracts-hygiene.plan.md) ·
  [dead exports](dead-export-sweep.plan.md) ·
  [tooling](tooling-gates.plan.md) — dependency order only, **not promoted to
  next**: command shell → fork registry → client type-safety → library routes →
  an editor-scaffold go/no-go → contracts, dead-export and tooling hygiene.

- **Codebase modularity — large-file splits and shared-code consolidation** —
  [audit](codebase-modularity.audit.md) — sixteen files over 1,500 lines and
  ~5,000 lines of scaffolding duplication; **needs a plan**, and its
  correctness-flavoured findings fold into whichever plan touches each file first.

## Someday / parking lot

Unpromoted ideas live in [deferred.plan.md](deferred.plan.md) — the
successor-engine improvement backlog ([deferred/CLAUDE.md](deferred/CLAUDE.md)),
owner-gated live eval runs, the body-affordance scene-image consumer,
[NPC puppeting](npc-puppeting.deferred.md), comms expansions, in-play item
acquisition, the remaining UX-audit deferrals, observer POV, and one permanent
park (companion-role-as-romance-eligibility).

Two remainders are documented but unplanned and need a home:
[condition-attribute-effects.md](condition-attribute-effects.md) (four small
chat-state plumbing items) and
[intimate-defaulting.md](intimate-defaulting.md) (body-config provenance and
re-derivation — belongs under character schema).

## Successor world engine — foundation and rollout COMPLETE

Gates 0–6 and rollout R0–R6 shipped 2026-07-21/22; the engine is the live world
authority for successor chats and the legacy world/session model is deleted.
Plan [engine.plan.md](engine.plan.md) · contract [engine.spec.md](engine.spec.md).
What remains on this track: optional Gate 7 (queued above), the owner-gated live
paired evals, product ruling 12 (route-estimate uncertainty exposure), and the
parked backlog under `deferred/`.

## Shipped (historical record)

Moved to its own file to keep this index short — see **[roadmap.shipped.md](roadmap.shipped.md)** (newest-first).
