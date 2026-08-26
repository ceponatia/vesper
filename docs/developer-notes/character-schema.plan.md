# Character schema improvements — facial realism + engine-shaped contracts

Status: **draft** — nothing in this plan is built. Written 2026-07-20 from an owner ask;
vocabulary and sequencing await owner review. Re-verified against the tree 2026-08-07: no
attractiveness attribute, no image-guidance field, no blemish attribute, no typed schedule
kinds, no birthday, no authored attraction band, no authored means band, and no authored
boundaries exist yet, and the portrait studio's beauty suffix is unchanged.

Outcome: The owner can author a character the app neither prettifies nor leaves blank —
a plain, weathered, or unattractive face renders as one, and her mealtimes, birthday,
money, and stated boundaries are recorded instead of invented at play time.

Two threads with one theme: the authored character schema should describe **the person
the owner imagined**, not the person our defaults assume. Thread 1 is the direct ask —
the portrait studio can only make beautiful people, and fixing that needs *descriptive*
facial vocabulary, not a lone "ugly" toggle. Thread 2 surveys what the successor engine
has grown that the character contracts can start feeding today.

> **Where the engine stands.** The successor engine is no longer a branch: gates 0–6 all
> closed between 2026-07-16 and 2026-07-21, and the rollout finished 2026-07-22 — the
> engine is the live world authority for successor chats and the legacy world/session
> model is deleted. Every engine feature named in thread 2 is **shipped and running**;
> what is missing is the *authored* side, which is entirely this plan's. Section
> references below (§25, §21.3, §21.4, §37.2, rulings 15 and 16) point at
> `engine.spec.md`'s § index and still resolve.

---

## Thread 1 — the facial field: describing the whole range of faces

### The problem, precisely

The portrait studio has a **structural beauty bias** that no authored data can express
its way out of:

1. **Every avatar prompt ends in hardcoded beauty language.** The realistic style suffix
   in `src/server/images/prompts-*.ts` appends *"Professional beauty portrait, flattering
   soft studio lighting, photogenic composition, luminous skin rendering … magazine-
   quality"* to every realistic portrait (the stylized variant says *"Beautiful stylized
   portrait, flattering …"*), and the variant instruction builder adds *"Soft flattering
   lighting"* to every portrait variant.
2. **No attribute can push back.** The registry describes facial *structure* — face shape,
   lip fullness, eye shape, skin texture — but has no axis for how the face *reads
   overall*. The closest thing, grooming, is upkeep, not looks. (The only literal "beauty"
   token in the registry is the beauty-mark skin marking.)
3. **Bare evaluative words don't steer image models anyway.** Diffusion models are
   heavily beauty-biased by their training data; a lone "ugly" token tends to produce
   either a still-pretty face or a caricature. What works is **descriptive** language —
   asymmetry, irregular proportion, unretouched skin, weathering — which is exactly the
   vocabulary the owner asked for. So the fix is a graded enum whose members carry
   authored descriptive phrases, not a beauty slider.

### Design

**A new `face.attractiveness` attribute** — a registry data edit, per the
registry-as-extension-point rule, so there is no schema migration: the value rides the
character's attribute list like everything else.

It is an inherent, physical, face-located, visually rendered attribute, and an **identity
anchor** (see "the anchor move" below) so a scene render cannot re-invent the face's
overall read on every image.

**Vocabulary** — ascending; owner review expected, and the *bands* matter more than the
labels. Each entry pairs a narrator gloss with an image phrase:

- **grotesque** — features that unsettle at first glance / heavily asymmetric, misshapen
  features; an unsettling, deliberately ugly countenance, not stylized, not beautified.
- **ugly** — plainly unattractive / pronounced asymmetry, irregular coarse features,
  rendered honestly with no beautification.
- **homely** — unpretty in an ordinary, human way / homely, unglamorous face; irregular
  features; candid and unretouched.
- **plain** — forgettable; attracts no second look / plain, unremarkable everyday
  features; unretouched candid look.
- **average** — neither plain nor pretty / ordinary face, natural unretouched skin.
- **pleasant** — mildly attractive, approachable / softly attractive features.
- **attractive** — conventionally good-looking / well-proportioned features.
- **beautiful** — genuinely beautiful / harmonious features; photogenic.
- **stunning** — arresting; turns heads / strikingly beautiful, arresting symmetry,
  magazine-quality beauty portrait.

The proposed default is **beautiful**, which preserves today's de-facto output for blank
creations; the owner may prefer *attractive*. The ugly end is never a silent default
because the default is explicit.

**A new per-value registry field for image guidance.** The two existing per-value hint
mechanisms are deliberately narrator-only — prompt hints and narrator guidance are both
excluded from image prompts by documented rule. This attribute's whole point is steering
the *image* model, so the registry grows one optional mirror field mapping each enum
member to a phrase, validated against the allowed values at definition time exactly as
narrator guidance is. Image prompt builders render the phrase **instead of** the bare
value token for attributes that carry it; narrator surfaces ignore it. This is generic
machinery — other attributes whose bare token under-describes for image models can adopt
it later.

**Neutralize the hardcoded suffix; make beauty authored.** The style suffix drops its
evaluative language and keeps craft language only (lighting, lens, detail, no text, no
watermark); the beauty, plainness or ugliness read comes from the attribute's image phrase,
placed **early** in the prompt where it frames everything after it rather than in the
late-sorting face bucket. The variant instruction's flattering-lighting line gets the same
treatment. **Fallback rule:** a character with no stored value — which is every existing
character — renders with the legacy beauty suffix, byte-identical to today. The neutral
suffix activates only when the attribute is present. No sweep, no behavior change for
existing casts until they are edited.

**The anchor move — let attractiveness condition the forge's structural fills.** The
descriptive phrase alone fights the model's prior; what actually lands the look is
*consistent structural attributes*. The forge already has the mechanism: identity-anchor
attributes are inferred first and condition the plausible ranges for unset visuals. Making
attractiveness an anchor means a character forged from "a haggard dockworker with a face
like a dropped pie" gets *ugly* inferred from the concept, and then face shape, nose, lips
and skin texture fills drawn from ranges *consistent with* ugly rather than the
pretty-leaning defaults. The authoring invariant mirrors the existing narrator-guidance
orthogonality rule: the image phrase stays at the harmony / symmetry / retouching level and
never names a feature that has its own attribute, so an explicit authored nose always wins.

### Skin micro-detail realism — blush, blemishes, and the blatancy problem

Owner report (2026-07-20): transient and small skin details — blushing, flushed skin,
pimples — render **blatant and badly blended**, a painted-on patch rather than skin. This is
one problem with two cases, and the codebase has already fought (and half-won) one of them.

**The house learning already on the books.** The scene lane discovered that image models
paint *colour-state words* as **cosmetics**: "flushed", "blushing" and "rosy" come back as
stage blusher. The shipped answer is a translate-don't-say law — the scene lane's visual
state note states physiology the model paints *as* physiology ("eyes bright and
heavy-lidded, lips parted, breath shallow, a faint sheen of sweat"), the composer's system
rule forbids skin-colour words outright, and a deterministic blush scrub backstops every
composer-authored field. That is the answer for **transient states**: don't name the
colour, name the body. It works because the model has seen bright eyes and damp hairlines
blended into real photos, while "blushing" mostly appears in its training data as makeup.

**Gap 1 — the portrait studio is unprotected.** The variant instruction builder passes the
user's typed instruction **verbatim**, so "make her blush" in the studio hits exactly the
failure the scene lane already closed. Fix in slice 1: run the variant instruction through
the scrub's family with a *translation* rather than a bare drop — the studio user asked for
something, and dropping it silently is worse than dropping a scene clause. A small
deterministic map from the colour-state family to physiology phrasing ("blush" → "a shy,
warm expression, eyes averted, faint sheen on the cheekbones"), plus the same rule line in
the variant framing so model-side compliance backs the scrub.

**Gap 2 — persistent imperfections have no vocabulary at all.** Skin markings cover scars,
moles and vitiligo but nothing for acne or blemishes, and skin texture tops out at
"weathered". Unlike blush, these are *wanted, authored* details — a ban is the wrong tool.
But the bare noun fails twice: models **amplify** a standalone token ("pimples" → severe
cystic acne covering the face) and render it **unblended**, pasted over the beauty-prior
skin that the current suffix's "luminous skin rendering" actively demands. The wording that
works, and what the image phrases should encode:

1. **Photographic realism framing, not dermatology nouns** — "natural unretouched skin,
   visible pores", "candid photo, no retouching". These recruit the model's *real-photo*
   prior, which is where blended imperfections live.
2. **Quantity and region limiters** — "a few small blemishes along the jawline", never the
   bare plural. The count word and the anchor region are what stop amplification.
3. **Texture-level integration** — fold the detail into the skin clause ("slightly uneven,
   blemish-prone skin") rather than emitting it as its own list item, so it reads as a
   property of the skin instead of an object on it.

Concretely: a new graded **`skin.blemishes`** attribute (none / rare / occasional /
prominent, mutable, defaulting to none) whose image phrases are built from the three rules
above, and whose narrator glosses stay behaviorally neutral. Skin texture gains image
guidance for its under-steering members the same way. This rides the slice-1 machinery
unchanged — it is the second customer that proves the field is generic — and the eval sweep
grows a blemish and blush column, where the pass condition is *rendered detail is visible
AND blended*.

The negative-prompt spike (OQ2) matters double here: "airbrushed, flawless skin, retouched,
glamour" as a negative fights the beauty prior from the other side for every band below
*beautiful* **and** for every blemish value above *none*.

### Touch points (implementation sketch)

1. Attribute types — add the image-guidance field plus definition-time validation
   (enum-only, keys a subset of the allowed values).
2. The face attribute category — the new attribute, with narrator glosses for the
   narrator side.
3. Image prompts — neutral style suffix and variant lighting line behind the presence
   check; render image-guidance phrases; hoist the attractiveness phrase to the subject
   line; leave the avatar omit-list untouched so the field reaches avatars.
4. Scene path — the appearance and identity-anchor summaries pick the value up
   automatically; add the id to the identity-anchor list so reference-locked renders
   re-assert it.
5. The from-portrait vision reader offers the new attribute automatically; confirm its
   closed-vocabulary list includes it.
6. Forge — anchor-conditioned plausible ranges.
7. Docs — `docs/images/pipelines.md` (document the suffix change **and** the previously undocumented
   beauty bias it replaces) and `docs/contracts/attributes.md` (the new field plus a
   vocabulary row).
8. Eval — a small portrait sweep across the vocabulary on the current model set. The exit
   test is *"an ugly character's portrait is recognizably not a beautiful person's"*, judged
   by eye against the sweep, before any wider authoring.

### Open questions (thread 1)

- **OQ1 — vocabulary and default.** Are these the right nine bands and labels? Is
  *grotesque* wanted at all, and is *beautiful* the right stored default for blank
  creations? (Owner review.)
- **OQ2 — negative prompts.** Venice text-to-image models accept negative prompts we don't
  currently send; "beautiful, glamour, retouched" as a negative for the ugly bands would
  fight the model prior from both sides. Worth a spike during the eval sweep, or out of
  scope?
- **OQ3 — social consequence.** Should attractiveness feed the *social* layer (first
  impressions, NPC reactions)? Deliberately out of scope here; park or plan separately.
- **OQ4 — supernatural beauty.** Species like the succubus imply an *otherworldly* band
  beyond *stunning* (inhuman symmetry as a feature). Add a tenth value now, or let heritage
  notes carry it?
- **OQ8 — wanted transient blush.** The translate-don't-say law renders arousal as
  physiology, never colour. If the owner *wants* visible reddening sometimes — an
  anime-adjacent stylized portrait can carry it — that is a per-style carve-out to rule on.
  The realistic lane's ban stands regardless.

---

## Thread 2 — what the engine adds that character contracts can feed

The successor's stance (engine.spec §5): **a character template is authored input; a world
character is historical identity.** Our character schema *is* the template side. Everything
below is ranked by "can the chat lane use it now, and does it become the instantiation seed
later" — pre-adoption is cheap because the profile is jsonb (data edits, no migrations), and
every field added now is one less authored-prior backfill at instantiation time.

### 2.1 Typed schedule kinds — the one the engine explicitly demands

Engine.spec §25.5 and §37.2: **new schedule data must use a typed kind; unknown text must
remain unknown and must not cause hard body or location effects**, and any text-inference
adapter is temporary. The engine's own authored rhythm rows already run typed sleep and wash
windows; the chat meter economy needs the same kinds for rhythm self-care.

**Change:** a character's schedule entries gain an optional kind — sleep, wash, meal, work,
leisure, unknown. The editor's daily-rhythm card offers the vocabulary and the forge drafts
it. A text-inference adapter, if built at all, runs only over legacy kind-less entries,
shadow-logged, and is deleted once authored coverage crosses the declared threshold. **No
such adapter exists today**, so "retire it" is a rule for whoever writes one, not a cleanup
task.

This is the highest-leverage single field in this doc — a large fraction of
`world-engine-refactor.plan.md`'s body and rhythm catalog
depends on it, as does [chat-meter-economy.plan.md](chat-meter-economy.plan.md) §4.
Whichever plan moves first adds the field; the other consumes it.

### 2.2 Birthday — the calendar anchor for aging

The clock runs and nobody ages. A structured birthday (month and day, optional year) makes
age a **derivation** from the calendar anchor plus the clock instead of static text — and a
birthday is plan-shaped, milestone-shaped, and a romance beat ("she can be hurt if the
player forgets") for the cost of one field. The free-text age stays for fantasy ages and the
narrator-facing line; birthday is the structured sibling, exactly like age versus apparent
age.

### 2.3 The attraction axis — completing the authored relationship record

The engine's relationship ledger (§21.3, shipped) derives a directional **trust /
attraction / resentment** read, seeded from authored-prior entries — which exist precisely
to carry what our authored records say. Our authored record carries familiarity and regard;
**attraction is the reserved third axis nobody built**, and it remains a record field
addition, never a migration. Adding an authored attraction band completes the mapping —
familiarity, regard and attraction become authored-prior seeds for the ledger's three-axis
read — and the chat lane can surface it immediately. A romance product currently has no
authored way to say "she's drawn to him but doesn't trust him".

### 2.4 Consent scaffolding — authored boundaries in the intimacy field's shape

Ruling 16 and §21.4: consent is ledger-gated and **fail-closed** under a closed scope
vocabulary — closeness, kiss, touch_intimate, undress, sex — with boundaries and permissions
as typed entries. That gate is built and running in the successor lane. Today our only
authored input to it is a free-text intimacy note. A structured sibling — a small list of
scope-plus-stance rows — instantiates directly as boundary or permission entries, and the
*chat* narrator can respect it now as law-shaped context, following the character-fidelity
pattern of authored data rendered as binding lines. This also gives the minor fence and
content-framing machinery a structured hook instead of prose. **Scope it small:** a stance
per scope key, no per-partner matrices — the ledger owns per-dyad history; the template owns
standing disposition.

### 2.5 Means band — the 90% economy field

The engine ships means bands and a derived means read with an explicit unknown default. An
authored band on the character profile lets the chat narrator respect it today — what she
can afford, where she'd eat, gift scale, composing with the shipped plans and gifts
machinery — and seeds the engine's band at instantiation.

**The engine's vocabulary is six keys, not four**: destitute, struggling, modest,
comfortable, wealthy, opulent. The authored band should adopt those keys outright rather
than invent a coarser scale that then needs a mapping table.

### 2.6 Smaller alignments (note now, build when touched)

- **Template versioning (§5).** Editing a template must not silently rewrite an instantiated
  character's past. Cheap pre-adoption: a revision counter or content hash bumped on
  character save, recorded by whatever copied the template. Defer until something consumes
  it, but stop designing schema features that assume live template reads are safe.
- **Per-actor body baselines (ruling 15).** The engine's meters are personalized — the
  actor's own sleep window, per-actor meter baselines. Sleep and wash windows fall out of
  §2.1; if the meter economy wants more authored baselines (appetite, libido), they belong
  in one body-adjacent bag rather than scattered fields — coordinate with
  [chat-meter-economy.plan.md](chat-meter-economy.plan.md) rather than adding here.
- **Wardrobe condition.** Items carry wear and cleanliness meters engine-side. That is an
  **item**-schema alignment, not a character one — noted so the item library plans pick it
  up.
- **What NOT to pre-adopt:** locations and topology (space is engine-authoritative, and the
  chat lane's don't-build ruling on movement stands), observation and belief tables (branch-
  scoped runtime state, nothing to author), and any per-minute body-tick machinery (both
  lanes forbid it).

### Open questions (thread 2)

- **OQ5 — schedule-kind vocabulary.** Is sleep / wash / meal / work / leisure complete for
  authoring (commute? errand?), and does *unknown* surface in the editor or only in parsed
  legacy rows?
- **OQ6 — boundaries v1 scope.** Is the per-scope stance list (2.4) the right first shape,
  or does the owner prefer to keep consent entirely free-text until the chat lane actually
  gates on it?
- **OQ7 — attraction band vocabulary.** Reuse the regard band names or a bespoke scale
  (indifferent / curious / drawn / infatuated)? It must map cleanly onto what the ledger
  read bands.
- **OQ9 — does the technical half of this plan need its own spec?** Thread 1 carries
  registry field shapes, prompt-assembly ordering, and a touch-point list that belong in a
  `character-schema.spec.md` under the plan/spec boundary rule. Split it at the same time as
  the owner review that settles OQ1.

---

## Sequencing sketch (not a commitment)

1. **Slice 1 — the facial field and skin micro-detail realism** (thread 1, self-contained,
   the direct ask): the image-guidance machinery, the attractiveness attribute, the blemish
   attribute, the variant-instruction blush translation, the neutral suffix, the forge
   anchor, docs, and the portrait eval sweep across attractiveness bands and blush/blemish
   blending.
2. **Slice 2 — typed schedule kinds** (2.1) — coordinates with
   [chat-meter-economy.plan.md](chat-meter-economy.plan.md), which consumes them.
3. **Slice 3 — the cheap authored fields**: birthday (2.2), attraction band (2.3), means
   (2.5) — three data-edit fields, each with an editor row, a forge draft rule, and one
   narrator surface.
4. **Slice 4 — consent scaffolding** (2.4) — after the owner rules OQ6.

Each slice is independently shippable; nothing here blocks, or is blocked by, engine work —
that is the point of pre-adopting template-side fields.
