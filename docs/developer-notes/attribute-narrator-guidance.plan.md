# Attribute narrator guidance — plan

Status: **next** — core mechanism SHIPPED 2026-07-13 (see §Shipped so far);
remaining: the vocabulary audit + stored-value sweep (slice 3) and the broader
authoring pass (slice 4).

## Shipped so far (2026-07-13)

Driven by the owner's sensory-drift report ("cheesy" feet narrated as clean /
salty — see [sensory-grounding.followups.md](sensory-grounding.followups.md)):

- **Slice 1 (schema + invariants):** `narratorGuidance` on
  `attributeDefinitionSchema`; `defineAttributeGroup` throws on non-enum
  guidance or keys outside `allowedValues`; registry invariant tests + the
  height-word orthogonality tripwire.
- **Slice 2 (rendering):** both `attributePhrase` renderers
  (`engine/prompts/character-chat.ts` — all call sites incl. the sensory-focus
  block — and `engine/scene.ts` glance impressions) append the gloss as an
  inline parenthetical; no gloss ⇒ byte-identical output. Chat renders glosses
  unconditionally per the 2026-07-13 ruling.
- **Slice 5 (write-side + UI reuse):** `describeConstraint` appends the gloss
  to each listed choice (forge + portrait-extraction prompts); the attribute
  picker shows it as the enum option / enum_list chip tooltip.
- **First authoring batch (sensory palettes only):** the full `feet.smell`
  palette plus shared `INTIMATE_SCENT_GUIDANCE` / `INTIMATE_TASTE_GUIDANCE`
  maps in `contracts/attributes/shared-values.ts` (spread by `vulva.scent`,
  `vulva.taste` — each glossing its own `sweet` augment — and `penis.scent`).
- **Slice 6 (docs):** contracts/attributes.md (field + orthogonality rule),
  prompts.md (render sites), authoring.md (authoring guidance).

Reference docs: [../contracts/attributes.md](../contracts/attributes.md) (the
definition schema this extends), [../prompts.md](../prompts.md) (the blocks that
render it). No separate spec — decisions are recorded inline here.

## Goal

Enum attribute values reach the LLMs bare today — `frame: willowy` — so the
narrator has no idea what _this game_ means by the word or where it sits
relative to its neighbors. Give every prompt-facing enum value an optional,
authored **`narratorGuidance`** gloss rendered inline, the way disposition
bands already do it (`Warmth: warm (openly affectionate and caring)` —
`contracts/personality/traits/disposition.ts`). Same mechanism, new surface:
attributes were the last bare-value vocabulary (trait bands and the conditions
catalog already carry per-value hints).

## Design (decided)

- **Readers get meaning, writers get the menu.** The narrator/chat prompts only
  _interpret_ a chosen value → they get the inline gloss. Agents that _choose_
  values (forge, overlay writers) already receive the full `allowedValues` via
  `describeConstraint` (`authoring/character-forge.ts`) → that stays; we never
  ship whole enum lists to read-side prompts (token multiplication, and a menu
  invites scale-talk in prose and value drift in agents).
- **Field shape:** `narratorGuidance?: Record<string, string>` on
  `AttributeDefinition` (`contracts/attributes/types.ts`) — a **partial** map
  from enum member → short gloss. Enum/enum*list attributes only. Distinct from
  the existing per-\_definition* `promptHints` (phrasing rules like "never state
  height as a number"), which keep their current pooled rendering.
- **Sparse by design.** Only ambiguous or game-calibrated members get an entry
  (`willowy`, `soft` vs `plump`, `toned` vs `defined` vs `athletic`…).
  Self-evident members (`average`, `tall`, `muscular`) get nothing. Exhaustive
  glossing is explicitly rejected — it bloats prompts back toward
  list-shipping.
- **The orthogonality rule (authoring invariant).** A gloss describes **only
  its own attribute's dimension**. `build.frame` guidance may talk silhouette
  and bone structure — never height (that's `build.height`'s job), never
  weight (that's `build.weight_presentation`'s). A gloss that _needs_ another
  attribute's dimension to explain its member reveals an **entangled
  vocabulary word**, which is a bug in `allowedValues`, not a job for
  guidance — fix the word (see the audit slice), don't launder the
  entanglement through the gloss.
- **Ordinal context is allowed when it stays in-dimension:** "slimmer than
  lean" inside a `frame` gloss is fine (it positions the member on its own
  scale); "tall-reading" is not.
- **Register:** sensory/behavioral cues the narrator can show, not dictionary
  definitions — match the trait-band hint voice. Short (roughly ≤ 12 words).
- **Image prompts stay excluded**, same as `promptHints` today
  (`server/images/prompts.ts` — renders lean on the avatar reference).
- **Chat lane renders glosses unconditionally** (ruled 2026-07-13). The chat
  attribute lines live in the prompt-cache-stable segment, so glosses cost one
  cached render — keep them in that stable segment (no per-turn churn).

## Build order

1. **Schema + invariants** (shipped 2026-07-13). `narratorGuidance` on `attributeDefinitionSchema`
   (zod `record`). Registry invariant tests: keys ⊆ `allowedValues`; only on
   enum/enum_list definitions; values non-empty. Optionally a cheap
   orthogonality tripwire: guidance text outside `build.height` /
   `identity.apparent_age` may not match `/\b(tall|short|towering|height)\b/i`
   (extend the blocklist per dimension as authoring reveals leaks).
2. **Rendering** (shipped 2026-07-13). Both attribute renderers append the gloss inline as a
   parenthetical when the resolved value has one:
   - `attributePhrase` in `engine/scene.ts:808` (glance impressions — cost is
     naturally bounded: full impressions only fire on first encounter /
     look-target);
   - `attributePhrase` in `engine/prompts/character-chat.ts:290` and its three
     call sites (attribute lines, sensory cues, chat-state overlays).
     Snapshot/degradation tests: no gloss ⇒ byte-identical output.
3. **Vocabulary audit (entangled members).** Sweep every enum's
   `allowedValues` for members that encode a _different_ attribute's dimension.
   For each rename: update `allowedValues` (+ keep the old word in
   `aliases` so freeform authoring still maps), and run a one-off value-sweep
   script over every storage site of attribute values (library character
   profiles, world snapshot copies, session/chat attribute overlays — the
   audit enumerates the exact tables) so no stored old value survives to fail
   vocabulary validation.
   - **`build.frame` already resolved in code (2026-07-08):** re-scoped to
     skeletal gauge (`delicate / slight / average / sturdy / heavy_boned`) —
     the one dimension not covered by height, weight, musculature, shoulders,
     hips, or waist. This dissolved the entangled members wholesale instead of
     renaming them (`willowy` → height+weight, `athletic` → musculature,
     `curvy` → hips/waist, `broad` → shoulders, `heavyset` → weight). Same
     change: `curvy` alias moved to `hips.width`, `build.musculature` dropped
     `soft` (kept `untoned`; `soft` still means light adiposity in
     `weight_presentation`), `build.height` uses `very_short` (not `dwarfish`
     — fantasy-race token skews image models). Species catalogs (dwarf, orc),
     the forge demo, and the harbor-house fixture were repointed. **The
     stored-value sweep in this slice must still map old frame values** in DB
     rows (`willowy`/`athletic`/`stocky`/`heavyset`/… → nearest new gauge
     value).
   - **Intimate vocabulary expanded in the same session:** `vulva.labia` was
     split into `vulva.labia_majora` + `vulva.labia_minora` (stored rows under
     the dead `vulva.labia` id need the sweep too — map `prominent` →
     `labia_minora: protruding`), and the vulva/breasts groups gained new
     fields (shape, mons, colors, pubic hair, texture, arousal-response
     tendencies; breasts augmentation/fullness/areola). All new values are
     snake_case; augmentation was split out of the size/shape scales per the
     orthogonality rule. `feet.scent` also swapped its space-containing values
     for a larger snake_case palette (`freshly washed`/`neutral` → `clean`,
     `sour` → `sour_sweat`, `cheesy and vinegary` → `cheesy`,
     `erotically stinky` → nearest of `thick_musk`/`feral`) — same sweep
     applies to stored rows.
4. **Authoring pass** (sensory palettes shipped 2026-07-13 — `feet.smell` +
   the shared intimate scent/taste maps; the rest remains). Draft glosses for the genuinely ambiguous enums (build,
   weight/musculature, intimate categories, voice, movement, skin), applying
   the orthogonality rule; owner reviews the batch. Data-only edit per the
   registry philosophy — no migration.
5. **Write-side + UI reuse (ruled 2026-07-13: ships with the core, not
   deferred; shipped 2026-07-13).** `describeConstraint` appends the gloss to each listed choice so
   the forge picks better; the attribute-picker UI surfaces it as option
   tooltip/help text. One authored string, three consumers.
6. **Docs** (shipped 2026-07-13). `contracts/attributes.md` (new field + orthogonality rule),
   `prompts.md` (where glosses render), `authoring.md` (authoring guidance +
   the sparse-by-design rule).

## Open questions

None — both ruled by the owner 2026-07-13 and folded into §Design (chat lane
includes glosses unconditionally) and the build order (slice 5 ships with the
core).

## Not in scope (this plan)

Shipping enum lists to read-side prompts (rejected above); glossing
non-attribute vocabularies that already have per-value hints (trait bands,
conditions catalog); any change to `promptHints` semantics; item/location
attribute _vocabulary_ expansion (they inherit the mechanism for free via the
shared `AttributeDefinition`, but new vocab is separate work).
