# Character-building schema audit

Status: **analysis / report** (2026-06-15). A standalone read of the schemas
behind character creation — the attribute registry, the body model, species,
the realized-body filter, and `CharacterProfile` — looking for unenforced
invariants, dead or aspirational schema, drift between docs and code, and gaps
worth filling. Not a phase plan: findings that graduate into work should move
into the relevant phase plan (or [deferred.plan.md](deferred.plan.md)) and be
struck from here.

Every claim below was checked against the code, not inferred from the docs.
Where it corrects a tempting-but-wrong reading (e.g. "`schedule` is dead"), the
correction is called out inline so the rest of the report is trustworthy.

## What the character schema is (one screen)

A character is a `characters` row whose `profile` JSONB is a
`CharacterProfile` (`contracts/world/profile.ts`):

- **Prose**: `bio`, `personality`, `voice?`, `aliases`.
- **Structure**: `speciesId` + `bodyPlanId` (registry ids), `intimateRegions`
  (body-config), `bodyFeatures?` (additive morphology).
- **Appearance**: `attributes: AttributeValue[]` — provenance-carrying values
  (`{ id, value, source, sourceId?, note? }`) validated against the attribute
  **registry** (`contracts/attributes/`).
- **Wardrobe / time**: `defaultOutfit` (item ids), `schedule`.

Three registries decide what a character *can* be: the **attribute registry**
(78 definitions across 28 categories), the **body-location tree** (humanoid,
~43 nodes incl. intimate + feature locations), and the **species catalog** (8
records, all on the one `humanoid` plan). `realizeBody({ bodyPlanId, speciesId,
intimateRegions, bodyFeatures })` (`species/realize.ts`) is the single gating
filter that intersects them per character and answers "which locations exist,
which attributes apply." It is consumed by the forge vocabulary, the attribute
picker, the narrator impression block, and image-prompt assembly. This part of
the system is genuinely well-built — the registry-as-extension-point principle
holds, and `realizeBody` is the right shape. The findings below are mostly about
schema that was *declared ahead of its consumers* and content that is *authored
but never read*.

---

## Findings

Severity: 🔴 correctness / unenforced invariant · 🟠 functional gap or
read/write asymmetry · 🟡 maintainability / drift · 🔵 future-facing.

### A. Unenforced invariant

**A1 🔴 `mutability` is declared but never enforced — and never read at all.**
*(Full write-up + ranked fixes: [attribute-mutability.md](attribute-mutability.md).)*
`AttributeDefinition.mutability` (`inherent | mutable | temporary`) is documented
in `contracts.md` as *"inherent: narrative can't change it."* Grep finds **zero**
consumers outside the schema definition and tests. The narrative attribute-change
merge path (`engine/merge.ts:1561-1586`) validates participant, known id, and
value schema — but not mutability — then writes a `source: "narrative"` overlay,
which `resolveAttributes` ranks above `creation`/`base`. So a narrator turn can
recolor `eyes.color`, change `identity.gender`, or shift `voice.pitch` — all
flagged `inherent` — and the change sticks. The invariant the docs promise does
not exist in code. *Verified: `rg mutability` returns only the type def and
tests; merge.ts write path read in full.*

### B. Aspirational schema — built, advertised, never exercised

**B1 🟡 Attribute `aliases` + `registry.resolveAlias()` have no caller.**
`contracts.md` advertises `resolveAlias(text)` for *"NLP mention resolution
('ginger' → hair.color)"*, and most attribute groups dutifully carry `aliases`.
The alias index is built (`registry.ts:64-69`) and the method exists
(`registry.ts:77`) but is **never called** anywhere in `src/` outside its own
test. Every alias array is dead weight today. *Verified: `rg resolveAlias`.*

**B2 🟠 `ConditionEffect.attributeEffects` is inert.**
*(Full write-up + fix, jointly with B3: [condition-attribute-effects.md](condition-attribute-effects.md).)* `condition.ts:40` defines
`attributeEffects: ConditionEffect[]`, and `contracts.md` §Conditions states they
are *"overlaid while active with source: condition, sourceId: condition id."*
That overlay step does not exist: the only place conditions are constructed in
the engine (`merge.ts:672`) hardcodes `attributeEffects: []`, and nothing reads
the field to produce overlays. A condition can *say* it makes someone's
`build.posture_default` "hunched," but the resolver never sees it. *Verified: `rg
attributeEffects` → schema def + one always-empty construction.*

**B3 🟠 Five of nine attribute sources are never produced.**
`SOURCE_PRECEDENCE` enumerates `base · creation · narrative · condition · injury
· item · magic · environment · manual`. At runtime only **four** are ever
written: `base`/`creation` (profile + forge), `manual` (editor —
`attribute-helpers.ts:17`), `narrative` (merge — `merge.ts:1573`). The entire
mid-precedence tier (`condition`/`injury`/`item`/`magic`/`environment`) is
unreachable; `value.test.ts` exercises the precedence math with them, but no
engine code emits them. This is the same hole as B2 from the other side — the
precedence ladder was built for condition/item-driven appearance changes that
were never wired. *Verified: `rg 'source: "(condition|injury|item|magic|environment)"'`
→ no matches in non-test code.*

**B4 🟡 `species.attributeRules` is empty on every species, and only `forbidden`
is consumed.** The `AttributeRule` primitive (`rules/attribute-rule.ts`) carries
`required | optional | forbidden` plus `defaultValue` / `allowedValues` /
`disallowedValues` narrowing — a rich port from aionchat. But all 8 species ship
`attributeRules: []`, and `realizeBody` reads **only** the `forbidden`
applicability (`realize.ts:80-82`); `required`, `optional`, and all three value
fields have no consumer. The schema is ~5× larger than its live surface.
*Verified: `rg attributeRules:` → all `[]`; realize.ts read in full.*

**B5 🟡 Body-plan / entity-kind targeting checks can't fire.**
`appliesToBodyPlans`, `excludesBodyPlans`, and `appliesToEntityKinds` are checked
by `realize.ts:85-87`, and `contracts.md` notes they are *"(previously inert) now
consumed here."* True in the narrow sense that the branches execute — but **no
attribute definition sets any of them**, and there is only one body plan, so the
body-plan branches are unreachable and the entity-kind branch always passes
(everything defaults to `["character"]`). The wiring is real; the data to
exercise it is absent. *Verified: `rg` across `groups/` → no occurrences.*

### C. Authored-but-unconsumed character content

This is the highest-value cluster: the forge spends model calls (and the author
spends effort) producing fields that never influence a turn. *(Full write-ups:
[unconsumed-character-prose.md](unconsumed-character-prose.md) for C1/C2,
[schedule-authoring-gap.md](schedule-authoring-gap.md) for C3.)*

**C1 🟠 `profile.personality` never reaches a prompt.** The forge profile section
explicitly generates *"a personality sketch (quirks, humor, flaws)"*
(`character-forge.ts:155,180`), and `fillBundlePlayerToken` token-substitutes it
(`bundle.ts:250`) — but no prompt builder reads `snapshot.personality`. The only
characterization that reaches the narrator is **bio**: NPC bio via the canonical
facts block (`scene.ts:692`) and *player* bio via `playerContext`
(`pipeline.ts:640` → `narrative.ts:150`). NPC personality is dead at runtime.
*(The bundle token-fill is defensive plumbing, not consumption — it does not make
the field live.)* *Verified: `rg personality` across `engine/prompts`,
`scene.ts`.*

**C2 🟠 `profile.voice` (free text) never reaches a prompt, and duplicates the
voice attributes.** There are two representations of "voice": the free-text
`CharacterProfile.voice` and the `voice` attribute category (`pitch`, `timbre`,
`accent`, `cadence`). The narrator's voice impression uses the **attributes**
(`scene.ts:767` filters `def.category !== "voice"`); the free-text field is
filled by the forge, token-substituted in the bundle (`bundle.ts:251`), and
otherwise ignored. Redundant and dead. *Verified: only `bundle.ts` touches
`snapshot.voice`; scene/voice impression reads voice-category attributes.*

**C3 🟠 `profile.schedule` is read by the engine but has no authoring path
(read/write asymmetry).** *Correction to a tempting "schedule is dead" reading:*
it is very much consumed — `merge.ts:1724` calls `scheduleEntryAt(...)` on every
schedule tick to place NPCs (the phase-3/5 movement seam). The gap is the
*other* direction: **nothing writes it.** Not the forge (the profile section
emits no schedule), not the character editor (no schedule control —
`character-editor.tsx`), not the create body beyond accepting raw `profile`
JSONB. The NPC schedule system can only ever read `[]` unless someone hand-edits
the DB. *Verified: `rg schedule` across authoring/api/components → no writer.*

**C4 🟡 `profile.aliases` is used only for name-matching, never as narrator
phrasing.** Aliases ground mention resolution in merge/memory but are never
offered to the narrator as alternate ways to refer to a character. Minor; noted
for completeness.

### D. Vocabulary hardcoded in the UI instead of derived from the registry

**D1 🟡 The attribute picker hardcodes anatomy nesting.**
`attribute-picker.tsx` carries local constants `NESTED_UNDER_CHEST = ["breasts"]`
and `PELVIS_CATEGORIES = ["vulva","penis","testicles"]`, plus literal `"chest"` /
`"hips"` category checks and `"Pelvis"` / `"Anus"` labels, to render intimate
categories under a synthetic "Pelvis" area (followups.phase4 §7). The
nest-under-area relationship is presentation that belongs in contracts — e.g. a
`uiArea`/`nestUnder` hint on `BodyLocation`, or a small exported map — so a new
anatomy group (the supplemental-anatomy port) doesn't require editing the
component. The followups doc already half-acknowledges this ("If a future
everyday pelvis/groin group lands… it slots into the same Pelvis area" — today
that's a code edit, not data).

**D2 🟡 Forge-section and layer-label lists are duplicated in components.**
`character-forge-page.tsx` re-declares the `profile`/`attributes`/`outfit`
section list that already lives in `lib/client/api.ts`, and `outfit-editor.tsx`
re-declares layer labels `["underwear","base","mid","outer"]` that mirror the
item schema. No shared source of truth; they can drift independently.

### E. Structural gaps & fragilities

**E1 🟠 Gender→`intimateRegions` seeding is fragile.**
*(Full write-up + fixes: [intimate-defaulting.md](intimate-defaulting.md).)* `defaultIntimateRegionsForGender`
seeds the body-config from `identity.gender` at forge time. But `identity.gender`
is flagged `identityAnchor` and **not** `coreVisual` (`groups/identity.ts`) — so
unlike hair/eye color it is *not* force-filled. If the model never emits gender
(weak signal in the prompt), `defaultIntimateRegionsForGender(undefined)` → `[]`
→ the character silently has no intimate anatomy. Compounding it, editing gender
in the editor afterward does not re-seed regions (documented as intentional —
"stored body-config is authoritative thereafter"). The net effect is a default
that is easy to lose without any signal to author or model. *Verified: identity
group flags; forge seeding path.*

**E2 🟡 The canonical-facts block bypasses `realizeBody`.**
`buildCanonicalFactsBlock` (`scene.ts:686`) calls `resolveAttributes` directly
with no realized-body gating — the one attribute-reading prompt surface that
does. It is **safe today** because it only extracts `identity.apparent_age` plus
bio, neither of which is body-gated. But it is the seam where a future "add the
character's eye color / build to canonical facts" change would leak intimate or
species-forbidden attributes ungated. Worth a guard or at least an explanatory
comment so the next editor doesn't widen it naively.

**E3 🔵 `identity.species_presentation` and `speciesId` can silently disagree.**
**Resolved (2026-06-15):** the divergence is eliminated — `identity.species_presentation`
was removed and the app unified on `speciesId` (the editor's Species dropdown is the single
species field; the species label + optional `lore` is surfaced to the narrator and image
prompts via `speciesPromptPhrase`). Decision 8 is thereby reversed. The analysis below is
retained for history.
Decision 8 deliberately separates the structural id (`speciesId: "human"`) from
the free-text presentation (`species_presentation: "wood-elf"`). Nothing
reconciles or flags a contradiction, and the two are produced by different forge
sections (species inference vs. the attribute agent), so a "human" character with
elven presentation text is reachable. Not necessarily wrong (a half-elf, an
illusion), but there's no diagnostic when structure and presentation diverge.

**E4 🔵 One body plan.** All 8 species share `humanoid`; `bodyPlanId` is
effectively constant. Known and intentional (structural plans are deferred — see
the non-human-races doc), noted so the body-plan machinery in B5 reads as
"awaiting data," not "broken."

---

## Recommendations

Prioritized; each is small unless marked. Framed to match the codebase's own
conventions (registry/data edits, `parseOr` at boundaries, diagnostics over
exceptions, degraded defaults).

### Quick wins (decide enforce-or-delete; either resolves the drift)

1. **`mutability` (A1)** — *enforce*: in `merge.ts`'s narrative attribute-change
   loop, skip (or downgrade to a diagnostic) any change whose
   `attributeRegistry.byId(id).mutability === "inherent"` — a few lines, and it
   makes the doc honest. *Or delete* the field + the `contracts.md` claim. Pick
   enforce: "the narrator can't retcon eye color" is a real correctness property
   for a continuity-sensitive engine. **Detailed proposal with code sketches,
   test plan, and the transformation seam:
   [attribute-mutability.md](attribute-mutability.md).**

2. **`personality` / free-text `voice` (C1, C2)** — *surface*: add a one-line NPC
   characterization to the narrator (personality drives *how the world reacts*,
   the cheapest high-value signal the forge already produces); fold free-text
   `voice` into the voice-attribute `promptHints` path or feed it as a phrasing
   hint. *Or stop generating them* in the forge and drop the fields. Surfacing is
   the better call — the content already exists and is exactly what a romance
   engine wants in the prompt. **Detailed proposal:
   [unconsumed-character-prose.md](unconsumed-character-prose.md).**

3. **Declarative anatomy nesting (D1)** — move `NESTED_UNDER_CHEST` /
   `PELVIS_CATEGORIES` into contracts as a `uiArea` hint on `BodyLocation` (or a
   small exported map) so the picker reads it instead of hardcoding it. Removes
   the future-anatomy-port code edit.

### Medium

4. **Schedule authoring (C3)** — add a schedule editor section (the read side and
   the `scheduleEntrySchema` already exist), or, if NPC schedules aren't wanted
   yet, say so and stop the movement system depending on a field nothing can
   write. The current state — a live consumer with no producer — is the worst of
   both. **Detailed proposal (incl. the world-location binding wrinkle):
   [schedule-authoring-gap.md](schedule-authoring-gap.md).**

5. **Resolve the condition/overlay story (B2 + B3)** — either implement
   `attributeEffects` materialization (walk active conditions, emit
   `source: "condition"` overlays keyed by `sourceId`; the precedence tier was
   built for exactly this and it would make conditions like "soaked"/"disheveled"
   actually shift appearance), or prune `attributeEffects` and the five unused
   sources down to what's produced. Implementing is the more valuable path for an
   intimacy engine (arousal/dishevelment as real overlays); pruning is the
   honest minimum. **Detailed proposal (idempotent rebuild, label-map, shared
   mutability gate): [condition-attribute-effects.md](condition-attribute-effects.md).**

### Larger / future (fold into a phase plan when picked up)

6. **Populate `species.attributeRules` and extend realize beyond `forbidden`
   (B4)** — elf pointed ears, orc tusks, goblin stature via `required` +
   `defaultValue`, which is phase 4's own stated success test ("a second humanoid
   species should be a single data file"). Today it's a data file *plus* teaching
   `realizeBody` to consume `required`/`defaultValue` narrowing. Tracked-adjacent
   in [non-human-races-and-features.deferred.md](non-human-races-and-features.deferred.md).

7. **Decouple intimate defaulting from a fragile gender read (E1)** — make
   `identity.gender` `coreVisual` (so it's always filled), or re-derive
   `intimateRegions` from the resolved gender at *save* time, or surface an
   explicit author prompt when both gender and body-config are empty. **Detailed
   proposal (why force-fill alone doesn't fix it): [intimate-defaulting.md](intimate-defaulting.md).**

8. **Decide the fate of attribute `aliases` (B1)** — wire `resolveAlias` into
   fact/mention extraction (the merge/memory layer already does fuzzy *name*
   grounding; attribute-mention grounding is the adjacent missing half), or prune
   the alias arrays. Don't leave an advertised registry method with no caller.

---

## Already tracked elsewhere (not new work)

To avoid double-planning, these adjacent items are already recorded:

- **Additive features + non-human species (image prompting, richer species
  rules, wardrobe accommodation)** — [non-human-races-and-features.deferred.md](non-human-races-and-features.deferred.md).
  Recommendation 6 above overlaps its "richer species rules."
- **Anatomy port granularity / supplemental anatomy** (buttocks, groin, abdomen,
  nose …) — [supplemental-anatomy.phase4.md](supplemental-anatomy.phase4.md). The
  D1 nesting fix should land *before* this port so the new groups slot in as data.
- **Pubic hair, anus attributes, demo body-config** — [followups.phase4.md](followups.phase4.md)
  §2–4.
- **`runtime` mutability tier, `requiresAttributes`/`conflictsWithAttributes`,
  `itemSchema`/`collection`** — explicitly deferred in [phase-4-plan.md](phase-4-plan.md)
  §Out of scope. Note these are *deferred* (a known parking lot); the A–B
  findings above are *drift* (built and advertised as live, but inert) — a
  different category that warrants enforce-or-delete now.

## Summary table

| # | Sev | Finding | Verified | Tracked? |
|---|-----|---------|----------|----------|
| A1 | 🔴 | `mutability` unenforced & unread; narrator can change `inherent` attrs | yes | no |
| B1 | 🟡 | Attribute `aliases` / `resolveAlias` — no caller | yes | no |
| B2 | 🟠 | `ConditionEffect.attributeEffects` inert (doc says overlaid) | yes | no |
| B3 | 🟠 | 5/9 attribute sources never produced | yes | partial (P4 out-of-scope) |
| B4 | 🟡 | `species.attributeRules` empty; only `forbidden` consumed | yes | adj. (non-human doc) |
| B5 | 🟡 | bodyPlan/entityKind targeting checks can't fire (no data) | yes | no |
| C1 | 🟠 | `personality` never reaches a prompt | yes | no |
| C2 | 🟠 | free-text `voice` never reaches a prompt; dup of voice attrs | yes | no |
| C3 | 🟠 | `schedule` read by engine, no authoring path | yes | no |
| C4 | 🟡 | `aliases` not surfaced to narrator | yes | no |
| D1 | 🟡 | Picker hardcodes anatomy nesting | yes | partial (followups §7) |
| D2 | 🟡 | Forge-section / layer lists duplicated in UI | yes | no |
| E1 | 🟠 | Gender→`intimateRegions` seeding fragile (gender not `coreVisual`) | yes | no |
| E2 | 🟡 | Canonical-facts block bypasses `realizeBody` (safe today) | yes | no |
| E3 | 🔵 | `species_presentation` vs `speciesId` can diverge silently | yes | yes (2026-06-15: field removed, unified on `speciesId`) |
| E4 | 🔵 | Single body plan; bodyPlan machinery awaits data | yes | yes (deferred) |
