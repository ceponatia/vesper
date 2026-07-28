# Clothing state graph — slice 0 audit

Status: complete — 2026-07-27 (detail doc for
[clothing-state-graph.plan.md](clothing-state-graph.plan.md) §Slice 0; downstream
companion:
[body-attribute-affordances.spec.garment-interaction.md](body-attribute-affordances.spec.garment-interaction.md)).
Every file:line below was re-verified against the tree at `d3e09ac4`, superseding
the review evidence captured at parking time.

---

## Part 1 — Seam map

### 1.1 Chat wardrobe truth

| Seam | Where | Current shape | Gap vs the plan |
| --- | --- | --- | --- |
| Stored worn state | `src/server/db/schema.ts:551,581`; `src/server/engine/chat-state.ts:773-802` | `worn_item_ids` (item-**definition** ids), `outfit_preset_id`, free-text `outfit` overlay, `outfit_exposed` bool — all per `(chat_id, character_id)` | No instance identity, no locus, no per-part state, no condition |
| Player worn state | `src/contracts/players/chat-player-state.ts`; `chat-wardrobe.ts:145-154` | `ChatPlayerState{personaId, wornItemIds, seeded, outfitPresetId, overlay}` on `character_chats.player_state` (chat-wide) | Same gaps; note it is already chat-wide, not per-character |
| The one read seam | `src/server/engine/chat-wardrobe.ts:104-137` (`resolveChatWardrobe`), `:182-208` (`resolvePlayerWardrobe`) | Loads defs → `wardrobeOutfitText` phrase + `exposedRegions` coverage + `wornItemIds` + overlay. Self-heals free-text → structured | Returns a **phrase + 4-region enum**; no garment/part handles, no observations |
| Prompt consumer | `chat-pipeline.ts:989-992,1866`; `prompts/character-chat.ts:742-745,1315-1316,2386-2397` | `state.outfit` is the rendered phrase; one "You're wearing …" line + exposure tone-steer | No authoritative digest, no cue block, no repeat gating |
| Scene image consumer | `src/app/api/chats/[chatId]/scene/queue.ts:97-158` | Passes `wardrobe.garments`, `wardrobe.exposure`, `playerWardrobe.exposure`, `lookKey` | Same phrase-level input |
| State route | `src/app/api/chats/[chatId]/state/route.ts:70-75` (PATCH body), `:159-168` (GET) | `wornItemIds` (≤40) + `outfitPresetId` + `outfit` + `outfitExposed` patchable; GET returns `outfitLabel` | Needs an instance-addressed patch surface |
| State-tools UI | `src/components/characters/chat-state-tools.tsx:103-104,168-169,372-382` → `chat-wardrobe-editor.tsx` (238 ll., `:57-123`) | Preset switcher + per-slot equip/remove over definition ids; slots bucketed by `definition.category` | No part/closure/roll/condition controls, no graph inspector |
| Scenario modal | `src/components/characters/chat-scenario-modal.tsx:210-217` | Persona switch resets `playerState` to `{wornItemIds:[], seeded:false, …}` | A persona switch must also drop/retire that persona's garment instances |

**How the continuity leg mutates the wardrobe today** — (1) the archivist emits
`outfit{description, exposed, removed[], added[]}` + `playerOutfit{…}` as
**free-text garment phrases** (`src/contracts/turns/chat-archivist.ts:126-148`,
`:164-184`), capped at `CHAT_ARCHIVIST_MAX_WORN_CHANGES`; (2)
`foldOutfitProposal` (`chat-state.ts:1424-1459`) / `foldPlayerOutfitProposal`
(`:1479-1513`) seed the worn list from a matched preset, or treat an unmatched
`description` as a free-text replacement that **clears** the structured list;
(3) `applyWornGarmentChanges` (`src/contracts/items/chat-wardrobe.ts:89-133`,
matcher `:54-72`) token-matches deltas against worn items / preset pool —
removal **splices the id out and it is gone**, an unmatched addition appends to
the overlay with `chat_wardrobe.add_overlay`.

Gap: removal is destruction — no "held", no "on the chair", no identity to
return to. And the add-pool filter `!ids.includes(p.id)` (`:117`) makes the worn
list a **set**: a character cannot wear two copies of one definition.

### 1.2 Item definitions

`src/contracts/items/item.ts`; stored in `items.definition` jsonb
(`schema.ts:752-774`), loaded by `loadDefaultWardrobe`
(`src/server/images/avatar.ts:122-160`).

| Field | Line | Consumers |
| --- | --- | --- |
| `coverage: string[]` | `:28` | `exposedRegions`, `resolveWardrobeVisibility`, coverage editor, `isBelowWaist` |
| `layer: 0..3` | `:62` | `resolveWardrobeVisibility` occlusion ordering |
| `opacity: opaque\|sheer` | `:63` | occlusion (`hinted`) + `exposedRegions` (`sheer` region band) |
| `category` | `:33` | authoring templates + wardrobe-editor slot bucketing. **Never prompt-bearing** |
| `subtype` | `:41` | prompt-bearing label (`clothingSubtypeLabel`) |
| `sensory.appearance` | `:64` | garment phrase parens, image prompts |
| `fields: Record<string, unknown>` | `:73` | untyped extras escape hatch — the plan correctly refuses to use it |
| `itemInstanceStateSchema{condition, cleanliness, wetness, open, locked, notes}` | `:83-97` | **none — zero importers in the tree.** Exported via `contracts/index.ts:21`, imported nowhere |

Category templates: `src/contracts/items/clothing-categories.ts:30-57` — 15
entries (top, outerwear, dress, pants, shorts, skirt, bra, underwear, socks,
footwear, gloves, headwear, eyewear, jewelry — plus the doc rule that names never
reach prompts). Body-location registry: `src/contracts/body/locations/`
(`everyday.ts:15-53` coverage-relevant tree; `intimate.ts:60-80` and
`features.ts:34-36` are `coverageRelevant: false`).

### 1.3 Retake / restore machinery — the decisive seam

There is **no per-exchange row history anywhere**. Rollback is exactly two
whole-value JSONB blobs, written and restored wholesale:

| Half | Write | Read | Restore |
| --- | --- | --- | --- |
| Per-character | `savePreExchangeSnapshot` `chat-state.ts:814-827` → `character_chat_state.pre_exchange_state` | `loadPreExchangeState` `:841-856` via `storedChatStateSchema` `:773-802` | `restoreOrDegrade` `chat-pipeline.ts:641-647`, roster-wide at `:769,781,1269,1408` |
| Chat-wide | `savePreExchangeScenario` `chat-state.ts:641-648` → `character_chats.pre_exchange_scenario` | `loadPreExchangeScenario` `:667-675` | `rollbackScenario` `:662-664` (`{...anchor}`, minus `supportingCast`) |

Properties a new garment store must inherit:

- **Membership in one of the two blobs is the entire mechanism.** `wornItemIds`
  rolls back only because it is a field in `storedChatStateSchema:781`.
- **Both anchors are guarded on the prompting message still existing**
  (`:2004-2005`, `:820-822`), so a mid-stream delete writes neither.
- **`{}` is the "no prior state" sentinel**, distinct from a missing row (`:852`,
  `:858-861`) — lose that three-way distinction and first-exchange retakes
  double-apply.
- **Degradation is per-member and independent**: `restoreOrDegrade` falls back to
  live state with `chat_state.snapshot.missing` for *one* member while others
  restore (`chat-pipeline.ts:645`), so a garment split across member rows can be
  duplicated or lost by a partial degrade.
- **The two live writes are not one transaction**: `saveChatState` (`:1957`) and
  `saveChatScenario` (`:1985`) are separate awaited statements.

⇒ **A new table would need net-new snapshot machinery** (per-exchange row copies,
a delete+reinsert restore, its own missing-anchor degradation and `{}` sentinel).
A field inside an existing blob needs none.

### 1.4 Successor item condition

| Piece | Where | Pure & reusable as-is? |
| --- | --- | --- |
| §25 integration kernel | `src/lib/simulation/bodies.ts:249-261` (`MeterIntegrationView`), `:325` (`integrateMeterValue`), `:367` (`solveNextThresholdCrossing`), `modifiersLiveAt`, `thresholdCrossed` | **Yes.** Subject-agnostic — never reads an `actorId`. Fixed-point, analytic, no tick loop, never persists |
| Item-condition kernel | `src/lib/simulation/material-condition.ts` (header `:60-73`; `meterViewOfItem:177`, `initialConditionMetersFor:455`, `buildWornWindowTransition:654`, `buildUseConditionDeltas:799`, `applyItemConditionEvent:990`, `replayItemConditionHistory:1125`) | **Partly.** The numerics are pure, but every entry point takes/returns `SimulationBranchEvent`, `ItemLocus`, branch ids and event envelopes |
| Registry | `src/contracts/simulation/material-condition.ts:61-98` — `cleanliness` (rate, zero base rate, `grimy` @3000 falling) + `wear` (load, `driftLaw:"none"`, `worn_out` @8000 rising); version `item-condition-v1` `:39` | Registry-as-data; the *pattern* transfers. The registry itself is successor-scoped |
| Sources | `:189-191` — `use \| clean \| adjustment` | Too narrow for wetness/deposits; extend, don't fork |
| Events | `:289-361` — initialized / source_applied / modifier_applied / modifier_ended / threshold_crossed | Successor-only (envelopes carry branch + sequence) |
| Tables | `schema.ts:1390-1428` `sim_items` (`conditionTracked:1413`), `:1438-1474` `sim_item_holdings` (one row per item; `locusKind held\|worn\|container\|zone\|gone`, free-text `slotKey`) | Successor-only; branch-scoped |
| Chat surface | `src/server/engine/sim-surfaces.ts:413-450` `readSimChatOutfit` | Joins `sim_items.name` for `locusKind="worn"`, ordered by `slotKey`, `.join(", ")` — a bare name list, degrades to `null` |

**Reuse boundary for chat:** take `lib/simulation/bodies.ts`'s four numeric
functions plus the `BodyMeterDefinition` registry *shape*. Do **not** import
`lib/simulation/material-condition.ts` — every export there is entangled with
branch events. The successor already owns the locus table (`sim_item_holdings`),
which is why the chat lane must not build a second one.

### 1.5 Visibility / coverage / exposure

| Piece | Where | Shape |
| --- | --- | --- |
| Coverage sets | `src/contracts/items/coverage.ts:28-33` `expandCoverage`, `:39-66` `toggleCoverage` | Exploded id sets; parent implies descendants; non-`coverageRelevant` ids never stored |
| Occlusion | `src/contracts/items/visibility.ts:30-69` `resolveWardrobeVisibility` | Per body location, highest `layer` wins; below ⇒ `hidden`, or `hinted` if every item above is sheer. Keyed on `instanceId` |
| Exposure | `:113-118` `EXPOSURE_REGION_LOCATIONS`, `:126-147` `exposedRegions` | 4 regions (torso/pelvis/legs/feet) × `covered\|sheer\|bare`. `FULLY_COVERED:74`, `intimateRegionsBare:82-84` |
| Worn input | `src/server/images/prompts.ts:81-92` `AvatarWardrobeItem`, `:111-119` `toWornInputs` | **`instanceId` is the array index** (`String(index)`); callers look views back up by index (`prompts.ts:124`, `avatar.ts:179`) |
| Phrase render | `src/server/images/avatar.ts:175-193` `wardrobeOutfitText` | Occlusion-filtered, subtype-led, description-primary |
| Image prompts | `src/server/images/prompts.ts:210-216`, `:482`, `:515-519`; `character-scene.ts:163-181` | Consume `RegionExposure` + the occlusion-filtered garment list |
| Intimacy gate | `src/contracts/turns/chat-intimacy.ts:40,63` | Reads `intimateRegionsBare(exposure)` |

Gap: coverage is **whole-garment**. There is no per-part coverage, and the
resolver's identity slot is positional.

### 1.6 The surfaced-cue / captured-cut pattern

There is no `capturedCut` in the chat lane. The live pattern is:

- **Storage**: `surfacedCues: Record<string, string>` — meter id → band string
  (`chat-state.ts:240,354,407,785`; column `schema.ts:581`), inside
  `storedChatStateSchema` so it rolls back with everything else.
- **Selection**: `splitStateCues` (`src/contracts/meters/registry.ts:279-298`) —
  band this cut, `changed = band !== prevBands[id]`, the **single** foreground cue
  is the highest-intensity changed one, the rest are `standing`; `nextBands` is
  persisted by the finalizer (`chat-state.ts:1742,1968`; pipeline `:1229-1230`).
- **Consumption / inspection**: `prompts/character-chat.ts:719-722` renders the
  foreground cue as the one "just shifted" line (standing cues bias tone only);
  `chat-state-tools.tsx:139,457`, patchable via `state/route.ts:81`.

**Shape a garment observation must fit**: a flat `Record<key, band>` map inside
the rollback blob plus a pure `split*(currentReads, prevBands) →
{foreground, standing, nextBands}`. Key = `garment:part:kind` (the plan's
`repeatKey` minus its band suffix); value = the **band alone**, so a change is a
string compare. "One or two cues" ⇒ the same one-foreground rule, optionally
widened to two by intensity.

---

## Part 2 — Recommended rulings

### P — Persistence shape for chat garment instances (feeds slice 2)

**Recommend: one chat-wide `garments` field on `ChatScenario`, backed by a new
`character_chats.garments` jsonb column. Not a new table; not the per-character
state row.**

Decided by §1.3. The entire retake guarantee is "one JSONB blob per anchor,
restored wholesale" — a scenario field inherits `pre_exchange_scenario` +
`rollbackScenario` with **zero** new machinery. Chat-wide rather than
per-character because a garment must sit at loci no character owns (`scene`,
`wardrobe`, `gone`) and move between body, hands and room — and because the two
live writes are not transactional (`chat-state.ts:1957` vs `:1985`) and the two
restores degrade independently (`chat-pipeline.ts:645`), so a cross-blob transfer
could duplicate or lose a garment on a partial degrade. The player's wardrobe is
*already* chat-wide for the same reason. Volume fits: ~6–20 instances, alongside
`sceneMemory` / `plans` / `supportingCast` / `playerState` on that row. Shape:
`{ seeded, blueprints: Record<hash, GarmentBlueprint>, instances: GarmentInstanceState[] }`,
`parseOr`'d to an empty store, capped (`CHAT_GARMENTS_MAX ≈ 48`, `gone` evicted
oldest-first), `.catch/.default` on every field like `storedChatStateSchema`.

*Rejected — a `chat_garment_instances` table.* Buys per-row queries and
cross-chat identity nothing in slices 1–6 needs, and pays with a parallel
snapshot system that must stay bit-exact with two existing ones — the
highest-risk way to satisfy "retake/replay restores graph state … identically".
It also duplicates `sim_item_holdings`, which slice 7 is told to adapt onto
rather than fork. Revisit only if garments must persist across conversations or
carry their own image assets.

*Rejected — a field on `character_chat_state`.* Cannot express `scene` or
`wardrobe` loci, splits player from character garments across two blobs, and
makes every transfer a non-atomic two-row write.

**Migration story for existing `wornItemIds` — lazy, no sweep** (the pattern
`resolveChatWardrobe:111` and `ChatPlayerState.seeded` already use):

1. `resolveChatWardrobe`/`resolvePlayerWardrobe` gain a branch: a non-empty
   `scenario.garments.instances` is the truth.
2. Otherwise materialize from `state.wornItemIds` (character, locus `worn`) +
   `playerWornIds(...)` (player, locus `worn`) + the free-text `outfit` overlay
   carried verbatim as non-mechanical prose — **written on the next state write,
   never on read**.
3. `seeded` breaks the player's ambiguity again: empty + unseeded = "not
   migrated"; empty + seeded = "wearing nothing".
4. `wornItemIds`/`outfitPresetId` survive one release as a **derived projection**
   written from the store (so `chatLookKey`, the equip editor and
   `chatStateSnapshot` keep working), deleted in slice 6 when the digest replaces
   the phrase. Never read as truth once seeded.
5. Applying a preset compiles to transfers: already-worn instances are **kept**
   (condition preserved), missing ones minted, extras moved to `wardrobe`.
6. `outfit_exposed` stops being authoritative once a chat is seeded (today an
   author-settable coverage bypass — `chat-wardrobe.ts:129`, `state/route.ts:75`).

### OQ2 — Chat instance identity

**Recommend: a normalized blueprint *snapshot*, content-hash deduplicated per
chat. Each instance stores `blueprintHash` (+ `definitionId?` as provenance
only); the chat-wide store holds `blueprints: Record<hash, GarmentBlueprint>`.**

Only this shape satisfies all three constraints at once. *Library edits must not
mutate active instances*: the snapshot is a value, not a pointer. *Retakes
restore exactly*: instances **and** their blueprint map ride the same rollback
blob and restore together, so a hash can never dangle across a retake — a
pointer into `items` could, since `items` is not snapshotted and the worn-id path
already silently drops deleted items (`chat-wardrobe.ts:122`). *R2's minted
ad-hoc garments* have no library row at all, so a definition-id scheme has
nothing to store for them. Content-hashing keeps the cost sane — the bloat worry
is really about *duplicated* snapshots, and two identical shirts (or six
uniformed characters) cost one blueprint entry. Hash the normalized blueprint
(sorted node/edge ids, canonical JSON) with the existing `fnv1a`
(`src/server/images/chat-look.ts:33-40`) or `lib/simulation/hash.ts`'s
`simulationHash`.

**Duplicate copies are authored by instantiating twice, never by a second library
row.** Two instances share one `blueprintHash` and differ only in `id`, `locus`,
`presentation`, `condition`; the library keeps one definition, the wardrobe
editor's "add" *is* "instantiate", and a per-slot duplicate control mints N. This
also fixes a live limitation — see wrong-assumption 5 and fixture F5.

*Rejected — definition id + immutable revision/hash resolved from the library at
read time.* It needs blueprint **version history** to survive a library edit (a
new table — exactly the machinery this plan avoids), orphans instances when the
library row is deleted, and has nothing to say about minted garments. A hash you
cannot resolve is worse than a value you can.

### OQ1 — v1 authoring depth

**Recommend: bind garment templates to the *existing* 15 `clothingCategories`
ids (`clothing-categories.ts:30-57`) rather than shipping a parallel vocabulary —
9 get a sparse part graph, 6 stay root-only.** Every item definition already
persists `category` (`item.ts:33`) and the wardrobe editor buckets by it; a
second template list would create two category truths and a mapping between them.

| Category | Parts beyond root | Behaviors |
| --- | --- | --- |
| `top` | front_panel, back_panel, collar, sleeve_l/r (+cuff_l/r), hem, placket | `linear_front_closure`, `rollable_sleeve` ×2, `tuckable_hem` |
| `outerwear` | same + lining | `linear_front_closure` or `zipper`, `rollable_sleeve` ×2 |
| `dress` | bodice_front, bodice_back, collar, sleeve_l/r, skirt_panel, hem, back_closure | `zipper`, `rollable_sleeve` ×2, `hem_lift` |
| `pants` | waistband, leg_l/r, cuff_l/r, fly | `zipper`, `rollable_sleeve` (as cuff roll) ×2 |
| `shorts` | waistband, leg_l/r, hem | — |
| `skirt` | waistband, panel, hem, closure | `zipper`, `hem_lift` |
| `bra` | cup_l/r, band, strap_l/r, back_closure | `adjustable_strap` ×2, `fastener_series` |
| `socks` | cuff | `rollable_sleeve` (cuff) |
| `footwear` | upper, closure | `linear_front_closure` (laces) |
| `underwear`, `gloves`, `headwear`, `eyewear`, `jewelry` | root only | — |

**Material registry: the plan's 7 + `unknown`** — `woven_cotton_linen`, `knit`,
`silk_satin`, `denim`, `wool`, `leather`, `synthetic_shell`, `unknown`
(conservative defaults). One adjustment: do **not** add a "sheer" material —
`baselineOpacity` defaults from the material and is **overridden** by the
definition's existing `opacity: "opaque" | "sheer"` enum (`item.ts:63`), keeping
sheer silk and sheer synthetic distinguishable and the occlusion `hinted` rule
unchanged. The graph inspector is read-only in slice 1, editable in slice 3, and
never mandatory (category template + "Draft from description" is a complete path).

*Rejected — a richer authored topology (per-button nodes, seams, per-panel
materials).* Violates the plan's own §"Model only parts that can change a read",
and every extra node is authoring cost paid on every item.

### OQ6 — Coverage behaviors

**Law:** a behavior may only **subtract** body-location ids from *its own node's*
`baselineCoverage` — never add coverage, never touch another garment, never
decide exposure. Cross-garment exposure stays the existing occlusion pass
(`resolveWardrobeVisibility` → `exposedRegions`) over the resulting per-part
coverage. That makes "two open collar buttons ≠ bare torso" structural, not a
tuned constant.

| Behavior | Channel | Legal on | Can subtract | Cannot produce |
| --- | --- | --- | --- | --- |
| `linear_front_closure` | `closure.fastener_series{count N, openIndexes[]}`, ordered top→bottom | placket / front panel of top, outerwear, dress, footwear (laces) | open fraction `k/N`: ≥0.5 drops `chest`; ≥0.8 drops `waist` | nothing at `k/N < 0.5` — two of six buttons is 0.33, an **observation only**. Never drops `back`, never doffs |
| `zipper` | `closure.continuous{openness}` | outerwear, dress back, skirt, footwear | same thresholds as above, monotone in `openness`; a declared two-way zip reverses the order | `openness = 1` is *open*, never *removed* |
| `rollable_sleeve` | `roll: FixedUnit` | sleeve_l/r, cuff, sock cuff (per side) | ≥0.35 drops `wrists`; ≥0.6 drops `forearms` | never drops `upper_arms` or `shoulders` — a rolled sleeve is not a missing sleeve. Asymmetry is native (one node per side) |
| `adjustable_strap` | `displacement{kind:"off_shoulder", side}` | strap_l/r of bra, dress, top | that side's `shoulders` only | never drops `chest` — a fallen strap is not a bared breast; only a separate bodice displacement can do that |
| `tuckable_hem` | `tuck: "out"\|"partial"\|"in"` | hem of top, dress | **nothing** — presentation/silhouette only | any coverage change at all |
| `hem_lift` (skirt/dress) | `displacement{kind:"lifted", degree}` | hem of skirt, dress | `substantial` drops `thighs`; `extreme` additionally drops this garment's `pelvis` | never bares `groin` directly — it removes *this* garment's coverage and the occlusion pass decides whether an underlayer still covers it |

Thresholds are band boundaries with hysteresis (plan §Condition vector); the
model never sees them.

*Rejected — a coverage-percentage model (each behavior scales a covered-area
float).* It cannot express "the front opens but the back does not", it invites
exactly the raw-percentage leakage the plan forbids, and it makes every read
depend on a tuning constant instead of a topology fact.

### OQ7 — Extraction confidence

**Recommend: drop every operation carrying an invalid part handle, with a stable
diagnostic — and make the garment ROOT an explicitly enumerated handle.** Slice 5
hands the extractor a closed list of opaque handles, so an unmatched handle means
the model hallucinated — and a hallucination about *which* part is not evidence
about the *garment*. Widening a rejected `sleeve_left` into the whole coat turns
a small miss into a visible contradiction and, for presentation operations, a
real coverage change. Concretely:
`{kind: "apply_condition" | "deposit" | "clean", partIds: []}` is **legal and
means the root** (so "rain soaked her coat" needs no fallback — it is a
first-class garment-scoped operation); any *present but unresolvable* `partId`
drops the operation with `garment_op.part_unresolved`, an unresolvable
`garmentId` with `garment_op.garment_unresolved`. `transfer`, `set_closure`,
`set_roll`, `set_tuck`, `restore_presentation`, `damage`, `repair` never fall
back. Traces land in the admin inspector so drop rates are measured, not guessed.

*Rejected — conservative garment-root fallback.* Contradicts the plan's own
"invalid or ambiguous proposals are no-ops with diagnostics", hides extraction
quality behind plausible-looking state, and is unnecessary once the absent-part
case is legal by construction.

### OQ8 — Image invalidation

**How it works today:** two *independent* gates. (a) The enqueue fires only on an
archivist outfit/attribute change (`chat-state.ts:2024-2026`, gated on
`outfitChanged` `:1800-1802`). (b) Only then does the job compute `chatLookKey`
(`chat-look.ts:50-64` — sorted worn ids + overlay + 4-letter exposure fingerprint
+ attribute overlays) and skip on a key match (`chat-reference-images.ts:71` →
`chat-look.ts:92-110`). The prompt itself is a free-text phrase
(`buildChatLookPrompt:67-79`).

**Recommend:**

| Refreshes the `chat_look` anchor | Next scene prompt only |
| --- | --- |
| worn **instance** set changes (don/doff/transfer) | `crease_load` — any band |
| structural presentation bands: closure `fastened\|partly_open\|open`, roll `down\|rolled`, tuck state, any `displacement` kind | `cleanliness` bands |
| `wetness` crossing into `wet`/`soaked` (portrait-visible) | `wetness` `damp`, and every drying step |
| a `deposit_visible` or `damage_visible` observation appearing/disappearing on a visible part | deposit **intensity** changes inside a band; deposit/damage on hidden parts |
| appearance attribute overlays (unchanged) | regional overrides that don't change a whole-garment band |

**And the trigger must widen, or none of this fires.** Gate (a) is
proposal-shaped, so adding condition bands to the key alone does nothing — a band
change with no archivist outfit proposal never enqueues and the look goes
silently stale. Replace `outfitChanged || attributeChanges.length` with a **key
comparison**: the finalizer already holds the resolved wardrobe, so compute the
look key pre- and post-fold and enqueue on difference. That collapses OQ8 into
one decision (what enters the key). Band functions must be hysteretic so the key
cannot oscillate.

*Rejected — every condition channel in the key.* Drying is continuous; each step
would remint an identity anchor (an image generation) for a change invisible at
portrait framing.

---

## Part 3 — Fixture corpus

Fixtures live beside the module under test; all are pure unless marked *(int)*.

| # | Scenario | Operations / events exercised | Assertion that proves it | Owner |
| --- | --- | --- | --- | --- |
| F1 | Asymmetric sleeves | `set_roll{sleeve_left, substantial}` on a `top` blueprint | `sleeve_left.roll > 0`, `sleeve_right.roll == 0`; effective coverage drops `forearms` **left only**; one garment instance, not two | S3 |
| F2 | Two collar buttons open | `set_closure{placket, fastener_series, open:[0,1]}` on N=6 | coverage unchanged (`chest` still covered); exactly one `closure_open` observation emitted; `exposedRegions.torso === "covered"` | S3 |
| F3 | Placket past the threshold | same, `open:[0,1,2,3]` (k/N=0.67) | shirt's own `chest` coverage drops; with a camisole worn under it, `exposedRegions.torso` is still `covered` (occlusion decides) | S3 |
| F4 | Removal to chair | `transfer{jacket, {kind:"scene", placeName:"the study", anchor:"over the desk chair"}}` | jacket contributes **zero** coverage; still exists at its locus; re-entering the place lists it; `wornItemIds` projection no longer contains it | S2 |
| F5 | Duplicate copies | instantiate the same definition twice, doff one | two instances share one `blueprintHash`; distinct `id`s; doffing one leaves the other worn (impossible today — `chat-wardrobe.ts:117`) | S2 |
| F6 | Library edit isolation | mint instance → edit the source `items` row's coverage → re-read | instance coverage unchanged; `blueprintHash` unchanged; diagnostic-free | S2 |
| F7 | Cotton vs leather rain | `apply_condition{wetness, +substantial}` on a `woven_cotton_linen` shirt and a `leather` jacket, same source | cotton reaches a higher saturation and a lower `effectiveOpacity`; leather stays low-absorption; the two produce **different** observation kinds | S4 |
| F8 | Local mud survives drying | `deposit{hem, mud, substantial}` then integrate 6h with no wetting source | whole-garment `wetness` band returns to `dry`; the hem deposit persists at full intensity; the whole-garment cleanliness band still reads soiled | S4 |
| F9 | Regional cleaning | F8 then `clean{partIds:[hem], target: clean}` | hem deposit removed; base cleanliness untouched elsewhere; no new damage marks | S4 |
| F10 | Washing (whole garment) | `clean{partIds:[], target: clean}` | all deposits removed, `cleanliness` at target, `crease_load` unchanged, `damageMarks` **retained** (a wash does not repair a tear) | S4 |
| F11 | Drying is analytic | two integrations to the same story time via different intermediate reads | identical result (partition invariance — the §25 property); no persistence on read | S4 |
| F12 | Hidden underlayers | camisole under a closed opaque shirt, `deposit{camisole, blood}` | camisole observations are suppressed (`visibility: hidden`); no cue emitted; the state is still stored and reappears when the shirt opens past F3's threshold | S3+S6 |
| F13 | Retake exactness | mint + roll + wet + deposit, take another take *(int)* | post-rollback store deep-equals the pre-exchange store — instances, blueprint map, presentation, condition, `integratedAt`, and the observation repeat-key map | S2 *(int)* |
| F14 | Retake with a missing anchor | delete one member's `pre_exchange_state`, retake *(int)* | garment store still restores atomically (it is chat-wide); `chat_state.snapshot.missing` diagnostic is emitted for the member; no garment duplicated or lost | S2 *(int)* |
| F15 | Ambiguous part operation | extractor returns `set_roll{partId:"sleeve_middle"}` | operation dropped; `garment_op.part_unresolved` diagnostic; state byte-identical; turn does not fail | S5 |
| F16 | Garment-scoped condition | extractor returns `apply_condition{partIds: [], wetness}` | applies to the root as a base-vector change (legal, not a fallback); no diagnostic | S5 |
| F17 | Malformed store JSONB | corrupt `character_chats.garments` *(int)* | `parseOr` → empty store + `chat_garments.parse_failed`; the read seam degrades to the `wornItemIds` projection; turn completes | S2 *(int)* |
| F18 | Image agreement | F3's state → narrator digest, exposure gate, and scene-image prompt | all three derive from one `EffectiveCoverageRead`; the image prompt's `RegionExposure` equals the gate's; no surface says "bare" while another says "covered" | S6 |
| F19 | Look-anchor invalidation | drying step vs. doffing the jacket | drying does **not** change `chatLookKey` and does not enqueue; the doff does both | S6 |
| F20 | Repeat gating | unchanged wardrobe across three exchanges, then one roll | exchanges 1–3 emit no fresh garment cue; the roll emits exactly one; its `repeatKey` band lands in the persisted map | S6 |
| F21 | Ad-hoc minted garment (R2) | continuity introduces "a borrowed hoodie" | a real instance is minted from the `outerwear` template with conservative material; it can be doffed and left on a chair; it **cannot** change intimate coverage on its own | S2 |
| F22 | Successor parity | same operations through the successor adapter *(int)* | `item-condition-v1` events replay to the same bands; fork/replay parity holds; `readSimChatOutfit` returns the shared digest, not a name join | S7 *(int)* |

---

## Plan assumptions the audit found to be wrong

1. **`itemInstanceStateSchema` is not "dormant" — it is dead.** `item.ts:83-97`
   defines it, `contracts/index.ts:21` re-exports it, **nothing imports it**. R4's
   "cleanliness/wear bridged for compatibility" therefore has no chat-side
   compatibility burden; the only real bridge target is `item-condition-v1`.
   Recommend **deleting** it in slice 4 (CLAUDE.md: remove, don't wrap).

2. **The `scene` locus has no stable key to reuse.** `ScenePlace` is name-keyed
   with **no id** (`chat-scene-memory.ts:68`), matched case-insensitively, capped
   at 12 with oldest-out eviction (`:21`, `:78-83`) over archivist-proposed free
   text. R3 needs the locus to snapshot the place **name** at drop time, match via
   the same `samePlaceName` normalization, and explicitly survive that place's
   eviction — a garment must never vanish because its room fell out of memory.

3. **"Reuse the existing visibility resolver through a richer input shape"
   understates slice 3.** `resolveWardrobeVisibility` keys on `instanceId`
   (`visibility.ts:30-69`) and every caller passes the **array index** as that id,
   then looks the view back up by `String(index)` (`prompts.ts:111-124`,
   `avatar.ts:177-179`). Per-part coverage makes one garment several inputs, so
   slice 3 must give worn inputs real ids, carry a `garmentId` beside the
   part-level `instanceId`, roll views back up per garment before
   `wardrobeOutfitText` renders, and rewrite both index-keyed lookups — a
   signature change plus two renderer rewrites, not a wider input type.

4. **The `chat_look` refresh is proposal-triggered, not key-triggered.** Adding
   condition bands to `chatLookKey` alone changes nothing: the enqueue
   (`chat-state.ts:2024`) fires only on an archivist outfit/attribute proposal.
   OQ8 must widen the trigger or the anchor goes silently stale.

5. **A character cannot currently wear two copies of one item** — the worn list
   is a set of definition ids and the add pool is filtered by `!ids.includes(p.id)`
   (`chat-wardrobe.ts:117`). OQ2's "how are duplicate copies authored?" is an
   existing defect the instance model fixes (fixture F5).

6. **`outfit_exposed` is still an author-settable coverage bypass** on the
   free-text path (`chat-wardrobe.ts:129`, `state/route.ts:75`). "Coverage,
   narrator authority, and image exposure share one read" is unreachable while it
   stays authoritative; slice 2 must demote it once a chat is seeded (the player
   side already has no such flag, deliberately — `chat-player-state.ts:15`).
