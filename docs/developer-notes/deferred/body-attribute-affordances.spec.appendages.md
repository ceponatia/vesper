# Affordance spec draft — morphology appendages (wings, tail, horns)

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## What this covers

Physical affordances of nonhuman appendages: what wings, a tail, or horns can
do in the current space, what constrains them, and what live state (wetness,
binding, seating) does to them. The morphology attribute categories already
exist (`wings.*`, `tail.*`, `horns.*`), and the demo cast includes a succubus
— this domain is not hypothetical.

The key boundary: this layer owns **capability and constraint**, not
behavior. It can say the tail is free, pinned under the character's seated
weight, or tucked beneath a skirt; it cannot decide that the tail *is*
swaying because she is pleased. Expressive motion is body language and stays
with the narrator/mood systems — but those systems must consult the
constraint read so a pinned tail never lashes.

## Contributing attributes

- `wings.type` (membrane / feathered / insectile / energy…), `wings.shape`,
  `wings.span`, `wings.carriage`
- `tail.type`, `tail.length`, `tail.tip`
- `horns.shape`, `horns.length`, `horns.count`

## Physical profile sketch

- Wings: `foldedBulk`, `spreadSpan`, `membraneWaterLoading` (by type —
  feathers soak, membranes shed and drip, energy wings ignore water),
  `flightCapable`.
- Tail: `reach`, `flexibility`, `massBand` (a thick demon tail vs a slim
  spade-tipped one), `prehensile` flag from type.
- Horns: `clearanceHeight`, `snagProfile` (curved horns catch on hoods and
  low branches; short nubs do not).

## Phenomena

- **clearance-and-fit** — appendage extent vs a coarse environment space band
  (open / roomy / confined / narrow). Wings cannot spread in a corridor;
  spreading them in a tavern is an *offered action with consequences*, not an
  ambient fact. Horns vs hoods, hats, low doorframes; a chair with a solid
  back forces the tail to one side. Requires a new environment input
  (`spaceBand`, coarse ceiling/passage facts) — fail closed: unknown space
  licenses no clearance claim in either direction.
- **constraint-state** — the standing read behavior systems consume: each
  appendage resolves to free / constrained (by seating, clothing, binding,
  a held object) / concealed, with suppression evidence. Consumed by the
  narrator contract the same way suppression works elsewhere: a constrained
  appendage never moves in prose.
- **wet-loading** — rain or immersion loads wings per `wings.type`: soaked
  feathers droop, ground the character (`flightCapable` suppressed), and
  shed droplets on a shake impulse (reusing the hair droplet-shedding
  pattern); membranes bead and drip quickly. Emits both the visual state and
  the capability suppression.
- **shelter-capability** — an *offered-action* affordance: a large wing can
  cover self or an adjacent character from rain or wind (asserted adjacency
  required). Acting on it is a command that changes presentation coverage;
  the affordance only surfaces the possibility.

## Worked example

Succubus with membrane wings and a long spade tail, seated in a high-backed
chair in a small room: constraint-state reads wings `constrained (chair)`,
tail `constrained (seated)`; clearance-and-fit suppresses any wing-spread
offer (`spaceBand: confined`). She stands by the open door: wings become
free-but-confined (no full spread), tail free — and only now may the mood
system animate it.

## Open questions

- Who produces the environment `spaceBand` and coarse passage/ceiling facts
  before location authoring ships? (Cross-ref
  [location-authoring.plan.md](location-authoring.plan.md).)
- Species/glamour: when morphology is hidden or shifted, is that an attribute
  overlay (already supported) or does this layer need a concealment input?
- Is `massBand`/`prehensile` derivable from `tail.type`, or does the tail
  vocabulary need the same orthogonality split as `hair.quality`?
- Do offered-action affordances (shelter, wing-spread) share the candidate
  contract or need a distinct `possibleAction` output type?
