# Conditions can't change appearance — `attributeEffects` is inert

Status: **analysis / proposal** (2026-06-15). Supplement to
[character-schema-audit.md](character-schema-audit.md) findings **B2** and **B3**.
`ConditionEffect.attributeEffects` is defined, documented as *"overlaid while
active,"* and never materialized. The attribute-overlay precedence tier built to
carry exactly these effects (`condition`/`item`/`magic`/`injury`/`environment`)
is never written. So a condition can impair perception and add a prose hint, but
it cannot actually change how a character looks — which is a core lever for an
intimacy/immersion engine.

## What conditions do today (the consumed half)

`ActiveCondition` (`contracts/conditions/condition.ts:25-46`) carries three
behavior channels; two are live:

- **`senseEffects`** → perception. `senseModsFromConditions` reads them (or maps
  known labels via `SENSE_EFFECT_BY_LABEL`) into per-observer sight/hearing mods
  in the witness matrix (`perception/darkness.ts`, consumed in `scene.ts` and
  `merge.ts`). Blindfolded ⇒ sight blocked; this works.
- **`promptHint`** → narrator. `buildMeterConditionBlock` (`scene.ts:850-865`)
  surfaces `condition: <label> (<severity>) — <promptHint>` in the state-hints
  block. Soft, text-only.
- **`durationMinutes`** → expiry. `expireConditions` (`merge.ts:679`) drops a
  condition once the clock passes `startedAt + duration`.

So conditions are *soft*: they steer perception and nudge the narrator with text,
but they make no mechanical change to the character's attributes.

## What's defined but inert

`ConditionEffect` (`condition.ts:4-9`) and `ActiveCondition.attributeEffects`
(`condition.ts:40`) exist, and the field's own comment says:

```ts
/** Overlaid while active with source "condition", sourceId = condition id. */
attributeEffects: z.array(conditionEffectSchema).default([]),
```

`docs/contracts/conditions.md` §Conditions repeats it. But the only place conditions are
constructed in the engine hardcodes the field empty (`merge.ts:665-674`):

```ts
next.push({ id: newId(), label: event.label, … source: { kind: "narrative" },
  attributeEffects: [],   // ← always empty
  promptHint: event.promptHint });
```

and nothing anywhere reads `attributeEffects` to produce an overlay. The
"overlaid while active" step does not exist.

## The dead source tier (B3, same hole from the other side)

`SOURCE_PRECEDENCE` (`attributes/value.ts:25-35`) reserves the mid band —
`condition`/`injury`/`item`/`magic`/`environment`, all precedence 3, above
`narrative` (2) and below `manual` (4). At runtime **none of these are ever
written** (audit B3). That band was designed for precisely this: a condition or a
worn item shifting appearance, outranking narrator drift but yielding to the human
author. The precedence math is tested (`value.test.ts`); the producers were never
built.

## Why it matters

This is a romance/immersion gap, not a cosmetic one. "Soaked," "disheveled,"
"flushed," "sweaty," "smeared makeup," "messy hair," post-intimacy dishevelment —
these are *appearance* states that should show up in the narrator's impression
**and** the image prompt, auto-expire, and be clearly provenance-tagged. Today a
condition can only whisper a `promptHint`; it can't set `hair.style := mussed` or
`presentation.grooming := disheveled` as a real, gated, expiring overlay. The
phase-4 Decision 2 routed live state (erect/aroused) onto *meters + conditions* on
the premise that conditions could carry the rest — but the conditions-as-overlays
half was never implemented, so conditions remain prose-only.

## A high-leverage detail: the consumer side is already done

The narrator impression and image prompt already resolve through overlays —
`resolveAttributes(p.snapshot.attributes, p.state.attributeOverlays)` at
`scene.ts:785`, `pipeline.ts:915/921`. So **once condition-sourced overlays are
written, they automatically flow into impressions and images** with no consumer
change. The entire missing piece is the *writer*.

## Solutions

Recommended: **A** (materialize, idempotently) + **B-ii** (a deterministic label
map) + the **mutability gate** from
[attribute-mutability.md](attribute-mutability.md). This closes B2 and revives the
`condition` source for a real use case (part of B3).

### A. Materialize `attributeEffects` into overlays, rebuilt each turn

Don't incrementally add on apply and remove on expire — that drifts. Instead,
**recompute** the condition-sourced overlays from the currently-active conditions
after the condition apply/expire step, so the set is always exactly "effects of
conditions active right now":

```ts
// after expireConditions(...) in the per-participant condition step (merge.ts ~1557)
const conditionOverlays = participant.state.conditions.flatMap((c) =>
  c.attributeEffects.map((e) => ({
    id: e.attributeId, value: e.value, source: "condition", sourceId: c.id,
  })));
participant.state.attributeOverlays = [
  ...participant.state.attributeOverlays.filter((o) => o.source !== "condition"),
  ...conditionOverlays.filter((o) => overlaySourceMayChange(defOf(o.id).mutability, "condition")),
];
```

Rebuilding from the active set makes expiry automatic (an expired condition's
effects vanish because it's no longer in `conditions`) and idempotent (re-running
a turn yields the same overlays).

### B. Where `attributeEffects` come from

**B-i — model-supplied.** Extend the simulant `conditionEvents` contract
(`agent-results.ts:62-73`) with an optional `attributeEffects` so the narrator can
attach appearance changes when it adds a condition. Flexible, but needs grounding
(valid id + registry value parse) and the mutability gate, and hands appearance
authority to the model.

**B-ii — a deterministic label map (recommended first).** Mirror the existing
`SENSE_EFFECT_BY_LABEL` pattern (`darkness.ts`) with an
`ATTRIBUTE_EFFECT_BY_LABEL`: known condition labels → effects (e.g. `"disheveled"`
→ `presentation.grooming := disheveled`, `"soaked"` → `skin.texture := wet` /
`hair.style := matted`). Deterministic, safe, no new agent surface; applied when a
condition with a known label is created. Start tight (a handful of high-value
labels), expand as play asks.

B-ii first (deterministic, testable), B-i later as an opt-in extension once
grounding + the mutability gate are in place.

### C. Gate effects through the mutability policy

A condition must only overlay `mutable`/`temporary` attributes — "soaked" can
muss hair, never change `eyes.color` or bone structure. This is the same
`overlaySourceMayChange(def.mutability, "condition")` check proposed in the
mutability supplement: `condition` on an `inherent` attribute is rejected with a
diagnostic. The two fixes share the one policy helper.

### D. The rest of the dead band (B3)

`item` (worn-item appearance effects), `magic` (transformations — see the
mutability doc's transformation seam), `injury`, `environment` can follow the same
materialize-from-source pattern as their features land, or be pruned if not
wanted. `condition` is the highest-value one to wire first; this doc scopes to it.

## Test plan

- **Pure/merge**: adding a `"disheveled"` condition writes a `source: "condition"`
  overlay; `resolveAttributes` surfaces it (above creation/base); it appears in
  `buildGlanceImpressions`. Expiring/ending the condition removes the overlay.
  Re-running the merge is idempotent (no duplicate overlays).
- **Gate**: a condition effect targeting an `inherent` id is dropped with a
  diagnostic (shared with the mutability tests).
- **Degradation**: a condition with empty `attributeEffects` and no mapped label
  behaves exactly as today (prose hint only).

## Open questions

- **Model-supplied vs. label-map** for the effect source (B). Lean label-map
  first.
- **Starter effect set** — which labels get appearance effects in v1 (disheveled,
  soaked, sweaty, flushed)? Tight start.
- **Arousal flush: condition or meter hint?** Decision 2 put arousal on a meter
  with threshold `promptHint`s; a visible flush could instead be a
  condition-with-effect. Decide where the line sits so the two don't both narrate
  it.
