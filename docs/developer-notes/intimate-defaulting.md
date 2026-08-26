# Fragile intimate-anatomy defaulting — open remainder

Status: draft — the open remainder of an otherwise-shipped fix, **re-verified
against the code 2026-08-07; §3b shipped that day, everything else stands**.
`seedBodyConfigFromAttributes` now has three call sites, the third being the
persona create path; `intimateRegions` still carries no provenance field on
either body; and no `body_config` diagnostic exists anywhere in `src/`.
Re-drafted 2026-08-02; the original 2026-06-15 analysis's headline fix shipped
same-day in `9ed4e31` + `c7d45fd` (see git history for the original).
Supplement to
`character-schema-audit.md` finding **E1**.
The remaining work has no owning plan and no roadmap line — §1, §2 and §3a are
queued nowhere. (§3b shipped 2026-08-07.)

Line references were refreshed on 2026-08-07 and drift with every edit to the
files named; symbol names are the durable half.

E1 was: the per-character body-config (`intimateRegions`) is seeded from
`identity.gender` at forge time, gender was not force-filled, so a weak-signal
prompt silently yielded a character with **no intimate anatomy** — and the empty
default was indistinguishable from a deliberate authorial choice.

The forge half of that is fixed, and so is the persona half (§3b, 2026-08-07):
personas had no seeding at all, which was the live re-occurrence of the E1
failure mode on the player's own body. What survives is what the original doc
filed under B, C, and D: **the body-config still records no provenance and still
never re-derives**, so it can go stale the moment an author changes gender, and
a character create that arrives *with* attributes is still not seeded.

## What shipped (evidence)

**Proposal A — `identity.gender` is `coreVisual`.** `9ed4e31` set
`coreVisual: true` with `defaultValue: "female"`
(`src/contracts/attributes/categories/identity.ts:33-34`; the comment there
cites *"was audit E1"*). The fill gate is `fillVisualDefaults`
(`src/server/authoring/character-forge.ts:1086`, gate at `:1098`), called from
`:1005`, so gender is always present on a forged draft.

**A's blocking caveat is gone.** The original doc argued A was not a standalone
fix because a tier-3 pick of `androgynous` still returned `[]`, so A only
populated anatomy by *forcing a binary gender*. `c7d45fd` (2026-06-29) removed
that trade-off by splitting the enum into born-sex variants — `female`, `male`,
`androgynous_born_female`, `androgynous_born_male`, `nonbinary_born_female`,
`nonbinary_born_male` — and giving **every one of the six** an anatomy
activation (`identity.ts:39-46`). An androgynous-born-female now seeds natal
female anatomy and is one editor toggle from anything else. **No gender value
seeds `[]` anymore.**

**Proposal D's mechanism (not its design question).** `activatesGroups` is a
declarative per-attribute-value map on the attribute definition
(`src/contracts/attributes/types.ts:189`), consumed by the pure
`seedBodyConfigFromAttributes` (`src/contracts/species/seed.ts:24`, described in
its own doc comment as *"the generalization of the old gender→intimateRegions
special case"*), which unions activated groups across all values for both
`intimateRegions` and `bodyFeatures`, validating ids against the body-config
vocab. `defaultIntimateRegionsForGender` is deleted. Tests:
`src/contracts/species/seed.test.ts`. Docs: [../contracts/body.md](../contracts/body.md)
and [../contracts/attributes.md](../contracts/attributes.md) §attribute
flags. The forge call site is `character-forge.ts:1025`.

**Net.** The forge happy path is correct: gender is always filled, every value
activates anatomy, the seed is declarative and tested. Anything the rest of this
doc describes is downstream of *not going through the forge*, or of *changing
things after creation*.

**Not shipped: Proposal C.** No `forge.character.body_config.unresolved`
diagnostic exists — grepping `body_config` across `src/` returns nothing. It was
never needed on the forge path, but §3 argues it is needed elsewhere.

## 1. No provenance, no re-derivation (Proposal B — 0% built)

Every claim the original doc made about B is still true verbatim.

- **No provenance flag.** `intimateRegions` is a bare array with a `[]` default
  on both bodies: `src/contracts/world/profile.ts:246` and
  `src/contracts/players/persona-profile.ts:51`. Nothing anywhere records
  whether a given value was seeded or authored.
- **No re-seed on save.** The character PATCH
  (`src/app/api/characters/[id]/route.ts:79`) merges the profile patch and
  runs `materializeBodyDefaults` over the merged attributes — it re-materializes
  *persisted-baseline facts*, which is a different mechanism, and never calls
  `seedBodyConfigFromAttributes`. The persona PATCH
  (`src/app/api/personas/[id]/route.ts:48`) does the same and no more.
- **No re-seed on gender edit.** The body-config is wired as a pure manual
  toggle in both editors: `src/components/characters/character-editor.tsx:334-335`
  and `src/components/personas/persona-editor.tsx:209-210` both hand
  `intimateRegions` straight to `patchProfile` with no gender dependency.

**Edit-time staleness is fully intact.** Switch a character from `female` to
`male` in the editor and `intimateRegions` remains `["vulva","breasts"]`. The
attribute layer and the body-config layer disagree, silently, and the
realized-body filter believes the body-config. The design note that "stored
body-config is authoritative thereafter" justifies *not clobbering an author's
choice*; it does not justify never re-deriving a value the author never touched,
because nothing distinguishes the two.

That is B's whole content and it remains the correct fix: mark the seeded value
`auto`, re-derive it whenever the activating attributes change while it is still
`auto`, and pin it to `overridden` the moment a human touches the toggle.

## 2. `[]` is more overloaded now, not less

The original doc noted that `[]` meant both "deliberately none" and "we couldn't
infer one." The 2026-06-29 change sharpened this into something closer to a
defect signal.

Since **every** gender value activates anatomy, a stored `intimateRegions: []`
on a character or persona that *has* a gender can only mean one of:

1. the author deliberately cleared it (a valid, intended outcome), or
2. the record arrived by a path that never seeded (§3), or was created before
   its path started seeding.

Case 2 is still the likely reading on any stored row, and it is exactly the E1
bug. But `[]` is still `[]` — the schema default, the empty author choice, and
the skipped-seeding bug are one value. No diagnostic can fire, no migration can
backfill, and no UI can explain itself, because the information needed to tell
them apart was never recorded. This is the same missing bit as §1; §1 wants it
for re-derivation, §2 wants it for diagnosis.

## 3. The unseeded paths (Proposal C, re-scoped)

C's diagnostic is moot where the original doc aimed it — the forge always
resolves a gender now. It was not moot on two live paths that reached the same
end state; §3b is fixed, §3a stands.

### 3a. Character creates that arrive with attributes

`src/app/api/characters/route.ts:67-69` gates both registry-default seeding and
body-config seeding on the profile being **blank**:

```ts
const blank = body.value.profile.attributes.length === 0;
const seeded = blank ? seedRegistryDefaultValues(body.value.profile.attributes) : body.value.profile.attributes;
const seededConfig = blank ? seedBodyConfigFromAttributes(seeded) : null;
```

The comment above it is explicit that this is deliberate — forge drafts, clones,
and raw API callers are "authored data and passes through untouched." That is
right for forge drafts, which already carry a seeded body-config from
`character-forge.ts:1025`. It is not obviously right for a clone of a stale
record, an import, or a raw API caller: a payload with `identity.gender` set and
`intimateRegions: []` is accepted silently, and the result is
indistinguishable from a deliberate empty (§2). The cheap fix is C's diagnostic,
scoped to non-blank creates: *gender present, activatesGroups would have seeded
something, stored config is empty* → emit. The expensive-but-correct fix is B's
provenance, which makes the same condition decidable rather than heuristic.

### 3b. Personas had no seeding at all — FIXED 2026-08-07

**This was the gap worth fixing first, and it is closed.** Before the fix, the
persona create route built its profile with `materializeBodyDefaults` and
nothing else. `seedBodyConfigFromAttributes` was never called on the persona
path, and neither was `seedRegistryDefaultValues`. So a persona was born with
`intimateRegions` at its schema default `[]` and it stayed `[]` no matter what
gender the player set, forever, unless the player found the Body tab and
toggled regions by hand — the persona PATCH did not fix it later (§1).

The blast radius was not persona-local. `personaToCharacterProfile` copies
`intimateRegions` straight across, so every character-shaped consumer — the
realized-body filter, attribute gating, prompt builders, the scene image queue —
saw a player body with no intimate anatomy. For a romance-first engine that is
the original E1 complaint word for word, except it landed on the player's own
avatar rather than an NPC, in the half of the scene the player is most likely to
notice.

**What shipped.** `seedNewPersonaProfile` in
`src/contracts/players/persona-profile.ts` — one pure function that grounds a
newly-created persona's body in three fill-only steps, called from
`POST /api/personas`:

1. **Curated core-visual defaults** (`seedRegistryDefaultValues`) on a truly
   blank body, so a persona has an `identity.gender` for step 2 to seed *from*.
   This step is load-bearing, not cosmetic: the library's New button posts
   `{title, name}` with no profile at all, so without it the shipped fix would
   have seeded nothing on the only path players use.
2. **The body-config those attribute values activate**
   (`seedBodyConfigFromAttributes`) — gender `female` ⇒ `["vulva","breasts"]`.
3. **The persisted-baseline facts** (`materializeBodyDefaults`) against the
   post-seed body, so the freshly seeded anatomy gates them. This step is the
   pre-existing behavior, now running after the seed rather than instead of it.

Tests are pure (`src/contracts/players/persona-profile.test.ts`), so CI runs
them, with route-level coverage alongside the other persona CRUD cases in
`src/app/api/library-routes.int.test.ts`.

**Owner-facing consequence:** a new persona is now born looking like a new
character — female, mid-twenties, with the anatomy that gender implies — instead
of anatomically blank. Everything remains one toggle away in the Body tab.

**Two decisions worth carrying forward.**

*The seed gate is the body-config, not the whole profile.* The character route
gates both seeds on the profile being blank (§3a), because its non-blank callers
are forge drafts and clones — authored bodies that already carry a seeded config
from `character-forge.ts`. A persona has neither a forge nor a clone, so its
only non-blank creator is an API client, and one that sends `identity.gender`
with no anatomy wants the anatomy that gender activates. So the persona path
seeds the body-config whenever the incoming config is empty, and the curated
core-visual fill still follows the character route's blank gate. A supplied
config always wins. The consequence is that an explicit `intimateRegions: []`
in a create payload is *not* distinguishable from an absent one and gets
seeded — that is §2's overload, and deciding it needs §1's provenance flag.

*An empty feature seed must leave `bodyFeatures` absent, not `[]`.* `realizeBody`
reads an omitted `bodyFeatures` as "use the species and heritage defaults" and a
provided one — including `[]` — as an explicit per-body override. Since
`identity.gender` is still the only definition declaring `activatesGroups` and
it activates only intimate regions, the feature seed is always empty today, so
writing it would silently strip a succubus persona of its wings, horns, and
tail. `seedNewPersonaProfile` writes `bodyFeatures` only when the seed produced
one. **The character create route has the same latent hazard and was left
unchanged** — it is unreachable there today (a blank character create always
carries the default `human` species), and changing that route means reopening
§3a rather than making a drive-by edit.

**Existing persona rows were not backfilled.** Every persona created before
2026-08-07 still carries `intimateRegions: []`, and by §2 that value is
ambiguous by construction — a backfill cannot tell a pre-fix row from a
deliberate authorial empty. Owners can fix one in the editor's Body tab today;
doing it automatically is the same decision as the third open question below and
waits on the same provenance flag.

## 4. Proposal D's design question is still unanswered — and now cheap to answer

D asked whether anatomy should be inferred from a broader signal (role, species,
explicit anatomical cues in the concept) rather than gender alone, and whether
the model should propose `intimateRegions` directly. `9ed4e31` shipped D's
*plumbing* and left its *question* untouched: `activatesGroups` is a general
attribute→body-config map, but `identity.gender` is still the only definition in
the registry that populates it.

The plumbing changes the economics of answering. Because activation is
declarative data on the attribute definition and the seeder unions across all
values (`seed.ts:24`), adding a second signal is a data edit, not a code change
— a species definition, a role attribute, or an anatomical-cue attribute can
each declare `activatesGroups` and the union falls out. So the two questions can
now be separated and answered independently:

- **Should other attributes activate anatomy?** Answerable incrementally, by
  declaration, with no new machinery and no new failure modes — the union is
  order-stable and de-duplicated, and the existing test file covers the
  multi-value case (`seed.test.ts`).
- **Should the model emit `intimateRegions` directly?** Still a genuine
  departure from "anatomy is body-config, not model output," and still worth
  debating rather than patching. Note that the declarative route makes the
  model's existing output (attribute values) do the work indirectly, which may
  be enough — the model already picks the values; the registry decides what they
  activate.

## Relationship to the parked natal-sex work

The parked structured-sex-at-birth item holds two adjacent points that touch
this territory without covering it:

- **Wider value set** — `intersex` on `natal_sex` "and the matching
  body-config seeding story." That is a new *activation* to declare, i.e. §4's
  first bullet, not §1's provenance.
- **Auto-consistency** — keep `natal_sex` and the gender
  born-variant in agreement. That is attribute↔attribute agreement; §1 is
  attribute↔body-config re-derivation. They are complementary: auto-consistency
  keeps the *seed input* coherent, B keeps the *seeded output* current.

Neither is B. Cross-reference, do not duplicate. `character-schema.plan.md` owns
none of this (verified — it covers facial realism and engine-shaped contracts).

## Recommended order

Persona seeding (§3b) was first and shipped 2026-08-07: smallest diff, live
player-facing gap, no design question attached. Next is the provenance flag
(§1/§2), which is the one missing bit that unblocks re-derivation, the
non-blank-create diagnostic, and any backfill — including the pre-2026-08-07
persona rows §3b deliberately left alone. The C diagnostic for non-blank creates
(§3a) is worth doing standalone only if provenance slips. §4 is a discussion,
not a queue item.

## Test plan

- **Persona create** — DONE 2026-08-07. A persona created with
  `identity.gender = "female"` and no explicit body-config lands with
  `intimateRegions: ["vulva","breasts"]`; a blank persona create gets the
  registry gender default and the anatomy it activates; a supplied non-empty
  config survives untouched. The one bullet this pass did **not** deliver is an
  explicit `intimateRegions: []` surviving — zod's `.default([])` makes absent
  and explicitly-empty the same value, so honouring it needs §1's provenance
  flag (§3b records the ruling).
- **Persona parity** — DONE 2026-08-07. `personaToCharacterProfile` of a seeded
  persona yields a character profile whose realized body gates intimate
  attributes on, matching an equivalently-configured character.
- **Re-seed with provenance (§1)** — editing gender `female`→`male` on an
  untouched (`auto`) body-config re-seeds to `["penis","testicles"]`; the same
  edit on an author-toggled (`overridden`) config leaves it alone; the flag
  survives a PATCH round-trip on both characters and personas.
- **Non-blank create (§3a)** — a create payload with gender set and
  `intimateRegions: []` is accepted but flagged (diagnostic, or `auto` +
  re-derivation, depending on which lands); a forge draft carrying an already-seeded
  config is not re-seeded or double-counted.
- **Degradation** — an author-cleared body-config stays empty and is never
  flagged once marked `overridden`, on both body types.

## Open questions

- **Provenance shape.** A sibling field (`intimateRegionsSource: "auto" |
  "overridden"`) or a wrapper object? A sibling migrates cleanly (absent ⇒ treat
  as `overridden`, i.e. fail-safe against clobbering existing records) but adds a
  field to two schemas. Decide before anything else in §1 can be built.
- **Backfill.** Existing records with gender set and `intimateRegions: []` are
  ambiguous by construction (§2) — this now includes every persona created
  before 2026-08-07, which §3b left untouched. Leave them alone, flag them for
  the author, or treat pre-provenance empties as `auto` and re-derive? The first
  is safest, the third is what most of those records actually want.
- **Should any attribute besides gender declare `activatesGroups`?** (§4) —
  answerable per-attribute now that it is data.
- **Should the model propose `intimateRegions` directly?** (§4) — still a
  deliberate departure from the current design; unchanged from 2026-06-15.
