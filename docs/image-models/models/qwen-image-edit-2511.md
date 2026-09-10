# Qwen Image Edit 2511

**Slug:** `qwen/qwen-image-edit-2511`
**Provenance:** probed 2026-08-05 against pinned version `a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729`.

> An enhanced version over Qwen-Image-Edit-2509, featuring multiple improvements
> including notably better consistency.

Vesper's default for chat scene images and portrait variants. It is the current
instruction editor used when the application must preserve a known character,
but “identity-preserving” is a relative capability rating rather than a promise
of exact likeness. The owner has observed faces that remain similar while losing
recognisable facial structure, which is why identity continuity must be judged
from output rather than inferred from a successful edit request.

## Runtime LoRA support

Replicate's published 2511 API currently exposes one custom runtime LoRA through:

- `lora_weights` — string; a Hugging Face repo slug (`owner/model`) or direct
  `.safetensors` URL; blank means no custom LoRA;
- `lora_scale` — number 0–4, default 1.

The same fields are compatible with Vesper's normalized LoRA control vocabulary
(`loraWeights` / `loraScale`). The probe already derives those bindings whenever
it sees them.

The production intimate-scene route, the portrait studio's `nsfw_test` variant
bench, and the bare reference view all run on this endpoint, pairing their
picked profile with the curated NSFW `image_loras` library row through these
same `lora_weights`/`lora_scale` fields rather than swapping onto a different
model ([scene-framing.md](../../images/pipelines/scene-framing.md) §Staging adds
the LoRA, [portrait-variants.md](../../images/pipelines/portrait-variants.md)
§The `nsfw test` anatomy bench).

The long-lived built-in 2511 registry row was originally probed before LoRA
binding derivation shipped, so its stored `advancedCapabilities` could remain
stale even though the provider version exposes the inputs. Migration 0118
backfilled the two verified bindings and their known-input names without changing
the selected provider version or any other capability fact, and
`0119_qwen-capability-backfill.sql` then replaced that partial snapshot with the
whole probed record — the same LoRA bindings plus the seed, the accelerated
sampling path, and one descriptor per declared input. That is what makes the
capability-driven Image Generator offer its LoRA picker when 2511 is selected;
there is no 2511-only form exception.

The Qwen model adapter likewise composes the semantic `lora` feature. The two
layers have different jobs: the adapter says that this endpoint family can load
a custom LoRA; the registry's probed bindings remain authoritative for the exact
provider fields a concrete version can send.

This does **not** imply that every historical 2511 prediction carried a LoRA.
A render uses a custom LoRA only when Vesper resolves a curated library row and
the final provider payload contains both `lora_weights` and `lora_scale`.

## The edit-only built-in

This is a seeded edit-only model. Its reference input is required, so it cannot
generate a portrait from a prompt alone and is never offered for a normal
new-portrait task.

## Capabilities

- **Generate without a reference:** no.
- **Edit from a reference:** yes — this is its purpose.
- **Reference field:** `image`, an array of URIs despite the singular name. The
  sibling [Qwen Image 2512](qwen-image-2512.md) uses the same key for a single
  URI.
- **Reference workflow:** 1–3 reference images. Vesper stores a cap of 3.
- **Aspect handling:** `aspect_ratio` enum includes `3:4`.
- **Runtime custom LoRA:** yes, one custom LoRA through
  `lora_weights`/`lora_scale` when the active capability record carries the
  verified bindings.
- **Accelerated sampling:** yes — `go_fast`, provider default `true`, reachable
  as the normalized `fastMode` control. Production refuses it; see the quality
  policy below.
- **Output:** array of URIs; WebP available.

## Reviewed capability

Reviewed by hand and never overwritten by a schema probe:

- **Edit kind:** `instruction_edit`;
- **Identity preservation:** `strong` relative to generic img2img/repaint models;
- **Operator warning:** none.

The `strong` rating keeps Qwen eligible for identity-critical tasks. It does not
mean every output is the exact same face. The rating is an eligibility rail;
trial results and future post-render identity checks are a separate concern.

## Quality policy at the render seam

The provider defaults `go_fast` to `true`. The reviewed policy
(`packages/image-core/src/models/reviewed-profile-controls.ts`) pins it off,
carried both by this model's task profiles (as a provider override) and by the
transitional overlay at the shared render seam:

```json
{
  "go_fast": false
}
```

All current production Qwen Edit jobs are identity-critical. Quality therefore
wins over the provider's speed preset. This model carries no curated fast/quality
profile variants; a non-identity task on it would need profile-level settings in
place of this global override before fast and quality work could diverge.

**The admin [Image Generator](../../image-generator/README.md) is the one
surface allowed to say otherwise.** The probed row binds `go_fast` as the
normalized `fastMode` control, so a bench run can ask this model for the
accelerated path — which is what a bench is for, since a control that only ever
agreed with production could not investigate the ruling it runs under.
Production is unaffected: the reviewed policy keeps `go_fast` as a
`providerOverrides` entry and overrides merge last, so no player-facing render
can pick up a bench setting.

The effective value differs from the raw `image_models.extra_input` row.
Diagnostics and provenance report the final payload, not infer it from the row.

## Numbered-reference instruction policy

Qwen's guidance for this family asks a caller to identify which image supplies
which subject or element, to say what changes and what stays fixed, and to write
connected sentences rather than a list. Vesper words all of that in the Qwen 2511
delta-edit dialect (`dialect-qwen-2511.ts`, `@vesper/image-core`) under the
dialect id `qwen_2511_delta_edit`, which carries this endpoint's own bindings and
packs. The dialect is the only source of the wording — no adapter in
`@vesper/image-models` touches prompt text, so a prompt reaches this endpoint
exactly as it was compiled and hashed.

**The reference is authoritative for face, skin tone and apparent age; the text
is authoritative for hair, build, wardrobe and pose.** That split is what the
binding sentence states, and it is why the prompt may describe a haircut or an
outfit the photograph does not show without contradicting itself.

**One sentence binds the subject to its image and states the preserve set.** The
lock, the identity slot's own `Image N` assignment and the subject's name are one
statement, not three: a display name repeated beside a numbered photograph is a
second identity cue competing with the picture the endpoint was given, and a
blanket "change only what this instruction requests" is a preserve clause with no
change to bound. With one identity reference:

```text
Use the woman in Image 1 as the sole subject; keep her face, skin tone and
apparent age exactly as shown.
```

With several:

```text
Use the numbered images as assigned: Image 1 shows a woman, Image 2 shows a man;
keep each person's face, skin tone and apparent age exactly as their own image
shows.
```

The exported `QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK` and
`QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK` are the **preserve clauses** of those
sentences rather than whole sentences: the rest names the subject, the image
number and a possessive, none of which is constant. Neither clause contains the
other, so a reader can assert which binding a render chose. The
`…_HAIR_CONCEALED` names are byte-identical deprecated aliases — hair is in
neither preserve set, so a covered head needs no separate spelling.

A payload carrying no reference compiles no binding sentence, which drops a
mandatory claim and refuses before spend: this endpoint's whole identity
transport IS the reference, and describing a face in prose would render a
stranger. Identity slots are named inside the binding; every other role keeps its
own numbered assignment sentence, compiled from the program's own reference plan
so a slot names the image the payload carries at that position
([character-prompts.md](../../images/character-prompts.md) §Reference planning
and numbering). A structural control role — mask, pose, depth, edge, control —
words nothing at all, because the probed schema has no structural input and a
sentence claiming one would assert a transport this endpoint does not have.

The apparent-age requirement remains text-authoritative. This preserves the owner
ruling that age text must correct an age-ambiguous reference rather than inherit
drift from it.

### How this dialect names a person

Three ways, in order: the display **label** the application supplied; the
**reference binding** — "the woman in Image 1" — when it supplied none, which is
the ordinary scene case ([character-prompts.md](../../images/character-prompts.md)
§Naming a subject per lane); or "the subject" when there is neither. Inside the
multi binding a subject is named INDEFINITELY ("Image 1 shows a woman") and
everywhere else definitely, because "Image 1 shows the woman in Image 1" defines
the image by itself.

After that introduction the dialect refers back with the subject's **pronoun
set**, which the world digest carries and this dialect never guesses. It is
withheld in three cases, each a pronoun that would not resolve: the digest stated
no set; two subjects in this cast share one; or no sentence in this prompt
introduces the subject, which is a cast member the payload carries no identity
image for. A withheld pronoun leaves the introduction standing in every clause.
`they_them` takes plural verb agreement for a single person.

### Grouped emission

The dialect renders **one segment per claim**, so fitting and provenance work over
exactly the units they always did, and then emits the survivors as grouped prose
in a fixed band order: binding, change, build, wardrobe, exposure, pose, capture,
setting, mood, style, close. Each emitted sentence becomes one segment carrying
the claim ids it absorbed, so the joined segments are still exactly the compiled
text and `source` still names the semantic units behind every sentence a provider
receives.

What the bands merge:

- **build** states the age anchor, then one sentence for the body, then one for
  the hair; **wardrobe** puts every garment in one sentence in the order the
  projection stated them; **pose** puts posture, pose, activity and expression in
  one.
- A value the character projection wrote as a `with …` fragment ("with the
  sweater tucked in", "with the hair worn loose") **trails** the sentence it
  qualifies — the garment list, or the hair sentence — and earns a sentence of
  its own only when that host was suppressed or trimmed.
- A posture another phrase in the same sentence already **contains** is dropped,
  so a committed "standing" beside a composed "standing at the craft services
  table" is not composed twice. Containment can only ever drop the shorter of two
  phrases, and two equal phrases are each other's equal rather than each other's
  container.
- A further subject's identity claim is **absorbed** by the multi binding, which
  has already introduced each person by their own image.
- A stated gender is absorbed when a usable pronoun already carries it, and kept
  whenever none does.

An absorbed claim is attributed to the sentence that carries it, never recorded
as dropped: a clause folded into another claim's sentence is not a claim the
render lost.

### The sentences this endpoint owns

- **Capture.** A first-person shot with no viewer body in frame reads "Seen from
  the camera's own eye-level point of view." It names the camera and nothing
  else: a POV sentence naming a viewer puts a person in the room and then forbids
  drawing them. The embodied and selfie forms keep the family's measured wording.
- **Close.** The person count is the LAST sentence, which is where a "nobody
  else" assertion can do its job: "She is the only person in the picture; the
  foreground is clear.", or "Exactly N people are in the picture and nobody else;
  the foreground is clear." An embodied shot takes the `fully in frame` forms
  instead, because the count is the cast and a limb the frame edge cuts is not
  one of them.
- **Possession.** "Every visible body part is hers." Deliberately abstract: a
  limb noun summons a limb even when it is possessively bound. A usable pronoun
  gives the independent possessive, several owners take "belongs to A or B", and
  an owner this prompt cannot name yields no sentence at all.
- **Face visibility.** A shot that cannot show the face states, immediately after
  the binding, what to preserve instead and that the subject is not to be rotated
  to the camera. Its "from Image N" anchor is per subject, never per payload.
- **Hair concealment.** "Her hair is fully covered by the headwear; no hair is
  visible." — the claim that keeps hair off a render whose reference shows it.

### The prompt budget

The row's prompt binding declares `recommendedChars: 1300`, roughly the 200 words
this family's published prompt guidance asks for. It is **advisory**: optional
material is trimmed toward it, a mandatory segment is never compressed for it,
and exceeding it is reported rather than refused. Vesper has measured no hard
ceiling for this endpoint, so the row carries no `maxChars`. The value is
owner-curated data on `advancedCapabilities`
([providers/registry.md](../../images/providers/registry.md) §Probe-owned
columns).

## Seeded profiles

Three profiles exist, all `operation: edit` with the `instruction_edit` prompt
strategy, and each is its task's global default
([providers.md](../../images/providers/README.md)):

- `variant-standard` — task `variant`; identity required, style optional;
- `scene-standard` — task `scene`; identity → location → style → object. Its
  profile policy itself does not require an identity role because a scene may
  contain no portrait-bearing character. **That does not create a bare-prompt
  2511 fallback.** The attempt planner adds `generate` only when the selected
  model has `canGenerate`; 2511 does not. With no usable reference, its attempt
  chain is empty and the scene route refuses rather than inventing a stranger;
- `chat-look-standard` — task `chat_look`; identity required, style optional.

All three carry empty control defaults. This model has no curated profiles
beyond them; the `go_fast` override stays at the quality seam above.

## Identity references

A waist-up portrait may contain too few face pixels for exact identity, so the
identity reference(s) an edit render sends come from the identity-pack service —
[identity-packs.md](../../images/identity-packs.md) owns crop derivation, quality
gates, and provenance. A face crop that cannot clear the quality gate is never
sent merely to fill a reference slot.

Reference selection and ordering are the resolved profile's policy
([providers.md](../../images/providers/README.md)). For portrait-bearing characters the
identity-pack lane fails closed before spend when the required identity source is
blocked; it does not silently read an arbitrary gallery image. In chat scenes a
current generated `chat_look` may be the cast member's anchor; otherwise the
canonical identity-pack references are used.

## Inputs

- `prompt` — string, required. It is an edit instruction, not merely a scene
  description.
- `image` — array of URI strings, required. JPEG, PNG, GIF, or WebP references.
- `aspect_ratio` — enum, provider default `"match_input_image"`. Values:
  `match_input_image`, `1:1`, `16:9`, `9:16`, `4:3`, `3:4`.
- `lora_weights` — string, default blank. Hugging Face repo slug or direct
  `.safetensors` URL.
- `lora_scale` — number, default 1, range 0–4.
- `go_fast` — boolean, provider default `true`; Vesper's current reviewed value
  is `false`.
- `output_format` — enum, provider default `"webp"`. Values: `webp`, `jpg`,
  `png`.
- `output_quality` — integer, default `95`, range 0–100.
- `seed` — integer.
- `disable_safety_checker` — boolean, default `false`.

There is no `strength` or `prompt_strength` control. Edit intensity and unchanged
content are governed by the instruction and references.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result.

## Effective Vesper payload

Ordinary production edit, on the current reviewed policy:

```json
{
  "prompt": "<compact numbered edit instruction>",
  "image": ["<url 1>", "<url 2>"],
  "aspect_ratio": "3:4",
  "output_format": "webp",
  "output_quality": 95,
  "go_fast": false,
  "disable_safety_checker": true
}
```

When the render resolves a compatible curated library LoRA, the final payload
additionally contains the provider bindings:

```json
{
  "lora_weights": "owner/hugging-face-repo-or-direct-safetensors-url",
  "lora_scale": 1.0
}
```

The compile-step LoRA invariant refuses pre-spend if the recorded library LoRA
and those final provider fields disagree. `aspect_ratio` is sent explicitly
rather than left at `match_input_image`, so a non-conforming reference cannot
dictate the output shape.

## Known limitations

- exact face likeness is not reliable enough to treat a successful reference
  edit as proof of identity continuity;
- a generated chat-look anchor can become the next scene's reference, so output
  identity drift can compound unless a post-render continuity gate rejects a bad
  intermediate;
- several references compete for a cap of three; the single-edit degradation
  rung sends only one reference, so additional characters can become prompt-only
  on that rung;
- one custom LoRA per prediction through the currently verified 2511 schema;
- no negative prompt or numeric edit-strength control exists;
- a second full-frame repair pass may change pose, body, clothing, or setting;
- multi-character face repair is not offered on this model: neither target
  localization nor role-aware reference capacity is proven on it;
- provider capability drift is real: diagnose the active Vesper pin and stored
  probe before assuming a future Replicate schema is unchanged.
