# World

The successor engine's physical world: locations, zones, and the links between
them; the access, privacy, and consent layers that gate movement and entry; and
the journeys actors take to cross the space. Commitments, actions, activities,
and live-scene arbitration are a separate concern — see
[activities.md](activities.md). The normative contract for everything below is
[engine.spec.world.md](../developer-notes/engine.spec.world.md); citations here
are plain-text `engine.spec §N` pointers into it.

## How it works

### Topology

A world's space is three nested shapes. A **Location** is a place (a house, a
workplace) with a `kind`, an optional map `coordinate`, and a
`defaultAccessPolicy`. A **Zone** is a room or area inside a Location — zones
can nest via `parentZoneId`, carry an `occupancyLimit`, and always carry their
own `privacyPolicy` (a bedroom's privacy policy is not inherited from the house
around it). A **Link** connects two zones for one or more `TravelMode`s, with a
`minimumDurationSeconds`, an optional `schedule` of access windows, its own
`accessPolicy`, and a state of `open`, `closed`, `locked`, or `blocked`
(engine.spec §13.1).

Location, Zone, and Link `kind` fields are open strings rather than an
engine-fixed enum — a world type authors whatever place and connection
vocabulary it needs without an engine change.

### Where an actor is

A `PhysicalLocus` is either `at` (an actorId resolved to one locationId and
zoneId, with a `since` timestamp) or `in_transit` (bound to a journeyId and
linkId, with `enteredAt` and `earliestExitAt`). An actor occupies exactly one
locus at a time: an in-transit actor is not simultaneously at its origin or
destination, even though narration may describe a vehicle or route zone —
every projection query still resolves to the single locus (engine.spec §13.2).

### Route planning

A route result carries the ordered links, the travel mode, the minimum
duration, an expected duration with uncertainty, access requirements, known
hazards or closures at planning time, and a route derivation version — hop
count alone is not a usable travel metric (engine.spec §13.3). A planned route
can still be delayed or invalidated later, but only by a new event that
explains the change; nothing silently reroutes an actor already underway. This
is the contract a Journey (below) is built from.

### Access layers

Reaching and entering a place passes through six independent layers, in order:
route passability, property access, zone access, current occupancy and
privacy, interpersonal consent for the proposed interaction, and perspective
entitlement to the reason. Passing one layer says nothing about the next — a
character can be free to walk to a house, stand at the door, and still have no
entitlement to know why it isn't answered (engine.spec §14).

Access into a scope is granted explicitly, not inferred from relationship or
history:

    type AccessGrant = {
      id: string;
      branchId: string;
      granteeActorId: string;
      issuerActorId?: string;
      scope: { locationId: string; zoneIds?: string[] };
      basis: "owner" | "resident" | "employee" | "invitation" | "key" | "public";
      permissions: ("enter" | "remain" | "bring_guest" | "use_item")[];
      validFrom: number;
      validUntil?: number;
      revocable: boolean;
      revokedAt?: number;
    };

`basis` is a closed set of literals, not an open vocabulary like Location/Zone
`kind` — adding a new basis is a spec change. An `AccessGrant` is scoped
narrowly on purpose: it grants physical entry, not blanket consent to
conversation, touch, intimacy, or interruption once inside. Those are action
preconditions owned by [activities.md](activities.md), evaluated independently
of whether the actor is allowed to be in the room (engine.spec §14).

### Player movement

A player instruction like "I go to Mara's house" proposes travel only to the
nearest legal arrival zone — normally the exterior or the doorstep, never the
interior. Actually entering is a second, separately validated action, and a
bedroom, bathroom, shower, locked office, or staff area additionally requires
current zone authority beyond having reached the property. When entry is
denied, the engine returns legal alternatives such as knock, call, wait, leave,
or — where the world type enables it — attempt trespass (engine.spec §14.1).

### NPC movement

The mirror instruction, "Mara comes here," cannot directly relocate Mara. It
resolves to a request — `InviteActor`, `RequestVisit`, `CallActor`, or
`AskActorToLeave`, depending on language and channel — that Mara's controller
evaluates against her locus, current activity, route, commitments,
relationship, safety, and preference. Acceptance produces a chain of
preparation, departure, journey, and arrival events; it never produces instant
co-location (engine.spec §14.2). This is the same reason a shift's "the NPC
comes back at 4pm" still consumes real travel time, covered in
[activities.md](activities.md).

### Trespass and forced entry

Where a world type permits transgressive entry attempts, they are modeled as
explicit activities carrying duration, noise, required tools or skill, the
lock and obstacle state, witnesses and observation channels, interruption, and
legal, social, and safety consequences — trespass is a played-out activity,
not a flag flip. Where the product disallows it, the attempt is rejected at
admission with a public rule reason; the door is never presented as physically
impossible just to hide a product restriction (engine.spec §14.3).

### Failure presentation

Every denied movement or entry produces a structured failure:

    type FailurePresentation = {
      code: string;
      publicReason: string;
      publicEvidence: string[];
      legalAlternatives: string[];
      privateCauseEventId?: string;
    };

`privateCauseEventId` exists for audit and authorized systems only — the
narrator sees it, and can narrate from it, only when the acting viewpoint
could actually perceive or know that cause. "She doesn't answer" is legal
narration on its own; "she doesn't answer because she is naked in the shower"
is only legal if the viewpoint has evidence for it. The type the narrator
actually renders from, `PublicFailurePresentation`, is the same shape with
`privateCauseEventId` omitted entirely — the private cause cannot leak by
accident (engine.spec §14.4).

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
arrival — not a row per minute of travel (engine.spec §17, §17.1). An arrival
event never lands before `earliestArrivalAt` unless a new causal event changes
the route or travel mode, and skipping ahead through idle travel time never
by itself changes when the actor arrives (engine.spec §17.1).

## Invariants

- Malformed, missing, or unknown private access data never degrades to public
  visibility — the engine fails closed, emits a diagnostic, and offers a safe
  boundary such as the exterior or doorstep instead (engine.spec §13.1).
- An actor resolves to exactly one `PhysicalLocus` at any query, even mid-
  journey (engine.spec §13.2).
- The six access layers are evaluated independently; clearing one is never
  treated as clearing the next (engine.spec §14).
- An `AccessGrant` never implies interpersonal consent to conversation, touch,
  intimacy, or interruption — those preconditions live with the action, not
  the grant (engine.spec §14).
- NPC relocation always routes through a controller-evaluated request
  (`InviteActor`, `RequestVisit`, `CallActor`, `AskActorToLeave`); nothing
  moves an NPC directly (engine.spec §14.2).
- A disallowed trespass attempt is rejected at admission with a public rule
  reason rather than faked as a physical impossibility (engine.spec §14.3).
- The narrator only receives a failure's private cause when the acting
  viewpoint could actually perceive or know it (engine.spec §14.4).
- A Journey's arrival never precedes `earliestArrivalAt` without a new causal
  event justifying the change (engine.spec §17.1).

## Extending it

Location and Zone `kind`, and the travel modes a Link accepts, are open
vocabularies authored per world type — adding a new place type or connection
kind is a data change in the world's content, not an engine change.
`AccessGrant.basis` and the Journey/Access state machines are closed sets
defined in the spec; extending either is a contract change, not a data edit.

## Degradation

Access data is a trust boundary: a private access record that is malformed,
missing, or of unknown shape is treated as denied, never as public, and the
engine emits a diagnostic and falls back to a safe boundary such as the
exterior or doorstep rather than guessing (engine.spec §13.1). This follows
the same fail-closed, diagnostic-over-exception pattern documented in
[resilience.md](../resilience.md).

## Related

- [activities.md](activities.md) — commitments, temporal pressure, actions,
  activities, and live-scene reconciliation (engine.spec §15–§18).
- [engine.spec.world.md](../developer-notes/engine.spec.world.md) — the
  normative source for this doc, §13, §14, and §17.
- [resilience.md](../resilience.md) — the fail-closed, diagnostic-first
  pattern this doc's access rules follow.
