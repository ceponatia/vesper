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

*2026-06-14, from T1/D7.* `anus` is modelled as a body location + body-config
region group (touchable, gated) but has no attribute category. In scope as a
region; descriptive/sensory attributes are a later tight-expansion if play wants
them.

## 4. Fixture body-config

*2026-06-14.* The harbor-house demo characters don't yet set `intimateRegions`
or any intimate attributes (the vocabulary-coverage test excludes the gated
categories). Optional polish: seed the two demo characters' body-config + a
tasteful minimal intimate set so the feature is visible in the seeded world.
