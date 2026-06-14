# Intimate anatomy, sensory detail & non-human species — expansion spec

Status: **decided — ready to build (phase 4)** (decided 2026-06-14; drafted
2026-06-14). This expands [ideas-feedback.md](ideas-feedback.md) **Idea 4**
(intimate body regions) and folds in **Idea 3** (sensory schema) and **Idea 5**
(non-human species, as _scaffolding only_). It is the single home for the "body
model" cluster. Every open question is resolved — the rulings are recorded inline
below and summarized in [Decisions](#decisions-resolved-2026-06-14). The one
remaining step before code is to stand up a `phase-4-plan.md` anchor that points
here (this spec carries the design; the plan will carry the task list).

**Phase map (resequenced 2026-06-14, per Decision 9).** This body-model work is
now **phase 4** and builds first, as a standalone effort. The previously-planned
phase-4 cluster — "the world moves" (movement authority, scheduled arrivals, the
pre-narrator intake steering) — is renumbered **phase 5**, and its specs now
carry the `.phase5.md` suffix.

A note for reading this: I've written each section in plain language first, with
a short _"under the hood"_ note for the engineer at the end of each. You don't
need to read the code bits.

---

## The big idea (in one paragraph)

All three ideas are really **one system seen from three angles**: _what body a
character has_. Today every character shares one identical "humanoid" body with
no intimate anatomy and almost no sensory detail. We want (a) the intimate
regions to exist (Idea 4), (b) those regions to carry scent / taste / texture so
intimacy reads vividly instead of vaguely (Idea 3), and (c) the machinery that
decides _which_ body a character has to be flexible enough that a non-human
species is later just a data entry, not a rewrite (Idea 5). The crucial insight
is that **(a) and (c) are the same machinery** — "a man doesn't have a vulva" and
"an elf has pointed ears" are the same kind of rule. Build that rule engine once,
populate it with human anatomy now, and species becomes free later. That's why
folding these together is the right call.

---

## What already exists (the substrate we build on)

We are **not** starting from scratch. The feedback's headline holds up against
the code:

- **A body-location registry.** `src/contracts/body/locations.ts` — a tree of 27
  humanoid body parts (head → face → eyes, torso → chest, pelvis → groin /
  buttocks, etc.). It's the wardrobe-granularity tree we forked from reverie:
  `groin` and `buttocks` exist only so clothing can cover them — there's no
  actual genitalia modeled. Adding parts is a **data edit in one file, no
  database migration** (this is a deliberate design guarantee).
- **An attribute registry** with a `sensory` _kind_ already defined, and
  attributes can already attach to a body part (`bodyLocationId`). Scent
  (`presentation.scent_baseline`), the full voice group, and a few textures
  (`skin.texture`, `hands.texture`) already exist.
- **An exposure mask** — the per-sense "how close are we" gate. It has three
  axes today: `appearance`, `scent`, `touch`, each with levels like
  `none → ambient → close → intimate`. The narrator is only allowed to describe
  skin-level scent or sustained touch when the mask says we've earned it.
- **An arousal meter** already exists (0 → 1, decays over time, with a "visibly
  affected" threshold hint).
- **Dormant species seams.** Every character profile already stores a
  `speciesId` ("human") and `bodyPlanId` ("humanoid"), and attribute definitions
  already have `appliesToBodyPlans` / `excludesBodyPlans` fields. **All of these
  are currently inert** — stored but read by nothing. The wiring is half-built
  and waiting.

So the work is mostly **populating data and wiring deterministic consumers**, not
new architecture.

### The template we're copying — aionchat

The feedback points at `~/projects/aionchat/packages/contracts` as the fuller
model, and it checks out. aionchat ships:

- **~77 body locations** including explicit intimate anatomy, all under the same
  tree shape we already use (`torso.pelvis.groin.vulva` → labia majora / minora /
  clitoris / vestibule; plus vagina, penis, testicles, mons pubis; breasts as
  left/right under `torso.chest`).
- A **species registry** where a species says which body plan it uses, which body
  locations it adds or removes, and per-attribute rules (e.g. an elf _requires_
  pointed ears; anatomy attributes are marked _optional_).
- A **`runtime` mutability tier** for live simulation state (penis erect/flaccid,
  vaginal lubrication) kept separate from permanent description.

Two honest caveats about the template:

1. aionchat **also only ships the humanoid body plan** — its avian/aquatic plans
   are planned-not-built. So "novel body plans" (mermaids, true non-humanoids)
   are hard _everywhere_, not just here. We are not attempting them (see Idea 5
   scope).
2. aionchat's gating is **not** keyed off gender; it marks anatomy "optional" and
   lets character creation decide. We layer a gender-driven _default_ on top of
   that (Decision 1) — the one place we diverge from the template.

---

## Section A — Intimate body regions (Idea 4)

### What we're adding

The intimate anatomy from the aionchat tree, slotted under our existing `pelvis`
and `chest` parents. Concretely, new body-location entries roughly like:

```
pelvis
 └─ groin
     ├─ mons (mons pubis)
     ├─ vulva ─ labia_majora · labia_minora · clitoris · vestibule
     ├─ vagina
     ├─ penis
     ├─ testicles
     └─ anus
chest
 └─ breasts ─ left · right (with nipples)
```

…plus a new attribute **category** per region (so an attribute id like
`vulva.size` or `penis.size` is valid) and the descriptive attributes that hang
off each (size, shape, prominence, etc., ported from aionchat's vocabulary).

_Under the hood:_ new rows in `humanoidBodyLocations`
(`src/contracts/body/locations.ts`), new categories in
`attributes/categories.ts`, and new attribute group files added to the
`attributeGroups` array (`attributes/groups/index.ts`). All additive data edits,
no migration.

### Design decision 1 — anatomy gating (this is the crux)

You **can't** just add a `vulva` region to the global body and call it done,
because then _every_ character — including male ones — "has" one. We need a rule
for **which character has which intimate anatomy.** This is the single most
important decision in this whole spec, and it's shared with species (Idea 5).

Your own note in ideas.md is the gender-driven instinct: _"breast_size and vagina
are irrelevant when gender is male; when female is selected they activate."_
aionchat does it differently — anatomy is "optional," and creation decides.
Here's the reconciliation we settled on (**Decision 1**):

**Store a small per-character "body configuration"** — the set of intimate
regions this character actually has. At character-creation (forge) time, **default
it from `identity.gender`** (female → vulva set + breasts; male → penis set;
androgynous/nonbinary → the author picks). **Always let the human override it.**

Why this shape:

- It gives you exactly the ideas.md behavior (pick female → female anatomy
  appears) _by default_…
- …without hard-wiring gender → anatomy, so trans, intersex, and fantasy
  characters work by override instead of fighting the system. (Your own principle:
  "the user can always override.")
- The same "which regions does this body have" switch is what species (Idea 5)
  flips for non-humans. One mechanism, two uses.

A region being "present" then drives **four** things consistently: which
attributes the editor offers, which body parts clothing can cover / expose, what
the narrator may describe, and what image generation may depict.

_Under the hood:_ the body-location tree is the **superset** (every possible
part). A character's _realized_ body = superset, filtered by (1) species
allow/disallow lists and (2) the per-character body-config. For v1 (human +
humanoid) the species layer filters nothing; the body-config does the work. The
forge's `characterAttributeDefinitions()` and the attribute-picker UI both filter
their offered attributes through this same realized set — today they offer every
attribute to everyone, which is the gap.

#### Q1a in plain language — how do we record "what anatomy this character has"?

Q1 settled *that* a character has a defined set of intimate anatomy. Q1a is the
narrower follow-on: **where does that fact actually live in the data?** There are
two ways to record "Marcus has a penis; Elena has a vulva and breasts," and they
behave differently in practice.

**Option 1 — Implicit ("you have it if you've described it").** There is no
separate "what anatomy this character has" field. Instead, the system *infers*
presence from the descriptive attributes already on the character: Elena "has a
vulva" precisely because her sheet contains vulva attributes (vulva size, shape,
etc.). Remove all the vulva attributes and, as far as the system is concerned,
she no longer has one.

> *The problem:* presence becomes a side-effect of **how much you've bothered to
> describe.** Picture creating Marcus, a male character, and not filling in any
> intimate detail yet (totally normal — you're still sketching him). Under the
> implicit rule the system doesn't *know* Marcus has a penis, because nothing is
> described. So clothing fit, exposure, narration, and image generation all treat
> him as having no genitals until you go author specifics. That's backwards —
> *whether a body part exists* shouldn't depend on *whether you've written its
> measurements.*

**Option 2 — Explicit ("the character carries a short list of what anatomy is
present").** The character sheet holds one small, separate fact — a little list
like `["penis", "testicles"]` for Marcus or `["vulva", "breasts"]` for Elena —
that simply states which intimate regions exist on this body. Descriptive
attributes (size, shape, scent…) are a *separate* layer you fill in on top, in
any amount, later or never.

> *Why this is cleaner:*
> - **Presence is known immediately,** before a single detail is written. Pick
>   "male" in the forge → the list is set to `["penis", "testicles"]` → the rest
>   of the system (clothing, exposure, narrator, images) knows what it's dealing
>   with right away.
> - **Override is a clean toggle.** A trans woman character? Set the list to
>   `["penis", "breasts"]`. An intersex or fantasy character? Any combination.
>   This is exactly the "the user can always override" principle, expressed as
>   ticking regions on or off rather than fighting the description fields.
> - **Every consumer reads one obvious place** instead of scanning the whole
>   attribute sheet trying to guess what's there.
> - **"Present but not yet described" is a valid, normal state** — the common case
>   while you're still building a character.

**My recommendation: Option 2 (explicit), storing a short list of present
*region groups*** — e.g. `vulva`, `penis`, `testicles`, `breasts` — rather than
every tiny sub-part. Listing the group is enough: "vulva is present" naturally
implies its sub-parts (labia, clitoris, vestibule) exist too, so the list stays
short and readable while the body tree supplies the detail. A bare gender→one-of
("male/female/both/none") enum would be simpler still but too rigid for the
trans/intersex/fantasy cases you want in Q1; a full list of every sub-location
would be needlessly verbose. The region-group list is the middle that handles
every combination without clutter.

*Under the hood (for the engineer):* a small field on `CharacterProfile`
(e.g. `intimateRegions: string[]` naming present intimate categories), riding in
the already-validated profile JSONB — **no migration**, read through `parseOr`
with a safe default (empty, or derived from gender at spawn). It composes under
the species layer: realized intimate anatomy = what the species/body-plan permits,
narrowed to what this character's list actually switches on. The forge seeds the
list from `identity.gender`; the character editor exposes it as
toggles. The descriptive attribute layer is unchanged — this is purely the
"is it there at all?" switch sitting above it.

**Applies to the player too (Decision 10).** The player is just a character the
user chooses to embody, so the player avatar carries the same body-config and the
same anatomy/sensory model as any NPC. At this stage every living entity shares
one capability set — there is no "player-only" or "NPC-only" body model.

### Design decision 2 — descriptive vs. live simulation state — *decided*

There's a difference between _what a body is_ (permanent: "average size,
trimmed") and _what it's doing right now_ (live: erect, lubricated). aionchat
models the live part with a dedicated `runtime` attribute tier.

**Decided (Decision 2): reuse what we already have — no new tier.** We model
"erect / lubricated / flushed" as **threshold hints on the existing `arousal`
meter** (0–1, decays) and/or **conditions** with prompt hints — the same move
that replaced the old hygiene vectors with `hygiene` + a condition. So the
attribute `mutability` enum stays `inherent | mutable | temporary` (we do **not**
add aionchat's `runtime`). If play later shows we genuinely need per-region,
per-turn state tracked as structured data rather than narrated, adding the tier is
a future additive change — but we don't pay for it now.

### Design decision 3 — image generation & content safety — *decided*

This is the flag the feedback raised, and it's real work, not just a data port.
The deciding fact is that Vesper has **two image generators with opposite content
rules**, and the codebase already knows which is which:

- **Flux** (`black-forest-labs/flux.2-*`, via OpenRouter) — backs the **default
  portrait/avatar** in the character studio. It **disallows** explicit content,
  and today it doesn't read exposure anyway.
- **Qwen** (`qwen-image` / `qwen-edit-uncensored`, via Venice) — **uncensored**.
  It backs **in-session scene images** and the character studio's **Qwen
  pose/outfit variants** (the studio has an explicit Flux/Qwen toggle).

**Decided (Decision 3): include the intimate fields wherever Qwen is the target;
withhold them wherever Flux is.** Concretely:

- **Scene image generator → include.** Intimate regions and full exposure detail
  flow into the scene prompt. Because the scene path is uncensored Qwen, image
  exposure is **not** kept coarse — it gets the fine regions, the same as
  narration. (This reverses my earlier "keep images coarse" lean; with an
  uncensored model there's no reason to.)
- **Character studio, Qwen pose/outfit path → include.** Same uncensored model,
  so the same fields apply.
- **Character studio, Flux main portrait → exclude.** Flux rejects these fields,
  so the prompt builder must omit the entire intimate set on this route or the
  request fails / gets moderated.

This is the second payoff of the dedicated `intimate/` folder (Decision 11 / §D): "the
set of fields to strip for Flux" is exactly "everything under `intimate/`," so the
Flux path filters it out in one line — and the same fence later serves the
lighter-model content-moderation concern from ideas.md.

*Under the hood (for the engineer):* the include/exclude switch keys on the
**image model/route**, not the image *kind* — `formatExposure` and the
scene-composer / variant prompt builders gain an "allow intimate detail" input
that is true for the Venice/Qwen routes and false for the Flux route
(`server/images/prompts.ts`, `avatar.ts`, `scene.ts`, `variants.ts`).

### Exposure-region grouping

Minor but required: the image-side region grouping
(`contracts/items/visibility.ts`, the `torso/pelvis/legs/feet` map) and the
"below the waist" set get the new intimate regions slotted under `pelvis`, with a
finer genital-exposure state for the Qwen routes so coverage and exposure compute
(and depict) correctly. Mechanical now that Decision 3 is set.

---

## Section B — Sensory schema & the taste sense (Idea 3)

### What's already there vs. what's missing

Sensory is **partly built** (scent baseline, voice, some textures, items carry
appearance/scent/tactile, locations carry ambient scent/sound/light, and the
exposure mask already gates scent + touch). So this is an **extension**, not a new
system. Two real gaps:

1. **Taste is missing entirely.** There is no taste attribute and — crucially —
   **no `taste` axis on the exposure mask.** Taste is the most intimate sense
   (earned only at intimate contact: a kiss, mouth on skin), so adding it is a
   new exposure axis with its own raise-trigger, not just a new attribute.
2. **Per-region sensory is sparse.** Attributes _can_ already bind to a body part,
   but almost none do. This is exactly where Idea 3 meets Idea 4: scent / taste /
   texture want to attach to the _new_ intimate regions (and to lips, skin,
   neck).

### Design decision 4 — the taste axis

Add a fourth exposure axis: `taste: "none" | "close" | "intimate"`, raised for a
turn when the player's input is a taste/lick/kiss action toward a target (the
exact analog of how smelling raises `scent` and touching raises `touch` today).
Then taste detail surfaces only when earned, same as the other senses.

_Under the hood:_ this is a well-trodden path — there are ~6 small, parallel edits
(mask schema, the narration-rules switch, the "include sensory detail" gate, a
`taste`/`lick`/`kiss` intent regex + an `tasteTarget` field on the intent brief,
the raise function, and the intake adapter). Each one already has a scent/touch
sibling to copy. Low risk, just touches several files.

**Decided (Decision 5): a kiss raises _both_ touch and taste at `close`;** deeper
acts (licking, mouth on skin) raise `intimate`. Kissing is both senses and is
common, so it earns both at the lighter level without jumping straight to the most
explicit tier.

### Per-region sensory & "authored, not improvised"

The new intimate regions (and lips/skin/neck) get `sensory`-kind attributes:
per-region scent, taste, and texture. The important principle (consistent with
how `scent_baseline` already works): **author these on the character, don't leave
them to the narrator to invent**, because improvised scent/taste drifts from turn
to turn and breaks immersion. The forge fills sensible defaults; the human can
edit.

**Decided (Decision 6): start tight, expand later.** Ship one scent + one taste +
one texture per relevant region to keep character sheets manageable; the registry
makes adding more a one-line data edit when play shows we want richer sensory
vocabulary.

**Tone (Decision 4):** the stored attribute **values are clinical/anatomical**
(e.g. `vulva.size: average`) so the data stays unambiguous and easy to validate,
but the **`promptHints` fed to the narrator are prose-driven and evocative** —
the schema is the skeleton, the prompt hints carry the voice.

---

## Section C — Non-human species (Idea 5, _scaffolding only_)

### Scope — read this first

Per your instruction: **schema and wiring only.** We are **not** creating any
non-human characters, body plans, or content in this work. The goal is narrow and
specific: **build the species machinery and turn on the dormant seams now, while
we're already building the gating engine for Idea 4, so that adding an elf or an
orc later is a pure data entry with no refactor.** If we don't do this now, we'll
build the anatomy-gating engine for Idea 4 in a species-blind way and have to tear
it open later to add species — exactly the rework you want to avoid.

### What "scaffolding" concretely means

1. **A species registry** (new file, modeled on aionchat's): a `SpeciesDefinition`
   with an id, label, the body plan it uses, optional body-location add/remove
   lists, and per-attribute rules (required / optional / forbidden, with
   defaults). Seed it with **`human` only.**
2. **Wire the dormant seams.** Make `appliesToBodyPlans` / `excludesBodyPlans`
   (currently defined-but-read-by-nothing) and the new species allow/disallow
   lists actually filter the realized body — _through the very same filter the
   Idea 4 body-config uses._ This is the "one mechanism, two uses" payoff.
3. **Keep `identity.species_presentation`** (the existing free-text "wood-elf"
   field) as the _visual flavor_ text. The new `speciesId` is the _structural_
   choice (what body/anatomy rules apply); `species_presentation` stays the prose
   description. **Decided (Decision 8): keep the two separate** — the structural id
   drives the gating engine, the free text drives description; they're
   complementary, not unified.

### What we are explicitly NOT building

- No elf/orc/alien species records (only `human`).
- No novel body plans (no tails, wings, gills, digitigrade legs). Those need new
  body-location trees, new wardrobe-coverage logic, and major image work — a
  separate future phase, with image generation in the room from day one. aionchat
  hasn't built them either.
- No species-specific UI beyond what the gating engine needs to function with one
  species.

The test for "did we scaffold correctly": **adding a second humanoid species
(say, elf) should be a single data file plus a registry entry — zero engine
changes.** If it would require engine changes, the scaffolding isn't done.

---

## How the three fit together

```
        body plan (humanoid)            ← the superset of all possible parts
              │  defines all locations
              ▼
        species (human)                 ← Idea 5: adds/removes parts, sets attr rules
              │  allow / disallow / required-optional-forbidden
              ▼
        per-character body-config       ← Idea 4: which optional intimate anatomy is present
              │  (defaulted from gender, overridable)
              ▼
        realized body for THIS character ─────────────┐
              │                                        │
              ├─► which attributes the forge/editor offer
              ├─► which parts clothing covers / exposes
              ├─► what the narrator may describe   ◄─ gated by exposure mask
              │        (scent · touch · TASTE ← Idea 3)
              └─► what scene-image generation may depict (Decision 3)
```

The single filter in the middle is the whole game. Idea 4 populates it with human
anatomy and a gender default; Idea 3 enriches what flows out of it (taste +
per-region sensory); Idea 5 makes the species layer real so non-humans drop in
later. Build the filter once.

---

## Section D — How we organize this on disk (the port layout)

You asked me to look at _how_ aionchat's contracts are physically organized and
decide whether there's a cleaner way to lay them out for Vesper — easy to
maintain, easy to read in both the code and the file explorer — without dropping
any of aionchat's fields. I read aionchat's actual files for this. The short
version: **aionchat's folder _shape_ is good and worth borrowing; aionchat's
file _contents_ are far more verbose than Vesper needs, and we should keep
Vesper's leaner style.** Details below.

### What aionchat does (and where it's heavy)

aionchat splits things sensibly into folders — `body-locations/`,
`attributes/`, `species/`, `body-plans/`, plus a shared `rules/` — and inside
`body-locations/` it further splits the humanoid tree into one file per region
(`humanoid/head.ts`, `torso.ts`, `arms.ts`, `legs.ts`). That region-splitting is
genuinely nice: each file is short and scannable.

But three things make aionchat's files heavier than they need to be, and we
should **not** copy them:

1. **Hand-written value schemas per attribute.** aionchat's `vulva.ts` is **167
   lines for 6 attributes** because it hand-writes, for every single attribute, a
   list of allowed values, a zod schema, and a TypeScript type. Vesper doesn't do
   this — Vesper's registry _derives_ all of that automatically from the
   `allowedValues` you write once. The equivalent Vesper file would be **~35
   lines.** This is the single biggest readability win, and it's already how
   Vesper works. Keep it.
2. **A 349-line `aliases.ts` monolith.** aionchat keeps every search alias
   ("ginger" → hair) in one giant separate file, far from the attributes they
   describe. Vesper keeps aliases _inline_ on each attribute (see `chest.ts`:
   `aliases: ["chest", "bust"]`). Vesper's way is better — the alias lives with
   the thing it names. Don't recreate the monolith.
3. **A 387-line body-plan _generator_.** aionchat computes each body plan's rules
   from the location tree via `define-body-plan-from-locations.ts` (145 lines) +
   a 242-line generated `humanoid.ts`. For our scaffolding scope this is
   over-engineered — Vesper's body plan is a simple list of location ids and that
   is enough. Keep it simple; we can revisit the generator if rules ever get
   complex.

One more difference, in Vesper's favor: aionchat encodes the body tree in the id
itself (`torso.pelvis.groin.vulva.labia_majora`) _and_ in a `parentId` — the same
hierarchy written twice. Vesper uses **flat ids** (`vulva`) plus `parentId`, which
is shorter and already our convention. Keep flat ids.

### What we should adopt from aionchat

- **Region-split the body-location file.** Vesper's `body/locations.ts` is one
  flat array. It's fine at 27 entries, but the intimate anatomy pushes it toward
  ~45 and it starts to get hard to scan. Borrow aionchat's idea: split it into a
  small folder of region files with an index that re-assembles them (the registry
  builder and the `belowWaist` helpers stay in the index).
- **A `species/` folder** mirroring aionchat's shape (a types file, a registry, a
  `humanoid/` subfolder of species records), seeded with `human` only. aionchat's
  registry is already written to grow (`// import { avianSpeciesCatalog }` sits
  commented in its registry) — that's exactly the "ready for later, no refactor"
  posture you want.
- **A shared `rules/attribute-rule.ts` primitive.** aionchat factors the
  "required / optional / forbidden + default + allowed/disallowed values + notes"
  shape into one reusable rule used by _both_ species and body plans. That's good
  factoring and it's the exact shape our gating engine (Decision 1) needs. Adopt it.

### The proposed Vesper layout

```
src/contracts/
  body/
    locations/                  ← was locations.ts, now split by region
      everyday.ts               ←   head · torso · arms · pelvis (non-intimate) · legs
      intimate.ts               ←   groin→vulva/penis/testicles/…, breasts   (NEW)
      index.ts                  ←   assembles all regions + registry builder + belowWaist helpers
    plans.ts                    ← humanoid plan (unchanged; gains the intimate ids)
  species/                      ← NEW — scaffolding (Idea 5)
    types.ts                    ←   SpeciesDefinition schema
    registry.ts                 ←   lookup helpers; written to grow (avian/… later)
    humanoid/
      human.ts                  ←   the only species record we ship
      index.ts                  ←   humanoid catalog
    index.ts
  rules/                        ← NEW — one shared primitive
    attribute-rule.ts           ←   required/optional/forbidden + default + allowed/disallowed
  attributes/
    categories.ts               ← + the new intimate categories (vulva, penis, …)
    types.ts                    ← unchanged — no new mutability tier (Decision 2: live state rides the arousal meter + conditions)
    groups/
      … the existing 21 files, unchanged …
      intimate/                 ← NEW subfolder — explicit anatomy + its per-region sensory
        vulva.ts                ←   vulva.size/shape/… AND vulva.scent/taste/texture (Idea 3)
        penis.ts
        testicles.ts
        breasts.ts
        groin.ts
        index.ts                ←   exports the intimate groups as one array
```

Two deliberate choices in there:

- **Per-region sensory lives in the region's own file.** Everything about the
  vulva — its description attributes _and_ its scent/taste/texture (Idea 3) — sits
  in `vulva.ts`. One file, one body part, nothing scattered. The `kind: "sensory"`
  flag already separates the senses from the descriptions inside that file.
- **A dedicated `intimate/` subfolder, not loose files mixed in with the everyday
  anatomy.** This was the one real organizational decision (**Decided, Decision
  11: yes, dedicated subfolder + region-split locations**), for a concrete reason
  beyond tidiness: you've
  already flagged (in ideas.md, "Model Improvements") that some fields will trip
  content-moderation on lighter models and must be withheld from those models.
  If every explicit attribute lives under one `intimate/` folder (and the intimate
  body locations under one `intimate.ts`), excluding that whole set from a
  moderation-prone prompt is a one-line filter, and a person scanning the file
  tree sees the sensitive content clearly fenced off. Mixing them into the flat
  `groups/` folder loses both benefits.

### Nothing is lost — field-by-field

You said not to drop any of aionchat's fields. Here's the mapping for the data
we're actually porting (the body locations and the anatomy attributes). Every
aionchat field has a Vesper home; the few aionchat-only schema fields are
_unused by the anatomy data_, so skipping them drops no information — I've listed
them so the choice is explicit, not accidental.

**Body-location fields**

| aionchat field                                  | Vesper home                                                       | Note                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`, `label`, `parentId`, `promptHints`        | same                                                              | direct                                                                                                   |
| `side` (left/right/upper/lower/center)          | `side` (left/right/center)                                        | extend the enum only if a ported part needs upper/lower; none of the intimate anatomy does               |
| `attributeCategory` (location→category pointer) | covered by Vesper's `bodyLocationId` (attribute→location pointer) | Vesper links the _other direction_; the reverse lookup is derivable in the registry. No capability lost. |
| —                                               | `coverageRelevant`                                                | Vesper-only; kept                                                                                        |

**Attribute fields**

| aionchat field                                                                                                                                                               | Vesper home                                                    | Note                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`, `label`, `kind`, `category`, `valueType`, `description`, `mutability`, `allowedValues`, `min`, `max`, `unit`, `appliesToBodyPlans`, `excludesBodyPlans`, `promptHints` | same                                                           | direct                                                                                                             |
| per-attribute zod schema + value enum + TS type                                                                                                                              | _derived by the registry_                                      | we write `allowedValues` once; Vesper generates the rest                                                           |
| externalized `aliases` (the monolith)                                                                                                                                        | inline `aliases` on each attribute                             | Vesper already does this, better                                                                                   |
| `mutability: "runtime"`                                                                                                                                                      | not ported (Decision 2)                                        | live state (erect/lubricated) rides the existing `arousal` meter + conditions, so the mutability enum is unchanged  |
| `requiresAttributes` / `conflictsWithAttributes`                                                                                                                             | not ported (gating handled by species rules + body-config, Decision 1) | these are an _alternative_ way to express "penis conflicts with vulva"; flagging in case we prefer them for gating |
| `itemSchema`, `valueType: "collection"`                                                                                                                                      | not ported                                                     | for structured collections (scar/tattoo lists) — not needed by intimate anatomy                                    |
| `kind: "magical" / "prosthetic"`, owner kinds `spell/faction/scene`, body-plan categories `tail/wings/horns/…`                                                               | not ported                                                     | these belong to aionchat's broader RPG scope / novel body plans, which are explicitly out of scope here            |

If we later want any of the skipped fields, each is an additive registry edit —
the same no-migration guarantee — so nothing here paints us into a corner.

> The existing 21 attribute groups are left as they are. The region-split of
> `locations.ts` rides along because the file is growing anyway (Decision 11).

---

## Decisions (resolved 2026-06-14)

All eleven brainstorming questions are settled. The detail for each lives in the
section noted; this is the scan-in-one-place summary.

1. **Anatomy gating — yes.** Gender sets a *default* anatomy at creation, on top
   of an aionchat-style optional-anatomy layer, and is **always overridable**. §A-decision-1
1a. **Body-config storage — explicit.** Store a short list of present *region
   groups* (e.g. `["penis", "testicles"]`) on the profile, decoupled from how much
   descriptive detail is filled in. §A "Q1a in plain language"
2. **Live state — reuse, no new tier.** Erect / lubricated / flushed ride the
   existing `arousal` meter + conditions; the `mutability` enum is unchanged (no
   `runtime`). §A-decision-2
3. **Image generation — model-gated.** Intimate fields go to the **uncensored Qwen**
   routes (scene generator + character-studio Qwen pose/outfit) at full detail, and
   are **withheld from the Flux** portrait route (Flux disallows them). §A-decision-3
4. **Tone — anatomical schema, prose prompt hints.** Stored values are clinical;
   the `promptHints` fed to the narrator are evocative. §B
5. **Kissing — raises both touch and taste at `close`;** deeper acts raise
   `intimate`. §B-decision-4
6. **Sensory vocabulary — start tight, expand later.** One scent + one taste + one
   texture per relevant region to begin. §B
7. **Anus — in scope.** Modeled now even though it may not come into play for a
   while. §A (region tree)
8. **`speciesId` vs `species_presentation` — keep separate.** Structural id drives
   gating; free text drives description. §C
9. **Phasing — this is the new phase 4**, a standalone build that goes first; the
   prior phase-4 "world moves" cluster is renumbered **phase 5**. See the Phase map
   at the top.
10. **Player character — same model as NPCs.** The player gets a body-config and
    the full anatomy/sensory model; every living entity shares one capability set. §A-decision-1
11. **File layout — dedicated `intimate/` subfolder + region-split locations.**
    Chosen partly so the moderation-sensitive field set is fenced off in one place
    (which also implements Decision 3's Flux exclusion). §D

---

## Rough scope & sequencing

The internal order is forced by dependency:

1. **The gating engine + body-config** (Idea 4's crux + Idea 5's scaffolding,
   built together) — the shared filter and the species registry with `human`.
2. **Port the intimate regions + descriptive attributes** onto the tree, gated by
   #1.
3. **Sensory + taste** (Idea 3) — the taste axis and per-region scent/taste/
   texture, attached to the regions from #2.
4. **Image-generation ripple** (Decision 3) — last, because it depends on which
   regions exist; wire the Qwen-include / Flux-exclude switch here.

Effort, honestly: the data port is mechanical; the **gating engine** and the
**image/safety** work are the real cost. Medium–large overall. The species
scaffolding adds little _on top of_ the gating engine — that's the whole reason to
do them together.

### Cross-cutting flags to carry into the phase plan

- **No database migrations** for any of the registry/attribute/body-location
  edits — that's a standing guarantee of the contracts design. The per-character
  body-config (Decision 1a) rides in the existing profile JSONB, so it needs no
  migration either.
- **Image generation is the real cost** (Decision 3) — the model-gated
  include/exclude switch touches several prompt builders; budget for it.
- **This is romance-core, not a deprioritized RPG mechanic** — it's squarely the
  product's reason to exist, so it ranks high.

---

## What this doc deliberately does NOT cover

Ideas 1 and 2 from the feedback (the pre-narrator **intake steering block** and
**dialogue-economy limits**) are the _other_ half of the intimacy cluster. They
_consume_ what this doc produces (the regions and sensory data feed the steering
block), but they're a separate piece of work with their own design surface
(prompt discipline, the already-approved intake agent). Keeping them out keeps
this doc focused on the **body model**. When both are ready they ship as the
"intimacy beat done well" cluster the feedback describes.

---

## Housekeeping note

The feedback ([ideas-feedback.md](ideas-feedback.md)) assesses "five raw ideas"
that don't match the _current_ contents of
[user-guidance/ideas.md](user-guidance/ideas.md) (which now lists different items
— NPC field-gating, auto-gen agents, autonomy, model/agent work, a World Forge
bug, RAG, time/schema). It looks like ideas.md was rewritten after the feedback
was authored. This doesn't affect the work here — the three ideas are well-defined
in the feedback — but per the docs convention I'd normally add a backlink from
ideas.md to this spec. Tell me if you want me to reconcile ideas.md (and which of
its _current_ items, if any, this spec should be linked from — its NPC
field-gating item is closely related to Decision 1).
