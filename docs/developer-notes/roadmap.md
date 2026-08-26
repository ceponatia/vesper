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
> A plan leaves this file only when the **whole** plan is done and accepted.
> Shipping a slice never removes an entry — it may only correct a hook that has
> stopped being true.

## Awaiting acceptance

- **Image model adapters and the feature composer** —
  [plan](image-model-adapters.plan.md) ·
  [spec](image-model-adapters.spec.md) — the adapter/composer build, LoRA
  compatibility split, final-wire invariant and two-phase bench budgets are
  merged; the owner's deployed Stage 7 Generator run with a curated LoRA is the
  remaining acceptance gate before any production-policy promotion.

## Active (building now)

- **Romantic contact affordances — foot-first grounded contact** —
  [plan](romantic-contact-affordances.plan.md) ·
  [spec index](romantic-contact-affordances.spec.md) — the romantic player
  surface, the movement-authority review, and positive visual contact narration
  all now wait on the owner rather than on code; the shared nonvisual sensory
  owners are the next developer-actionable piece.

- **Constraint-first narrator physical guidance** —
  [plan](narrator-physical-guidance.plan.md) ·
  [spec](narrator-physical-guidance.spec.md) — scoped consistency constraints,
  false-premise fences and mandatory action outcomes, live in production; slice 4
  needs a design decision, slices 5–6 need instruments that don't exist.

- **Visual state and attention** — [plan](visual-state.plan.md) ·
  [spec](visual-state.spec.md) — one lane-neutral projection over the existing
  appearance, wardrobe, body-condition and scene owners; slices 0–9 are
  complete, including narrator wiring behind a per-chat switch that is off by
  default, leaving slice 10's final consolidation.

- **Image render quality — per-model prompts, negative steering, and face
  fidelity** — [plan](image-render-quality.plan.md) ·
  [spec](image-render-quality.spec.md) — the content and tuning companion to the
  shipped capabilities plan, now scoped to the Qwen family and the recent seeded
  models; prompt segments and profile controls are live end-to-end on the probed
  reviewed rows, and slice 3's dialect and negative work now runs under the
  model-aware prompt programs plan below.

- **Image lane consolidation — one visual digest, one prompt path, verified
  legacy deletion** —
  [plan](image-lane-consolidation.plan.md) ·
  [visual-state spec](image-lane-consolidation.spec.visual-state.md) ·
  [prompt spec](image-lane-consolidation.spec.prompts.md) ·
  [retirement spec](image-lane-consolidation.spec.retirement.md) — consolidate
  every character-bearing image route onto semantic visual facts, then remove
  the duplicated appearance, reference-numbering, and prompt-budget machinery;
  Stages 1–4 are in — every character-bearing lane, including multi-character
  scenes, portrait edits, the chat-look anchor and the staged bench, now renders
  from the digest with provenance on the row — and collapsing the two scene
  assemblers into one (Stage 5) is the next step.

- **Model-aware image prompt programs** —
  [plan](model-aware-image-prompts.plan.md) ·
  [spec](model-aware-image-prompts.spec.md) ·
  [research](model-aware-image-prompts.research.md) — one immutable set of world
  facts feeds a positive prompt and a separately versioned negative prompt, with a
  linter that stops an exclusion forbidding something the world requires; the core
  and the Qwen Image 2512 slice are live on item and location renders, where every
  exclusion drops with a recorded reason because that endpoint ignores its
  negative field.

- **Narrator Prompt Lab** — [plan](narrator-prompt-lab.plan.md) ·
  [spec](narrator-prompt-lab.spec.md) — named,
  hand-written narrator instruction prompts with immutable revisions, selected
  per conversation, replacing only the narrator's behavior/craft layer while
  Vesper keeps supplying character/world state, per-turn constraints and the
  response contract; every take records the exact prompt revision and model that
  produced it.

- **Narrator model test bench** — [plan](narrator-model-bench.plan.md) ·
  [spec](narrator-model-bench.spec.md) — fourteen roleplay and low-refusal
  narrators are pickable from the chat menu, three of them served by a second
  provider (Featherless) for models no commercial host carries; the recorded
  comparison that would move a default is still the next step.

- **Image Generator — freeform registered-model testing, separate from the
  Image Lab** — [plan](image-lab-general-model-trials.plan.md) ·
  [spec](image-lab-general-model-trials.spec.md) — a distinct admin surface
  that runs any registered model with an authored prompt, supported inputs,
  and capability-driven controls, while the Advanced Image Lab keeps its
  stricter evidence contracts and sheds its misleading affordances.

- **Stable Diffusion rendering package** —
  [plan](sd-rendering-package.plan.md) ·
  [training runbook](sd-rendering-package.training.md) — `@vesper/image-sd`
  gives SDXL character LoRAs, identity conditioning, and ControlNet recipes
  behind the existing profile picker; the renderer is deployed and registered
  lab-only, Stage 3's PuLID arms picked `sdxl/identity-portrait` (0.80), and the
  Stage 4 training pipeline is built — the paid rank 8 / rank 16 runs and their
  graded comparison are the next step.

## Next (queued, in dependency order)

**Unblocked today — only scheduling gates these:** data lifecycle, resilience
closures, `ConfirmDialog`, clothing slice 7, and wiring the affordance layer to
the scene owner.

- **Data lifecycle — chat-scoped deletion, retention sweeps, intentional image
  orphans** — [plan](data-lifecycle.plan.md) · [audit](data-lifecycle.audit.md) —
  chat-flow data gets a real `chat_id` FK and dies with its chat, with images the
  one deliberate survivor so the Gallery keeps them.

- **Character reference views — accepting a portrait, and the angles it
  unlocks** — [plan](character-reference-views.plan.md) ·
  [spec](character-reference-views.spec.md) — accepting a canonical portrait
  builds side and full-length front/back views of that character, dressed and
  undressed, so a shot taken from behind anchors on her real back.

- **Body-attribute visual affordances — remainder** —
  [plan](body-attribute-affordances.plan.md) — the release-contract remainder is
  the successor adapter; separately unblocked scene-owner wiring enables hair
  adhesion and garment drape, while wet cling still waits on a recorded garment
  fit.

- **Clothing state graph — remainder** — [plan](clothing-state-graph.plan.md) ·
  [audit](clothing-state-graph.audit.md) — slice 7 maps the contracts onto
  successor items and is blocked on nothing; the `CHAT_GARMENT_CUES` tuning run
  now needs owner spend and a verdict, not an instrument.

- **Codebase efficiency — correctness and measured-response tranche** —
  [resilience](resilience-closures.plan.md) ·
  [confirm dialog](editor-scaffold.plan.md) ·
  [chat latency](chat-reply-latency.plan.md) — ordered: resilience closures →
  `ConfirmDialog` alone → chat pre-reply latency after a repeated baseline.

- **Chat meter economy — the body on the story clock** —
  [plan](chat-meter-economy.plan.md) · [spec](chat-meter-economy.spec.md) —
  hygiene, arousal, energy and sleep driven by the story clock instead of
  exchange counts; a chat-lane build, not an engine port.

- **Chat body needs — satiation, hydration, and needs that push** —
  [plan](chat-body-needs.plan.md) — the three asked-for meters plus the needs →
  initiative channel; depends on the meter economy landing first.

- **Character schema improvements — facial realism + engine-shaped contracts** —
  [plan](character-schema.plan.md) — a descriptive `face.attractiveness`
  attribute replacing the portrait studio's hardcoded beauty bias, plus the
  template fields the engine can consume; owes a `character-schema.spec.md` split.

- **Codebase efficiency — later consolidation sequence** —
  [client safety](client-type-safety.plan.md) ·
  [library routes](library-route-registry.plan.md) ·
  [editor scaffold](editor-scaffold.plan.md) ·
  [contracts](contracts-hygiene.plan.md) ·
  [dead exports](dead-export-sweep.plan.md) ·
  [tooling](tooling-gates.plan.md) — dependency order only, **not promoted to
  next**: client type-safety → library routes → an editor-scaffold go/no-go →
  contracts, dead-export and tooling hygiene.

- **Headwear that actually covers hair** —
  [plan](headwear-hair-occlusion.plan.md) ·
  [spec](headwear-hair-occlusion.spec.md) — a headscarf renders with the hair
  genuinely hidden while a cap or visor leaves it showing, via an enclosure band
  on headwear that the wardrobe's coverage axis cannot express.

## Someday / parking lot

Parked ideas are tracked as GitHub issues rather than in this repo.

Three detail documents survive on disk without a plan above them, kept for the
research in them: [attribute-scales.deferred.md](attribute-scales.deferred.md)
(ordered attribute axes and composite body-types),
[npc-puppeting.deferred.md](npc-puppeting.deferred.md) (the full puppet-handling
system beyond the shipped deflection directive), and
[video-generation.deferred.md](video-generation.deferred.md) (the model,
provider and cost landscape for reference-driven clips).

Two remainders are documented but unplanned and need a home:
[condition-attribute-effects.md](condition-attribute-effects.md) (four small
chat-state plumbing items) and
[intimate-defaulting.md](intimate-defaulting.md) (body-config provenance and
re-derivation — belongs under character schema).

## Successor world engine — foundation and rollout COMPLETE

Gates 0–6 and rollout R0–R6 shipped 2026-07-21/22; the engine is the live world
authority for successor chats and the legacy world/session model is deleted.
How it works: [docs/engine/](../engine/README.md). What remains on this track:
the owner-gated live paired evals, and product ruling 12 (route-estimate
uncertainty exposure).
