# Visual state and attention

Status: active (planned 2026-08-05; slices 0–1 reviewed 2026-08-16, slice 2 built
2026-08-16 and awaiting review, slices 3–10 queued)

Outcome: A player can watch a character's appearance carry forward — damp hair
still damp, one sleeve still rolled, the jacket still on the chair — in both the
writing and the pictures, so that details stop resetting between one moment and
the next.

Technical companion: [visual-state.spec.md](visual-state.spec.md)

Related work:

- [body-attribute visual affordances](body-attribute-affordances.plan.md) owns the
  existing body-truth projections, physical observations, recognizable features,
  and observer visual memory this plan extends rather than replaces;
- [clothing state graph](clothing-state-graph.plan.md) owns garment instances,
  per-part presentation, material condition, coverage, and scene locus;
- [romantic contact affordances](romantic-contact-affordances.plan.md) owns the
  scene / body-relations layer this plan reads for body language;
- [narrator physical guidance](narrator-physical-guidance.plan.md) owns binding
  constraints and premise correction;
- [image model capabilities](finished/image-model-capabilities.plan.md) owns the shared
  render intent that will consume visual state;
- [image render quality](image-render-quality.plan.md) owns model-specific
  prompting, reference quality, render QA, and image trials;
- [image lane consolidation](image-lane-consolidation.plan.md) owns migration of
  character-bearing image routes onto this plan's digest, final reference
  ownership, and deletion of superseded image prompt machinery;
- [scene composition](finished/scene-composition.plan.md) owns the scene image's camera,
  subject orientation, and intimate staging; its interim read of the scene /
  body-relations owner migrates onto this plan's image digest when slice 8
  ships.

## What this plan waits for

Slices 0–5 are unblocked. Every owner they read from already exists: canonical
attributes and located appearance facts, realized anatomy, recognizable-feature
priors and observer visual memory, the garment graph, body-surface wetness, and —
since 2026-07-31 — the scene / body-relations owner that proves posture, facing,
proximity, support, and reach. That last one was the notable gap when this plan
was written, and it has closed.

One later slice has a real prerequisite:

- **Slice 7** is a paid narrator trial and needs a scheduled comparison run.
- **Slice 8** feeds the shared render intent, which shipped with the
  [capabilities plan's](finished/image-model-capabilities.plan.md) slice 2 on
  2026-08-07 — that gate is open, and the intent's role-carrying references
  are waiting for this plan's image digest.

This plan does **not** depend on
[image identity packs](finished/image-identity-packs.plan.md). A pack is a stored picture
of a face; visual state is a computed description of a person right now. They
meet only inside a render request, where the pack supplies the reference image
and this plan's image digest supplies the facts, and neither reads the other.

## In one sentence

Turn stable identity, deliberate presentation, current physical condition,
clothing arrangement, and body language into one deterministic visual
projection, then select only what the current observer or camera can perceive
and what matters enough to use.

## The experience we want

Vesper should not re-create a character from a static appearance paragraph every
time the narrator or image generator needs them.

The system should distinguish:

- what is normally true of the person;
- what they deliberately chose today;
- what has happened to that presentation since;
- how their body and clothing are arranged now;
- which facts are visible from the current viewpoint;
- which visible facts are new, distinctive, changed, or relevant.

That makes ordinary continuity possible: damp hair remains damp until it dries;
one sleeve can stay rolled; lipstick may become smudged; a jacket stays over the
chair after removal; trembling hands matter while a glass is offered; a scar is
not reintroduced every scene; eye colour is not described from across a dark
room; intentional missing or additional anatomy is not “corrected” by an image
quality prompt.

The common result should still be restraint. Narration normally receives one or
two useful details, not an appearance inventory. Image generation receives all
load-bearing identity and continuity facts, then only the optional current-state
detail its prompt budget can support.

## Why this needs its own plan

Vesper already has stable attributes, located appearance facts, anatomy state,
garment instances, garment-part presentation, body-surface wetness, physical
affordances, recognizable-feature salience, and observer visual memory.

The missing layer is a lane-neutral projection that can answer:

1. What is visually true at this committed story moment?
2. Which source owns each fact?
3. How does one fact modify, cover, or replace another visible surface?
4. What can this observer or camera resolve?
5. What is mandatory for identity and continuity?
6. What is optional but salient enough to mention or emphasize?
7. Which output is appropriate for narration, imagery, diagnostics, or future
   animation?

Without it, each consumer builds a different partial appearance summary. That
invites drift, duplicated logic, hidden-feature leakage, prompt bloat, and
disagreement between prose and images.

## Core design rulings

### Visual state is a projection, not another truth store

Do not persist a giant `visualState` blob that duplicates body, wardrobe,
conditions, pose, or world state.

Canonical attributes and located facts own stable appearance. Anatomy owns
present, absent, altered, prosthetic, or additional parts. Wardrobe owns garment
identity, locus, coverage, part presentation, material condition, marks, and
damage. Body-state owners own current conditions when they actually exist.
Presentation owns deliberate non-item choices. Pose, contact, scene relations,
and committed actions own body language and geometry. Environment owns scene
conditions.

`VisualStateFeature` is the normalized read over those owners. Its source
reference, evidence, and fingerprint make conflicts diagnosable and replay
deterministic.

### Keep four layers separate

The projection preserves:

- **identity** — stable morphology and recognizable landmarks;
- **presentation** — deliberate, currently maintained choices;
- **current** — transient or persistent effects on body, presentation, or
  clothing;
- **body language** — asserted posture, support, orientation, gesture, and
  movement, never an emotional guess.

A wet hairstyle is not a new identity. A wig is not a hair-colour mutation.
Smudged makeup is not a permanent facial mark. Typed composition resolves these
relationships instead of flattening them into prose.

### Prefer measurable facts to subjective adjectives

The source contract stores or projects shape, angle, spacing, texture, pattern,
side, region, wetness, displacement, openness, roll, damage, dirt, posture,
support, orientation, gaze, and motion.

Beautiful, intimidating, delicate, youthful, exhausted, or seductive may be
consumer interpretations. They are not substitutes for the facts that produce
those reads and never silently become body truth.

### Never parse prose as current truth

Narrator text, biographies, generated captions, and semantic memory are not
authoritative visual state. Models may propose typed operations through guarded
extraction lanes; reducers and source owners decide whether they commit.

### Observer perception and camera visibility are not identical

Narration uses an observer-relative view and observer memory. Image generation
uses a camera-relative view.

A camera may render a visible feature the player has not consciously noticed;
that does not update player memory. The narrator may recognize a familiar person
from a silhouette while an image prompt still needs hidden identity anchors to
hold the generated character together.

### Identity requirements are not optional salience

Salience selects optional detail. It never removes required identity,
morphology, subject count, wardrobe truth, requested action, or authored
absence from an image render.

### Reuse the existing visual-memory owner

Vesper already separates what an observer noticed from what the narrator
mentioned. This plan extends eligible sources and selection policy; it does not
create a second appearance-memory system.

Hidden features are not forgotten. Familiar features may support recognition
without narration. A changed fingerprint becomes a change candidate rather than
silently rewriting remembered truth.

### Derived effects remain derived

Damp strands clumping, water beading on leather, fabric creasing, or a wet hem
hanging heavily may project for the current cut. They are not persisted as
independent truth unless an owner records a lasting tear, stain, tangle,
displacement, or similar change.

### Retakes restore the entire visual moment

Projection and attention are pure over a committed cut. Character chat derives
from restored state, scenario, wardrobe, perception, and observer memory.
Successor chats derive from the restored branch cut. Later state and later
knowledge cannot leak backward.

### Missing owners mean silence

If Vesper cannot answer whether a surface is exposed, whether two regions touch,
whether a garment is fitted, or whether a character is trembling, that feature
is unavailable. Unknown is neither false nor permission to invent a plausible
effect.

## Scope

This plan owns:

- the lane-neutral `VisualStateFeature` contract and kind registry;
- adapters from existing authoritative sources;
- typed composition across identity, presentation, current state, body
  language, and occlusion;
- observer/camera visibility;
- visual-attention ranking and consumer-specific selection;
- narrator, image, and inspector digests from one snapshot;
- compatibility with recognizable-feature projection and visual memory;
- an offline, review-first reference-image extraction workflow;
- diagnostics, trials, rollout, and eventual removal of duplicate summaries.

It does not become a second wardrobe, body, anatomy, pose, environment, memory,
or image database. It does not infer emotion from posture, run a full physics or
animation simulator, decide that an action occurred, call vision every turn,
overwrite authored data from an image, bypass intimate-region gates, or replace
model-specific image controls.

Sound, scent, touch, voice, footsteps, perfume, and fabric noise are valuable
parallel affordances, but generalizing this into a full perception engine is not
part of the first release. The technical contract leaves a channel seam for a
future plan.

## First-release source map

Stable identity begins with canonical attributes, located appearance facts,
realized anatomy, and recognizable-feature priors.

Presentation begins with the wardrobe graph and a small typed owner for
non-item deliberate choices. Jewelry, glasses, hats, coats, and carried objects
remain item-backed. Hairstyle arrangement, makeup application, nail finish, and
similar choices must not live as free text.

Current state begins with owned hair/body-surface wetness, garment presentation
and condition, active located conditions, and supported physical-affordance
results. Dirt, blood, swelling, fatigue, cosmetics wear, and other effects join
only when an authoritative owner exists.

Body language begins narrowly with facts the scene / body-relations layer can
prove. That layer shipped in the chat lane on 2026-07-31 and holds participant
posture, coarse facing and proximity, support roles and surfaces, coarse surface
height, and the reach they imply — with provenance on every fact and an explicit
refusal to source anything from narrator prose. Occupied hands and committed
gestures come from the contact lifecycle beside it. Fine joint pose and
emotion-derived microexpressions remain unavailable.

Visibility starts with current coverage and perception, then adds explicit
lighting, distance, angle, motion, frame size, and occlusion inputs rather than
burying them in prompt prose.

## Consumer behavior

### Narration

The narrator may receive a compact must-preserve block when contradiction
prevention is relevant and at most one or two visible, grounded, high-priority
current details. A change/repeat key keeps familiar steady state quiet.

The failed ambient affordance-cue trial remains a warning: more specificity is
not automatically better. Narrator use begins in shadow and must prove reduced
contradictions or clearly better grounded detail without raising repetition.

### Image generation

The image compiler receives every required identity, morphology, age,
subject-count, wardrobe, and action fact; the presentation in force; visible
current state; proved body language; and optional salient deltas that fit the
model profile.

It does not consult mention cooldowns or update observer memory. Render
provenance records the visual snapshot and selected feature keys.

### Inspector

The inspector shows source facts, projected features, composition, suppression,
visibility evidence, attention scores, memory where applicable, and final
consumer digests. It is read-only and never spends notice or mention state.

## Delivery slices

### Slice 0 — source and duplication audit

Status: reviewed 2026-08-16. Findings in
[visual-state.audit.md](visual-state.audit.md).

Inventory every appearance summary, image prompt builder, narrator appearance
block, recognition projection, wardrobe digest, body-state read, and scene
relation used by either lane. Record authoritative, derived, unavailable, and
prose-only sources. Freeze fixture scenarios and identify old summaries that
will eventually disappear.

### Slice 1 — core contract and compatibility adapter

Status: reviewed 2026-08-16. Four corrections the review raised landed inside
slice 2.

Add pure `VisualStateFeature`, source, locus, stability, layer, evidence, kind
registry, key/fingerprint helpers, deterministic snapshot ordering, parsing,
and diagnostics. Adapt existing `ProjectedFeatureTruth` records without
renaming or breaking its frozen recognition seam.

### Slice 2 — identity and presentation

Status: built 2026-08-16 — awaiting review.

Project attributes, located facts, anatomy, species feature groups, and garment
and item loci. Add the small typed owner deliberate non-item choices never had —
how the hair is worn, whether there is makeup on, how one area is groomed, what
is on the nails, a temporary cosmetic mark — with named operations for applying,
removing, rearranging, smudging and restoring them. Add typed replacement,
modification, attachment and occlusion between all of it, so a hat can cover a
hairstyle without erasing it and a coat can sit over a shirt that is still known
to be there.

Two of those relationships are built but unused: nothing in the wardrobe tells a
hairpiece from a hat, and a derived effect needs the material reads slice 3
brings. Both are recorded as missing owners rather than guessed at.

### Slice 3 — current state

Status: queued.

Add adapters for body-surface state, garment gradients and presentation,
supported physical-affordance observations, active conditions, change stamps,
validity windows, semantic bands, and lazy time integration. Unsupported
physiology, contamination, contact, and fit remain explicit suppressions.

### Slice 4 — body language and visibility

Status: queued.

Consume the shipped scene / body-relations owner for posture, support,
orientation, hand occupation, gaze, and committed motion. Add observer/camera
lighting, distance, angle, motion, frame-size, exposure, and occlusion reads.
Include non-human and altered-anatomy fixtures before enabling image use.

### Slice 5 — attention and memory integration

Status: queued.

Reuse existing fixed-point salience and visual-memory laws. Add change
significance, action relevance, and consumer relevance without rewriting stored
uniqueness or importance. Produce separate narrator and image selections with
strict budgets and preserved observer isolation.

### Slice 6 — shadow adapters and inspector

Status: queued.

Run the new snapshot and selections beside current inputs in character chat and
successor chat without changing prompts, images, state, or memory. Add the
inspector and measure missing-owner frequency, duplicate facts, and disagreement
with current summaries.

### Slice 7 — narrator proving release

Status: queued.

Behind a default-off flag, feed only change-gated, action-relevant, or newly
revealed selections into narration. Keep binding constraints separate from
optional positive detail. Run a paired trial over contradiction, repetition,
grounded specificity, naturalness, and hidden-detail leakage.

### Slice 8 — image digest and render-intent seam

Status: queued.

The shared render intent it feeds is live (capabilities slice 2, 2026-08-07).
Produce the required and optional image digest, its camera-relative selection,
and the provenance inputs character-bearing image routes need. The
[image lane consolidation plan](image-lane-consolidation.plan.md) owns cutting
those routes over, deleting their old builders, and running the combined
human/non-human, altered-anatomy, realistic, and stylized acceptance matrix.

### Slice 9 — reference-image compiler

Status: queued.

Allow canonical images to propose structured identity and presentation facts
offline. Store source hash, extractor version, confidence, and diffs. Require
review before accepted facts reach canonical owners, and preserve manual edits
when a better extractor is run later.

### Slice 10 — narrator consolidation and successor parity

Status: queued.

Remove duplicate narrator appearance summaries only after their consumers use
the shared snapshot. Complete successor capture parity, update live docs, and
record unsupported sensory or advanced-pose work as named follow-ups. Image
prompt and image-lane deletion belong to
[image lane consolidation](image-lane-consolidation.plan.md).

## Trial matrix

The fixed matrix must cover an ordinary sparse human, a heavily authored human,
altered or prosthetic anatomy, a non-human with intentional appendage count,
realistic and stylized presentation, bright close range, dim distance,
silhouette, occlusion, motion, wet hair, a rolled sleeve, smudged makeup, a
garment left in the scene, a body-language change, a newly revealed feature, a
familiar feature, a changed familiar feature, retakes, and branch forks.

Every trial stores source state, projected features, suppression reasons, final
selection, consumer input, output, latency, and owner verdict.

## Success criteria

- The same committed truth produces byte-equal keys, fingerprints, and ordering.
- No visual feature becomes an independent authority for another system's fact.
- Identity, presentation, current state, and body language remain distinct.
- Hidden, distant, occluded, gated, or unknown features never leak into
  narrator selections.
- Observer memory stays isolated and notice remains separate from mention.
- Image generation cannot drop mandatory identity or morphology for salience.
- Narration stays within its cue cap and does not repeatedly reintroduce
  unchanged familiar traits.
- Retakes and forks cannot read later state or knowledge.
- Reference extraction cannot overwrite canonical truth without review.
- Unsupported owners produce diagnostics and conservative silence.
- Shadow mode leaves production behavior byte-identical.

## Open questions

No owner ruling blocks slices 0–5. These values should be calibrated by fixtures
and trials rather than guessed:

- the first-release kind catalog beyond already owned appearance, garment, and
  wetness facts;
- narrator and image optional-detail caps by task/profile;
- lighting, distance, motion, and pixel-size thresholds for detail tiers;
- whether a later perceptual-state plan should generalize the machinery to
  sound, scent, and touch.

Any new owner question discovered during design or implementation must be
restated here before work proceeds.
