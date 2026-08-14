# Deferred — unplanned-but-good ideas

Status: **parking lot** — ideas worth keeping that aren't yet promoted to a plan.
Not a commitment, not priority-ordered (priority lives in [roadmap.md](roadmap.md)).
When an idea graduates it becomes a `<topic>.plan.md`, gets a roadmap line, and
leaves here (a one-line "graduated → …" tombstone is fine). This file is the
anchor; supporting detail files named `<topic>.deferred.md` nest under it in the
editor.

## Successor-engine improvement backlog (2026-07-23 + 2026-07-24 reviews)

_Detail: one draft-plan stub per item in the [deferred/](deferred/CLAUDE.md)
folder (index in its CLAUDE.md, which also keeps the stub-by-stub record of
what has already graduated). Batch 1 came from the 2026-07-23 correctness /
simulation-fidelity / resilience-perf review; batch 2 from the 2026-07-24
product review of the successor front door, chat routes, exchange layer, and
world surfaces — every claim code-verified before parking. **Owner ruling
(2026-07-23): these are fleshed out one at a time, on request. Each stub
graduates per deferred/CLAUDE.md to its own `<topic>.plan.md` (+ spec where
warranted) and a roadmap line.** None are committed work until then. Group A is
down to one
item, and groups C (hardening & perf) and E (lifecycle integrity) graduated in
full — command-integrity, drain-hardening, sim-read-seam-guards, and
successor-world-lifecycle all shipped 2026-07-23..27. Still parked:_

- **A. Bugs first** — **A3** solo-reply regenerate 409
  ([deferred/solo-retake.plan.md](deferred/solo-retake.plan.md)).
- **B. Living world** — seed the built-but-unseeded life — B8 graduated and
  shipped 2026-08-02 →
  [finished/starter-world-seeds.plan.md](finished/starter-world-seeds.plan.md);
  the primary's LOD
  ruling (at `exact` she is mechanically inert forever); remote text/voice when
  apart; successor NPC initiative; named daylight-band skips (the R5 leftover);
  autonomous NPC travel toward commitments.
- **D. Honest controls** — real Stop via an AbortSignal through the successor
  turn (D18); branch/fork/replay UX — the complete fix for honest rerun and
  history editing, surfacing `forkBranch`/ancestry/`explainItemPlacement`,
  none of which has a production caller (D19). (D17's capability manifest
  graduated and shipped 2026-07-28.)
- **F. Honest progress & status** — typed reply stream replacing the ZWSP
  heartbeat, preserving successor failure codes the reply-failure contract
  currently flattens to `unknown` (F21); turn-time honesty — solo turns
  through the bounded drain seam, completion beats written at completion
  (F23). (F22's world surface graduated and shipped 2026-07-28.)
- **G. Product & maintainability** — Worlds page → operational dashboard
  (G24); ChatConversation decomposition + explicit exchange state machine
  (G25); composer IME guard + per-chat drafts (G26); memory-index drain off
  the reply-critical path (G27).

## Account deletion — user-data erasure path

_Parked 2026-07-29 (owner ruling during data-lifecycle planning,
[data-lifecycle.plan.md](data-lifecycle.plan.md))._ No user-deletion path
exists today: no route or UI, Better Auth's `deleteUser` is not enabled, and
ten content tables reference `users.id` with default RESTRICT — deleting a
`users` row directly fails on FK violations. Build when the product needs it
(it eventually will — data-protection hygiene): the cascade/ownership map in
[data-lifecycle.audit.md](data-lifecycle.audit.md) §"Adjacent finding" is the
starting inventory, and the data-lifecycle chat-sweep machinery (chat_id FKs,
retention sweep) is the substrate a full account cascade composes from.

## Character-LoRA training as an in-app tool

_Owner direction 2026-08-11, taken when the Stage 5 character-LoRA pilot closed
([qwen-advanced-image-subsystem.plan.md](qwen-advanced-image-subsystem.plan.md)).
The Qwen plan lists automatic LoRA training inside Vesper as out of scope for
its first implementation, and this is where that lands. **Wanted so a more
sophisticated LoRA can be trained** — the pilot proved a character LoRA
improves identity alongside pack references, and found that its own training
set was the limiting factor, so this is no longer gated on the technique
proving itself._

Today training is an **operator errand**: `scripts/train-image-lora.ts` is run
by hand for one character, its dataset is assembled by hand, and the trained
weights are extracted and re-hosted by hand before a library row can point at
them. The tool would make that a product action — pick a character, review the
images it proposes, press train — and the pilot already exposed most of what it
has to own:

- **Dataset assembly from the character's own gallery.** The pilot's set was
  hand-curated from lab experiments whose verdicts said identity survived; a
  tool needs its own answer to "which of this character's renders represent
  her", plus per-image include/exclude review, near-duplicate detection, and a
  way to commission the missing variety (the pilot filled wardrobe, setting and
  framing gaps with ordinary variant renders).
- **Captions from authored appearance.** The trainer's doctrine is descriptive
  real words and the character's real name, never rare tokens — which is
  exactly what a character's authored appearance attributes could generate,
  and the same dependency
  [character-schema.plan.md](character-schema.plan.md) already owes the
  identity-finishing pass.
- **A training job, not a script.** Through the existing detached-job and
  image-cost machinery, with the provenance a comparison needs recorded on the
  row: which images, which hyperparameters, which training id, which artifact.
- **Hosting, which is the awkward part.** The trainer emits a zip and the
  Qwen LoRA connector refuses archives, so something must extract the
  safetensors and publish it at a durable public address before a library row
  is usable. That is a deployment-shaped decision (a bucket, a lifecycle, a
  ~600 MB artifact per character) rather than an application feature, and it is
  the piece most likely to decide whether this is worth building.
- **Lifecycle.** The Qwen plan's rule that a LoRA must not stay active when its
  training set no longer represents the character needs a mechanism here —
  staleness when the canonical portrait changes, and retraining or retirement.

**Trigger:** owner scheduling. Stage 5 already answered the question that used
to gate this — a character LoRA does improve identity alongside pack
references — so what remains is deciding when the tool is worth building
against the rest of the roadmap. The first thing it should make cheap is a
deliberately varied training set, since that is what the pilot lacked.

**Build it together with free-form image iteration, below** (owner direction
2026-08-11): the two are one workflow. Iterating a reference image by
instruction is how a varied training set gets made in the first place, and a
trained LoRA is what makes the next round of images better.

## Free-form image iteration — reference image plus an instruction

_Owner direction 2026-08-11, alongside the LoRA training tool above; build the
two at the same time._

Portrait Studio can only change a **fixed menu** of things: its variant kinds
are pose, outfit, expression and setting, each compiling its own instruction
against the character's canonical portrait. There is no way to say
"make her eyebrows a little thinner" — an ordinary, specific, small edit — and
no way to work from an image other than the canonical one.

What the owner wants: **supply an image, write an instruction in plain
language, get a result, and keep going from that result.** The value is direct
for LoRA datasets (targeted variety on demand is exactly what the Stage 5
pilot could not produce), and it is a better editing surface in its own right.

What it has to settle:

- **Any source, not just the canonical portrait** — an uploaded image, or any
  render the character already has. The lab's finishing pass already addresses
  a prior result by id; this generalizes that to the studio.
- **A free-form instruction beside the fixed kinds**, not instead of them. The
  four variant kinds carry compiled wording that has been tuned; a free-form
  path needs its own preamble deciding what stays locked, and the lab's
  finishing recipe is the worked example — a fixed change-nothing-else rule
  plus the author's narrow instruction, with the rule not editable.
- **Iteration with lineage.** Each result becomes the next input, so the chain
  needs to record what it descends from. The lab deliberately refuses a
  finishing pass over another finishing pass because "a chain accumulates
  drift with nothing to attribute it to" — a studio built for chaining has to
  answer that rather than inherit the refusal, most likely by showing the
  chain and letting a step be reverted to any ancestor.
- **Drift is the risk, and it compounds.** Every Qwen edit in this lab moved
  something it was told to leave alone; ten chained edits will drift further
  than one. Identity-pack references and the appearance instruction are the
  known mitigations, and the connector's own recrop habit
  ([qwen-advanced-image-subsystem.spec.md](qwen-advanced-image-subsystem.spec.md)
  §"Stage 4 verdicts") is the first thing to watch.
- **Who gets it.** Admin-only first, like the lab; a player-facing version is a
  separate decision about how much freedom an ordinary editing surface should
  have.

## Edge-controlled portrait variants

_Parked 2026-08-13, when the Qwen advanced image subsystem closed
([finished/qwen-advanced-image-subsystem.plan.md](finished/qwen-advanced-image-subsystem.plan.md)).
Stage 7 ruled this promotion in (2026-08-12) — edge is the reliable control
that costs no provider call — and the close-out ruling (2026-08-13) parked it
unbuilt rather than holding the plan open._

Portrait Studio's variant kinds would accept an edge map as a structural guide,
the way the lab's controlled portraits do. Two design rulings are owed before
coding, carried here from the spec's delivery section:

- **Which variant kinds may carry an edge map.** Edge maps encode clothing
  silhouettes (a recorded Stage 1/2 finding), so the map is actively wrong for
  `outfit` and questionable for `pose`.
- **Where the map comes from.** Extracting it from the canonical portrait and
  then sending both is the shape the lab bars as `control_source_sent`, and in
  a variant it would add little the identity image does not already carry. An
  edge map earns its place when it comes from a _different_ image — a
  source-picking decision, not a wiring one.

**Trigger:** owner scheduling, with the source-picking ruling taken first.

## Image sets and multi-output

_Parked 2026-08-14 (owner ruling at the image-model-capabilities close-out,
[finished/image-model-capabilities.plan.md](finished/image-model-capabilities.plan.md)):
a separate multi-output workflow is a product expansion, not normal-render
infrastructure, and did not hold that plan open._ The idea: an `image_sets`
table with ordered sibling images sharing a set identity, a multi-output
provider shell (`runRegistryImageModelMany`, `outputUrls`), the `coherent_set`
prompt strategy, and a distinct workflow for Seedream sequences, Wan image
sets, storyboard shots, and variation grids — while every existing lane stays
single-image. The full technical design is preserved in the archived spec
([finished/image-model-capabilities.spec.md](finished/image-model-capabilities.spec.md)
§"Image sets", §"Replicate prediction shell").

**Trigger:** owner scheduling, when a product surface actually wants ordered
multi-image output.

## Image capability remainders

_Parked 2026-08-14 with the same close-out._ Small pieces of the capabilities
plan deliberately left unbuilt, none load-bearing for normal renders:

- **Prompt fitting to model limits** — `fitPromptToModel` over named prompt
  segments, probe-recorded prompt length limits, and the
  `image_model.prompt_too_long_required` refusal (design:
  [finished/image-model-capabilities.spec.md](finished/image-model-capabilities.spec.md)
  §"Prompt fitting"). The reference-edit paths still run the fixed character
  budget inherited from Venice. Most natural alongside the render-quality
  plan's per-model prompt work.
- **Retry same composition** — a player/admin action reusing a stored
  `images.meta.render` record (profile, prompt, seed, controls, reference
  sources). The record exists on every render; only the button does not.
- **Derived latency labels** — per-profile fast/normal/slow from recent
  successful runs; needs duration recording first.
- **Text-repair / example-transform / remix profiles** — their prompt
  strategies deliberately refuse to compile and no lane supplies their
  references; seeding any of them is a broken picker entry until a consuming
  surface exists.

**Trigger:** owner scheduling; the retry action is the most player-visible of
the four.

## A reviewed style LoRA in an ordinary lane

_Parked 2026-08-13, when the Qwen advanced image subsystem closed
([finished/qwen-advanced-image-subsystem.plan.md](finished/qwen-advanced-image-subsystem.plan.md)).
Stage 7 ruled this promotion in (2026-08-12), behind a curated profile; the
close-out ruling (2026-08-13) parked it unbuilt._

Selection, validation, refusal and reproducibility are proven end to end in the
lab. What remains is machinery owned by
[image-model-capabilities.plan.md](image-model-capabilities.plan.md): a curated
LoRA-bearing profile is that plan's model-specific-profiles slice, and
`image_model_profiles` has no write path today, so any profile is a migration.

**The constraint that parked it:** the model the ordinary lanes run on takes no
LoRA at all, so LoRA work runs on the 2509-generation LoRA explorer, rated a
step down in identity preservation — promoting a style LoRA moves that lane
onto a weaker-identity checkpoint. Revisit when a LoRA-capable endpoint with
2511-grade identity exists, or when a style payoff justifies the trade.

**Trigger:** owner scheduling, most naturally alongside the capabilities plan's
model-specific-profiles slice.

## Outfit control without collapsing identity

_Parked 2026-08-13 from the Qwen plan's open question
([finished/qwen-advanced-image-subsystem.plan.md](finished/qwen-advanced-image-subsystem.plan.md);
the trial results are in the spec beside it). Owner ruling (2026-08-11):
identity plus one control is the proven configuration, and the wardrobe
pipeline is future work outside the Stage 1/2 acceptance._

Both wardrobe trial runs — identity plus a control map plus an outfit
reference, the model's full three-reference capacity — produced a different
person and ignored the pose, under two different instructions, while every
two-reference run preserved identity at least moderately. Two parts need
answering:

- why crowding the model at capacity costs identity rather than an optional
  role;
- what shape outfit control should take instead — a separate pass over a
  finished image, a wardrobe-specific recipe, or a model with more reference
  room.

## Video generation — reference-driven clips and keyframe stitching

_Owner direction 2026-08-14: a future capability, deliberately not next on the
roadmap. Feasibility research run the same day; full detail (model landscape,
provider comparison, costs, workflows) in
[video-generation.deferred.md](video-generation.deferred.md)._

Generate ~10-second clips the way Vesper generates images: a portrait or scene
render as the reference plus a motion prompt — an admin **video lab** first
(the Advanced Image Lab pattern), chat-context later. Longer videos come from
chaining clips through keyframes and concatenating. The research settled the
shape: it is an API-only commodity capability today; the image registry's
moderation split repeats exactly (open-weights Wan 2.2 / HunyuanVideo-1.5 /
LTX-2.5 are the explicit-capable backbone, hosted flagships the SFW quality
tier); Replicate is the recommended first provider (same predictions/webhook
flow as images, whole Wan line + MiniMax H3 + the `nsfw-api` Hunyuan tooling,
permissive terms, video LoRA trainers); and the identity-safe path to long
video is image-model keyframes — identity-pack-anchored stills — with the
video model interpolating first→last between them, so drift cannot compound.
This is also where the Seedream-to-Seedance video handoff idea
([image-model-capabilities.plan.md](image-model-capabilities.plan.md)) lands
when a video pipeline exists.

**Trigger:** owner scheduling. Promotion starts with a lane ruling (SFW-first
vs explicit-first) and a paid Stage-0-style probe; the detail doc names the
candidate endpoints.

## World authoring — locations, travel distances & durations

_Owner direction 2026-07-23: world setup for bespoke first-party worlds and
player-built worlds needs an authoring surface. Two stubs, which may fold into
one plan at promotion:_

- **Location builder** —
  [deferred/location-authoring.plan.md](deferred/location-authoring.plan.md):
  authored locations outside the entity library, with travel times to
  connected locations, contained furniture/items, a within-location spatial
  model (character/player position and facing, item positions and obstacle
  flags for movement + line-of-sight), owners (household), residents, upkeep
  cost, and function typing (workplace/shop/home/…).
- **Travel distances & durations** —
  [deferred/travel-duration-authoring.plan.md](deferred/travel-duration-authoring.plan.md):
  the duration-authoring facet (feeds `minimum`/`expected`/`uncertainty`);
  carries the drain-hardening tripwire (nonzero uncertainty MUST NOT ship
  before [drain-hardening.plan.md](finished/drain-hardening.plan.md) has — promoted
  2026-07-23).

## Physiology simulation — triggered body responses

_Owner direction 2026-07-23. Stub:
[deferred/physiology.plan.md](deferred/physiology.plan.md)._
Simulate physiology responding to triggers — arousal → genital blood flow →
swelling/lubrication, and the general case (cold → shivering/goosebumps,
embarrassment → blush, fear → trembling, exertion → sweat/breath). Background
processes: never wired to the narrator directly, but their *results* are
visible (field values, reads, behavior). The generalization of the
meter-economy OQ2 ruling ("arousal is a driver, not a talk-switch") into a
**response registry**: per-response drivers + rise/fall τ, with the
just-authored tendency attributes (`vulva.swelling`/`wetness`/`tightness`,
the sensitivity gains) as each character's transfer function, surfacing only
through perception-gated reads, the state strip, image prompts, and existing
behavior channels. Hard-depends on
[chat-meter-economy.plan.md](chat-meter-economy.plan.md); pairs with
[chat-body-needs.plan.md](chat-body-needs.plan.md) (drivers, couplings, the
needs channel). Open questions (stored vs derived, expression mechanism,
which intermediates earn their keep, anti-tedium cap) live in the stub.

## Owner-gated live eval runs — run on request, not roadmap items

_Removed from the roadmap 2026-07-13 (owner ruling: manual OpenRouter-spend
runs aren't tracked as roadmap items for now). Each is built and dry-run
validated; run when the owner asks, then record results in the owning plan._

- **Gate 4 paired voice/chemistry eval** (deferred at gate close, 2026-07-19) —
  the fifth [engine.gate4.perception-narration.md](engine.gate4.perception-narration.md)
  §"Gate 4 exit" criterion: a live paired
  eval showing the E4.x context (typed cuts, beliefs, licensed soft canon, memory
  recall) improves causal enactment without degrading median voice or chemistry.
  Per the owner's 2026-07-18 exit-scope ruling it does not hold the gate verdict —
  the deterministic corpus closed Gate 4. Unlike the entries below, its harness is
  **not yet built**: scoping and building the paired-prompt fixture set is part of
  running it, when the owner schedules the spend.
- **Enactment measurement run** —
  [finished/character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md)
  §slice 2 / spec §5: `pnpm eval:narration` then
  `pnpm eval:narration:compare --axis contrast`; bar ≥80% blind identification
  per axis. Also validates the 2026-07-10 trait-quota softening
  (narrator-prompt-consolidation slice 3 — below the bar ⇒ restore the
  commented pre-softening wording), and carries the multi-character fixtures
  (multi-character-chat followups ruling 7) + the `chat-secret-hold`/`-reveal`
  fixtures ([character-drives.plan.md](finished/character-drives.plan.md) slice 4,
  `secretCue` metric). This is also the **measurement for character-fidelity
  slice 9** (the chat-lane consistency check —
  [character-fidelity.plan.md](finished/character-fidelity.plan.md) slice 9): the
  blind-identification/contrast bar quantifies whether the one-turn corrective
  tail note actually holds voice/disposition/age register over a long chat.
- **`mt-chat-*` longitudinal baseline** and the **`CHAT_PROMPT_LAYOUT` A/B**
  (before its default flips) —
  [narrator-prompt-consolidation.plan.md](finished/narrator-prompt-consolidation.plan.md)
  §Rulings & leftovers.
- Older single-run leftovers recorded in their plans: `mt-chat-feeling-hurt`
  (emotional weather), the memory-callbacks judged run, the `chat-pov-*`
  scored run.

## Narration eval: self-consistency judge vote

_Raised 2026-06-29 (the one leftover when [finished/narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) shipped)._
The pairwise narration judge (`pnpm eval:narration:compare`) ranks each group **once**, with a
single judge. Run 2's close calls (and Run 3's 53/47 focus wash) would be firmer with a
**self-consistency vote**: rank each group N times (or with a second strong judge) and keep the
majority ordering. Position bias is already mitigated (shuffled labels) but not eliminated. A
methodology nicety, not blocking — the shipped rulings (per-lane profile, per-model reasoning,
"focus planner doesn't earn its keep") already stand on the current data. Pick up only if a future
ruling hinges on a margin this thin.

## Attribute value relationships & composite body-types

_Raised 2026-07-23. Detail: [attribute-scales.deferred.md](attribute-scales.deferred.md)._
Successor to the shipped per-value glosses
([finished/attribute-narrator-guidance.plan.md](finished/attribute-narrator-guidance.plan.md))
— the layer above them: the *relationship between* sibling values, so
`wiry` / `slim` / `athletic` stop being amorphous LLM-in-the-moment reads. The
owner's tell — those three aren't one scale, they're a gestalt flattened across
the orthogonal `frame × musculature × weight` axes. Two facets on one foundation
(attribute vocabularies as **ordered axes in a body-space**):

- **A — narrator scale/neighbor guidance (read):** on *ordered-scale* enums only,
  enrich the character's one rendered value with derived prev/next neighbors + a
  positional scope descriptor ("low on a 7-step scale"). Bounded to O(1) tokens
  (never the rejected full menu); pole-**words** and counts-between stay out of
  the prompt (counts feed an authoring/eval tool instead). Zero new authoring —
  all derived from the existing `allowedValues` order.
- **B — composite body-type fill (write):** a root gestalt word ("athletic")
  pre-fills the body axes. The owner's "too many combinations" worry dissolves:
  sparse per-word patches (2–3 defining axes) + additive composition + editable
  seed (not lock) + forge fallback for the tail ⇒ **O(words), not
  O(combinations)**.

Prerequisite for both: a definition flag marking which enums are ordered scales
vs categorical. Open questions (scope form, counts, lexicon size, conflict
resolution) live in the detail doc. Can graduate separately (A is render-only and
smaller; B is an authoring feature) but they share the prerequisite.

## Wardrobe accommodation for body features

_The one strand parked back when
[non-human-species.plan.md](finished/non-human-species.plan.md) shipped
(2026-06-18)._ Garments that fit winged/tailed bodies (back slits, tail
openings, horn-cutout hoods) so outfits don't clip or contradict features. The
seam is the `expand`/coverage question on the `coverageRelevant: false` `tail`
location; solving it means excluding `featureGroup` locations from coverage
`expand`, or per-garment "accommodates feature X" flags.

## Garment archetypes and reusable components

_Owner direction 2026-07-30. Draft plan:
[deferred/clothing-archetypes-components.plan.md](deferred/clothing-archetypes-components.plan.md);
technical companion:
[deferred/clothing-archetypes-components.spec.md](deferred/clothing-archetypes-components.spec.md)._
Extend the shipped clothing-state graph with a future blueprint-v2 authoring
compiler: keep the existing broad categories and content-hash snapshot identity,
then add recognizable archetypes (tee, polo, sweater, pullover hoodie, zip
hoodie), reusable component fragments, explicit pockets/openings/hoods/
drawstrings/decorations, conservative authored fit, and localized decoration
condition. Capability remains distinct from current body-garment relations: a
pocket says a hand *can* enter, while the future shared scene/body-relations
owner must establish that a hand is actually inside before garment affordances
may derive sag, tension, or a narration cue. This is a parked follow-up, not an
expansion of the clothing plan's already-defined remaining slices.

## Comms expansions

_Raised 2026-06-13, from the phase-3 presence open questions._ Phase-3 comms
ships single-pair only. Deferred, none designed:

- **Group calls / group texts.**
- **Voicemail content** — a missed call carrying a message that becomes a
  told-fact.
- **Persistent text-thread history** the player can reread — the first thing
  players will ask for, and a natural UI surface for the pending-messages
  mechanic.

See
[presence-and-perception-spec.phase3.md](finished/presence-and-perception-spec.phase3.md)
§Gaps & opportunities.

## Chat story map — scene-memory places graph

_Raised 2026-07-14, from the world-sim carry-forward review (the chat-lane
descendant of the demoted [world-map.plan.md](finished/world-map.plan.md))._ Chat's
`scene_memory` already stores places + connections — the same nodes-and-edges
shape the world map renders — and the graph component was written generically
(`lib/world-graph-layout.ts` + `components/worlds/world-map-graph.tsx`,
locations + links in). A small read-only "places this story knows" view (in the
Scenario modal or the desktop aside) is nearly free: nice texture for the
player and a useful QA window into scene memory. Not promoted because it's
garnish — pick up if players ask for it or scene-memory debugging warrants it.

## Item acquisition during play

_Raised 2026-06-13, from the location-design ownership ruling._ Spawn-time item
ownership ships with the location/ownership work (`owner_participant_id`,
written only at spawn). Deferred — needs its own design: characters **acquire**
items in play (purchases, gifts) that become owned at acquisition time, a
second provenance path the items model doesn't have yet.

See [location-design-spec.phase3.md](finished/location-design-spec.phase3.md)
§Ownership.

## Monorepo split — GRADUATED 2026-08-12

Graduated to [monorepo-image-core.plan.md](monorepo-image-core.plan.md). The
2026-06-16 permanent deferral was correct for the question it answered —
packaging for its own sake, gated on a second deployable. The question that
reopened it is different: the image subsystem grew into its own product and
needs a boundary the app cannot cross, which one workspace package supplies
without any second deployable.

## Observer / god-mode session POV

_Raised 2026-06-13, from the phase-3 presence open questions._ The
presence/perception design assumes a player POV; observer / god-mode
("omniscient") sessions have no player participant to anchor awareness
blocks to (followups.phase2.md #10). Omniscient mode is **less relevant
to this fork's romance scope**, but the user wants to support it
eventually. Needs its own think — likely narrator-omniscient with no
awareness blocks, but deferred rather than ruled. Phase 3 takes no
stance for observer sessions.

See [presence-and-perception-spec.phase3.md](finished/presence-and-perception-spec.phase3.md).

## Companion role as romance eligibility

**Owner ruling (2026-06-16): park — don't build, don't remove.** Keep the
`tier` and `role` fields; do not build companion-as-romance-eligibility now.

**Context (2026-06-16).** The original justification for Companion and NPC tiers
was narrator context budget — how much context to send for each character — and
that justification has not held up: context window has not been a problem, since
current models handle a lot of tokens. The open doubt was therefore whether the
tier and Companion systems carry any real value at all, or should be removed
entirely. The counterweight: in large worlds with many characters running in the
background, per-character cost could make tiers and companion flags necessary
after all.

**Assessment (2026-06-16).** What these fields do today: `tier`
(major/minor/extra) and `role` (companion/npc) are **stored and snapshotted but
nothing branches on them at runtime** — the only consumers are `spawnTier`
(companion `minor`→`major` bump) and the `MAJOR_TIER_SOFT_CAP` spawn/editor
warning (`lib/cast-tiers.ts`). Context window is not the justification and never
was the real lever. The lever these fields exist _for_ is **simulation cost**:
the per-character post-turn agent fan-out + memory writes each turn, and (once
it lands) offscreen simulation — compute/latency/token spend that scales with
**cast size**, not context length. The fields are nearly free as data and match
the project's forward-looking schema preference, so keeping them costs little;
building romance eligibility on `role` now would add the first runtime `role`
branch for a speculative benefit. If offscreen sim or large background casts
never land, deleting two inert fields later is trivial.

**Revisit trigger.** Reopen both questions together when offscreen simulation or
large background casts actually land and per-character cost bites — that is when
tiers would earn their keep.

_Raised 2026-06-13, brainstorm from the cast-tiers investigation._ Use the
existing cast **`role`** field (not tier) to designate romance targets:
**`role: companion` characters are the session's valid romance targets;
`role: npc` are not.** `npc`s stay fully fleshed (forge, facts, schedule,
presence) but are background flavor — the narrator deflects or gently redirects
romance gestures aimed at them. This keeps `tier` (`major`/`minor`/`extra`)
free for its existing job — _simulation/narration depth_ — orthogonal to who
can be romanced.

It rides machinery that already exists: `spawnTier` auto-promotes a `companion`
authored `minor` to `major` (`cast-tiers.ts`), so romance leads already get the
deepest simulation — wardrobe, meters, per-character memory, perspective
memories — for free, while a background `npc` sits at whatever tier its world
texture needs. Romance would still gate on the **affinity edge**, not the role
alone — the `close`/`devoted` stages and the perceived-affinity model are the
mechanical substrate; the `companion` role just decides _who is eligible to
climb that ladder at all_.

Note this gives `role` a concrete gameplay meaning. The cast-tiers spec today
calls `role: companion | npc` "an authoring/POV distinction, not a simulation
one" — this would make it the **first behavior to branch on `role` at runtime**
(nothing branches on role _or_ tier today). Tradeoff to weigh: a non-companion
that later needs to be romanceable must be re-cast as a `companion`, or gain a
separate `romanceable` flag; coupling to the existing role is cheapest and
matches the framing.

See [cast-tiers-and-affinity-spec.phase3.md](finished/cast-tiers-and-affinity-spec.phase3.md)
§Problem (role definition) and §Design: tiers.

## Natal sex — structured sex-at-birth

_Raised 2026-06-29, alongside the gender born-variant change._ The character
`identity.gender` enum now splits androgynous / nonbinary by sex at birth
(`androgynous_born_female` / `…_born_male` / `nonbinary_born_*`) so image generation
gets the natal build, and a separate **`identity.natal_sex`** attribute (enum
`female`/`male`) was created as a **scaffold** — flagged `excludeFromPrompts` (stored

- authored + editable, but not yet surfaced in any generated prompt) and shown in the
  editor **only for an androgynous / nonbinary presentation** (redundant for plain
  female/male). The born-variant on `gender` carries natal sex into rendering for now;
  `natal_sex` is the placeholder for doing this properly later. See
  [../contracts/attributes.md](../contracts/attributes.md) §"`natal_sex` is a
  forward-looking scaffold".

What "fleshing it out" should cover (none built yet):

- **Wire `natal_sex` into prompts** as the source of truth (drop `excludeFromPrompts`
  and add render logic to the attribute-iterating builders that currently skip it —
  `characterAppearanceSummary` / `buildAvatarPrompt` in `images/prompts-*.ts`,
  `buildGlanceImpressions` in `engine/scene.ts`, the chat loop in
  `prompts/character-chat.ts`), and decide whether it then **supersedes** the gender
  born-variants (collapsing `gender` back toward `female`/`male`/`androgynous`/
  `nonbinary` + a separate natal-sex axis) — which would also cleanly cover **trans
  presentations** the born-variant enum can't (e.g. female-presenting, natal male).
- **A model-facing definition of each gender term** — the open question from the
  2026-06-29 discussion: tell the narrator/image models what `androgynous` vs
  `nonbinary` actually _mean for this game_ (presentation vs identity), since for a
  purely visual prompt they otherwise overlap. Likely a `promptHints`-style gloss or a
  small rulebook note, gated on whether `natal_sex` becomes the visual driver.
- **Wider value set** — `intersex` (and possibly more) on `natal_sex`, and the matching
  body-config seeding story.
- **Auto-consistency** — keep `natal_sex` and the gender born-variant in agreement
  (derive one from the other, or warn on mismatch) instead of two hand-set fields.
- **A general conditional-visibility mechanism** — the editor currently hard-codes the
  `natal_sex`↔gender dependency in `attribute-picker.tsx`; a declarative `showWhen` on
  the attribute definition would generalize it (only worth building if a second
  conditional attribute appears).

## Relationship & meter timeline — _UX audit feature #4_

_Raised 2026-06-17 (UX audit §6 #4). **Graduated at chat scale 2026-07-02** →
[character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md) slice 8: the chat
Relationship panel ships an affinity sparkline (`relationship_history` ring) + milestones._
What stays parked: the **session-scale** version — a sparkline/timeline in the Cast panel
charting affinity + meters across a session (the per-turn deltas the post-turn agents
already emit). Promote it by porting the chat panel's shape onto session data.

## Session transcript export / share — _UX audit feature #8_

_Raised 2026-06-17 (UX audit §6 #8). **Graduated at chat scale 2026-07-02** →
[character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md) slice 8:
`GET /api/chats/:id/export?format=md|json` (+ optional memory appendix) ships from the
chat Relationship panel._ What stays parked: the **session** narrative-feed export
(and/or a shareable read-only view) — port the chat exporter's shape onto the
episode/feed data when wanted.

## Scene image: pin / set as session cover — _UX audit feature #9_

_Raised 2026-06-17, from the UX audit ([ux-audit.intake.md](finished/ux-audit.intake.md) §6 #9)._
Let a player promote a favorite generated **scene image** to the session header as its
cover. A small surface on top of the existing scene-image + gallery machinery. From
[ux-audit.plan.md](finished/ux-audit.plan.md).

## Body-affordance scene-image consumer

_Deferred by the
[body-attribute affordances plan](body-attribute-affordances.plan.md#slice-8--image-consumer-decision)
Slice 8 ruling on 2026-07-29; technical contract in the
[architecture spec](body-attribute-affordances.spec.architecture.md#deferred-scene-image-consumer-slice-8-ruling-2026-07-29)._

Let character-chat scene images consume a small allowlist of paintable semantic
facts from the same captured, perception-safe affordance read used by the rest
of the scene. Do not create image-only mechanics, coverage, or body state.
Promote this after the shared scene/body-relations owner supplies posture,
support, contact, impulse, and relative geometry. The owner may schedule an
earlier paired trial limited to already-authoritative wet-hair and wet-garment
facts; it must show a repeated visible gain without identity, pose, outfit,
coverage, phantom-body-part, or prompt-budget regressions. A non-win leaves the
consumer absent.

## First-run guided tour — _UX audit feature #10_

_Raised 2026-06-17, from the UX audit ([ux-audit.intake.md](finished/ux-audit.intake.md) §6 #10)._
The empty states are already strong (the audit praised them); a light **3-step coachmark**
("forge → begin → play") could shorten time-to-first-turn for a brand-new user. Lowest
priority of the audit ideas. From [ux-audit.plan.md](finished/ux-audit.plan.md).

## NPC puppeting — the full handling system

_Raised 2026-06-18, from personality Slice 2._ Slice 2 shipped the **deflection
directive** half of the puppet guardrail: intake flags player-authored NPC behaviour
(`narratedNpcBehaviors`), a deterministic rule refuses behaviour that contradicts
disposition, and the narrator answers with a cheeky meta aside. That is the working
v1; the broader system around "the player tries to puppet an NPC" is deferred to
[npc-puppeting.deferred.md](npc-puppeting.deferred.md) — merge-level state stripping,
stronger refusal (disallowing player-authored NPC behaviour from the player prompt
entirely, routed through the companion/narrator out-of-POV affordances), and richer
contradiction judging once full traits + affinity + mood exist (personality Slice 3).

## Production-build performance pass — _UX audit §5_

_Raised 2026-06-17, from the UX audit ([ux-audit.intake.md](finished/ux-audit.intake.md) §5)._
The audit **deliberately skipped** perf benchmarking because the dev Turbopack build
(unminified, HMR) isn't representative. Run a **production-build Lighthouse-perf + trace
pass** focused on the dashboard and the play screen (the heaviest route) for real numbers.
Not blocking — do it when perf becomes a question. From [ux-audit.plan.md](finished/ux-audit.plan.md).

## Old World-Model Plans from the Roadmap

These items were on the roadmap and are holdovers from the world-model system,
deprecated in favor of expanding and perfecting the character-chat system
_first_, and only then deciding whether to incorporate it into a bigger world
system.

**Owner lean (recorded with these demotions):** all desired features eventually
land in character chat, and character chat becomes less 1-on-1 focused over
time.

**Undecided, owner's call at promotion:** whether that broader chat lives behind
a different app route, or whether everything stays in one chat system.

- **Visual world map** — [world-map.plan.md](finished/world-map.plan.md). Slice 1 (read-only
  force-directed graph) shipped 2026-06-18; slices 2–3 (editable layout, play-screen
  minimap) remain — optional polish on a feature already delivering its core value.
  _Demoted to the bottom 2026-07-14 (owner): character chat is now the app's main
  focus and the world model is headed for deprecation or refactor — don't polish it.
  A chat-lane descendant (a read-only scene-memory places graph) is parked in
  [deferred.plan.md](deferred.plan.md) §Chat story map._
- **World simulation ("the world moves")** — the former "phase 5" cluster, not
  yet started, and now **direction-dependent**: character chat is the test bed
  for what the world/session model will eventually look like (owner direction
  2026-07-13 — see `CLAUDE.md`), so the movement-authority and
  scheduled-arrivals specs were retired (deleted) 2026-07-13 rather than built
  against the possibly-deprecated session model.
  [pre-narrator-agents.spec.md](finished/pre-narrator-agents.spec.md) remains as
  findings (its intake half shipped). A future `world-simulation.plan.md` — or
  the chat-successor equivalent — re-derives what it needs when this becomes
  active. **Re-derived 2026-07-16 as that chat-successor equivalent:
  [world-engine-refactor.plan.md](world-engine-refactor.plan.md)** (draft) — chat
  generalized, not the session model revived. Its thesis is that a *derived* world
  needs no tick, which is why the session-side remainder named here (movement
  authority, world-scale simulation) stays parked rather than becoming its
  prerequisite. _Demoted to the bottom 2026-07-14 (owner) with the map, same rationale._
  _Carry-forward 2026-07-14: the chat-applicable ideas graduated to
  [chat-plans-promises.plan.md](finished/chat-plans-promises.plan.md) (scheduled arrivals
  reborn) and [chat-offscreen-life.plan.md](finished/chat-offscreen-life.plan.md) (the
  world moves, scoped to the cast's lives) — see the top of this list. What
  stays here is only the session-side remainder (movement authority, world-scale
  simulation), pending the direction._