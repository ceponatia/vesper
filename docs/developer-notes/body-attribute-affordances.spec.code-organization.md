# Body-attribute affordances — code organization

Status: technical companion to
[body-attribute-affordances.spec.architecture.md](body-attribute-affordances.spec.architecture.md)

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

## Shipped file map (slices 2–6)

### Pure contracts

| Path | What it owns |
| --- | --- |
| `src/contracts/affordances/core/*` | The staged types, unit algebra, evidence, perception, ranking, registry. Names no domain — `core/domain-neutrality.test.ts` asserts it over the source. |
| `src/contracts/affordances/domains/hair/*` | The first proving domain (slices 2–3). Structure from canonical attributes. |
| `src/contracts/affordances/domains/garment/*` | The second proving domain (slice 6). Structure from wardrobe truth. |
| `src/contracts/items/effective-coverage-read.ts` | The final `EffectiveCoverageRead` vocabulary + persisted shape. **Owned by items**, derived by the garment domain — items never import affordances. |

The garment domain differs from hair in two ways the core absorbed without
learning a domain noun: its structure comes from the request's PAYLOAD rather
than its attributes (hence `compileProfile(request)`), and it is plural and
regional rather than singular (the architecture spec's "regional collections").

### Chat-lane adapters and consumers (`src/server/engine/`)

| Path | What it owns |
| --- | --- |
| `chat-affordances.ts` | THE adapter: builds the hair payload, the perception view, the read, and returns the coverage capture. Pure. |
| `chat-garment-affordances.ts` | The garment half's wardrobe normalization — store + blueprint + condition + occlusion → `GarmentLanePayload`, plus the derived coverage read. Pure. |
| `chat-affordance-cues.ts` | Cue projection for both domains, and the `CHAT_GARMENT_CUES` dedupe boundary. Pure. |
| `chat-affordance-preview.ts` | The read-only developer preview's staged view. Pure over an already-computed read. |
| `chat-pipeline.ts` | Wiring: the pre-fan-out read, the cue block, `previewChatAffordances`. |
| `chat-state.ts` | Persists the cue memory (`ChatScenario.affordanceCues`) and the coverage capture (`ChatGarmentStore.coverage`). |

### Developer preview surface

| Path | What it owns |
| --- | --- |
| `src/app/api/admin/chat-inspector/[chatId]/affordances/route.ts` | The self-scoped admin route (`/api/admin/self/chat-inspector/:id/affordances` re-exports it). |
| `src/components/chat/chat-inspector-affordances.tsx` | The staged read-only panel on the memory inspector page. |
| `src/lib/api-inspector.ts` | The healing client schema for the preview payload. |

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
