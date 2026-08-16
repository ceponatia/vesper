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
  premise implies containment — **with guardrails (ruled 2026-06-13):
  an interior/building implies its rooms take nested segments, but an
  outdoor/open area needs no nesting; the agent must not invent
  gratuitous depth.** Nesting stays **implicit** — a path-based folder
  model the travel rule and district seed read, with no folder-tree UI
  built yet. Separator is `/` (ruled); segment casing follows the
  location-naming style, settled at implementation.
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
    (ruled by user). Write-only until consumers land. **Confirmed
    2026-06-13:** spawn-only writes. Future (deferred, needs its own
    design): characters *acquire* items in play — purchases, gifts —
    that become owned at acquisition time, a second provenance path the
    items model doesn't have yet; tracked in
    [deferred.plan.md](../deferred.plan.md).
- **Phase-later consumers:**
  - Norms: taking an owned item / entering an owned space uninvited
    becomes a detectable breach candidate (the continuity agent gets
    owner context); per-character norm stances modulate reactions.
  - Access control: RECONCILE with the link model's
    `{ kind: "private", ownerParticipantIds }` — two ownership homes
    invite drift. Proposal: location owner is the source of truth and
    a private link *derives* its owners from the location it guards;
    hand-authored `ownerParticipantIds` stays only for links guarding
    nothing (a private footpath). **Ruled 2026-06-13:** adopt this —
    the location owner is the source of truth and the private link
    derives its owners from the location it guards; keep the derivation
    a thin, swappable seam so that if testing shows independently-authored
    link owners are wanted, it's a small change, not a migration.
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
- **Ruled 2026-06-13:** the four daylight bands (dawn / day / dusk /
  night) are the v1 vocabulary. Design them **customizable later** —
  worlds on other planets or dimensions won't share Earth's day scale,
  so the band set must be overridable per world / `style` (the defaults
  doc already flags bands as `style`-overridable), never hard-coded as a
  universal four.
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

## Rulings (2026-06-13)

All four open questions are resolved; detail is folded into the sections
above.

1. **Area paths** — separator `/`; implicit path-based nesting (no
   folder-tree UI yet); forge suggests nested paths with guardrails
   (buildings nest rooms, outdoor areas don't).
2. **Owner ↔ private-link** — location owner is the source of truth; a
   private link derives its owners from the location it guards; kept a
   swappable seam.
3. **Banded ambients** — four daylight bands, designed overridable per
   world / `style` for non-Earth time scales.
4. **Item-instance ownership** — `owner_participant_id`, spawn-only
   writes; play-time acquisition deferred to
   [deferred.plan.md](../deferred.plan.md).

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
