# Intimacy notes — plan

Status: **draft** (not settled — design under review; no code yet).

Design/decisions: [intimacy-notes.spec.md](intimacy-notes.spec.md) — read it
first; it is the truth. This plan is the task list and build order. Builds on the
shipped species note split (`appearance`/`lore`, see
[non-human-species.plan.md](finished/non-human-species.plan.md)) and the phase-4 exposure
mask.

## Goal

A third model-facing species/heritage note — **`intimacy`** — plus a per-character
`profile.intimacy`, **merged and surfaced to the narrator only when the turn's
exposure mask reaches the intimate tier**. Completes the `appearance` (image) /
`lore` (narrator, always) / `intimacy` (narrator, intimate-only) trio.

## Build order

1. **Schema.** `intimacy: z.string().default("")` on `heritageDefinitionSchema`
   and `speciesDefinitionSchema` (`contracts/species/types.ts`);
   `intimacy?: string` on `characterProfileSchema` (`contracts/world/profile.ts`).
   Add `speciesIntimacyNote(speciesId, heritageId)` to `species/registry.ts`
   (heritage **replaces** species; bare text; "" for human/unknown/unauthored).
2. **Gate + narrator block.** `buildIntimateDispositionBlock(bundle, exposure)` in
   `engine/scene.ts` (sight-present NPCs; archetype note + character note merged;
   "" below the gate). Thread through `engine/pipeline.ts` (effective mask) into
   `buildTurnContext` (`engine/prompts/narrative.ts`).
3. **Forge.** Optional `intimacy` line in the profile section
   (`authoring/character-forge.ts`) — short, tasteful, content-aware.
4. **Editor.** "Intimate disposition" textarea on the profile tab
   (`components/characters/character-editor.tsx`), with a "surfaces only in
   intimate scenes" hint.
5. **Authoring.** Write `intimacy` notes for the species/heritages that warrant
   them (succubus, sprite, …); humans/baseline stay empty.
6. **Tests.** Gate on/off (no block below the tier), merge semantics
   (heritage-replaces, archetype+character append), `speciesIntimacyNote`,
   degradation (all-empty ⇒ ""). Reuse the exposure-mask test fixtures.
7. **Docs.** `contracts/body.md` (the third note axis + gate), `prompts.md` (the new
   block + its place in `exposureRules`), `authoring.md` (forge field + editor).

## Open questions

Each is detailed in the spec — see
[intimacy-notes.spec.md §Open questions](intimacy-notes.spec.md#open-questions).

- **Gate trigger** — any-axis-`intimate` (proposed) vs `appearance === "intimate"`
  only?
- **Archetype ↔ character merge** — append (proposed) vs character overrides?
- **Forge generation** — always vs concept/rating-gated?
- **Player note** — NPC-only (proposed) or also surface the player's disposition?
- **Field name** — `intimacy` vs `intimateDisposition`.
- **Helper shape** — bare text vs labeled.
- **World content rating** — can it suppress the block independent of the tier?

## Not in scope (this plan)

Per-relationship intimacy, any meter/mechanic, and player-disposition surfacing —
see [spec §Out of scope](intimacy-notes.spec.md#out-of-scope).
