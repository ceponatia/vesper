# Pipelines

The generation lanes. Every lane resolves its task's profile
([../providers/README.md](../providers/README.md)), renders through the shared pipeline shell
([../README.md](../README.md) §Adding a pipeline), and lands its assets in the one registry
([../asset-registry.md](../asset-registry.md)).

## Reading order

| Doc                                          | What it covers                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| [avatars.md](avatars.md)                     | The canonical avatar: digest-sourced segments, waist-up policy, model switch      |
| [avatar-upload.md](avatar-upload.md)         | The user-supplied portrait: crop dialog, backdrop, synchronous promotion          |
| [portrait-variants.md](portrait-variants.md) | Reference edits of the canonical avatar, promotion, the `nsfw test` anatomy bench |
| [scene-images.md](scene-images.md)           | The chat scene lane: cast, composer, attempt ladder, chat keying, the Gallery     |
| [scene-framing.md](scene-framing.md)         | Player POV, the embodied viewer, the camera, intimate staging                     |
| [scene-subjects.md](scene-subjects.md)       | How every present character's facts are produced: digest, coverage, reveal, state |
| [chat-images.md](chat-images.md)             | Selfies, the look/place reference anchors, and player photo uploads               |
| [entity-images.md](entity-images.md)         | Item and location art, compiled from a world digest rather than written           |

## Render provenance

Every generating lane records the render's attempt provenance under `images.meta.render` —
model, profile, strategy, seed, applied and dropped controls, sent reference roles,
prediction id, executed version — on failures too, where the lane's failure shape allows.

## Visual provenance

The lanes that draw a character from committed visual state — avatars, portrait variants,
chat scenes at any cast size (selfies included), and the chat-look anchor — also record
compact **visual provenance** under `images.meta.visualState`, a sibling of `meta.render`
(app-owned, so the two are never merged): the visual-state scope key, cut id and story
minute, the snapshot/selection/camera fingerprints, each subject's selected facts (key, truth
fingerprint, required flag, target segment kind), and the suppressions.

Identifiers and fingerprints only, never a second copy of source values — enough to answer
which visual moment produced a stored image and whether a retry is "same composition" or
"current state moved" (`visualImageProvenanceOf`, `contracts/images/visual-digest.ts`). It is
written at **reserve time**, before any provider call, so it survives a failed render, and the
client image schema passes it through.

## Failing before spend

A lane whose visual digest cannot be assembled, or whose required fact resolves no clause,
**fails the row before the provider call** rather than degrading to a legacy prose builder.
Each lane's page names its own diagnostic code. The degraded-state rules are
[../../resilience.md](../../resilience.md): a failed or unreadable wardrobe is unknown state,
never a bare body.

## Failure classification

Image-generation failures are classified, not swallowed. `describeImageGenError`
(`server/ai/errors.ts`) recovers a real upstream message from an error body — the case it
exists for is a moderation verdict that arrives *after* the provider committed an HTTP 200
(slow gen → keep-alive padding → the AI SDK's success-schema parse throwing a generic
`APICallError("Invalid JSON response")`). It is provider-agnostic; Replicate's own routes
return plain error strings, which flow through the plain-message branch.

`classifyImageFailure` reuses it to bucket a failure as **transient**, **content_rejection**,
**billing**, or **other**. Every lane that retries or degrades reads those buckets: transient
may retry, a content rejection never retries, and a billing failure never retries at all.
