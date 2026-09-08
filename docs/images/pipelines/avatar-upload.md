# Avatar upload

Instead of generating, the user can upload their own picture in the portrait studio. No model
runs, so this lane works in demo mode and offline.

## The crop dialog

`components/characters/avatar-upload-dialog.tsx` owns the shared crop surface used by avatar and
reference-view uploads. It loads the file client-side and **always** offers the 3:4 pan/zoom crop
window (pure geometry in `@vesper/image-core`) — including for an
already-3:4 file, because reframing is wanted even at the right ratio (owner request
2026-07-29: zoom a knees-up render to waist-up). At zoom 1 a 3:4 image exactly fills the frame,
so "Use image" untouched is the pass-through.

Zoom runs **below cover too** (`MIN_ZOOM`): shrinking past cover letterboxes the image inside
the frame so parts a 3:4 cover-crop would cut — a wide shot's sides — stay in the portrait. A
**flat backdrop color** (picker in the dialog, neutral-grey default, previewed live as the
frame's background) fills the uncovered area, and is mandatory at render because JPEG has no
alpha. A canvas fills the backdrop then draws the whole image at its display transform
(`canvasRect` — overflow clips when zoomed in, margins show when zoomed out) to a JPEG data
URL.

## The upload route

`POST /api/characters/:id/avatar/upload` decodes the data URL, re-fits to the canonical
`AVATAR_WIDTH × AVATAR_HEIGHT` (768×1024) with sharp `cover` + EXIF `rotate()` — defense in
depth, since the client already cropped — saves through the normal row-before-file path
(`kind: "avatar"`, `meta.source: "upload"`), and **promotes it to the avatar** in one
synchronous request.

It promotes through `promoteVariant`, so — like every other portrait writer — it sets the
**candidate** only and derives nothing. An uploaded portrait becomes the character's identity
source when its owner accepts it, which is what prepares the identity pack
([../identity-packs.md](../identity-packs.md) §The source is the ACCEPTED portrait).

The new id returns in the response, so the studio refetches immediately rather than polling.
An uploaded avatar carries no generation prompt, which is why the studio's prompt box reads
null for one ([avatars.md](avatars.md) §The job and the studio).
