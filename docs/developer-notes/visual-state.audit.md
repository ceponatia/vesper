# Visual state — source and duplication audit

Status: reference (audit run 2026-08-16)

A snapshot of the code as it stood on the date above. It records findings; it
does not plan the fixes. Consolidation is owned by slice 10 of
[visual-state.plan.md](visual-state.plan.md); anything outside that plan's scope
is named as such at the end of its finding.

## Scope

Examined, across **both lanes** (legacy character chat and successor chats):

- every producer of a character appearance summary, in any output form;
- every image prompt builder and prompt mutator, in the app and in
  `@vesper/image-core`;
- the narrator appearance blocks in the chat prompt;
- the recognition projection, its salience law, and observer visual memory;
- the wardrobe/garment digest stack;
- body-state reads: surface wetness, active conditions, anatomy realization,
  physical-affordance observations;
- the scene / body-relations reads: posture, facing, proximity, support, reach,
  contact lifecycle.

Deliberately out of scope: the authoring/forge lane's own prompts beyond naming
them, meter and mood projection except where they stand in for a visual fact,
memory retrieval, and anything that reads appearance only to render a UI badge.

Every symbol below was located by search and read; nothing is inferred from
naming.

## Method

Four independent sweeps over `apps/web/src`, `packages/`, and `scripts/`, each
required to report `file:symbol`, the inputs it reads, the shape it emits, its
call sites, and its lane. Findings were then cross-checked against each other:
a producer named by one sweep and not the others was re-searched before being
recorded. Classification uses four buckets, applied to the FACT a symbol
carries, not to the symbol:

- **authoritative** — an owner contract or table is the source of truth;
- **derived** — computed from an authoritative owner, never stored as truth;
- **prose-only** — the value is free text (authored, or written by a model);
- **unavailable** — the app cannot answer the question at all today.

## Findings

### 1. Twenty-five distinct appearance-summary producers, and no shared read

- **What** — twenty-five symbols independently turn character truth into an
  appearance description; twenty-three have live callers and two are already
  dead. Six of them emit a complete description of a character; the rest emit a
  fragment (age, identity anchors, viewer body, species phrase, wardrobe).
  Grouped by lane:

  **Image lane** (`apps/web/src/server/images/`) — ten:
  - `prompts-appearance.ts:characterAppearanceSummary` — derived from resolved
    attributes + `realizeBody`; `"Label: value; …"`, 200 chars.
  - `prompts-appearance.ts:identityAnchorSummary` — same inputs through an
    eleven-id whitelist; 180 chars.
  - `prompts-appearance.ts:apparentAgeAnchor` — one sentence, from
    `identity.apparent_age` + `identity.gender` + `skin.texture`.
  - `prompts-appearance.ts:imageAgeWord` — a single age word for the avatar
    subject line.
  - `prompts-appearance.ts:viewerBodyAppearance` — the player persona's body,
    intersected with the parts in frame.
  - `prompts-appearance.ts:sceneRevealAppearance` — attributes gated by region
    exposure, with an `{intimate}` split.
  - `prompts-appearance.ts:intimateSceneAppearance` — **no live caller**;
    superseded by `sceneRevealAppearance`.
  - `prompts-avatar.ts:buildAvatarPrompt` — the whole avatar prompt, with its
    own appearance clause grouping.
  - `prompts-scene-render.ts:buildSceneRenderPrompt` — the single-reference
    scene assembly.
  - `prompts-scene-render.ts:assembleMulti` — the multi-reference assembly,
    with different wording for the same five inputs.

  **Legacy narrator prompt** (`apps/web/src/server/engine/prompts/character-chat.ts`)
  — six: the inline Attributes block with `attributePhrase`; `sensoryCues` +
  `buildSensorySection`; `buildTransientAppearanceSection`;
  `ensembleAttributeLines` + `ensembleMemberSheet`; the transient half of
  `ensembleMemberEnactment`; and `buildSensoryFocusSection`.

  **Legacy derived cues** — three: `chat-affordance-cues.ts:renderChatAffordanceCues`
  (a closed experiment, flag parked off permanently),
  `chat-recognition-adapter.ts:renderChatRecognitionCue` (flag
  `CHAT_RECOGNITION_CUES`, default off), and
  `chat-physical-guidance-render.ts:renderChatPhysicalGuidance` (live in
  production, and constraint-first — it emits prohibitions, not description).

  **Lane-neutral** — one: `contracts/appearance-features/projection.ts:projectAppearanceTruth`,
  the only structured producer in the list. It emits `ProjectedFeatureTruth[]`
  and no prose.

  **Authoring** — three: `character-fill.ts:renderSheetLines`,
  `portrait-attributes.ts:portraitPrompt`, `character-forge.ts:speciesForgeDescriptor`.

  **Species phrases** — one family: `contracts/species/registry.ts` —
  `speciesLabelPhrase`, `speciesLorePhrase`, and `speciesAppearancePhrase`,
  which has **no live consumer**.

  **Successor lane** — one: `prompts/sim-render.ts:buildTruthBlock`, whose
  `VISIBLE ON THE BODY` lines come from
  `engine/simulation/body-reads.ts:deriveVisibleBodySigns`.

- **Impact** — a change to how one appearance fact is worded reaches the player
  through one route and not the others. The lanes have already drifted: the
  successor's `buildCanonBlock` deliberately never reads `profile.attributes`
  at all, so a successor chat's narrator has no attribute-derived appearance
  description, while legacy chat has three overlapping ones.
- **Where it goes** — slice 10 of the visual-state plan. The two dead symbols
  (`intimateSceneAppearance`, `speciesAppearancePhrase`) need no plan; they are
  deletions, and `dead-export-sweep.plan.md` already owns that class of work.

### 2. Worst duplication: the `label: value` renderer and its five-step guard

- **What** — two independent implementations of one output shape over one
  registry: `server/images/prompts-format.ts:formatAttribute` and
  `server/engine/prompts/character-chat.ts:attributePhrase`, each with its own
  `humanize`. Around them, the same five-step guard chain — skip
  `identity.apparent_age`, skip an unknown definition, skip
  `excludeFromPrompts`, skip what `realizedBody.isAttributeApplicable` rejects,
  then apply an intimacy gate — is re-typed at **seven** loop sites
  (`prompts-appearance.ts` ×5, `prompts-avatar.ts`, `character-chat.ts` ×4).
- **Impact** — the copies already disagree on the last step. The chat loops gate
  on `def.kind === "sensory" && isIntimateAttributeCategory(...)`; the image
  loops gate on `isNonVisualAttribute(def)`. Those are different predicates over
  the same field, so the same character can be described differently by the
  narrator and by the image prompt for reasons no one chose. A new registry flag
  has to be added in seven places to take effect everywhere.
- **Where it goes** — slice 10.

### 3. Second-worst: one condition-overlay block implemented twice inside one file

- **What** — `character-chat.ts:buildTransientAppearanceSection` and the second
  half of `character-chat.ts:ensembleMemberEnactment` are the same algorithm
  (`conditionAttributeOverlays` → `resolveAttributes` → diff against the stable
  resolve → bullets), differing only in second- versus third-person heading text.
  The disinhibition block (`buildDisinhibitionSection` versus the first half of
  `ensembleMemberEnactment`) is duplicated the same way, as is the base
  attribute loop.
- **Impact** — the solo speaker and an ensemble member get their transient
  appearance from two code paths that must be edited together and are not
  adjacent.
- **Where it goes** — slice 10.

### 4. Third: the same five appearance strings, assembled by two scene builders

- **What** — `prompts-scene-render.ts:buildSceneRenderPrompt` and
  `prompts-scene-render.ts:assembleMulti` each independently emit `ageAnchor`,
  `identityAnchors`, `appearance`, `lowerBody` and `intimateAppearance`, with
  different phrasing, ordering and budgets ("Same person as the reference
  image — these features confirm it…" versus "matching the reference: …";
  "Body (below the portrait's framing): …" versus "figure: …").
- **Impact** — a reworded identity anchor must be changed in both, and a scene
  reads differently depending on how many references it happens to carry.
- **Where it goes** — slice 8 feeds both through one digest; slice 10 removes
  the loser.

### 5. Image lane: 11 base prompt builders, 5 mutators, 20 segment producers

- **What** — thirty-seven prompt-producing symbols. Everything funnels through
  one compile step, `packages/image-core/src/render-kernel/compile-profile-plan.ts:compileProfileRenderPlan`,
  which applies prompt-strategy dispatch, LoRA additions and the model-dialect
  rewrite to whatever base prompt a lane handed it. Upstream of it:
  - eight base builders in `apps/web/src/server/images/` (avatar, scene render,
    variant instruction, chat look, chat place, item, location, staged scene);
  - three in `packages/image-core/` (two image-lab instruction builders and the
    identity-pack trial fixtures, none of which read character facts);
  - three image-lab kinds with no builder at all — the base prompt is the
    admin's `instruction` string verbatim;
  - one text-model builder, `prompts-scene-composer.ts:buildSceneComposerPrompt`,
    which produces the plan the image prompt is then built from.
- **Impact** — this is the surface slice 8 must feed without forking again. The
  count matters less than the shape: character facts enter the image lane at
  eight independent points, and only one of them (the scene lane, through
  `describeCommittedFacts`) reads a committed structured owner.
- **Where it goes** — slice 8.

### 6. Duplicated facts inside the image lane

Six cases, all verified:

- **Apparent age** — three renderers and four separate
  `if (value.id === "identity.apparent_age") continue;` skips. Worse,
  `apparentAgeAnchor` is called from three sites with **different attribute
  inputs**: `character-scene.ts` passes condition overlays, while `variants.ts`
  and `chat-reference-images.ts` pass none. The same character can get a
  different age sentence depending on which route asked.
- **Skin, hair, eyes, lips, face** — three renderings from one
  `resolveAttributes` call: the avatar's grouped clauses,
  `characterAppearanceSummary`, and `identityAnchorSummary`. In a
  multi-character scene, an anchored character gets the anchor form and a
  textual character gets the summary form.
- **Wardrobe** — four paths, two of which are concatenated into one field:
  `visibleAvatarOutfit`, `wardrobeOutfitSummary` (called twice per scene
  render), `resolveChatWardrobe.garments`, and `garmentSceneNotes`. The scene
  queue joins the last two with `"; "`, so one garment's state can be described
  twice in the same `Wearing:` clause.
- **Exposure** — recomputed four times from different inputs, then rendered
  twice per scene.
- **The identity-lock sentence** — byte-identical string literals in
  `apps/web/src/server/images/prompts-variant.ts` and
  `packages/image-core/src/models/quality-presets.ts`, coupled only by an
  exact-match `replaceAll`. Editing one silently stops the Qwen adaptation from
  matching.
- **The cast-integrity sentence** — near-identical in
  `prompts-scene-render.ts` and
  `packages/image-core/src/references/reference-role-prompt.ts`, with two
  different reference-numbering conventions. They do not stack today only
  because every seeded scene profile uses `instruction_edit`; a profile flipped
  to `multi_reference_compose` would emit both.

**Where it goes** — slices 8 and 10. The identity-lock literal is a
cross-workspace coupling that no visual-state slice touches; it belongs in
`image-render-quality.plan.md`.

### 7. The one structured producer, and the seam it must not break

- **What** — `contracts/appearance-features/projection.ts` is the only
  appearance producer that emits records instead of prose. It carries an
  explicit **FROZEN SEAM** marker, as does `appearance-features/locus.ts`:
  the names and shapes are the interface `contracts/affordances/recognition/`
  consumes. `ProjectedFeatureTruth` has one real downstream consumer,
  `recognition/candidates.ts`, which reads seven of its eight fields and
  decomposes the eighth (`priors`) into four.
- **Impact** — two properties are load-bearing beyond the type. Feature keys
  (`<subject>/<locusKey>/<aspect>`) index observer visual memory rows in live
  conversations, and `truthFingerprint` is compared against stored fingerprints
  to detect change. Either one moving is a silent failure: nothing throws, the
  rows simply stop matching.
- **Where it goes** — no action. Slice 1 adapts it and preserves both, by
  construction and by test.

### 8. Recognition and visual memory are complete and default-off

- **What** — the observer half is fully built: `recognition/candidates.ts`
  (observer-relative gating, nine suppression codes), `recognition/salience.ts`
  (the fixed-point law `visibility × (0.55 × uniqueness + 0.45 × importance)`,
  then `× max(novelty, changeSignificance, actionRelevance) × repetitionCooldown`),
  `recognition/visual-memory.ts` (`VisualMemoryState`, a 96-row cap with
  coldest-first eviction, notice separated from mention, a recognition floor for
  inherent and persistent features only), and `recognition/mention-policy.ts`.
  Storage is `chat_visual_memory`, read and written only by
  `server/engine/visual-memory-store.ts`, whose two-generation column trick
  (`features` / `features_before`, keyed by `applied_message_id`) is what makes
  a retake stop double-counting a notice.
- **Impact** — the machinery slices 5 and 7 need already exists and is already
  calibrated. It reaches no player: `chatRecognitionCuesEnabled()` reads
  `CHAT_RECOGNITION_CUES === "on"` and is off, so no read is taken and no row is
  written.
- **Where it goes** — no action. Slice 5 extends this owner rather than
  replacing it.

### 9. Determinism primitives: no hash anywhere in the appearance path

- **What** — the whole appearance and recognition path uses exactly one shared
  primitive, `scaleFixedPoint` from `@/lib/fixed-point` (a re-export barrel over
  `@vesper/contracts`). Fingerprint determinism comes from
  `appearanceCanonicalFingerprint`, which is canonical sorted-key JSON, not a
  hash. Ordering determinism comes from explicit `<` / `>` comparators, never
  `localeCompare`.
- **Impact** — a projection contract that assumed a hashed fingerprint would
  produce values that never match a stored one. The repository's one string hash
  (`fnv1aHex`, FNV-1a) exists and is golden-pinned, but it is a cache-key and
  digest tool here, not the fingerprint form.
- **Where it goes** — no action. Recorded because it is the single easiest
  mistake to make when writing against this seam.

### 10. The garment stack is complete and gated off

- **What** — wardrobe is the best-developed visual owner in the app.
  Authoritative: `contracts/items/garment-instance.ts` (instance identity,
  `locus` including a `scene` anchor for a garment left on a chair, deposits,
  damage), `garment-blueprint.ts` (part graph, snapshotted at mint),
  `garment-presentation.ts` (closure, roll, tuck, displacement),
  `garment-condition.ts` (wetness, cleanliness, crease, wear, with lazy
  half-life drying), `garment-material.ts`, `garment-store.ts` (the reducer,
  including `garmentsAtScenePlace`). Derived: `garment-coverage.ts`,
  `garment-effective-coverage.ts:garmentReadout` (the canonical per-garment
  read), `effective-coverage-read.ts`, `visibility.ts`, `garment-handles.ts`.
  Digest and attention: `garment-digest.ts` (`garmentStructuralFacts`,
  `garmentDigestEntry`, `buildGarmentDigest`, `renderGarmentDigest`,
  `garmentLookFingerprint`) and `garment-observation.ts` (`garmentObservations`,
  `splitGarmentCues`, `garmentSceneNotes`). One server read seam:
  `server/engine/chat-garments.ts:buildChatGarmentNarration`.
- **Impact** — everything slices 2 and 3 need for clothing exists, already
  perception-gated and already fingerprinted. It is invisible to players:
  the narrator digest and the scene notes are both behind `CHAT_GARMENT_CUES`,
  default off. Only the look-identity key is ungated.
- **Where it goes** — slices 2 and 3 consume it. No fix needed.

### 11. Body-state owners exist unevenly, and one is written but never read

- **What**, by owner:
  - `contracts/state/body-surface.ts` — **authoritative** body-surface wetness
    across 32 body locations, fixed-point, with lazy drying. The only production
    reader is `chat-affordances.ts`, and it reads the hair location only.
  - `contracts/state/chat-environment.ts` — **authoritative** wind,
    precipitation and indoors, which gate drying.
  - `contracts/conditions/condition.ts` — **authoritative but untyped**: an
    active condition carries a free-text `label`, a severity, an expiry and
    attribute effects. It has no body locus, so a condition cannot be placed.
  - `contracts/appearance-features/anatomy-state.ts` — **authoritative**
    topology, event-sourced, four states: `present`, `absent`, `altered`,
    `prosthetic`. There is no `extra`.
  - `contracts/species/realize.ts` + `contracts/body/locations/features.ts` —
    **authoritative** additive feature groups (`wings`, `horns`, `tail`), static
    per character. This is where "extra parts" actually lives.
  - `contracts/affordances/core/types.ts` — **derived** physical-affordance
    observations, with the `supported` / `unavailable` / `invalid` distinction
    the whole audit rests on. Only two domains are registered (`hair`,
    `garment`); the `domains/foot/**` tree is on disk and unreachable.
  - `contracts/meters/registry.ts` — **prose-only** as a visual fact: the
    `energy` meter's prompt hint is the app's entire representation of visible
    fatigue.
- **Impact** — two split owners will surprise a later slice. "Extra anatomy"
  is species/heritage data, not evented anatomy state, so a character cannot
  gain or lose an extra limb. Body-surface wetness is owned and written for the
  whole body but spent for hair alone.
- **Where it goes** — slice 3 consumes what exists and suppresses the rest.
  The `foot` domain being unregistered is pre-existing and outside this plan.

### 12. Scene relations reach the camera and the action validator, never the narrator

- **What** — `contracts/affordances/scene/` is **authoritative** and complete
  for its vocabulary: five postures, three facings, four proximity bands, six
  height rungs, five body zones, four support roles, with `SceneProvenance` on
  every fact and no `unknown` member (absence means unresolved).
  `scene/relations.ts` derives reach and support. `scene/intents.ts` is the only
  writer. State persists on `character_chats.scene`. Consumers:
  `chat-contact-adapter.ts` (action validation), the NPC movement trio,
  `contracts/images/scene-committed.ts` (camera, orientation and distance, plus
  a plain-English composer context), and `chat-permission-events.ts`.
- **Impact** — the narrator prompt reads **none** of it: no posture, facing,
  proximity, support or reach line exists in `character-chat.ts` or any sibling.
  No UI component reads `SceneState` either. Slice 4's body-language layer is
  therefore additive for narration rather than a migration.
- **Where it goes** — slice 4. One inert seam noted in passing:
  `contracts/images/scene-staging.ts:sceneStagingContactEvidence` is an empty
  array, so committed contact can never substitute for a narration quote in
  staging selection. It is documented as intentional and is
  `scene-composition`'s business, not this plan's.

### 13. Occupied hands has no owner

- **What** — no `occupiedHands`, `handsFree` or equivalent symbol exists. The
  two partial substitutes are `SceneSupportRelation.loadZones` — whose own
  comment frames it as making "that hand is not free to act" answerable without
  a joint model, but whose zone is `arms`, not a hand — and per-surface-pair
  occupancy inside `commitContactResolution`.
- **Impact** — the plan's first-release source map lists occupied hands as
  coming from the contact lifecycle. It can be derived from active contacts, but
  there is nothing to read today.
- **Where it goes** — slice 4, which must derive it or declare it unavailable.

### 14. Visual facts with no owner today

Verified by search, not assumed. `unavailable` here means the app cannot answer
the question at all; `prose-only` means a value exists but is free text.

| Visual fact             | Verdict      | Nearest thing that exists              |
| ----------------------- | ------------ | -------------------------------------- |
| Dirt on skin            | unavailable  | garment deposits (`mud`, `dust`)       |
| Blood on skin           | unavailable  | garment deposit `blood`                |
| Swelling                | unavailable  | authored static attributes only        |
| Cosmetics wear          | unavailable  | garment deposit `cosmetic`             |
| Fine joint pose         | unavailable  | five coarse postures, by design        |
| Scene occlusion         | unavailable  | garment-layer occlusion only           |
| Occupied hands          | unavailable  | support `loadZones`, zoned to arms     |
| Extra limb as an event  | unavailable  | static species feature groups          |
| Visible fatigue         | prose-only   | the `energy` meter's prompt hint       |
| Microexpression         | prose-only   | one mood label plus an intensity       |
| Lighting                | prose-only   | a composer-written `lighting` string   |
| Camera distance         | derived      | proximity → shot distance              |
| Camera angle and height | derived      | facing and postures → orientation      |

- **Impact** — nine of thirteen rows are unavailable. The plan's ruling that
  missing owners mean silence is not a rare edge case; it is the common case for
  current-state facts, and slices 3 and 4 will spend more code suppressing than
  projecting.
- **Where it goes** — slices 3 and 4 record each as an explicit suppression. New
  owners are not this plan's scope.

## Frozen fixture scenarios

The scenarios later slices are tested against. Each names what already exists,
so a slice adds assertions rather than inventing a body.

**Pure fixtures**, built on `contracts/appearance-features/fixtures.ts` (which
the recognition tests already share, so both halves are judged against one body):

- **VS-1 sparse human** — `crookedNoseAttributes()` alone. The ordinary case:
  attributes, no marks, no topology.
- **VS-2 authored human** — `crookedNoseAttributes()` + `freckleClusterFact()` +
  `birthmarkFact()` + `scarFact()`. Covers the coarse-locus fallback and event
  provenance.
- **VS-3 altered anatomy** — `missingFingerState()`. The fine-locus topology
  case, and the one that must survive an image render unchanged.
- **VS-4 prosthetic** — `missingFingerState()` re-stated with
  `state: "prosthetic"` and an alteration kind.
- **VS-5 non-human** — a species/heritage with a `wings`, `horns` or `tail`
  feature group through `realizeBody`. This is the intentional-appendage case,
  and it is NOT anatomy state (finding 11).
- **VS-6 garment presentation** — a blueprint with a rolled cuff, an open
  closure and an off-shoulder displacement, through
  `garmentReadout`.
- **VS-7 garment condition** — wetness at `wet`, one deposit, one damage mark,
  read at two story times so lazy drying is exercised.
- **VS-8 garment left in the scene** — a garment whose locus is
  `{ kind: "scene", anchor: … }`, via `garmentsAtScenePlace`.
- **VS-9 wet hair** — `BodySurfaceState` at the hair location, with and without
  the environment suspending drying.
- **VS-10 scene relations** — two participants with posture, facing, proximity
  and a support relation, all carrying provenance.
- **VS-11 retake** — one committed cut projected twice, and the same cut after a
  later cut exists. Later state must not appear in the earlier projection.
- **VS-12 branch fork** — the successor equivalent of VS-11, across two branch
  versions.

**Live fixtures** on the QA account (`uxtest-main@vesper.local`): the _Sabrina
Vale_ character, her canonical portrait, her full-body pose variant, and the
three reviewed Advanced-Image-Lab control fixtures. Any end-to-end check of a
narrator or image digest uses an existing conversation on that account.

## Summaries expected to disappear at consolidation

Named here so slice 10 has a checklist, not a search. None of these is removed
before its consumers read the shared snapshot.

- `server/images/prompts-appearance.ts` — `characterAppearanceSummary`,
  `identityAnchorSummary`, `sceneRevealAppearance`, `viewerBodyAppearance`,
  `apparentAgeAnchor`, `imageAgeWord`.
- `server/images/prompts-avatar.ts` — the appearance and wearing slots of
  `buildAvatarPrompt`, plus `visibleAvatarOutfit`.
- `server/images/prompts-scene-render.ts` — one of `buildSceneRenderPrompt` /
  `assembleMulti`, once both read one digest.
- `server/engine/prompts/character-chat.ts` — the inline Attributes block and
  `attributePhrase`, `buildTransientAppearanceSection`, `ensembleAttributeLines`,
  the transient half of `ensembleMemberEnactment`, and the attribute lines
  inside `buildSensoryFocusSection`.
- `server/engine/chat-affordance-cues.ts:renderChatAffordanceCues` — a closed
  experiment retained as an eval harness; it survives consolidation only if the
  harness is still wanted.

Two are already dead and are deletions rather than consolidation:
`server/images/prompts-appearance.ts:intimateSceneAppearance` and
`contracts/species/registry.ts:speciesAppearancePhrase`.

## Nothing found

- **No second recognition or visual-memory system.** One projection, one
  salience law, one memory owner, one store.
- **No prose parsed as current visual truth.** The one classifier that reads
  narration, `contracts/items/outfit-change-evidence.ts:classifyOutfitChangeQuote`,
  returns a verdict for a reducer rather than writing a fact.
- **No appearance summary in the successor lane's canon block.**
  `sim-render.ts:buildCanonBlock` never touches `profile.attributes`, so there
  is no successor-side duplicate of the legacy attribute block to consolidate.
- **No competing scope vocabulary.** `VisualMemoryScopeRef` (`chat` memory group
  / `world_branch`) is the only continuity scope in this area.
- **No floating-point drift in the shared math.** Every quantity on this path is
  fixed-point integer through one kernel.
- **No cycles between the appearance, affordance and recognition layers.** The
  import direction stated in each barrel holds in the code.
