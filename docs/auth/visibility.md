# The authorization seam

`server/api/visibility.ts` owns the asymmetry — **reads widen, writes stay strict**.

| Operation                                       | Rule                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Write** (PATCH / DELETE / mutating image-gen) | `ownerId = me` **only** — a non-owner write returns 404, never confirming the row exists.                                                               |
| **List "my library"**                           | `ownerId = me` (any visibility).                                                                                                                        |
| **Browse / preview** (read for copy)            | `findViewable(kind, id, me)` = owner **OR** `visibility = 'public'`; a **foreign** viewer receives the allow-listed public representation, not the row. |
| **Clone** to your library                       | read the public source, deep-copy into a new owned row (`visibility='private'`, `clonedFromId=src`) — see [sharing.md](sharing.md).                     |

- **Shareable** entities (`characters`, `locations`, `items`, `social_cards`) carry a `visibility`
  column (`private` default | `public`). **Personas and chats are always private** — they have no
  such column.
- The `GET /:kind/:id` routes use `findViewable`, then scope sub-resources (portraits) to the
  **entity owner**, so a public preview shows the author's art rather than the viewer's.
- **`<entity>.visibility` is a cross-account share scope**, distinct from any in-world or
  in-fiction secrecy concept. Do not confuse a public/private *share* scope with a character's
  authored secrets or a scenario's hidden premise.
- Headroom: `visibility` can gain an `unlisted` (link-only) tier with no migration. A
  `(visibility)` index lands with the public-browse query, not before.

## The discovery scope is typed to that split

`searchLibraryIds` (`server/api/library.ts`) is overloaded: any `LibraryKind` may be searched at
`owned`, but `public` and `all` are accepted only for a `ShareableKind`, so a visibility-less kind
cannot reach the `visibility = 'public'` predicate from a statically-known call site.

`resolveLibraryScope` is the runtime backstop for dynamic kinds: an unsupported pair returns **no
ids** plus an `api.library.scope_unsupported` warn diagnostic, instead of emitting SQL against a
column the table does not have (matrix in `library.test.ts`).

## "Public" is a representation, not the row

A foreign viewer never receives the persisted row. `server/api/visibility.ts` owns one
**allow-list projection per kind** — `toPublicCharacter`, `toPublicLocation`, `toPublicItem`,
`toPublicSocialCard` — and the four detail routes split on `mine`
(`row.ownerId === user.id`): the owner keeps the full row because the edit surfaces need every
column, and everyone else gets the projection.

- **Always excluded**: `ownerId` (the response carries the computed `mine` flag instead — a viewer
  never needs another account's id), `searchEmbedding` / `embedder`, `clonedFromId`, and
  `updatedAt`. `createdAt` is the only timestamp.
- **Included**: id, name, tags, visibility, createdAt, plus the kind's display fields — character
  `profile` (projected, below) and `avatarImageId`; location description, ambient, scale, area,
  affordances and imageId; item kind, description, definition and imageId; social card description
  and definition.
- Portrait rows beside a public character project to
  `{ id, kind, entityKind, entityId, createdAt }` — no `path`, no `prompt`, no provider internals
  ([../images/asset-registry.md](../images/asset-registry.md)).
- The default is **closed**: a column added to one of these tables is private until someone adds it
  to the projection. `public-dto.int.test.ts` asserts the **exact key set** per kind, so widening
  the public surface is always a deliberate, reviewed edit.
- The **list and browse** routes were already projected to summary columns only and stay that way:
  `searchLibraryIds` returns ids, and whatever hydrates them for a `public` or `all` scope must
  select an explicit column list.

## The character profile is itself projected

`toPublicCharacterProfile` lives in
[`contracts/world/profile.ts`](../../apps/web/src/contracts/world/profile.ts), beside the field
definitions, so adding a profile field puts the reviewer next to the decision. The ruling is
**conservative private-by-default**.

A public preview shows **presentation only**: `bio`, `personality`, `age`, `speciesId`, and an
allow-listed slice of `attributes` — today just `identity.gender`, which the browse route already
publishes as a facet, with each surviving row reduced to `{ id, value }` and no provenance.

Withheld: narrator guidance (`voice`, `voiceAnchors`, `microExemplars`, `intimacy`, `traits`,
`preferences`, `socialCards`, disposition `tags`), authored secrets (`drives` — they carry
`guarded` and `secret` levels and reveal gates), hidden stance (`playerRelationship` — mask, shared
history, premise note), and the operational fields (`heritageId`, `bodyPlanId`, `intimateRegions`,
`bodyFeatures`, `aliases`, `outfits`, `schedule`).

`row.profile` is untrusted jsonb, so it goes through `parseOr(characterProfileSchema, …)` before
the projection — never a cast. `public-dto.int.test.ts` asserts the exact key set of the projection
**and** of its nested `attributes` rows, with a pure twin in `contracts/world/profile.test.ts`.
