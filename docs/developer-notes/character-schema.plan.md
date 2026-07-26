# Character schema improvements — facial realism + engine-shaped contracts

Status: **draft** — research plan written 2026-07-20 from an owner ask; vocabulary and
sequencing await owner review.

Two threads with one theme: the authored character schema should describe **the person
the owner imagined**, not the person our defaults assume. Thread 1 is the direct ask —
the portrait studio can only make beautiful people, and fixing that needs *descriptive*
facial vocabulary, not a lone "ugly" toggle. Thread 2 surveys what the successor engine
([engine.plan.md](engine.plan.md) / [engine.spec.md](engine.spec.md)) has grown that the
character contracts can start feeding today.

> **Sourcing note:** the engine docs on `main` are the 2026-07-16 draft. The live state
> is the **`engine` branch**, where Gates 0–4 are closed and Gate 5 is underway (E5.1–
> E5.4 shipped, E5.5 slice 1 shipped 2026-07-20: body meters + rhythms, item condition,
> households/means, the relationship ledger + consent vocabulary). Section references
> below (§25, §21.3, §21.4, §37.2, ruling 15/16) are to the engine-branch spec.

---

## Thread 1 — the facial field: describing the whole range of faces

### The problem, precisely

The portrait studio has a **structural beauty bias** that no authored data can express
its way out of:

1. **Every avatar prompt ends in hardcoded beauty language.** `STYLE_SUFFIX`
   (`src/server/images/prompts.ts:60`) appends *"Professional beauty portrait,
   flattering soft studio lighting, photogenic composition, luminous skin rendering …
   magazine-quality"* to every realistic portrait (the stylized variant says
   *"Beautiful stylized portrait, flattering …"*). `buildVariantInstruction`
   (`prompts.ts:422`) adds *"Soft flattering lighting"* to every portrait variant.
2. **No attribute can push back.** The registry describes facial *structure* —
   `face.shape`, `lips.fullness`, `eyes.shape`, `skin.texture` — but has no axis for
   how the face *reads overall*. The closest thing, `presentation.grooming`, is upkeep,
   not looks. (The only literal "beauty" token in the registry is the `beauty_mark`
   skin marking.)
3. **Bare evaluative words don't steer image models anyway.** Diffusion models are
   heavily beauty-biased by their training data; a lone "ugly" token tends to produce
   either a still-pretty face or a caricature. What works is **descriptive** language —
   asymmetry, irregular proportion, unretouched skin, weathering — which is exactly the
   vocabulary the owner asked for. So the fix is a graded enum whose members carry
   authored descriptive phrases, not a beauty slider.

### Design

**A new `face.attractiveness` attribute** — a registry data edit in
`src/contracts/attributes/categories/face.ts`, per the registry-as-extension-point
rule (no schema migration; the value rides `profile.attributes` like everything else).

Proposed definition shape:

- `valueType: "enum"`, `mutability: "inherent"`, `kind: "physical"`,
  `bodyLocationId: "face"`, `renderVisual: true` (a scene render re-invents the face's
  overall read on every image when unset — this is exactly the cross-scene-drift tier),
  `identityAnchor: true` (see "the anchor move" below).
- **Vocabulary** (ascending, snake_case; owner review expected — the *bands* matter
  more than the labels):

  | value | narrator gloss (sketch) | image phrase (sketch) |
  | --- | --- | --- |
  | `grotesque` | features that unsettle at first glance | heavily asymmetric, misshapen features; an unsettling, deliberately ugly countenance — not stylized, not beautified |
  | `ugly` | plainly unattractive | unattractive face, pronounced asymmetry, irregular coarse features; an ugly person rendered honestly, no beautification |
  | `homely` | unpretty in an ordinary, human way | homely, unglamorous face; irregular features; candid and unretouched |
  | `plain` | forgettable; attracts no second look | plain, unremarkable face; everyday features; unretouched candid look |
  | `average` | neither plain nor pretty | ordinary face, natural unretouched skin |
  | `pleasant` | mildly attractive, approachable | pleasant, approachable face; softly attractive features |
  | `attractive` | conventionally good-looking | attractive, well-proportioned features |
  | `beautiful` | genuinely beautiful | beautiful, harmonious features; photogenic |
  | `stunning` | arresting; turns heads | strikingly beautiful, arresting symmetry, magazine-quality beauty portrait |

- `defaultValue`: **`beautiful`** (proposed — preserves today's de-facto output for
  blank creations; owner may prefer `attractive`). No `autoDefaultExcludes` needed:
  the ugly end is never a silent default because the default is explicit.

**A new per-value registry field: `imageGuidance`.** The two existing per-value/hint
mechanisms are deliberately narrator-only — `promptHints` and `narratorGuidance` are
both excluded from image prompts by documented rule. This attribute's whole point is
steering the *image* model, so the registry grows one optional field, the mirror of
`narratorGuidance`: `imageGuidance?: Record<string, string>` (enum-member → phrase,
validated against `allowedValues` at group-definition time, same as narratorGuidance).
Image prompt builders render the phrase **instead of** the bare value token for
attributes that carry it; narrator surfaces ignore it. This is generic machinery —
other attributes whose bare enum token under-describes for image models (e.g.
`skin.texture: weathered`) can adopt it later.

**Neutralize the hardcoded suffix; make beauty authored.** `STYLE_SUFFIX` drops its
evaluative language and keeps craft language only (*"professional portrait photograph,
soft studio lighting, sharp detail, shallow depth of field, 85mm lens bokeh, no text,
no watermark"*); the beauty/plainness/ugliness read comes from the attribute's
`imageGuidance` phrase, placed **early** in the prompt (in or beside the `Subject:`
line, not the late-sorting `face` category bucket — `APPEARANCE_CATEGORY_ORDER` sorts
face near the end, and an overall-read phrase belongs up front where it frames
everything after it). `buildVariantInstruction`'s "Soft flattering lighting" gets the
same treatment. **Fallback rule:** a character with *no* stored value (every existing
character) renders with the legacy beauty suffix, byte-identical to today — the
neutral suffix + gloss path activates only when the attribute is present. No sweep, no
behavior change for existing casts until they're edited.

**The anchor move — let attractiveness condition the forge's structural fills.** The
descriptive phrase alone fights the model's prior; what actually lands the look is
*consistent structural attributes*. The forge already has the mechanism: `identityAnchor`
attributes are inferred first and condition the plausible-subset ranges for unset
core/render visuals. Marking `face.attractiveness` as an anchor means a character
forged from "a haggard dockworker with a face like a dropped pie" gets `ugly` inferred
from the concept, and then face-shape / nose / lips / skin-texture fills drawn from
ranges *consistent with* ugly — asymmetric-leaning shapes, weathered textures — rather
than the pretty-leaning defaults. (Authoring invariant, mirroring the narratorGuidance
orthogonality rule: the `imageGuidance` phrase itself stays at the harmony /
symmetry / retouching level and never names a feature that has its own attribute —
the *fills* carry feature-level specifics, so an explicit authored nose always wins.)

### Touch points (implementation sketch)

1. `contracts/attributes/types.ts` — add `imageGuidance` + definition-time validation
   (enum-only, keys ⊆ allowedValues).
2. `contracts/attributes/categories/face.ts` — the new attribute (vocabulary above +
   `narratorGuidance` glosses for the narrator side).
3. `server/images/prompts.ts` — neutral `STYLE_SUFFIX` / variant lighting line behind
   the presence check; render `imageGuidance` phrases; hoist the attractiveness phrase
   to the subject line; keep `AVATAR_OMIT_ATTRIBUTES` untouched (the field must reach
   avatars).
4. Scene path: `characterAppearanceSummary` + `identityAnchorSummary` pick the value up
   automatically; add the id to `IDENTITY_ANCHOR_ATTRIBUTE_IDS` so reference-locked
   renders re-assert it.
5. `server/authoring/portrait-attributes.ts` — the from-portrait vision reader offers
   the new attribute automatically; confirm its closed-vocabulary list includes it.
6. Forge: anchor-conditioned fills (`character-forge.ts` plausible ranges).
7. Docs: `docs/images.md` (document the suffix change **and** the previously
   undocumented beauty bias it replaces), `docs/contracts/attributes.md` (the
   `imageGuidance` field + vocabulary table row).
8. Eval: a small portrait sweep across the vocabulary on the current model set (Venice)
   — the plan's exit test is *"an `ugly` character's portrait is recognizably not a
   beautiful person's"*, judged by eye against the sweep, before any wider authoring.

### Skin micro-detail realism — blush, blemishes, and the blatancy problem

Owner report (2026-07-20): transient/small skin details — blushing, flushed skin,
pimples — render **blatant and badly blended** (a painted-on patch, not skin). This is
one problem with two cases, and the codebase has already fought (and half-won) one of
them:

**The house learning already on the books.** The scene lane discovered that image
models paint *colour-state words* as **cosmetics**: "flushed"/"blushing"/"rosy" comes
back as stage blusher (scene-pov-embodiment slice 0, owner report). The shipped answer
is a translate-don't-say law: `visualStateNote` (`server/images/character-scene.ts`)
states physiology the model paints *as* physiology — "eyes bright and heavy-lidded,
lips parted, breath shallow, a faint sheen of sweat" — the composer system rule forbids
skin-colour words outright, and `scrubBlush` (`server/images/prompts.ts:1044`) is the
deterministic backstop over every composer-authored field. That is the answer for
**transient states**: don't name the colour, name the body. It works because the model
has seen bright eyes and damp hairlines blended into real photos, but "blushing" mostly
appears in its training data as makeup.

**Gap 1 — the portrait studio is unprotected.** `buildVariantInstruction`
(`prompts.ts:422`) passes the user's typed variant instruction **verbatim** — "make her
blush" in the studio hits exactly the failure the scene lane already closed. Fix in
slice 1: run the variant instruction through `scrubBlush`'s family with a
*translation* rather than a bare drop (the studio user asked for something; dropping
it silently is worse than a scene clause) — a small deterministic map from the
colour-state family to the physiology phrasing ("blush" → "a shy, warm expression,
eyes averted, faint sheen on the cheekbones"), plus the same rule line in the variant
framing so model-side compliance backs the scrub.

**Gap 2 — persistent imperfections have no vocabulary at all.** `skin.markings` has
scars/moles/vitiligo but nothing for acne/blemishes, and `skin.texture` tops out at
"weathered". Unlike blush, these are *wanted, authored* details — a ban is the wrong
tool. But the bare noun fails twice: models **amplify** a standalone token ("pimples" →
severe cystic acne covering the face) and render it **unblended** (pasted over the
beauty-prior skin, which `STYLE_SUFFIX`'s "luminous skin rendering" actively demands —
slice 1 already removes that). The wording that works, and what the `imageGuidance`
phrases should encode:

1. **Photographic realism framing, not dermatology nouns** — "natural unretouched
   skin, visible pores", "candid photo, no retouching". These recruit the model's
   *real-photo* prior, which is where blended imperfections live.
2. **Quantity + region limiters** — "a few small blemishes along the jawline", never
   the bare plural. The count word and the anchor region are what stop amplification.
3. **Texture-level integration** — fold the detail into the skin clause ("slightly
   uneven, blemish-prone skin") rather than emitting it as its own list item, so it
   reads as a property of the skin instead of an object on it.

Concretely: a new graded **`skin.blemishes`** attribute (`none / rare / occasional /
prominent`, `mutability: "mutable"`, default `none`) whose `imageGuidance` phrases are
built from the three rules above — e.g. `occasional` → *"natural unretouched skin with
a few small blemishes across the forehead and jawline, visible pores"* — and whose
narrator glosses stay behavioral-neutral. `skin.texture` gains `imageGuidance` for its
under-steering members the same way (`weathered`, `rough`). This rides the slice-1
`imageGuidance` machinery unchanged — it's the second customer that proves the field
is generic, and the eval sweep grows a blemish/blush column: *rendered detail is
visible AND blended* is the pass condition.

(The negative-prompt spike — OQ2 — matters double here: "airbrushed, flawless skin,
retouched, glamour" as a negative fights the beauty prior from the other side for
every band below `beautiful` *and* for every blemish value above `none`.)

### Open questions (thread 1)

- **OQ1 — vocabulary + default.** Are these the right nine bands and labels? Is
  `grotesque` wanted at all, and is `beautiful` the right stored default for blank
  creations? (Owner review.)
- **OQ2 — negative prompts.** Venice t2i models accept negative prompts we don't
  currently send; "beautiful, glamour, retouched" as a negative for the ugly bands
  would fight the model prior from both sides. Worth a spike during the eval sweep, or
  out of scope?
- **OQ3 — social consequence.** Should attractiveness feed the *social* layer (first
  impressions, NPC reactions — a natural social-card / reaction-modulation input)?
  Deliberately out of scope here; park or plan separately.
- **OQ4 — supernatural beauty.** Species like the succubus imply an `otherworldly`
  band beyond `stunning` (inhuman symmetry as a feature). Add a tenth value now or let
  heritage notes carry it?
- **OQ8 — wanted transient blush.** The translate-don't-say law renders arousal as
  physiology, never colour. If the owner *wants* visible reddening sometimes (an
  anime-adjacent stylized portrait can carry it), that's a per-style carve-out
  (`stylized` only?) to rule on — the realistic lane's ban stands regardless.

---

## Thread 2 — what the engine adds that character contracts can feed

The successor's stance (spec §5): **CharacterTemplate is authored input; WorldCharacter
is historical identity.** Our character schema *is* the template side. Everything below
is ranked by "can the chat lane use it now, and does it become the instantiation seed
later" — pre-adoption is cheap because the profile is jsonb (data edits, no
migrations), and every field added now is one less `authored_prior`-style backfill at
migration time.

### 2.1 Typed schedule kinds — the one the engine explicitly demands

Spec §37.2 + plan "Preserve the queued meter ruling": `inferScheduleKind` is a
**temporary migration adapter** — *"new schedule data MUST use a typed kind; unknown
text MUST remain unknown and MUST NOT cause hard body or location effects."* The
engine's `sim_body_rhythms` (E5.2) runs sleep/wash windows; the chat meter-economy plan
needs the same kinds for rhythm self-care.

**Change:** `scheduleEntrySchema` (`contracts/world/profile.ts`) gains
`kind?: "sleep" | "wash" | "meal" | "work" | "leisure" | "unknown"`. The editor's
Daily-rhythm card offers the vocabulary; the forge drafts it; `inferScheduleKind` runs
only over legacy kind-less entries (shadow-logged, per the plan's adapter rules) and is
deleted once authored coverage crosses the declared threshold. This is the highest-
leverage single field in this doc — §A and half of §B of
[world-engine-refactor.plan.md](world-engine-refactor.plan.md) hang off it (its C.1:
*"The one enabler … Everything in §A and half of §B depends on it"*).

### 2.2 Birthday — the calendar anchor for aging

world-engine-refactor C.5: the clock runs, nobody ages. `profile.birthday`
({month, day}, optional year) makes age a **derivation** (`deriveAge` from
`calendar_start` + clock) instead of static text — and a birthday is plan-shaped,
milestone-shaped, and a romance beat ("she can be hurt if the player forgets") for the
cost of one field. The free-text `age` stays (fantasy ages; the narrator-facing line);
birthday is the structured sibling, exactly like `age` vs `identity.apparent_age`.

### 2.3 The attraction axis — completing the authored relationship record

The relationship ledger (spec §21.3, E5.5 slice 1 **shipped**) derives a directional
**trust / attraction / resentment** read, seeded from `authored_prior` entries — which
exist precisely to carry what our authored records say. Our authored record
(`authoredRelationshipRecordSchema`) carries familiarity + regard; **attraction is the
reserved third axis nobody built** (world-engine-refactor E.1: *"the cheapest axis
anyone will ever add"* — a record addition, never a migration). Adding an authored
`attraction` band completes the mapping: familiarity/regard/attraction →
authored-prior seeds for the ledger's three-axis read, and the chat lane can surface it
immediately (a romance product currently has no authored way to say "she's drawn to him
but doesn't trust him").

### 2.4 Consent scaffolding — authored boundaries in the intimacy field's shape

Ruling 16 + spec §21.4: consent is ledger-gated and **fail-closed** under a closed
`ConsentScopeKey` vocabulary (`closeness`, `kiss`, `touch_intimate`, `undress`, `sex`),
with boundaries/permissions as typed entries. Today our only authored input to that
future gate is the free-text `intimacy` note. A structured sibling —
`profile.boundaries`: a small list of `{ scopeKey, stance: "boundary" | "open" }` rows —
instantiates directly as `boundary_stated` / `permission_granted` authored entries at
migration, and the *chat* narrator can respect it now as law-shaped context (the
character-fidelity pattern: authored data rendered as binding lines). This also gives
the minor fence and content-framing machinery a structured hook instead of prose.
**Scope it small:** stances per scope key, no per-partner matrices — the ledger owns
per-dyad history; the template owns standing disposition.

### 2.5 Means band — the 90% economy field

E5.4 shipped `sim_means_bands` + `deriveMeansRead` (bands with an explicit `unknown`
degraded default); world-engine-refactor G.1 calls the authored band *"90% of the value
of an economy for 1% of the cost."* Add `profile.means: "broke" | "getting_by" |
"comfortable" | "wealthy"` (absent = unknown). Chat narrator respects it today (what
she can afford, where she'd eat, gift scale — composes with the shipped plans/gifts
machinery); at migration it seeds `set_means_band` verbatim.

### 2.6 Smaller alignments (note now, build when touched)

- **Template versioning (spec §5).** *"Editing a template MUST NOT silently rewrite an
  instantiated character's past."* Cheap pre-adoption: a `revision` counter (or content
  hash) bumped on character save, recorded by chats/instantiations that copied it.
  Defer until something consumes it, but stop designing schema features that assume
  live template reads are safe.
- **Per-actor body baselines (ruling 15).** The engine's meters are personalized (the
  actor's *own* sleep window, per-actor arousal baseline). Sleep/wash windows fall out
  of 2.1; if the meter-economy plan wants more authored baselines (appetite, libido
  baseline), they belong in one `profile.body`-adjacent bag, not scattered fields —
  coordinate with [chat-meter-economy.plan.md](chat-meter-economy.plan.md) rather than
  adding here.
- **Wardrobe condition (E5.3 slice 3).** Items now carry wear/cleanliness meters
  engine-side (`conditionTracked`). This is an **item**-schema alignment, not a
  character one — noted so the item library plans pick it up.
- **What NOT to pre-adopt:** locations/topology (Gate 3 space is engine-authoritative;
  chat's don't-build ruling on movement stands — world-engine-refactor D.6),
  observation/belief tables (§20–21 are branch-scoped runtime state, nothing to
  author), and any per-minute/body-tick machinery (both lanes forbid it).

### Open questions (thread 2)

- **OQ5 — schedule-kind vocabulary.** Is `sleep|wash|meal|work|leisure` complete for
  authoring (commute? errand?), and does `unknown` surface in the editor or only in
  parsed legacy rows?
- **OQ6 — boundaries v1 scope.** Is the per-scope stance list (2.4) the right first
  shape, or does the owner prefer to keep consent entirely free-text until the chat
  lane actually gates on it?
- **OQ7 — attraction band vocabulary.** Reuse the regard band names or a bespoke scale
  (indifferent / curious / drawn / infatuated)? Must match what the ledger read will
  band, or map cleanly onto it.

---

## Sequencing sketch (not a commitment)

1. **Slice 1 — the facial field + skin micro-detail realism** (thread 1,
   self-contained, the direct ask): `imageGuidance` machinery + `face.attractiveness` +
   `skin.blemishes` + the variant-instruction blush translation + neutral suffix +
   forge anchor + docs + the portrait eval sweep (attractiveness bands × blemish/blush
   blending).
2. **Slice 2 — typed schedule kinds** (2.1) — coordinates with
   [chat-meter-economy.plan.md](chat-meter-economy.plan.md), which consumes them.
3. **Slice 3 — the cheap authored fields**: birthday (2.2), attraction band (2.3),
   means (2.5) — three data-edit fields, each with an editor row, a forge draft rule,
   and one narrator surface.
4. **Slice 4 — consent scaffolding** (2.4) — after the owner rules OQ6.

Each slice is independently shippable; nothing here blocks (or is blocked by) the
engine gates — that's the point of pre-adopting template-side fields.
