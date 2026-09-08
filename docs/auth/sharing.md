# Copy-on-use and publishing

**Using** a public entity *copies* it — there are **no live cross-owner references**.
`cloneToLibrary` (`server/api/clone.ts`) deep-copies a viewable source into a new owned, private
row. The source author cannot push changes or break your copy: deleting the source leaves the clone
intact (verified in `library-routes.int.test.ts`).

## Images are duplicated, not shared

`cloneEntityImages` copies each ready image file into the new owner's storage with a fresh row
(`sourceImageId` provenance), so a clone is fully self-contained.

`images/:id/file` serves owner-only by default but widens to a **public-entity** image on the
preview path (`isPublicEntityImage`) — and only when the image and the public entity it names
**share an owner**, since the entity linkage is polymorphic metadata with no FK. Cache policy
follows that split: `public` for public-entity images, `private` for owner-only.

## What a copy carries

A clone copies the **stored row, not the public preview**. For a character that means the whole
authored `profile`: narrator guidance, drives, intimacy notes, and voice anchors included — every
field `toPublicCharacterProfile` narrows away for a browsing non-owner
([visibility.md](visibility.md)).

**Images come too**: `cloneToLibrary` runs `cloneEntityImages` for character, location and item
(social cards carry none), re-storing each file under the copier's account.

And a clone is an **independent row** — making the source private again stops *new* copies but
**cannot recall copies already made**. That asymmetry is deliberate: a published character is
offered as a full authored starting point, not a screenshot (owner ruling 2026-07-31, re-affirmed
rather than narrowing the clone).

## Disclosure at the publish control

The consent lives at the publishing action, owned by `PublishToggle`
(`components/library/publish-toggle.tsx`), with the copy and the flow rule extracted to the pure
`publish-disclosure.ts` beside it so `publish-disclosure.test.ts` pins the wording:

- **Character publishing** (`publishConfirmRequired`, private → public) opens a confirmation.
  It states all three facts: a copy takes the full profile including the private fields, its
  images are duplicated too, and unpublishing later does not recall copies people already made.
  Cancel leaves it private. This disclosure appears when choosing Publish, keeping the private
  editor focused on authoring.
- **Other kinds** show a brief inline disclosure beside their one-click publishing control.

Everything else stays one click: **unpublishing** for every kind (it takes nothing away the author
cannot redo), and publishing a location, item or social card — they have no private-versus-preview
split to consent to, so they keep the plain copyable one-liner. The made-private toast is careful
not to imply existing copies come back.

A field added to a character profile is **clone-visible by default** and only preview-visible if
someone adds it to `toPublicCharacterProfile`. Publishing is therefore the consent boundary for the
whole profile, which is exactly what the disclosure says.
