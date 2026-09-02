# Character prompts

Every character-image render — a library portrait, a portrait variant, a chat
scene, a chat-look anchor — builds the prompt it sends through one seam,
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
  planning and slot numbering, the reference-anchored identity anchor, and the
  refusals the seam adds to the layer's own.
- **Does not own:** the compile itself, dialects, packs and bindings
  ([prompt-programs.md](prompt-programs.md)); how a cast's per-person cuts are
  produced and folded ([pipelines/scene-subjects.md](pipelines/scene-subjects.md));
  what each lane does with the result (the lane pages under
  [pipelines/](pipelines/README.md)).

## The character projection

Character subjects reach the digest through a two-module seam in
`apps/web/src/contracts/images/`, and the split is an ownership boundary, not a
convenience:

| Layer                          | Owns                                              |
| ------------------------------ | ------------------------------------------------- |
| visual state                   | which facts apply, and required vs camera-visible |
| canonical character owners     | the semantic value of each selected fact          |
| `subject-digest.ts` (scaffold) | vocabulary translation; it adds no truth          |
| `character-adapter.ts`         | joining selection to values as complete claims    |

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
  segment closed.
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

An edit lane's digest states no identity descriptors — the reference image
carries the face, and describing it back invites the model to repaint what it
should be copying. But saying nothing about a face and letting it change are
opposite instructions, and a dialect emits its identity lock from a
`subject.identity` claim. So a subject named by a REQUIRED identity reference
carries an identity anchor in the digest: a model-neutral fact stating that this
subject is the person in the reference.

The anchor is required, so no budget squeeze can trade a likeness for optional
detail, and it is synthesized only where a required identity reference actually
names the subject — an anchor with no anchor point would be a claim the payload
cannot support. A subject whose projection already states identity keeps its own
facts and gains nothing, so a describe-the-face lane cannot lock twice.

**The lock wording belongs to the dialect, never to the digest.** The digest
states what is true; each endpoint decides how it says so. The Qwen edit dialects
emit their lock byte-identically to the wording the render kernel's family quirk
writes, and the prose family emits the provider-neutral sentence its endpoints
already receive — so no endpoint is asked something it has not been asked before.
`scripts/qwen-identity-lock-parity.test.ts` fails the build if either copy
drifts.

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

Each lane fails in its own shape. The reserving lanes fail the row before any
provider call. The chat-look mint leaves no row at all, because it re-fires on
every outfit change and would otherwise accumulate one failed row per change. The
scene lane's chain is several renders of one scene, so a refusal drops that rung
and the row fails only when no rung survives
([pipelines/scene-images.md](pipelines/scene-images.md)) — a handoff to the next
rung, never a handoff to another prompt.

