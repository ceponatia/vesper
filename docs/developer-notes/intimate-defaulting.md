# Fragile intimate-anatomy defaulting — open remainder

Status: **open remainder** (re-drafted 2026-08-02; the original 2026-06-15
analysis's headline fix shipped same-day in `9ed4e31` + `c7d45fd` — see git
history for the original). Supplement to
[character-schema-audit.md](finished/character-schema-audit.md) finding **E1**.

E1 was: the per-character body-config (`intimateRegions`) is seeded from
`identity.gender` at forge time, gender was not force-filled, so a weak-signal
prompt silently yielded a character with **no intimate anatomy** — and the empty
default was indistinguishable from a deliberate authorial choice.

The forge half of that is fixed. What survives is everything the original doc
filed under B, C, and D: **the body-config still records no provenance, still
never re-derives, and is still seeded on exactly one code path out of four.**
The most consequential of those — personas get no seeding at all — was not in
the original analysis's scope and is the live re-occurrence of the E1 failure
mode on the player's own body.

## What shipped (evidence)

**Proposal A — `identity.gender` is `coreVisual`.** `9ed4e31` set
`coreVisual: true` with `defaultValue: "female"`
(`src/contracts/attributes/categories/identity.ts:33-34`; the comment there
cites *"was audit E1"*). The three-tier fill gate is
`src/server/authoring/character-forge.ts:1106-1107`, called from `:1004`, so
gender is always present on a forged draft.

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
line 79 and [../contracts/attributes.md](../contracts/attributes.md) §attribute
flags. The forge call site is `character-forge.ts:1024`.

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
  on both bodies: `src/contracts/world/profile.ts:264` and
  `src/contracts/players/persona-profile.ts:61`. Nothing anywhere records
  whether a given value was seeded or authored.
- **No re-seed on save.** The character PATCH
  (`src/app/api/characters/[id]/route.ts:63-75`) merges the profile patch and
  runs `materializeBodyDefaults` over the merged attributes — it re-materializes
  *persisted-baseline facts*, which is a different mechanism, and never calls
  `seedBodyConfigFromAttributes`. The persona PATCH
  (`src/app/api/personas/[id]/route.ts:46-48`) does the same and no more.
- **No re-seed on gender edit.** The body-config is wired as a pure manual
  toggle in both editors: `src/components/characters/character-editor.tsx:355-356`
  and `src/components/personas/persona-editor.tsx:224-225` both hand
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
2. the record arrived by a path that never seeded (§3).

Case 2 is now the overwhelmingly likely reading, and it is exactly the E1 bug.
But `[]` is still `[]` — the schema default, the empty author choice, and the
skipped-seeding bug are one value. No diagnostic can fire, no migration can
backfill, and no UI can explain itself, because the information needed to tell
them apart was never recorded. This is the same missing bit as §1; §1 wants it
for re-derivation, §2 wants it for diagnosis.

## 3. The unseeded paths (Proposal C, re-scoped)

C's diagnostic is moot where the original doc aimed it — the forge always
resolves a gender now. It is not moot on two live paths that reach the same end
state.

### 3a. Character creates that arrive with attributes

`src/app/api/characters/route.ts:80-82` gates both registry-default seeding and
body-config seeding on the profile being **blank**:

```ts
const blank = body.value.profile.attributes.length === 0;
const seeded = blank ? seedRegistryDefaultValues(body.value.profile.attributes) : body.value.profile.attributes;
const seededConfig = blank ? seedBodyConfigFromAttributes(seeded) : null;
```

The comment above it is explicit that this is deliberate — forge drafts, clones,
and raw API callers are "authored data and passes through untouched." That is
right for forge drafts, which already carry a seeded body-config from
`character-forge.ts:1024`. It is not obviously right for a clone of a stale
record, an import, or a raw API caller: a payload with `identity.gender` set and
`intimateRegions: []` is accepted silently, and the result is
indistinguishable from a deliberate empty (§2). The cheap fix is C's diagnostic,
scoped to non-blank creates: *gender present, activatesGroups would have seeded
something, stored config is empty* → emit. The expensive-but-correct fix is B's
provenance, which makes the same condition decidable rather than heuristic.

### 3b. Personas have no seeding at all — the E1 failure mode, live, on the player side

**This is the gap worth fixing first.** The persona create route
(`src/app/api/personas/route.ts:51-54`) builds its profile with
`materializeBodyDefaults` and nothing else:

```ts
const profile = {
  ...body.value.profile,
  attributes: materializeBodyDefaults(body.value.profile.attributes, body.value.profile),
};
```

`seedBodyConfigFromAttributes` is never called — the only call sites in the
codebase are `character-forge.ts:1024` and `characters/route.ts:82`.
`seedRegistryDefaultValues` is likewise character-only (`characters/route.ts:81`).
So a persona is born with `intimateRegions` at its schema default `[]`
(`persona-profile.ts:61`), and it stays `[]` no matter what gender the player
sets, forever, unless the player finds the body tab and toggles regions by hand.
The persona PATCH does not fix it later (§1).

The blast radius is not persona-local. `personaToCharacterProfile`
(`persona-profile.ts:103-117`) copies `intimateRegions` straight across at
`:112`, so every character-shaped consumer — the realized-body filter, attribute
gating, prompt builders — sees a player body with no intimate anatomy. For a
romance-first engine that is the original E1 complaint word for word, except it
lands on the player's own avatar rather than an NPC, in the half of the scene
the player is most likely to notice.

Personas run the same attribute registry and the same `AttributePicker`
(`persona-editor.tsx:224-230`), so `identity.gender` and its `activatesGroups`
are already available; nothing about the seed is character-specific. The fix is
to call `seedBodyConfigFromAttributes` on persona create the way
`characters/route.ts:82` does — plus, ideally, the registry-default seed, so a
blank persona is born with a gender to seed *from*. Both are small. The reason
they are missing is that the 2026-06-15 analysis, and the fix it drove, were
character-only.

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

## Relationship to `deferred.plan.md` §Natal sex

[deferred.plan.md](deferred.plan.md) lines 355-392 holds two adjacent items that
touch this territory without covering it:

- **Wider value set** (`:385-386`) — `intersex` on `natal_sex` "and the matching
  body-config seeding story." That is a new *activation* to declare, i.e. §4's
  first bullet, not §1's provenance.
- **Auto-consistency** (`:387-388`) — keep `natal_sex` and the gender
  born-variant in agreement. That is attribute↔attribute agreement; §1 is
  attribute↔body-config re-derivation. They are complementary: auto-consistency
  keeps the *seed input* coherent, B keeps the *seeded output* current.

Neither is B. Cross-reference, do not duplicate. `character-schema.plan.md` owns
none of this (verified — it covers facial realism and engine-shaped contracts).

## Recommended order

Persona seeding (§3b) first: smallest diff, live player-facing gap, no design
question attached. Then the provenance flag (§1/§2), which is the one missing
bit that unblocks re-derivation, the non-blank-create diagnostic, and any future
backfill. The C diagnostic for non-blank creates (§3a) is worth doing standalone
only if provenance slips. §4 is a discussion, not a queue item.

## Test plan

- **Persona create** — a persona created with `identity.gender = "female"` and
  no explicit body-config lands with `intimateRegions: ["vulva","breasts"]`; a
  blank persona create gets the registry gender default and the anatomy it
  activates; an explicit `intimateRegions: []` in the create payload survives.
- **Persona parity** — `personaToCharacterProfile` of a seeded persona yields a
  character profile whose realized body gates intimate attributes on, matching
  an equivalently-configured character.
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

- **Where does the persona seed run?** Mirroring `characters/route.ts:80-82` in
  `personas/route.ts` is the direct fix, but a shared create-time helper over
  both bodies would stop the two paths drifting a third time. Also: should
  persona create get `seedRegistryDefaultValues` too, or is an attribute-less
  persona a deliberate state?
- **Provenance shape.** A sibling field (`intimateRegionsSource: "auto" |
  "overridden"`) or a wrapper object? A sibling migrates cleanly (absent ⇒ treat
  as `overridden`, i.e. fail-safe against clobbering existing records) but adds a
  field to two schemas. Decide before anything else in §1 can be built.
- **Backfill.** Existing records with gender set and `intimateRegions: []` are
  ambiguous by construction (§2). Leave them alone, flag them for the author, or
  treat pre-provenance empties as `auto` and re-derive? The first is safest, the
  third is what most of those records actually want.
- **Should any attribute besides gender declare `activatesGroups`?** (§4) —
  answerable per-attribute now that it is data.
- **Should the model propose `intimateRegions` directly?** (§4) — still a
  deliberate departure from the current design; unchanged from 2026-06-15.
