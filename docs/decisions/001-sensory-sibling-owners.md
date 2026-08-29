# 001. Touch, smell, and taste are sibling presentation owners, never one sensory system

Date: 2026-08-22

## Decision

Each sense keeps its own observation contract under one shared presentation
architecture. A routing envelope may carry a sensory channel, but
modality-specific observation contracts are never collapsed into one generic
cross-sensory type, and the shared `AffordanceObservation` gains no channel
discriminant. Visual state stays explicitly visual; the nonvisual owners under
`apps/web/src/contracts/sensory/` are siblings beside it.

## Context

Contact spans several senses, and its phenomenon seam tags every candidate
with the channel it could be perceived through. The shared affordance
observation contract was channel-neutral only because every producer so far
was visual, so the first multi-sense producer forced the question: widen the
shared contract with a channel field, or build per-sense contracts. At the
same time, visual state already owned attention, repetition, memory, and
selection, which made "reuse visual state for everything" the path of least
resistance.

## Alternatives considered

- **One generic cross-sensory observation type with a channel field** — one
  adapter, one selection, no new contracts; every existing visual consumer
  would have kept working with a filter.
- **Generalize visual state into an all-senses presentation owner** — its
  attention/memory/selection machinery already exists and is proven.
- **Contact-local sensory presentation** — contact produces the first
  nonvisual phenomena, so the shortest path was a cue block inside contact.

## Why this choice

The senses share broad presentation laws — observer identity, fail-closed
access, repeat families, bounded budgets, no prose before selection — but
their access rules are physically different: touch requires participation in
the committed contact, smell requires a real source and a range answer, taste
requires committed oral contact. One generic type forces those laws to meet in
conditional code keyed on a channel field, where a forgotten branch silently
grants one sense another sense's access. Distinct contracts make the wall a
compile-time fact: a tactile value cannot reach the visual adapter or the
olfactory owner at all. What is genuinely shared lives once, as the generic
staging in `contracts/sensory/presentation.ts`, so the choice trades a small
amount of per-sense declaration for structural leak-proofing. Contact-local
presentation was rejected because the owners must serve every producer domain,
not copy themselves per producer.

## Consequences

- Any future change to the shared affordance observation contract must be
  designed across domains; contact alone never justifies widening it.
- A new sense (auditory next) is a new sibling module with its own contract
  and access law, not a new enum member on an existing type.
- Producers adapt into the sense contracts at their own routing seams; the
  sensory package imports no producer.
- The cost is deliberate duplication of contract shape across senses; the
  type-pin tests in `contracts/sensory/presentation.test.ts` and
  `contracts/affordances/contact/phenomena.test.ts` are the guard that the
  duplication never quietly collapses back into assignability.
