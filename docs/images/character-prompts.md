# Character prompts

Every character-image render — a library portrait, a portrait variant, a chat
scene, a chat-look anchor, the Image Lab's staged bench — builds the prompt it
sends through one seam,
`apps/web/src/server/images/character-prompt-program.ts`. It owns the whole
semantic path from a lane's realized visual cut to a compiled program: the cast
merge, the world-digest assembly, the operation contract, binding and pack
resolution, reference planning, the prompt budget and the compile.

The layer it compiles through is [prompt-programs.md](prompt-programs.md); this
page states what is true of CHARACTER renders specifically. A lane supplies only
what is genuinely its own — which profile it resolved, which people it draws,
which references it will send, and what job it is asking for — and gets back the
prompt text, any compiled negative, the provenance the row records, and the
reference list it must send.

## Owns / does not own

- **Owns:** the character projection into world facts, the cast, reference
  planning and slot numbering, the reference-anchored identity anchor, the
  per-lane apparent-age policy, and the refusals the seam adds to the layer's
  own.
- **Does not own:** the compile itself, dialects, packs and bindings
  ([prompt-programs.md](prompt-programs.md)); how a cast's per-person cuts are
  produced and folded ([pipelines/scene-subjects.md](pipelines/scene-subjects.md));
  what each lane does with the result (the lane pages under
  [pipelines/](pipelines/README.md)).

## The character projection

Character subjects reach the digest through a two-module seam in
`apps/web/src/contracts/images/`, and the split is an ownership boundary, not a
convenience:

| Layer                          | Owns                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| observer recognition           | the deliberately narrow catalog of distinctive recognizable cues   |
| attribute registry             | image-description eligibility, class and canonical readable value  |
| visual state                   | current presentation, camera-visible truth and transient state     |
| `subject-digest.ts` (scaffold) | vocabulary translation; it adds no truth                           |
| `character-adapter.ts`         | render visibility, replacement and completeness over those owners  |

`projectSubjectDigests` translates the visual digest's classification into
concepts and dispositions, verbatim. `projectCharacterWorldSlices` consumes it
and states what translation alone cannot:

- **A truth fingerprint is provenance, never prompt semantics.** Appearance
  facts arrive carrying their fingerprint as `value`; the adapter answers them
  from the canonical owners — the attribute registry, the located-fact rows, the
  anatomy rows — and never decodes or guesses from a fingerprint. A fact no
  owner can value is suppressed, and a required one lands in `missingRequired`
  so a lane compiled with `refuseOnMissingRequired` fails closed.
- **Apparent age** is stated from the `identity.apparent_age` attribute through
  the image age vocabulary (`imageAgeBandPhrases`), whose floor is an explicit
  adult (owner ruling 2026-07-29): a minor band the registry recognizes states
  nothing — a designed suppression, never a missing anchor — while an absent
  value, or one outside the registry's vocabulary, fails the mandatory age
  segment closed. All of it under the lane's apparent-age policy
  ([§Apparent age per lane](#apparent-age-per-lane)): a lane that omits age
  states none, whatever the band.
- **Exposure** is the adapter's own authoritative `subject.exposure` claims over
  the garment coverage readout, worded by `visual-segments.ts`'s one canonical
  table — in its predicate-fragment inflection, since dialects wrap exposure
  values as `<subject> is <value>` — and gated to the regions the digest's
  framing band can show. Covered regions are silent — silence is the covered
  statement — and a subject with no joined coverage readout fails the mandatory
  exposure closed.
- **An authored absence** re-files its anatomy fact as `subject.absence` — the
  same `morphology` segment kind, a different protection — which takes the
  missing-part exclusions off the negative channel's table; a prosthetic
  additionally tags `morphology.synthetic_surface`.
- **Every emitted value is prompt-ready.** Record-shaped values resolve to their
  readable members with ids stripped; a record with nothing readable left is
  suppressed rather than flattened into a payload.

### Registry-backed image appearance

Ordinary image description is independent of observer recognition. The
recognition projection remains a small catalog of features useful for noticing
and identifying somebody; broadening it would make common hair, eye, face and
build facts into recognition events. The attribute registry instead marks the
values eligible for image description with `imageAppearance`, and
`projectImageAppearanceAttributes` projects those resolved values without
changing the recognition catalog or creating a lane-owned appearance string.

The metadata divides eligible values by their use in an image:

| Class           | Role                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `core`          | stable identity and silhouette description, including the reference-free completeness candidates      |
| `reinforcement` | useful face, skin, hair and body detail when the shot can show it                                     |
| `fine`          | close or full-body detail admitted only at a framing and exposure where it can contribute             |
| `fallback`      | sheet presentation used only while no current hairstyle, grooming, expression or wardrobe owner wins  |

The projector takes the last resolved row for each attribute id and applies the
registry's policy before the adapter sees it:

- attributes with no `imageAppearance` metadata, nonvisual attributes and
  `excludeFromPrompts` definitions are absent;
- realized-body applicability removes stale facts whose anatomy or body plan no
  longer permits them;
- `none` follows the registry's prompt-elision rule, and metadata may omit other
  valid storage values that add no useful image instruction;
- `formatAttribute` supplies the readable label and value. The source attribute
  id and canonical truth fingerprint remain provenance and never become prompt
  prose.

The adapter then applies render-specific policy once for every lane. A fact's
inclusive minimum-to-maximum framing range and body location decide whether the
camera can use it; coverage removes hidden surface detail; and full hair
concealment removes both sheet and
current hair facts in favor of the required concealment claim. Full-figure facts
such as categorical height, leg build and hands do not consume a waist-up or
close prompt. Current hairstyle replaces sheet `hair.arrangement` and
`hair.style`, current grooming replaces sheet `presentation.grooming`, and a
current expression, pose or scene direction replaces `face.expression_default`.
An actual wardrobe suppresses the sheet's personal dress style; that style may
guide invention only when no wardrobe owner supplies the outfit.

### Reference-free completeness

Completeness is a property of the actual planned render, not of observer
recognition or character creation. A subject without a valid identity reference
must provide every applicable reference-free core value:

- `identity.apparent_age`, under the lane's age policy, and `identity.gender`;
- `skin.tone`;
- `hair.color` and `hair.length`, unless hair is absent, inapplicable or fully
  concealed;
- `eyes.color`, unless eyes are inapplicable;
- `face.shape`, `build.frame` and `build.weight_presentation`; and
- species and subtype when the realized body is not a plain human.

`identity.heritage`, hair texture, build musculature and categorical height may
reinforce the description but do not satisfy a missing required core value. An
unresolved required value enters `missingRequired`; a production lane compiled
with `refuseOnMissingRequired` refuses before provider spend instead of drawing
an unspecified person.

A valid required identity reference satisfies the stable-identity completeness
requirement only for the subject it names. It must survive reference planning,
be eligible for identity-preserving use and carry that subject binding; merely
using a model field that accepts an image is not sufficient. Available canonical
appearance values still reinforce the reference in the compiled prompt, while
missing optional sheet values alone do not refuse the render. Reference-carried
identity does not satisfy current morphology, coverage, concealment, required
reference roles or any other fact the image cannot honestly supply.

### Chest and bust silhouette

Realized-body applicability chooses one ordinary upper-torso size owner. When
the realized body has no `breasts` region, applicable `chest.size` describes
chest build under normal framing and coverage policy. When that region exists,
it makes `chest.size` inapplicable and `breasts.size` owns the silhouette.
`breasts.size` is the single `ordinarySilhouette` exception: its shape may be
stated through clothing on an ordinary route. Other breast attributes remain on
the intimate reveal path and retain their exposure rules, so an ordinary prompt
never gains nipple or other surface detail from this exception.

The adapter is the ONE owner of character appearance wording.
`scripts/image-appearance-prose.test.ts` fails the build if a production module
under `server/images` turns an attribute into words (`formatAttribute`,
`formatAttributeValue`, `attributeRegistry.byId`) or exports a prose builder by
name beyond the reviewed residue — the identity-free `chat_place` shot and the
composer's own instruction builder, neither of which describes a character from
attributes.

## Ordinary visual identity

Image appearance does not depend on the observer-recognition catalog. The
visual-state snapshot preserves every subject declared by the cut even when no
recognition feature describes them, and the character adapter projects a
separate, explicit image-only vocabulary from resolved sheet attributes. Those
facts never enter narrator selection or visual memory.

- The adapter reads resolved current values first, then applicable species or
  registry defaults. It skips nonvisual and `excludeFromPrompts` fields, values
  whose body location is absent, prompt-elided `none` values, concealed hair,
  covered skin detail and detail outside the camera frame.
- Current hairstyle and grooming facts supersede sheet fallbacks. A neutral
  standalone portrait may use the sheet's default expression; other lanes do
  not.
- An ordinary prompt carries only the applicable chest silhouette owner:
  `chest.size` for a body without breasts or `breasts.size` for a body with
  breasts. The latter is the single clothed-silhouette intimate exception;
  every other intimate attribute stays on the consent- and exposure-gated
  reveal path.
- A reference-free portrait requires apparent age, gender, skin tone, visible
  hair color and length, eye color, face shape, frame and weight presentation,
  plus species or subtype for a non-human subject. Missing applicable facts
  refuse before provider spend. A sent subject-bound identity reference
  satisfies stable identity completeness while current mutable sheet facts may
  still guide the edit.

The compiler receives the exact subject refs the caller resolved and refuses
when the digest loses or adds one. Subject integrity is therefore
checked before dialect wording or provider spend.

## Apparent age per lane

Whether a compiled prompt states its subjects' apparent age is the lane's
policy, decided once in the seam (`CHARACTER_LANE_APPARENT_AGE`, keyed by lane
and settable by no caller) and applied by the adapter
(`CharacterWorldSlicesInput.apparentAge`) for every subject of the render:

| Lane                       | Policy  | Why                                                         |
| -------------------------- | ------- | ----------------------------------------------------------- |
| avatar, variant, chat look | `state` | the text anchor is authoritative beside the portrait        |
| scene                      | `omit`  | the cast inherit visible age from their identity references |

- **`state`** is the projection above, floor and all: an adult band becomes the
  required `subject.apparent_age` claim
  ([pipelines/avatars.md](pipelines/avatars.md) §Apparent age).
- **`omit`** withholds every subject's anchor ahead of the band, on both anchor
  paths — the one the adapter synthesizes from the sheet and a projected
  age fact — as the designed suppression `character.apparent_age.omitted`.
  `missingRequired` never names the key, so an omitted age cannot refuse a
  `refuseOnMissingRequired` rung; the cut, the coverage and every other anchor
  compile exactly as they do under `state`. A scene prompt therefore carries no
  age sentence for anyone, on every rung of its chain
  ([pipelines/scene-subjects.md](pipelines/scene-subjects.md) §Identity anchors
  and the setting).

## Hair the headwear conceals

A cut carries the subject's resolved hair-occlusion band beside its coverage
readout (`CharacterPromptSubjectCut.hairOcclusion`;
[../contracts/items/README.md](../contracts/items/README.md) §Hair occlusion
owns the band and its resolution). The seam hands it to the projection with the
other canonical owners (`CharacterSubjectSources.hairOcclusion`), and the
adapter — never a lane, never a route — applies the one image consequence:

- **At `full`, no authored hair fact reaches the digest.** Every selected fact
  that describes the hair is withheld as a designed suppression
  (`character.hair.concealed`): the `hair.*` attributes, the current hairstyle
  presentation, and any other fact at the `hair` body locus. The test is
  structural — the attribute registry's body location, the presentation kind
  id, the locus — never a match on value words. A withheld hair fact is not a
  lost anchor; `missingRequired` never names one.
- **In their place the subject states one required fact**,
  `subject.hair_concealment`: the hair is fully covered by the headwear and
  none of it is visible. It is `required_visual` and filed in the `wardrobe`
  segment kind, beside the garment that causes it and unfittable by kind, so no
  budget squeeze can drop the statement while the authored hair stays withheld
  ([prompt-programs.md](prompt-programs.md) §Concepts). Each dialect words it in
  its own register with the same meaning — the prose families
  "`<Name>`'s hair is fully covered by the headwear; no hair is visible.", the
  tag family "`<Name>` hair fully covered by headwear, no visible hair".
- **At `none` and `partial` nothing changes.** Some hair remains visible, so
  the authored facts stand exactly as visual state selected them, and no
  concealment fact is stated. The two bands stay distinct values even though
  this consumer treats them alike.

## A cast of more than one

Visual state commits one cut per PERSON, and the assembly takes one digest
carrying N subjects, so the seam folds the cuts into one before anything
describes them. The fold's own laws — what it keeps, what it refuses and why
scope is not one of those refusals — are
[scene-subjects.md](pipelines/scene-subjects.md)'s.

**Each identity reference names its own subject.** A reference carries the cast
member it depicts, so an ensemble prompt binds each face to the right person; a
seam that anchored every identity image to one subject would be asserting that
both photographs show the same woman.

## Reference planning and numbering

The seam plans the references itself and compiles the dialect's slots against
the plan, never against the caller's list — planning drops roles the profile
disallows, binds control roles to their own provider fields, and reorders
required references ahead of optional ones, so a program built from the caller's
array names an image the payload sends somewhere else. The planned send list
travels back to the caller for exactly that reason.

On a dialect that numbers its slots, planning that moves a sent reference out of
the position the caller's order gave it **refuses**. It is a tripwire rather than
a bug detector: the prompt is numbered from the plan, the chat scene sends the
planned list itself, and every other lane hands the renderer the list it handed
this seam, which the same planner reduces to the same order — so slot N is the
image received at N by construction. The refusal guards the moment a lane's own
order stops agreeing with its profile's policy, and fires before spend rather
than after a plausible image of the wrong composition is saved. A dialect that
names references by role, or names none, cannot misname a slot it never asserts.

## Identity on a reference-anchored render

An edit lane's stable identity comes from the reference image. Inherent sheet
descriptors are withheld because describing the face back invites the model to
repaint what it should copy; mutable current appearance may still state a real
change such as a haircut or weight change. Saying nothing about identity and
letting it change are opposite instructions, and a dialect emits its identity
lock from a `subject.identity` claim. A subject named by a required identity
reference therefore carries an identity anchor in the digest: a model-neutral
fact stating that this subject is the person in the reference.

The anchor is required, so no budget squeeze can trade a likeness for optional
detail, and it is synthesized only where a required identity reference actually
names the subject — an anchor with no anchor point would be a claim the payload
cannot support. A subject whose projection already states identity keeps its own
facts and gains nothing, so a describe-the-face lane cannot lock twice.

**The lock wording belongs to the dialect, never to the digest.** The digest
states what is true; each endpoint decides how it says so. The Qwen edit
dialects word the lock from `QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK` /
`QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK` (`@vesper/image-core`,
`dialect-qwen-2511.ts`), chosen by reference count — zero references lock
nothing, because there is no image to lock an identity to — and the prose
family emits its provider-neutral sentence. No adapter in
`@vesper/image-models` touches prompt text, so a prompt reaches the provider
exactly as it was compiled and hashed.

**The lock never asks the reference to restore hair the headwear hides.** A
subject at the `full` hair-occlusion band carries a `subject.hair_concealment`
claim ([§Hair the headwear conceals](#hair-the-headwear-conceals)), and the
dialect reads the band from that claim in the set it already renders — no
second channel carries it. When any cast member's claim is present the lock
ships its hair-free spelling (`…_IDENTITY_LOCK_HAIR_CONCEALED` in each family:
the prose sentence without "hair color and style", the Qwen single- and
multi-reference locks without "hair"), and every other cue — face, skin tone,
build or proportions, apparent age — stays as the measured lock states it. The
rule is conservative on purpose: the lock is one sentence for the whole cast,
so one covered person drops the clause for everyone, because a lock that kept
"hair" would tell the model to paint that person's reference hair back over the
hijab, and the uncovered rest of the cast still carry their hair in their
references. At `none` and `partial` the measured lock ships untouched.

**A face the shot cannot show adapts the lock, in a sentence of its own and
never inside the lock string.** The lock says preserve the exact face, and on a
back-turned or profile shot that pulls against the composition: the cheapest way
for a model to prove it preserved a face is to show that face, so the subject
gets rotated back to the lens. A `subject.face_visibility` claim states what the
shot can show, and each dialect words it separately — what to preserve when the
face is not the evidence, and that the turn is not on the table. It is filed in
the `identity` segment kind at a priority strictly below the lock's, so it
**follows the lock within the identity band and never precedes it**, and it is as
unfittable as the lock it corrects: an adaptation a budget squeeze dropped while
the lock survived would leave exactly the failure it exists to end. Nothing
promises the two are adjacent — every subject's identity claim sits at the lock's
own priority, so on an ensemble one of those may fall between them.

**The preservation set is anchored per subject, never per payload.** "Preserve
… exactly from the reference" is said only where an identity reference for
*that* subject is in the send list. A render can carry one person's identity
image and not another's — the scene ladder's single-reference rung is exactly
that shape, and its focal is chosen independently of which reference survived —
and anchoring on the mere presence of references would tell the model to copy
one character's hair, build and skin tone from a photograph of somebody else.
Which shots carry an adaptation at all is the scene lane's
([pipelines/scene-framing.md](pipelines/scene-framing.md) §The camera).

**Covered hair leaves the adaptation's preserve list, per subject.** For a
subject whose own `subject.hair_concealment` claim is in the set, the sentence
drops "hair color and style" (the tag family drops "hair") and keeps every
other word — the visible features, build and skin tone, the anchor, and the
"do not rotate … to face the camera" clause byte for byte. Decided per subject
rather than per cast, because the sentence is per subject: a covered focal
beside a bare-headed bystander adapts only the focal's list. At `none` and
`partial` the measured wording is unchanged.

## Intimate anatomy on a permitting route

A committed cut never carries intimate anatomy: the visual-state image selection keeps its
consent gate shut in every lane. A lane whose route permits it — the chat scene's uncensored
reference-edit rungs — passes `intimateReveal` to the seam, which projects each cut's exposed
intimate anatomy as optional `subject.intimate_anatomy` facts beside the digest
(`contracts/images/subject-reveal.ts`): silhouette through clothing, surface detail when the
region reads bare, untagged anatomy when its region is exposed, sensory never. The facts are
the route's, sourced `images.subject_reveal`, and the assembly appends them to the subject
untouched. A lane that passes nothing compiles the cut alone, which is every lane but the
scene ([pipelines/scene-subjects.md](pipelines/scene-subjects.md) §Subject body reveal).

## Refusals the seam adds

Beyond the layer's own refusals, three belong to this seam. All happen
before provider spend.

| Code                                          | Cause                                                   |
| --------------------------------------------- | ------------------------------------------------------- |
| `image_prompt_program.pack_missing`           | a bound pack version is not registered                  |
| `image_prompt_program.references_renumbered`  | planning moves a slot a numbering dialect names         |
| `visual_state.digest.cast_*`                  | the cast could not be folded into one digest            |

A refusal is never a fall-back to a second prompt system: a binding that resolved
and then failed to compile is a fault on a lane that IS bound, and rendering
something reasonable instead hides it behind an acceptable-looking image.

The seam answers one of three ways, and `unbound` is deliberately a third answer
rather than a refusal:

| Answer     | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `compiled` | a program for this render — the lane sends exactly its prompt and references |
| `refused`  | a configuration or compile fault on a lane that IS bound                     |
| `unbound`  | no `active` binding row for this model, task and profile key                 |

`unbound` is the honest "no row": the binding table is where a lane's words are
authorized, so an endpoint missing from it is one the lane may not speak for,
and `characterPromptUnboundRefusal` names the three coordinates an operator has
to add a row for. It never degrades to a different prompt.

Each lane fails in its own shape and names its own codes on its page. The
reserving lanes — avatar, variant — fail the row before any provider call,
whether the cut would not assemble, the program refused, or the model is
unbound. The chat-look mint leaves no row at all, because it re-fires on every
outfit change and would otherwise accumulate one failed row per change. The
scene lane's chain is several renders of one scene, so a refused or unbound
rung is dropped and the row fails only when no rung survives
([pipelines/scene-images.md](pipelines/scene-images.md)) — a handoff to the next
rung, never a handoff to another prompt. The staged bench settles its row under
the program's own code, or `image_prompt_program.unbound`
([../image-lab/staged-scene.md](../image-lab/staged-scene.md)).
