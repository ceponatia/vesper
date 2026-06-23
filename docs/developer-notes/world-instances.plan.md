# World instances — the library→world→session copy cascade — plan

Status: **shipped — 2026-06-23** — the library → world → session copy cascade is
live. Topic slug `world-instances`. Born from the 2026-06-23 auth design discussion
(see [auth.plan.md](auth.plan.md)); unblocks the auth visibility seam (no
cross-owner references to build).

> **Completion note (2026-06-23).** Migration `0010_tiny_green_goblin.sql`: `world_*`
> rows now carry a `snapshot` + soft `source_*_id` (no FK) + `source_stamped_at`;
> library FKs dropped from `world_cast`/`world_items`/`world_locations` **and** from
> `session_participants`/`session_locations`/`item_instances`. `worldLocations.overrides`
> was replaced by a full `LocationSnapshot` (new `contracts/world/location.ts`, which
> also became the canonical home for `ambientSchema`). Write paths (`worlds.ts`,
> `world-from-draft.ts`, seed) bake snapshots; read paths (`spawn.ts loadWorldMaterial`,
> `getWorldDetail`) serve from snapshots with no library joins; `duplicateWorld` copies
> snapshots. Library DELETE routes dropped the now-dead `in_use` 409. `pnpm verify`
> green (1350 pure tests). **Deviations from the plan:** (1) session-table source
> columns kept their existing names (`character_id`/`location_id`/`item_id`) and only
> dropped the FK, to avoid a wide rename ripple; world columns were renamed to
> `source_*_id` as planned. (2) Avatars (the one shared image asset) resolve via the
> world image-backfill writing back `world_cast.avatar_image_id`, plus ref-aware
> `deleteEntityImages` that won't unlink an avatar a world/session copy still shows —
> reads stay snapshot-only. **Leftovers:** selective update **propagation** stays
> deferred (§Future); a batch of **pre-existing** int-test failures (player display
> name `You` vs `Brian` per UX-audit P1; stale `MAX_GENERATED_CAST`) surfaced during
> validation and are handled separately (test-suite cleanup), not by this refactor.

Make the entity cascade uniform: **library = templates → world = instances →
session = runtime**, where each layer is a self-sufficient copy of the one above
and **deletes never cascade downward**. Sessions already work this way; this plan
extends the same proven pattern up one level to **worlds**, which are the only
layer still holding live foreign-key references into the library.

## The model

| Layer       | Role                                                   | Characters            | Items           | Locations          | Today                     |
| ----------- | ------------------------------------------------------ | --------------------- | --------------- | ------------------ | ------------------------- |
| **Library** | Authored, ownable, **shareable** templates             | `characters`          | `items`         | `locations`        | ✅                        |
| **World**   | A world's own **instances** (owned by the world owner) | `worldCast`           | `worldItems`    | `worldLocations`   | ❌ live FK / ⚠️ half-copy |
| **Session** | Per-playthrough **runtime state** (unique, mutable)    | `sessionParticipants` | `itemInstances` | `sessionLocations` | ✅ full snapshot          |

**Invariant:** each layer is self-contained. Editing or deleting a row at one
layer never reaches _down_ into copies already made below it. A library entity can
be deleted at any time; worlds and sessions built from it survive untouched.

## Why (what it buys)

- **Safe deletion** — the problem that started this: deleting a library entity
  (yours or, once sharing lands, anyone's) can never break a world or session,
  because they hold their own copies. No FK 409 "in use", no dangling worlds.
- **Safe cross-owner sharing — and a _stronger_ security posture.** This is the
  big one for [auth.plan.md](auth.plan.md). "Use a public entity" becomes "copy it
  into your world/library at add-time," so **no cross-owner foreign keys ever
  exist**. Every row stays owner-scoped (the IDOR-clean property the 2026-06-23
  scan praised is preserved), and the entire "what happens on un-publish / delete
  of a referenced public entity" lifecycle tangle simply doesn't arise. The only
  cross-owner read in the system is the browse/preview/copy moment.
- **Per-world isolation** — tuning a character for one world (role, relationships,
  start location, a tweaked bio) never leaks to the library or to other worlds.
  This generalizes the per-world divergence that `worldLocations.overrides` already
  provides today.
- **`duplicateWorld` gets simpler** — copying a world becomes copying its own
  instances, with no library re-resolution.
- **Whole-world sharing becomes trivial later** — a world is self-contained, so
  publishing an entire world is a future option (out of scope; worlds stay private
  for now per the auth plan).

The cost paid for this: **library edits do not propagate to existing world/session
copies** (a typo fix in library "Aria" doesn't reach worlds already built from
her). That is the accepted v1 behavior — sessions already work this way — and the
deferred _selective propagation_ feature below is how we soften it later without
giving up the decoupling.

## Schema changes (`src/server/db/schema.ts`)

DB workflow per `CLAUDE.md` (edit `schema.ts` → `db:generate` → review → `db:migrate`).

- **`worldCast`** — add a `snapshot` JSONB holding the `CharacterProfile` copy;
  change `characterId` (hard FK) to a **soft, nullable** `sourceCharacterId` (no
  FK — provenance only, like `imageId`). Keep `role`/`tier`/`relationships`.
- **`worldItems`** — add a `snapshot` JSONB (`ItemDefinition` copy); `itemId` →
  soft nullable `sourceItemId`. Keep placement columns.
- **`worldLocations`** — promote `overrides` (partial) to a **full** location
  `snapshot`; `locationId` → soft nullable `sourceLocationId`.
- **Provenance for future propagation** (cheap, forward-compatible — see the
  forward-compatible-schema preference): keep the `source*Id` soft links **and**
  stamp a `sourceStampedAt` (the source's `updatedAt` at copy-time) or a content
  hash on each copy, so a future diff ("what changed in the source since you
  copied?") is computable without it we'd have no baseline to diff against.
- **Session tables** already snapshot — adjust them to copy from the **world
  instance** rather than the library, and soften any remaining hard library FKs to
  soft `source*Id` so a deleted library entity can't block anything.
- **Images are the exception — do not copy files blindly.** Snapshots are a few KB
  of JSONB (trivial); image files are binaries at `images/<ownerId>/…`.
  - **Same-owner copies** (your library → your world → your session): _share_ the
    image file; keep entity deletion **ref-aware** so an image still used by a
    world/session isn't deleted out from under it — lean on the existing
    `image_sweep` orphan job for reconciliation.
  - **Cross-owner copies** (you copy someone's public entity): **duplicate the
    file** into your ownership, so your world is self-contained and you actually
    own the asset (no silent dependency on the source owner's files).

## Materialization paths to rewire

- `materializeWorldEntities` (create/update world) — copy library → world instances.
- World from-draft / forge — forge **creates owned library templates and copies
  them into world instances in one step** (locked 2026-06-23): a single forge
  action both populates your library (the single reuse surface, so everything you
  forge is reusable in other worlds) and materializes the world's instances.
  Auto-generated rows keep a tag (the existing `suggested`/`forged` convention from
  `materializeSuggestedItems`) so the library can filter or bulk-clean them later.
- `duplicateWorld` — copy world instances directly (simpler, no library lookup).
- Session spawn — snapshot from **world instances**, not the library.

## v1 defaults (locked)

- **Pure snapshot, no propagation.** Copies are frozen at copy-time.
- **`source*Id` + `sourceStampedAt` retained** purely as provenance/forward-hook.
- **Image policy** as above (share same-owner, duplicate cross-owner, ref-aware
  cleanup via `image_sweep`).

## Future (deferred) — selective, opt-in update propagation

A later feature, **not v1**. The decoupling above is the floor; this is how we let
owners' improvements _optionally_ reach copies without reintroducing the coupling.
Rules captured from the 2026-06-23 discussion:

- **Deletes never propagate.** Ever. Deleting a source removes only the source;
  copies are untouched. (This is the whole point of the cascade.)
- **Only _some_ updates are propagation-eligible — additive, non-structural.** An
  owner can freely make sweeping changes to their own library entity (large
  redesigns that change _how a character functions_), but those **do not
  propagate**. Propagation is limited to safe, additive changes.
- **Already-set fields are locked for propagation.** A value that already exists on
  the copy is never overwritten, and structural changes to an already-set attribute
  don't propagate. Ride this on the existing **attribute `mutability`** system
  (`attribute-mutability.plan.md` / `overlaySourceMayChange`) rather than inventing
  a parallel notion — inherent/set attributes stay locked.
- **Newly-set (previously-unset) fields _may_ propagate when the owner sets them**
  — additive-only merge that fills gaps, never clobbers the copy-holder's edits.
- **Opt-in merge with a visible diff.** Copy-holders are _shown what changed_ and
  choose whether to merge into their copy — never auto-applied.
- **Undo.** At minimum, undo **one** merge (keep the pre-merge snapshot — cheap).
  A _deeper_ undo tree is **not** especially complex architecturally: it's an
  append-only per-copy merge-event log (snapshot or diff per merge); the cost is
  mostly UI + modest storage. Default to single-level undo for the first cut, but
  the append-only log keeps the door open to a deeper tree cheaply.

This is why v1 keeps `source*Id` + `sourceStampedAt` now: without that provenance
and baseline, none of the above is computable later.

## Rollout (ordered slices — no `phase-N` filenames)

1. **Schema** — `worldCast`/`worldItems`/`worldLocations` snapshots + soft
   `source*Id` + `sourceStampedAt`; soften session library FKs. Migration.
2. **Write paths** — rewire `materializeWorldEntities`, from-draft, session spawn
   to copy; verify `duplicateWorld` simplification.
3. **Read paths** — world/session reads serve from snapshots; world editor edits
   the **world instance**, not the library entity.
4. **Image handling** — ref-aware deletion (same-owner) + the existing
   `image_sweep` integration; cross-owner file duplication wired into the copy op
   (lands with auth's clone/add, see [auth.plan.md](auth.plan.md)).
5. **Delete unblocking** — drop the FK-driven "in_use" 409 on library deletes (it
   no longer applies); confirm worlds/sessions survive a source delete.

## Testing

- Deleting a library entity used by a world and a session **succeeds**; both the
  world and the session are **unchanged** afterward.
- Editing a library entity does **not** change existing world/session copies.
- Editing a world instance does **not** change the library template or other worlds.
- `duplicateWorld` produces an independent world (no shared rows).
- Same-owner image still referenced by a world is **not** deleted on library entity
  delete; an orphaned file is reclaimed by `image_sweep`.

## Docs to update (same change)

- `docs/turn-engine.md` / `docs/authoring.md` — the materialization cascade now
  copies at the world layer; update the data-flow description.
- `docs/database.md` — the new world snapshot columns + soft `source*Id` semantics.
- `docs/architecture.md` — note the library/world/session copy invariant.
- `roadmap.md` — this entry; sequence ahead of auth's visibility seam.

## Open questions

- **Propagation (deferred)** — the additive-merge rules above are a sketch; spec
  them properly when the feature is promoted (likely its own
  `world-instances.propagation.spec.md`).

### Resolved (2026-06-23)

- **Image cross-owner copy** — **duplicate the file** into the new owner's storage
  (self-contained). Same-owner copies share the file with ref-aware `image_sweep`
  cleanup. → §Schema/Images.
- **Forge target** — forge **creates owned library templates and copies them into
  the world in one step**; the library stays the single reuse surface. →
  §Materialization.
