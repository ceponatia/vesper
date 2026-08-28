# Materials and Inventory

The simulation engine's material economy: where items sit, who holds and owns them,
how they move, wear, and get consumed, and the coarser household-scale economy — lots,
means, and restock — that backs a world too detailed to track every spoon. See
[bodies.md](bodies.md) for meters and conditions on characters, and
[../contracts/items/README.md](../contracts/items/README.md) for the item/wardrobe registry
(`ItemDefinition`, coverage, visibility) this model builds on.

## Items and holding loci

Every material item occupies exactly one holding locus at any story second:

- **held** — carried by an actor;
- **worn** — on an actor in a named slot (slot keys are free text);
- **container** — inside another item that declares container configuration;
- **zone** — resting at a place;
- **gone** — terminal: consumed, destroyed, or lost.

One holdings row per item is the database-enforced guarantee that an item cannot be
in two places at once. `gone` has no outgoing transition — an item that reappears is a
new item, never a resurrection of the old row.

Containers are themselves items, so holding chains nest (an item in a bag, the bag held
by an actor). Every chain resolves to a **root locus** — an actor or a zone — through a
depth-capped walk (8) with cycle rejection at transfer time; there are no synthetic
container rows standing in for actors or locations.

## Containers and access

Container capacity is a plain occupant count today (size and weight classes are
reserved vocabulary, not yet schema). Access policy is fail-closed and checked on the
**immediate** container at both ends of a transfer:

- `open` — any co-located actor;
- `holder_only` — only the actor at the chain's root;
- `allow_list` — a named actor set.

## Ownership vs. holding

Ownership is a nullable `ownerActorId` on the item, distinct from where it physically
sits, changed only by an `item_ownership_set` event. Holding law is physical and never
blocked by ownership — you can move an item you don't own. A transfer performed by
someone other than the recorded owner is flagged `againstOwnership: true` on the event;
any consequence flows through the social ledger, not through rejecting the move.

## Transfer law

`transfer_item` names the acting actor, the item, an asserted source locus, and a
destination locus, and validates a strict ordered chain before committing: the actor
exists and is in control, is embodied at a zone, the item still exists, the asserted
source matches current truth (a staleness defense against stale client state), the
destination is well-formed, the acting actor's zone matches the **root** zone of both
chains, a source chain rooted at another actor is rejected (no lifting things off
another person or out of their worn slots without consent) while a destination chain
rooted at a co-located other actor is allowed (giving), a `worn` destination is only
legal on the actor's own body, container access clears at both immediate ends,
destination capacity holds, no cycle would result, and source and destination are not
the same locus. A scheduled transfer re-runs this whole chain at fire time rather than
trusting the state it was scheduled against.

Material events derive their observations through the same perception rule table
used elsewhere in the engine — an obvious hand-off is seen by anyone in the zone, while
a worn-slot change hidden under clothing stays reserved for finer-grained perception
later.

## Resource costs and reservations

An action definition can carry `resourceCosts`: each cost names an authored
`materialKindKey`, a quantity, and a disposition — `consume` (destroyed into a body or
world effect on completion) or `use` (reserved for the activity's span, with wear or
cleanliness effects applying on completion). Starting the activity selects concrete
items deterministically — extant, matching kind, root-located with the actor, held
items before zone items, ties broken by item id — and records that selection on the
`activity_started` event.

Selected items are reserved exclusively for the activity. The reservation isn't a
separate store to go stale or leak: it's projected from live activity state the same
way claims are, held for every claim-holding phase and released the moment the
activity ends, so no reservation can outlive its activity. Anyone other than the
reserving activity's own machinery who tries to transfer, consume, or destroy a
reserved item is rejected with `item_reserved`, and completion re-validates the
reservation again at fire time before it actually consumes anything.

## Consumption

`consume_item`, and the completion of any `consume`-disposition resource cost, emits
one `item_consumed` event moving the item's locus to `gone/consumed`, with trailing
`body_source_applied` events — one per the item's authored `consumptionEffects` — each
naming a meter, a source kind (`meal`, `drink`, `adjustment`), and an operation.
These are causation-chained to the consumption event and integrated through the same
meter kernel [bodies.md](bodies.md) uses, in the same transaction, so threshold and
collapse alarms retire and re-arm exactly as they would for any other body event. A
meal is a material event with a body effect: one command, one atomic record, never a
follow-up write.

## Item condition

Wear and cleanliness are item condition meters running on the exact meter machinery
bodies use — fixed-point kernel, registry-as-data, the same modifier contract and
analytical integration — but under an item-scoped registry (`item-condition-v1`) and
item-scoped tables; the body tables aren't reused, only the kernel that drives them.
[bodies.md](bodies.md) covers that shared machinery in full.

The current registry has two meters: `cleanliness` (a linear law with a zero at-rest
rate — a garment sitting unworn doesn't foul on its own — that picks up a
`rate_add` modifier while worn, so it only gets dirty on a body; the added rate is
**positive**, which composed with a zero base rate and a zero target produces
approach-mode decay toward fully soiled, where a literal negative rate would be
inert and never move the meter at all) and `wear` (no drift at all,
only discrete deltas landing from `use`-disposition activity completions). Threshold
crossings — going grimy, going worn-out — are registry data and alarm through an
`item_condition_threshold_due` trigger, witnessed by co-location with the item's root
locus when the crossing is marked noticeable. Raw item-meter values never enter a
narrative cut directly; a read is perception-gated the same way a body meter's raw
value is.

## Households and membership

A household is a branch-scoped shared domestic unit: a named group of actors sharing
stores, a residence, and a coarse economic footprint. It exists only as the product of
a `household_created` event — co-residence alone never implies one.

Membership is a typed relation between an actor and a household, carrying a role
(`resident`, `dependent`, or `guest` — descriptive only, it doesn't by itself gate
stock access) and a status (`active` or `ended`). Only an active membership lets an
actor draw from the household's shared stores.

A household declares a `residenceZoneIds` set (where its stores and routine live) and
a `stockAccessPolicy` — `members_only` (any actively-membered actor) or `allow_list`
(a named set, for access without membership, e.g. a hired hand). Every command that
debits or promotes from a household's stock checks, in order, that the acting actor is
embodied at a zone, that zone is one of the household's residence zones, and the stock
access policy admits the actor — the same physical-presence discipline as an ordinary
item transfer, deliberately not a remote-banking shortcut. Storyteller and system
authoring commands are exempt from this co-location check, the same way other
privileged commands sidestep ordinary movement rules.

## Fungible material lots and conservation

A material lot is a branch-scoped account: a quantity of one `materialKindKey` resting
at one of three flat loci — a household's shared store, an actor's personal holding (no
co-location check; it travels with them), or stock resting at a zone. Unlike an item's
holding locus, a lot never nests inside a container, and a zero balance isn't terminal
— a lot can return to positive, and its row persists once initialized, lazily on first
touch, the same lazy-init pattern item-condition meters use.

Quantities are integers, never floats. Each material kind declares a `quantityKind`:
`fixed_point` (the same 10 000-per-unit convention meters use, for currency and any
kind with a fractional narrative unit) or `count` (a plain non-negative integer, the
default for any kind the registry doesn't mention — an unregistered kind degrades to
the simpler representation instead of failing closed). The reserved kind `currency` is
always `fixed_point`. A lot captures its `quantityKind` and registry version at
initialization and never reinterprets its stored value under a later registry change.

**Conservation.** Every quantity change is an event. Moving a quantity between two lots
of the *same* kind (`transfer_lot_quantity`) commits the debit and the credit in one
event — conserved by construction, the same way an item transfer moves one locus in one
event rather than a paired remove/add. A negative balance can't happen: the pure
resolver rejects an insufficient balance before any event is built, and a database
CHECK backs that up so even a projection bug can't commit one.

Conservation holds only *within* one material kind. Exchanging across kinds — buying
food stock with currency — is two causally-linked adjustments (a currency debit, a
stock credit, both `material_lot_adjusted`, the second chained to the first), not one
conserved transfer, because the wider market that would balance the other side of the
trade isn't itself modeled.

A quantity change with no conserving counterpart at all — an authored injection, a
promotion's stock debit, a restock's stock credit — is `material_lot_adjusted`,
carrying a `reason` (`authoring`, `promotion_cost`, `restock_purchase`, or
`restock_topup_unconserved`) and a signed delta: the lot analogue of a body meter's
external source application. `restock_topup_unconserved` is the one reason that
deliberately breaks conservation — a means-band-funded restock (see below) credits
stock with no debited counterpart anywhere, because a low-detail household's "budget"
is a coarse band, not a tracked account. Every other reason either has a linked
counterpart event in the same transaction or is an explicit, audited authoring act.

## Means: bands and promotion

A means subject — an actor or a household (and, at coarser scope, a population cohort)
— reads its means from exactly one of two sources, never a blend:

1. **Lot-tracked**, if the subject has an initialized `currency` lot: the read is that
   lot's balance. This is the path for a promoted actor, or a household played at full
   economic detail.
2. **Band-tracked**, otherwise, if a `means_band_set` record exists: the read exposes
   only the band, a closed and versioned world-type vocabulary ordered from least to
   most means, never a number.

Absent either, the read is the explicit degraded default `unknown` — a diagnostic code,
never a fabricated figure. Precedence is structural rather than a toggle: a lot wins
the instant it exists, and setting a means band on an already lot-tracked subject is
legal narrative color that the means read simply never consults.

**Promotion.** `promote_item_from_stock` is the only path by which an aggregate
material fact — "there's clothing stock in the shop" — becomes a concrete `sim_items`
row. It checks the acting actor's authority and, for a household-locus funding source,
the household access preconditions above (an actor-locus source needs no co-location
check, since the actor's own stock travels with them); resolves funding as either
`stock` (debiting whole units of the *same* kind the promoted item declares — one unit
of a clothing lot becomes one shirt) or `purchase` (debiting an authored unit price
from a currency lot), rejecting `insufficient_balance` if the funding lot can't cover
it; samples any detail the command didn't supply — a display name, say — from an
authored pool through a named deterministic stream keyed to the command's id and a
purpose label, capturing the stream identity and drawn result on the event so replay
never re-samples; and emits, in one transaction, a `material_lot_adjusted` debit
(`reason: "promotion_cost"`) and a causation-chained `item_instantiated_from_promotion`
event carrying the item's full shape and locus.

Promotion never contradicts something already observed, asserted, or believed about
the fact — whoever calls the command is responsible for supplying any
narratively-established detail explicitly, which bypasses sampling for that field. An
item can come to exist in `sim_items` only through the branch seed or this event; a
narrator can describe an aggregate fact without promoting it, but can't hand a player
or NPC command a concrete item reference until `promote_item_from_stock` has run.

## Household restock routine

A household's own stock replenishes on a deterministic, scheduled routine rather than
as a side effect of every consumption. `configure_restock_routine` authors, per
household and material kind, a target quantity, a low-water threshold, a cadence in
seconds, and a funding source — a currency-lot purchase, or, for a band-tracked
household, a means-band-gated non-conserved top-up. Configuring it arms a
`household_restock_due` trigger at `now + cadenceSeconds`, keyed so that reconfiguring
unconditionally retires any stale pending alarm — the same unconditional-retire idiom
item condition uses when a worn-ness change supersedes a prior cleanliness alarm.

At fire time, `run_household_restock` (a system-principal, trigger-dispatched command)
re-validates before doing anything: the routine still exists and is active (otherwise
it simply isn't re-armed — something already retired it); the stock is actually below
target (otherwise it's deferred as `already_stocked` and the next cycle re-arms as
normal); and the funding source can cover the top-up (otherwise deferred as
`insufficient_funds` — a household running dry is an intended failure mode, not a
silently swallowed one). On success it debits the funding source and credits the stock
lot up to target in one transaction (`household_restock_fulfilled`), then re-arms the
next cycle regardless of outcome, so a deferred cycle keeps trying rather than going
quiet.

## Related

- [bodies.md](bodies.md) — the meter/condition kernel item condition and consumption
  both run on, and the character-side model materials feed into.
- [../contracts/items/README.md](../contracts/items/README.md) — the item and wardrobe registry
  (`ItemDefinition`, coverage, visibility) that engine items are instances of.
