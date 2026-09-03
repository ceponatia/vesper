# Chat image lanes

The three chat-scoped asset kinds beside the scene itself: the character's selfies, the cached
look and place reference anchors, and the player's uploaded photos. This page owns their
**render mechanics**; the lane's triggers, gates, cooldowns and lifecycle are
[../../character-chat/images.md](../../character-chat/images.md).

## Selfies

`meta.flavor: "selfie"` on kind `scene`: the chat scene pipeline
([scene-images.md](scene-images.md)) with the shot's **capture mode** set to `selfie` — the
subject's own phone camera, arm's length or a mirror, aware of the lens. It is a member of the
closed capture-mode choice rather than a flag on the first-person rule, because a selfie is as
far from POV as it is from an observing camera: the subject's own arm is holding the lens. The
route decides it before the plan is composed and the plan carries it, so the composer never
sees it and a confused answer cannot un-selfie a render the player asked for
([scene-framing.md](scene-framing.md) §Whose eyes the shot is through). A selfie's cast is
trimmed to the sender, so the shot's person-count assertion says one.

Selfies are **always the identity-locked reference route** (owner ruling): the per-chat
`scene_model` text-to-image pick is ignored. The staged arrangement and the possession clause
both drop out with the mode — a selfie has the subject's own arm on the lens, so neither a
two-body geometry nor a viewer-limb binding is true of it
([scene-framing.md](scene-framing.md) §Intimate staging).

A **retry-once failure policy** replaces the ladder's silent degrade: classify the first failure
(`classifyImageFailure`), retry once — a content rejection with a sanitized plan, exposure and
intimate phrasing stripped, including `staging`; a transient failure as-is — drop the failed
first row, and let a second failure stand as a debuggable `failed` row. Diagnostic:
`images.selfie.retry` (info).

## The look anchor

`kind: "chat_look"` is an identity-locked reference edit wearing the archivist-tracked outfit,
its identity reference(s) sourced from the identity-pack service
([../identity-packs.md](../identity-packs.md)).

Its prompt is the **compiled prompt program over the conversation's committed cut**
(`buildChatLookCut` → the mint's program, `server/images/chat-look.ts`), the mint's only prompt
path ([../character-prompts.md](../character-prompts.md)). The cut is this character's committed
chat cut as the shared factory hands it over (`chatVisualStateShadowInput`), realized under the
look's fixed studio viewpoint `CHAT_LOOK_CAMERA` — facing the viewer at medium distance, the
`waist_up` band, camera id `chat_look_studio` — rather than a committed scene camera, because
a look keyed to whatever the fiction's camera was doing would invalidate on every shot change.
The read is `committed_cut` on the cut's own id: the cut id IS the staleness check.

The program compiles as lane `chat_look`, task `chat_look`, with every reference bound to the
subject (each is the subject's own identity pack) and `refuseOnMissingRequired: true`. The
outfit reaches the prompt as the operation's **change contract** on `subject.wardrobe`
(`characterChatLookImageOperation`): the tracked outfit text, or `nothing` for an undressed
character, or a simple casual outfit when the conversation settled on nothing in particular —
an empty outfit is a real instruction, not a missing one. No intimate reveal is passed, and the
digest's consent gate stays shut.

Like its sibling edit lane ([portrait-variants.md](portrait-variants.md)) the mint states no
identity descriptors: it gains the digest's body-shape anchors — horns, wings, tail — and the
seam's identity anchor, while hair, eye and skin color come off the reference photograph.

**For a fixed look key the compiled prompt is a function of the key's inputs alone.** The
committed cut carries more than `chatLookKey` hashes — the current layer (body-surface wetness,
garment condition and arrangement, active conditions) and body language — and a program that
stated them would send two prompts under one key: the cached anchor goes stale for a fact that
never moved the key, or a transient state (wet hair, a slouch) is baked into the reference every
later scene composes from. The omission is a **pack suppression, not a lane-side filter**: the
chat-look binding (`binding-qwen-2511-chat-look-v1`) compiles through its own positive pack,
`pack-qwen-2511-positive-chat-look-v1`, which is the endpoint's shared pack with
`subject.current_state` and `subject.body_language` suppressed and nothing else changed, so the
row's `promptProgram.positivePackVersionId` names what the anchor was compiled without. The
mint passes the whole cut and filters nothing itself. Presentation-layer facts — hairstyle,
makeup, grooming, nails, cosmetic marks — project as `subject.current_state` too and leave with
it; the key does not hash them either, and the scene lane states the current cut over the anchor
at render time. What the anchor states is the identity, age and morphology anchors, the
wardrobe band with its hair-concealment fact, and the coverage statement — the outfit-true,
identity-locked reference the scene lane wants from it. Neither suppressed concept is ever
mandatory, so the suppression never refuses a mint.

Every refusal happens **before reserving a row**, so an ineligible chat accumulates no failed
rows and simply retries on the next outfit or appearance change. A caller with no committed
cut to give — a missing `chat_participants` row — refuses with
`images.chat_look.visual_cut_missing`: there is no second prompt system to phrase an anchor
from, and a plausible face minted from a string would be one every later scene composes from.
A cut that will not assemble refuses with `images.chat_look.visual_digest_unavailable`; a
refused program mints nothing; a chat-look profile whose model has no active binding refuses
with `images.chat_look.program_unbound`, naming the row to add. What a successful mint sends is
`characterPromptTransport(compiled)`: the compiled prompt plus the compiled exclusions on the
normalized `controls.negativePrompt`.

`chatLookKey` is the sorted worn item ids + the outfit overlay + the coverage fingerprint +
appearance overlays + the garment fingerprint (worn instances, presentation bands, wetness,
deposit and damage presence — appended only when the actor is modelled) + the resolved
hair-occlusion band (a `partial` or `full` band adds a term; `none` keys exactly as a chat with
no band), keep-latest
**per character** — the
loader, the freshness check and the purge all scope on `entityId`, because a chat-wide read
hands one roster member's look to another and a chat-wide purge makes two cast members evict
each other's anchor on every mint. Scenes and selfies anchor on a fresh look instead of the
always-dressed avatar, so render prompts stop fighting the reference's clothes.

## The place anchor

`kind: "chat_place"` is a text-to-image establishing shot of the current scene-memory place,
minted lazily from its sketch (`chat_place_image`, CAS onto `ScenePlace.imageId`). Once present,
chat scenes render **multi-reference** (look or avatar, plus place) through the same
multi-reference rung the scene ladder already carries.

Both anchor kinds are chat-keyed, Gallery-hidden, and hard-deleted with the conversation
(`deleteChatAssets`).

## Player photo attachments

`kind: "chat_upload"`: player photos uploaded via `POST /api/chats/:chatId/attachments`
(`uploadChatAttachment` — the same decode-bomb guards as the avatar upload, fit inside 1280px,
row-before-file, chat-keyed).

They are **input-only**: never an identity anchor or edit reference, and never in the Gallery.
Unlike scenes they are **hard-deleted** with their message or conversation (`deleteChatUploads`;
`deleteChat` removes them before the FK would SET-NULL them into limbo).

At exchange time ONE batched vision call (`engine/chat-vision.ts`, `visionModelId()`) describes
every photo on the message; the reads persist on the message meta, so regenerate never
re-spends, and reach the narrator as a fenced seen-channel tail block.
