# Roadmap

The single ordered index of development plans. **Order here is the only place
priority lives** — reprioritizing is a one-line move, never a file rename (see
`CLAUDE.md` → working-docs convention).

Status legend: **draft** (not settled) · **next** (queued) · **active** (in
progress) · **shipped — <date>** · **parked**.

> Order is priority, top-down. Each entry links its plan; the plan links its
> spec/detail.
>
> **Entries are short on purpose.** A title, its links, a status, and a few
> lines saying what the work is and what gates it. Build history, slice
> narratives, and rulings belong in the plan — an entry that grows past a short
> paragraph is a plan leaking into its index.

## To be Planned

This section is for the product owner to add ideas for features and improvements. AI agents
must _not_ add anything to this section. AI agents _may_ remove items from this section once
they have incorporated them into the roadmap below and either created a new plan or updated
an existing plan that will include this work.

_(Currently empty — the two character-chat ideas that were here graduated to plans on
2026-06-30.)_

## Active (building now)

- **Image model capabilities — profiles, shared controls, and richer workflows** —
  [image-model-capabilities.plan.md](image-model-capabilities.plan.md) ·
  [spec](image-model-capabilities.spec.md) (active). Makes image models *usable
  well* now that the registry made them data: reviewed semantic capabilities,
  task profiles beneath each model, one normalized render intent shared by every
  image lane, role-aware references, recorded seeds, safe version promotion, a
  curated LoRA library, and coherent image sets. **Slice 1 shipped 2026-08-05.**
  **Slice 2 — the shared render intent — is the highest-leverage unblocked work
  in the repo:** four other plans wait on it, and it is cheaper than the plan
  was written to expect, because the profile compile step, control mapper,
  prompt-strategy dispatch and renderer pass-throughs already landed inside the
  identity-pack trial.

- **Image identity packs — durable owner-scoped face references** —
  [image-identity-packs.plan.md](image-identity-packs.plan.md) ·
  [spec](image-identity-packs.spec.md) (active). Compiles each character's
  canonical portrait into a revisioned identity pack behind a hidden image kind.
  **Slices 1–4 and 5A shipped 2026-08-06; the slice-6 trial harness shipped
  2026-08-06 and was hardened through 2026-08-07.** Nothing consumes packs yet —
  `IMAGE_IDENTITY_PACK_REFERENCES` is default off. Remaining: **slice 6's trial
  run** (owner corpus + paid cells + detector decision + thresholds), **slice 5B**
  (render-lane consumption, waits on capabilities slice 2), then **slice 7**
  close-out. **Before any paid cell can run, an admin must re-probe each seeded
  model** — all six ship as bare official slugs with no pinned version, and the
  trial deliberately refuses to plan unpinnable cells.

- **Romantic contact affordances — foot-first grounded contact** —
  [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md) ·
  [spec index](romantic-contact-affordances.spec.md) (active). The affectionate
  tier is **live in production since 2026-08-02** (`CHAT_CONTACT_ACTIONS` and
  `CHAT_PHYSICAL_CONSTRAINTS` on) after an internal trial the owner passed on
  2026-08-01. NPC scene-decision authority (item 4) and the `romantic_touch`
  permission owner (item 5) are **built and dark**. **Next is a free step: enable
  the shadow measurement.** It costs one classifier call per qualifying reply,
  needs no code, and every later item waits on the window it opens — so starting
  it early costs nothing and blocks nothing.
  **Rollout hazard:** `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS` grants *all three*
  authority kinds when unset. It must be narrowed **before**
  `CHAT_NPC_SCENE_DECISIONS` is turned on, or the staged rollout the spec mandates
  is skipped in one step.

- **Constraint-first narrator physical guidance** —
  [narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md) ·
  [spec](narrator-physical-guidance.spec.md) (active). Replaces always-on
  descriptive suggestions with scoped consistency constraints, false-premise
  fences, and mandatory resolved action outcomes. **Slices 0–3 shipped
  2026-07-30/31, and `CHAT_PHYSICAL_CONSTRAINTS` has been on in production since
  2026-08-02** — this is a live feature, not a dark experiment. Remaining: slice 4
  (change-gated positive detail — gated on a design decision, because the
  transition tier now has a mandatory tenant it cannot displace), slice 5 (the
  trials — gated on instrument work that does not exist), slice 6 (successor
  adapter — gated on successor affordance/contact adapters that do not exist).
  `CHAT_AFFORDANCE_CUES` is parked off permanently; that experiment closed.

## Next (queued, in dependency order)

**Unblocked today — nothing gates these but scheduling:** data lifecycle,
capabilities slice 2 (above), visual state slices 0–5, the shadow-measurement
enable (above), resilience closures, `ConfirmDialog`, clothing slice 7, and
wiring the affordance layer to the scene owner.

- **Data lifecycle — chat-scoped deletion, retention sweeps, intentional image
  orphans** — [data-lifecycle.plan.md](data-lifecycle.plan.md) ·
  [audit](data-lifecycle.audit.md) (next). **Nothing gates this, and it is the
  security/privacy follow-through the owner asked to start with.** Chat-flow data
  gets a real `chat_id` FK and dies with its chat; images are the one deliberate
  exception, surviving chat *and* character deletion so the Gallery keeps them.
  Also: a one-time purge of audited orphans, retention deletions folded into the
  periodic sweep that now exists, and prod telemetry content minimization. All
  four open questions were ruled 2026-07-29.

- **Visual state and attention — identity, presentation, current state, and what
  the viewpoint notices** — [visual-state.plan.md](visual-state.plan.md) ·
  [spec](visual-state.spec.md) (next; not started). One lane-neutral projection
  over existing appearance, anatomy, wardrobe, body-condition, scene-relation and
  affordance owners, keeping identity, deliberate presentation, current effects
  and body language separate, and supplying narrator, image and inspector digests.
  **Slices 0–5 are unblocked** — every source owner it reads now exists. Slice 7
  needs a paid narrator trial; slice 8 needs capabilities slice 2. It does **not**
  depend on identity packs.

- **Image render quality — per-model prompts, negative steering, and face
  fidelity** — [image-render-quality.plan.md](image-render-quality.plan.md) ·
  [spec](image-render-quality.spec.md) (active). The content/tuning companion to
  the capabilities plan: per-model prompt dialects, context-aware negative
  steering, reviewed sampler settings, delta-first edit contracts, model-native
  dimensions, best-of-N portraits, guarded repair, and advisory output QA.
  **Slice 1 — the reviewed quality overrides — shipped 2026-08-05 and runs in
  every render.** Everything after it waits on capabilities slice 2, plus a paid
  tuning trial and an owner decision on the face-repair model.

- **Body-attribute visual affordances — remainder: successor adapter, and reading
  the scene owner** —
  [body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
  (active; slices 0–4, 6 and 7 shipped 2026-07-28/29, slices 5 and 8 closed
  2026-07-29). The shared read runs on every production exchange. **The
  release-contract remainder is one item: the successor-lane adapter**, gated on
  the successor lane owning any of attribute-derived appearance, weather, or body
  wetness. Separately and unblocked: `chat-affordances.ts` still does not read the
  scene owner, which is the only thing keeping hair adhesion and garment cling
  and drape silent in production. One wardrobe gap remains — nothing records
  garment fit, and that single field is what lights up wet cling.

- **Clothing state graph — remainder: slice 7, and an instrument for the tuning
  run** — [clothing-state-graph.plan.md](clothing-state-graph.plan.md) ·
  [audit](clothing-state-graph.audit.md) (active; slices 0–6 shipped 2026-07-27,
  slice 8 closed 2026-07-29). **Slice 7** — mapping the contracts onto successor
  items — is blocked on nothing. The `CHAT_GARMENT_CUES` comparison run that would
  decide whether the narrator digest flips on **has no harness**; building the
  instrument is comparable in size to the run, so this is not owner spend alone.
  Also queued: widening the extraction lane to ensemble members, which needs one
  signature to start carrying character ids.

- **Codebase efficiency — correctness and measured-response tranche** —
  [audit](codebase-efficiency.audit.md) ·
  [resilience](resilience-closures.plan.md) ·
  [confirm dialog](editor-scaffold.plan.md) ·
  [command hot path](sim-command-shell.plan.md) ·
  [chat latency](chat-reply-latency.plan.md) (next). Ordered: **(1) resilience
  closures**, including production garment-graph validation; **(2) `ConfirmDialog`
  alone** — approved as a same-day focused fix, still unbuilt, and the
  dismiss-mid-delete defect is live; **(3) the cheap hot-path set** — A11's single
  recorder-window read and E13/E14's immutable registry indexes; then **(4) chat
  pre-reply latency** after a repeated timing baseline. Each slice must preserve
  narrator output and committed state, except the approved diagnostic and
  degraded-validation behavior. **This tranche no longer waits on the affordance
  builds** — none of its files are in that area, and those files will not go
  quiet; only the contracts affordance slices (E8/E9) and the affordance-cue eval
  runner do.

- **Chat meter economy — the body on the story clock** —
  [chat-meter-economy.plan.md](chat-meter-economy.plan.md) ·
  [spec](chat-meter-economy.spec.md) (next; nothing built in the chat lane).
  Hygiene never visibly decays, arousal never resolves after intimacy completes,
  and flavor-only skips no longer fit a world where skips are the primary time
  mover. Drift moves off exchange-counting onto the story clock, plus a
  bidirectional energy/sleep axis, a pulse intimacy read with climax reset and
  afterglow, arousal regraded to body facts, and off-screen self-care.
  **This design already shipped — in the successor engine.** Gate 5 adopted this
  plan's spec as its normative source, so the remaining work is a port into the
  chat lane, and whether to reuse the engine's pure modules or twin them is open.

- **Chat body needs — satiation, hydration, and needs that push** —
  [chat-body-needs.plan.md](chat-body-needs.plan.md) (draft). The three asked-for
  meters plus the needs → initiative channel that makes them worth having.
  **Depends on the meter economy landing first** — it is the second use of that
  plan's clock-keyed drift, rhythm kinds and read seam. Its meters are already
  pre-authorized engine-side as registry data edits rather than schema changes.

- **Successor world engine — Gate 7: optional institutions & macro simulation** —
  [engine.gate7.institutions.md](engine.gate7.institutions.md) (draft).
  **Explicitly optional** (owner ruling 2026-07-21). Its precondition was met
  2026-07-22, so it is unblocked but opens only on the owner's call. Admit a
  package (employers, schools, housing, labor, markets, news, law, weather,
  factions…) only when a world type and scenario corpus justify it and it declares
  its authority, LOD, laws, budget, and disable path.

- **Character schema improvements — facial realism + engine-shaped contracts** —
  [character-schema.plan.md](character-schema.plan.md) (draft; none of its items
  exist yet). Two threads: the portrait studio's hardcoded beauty bias replaced by
  a descriptive `face.attractiveness` attribute with per-value image guidance
  (evaluative one-worders don't steer image models; descriptive vocabulary does),
  and the template-side fields the engine can consume — typed schedule kinds,
  `birthday`, the reserved `attraction` axis, an authored `means` band, and
  consent-scope scaffolding. Owns the surviving character-forge work. Thread 1
  carries spec-grade detail and owes a `character-schema.spec.md` split.

- **Spatially controlled scene images — pose, depth, and character identity** —
  [spatial-scene-images.plan.md](spatial-scene-images.plan.md) (draft; not
  started). Chat-first detached image pipeline: one validated 3D spatial frame
  produces pose/depth/segmentation controls, and the same frame can later feed
  narrator reachability and motion. **Gate 0 is a paid spike, and it asks the same
  question as the Qwen advanced subsystem below by a different route** —
  self-hosted ComfyUI versus a hosted control-map model. Funding both pays twice
  for one answer; this needs an owner decision before either is scheduled.

- **Qwen advanced image subsystem — controlled composition experiments** —
  [qwen-advanced-image-subsystem.plan.md](qwen-advanced-image-subsystem.plan.md)
  (draft; no code, and awaiting owner review). An admin-only lab that runs a Qwen
  edit model with pose/depth/edge control maps and compares each result blind
  against the ordinary output. **Model choice ruled 2026-08-07: build on the
  already-seeded Qwen Image Edit 2511, and register Qwen Image Edit Plus only if
  2511 turns out not to honour control maps** — so Stage 0 opens with a
  one-generation probe that decides the plan's shape. **Blocked on capabilities
  slices 2, 3 and 9**, and its LoRA stage duplicates capabilities slice 6 — that
  stage should fold there rather than being built twice. Competes with the plan
  above for the same experiment budget.

- **RAG improvements — remainder** —
  [RAG-improvements.plan.md](RAG-improvements.plan.md) (draft; partly shipped).
  Per-query embeddings with rank fusion and provenance, subject supersedence, the
  retrieval eval harness, and a measured fact-relevance floor all shipped
  2026-07-02; centralizing lore gating is moot because lore retrieval was deleted.
  **Three strands remain** — the presence half of the relevance floor, wiring
  witness gating to a real viewpoint, and RAG-as-history — and all three are
  near-worthless until multi-character conversations are the normal case, because
  in a one-on-one the subject is trivially present and one viewpoint sees
  everything.

- **At-rest encryption — user chat content unreadable on Neon** —
  [at-rest-encryption.plan.md](at-rest-encryption.plan.md) (draft; zero
  implementation). App-side AES-256-GCM envelopes over transcripts, memory rows
  and derived sinks so Neon holds only ciphertext, with the key in Fly secrets.
  **Gated on one owner ruling (D1)**: whether to encrypt fact and episode
  embeddings and move scoped similarity ranking app-side, since plaintext
  embeddings are invertible. Successor-lane scope is an open question, not settled
  scope. Sequencing note: any future SQL-side retrieval filter should land before
  D1(b), or be re-expressed in-process afterwards.

- **World engine refactor — the unowned catalog** —
  [world-engine-refactor.plan.md](world-engine-refactor.plan.md) (draft;
  umbrella, not a build item). Nothing is built *as* this plan; its buildable
  pieces promote out into their own plans. **Its architecture chapter is now
  history** — the engine was built from it and shipped. What still earns it a live
  slot is the catalog: roughly twenty ideas owned by no plan, of which the
  **salience bus** and a **composed scene frame** are the only named seams still
  unbuilt in either lane. Once those and the environment core are promoted, what
  remains is history and this archives.

- **Codebase efficiency — later consolidation sequence** —
  [audit disposition](codebase-efficiency.audit.md#review-disposition-and-owner-rulings--2026-07-30)
  · [command shell](sim-command-shell.plan.md) ·
  [fork registry](sim-fork-registry.plan.md) ·
  [client safety](client-type-safety.plan.md) ·
  [library routes](library-route-registry.plan.md) ·
  [editor scaffold](editor-scaffold.plan.md) ·
  [contracts](contracts-hygiene.plan.md) ·
  [dead exports](dead-export-sweep.plan.md) ·
  [tooling](tooling-gates.plan.md) (draft; dependency order only, **not all
  promoted to next**). After the tranche above: command-shell consolidation → fork
  registry (strictly after — a fork mismatch caused by the shell migration would
  be misread as a registry regression) → client type-safety (unblocked since the
  image pipeline shipped 2026-08-02) → library registry/routes → a go/no-go on the
  full editor scaffold → broad contracts, dead-export and eval-tooling hygiene.
  `ConfirmDialog` is deliberately **not** in this sequence — it is pulled forward
  into the tranche above. The eval harness must precede widening the duplication
  gate, or that gate goes red on its first run. Settled exclusions: no expanded
  snapshots without measurements, no suggested-item write batching, no client
  cache, no removal of `travel_minutes`.

- **Codebase modularity — large-file splits and shared-code consolidation** —
  [audit](codebase-modularity.audit.md) (audit run 2026-08-06; **needs a plan**).
  Sixteen files exceed 1,500 lines, and roughly 5,000 lines of duplication sit in
  three clusters of scaffolding around already-good abstractions. Distinct from
  the efficiency cluster above — different question (read cost versus duplication
  and hot paths), different risk profile, and one prerequisite it doesn't share:
  the biggest targets are still being edited by two live builds. Two of its
  findings are already owned elsewhere and must not be re-claimed here. Its
  correctness-flavoured findings should not wait for a plan at all — they fold
  into whichever plan touches each file first.

## Someday / parking lot

Unpromoted ideas live in [deferred.plan.md](deferred.plan.md): the
**successor-engine improvement backlog**
([deferred/CLAUDE.md](deferred/CLAUDE.md) — fourteen draft stubs from the
2026-07-23/24 review batches; they graduate one at a time on the owner's go,
never in bulk), the **owner-gated live eval runs**, the **body-affordance
scene-image consumer**, the relationship & meter timeline (UX-audit #4), the full
**NPC-puppeting** system
([npc-puppeting.deferred.md](npc-puppeting.deferred.md)), comms expansions, item
acquisition during play, the remaining UX-audit deferrals (transcript export #8,
scene-image pin #9, first-run tour #10, production-build perf pass §5), observer /
god-mode POV, monorepo split (permanently deferred), and
companion-role-as-romance-eligibility (park, don't build).

Two open remainders are documented but not yet planned:
[condition-attribute-effects.md](condition-attribute-effects.md) (four small
chat-state plumbing items — a catalog row, one call, a write-boundary diagnostic,
and a precedence ruling) and [intimate-defaulting.md](intimate-defaulting.md)
(body-config provenance and re-derivation; its persona-seeding item was a live
player-facing defect and shipped 2026-08-07 — see
[roadmap.shipped.md](roadmap.shipped.md)). Both need a home — the second belongs
under character schema.

## Successor world engine — foundation and rollout COMPLETE

All committed gates (0–6) closed 2026-07-16 → 2026-07-21, and the migration &
rollout plan (R0–R6) shipped 2026-07-21/22 — the engine is the live world
authority for successor chats and **the legacy world/session model is deleted**
(see the top of [roadmap.shipped.md](roadmap.shipped.md)). What remains on this
track: optional Gate 7 (queued above, owner-gated); the owner-gated live paired
evals; **product ruling 12** (route-estimate uncertainty exposure — the last one
open); and the parked improvement backlog under `deferred/`. The plan's single
end-to-end graduation scenario was never run as one arc; each gate closed on its
own corpus instead.

The chat-lane [chat-meter-economy.plan.md](chat-meter-economy.plan.md) and
[chat-body-needs.plan.md](chat-body-needs.plan.md) are queued above as **chat-lane
work, not engine ports** — Gate 5 already implements that economy in the successor
lane because ruling 15 took the chat spec as its normative source. Full plan
[engine.plan.md](engine.plan.md) · contract [engine.spec.md](engine.spec.md).
(Distinct from the chat-lane
[world-engine-refactor.plan.md](world-engine-refactor.plan.md) umbrella above.)

## Shipped (historical record)

Moved to its own file to keep this index short — see **[roadmap.shipped.md](roadmap.shipped.md)** (newest-first).
