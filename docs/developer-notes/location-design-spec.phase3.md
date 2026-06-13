# Location design — spec

Status: **draft for discussion** (2026-06-12, from user testing
feedback — see followups.phase2.md #12 for the editor-UI items shipped
immediately). Locations today are hollow boxes: a name, a freeform
description, three ambient strings — everything else lives in prose,
so the narrator and state agents can't *use* any of it, and authoring
at scale is slow. This spec adds structure the engine can read.
Feature-sized; slots into the phase-3+ build order where its
dependencies live. Cross-cutting with
[time-and-travel-spec.phase3.md](time-and-travel-spec.phase3.md) (area
semantics, daylight bands),
[npc-movement-spec.phase3.md](npc-movement-spec.phase3.md) (access
control), [presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
(darkness), and [offscreen-simulation-spec.phase3.md](offscreen-simulation-spec.phase3.md)
(affordances).

## Already in place

`scale` (authored, framing line ships), `area` (flat label, drives
travel defaults), `affordances` column (ships empty; phase 5 fills),
location-tagged scene-tier lore, ambient `{scent, sound, light}`
strings, and the editor improvements from followups #12 (collapse,
drag-sort with persisted order, copy, link-union display).

## Area hierarchy (the Apartment 102 problem)

Authored case: Apartment 102's kitchen/living room/bedroom share area
`"Apartment 102"`, but the apartment is *in* the building — living
room → building hallway should default to the intra-area 1 minute, not
the 10-minute inter-area cost.

**Proposal: hierarchical path labels.** `area` stays a single string —
`"Harbor Apartments / Apartment 102"` — segments split on `/`. The
travel-default rule becomes: locations whose area paths share **any
leading segment** get `DEFAULT_LINK_TRAVEL_MINUTES`; fully disjoint
paths get `DEFAULT_INTER_AREA_TRAVEL_MINUTES`. Flat labels are
one-segment paths, so every existing world behaves identically — no
migration, no new entity.

- Honors time-and-travel's "a label, not a container" decision in
  letter and spirit: there is still no containment entity, just a
  richer label the *authoring-time default* reads. Runtime never
  parses areas (travel costs are materialized onto links at save).
- The district-abstraction trigger (defaults doc) gets natural
  districts from first segments for free.
- Editor: area input gains autocomplete over the world's existing
  paths. Forge: location agent may suggest nested paths when the
  premise implies containment.
- Alternative considered: multiple area tags per location (set
  membership; share-any-tag ⇒ intra). Simpler mental model, but
  loses the district seed and makes "inside" inexpressible. Rejected
  unless paths prove confusing in authoring.

## Ownership

Non-required `owner` on locations: "this is Fatima's apartment" as
structure, not prose.

- **Shape**: `ownerCastId` (nullable) on `world_locations` overrides /
  draft; spawn resolves it to `owner_participant_id` on
  `session_locations`. References cast, not library characters — only
  cast members exist in sessions.
- **Phase-early uses (cheap, no behavior systems needed):**
  - Editor: owner select on the location card (cast names + none).
  - Narrator: one scene-snapshot line ("This is Fatima's home") —
    replaces burying ownership in the description.
  - **Spawn item ownership**: items placed in an owned location at
    spawn become owned by the owner. This needs item-instance
    ownership vocabulary that does not exist yet — proposal: nullable
    `owner_participant_id` on `item_instances`, set **only at spawn**.
    Play-time placements and drops never auto-assign ownership
    (ruled by user). Write-only until consumers land.
- **Phase-later consumers:**
  - Norms: taking an owned item / entering an owned space uninvited
    becomes a detectable breach candidate (the continuity agent gets
    owner context); per-character norm stances modulate reactions.
  - Access control: RECONCILE with the link model's
    `{ kind: "private", ownerParticipantIds }` — two ownership homes
    invite drift. Proposal: location owner is the source of truth and
    a private link *derives* its owners from the location it guards;
    hand-authored `ownerParticipantIds` stays only for links guarding
    nothing (a private footpath). Needs a ruling before phase-4
    enforcement builds on either.
  - Drives/off-screen: owners act freely in their space; "home" is an
    affordance anchor for needs/schedule drives.

## Time-banded ambients

Authored case: daylight through the window by day, a lamp at night.

**Proposal**: keep base `ambient` as the default; add optional
per-band overrides reusing the existing daylight-band vocabulary
(dawn / day / dusk / night — one time vocabulary in the codebase, not
a new morning/afternoon/evening set):

```ts
ambient: {
  scent?, sound?, light?,                  // base (as today)
  byBand?: { dawn?: {...}, day?: {...}, dusk?: {...}, night?: {...} }
}
```

- Scene snapshot renders the band-appropriate values (band from the
  time-context helper, already shipped).
- The phase-3 **darkness model upgrades from keyword heuristics to
  authored truth**: banded `light` answers "is it dark here right now"
  directly ("lamplit" at night ⇒ lit) — the defaults doc's keyword
  list becomes the fallback for unbanded locations.
- Backward compatible: `byBand` optional, old rows parse unchanged.
- Editor: compact band column per ambient field, or a "varies by time
  of day" toggle revealing the grid. Forge fills bands when the
  description implies them.

## Per-location forge

A forge button on the location card (mirrors the character forge):
fills description, ambient (+ bands), scale, tags — and suggests
affordances once those are authorable — from the name, any text
already entered, and the world premise. Small targeted section call
(`forge.world.location_detail`), demo-mode fallback, same grounding
and diagnostics discipline as the existing sections. This is the
answer to "an hour for 6 locations": copy + forge gets a room to
90% in seconds.

## More structure, more flavor (aligned with existing plans)

- **Affordances become authorable early.** The column exists and waits
  for phase 5's forge fill — but an editor field plus a line in the
  scene context ("things to do here") costs little and pays
  immediately; the needs/drives consumers arrive later unchanged.
- **Encounter hints** (decision 42) live on locations/areas — author
  them on the location card when extras spawn-authority ships.
- **Perception defaults** (presence spec): a location-level attention
  hint ("the gallery faces outward") complementing item-level hints.
- **Norm overlays** (opportunity, unspecced): a location tag that
  raises/lowers specific world norms — a chapel where rowdiness is
  outrage, a dive bar where it's nothing. Compose with norm stances.
- **Owner + banded ambient + affordances together** make the scene
  snapshot structurally rich: "Fatima's apartment — lamplit this late,
  the kettle she keeps by the window" without an author writing that
  sentence.

## Open questions

(Restated in [phase-3-plan.md](phase-3-plan.md) per the repo rule.)

1. Area path separator (`/` proposed) and whether the forge suggests
   nested paths from day one.
2. Owner ↔ private-link reconciliation: does `private` derive its
   owners from the guarded location's owner (proposed) or stay
   independently authored?
3. Banded-ambient vocabulary: reuse the four daylight bands (proposed)
   vs the user's simpler morning/afternoon/evening three.
4. Item-instance ownership shape (`owner_participant_id`, spawn-only
   writes) — confirm before the items data model grows a second
   provenance mechanism.

## Testing sketch

Pure: area-prefix travel defaults (flat labels unchanged; nested
prefix ⇒ intra); banded ambient resolution per band incl. fallback to
base; owner resolution at spawn (cast → participant, unresolved ⇒
diagnostic + unowned). Integration: spawn copies owner + banded
ambients; snapshot renders band + owner lines; spawn-time item
ownership set, play-time placement leaves it null.

## Docs to update when implementing

`contracts.md` (ambient shape, owner), `database.md` (columns),
`turn-engine.md` (snapshot lines), `authoring.md` (location forge,
area paths), `ui.md` (editor fields).
