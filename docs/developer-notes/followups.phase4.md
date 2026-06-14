# Phase 4 followups — the body model

Post-ship tracking for the body-model build ([phase-4-plan.md](phase-4-plan.md),
spec [intimate-anatomy-sensory-and-species-spec.phase4.md](intimate-anatomy-sensory-and-species-spec.phase4.md)).
Dated entries: observation · verdict · proposed fix. Feature-sized items go to a
future phase plan instead.

## 1. Scene-image per-region intimate text (route-aware threading)

*2026-06-14, from T3.* Decision 3 wanted intimate fields in the **scene image
generator** too. Shipped conservatively: the portrait path is fully model-gated
(Qwen includes intimate attributes, Flux excludes), but the scene **composer**
withholds them (`characterAppearanceSummary` defaults `allowIntimate: false`) —
because the composer runs on the moderation-prone gemini `TOOL_MODEL` and the
final scene render route (qwen-edit vs. flux text-to-image) is decided later in
`server/images/scene.ts`, not where the composer context is built. **Scene nudity
still flows** via the region-level `formatExposure` (unchanged). **Verdict:**
acceptable v1; finer per-region intimate text in scenes needs the render route +
per-character exposure threaded into the composer/exposure path so it's allowed
only on the uncensored route when the region is actually exposed. **Proposed fix:**
thread an `allowIntimate` (route-aware + exposure-gated) into
`buildSceneComposerContext` / `formatExposure`.

## 2. Pubic hair (tight-start omission)

*2026-06-14, from T1.* Pubic hair is shared by vulva- and penis-havers, which
breaks the clean category==region-group gating (it would need "vulva OR penis").
Omitted for v1 (Decision 6: start tight). **Proposed fix when wanted:** a single
grooming attribute gated on "any genital region present," or per-region
`vulva.pubic_hair` / `penis.pubic_hair` with distinct aliases.

## 3. Anus has no descriptive/sensory attributes yet

*2026-06-14, from T1/D7.* `anus` is modelled as a body location + body-config
region group (touchable, gated) but has no attribute category. In scope as a
region; descriptive/sensory attributes are a later tight-expansion if play wants
them.

## 4. Fixture body-config

*2026-06-14.* The harbor-house demo characters don't yet set `intimateRegions`
or any intimate attributes (the vocabulary-coverage test excludes the gated
categories). Optional polish: seed the two demo characters' body-config + a
tasteful minimal intimate set so the feature is visible in the seeded world.
