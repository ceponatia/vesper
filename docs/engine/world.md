# World

The successor engine's physical world: locations, zones, and the links between
them; the access, privacy, and consent layers that gate movement and entry; and
the journeys actors take to cross the space. Commitments, actions, activities,
and live-scene arbitration are a separate concern — see
[activities.md](activities.md).

## How it works

### Topology

A world's space is three nested shapes. A **Location** is a place (a house, a
workplace) with a `kind`, an optional map `coordinate`, and a
`defaultAccessPolicy`. A **Zone** is a room or area inside a Location — zones
can nest via `parentZoneId`, carry an `occupancyLimit`, and always carry their
own `privacyPolicy` (a bedroom's privacy policy is not inherited from the house
around it). A **Link** connects two zones for one or more `TravelMode`s, with a
`minimumDurationSeconds`, an optional `schedule` of access windows, its own
`accessPolicy`, and a state of `open`, `closed`, `locked`, or `blocked`.

Location, Zone, and Link `kind` fields are open strings rather than an
engine-fixed enum — a world type authors whatever place and connection
vocabulary it needs without an engine change.

### Where an actor is

A `PhysicalLocus` is either `at` (an actorId resolved to one locationId and
zoneId, with a `since` timestamp) or `in_transit` (bound to a journeyId and
linkId, with `enteredAt` and `earliestExitAt`). An actor occupies exactly one
locus at a time: an in-transit actor is not simultaneously at its origin or
destination, even though narration may describe a vehicle or route zone —
every projection query still resolves to the single locus.

### Route planning

A route result carries the ordered links, the travel mode, the minimum
duration, an expected duration with uncertainty, access requirements, known
hazards or closures at planning time, and a route derivation version — hop
count alone is not a usable travel metric. A planned route
can still be delayed or invalidated later, but only by a new event that
explains the change; nothing silently reroutes an actor already underway. This
is the contract a Journey (below) is built from.

### Access layers

Reaching and entering a place passes through six independent layers, in order:
route passability, property access, zone access, current occupancy and
privacy, interpersonal consent for the proposed interaction, and perspective
entitlement to the reason. Passing one layer says nothing about the next — a
character can be free to walk to a house, stand at the door, and still have no
entitlement to know why it isn't answered.

Access into a scope is granted explicitly, not inferred from relationship or
history:

    type AccessGrant = {
      id: string;
      granteeActorId: string;
      locationId: string;
      zoneIds?: string[];
      basis: "owner" | "resident" | "employee" | "invitation" | "key" | "forced";
      validFrom: number;
      validUntil?: number;
      revokedAt?: number;
    };

A grant carries no permission list and no revocable flag — revocation is
expressed by stamping `revokedAt`. Public access needs no grant at all, which is
why `public` is not a basis; `forced` is, so a trespass records the basis it
entered on.

`basis` is a closed set of literals, not an open vocabulary like Location/Zone
`kind` — adding a new basis is a contract change. An `AccessGrant` is scoped
narrowly on purpose: it grants physical entry, not blanket consent to
conversation, touch, intimacy, or interruption once inside. Those are action
preconditions owned by [activities.md](activities.md), evaluated independently
of whether the actor is allowed to be in the room.

### Player movement

A player instruction like "I go to Mara's house" proposes travel only to the
nearest legal arrival zone — normally the exterior or the doorstep, never the
interior. Actually entering is a second, separately validated action, and a
bedroom, bathroom, shower, locked office, or staff area additionally requires
current zone authority beyond having reached the property. When entry is
denied, the engine returns legal alternatives such as knock, call, wait, leave,
or — where the world type enables it — attempt trespass.

### NPC movement

The mirror instruction, "Mara comes here," cannot directly relocate Mara. There
is no request family a controller evaluates against her locus, activity, route,
commitments, relationship, safety and preference — **no such
command exists in code**. The only NPC-inclusive movement command is
`move_together`, and it requires the NPC to already share the player's zone —
nothing can summon a remote NPC today. Where movement does happen it still
produces a chain of preparation, departure, journey and arrival events rather
than instant co-location. This is the same reason a shift's "the NPC
comes back at 4pm" still consumes real travel time, covered in
[activities.md](activities.md).

### Trespass and forced entry

Where a world type permits transgressive entry attempts, `attempt_entry` carries
a boolean `forced` and resolves synchronously in one step: it checks the link
state and the world's trespass permission, then emits one `zone_entered` event
with basis `forced`, recording witnesses. Trespass as a played-out activity
with duration, noise, tools and interruption is **not built** —
witnesses are the only part of it that exists. Where the product disallows it, the attempt is rejected at
admission with a public rule reason; the door is never presented as physically
impossible just to hide a product restriction.

### Failure presentation

Every denied movement or entry produces a structured failure:

    type PublicFailurePresentation = {
      code: string;
      publicReason: string;
      publicEvidence: string[];
      legalAlternatives: string[];
    };

This is the only failure type there is: **no paired private record carrying a
`privateCauseEventId` for audit exists** — callers construct the public shape
directly, so there is no private cause to leak in the first place.

The perspective rule the design was reaching for still holds, and is enforced
upstream in what the cut carries rather than by omitting a field here: "She
doesn't answer" is legal narration on its own, while "she doesn't answer because
she is naked in the shower" is legal only where the viewpoint has evidence for it.

### Journeys

A Journey is the durable record of one actor's (or group's) transit between
two zones:

    type Journey = {
      id: string;
      actorIds: string[];
      originZoneId: string;
      destinationZoneId: string;
      routeLinkIds: string[];
      travelMode: TravelMode;
      departedAt?: number;
      earliestArrivalAt: number;
      expectedArrivalAt: number;
      status: "planned" | "active" | "delayed" | "interrupted" | "arrived" | "abandoned";
      currentLinkIndex: number;
      routeDerivationVersion: string;
    };

| From        | Legal next states                        |
| ----------- | ----------------------------------------- |
| planned     | active, abandoned                         |
| active      | delayed, interrupted, arrived, abandoned  |
| delayed     | active, interrupted, arrived, abandoned   |
| interrupted | active, abandoned                         |
| arrived     | terminal                                  |
| abandoned   | terminal                                  |

Journey progress is analytical rather than a simulation tick: the engine
persists departure, a link or mode change, a delay, an interruption, and
arrival — not a row per minute of travel. An arrival
event never lands before `earliestArrivalAt` unless a new causal event changes
the route or travel mode, and skipping ahead through idle travel time never
by itself changes when the actor arrives.

## Invariants

- Malformed, missing, or unknown private access data never degrades to public
  visibility — a grant row that fails its schema parse is dropped, so entry is
  denied. No diagnostic is emitted on that path today.
- An actor resolves to exactly one `PhysicalLocus` at any query, even mid-
  journey.
- The six access layers are evaluated independently; clearing one is never
  treated as clearing the next.
- An `AccessGrant` never implies interpersonal consent to conversation, touch,
  intimacy, or interruption — those preconditions live with the action, not
  the grant.
- Nothing relocates an NPC directly. `move_together` is the only NPC-inclusive
  movement command, and it requires the NPC to already share the player's
  zone.
- A disallowed trespass attempt is rejected at admission with a public rule
  reason rather than faked as a physical impossibility.
- The narrator only receives a failure's private cause when the acting
  viewpoint could actually perceive or know it.
- A Journey's arrival never precedes `earliestArrivalAt` without a new causal
  event justifying the change.

## Extending it

Location and Zone `kind`, and the travel modes a Link accepts, are open
vocabularies authored per world type — adding a new place type or connection
kind is a data change in the world's content, not an engine change.
`AccessGrant.basis` and the Journey/Access state machines are closed sets
defined in [@vesper/simulation-core](../../packages/simulation-core/README.md);
extending either is a contract change, not a data edit.

## Degradation

Access data is a trust boundary: a private access record that is malformed,
missing, or of unknown shape is treated as denied, never as public, and the
unparseable grant row is simply excluded. It fails closed,
but it does so silently: the access store uses a bare schema parse rather than
the diagnostic-emitting `parseOr` pattern that
[resilience.md](../resilience.md) prescribes, so nothing records that a row was
dropped.

## Related

- [activities.md](activities.md) — commitments, temporal pressure, actions,
  activities, and live-scene reconciliation.
- [resilience.md](../resilience.md) — the fail-closed, diagnostic-first
  pattern this doc's access rules follow.
