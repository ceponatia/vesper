# Entity images

Library items and locations each carry one image (their `imageId` column), generated from the
entity's own fields. There are no character-style variants, no upload, and no gallery entry
beyond the `entity` tab.

`generateEntityImage({ entityKind, entityId, userId })` (`server/images/entity.ts`) compiles the
prompt, creates a `kind: "entity"` asset, generates (with the demo monogram fallback), and on
success sets the row's `imageId` and **reclaims every other image for that entity** — a
regenerate replaces the old one, one image per entity, no orphans.

## The prompt is compiled, not written

`buildEntityPromptProgram` (`server/images/entity-prompt-program.ts`) reads the row, projects it
into an immutable world digest through `contracts/images/entity-digest.ts`, and compiles that
digest through `@vesper/image-core`'s prompt-program pipeline against the profile's bound dialect
and prompt packs — see [../prompt-programs.md](../prompt-programs.md).

The projection makes the shot decisions as **facts**:

- an item's `kind` chooses its presentation — clothing hangs in its own shape and the clause
  names no support, objects and containers are isolated on a seamless surface;
- a location's `scale` chooses its view — `open` or `expanse` gives an outdoor landscape,
  otherwise an architectural interior; and
- both operations assert **zero subjects**, which is what puts "no people" in the prompt and
  switches off every anatomy, hand, skin and single-subject negative block.

Aspect is 1:1 for items and 3:2 for locations. Exclusions — accidental lettering, watermarks,
cluttered background, wrong medium — live in the negative pack, not in the positive prose, so
the collision linter can drop one when a world fact contradicts it (an item whose marking must
be legible keeps its lettering). The compiled program's provenance lands on the image row under
`meta.promptProgram` and `meta.worldState`.

A lane whose resolved model has **no bound prompt program refuses**: the image row is marked
failed with the reason, rather than falling back to a generic paragraph. Every source field an
entity carries has a recorded projection disposition
(`contracts/images/world-projection.ts`), and a test fails when a new column or definition
member has none.

## Triggering

`POST /api/{items,locations}/:id/image` runs a background `entity_image` job, so it survives
navigation. The editor's **Image** tab polls `GET /api/{items,locations}/:id/image` (latest row)
until it leaves `pending`, shows the result with click-to-enlarge, and offers Regenerate. Entity
deletion drops these via `deleteEntityImages`.

The library pages also carry a **Generate images** button. `POST /api/{items,locations}/images`
takes the ids the client sends — those visible under the active type/search filter, so the Items
library's All/Clothing/Object/Container buckets scope the batch — intersects them with the
owner's still-missing entities (`missingEntityImageIds`), and runs `generateEntityImagesBatch`:
parallel batches of `ENTITY_IMAGE_BATCH_SIZE` (5), one failure never aborting the rest, in a
background job. The grid polls so images appear as they land. The button opens a confirm dialog
naming how many images the batch covers; entities that already have an image are skipped.
