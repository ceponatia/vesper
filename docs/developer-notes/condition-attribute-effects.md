# Condition → attribute effects: the unwired remainder

Status: draft — the open remainder of an otherwise-shipped slice (re-drafted
2026-08-02; the original 2026-06-15 analysis is mostly shipped via
[finished/character-chat-state-narration.spec.md](finished/character-chat-state-narration.spec.md)
§2 — see git history for the original text). Supplement to
[finished/character-schema-audit.md](finished/character-schema-audit.md) findings **B2**
and **B3**. **B2 is closed.** What remains is B3's other four source levels, the
model-supplied effect channel, a missing rejection diagnostic, and two wiring gaps
in the shipped slice.

## What shipped (and how it differs from this doc's proposal)

Commit `4484cb4` (2026-06-30), built to
[finished/character-chat-state-narration.spec.md](finished/character-chat-state-narration.spec.md)
§2 — **not** to this doc directly. The delta matters, because the shipped shape is
cheaper than the one proposed here:

- **`conditionAttributeOverlays(conditions)`** (`contracts/conditions/overlays.ts:20`)
  derives `{ id, value, source: "condition", sourceId }` overlays **at render time**
  from the live condition list. This is Proposal A's intent without Proposal A's
  mechanism: the doc proposed *rebuilding a persisted overlay set* after the
  condition apply/expire step, which needs a filter-and-splice against
  `state.attributeOverlays` and can drift if any writer forgets it. Deriving instead
  of persisting means **nothing is written to `state.attributeOverlays`** — so there
  is no drift surface, idempotency is structural, and expiry is automatic (an expired
  condition is simply absent from `state.conditions`, so its overlays cease to exist).
  `state.attributeOverlays` remains a real persisted column (parsed at
  `engine/chat-state.ts:1097`, written at `:2955`) but carries only `narrative`
  overlays from the archivist (`applyChatAttributeOverlays`,
  `chat-state.ts:1536-1570`).
- **Consumers**, all reading the same helper: the chat system prompt
  (`engine/prompts/character-chat.ts:1942`, and the multi-character member builder at
  `:2483`), affordance reads (`engine/chat-affordances.ts:342`), the scene-image
  prompt (`server/images/character-scene.ts:171`), and the state-tools inspector
  (`components/characters/chat-state-tools.tsx:148`).
- **Proposal B-ii (label map)** shipped as `CONDITION_CATALOG`
  (`contracts/conditions/catalog.ts:22`) with `catalogConditionForLabel` at `:38`,
  seeded by `seedConditionEffects` (`engine/chat-state.ts:3279`) — author-supplied
  effects win; an unrecognised label passes through untouched.
- **Proposal C (mutability gate)** shipped as `overlaySourceMayChange`
  (`contracts/attributes/value.ts:85`), applied inside the derivation at
  `overlays.ts:26`, so a condition can never rewrite an inherent attribute even
  though `resolveAttributes` is unguarded last-write-wins.
- **Tests**: `contracts/conditions/overlays.test.ts` (whole file),
  `contracts/conditions/catalog.test.ts`, and two prompt-level assertions —
  grooming→unkempt at `engine/prompts/character-chat.test.ts:680`, inherent-eye-colour
  rejection at `:698`.

The consumer side the original doc flagged as "already done" held up: no consumer
needed a redesign, only the empty overlay array needed replacing.

## Still open

Four items, cheapest first in practice — **§4 (wiring gaps)** is a same-day fix and
is what currently makes the shipped slice look inert to a player; **§1** is the
largest but is now a pattern extension rather than a design.

### 1. The rest of the dead precedence band (B3's remainder)

`SOURCE_PRECEDENCE` (`contracts/registry/provenance.ts:29-39`) still reserves a
five-member tier-3 band above `narrative` (2) and below `manual` (4):

```ts
narrative: 2,
condition: 3,   // ← the only live member
injury: 3,
item: 3,
magic: 3,
environment: 3,
manual: 4,
```

`condition` is now the **only** one with a producer. A repo-wide search for
`source: "injury" | "item" | "magic" | "environment"` returns exactly one hit, and
it is a precedence unit test (`contracts/attributes/value.test.ts:80`). Four of five
levels remain ceremony.

One caveat on "unwritable": the inspector-grade state PATCH route accepts a whole
`attributeOverlays` array (`app/api/chats/[chatId]/state/route.ts:92`) and
`applyStatePatch` assigns it wholesale with no mutability gate
(`engine/chat-state.ts:3139`), so a client *can* land an `item`-sourced overlay.
That is a passthrough, not a producer — and it cannot be used to escalate by
accident, because `attributeValueSchema.source` leaf-`.catch`es a malformed source
down to `creation` rather than up (`contracts/attributes/value.ts:28`). No feature
mints these levels.

**Why this is now cheap.** The materialize-from-source pattern is proven end-to-end:
a pure `(sources) → AttributeValue[]` helper, a mutability filter, and a spread at
each `resolveAttributes` call site. `item` is the obvious next one — worn-item
appearance effects, where the input already exists (`wornItemIds` on chat state,
route schema `:74`) and would slot into the same five consumer sites. `injury` and
`environment` are speculative until a feature asks; `magic` stays the documented
transformation seam (`value.ts:81-83`). **No other doc owns this band** — if it is
not extended, the honest close-out is to prune the unused levels rather than leave
four reserved tiers implying producers that do not exist.

### 2. Model-supplied `attributeEffects` (B-i)

The original doc proposed extending the simulant `conditionEvents` contract in
`agents/agent-results.ts`. **That file no longer exists**, and neither does that
contract; the surviving `conditionEvents` identifier
(`engine/simulation/material-store.ts:921`) is unrelated engine-lane material
resolution. B-i needs re-targeting, not re-deciding.

Conditions in the chat lane today originate from exactly three places:

| Origin                               | Site                                       | Catalog-seeded?      |
| ------------------------------------ | ------------------------------------------ | -------------------- |
| Catalog seed on the state-patch path | `chat-state.ts:3127`                       | — (it *is* the seed) |
| API state PATCH (`conditions` field) | `app/api/chats/[chatId]/state/route.ts:72` | yes, via `:3127`     |
| Hardcoded `fluster` action chip      | `chat-state.ts:3254-3261`                  | **no** (see §4b)     |

The state-tools "add condition" UI (`chat-state-tools.tsx:158`) constructs with
`attributeEffects: []` but PATCHes through the route, so it inherits the seed.
No model-facing surface can attach an attribute effect at all.

The grounding requirements the original doc named — **valid id + registry value
parse + mutability gate** — no longer need new machinery, because
`applyChatAttributeOverlays` (`chat-state.ts:1536-1570`) already implements all
three for *narrative* attribute changes, with diagnostics and a
`MAX_CHAT_ATTRIBUTE_CHANGES` cap. B-i reduces to: give model-supplied condition
effects the same write-boundary treatment, at the same trust level, with
`"condition"` substituted for `"narrative"` in the gate call. The remaining product
question is unchanged — whether appearance authority belongs to the model at all,
given the catalog covers the deterministic cases.

### 3. The missing rejection diagnostic

Proposal C shipped its *gate* but not its *diagnostic*. `overlays.ts:24-26` drops
both failure modes with a bare `continue`:

```ts
const def = attributeRegistry.byId(effect.attributeId);
if (!def) continue; // unknown vocabulary — never leak a raw id
if (!overlaySourceMayChange(def.mutability, "condition")) continue; // inherent ⇒ dropped
```

This is asymmetric with the narrative path, which emits
`chat_state.attribute.unknown` and `chat_state.attribute.inherent_change_rejected`
into a `DiagnosticSink` for exactly these two cases (`chat-state.ts:1544-1557`). A
condition effect that targets an inherent attribute therefore **vanishes with no
signal anywhere** — the author sees a condition whose stated effect never appears
and has nothing to look at.

Scope note: catalog rows are already covered at *test* time —
`catalog.test.ts:16` asserts every effect resolves to a known attribute and `:25`
asserts every one is mutable, so a bad catalog row fails CI rather than silently
degrading in production. The uncovered surface is **author- and (future)
model-supplied** effects, which arrive through the PATCH route under
`activeConditionSchema` with no mutability check at the write boundary and are then
discarded at render.

That points at the fix. Threading an optional sink into
`conditionAttributeOverlays` only helps three of its five call sites — it is called
per-render, and one caller is a client component (`chat-state-tools.tsx:148`) with
no sink to thread. Gate at the **write** boundary instead (in `seedConditionEffects`
or alongside it on the patch path), where a `DiagnosticSink` is already in hand and
the rejection happens once per save rather than once per render; leave the
render-time guard in place as belt-and-braces.

### 4. Two wiring gaps in the shipped slice

**(a) The catalog is missing its own headline labels.** `CONDITION_CATALOG` holds
three rows — `disheveled`, `unkempt`, `unwashed` (`catalog.ts:23`/`:27`/`:31`) — all
mapping to `presentation.grooming`. The starter set both this doc and the shipping
spec's §2 table named includes **`flushed`, `soaked`, `sweaty`**, and none of the
three exists. `flushed` is the conspicuous one: the spec's own table lists it first,
and it is the only label the app actually mints on its own (§4b).

**(b) The one server-side condition minter bypasses the seed.** The `fluster` chip
creates "Flushed" inline (`chat-state.ts:3254-3261`) with `attributeEffects: []`
hardcoded at `:3260`, and `seedConditionEffects` is wired **only** on the
state-patch path (`:3127`). So adding a catalog `flushed` row would still not fire
there. The spec is explicit that the catalog should apply *"wherever a chat
condition is created (the `fluster`→"flushed" action and `applyChatAction`'s other
chips in `chat-state.ts`, the pulse, and the state-tools 'add condition' path)"* —
only the last of those is covered, and only incidentally, because it routes through
the PATCH.

Label casing is not an obstacle: the chip's label is `"Flushed"` and lookup
normalizes (`catalog.ts:39`, asserted at `catalog.test.ts:11`). The fix is one call
— route the chip's condition through `seedConditionEffects` — plus the missing rows.
Doing (b) without (a), or (a) without (b), changes nothing observable.

## Also record

- **The session-lane framing in the original draft is dead.** Everything the
  original "What conditions do today" section described — `merge.ts`, `scene.ts`,
  `senseModsFromConditions`, `SENSE_EFFECT_BY_LABEL`, the perception witness matrix,
  `contracts/perception/` — was deleted in rollout **R6 (2026-07-22)** along with the
  rest of the legacy world/session model. Everything shipped here is **chat-lane**.
  The only surviving trace of that pattern is a doc comment at `catalog.ts:7`.
- **`senseEffects` now has zero readers.** The field survives on the contract
  (`contracts/conditions/condition.ts:19-23`, `:42`) and nothing in `src/` consumes
  it. It was deferred as **D6** in
  [finished/character-chat-state-narration.spec.md](finished/character-chat-state-narration.spec.md):334
  ("chat has no perception pipeline"), flagged to revisit. It is not in this doc's
  scope; it is recorded here so the next reader does not mistake it for a live
  channel.
- **The arousal-flush question has a newer owner.** The original doc's third open
  question (visible flush as a meter hint vs. a condition-with-effect) is now posed
  more generally as the "Expression mechanism" question in
  [deferred/physiology.plan.md](deferred/physiology.plan.md):190-193 — read-time
  composition vs. condition `attributeEffects` overlays, with the noted risk of
  double-authoring vocabulary the reads already own. Defer to that fork rather than
  re-litigating it here. §4's `flushed` row is a tactical fix to an inconsistency
  in the shipped slice, not a ruling on that question.

## Test plan

Scoped to the open items; the shipped slice's tests
(`overlays.test.ts`, `catalog.test.ts`, `character-chat.test.ts:680`/`:698`) stay as-is.

- **§4b wiring**: applying the `fluster` chip yields a condition whose
  `attributeEffects` are non-empty once a `flushed` catalog row exists, and the
  resulting overlay reaches the system prompt. A second application (the chip is
  `upsertCondition`-based, `chat-state.ts:3268`) is idempotent — one condition, one
  overlay. Extend to any other chip that gains a condition.
- **§4a catalog rows**: new rows are automatically covered by the existing
  known-attribute and mutable-only invariants (`catalog.test.ts:16`/`:25`); add a
  prompt-level assertion per row that the effect actually renders, mirroring the
  grooming→unkempt test.
- **§3 diagnostic**: a PATCHed condition whose effect targets an inherent attribute
  is rejected at the write boundary **with** a diagnostic code, and the surviving
  condition still carries its `promptHint`. An unknown attribute id yields the
  unknown-attribute code and never leaks the raw id into a prompt.
- **§1 extension (when built)**: a second tier-3 source (e.g. `item`) composes
  correctly with `condition` at equal precedence (later entry wins per
  `resolveProvenance`), and still loses to `manual`.
- **Degradation, unchanged**: a condition with empty `attributeEffects` and an
  unrecognised label behaves exactly as today — prose hint only, no overlay, no
  diagnostic.

## Open questions

- **Extend or prune the tier-3 band (§1).** `injury`/`environment` have no candidate
  feature. Leaving four reserved levels with no producers is the same "documented but
  inert" failure this doc originally reported. Decide per level: `item` extend,
  `magic` keep as the declared transformation seam, `injury`/`environment` extend or
  prune.
- **Does the model ever get appearance authority (§2)?** The catalog covers the
  deterministic cases and the grounding machinery already exists, so B-i is cheap to
  build — which makes "should we" the only real question left.
- **Where does the condition-effect gate live (§3)?** Write boundary (diagnostics
  available, once per save) vs. render (already there, but sink-less at two of five
  call sites). Recommended: both, with the diagnostic at the write boundary.
- **How large should the catalog get (§4a)?** It is deliberately small — the headline
  drunk/hygiene cues are *meter*-driven, not condition-driven. `flushed`/`soaked`/
  `sweaty` close the stated starter set; beyond that, add rows as play asks rather
  than pre-populating a vocabulary.
