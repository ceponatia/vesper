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

    skin-surface/
    garment/
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
