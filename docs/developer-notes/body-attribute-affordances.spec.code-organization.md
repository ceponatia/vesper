# Body-attribute affordances — code organization

Status: **implemented** — technical companion to
[body-attribute-affordances.spec.architecture.md](body-attribute-affordances.spec.architecture.md).
The tree below was built as proposed for the domains that shipped; §"Shipped
file map" records what exists.

`src/contracts/affordances/` has since grown four siblings that this plan does
not own — `contact/`, `scene/`, `permission/`, `guidance/`, and
`domains/foot/`, all from the
[romantic-contact](romantic-contact-affordances.plan.md) and
[narrator-guidance](narrator-physical-guidance.plan.md) plans. They obey the
same import direction and the same core; each is specified by its own plan.

## Proposed tree

Co-locate each domain so its vocabulary mapping, reusable calculations,
phenomena, fixtures, and registration are reviewed together:

```text
src/contracts/affordances/
  core/
    types.ts
    fixed-point.ts
    evidence.ts
    perception.ts
    ranking.ts
    registry.ts
    index.ts

  domains/
    hair/
      attribute-maps/
        length.ts
        density.ts
        strand-thickness.ts
        texture.ts
        condition.ts
        index.ts
      profile.ts
      mechanics.ts
      frame.ts
      phenomena/
        wet-clumping.ts
        wind-motion.ts
        skin-adhesion.ts
        droplet-shedding.ts
        index.ts
      domain.ts
      fixtures.ts
      hair.test.ts

    garment/
      profile.ts
      mechanics.ts
      frame.ts
      effective-coverage.ts
      phenomena/
        bands.ts
        shared.ts
        tags.ts
        wet-surface-state.ts
        wet-cling.ts
        effective-opacity.ts
        index.ts
      domain.ts
      fixtures.ts
      index.ts
      mechanics.test.ts
      garment.test.ts

    skin-surface/
    appendages/
    soft-tissue/
    relative-geometry/

  recognition/
    candidates.ts
    salience.ts
    visual-memory.ts
    mention-policy.ts

  domains.ts
  derive-affordance-read.ts
  index.ts
```

The exact filenames may change during implementation. The ownership and
dependency direction may not.

## Shipped file map (slices 2–7)

### Pure contracts

- `src/contracts/affordances/core/*` — the staged types, unit algebra,
  evidence, perception, ranking, registry. Names no domain —
  `core/domain-neutrality.test.ts` asserts it over the source.
- `src/contracts/affordances/domains/hair/*` — the first proving domain
  (slices 2–3). Structure from canonical attributes.
- `src/contracts/affordances/domains/garment/*` — the second proving domain
  (slice 6). Structure from wardrobe truth.
- `src/contracts/items/effective-coverage-read.ts` — the final
  `EffectiveCoverageRead` vocabulary + persisted shape. **Owned by items**,
  derived by the garment domain — items never import affordances.

### Recognition (slice 7)

Body truth first, observer-relative second — the §Recognition ownership tree
below, as built.

- `src/contracts/appearance-features/locus.ts` — `BodyLocusRef` + the finite
  detail-schema registry (`humanoid_hand_v1`, left/right named digits);
  fail-closed topology validation, coarsen-with-diagnostic for appearance-only
  reads.
- `src/contracts/appearance-features/priors.ts` — detail tiers + authored
  recognition priors, as a **leaf**: the kind registry and the attribute
  catalog both need it while `projection.ts` consumes both. Re-exported
  verbatim by `projection.ts`, so the frozen seam's names are unchanged
  (`pnpm lint:cycles`).
- `src/contracts/appearance-features/definitions.ts` · `kinds.ts` ·
  `registry.ts` — the feature-kind contract and its seeded registry (freckle
  cluster, birthmark, mole, scar).
- `src/contracts/appearance-features/facts.ts` · `anatomy-state.ts` — located
  appearance facts (validity windows + supersedence) and evented
  `AnatomyPartState`.
- `src/contracts/appearance-features/attribute-recognition.ts` — which
  canonical attributes are recognition-worthy, their eligible values, priors,
  and body-area path. Colocated catalog, not fields on `AttributeDefinition`.
- `src/contracts/appearance-features/projection.ts` — `projectAppearanceTruth`
  → lane-neutral `ProjectedFeatureTruth` with canonical fingerprints. Never
  salience, never observer state.
- `src/contracts/affordances/recognition/candidates.ts` —
  `buildRecognitionCandidates`: the hard exposure/channel/tier/intimacy gates,
  then observer-relative visibility, uniqueness, importance, and `detailTier`.
- `src/contracts/affordances/recognition/salience.ts` — fixed-point salience,
  freshness buckets, novelty ladder, cooldown, recognition
  strength/confidence.
- `src/contracts/affordances/recognition/visual-memory.ts` —
  `VisualMemoryState` + the three transitions (notices, fingerprint adoption,
  mention), healing schemas, the 96-feature cap.
- `src/contracts/affordances/recognition/mention-policy.ts` —
  `selectRecognitionCue` (serializable selection + `mentionCommit`) and
  `commitRecognitionMention`.

`appearance-features` never imports the affordance layer; `recognition` never
imports a lane. Both barrels state the direction in their header.

The garment domain differs from hair in two ways the core absorbed without
learning a domain noun: its structure comes from the request's PAYLOAD rather
than its attributes (hence `compileProfile(request)`), and it is plural and
regional rather than singular (the architecture spec's "regional collections").

### Chat-lane adapters and consumers (`src/server/engine/`)

- `chat-affordances.ts` — THE adapter: builds the hair payload, the perception
  view, the read, and returns the coverage capture. Pure.
- `chat-garment-affordances.ts` — the garment half's wardrobe normalization:
  store + blueprint + condition + occlusion → `GarmentLanePayload`, plus the
  derived coverage read. Pure.
- `chat-affordance-cues.ts` — cue projection for both domains, and the
  `CHAT_GARMENT_CUES` dedupe boundary. Pure.
- `chat-affordance-preview.ts` — the read-only developer preview's staged view.
  Pure over an already-computed read.
- `chat-pipeline.ts` — wiring: the pre-fan-out read, the cue block,
  `previewChatAffordances`.
- `chat-state.ts` — persists the cue memory (`ChatScenario.affordanceCues`) and
  the coverage capture (`ChatGarmentStore.coverage`).
- `chat-recognition-adapter.ts` — slice 7's adapter: project → candidates →
  select → `renderChatRecognitionCue` (reason-shaped grounded lines, no second
  person, no invented emotion). Pure.
- `visual-memory-store.ts` — the only IO half of recognition: load/save over
  `chat_visual_memory`, two-generation rows keyed by the exchange's rollback
  guard.

### Persistence and tests (slice 7)

- `src/server/db/schema.ts` → `chat_visual_memory` (migration
  `drizzle/0092_careful_spectrum.sql`) — PK
  `(memory_group_id, viewpoint_id, subject_id)`; `features` /
  `features_before` / `applied_message_id`. Memory-group scoped per the owner
  ruling; cleaned up by `deleteChat`.
- `src/test/recognition-acceptance.ts` — the shared acceptance harness
  (fixtures + a one-call scenario runner) both acceptance suites drive.
- `src/contracts/affordances/recognition/recognition-acceptance.test.ts` ·
  `recognition-acceptance-safety.test.ts` — the 23 scenarios proving the
  feature spec's and the visual-memory detail's acceptance lists end to end.

### Developer preview surface

- `src/app/api/admin/chat-inspector/[chatId]/affordances/route.ts` — the
  self-scoped admin route; `/api/admin/self/chat-inspector/:id/affordances`
  re-exports it.
- `src/components/chat/chat-inspector-affordances.tsx` — the staged read-only
  panel on the memory inspector page. It does not render the slice-7
  recognition line (minor follow-up).
- `src/lib/api-inspector.ts` — the healing client schema for the preview
  payload.

## Rulings

- Organize by domain, not by global `attributes/` and `phenomena/` trees.
- Keep the generic core ignorant of hair, skin, garments, and anatomy names.
- Use explicit registry imports, never filesystem discovery.
- Keep all resolution code pure and lane-neutral.
- Keep trust-boundary parsing and persistence access in lane adapters under
  `src/server`; `src/contracts` remains pure.
- Export server modules only through their owning `index.ts` barrels.
- Chat and successor callers adapt authoritative state into the same contracts
  rather than forking calculations.
- Put reusable fixed-point math in the core only after two domains require the
  same operation.
- Keep fixture builders with the domain; cross-domain parity fixtures may live
  in a shared test-support module.

## Import direction

```text
attribute/body/item contracts
            ↓
affordance core
            ↓
domain definitions
            ↓
lane adapters under server
            ↓
prompt / presentation consumers
```

Domain definitions may import the affordance core and ordinary pure contracts.
The core cannot import a domain. Contracts cannot import server adapters or
prompt builders.

## Recognition ownership

Recognizable-feature truth belongs in ordinary appearance, anatomy, and
event-sourced state, not in an affordance-owned list:

```text
src/contracts/appearance-features/
  locus.ts
  definitions.ts
  registry.ts
  facts.ts
  anatomy-state.ts
  projection.ts

src/contracts/affordances/recognition/
  candidates.ts
  salience.ts
  visual-memory.ts
  mention-policy.ts

src/server/.../
  chat-recognition-adapter.ts
  sim-recognition-projector.ts
  visual-memory-store.ts
```

Recognition consumes normalized, lane-neutral projections. Server adapters
read authoritative state and keep each observer's memory separate.

Slice 7 built this tree as proposed, minus `sim-recognition-projector.ts`
(successor projection is deferred) and plus three leaves the shipping work
needed: `priors.ts`, `kinds.ts`, and `attribute-recognition.ts`. Exact entries
in §"Shipped file map" above.
