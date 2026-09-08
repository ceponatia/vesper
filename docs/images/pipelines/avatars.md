# Avatar generation

The canonical portrait, text → image. Its prompt is the **compiled prompt program** over the
character's standalone visual cut (`buildAvatarCut` → `buildAvatarProgram`,
`server/images/avatar.ts`), the lane's only prompt path
([../character-prompts.md](../character-prompts.md)). Nothing in this lane phrases a character
from prose: the cut states what is true, the seam compiles it, and the bound endpoint's dialect
words it.

## The cut

`buildAvatarCut` is the standalone assembly (`standalone-subject-visual.ts`, shared with portrait
variants) under the portrait studio's fixed camera, `AVATAR_PORTRAIT_CAMERA` — facing the viewer
at medium distance, which reads as the `waist_up` framing band — fingerprinted under the camera
id `portrait_studio`:

- one snapshot of the character sheet (scope `standalone_character` — resolved attributes plus
  the realized body, projecting species feature groups and cataloged distinctive marks);
- a **read token** minted from the character row's `authoringRevision` plus every wardrobe row read
  for the render (`standaloneCharacterReadToken` — an edit to either mints a different token;
  it stands in for a committed cut as the snapshot's cut id and the provenance's
  committed-cut name);
- **one coverage-aware selection pass** bound to that camera, with the digest's consent gate
  shut (`intimateAllowed: false`); and
- a digest realized from that exact selection, never a re-select.

A `StandaloneSubjectCut` is the realized digest, its `meta.visualState` provenance, the
resolved attributes, the realized body and the canonical coverage readout — the vocabulary the
seam compiles a subject from. The provenance merges into the row's meta at reserve time,
beside `style`/`model`, so it survives a failed render. A cut that throws **fails the row
before provider spend** with `images.avatar.visual_cut_failed`; the lane never assembles a
different one.

## The program

`buildAvatarProgram` compiles through the character seam as lane `avatar`, task `portrait`,
on the picked profile: a cast of one, **no references** (every portrait profile's reference
policy allows no roles, so identity travels entirely in the digest's own descriptors), the
operation `characterPortraitImageOperation()`, and `refuseOnMissingRequired: true` — a portrait
of a specific character with a lost identity or morphology anchor is a picture of somebody
else.

Binding resolution is strict on the profile **key**: Qwen Image 2512 carries three portrait
rows (`portrait-standard`, `portrait-fast`, `portrait-quality`) whose packs stay separately
promotable, and SD 3.5 Large carries two, so a key with no row resolves `unbound` rather than
borrowing a sibling profile's pack pins.

What reaches the provider is `characterPromptTransport(compiled)`: the compiled positive text,
which is also the row's stored `prompt`, plus the compiled exclusions on the normalized
`controls.negativePrompt` when the program compiled any. Prompt length is the binding's own
prompt budget (`imagePromptBudgetFromBinding`, `@vesper/image-core`), applied inside the
compile; the fitter protects the mandatory floor.

The seam's three answers, none of which is a second prompt:

| Answer     | What the lane does                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `compiled` | sends exactly the compiled prompt                                                                                    |
| `refused`  | fails the row before provider spend with the program's own refusal                                                   |
| `unbound`  | fails the row before spend — `images.avatar.program_unbound` (warn) — naming the model, task and profile key to bind |

Demo mode compiles nothing and draws the monogram; the row's `prompt` then carries the
monogram's own label, so it describes the picture that was drawn. A failed row carries no
prompt at all.

## What the program states

The digest carries the species feature-group **morphology** — the anchors an image model
"corrects" away, the "human wearing fake wings" failure — the cataloged recognition marks, and
the appearance facts the visual-state selection carries for this camera: the mandatory
identity lane plus camera-visible optional detail. The character adapter
(`contracts/images/character-adapter.ts`) values every fact from its canonical owner — the
attribute registry, the located-fact rows, the anatomy rows — and never from a fingerprint.
Non-visual attributes (`kind: "sensory"` — voice, scent, taste) and `excludeFromPrompts`
fields never reach an image prompt.

The **waist-up frame** is the camera's, not a lane-side filter: the `waist_up` band decides
which optional facts the selection keeps and which regions the adapter's exposure claims may
name, with signature feature morphology kept whatever its root (a pelvis-rooted tail sweeps up
into frame). The lane maintains no omit list of its own.

The operation states the honest default style — a photographic medium and no descriptors. The
studio's `realistic`/`stylized` toggle is recorded on the row's meta and does **not** become a
style claim: it would state the medium twice, in a channel the collision linter cannot
reconcile with the pack's rendering intent.

## Apparent age

Apparent age is the adapter's own **required** `subject.apparent_age` claim, made from the
`identity.apparent_age` attribute through the image age vocabulary (`imageAgeBandPhrases`)
on every lane whose policy states it — the avatar, the variant and the chat look; a scene
omits it ([../character-prompts.md](../character-prompts.md) §Apparent age per lane). The
**image age floor** and the narrative/visual
age split are owned by [../../contracts/attributes.md](../../contracts/attributes.md)
§Starter vocabulary: an adult band states explicit adult wording; a minor band the registry
recognizes states **nothing** — a designed suppression, never a missing anchor; an absent or
unrecognized value fails the mandatory age segment closed, so an identity-critical lane refuses
before provider spend.

The claim is deliberately **text-authoritative** on the edit lanes. Qwen edits re-synthesize
skin with a texture-amplifying prior, and "preserve apparent age" preserves the model's own
**over-estimate** of an age-ambiguous reference (sunglasses hide the eyes; tan + toned reads
older), compounding a step older per edit generation with nothing ever pulling it back —
unlike the identity anchor, where the reference wins. Where the age claim lands relative to
the identity lock is the dialect's own emission order.

## Species, style, and what never reaches an image prompt

A non-human character's species reaches the prompt as its feature-group morphology. The
authored generic `appearance` description is deliberately **omitted** — the feature attributes
already carry the morphology, and that text goes to the character forge instead. The **bio is
omitted** (no visual signal).

The image prompt also **omits the registry `promptHints`**: those are narrator/inference
guidance ("state apparent age as an impression…"), and an image model reads a hint's concrete
example ("late thirties") as literal subject detail, anchoring every face to it. `promptHints`
feed the narrator only (`engine/scene.ts`).

## The wardrobe

The lane loads the character's **raw default wardrobe** (`loadDefaultWardrobeWithRevisions`,
coverage included — the same load whose row revisions feed the read token) and hands it to
the cut as worn inputs (`toWornInputs`, `avatar-wardrobe.ts`). That one list is the source of
BOTH halves of what the camera may see: the canonical region exposure the adapter states as
authoritative `subject.exposure` claims, computed once over the **full** wardrobe, and the
camera's per-location perception (`portraitPerception`), which gates optional facts at
covered locations — a chest tattoo under the saved outfit goes unstated rather than asserted
onto a body nobody could see. Covered regions are silent; silence is the covered statement.

The standalone snapshot has no wardrobe owner, so the portrait program states **coverage, not
garments**: a portrait prompt names no garment. (A chat-backed cut is different — its wardrobe
owner projects worn garments as `subject.wardrobe` facts;
[scene-subjects.md](scene-subjects.md).)

**A failed or unreadable wardrobe is unknown state, never a bare body**
([../../resilience.md](../../resilience.md)). A thrown load (`wardrobeUnavailable`, warn
`images.avatar.outfit_load_failed`) or a loaded row whose `coverage` column would not parse
(`coverageUnreliable`, warn `images.avatar.coverage_unreadable`) degrades BOTH halves of the
read from one flag: the exposure readout falls to fully covered (the prompt stays silent about
exposure), and the camera's perception reads a fully-covering stand-in wardrobe so optional
facts at covered locations go unstated. Identity and morphology stay resolvable because the
mandatory selection lane never consults perception. A genuinely empty wardrobe — a successful
load with zero rows — still states its bare regions.

## Model switch

The portrait studio offers **two** pickers, both reading the registry
([../providers/README.md](../providers/README.md)) rather than a code-side key union: the
canonical-avatar picker lists models with `canGenerate` and the New Variant picker lists models
with `canEdit`, so an edit-only model such as `qwen/qwen-image-edit-2511` can never be asked to
invent a portrait from nothing. Defaults are `qwen/qwen-image-2512` for a new portrait and
`qwen/qwen-image-edit-2511` for variants and scenes (owner ruling 2026-08-05).

Both pickers send a model **id**. An id that no longer exists — a deleted row, or a legacy
pre-registry key — degrades to that task's default profile at render rather than failing
(`resolveImageProfileForTask`). `images.meta.model` records the winning `replicate/<slug>`.
"Uncensored" is the safety checker disabled, the codebase default, and is only ever sent to
models whose schema declares that input; a missing `REPLICATE_API_TOKEN` fails the row with
that message. Aspect is 3:4 for every portrait — negotiated per model, cropped when the model
has no exact 3:4 ([../providers/README.md](../providers/README.md)). Every image lane is
Replicate; OpenRouter stays for text only.

## Intimate-anatomy gating

The portrait studio is **intimate-free by rule**, at two owners: the cut's selection runs with
the consent gate shut (`intimateAllowed: false`), so no intimate anatomy enters the digest
whatever the default outfit exposes, and the program passes no `intimateReveal`, so the route
projects none beside it. The `avatar.test.ts` field-policy pin holds both — the defect is a
one-line one, and the picture it produces is a nude portrait of a character whose sheet merely
lists their anatomy.

Intimate anatomy is **scene-render-only** ([scene-subjects.md](scene-subjects.md) §Subject body
reveal). Non-intimate **`chest.hair`** stays exposure-gated in the avatar — selected only when
the torso reads bare or sheer, never under clothing.

## The job and the studio

A finished avatar becomes the character's portrait **candidate** and nothing more: it is what the
studio, the library card and the chat strip show, and it derives no identity reference. The
character's identity source moves only when its owner accepts the portrait, which is what prepares
the identity pack
([../identity-packs.md](../identity-packs.md) §The source is the ACCEPTED portrait).

The editor saves before queueing and sends the acknowledged `authoringRevision`. The route reserves
that exact revision and an immutable character snapshot in a short transaction before budget
admission, records both on the `avatar` job, and releases the row lock before provider work. A
changed revision returns a recoverable conflict without spending a render.

The avatar runs as an `avatar` job. The pending image row is reserved **inside** the job (after
the queue route's 202), so `GET /api/characters/:id/portraits` returns the rows plus a
**`rendering`** flag — a live `avatar`/`portrait_variant` job for the character, via the
staleness-bounded jobs check (`hasLiveCharacterJob`). The studio polls while either a pending
row or the flag says work is in flight, showing a painting tile through the stretch before the
pending row exists, the same shape as the conversation page's scene polling.

Failed non-canonical avatar attempts stay in the Portrait history grid with
`images.meta.error` visible. The studio also shows the **canonical avatar's prompt** in a
read-only box between the generation controls and the variant form, sourced from
`images.prompt` and updated when a variant is promoted — null when there is no avatar or it is
an uploaded image (`meta.source: "upload"`, which carries no generation prompt).
