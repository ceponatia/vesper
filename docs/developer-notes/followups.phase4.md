# Phase 4 followups — the body model

Post-ship tracking for the body-model build ([phase-4-plan.md](phase-4-plan.md),
spec [intimate-anatomy-sensory-and-species-spec.phase4.md](intimate-anatomy-sensory-and-species-spec.phase4.md)).
Dated entries: observation · verdict · proposed fix. Feature-sized items go to a
future phase plan instead.

## 1. Scene-image per-region intimate text (route-aware threading) — RESOLVED

*Raised + resolved 2026-06-14.* Decision 3 wanted intimate fields in the **scene
image generator** too. Now shipped: `intimateSceneAppearance(attributes, exposure)`
builds a visible intimate-anatomy phrase **exposure-gated** (a region surfaces only
when it reads `bare`/`sheer`; sensory scent/taste never render). It's precomputed
on each present character in `buildSceneComposerContext`, carried through the plan
(`SceneCharacterSpec.intimateAppearance`), and emitted into the final render prompt
by `buildSceneRenderPrompt` **only when `allowIntimate` is set** — which
`renderSceneImage` passes only on the uncensored Venice/Qwen reference-edit route,
never the Flux text-to-image fallback. The moderation-prone gemini **composer**
never sees it (it's injected at render assembly, not via the composer LLM). So a
scene image shows explicit anatomy iff: the character has it (realized) **and** the
region is exposed **and** the route is uncensored.

## 2. Pubic hair (tight-start omission)

*2026-06-14, from T1.* Pubic hair is shared by vulva- and penis-havers, which
breaks the clean category==region-group gating (it would need "vulva OR penis").
Omitted for v1 (Decision 6: start tight). **Proposed fix when wanted:** a single
grooming attribute gated on "any genital region present," or per-region
`vulva.pubic_hair` / `penis.pubic_hair` with distinct aliases.

## 3. Anus has no descriptive/sensory attributes yet

*2026-06-14, from T1/D7. Updated by §5.* `anus` is a body location (now
**universal**, not a gated region group — see §5) with no attribute category.
Touchable + exposure-gated; descriptive/sensory attributes are a later tight-
expansion if play wants them (aionchat ships none either — it has no `anus`
anatomy file).

## 4. Fixture body-config

*2026-06-14.* The harbor-house demo characters don't yet set `intimateRegions`
or any intimate attributes (the vocabulary-coverage test excludes the gated
categories). Optional polish: seed the two demo characters' body-config + a
tasteful minimal intimate set so the feature is visible in the seeded world.

## 5. Anus made universal (was a gated region group) — RESOLVED

*Raised + resolved 2026-06-14, from play.* **Observation:** in the character
editor's Body configuration, clicking the **anus** toggle "did nothing" — it
unlocked no attribute group (anus has none), so it read as broken even though the
selection persisted. **Investigation:** anus was an `intimateGroup`-tagged
location *and* a member of `INTIMATE_REGION_GROUPS`, so it behaved like a per-
character toggle — but every body has one, and there's no descriptive attribute
to show when it's "on." Modelling universal anatomy as an opt-in toggle was the
real bug. The body-config round-trips correctly (save sends `draft.profile`, load
re-parses through `characterProfileSchema`) — **not** a persistence bug.
**Verdict + fix:** anus is now **universal** — the `anus` location drops its
`intimateGroup` (so `realizeBody` always includes it) and "anus" is removed from
`INTIMATE_REGION_GROUPS` (so it's no longer a toggle). It stays in `intimate.ts`
(moderation-sensitive, exposure-gated) and parented to `pelvis` (covered by any
pelvis garment). Regression test in `species/realize.test.ts`
("anus is universal, not a configurable region group"). Docs: `contracts.md`
§Intimate anatomy + the spec D7 note updated.

## 6. Body-config toggle feedback — RESOLVED (via §5 + §7)

*2026-06-14.* The "clicking does not actually add it" symptom (§5) was a
**feedback** gap, not data loss: a toggled region with no attribute group (anus)
showed no change. Resolved structurally — anus is no longer a toggle (§5), and the
genital regions now surface as nested sub-groups under the **Pelvis** area the
moment they're switched on (§7), so every toggle has a visible effect. The anus
itself shows as a present-region note in the Pelvis area.

## 7. Intimate attribute groups nested under anatomical areas — RESOLVED

*Raised + resolved 2026-06-14, from play.* **Observation:** `breasts`, `vulva`,
`penis`, `testicles` appeared as **new top-level sections** in the attribute list,
floating loose. **Verdict + fix:** the attribute picker
(`components/characters/attribute-picker.tsx`) now nests them under their
anatomical area — **Breasts** inside the everyday **Chest** section, and a
synthetic **Pelvis** area (placed next to Hips) hosting **Vulva / Penis /
Testicles** + the universal anus note. Nesting is driven by `NESTED_UNDER_CHEST` /
`PELVIS_CATEGORIES` constants; a category renders nested *or* top-level, never
both. Section "N set" counts roll up nested sub-groups. (If a future everyday
`pelvis`/`groin`/`buttocks` attribute group lands — see
[supplemental-anatomy.phase4.md](supplemental-anatomy.phase4.md) — it slots into
the same Pelvis area.)

## 8. Removed clothing always read as "held" — RESOLVED

*Raised + resolved 2026-06-15, from play.* **Observation:** when the narrator has
a character take off a garment that ends up on the ground ("kicking off her
sneakers… they drop to the floor with two quiet thuds"), the UI showed her
**holding** them. **Investigation:** the simulant emitted a bare `remove`, and
`planItemEvent`'s `remove` case unconditionally transitioned worn → **held**
(`merge.ts`). The end-state was representable (`drop`/`place` → at-location), but
required a second event the agent wasn't reliably emitting, and `held` is only the
right default when prose doesn't say where the garment goes. **Verdict + fix:**
`remove` now honors the event's already-present `containerName` (stow off-body in
a container) / `locationName` (drop in the open at that location — an unresolvable
phrase like "the floor" falls back to the actor's room), defaulting to **held**
only when neither is given. One event, no chaining, and `remove`'s instance
selection already prefers the *worn* pair. The simulant prompt
(`engine/prompts/agents.ts`) was tightened to set the destination for
dropped/kicked-off/stowed garments. Container placement is shared with `store_in`
via `planStoreInContainer`. No schema/DB change (fields existed; rides JSONB).
