# Images

The full image suite: avatar generation, reference editing (identity-locked portrait variants),
character-chat scene images, and entity art. All assets are rows in the `images` table with files
under `data/` — one registry, one serving route, one lifecycle.

## Which tree owns what

Image documentation lives in four top-level folders, one per system, and they do not overlap:

| Folder                                           | Owns                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [images/](README.md)                             | The suite itself: providers, the asset registry, the generation lanes, identity packs |
| [image-models/](../image-models/README.md)       | `@vesper/image-models` behavior and the per-model provider reference pages            |
| [image-generator/](../image-generator/README.md) | The admin raw prompt/model bench: one-off runs against any registered model           |
| [image-lab/](../image-lab/README.md)             | The admin experiment bench: evidence-bearing experiment kinds and control fixtures    |

The distinctions that decide where something belongs:

- **`images/` versus `image-models/`.** `images/providers/` owns what the *system* does with a
  model — the row, the probe, the profile, the render intent, the transport.
  `image-models/features/` owns the provider-neutral capability vocabulary and
  `image-models/models/` owns what a specific pinned version measured. A fact about one model's
  behavior at a version belongs on its model page; a fact about how any model is called belongs
  here.
- **`image-generator/` versus `image-lab/`.** Both are admin benches that share the registry,
  capability and render stack, and neither imports the other. The Generator runs an authored
  prompt against any registered model with capability-bound controls and no evidence rules; the Lab
  runs narrow experiment kinds that each require durable evidence — a reviewed fixture, a bound
  identity, a prior run.

Paths stay where they are: the four folders are siblings under `docs/`, not nested under
`images/`.

## Where the code lives

The suite spans three places, and the split is the load-bearing distinction:

- **`packages/image-core/`** (`@vesper/image-core`) — the provider-neutral engine. What a model can
  do, which references a render may carry and in what role, how a prompt compiles for a profile,
  what an identity pack is and when it is usable, how controls bind to a provider's real fields,
  what a failure message means. It knows nothing about characters, chats, or the database, and it
  may not import the app at all. See [its README](../../packages/image-core/README.md).
- **`packages/image-replicate/`** (`@vesper/image-replicate`) — the server-only Replicate transport:
  predictions, reference uploads and cleanup, output download, payload construction, and save-time
  schema probing. It reads no environment; `apps/web/src/server/ai/replicate-runtime.ts` is the only
  code that reads `REPLICATE_*` and hands it one configured client per process.
- **`apps/web/src/server/images/`** — the application's image work: turning game state into an image
  request, and everything stateful around it. Persistence, ownership, job state, event logging,
  prompt composition from a character's attributes and wardrobe, identity-pack and lab lifecycle,
  the gallery, the chat scene queue.

The rule for new code: a provider-neutral image decision belongs in `@vesper/image-core`; Replicate
network or schema work belongs in `@vesper/image-replicate`; translating Vesper's characters,
wardrobe, and scene state into either vocabulary stays in `apps/web`. And because
`@vesper/image-core` and `@vesper/simulation-core` hold equal layer rank, neither may import the
other — application code is the bridge that reads simulated state and emits an image request.

## Reading order

| Doc                                               | What it covers                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [providers/](providers/README.md)                 | Replicate: model rows, probing, task profiles, render intents, transport                 |
| [asset-registry.md](asset-registry.md)            | `images` rows and files: row-before-file, serving gate, deletes, sweep                   |
| [pipelines/](pipelines/README.md)                 | The lanes: avatars, variants, chat scenes, selfies, anchors, entity art                  |
| [prompt-programs/](prompt-programs/README.md)     | Plain-English end-state guide: components, behavior, testing, and worked examples        |
| [prompt-programs.md](prompt-programs.md)          | Technical reference: world digests, positive claims, guarded negatives, endpoint dialects |
| [character-prompts.md](character-prompts.md)      | The character seam: projection, cast, references, identity anchor                        |
| [identity-packs.md](identity-packs.md)            | Derived face crops: derivation, lifecycle, surfaces, trial harness                       |
| [vision.md](vision.md)                            | Models reading stored images: portrait→attributes, chat photo reads                      |

## Demo mode

No keys means an SVG monogram placeholder — a deterministic gradient from the entity name — saved
through the same registry path and flagged `meta.demo: true`. Every pipeline is exercisable in the
automated test suite.

## Adding a pipeline

A new generation kind is a new `images.kind` value plus a job type plus a prompt builder in
`server/images/`, run through the **shared pipeline shell**: `runImagePipeline`
(`images/assets.ts`), which owns the reserve → generate → save-or-fail → log sequence in exactly one
place. Never copy a neighbouring lane.

The lane supplies its row (`CreateImageAssetOptions`), a `produce` returning bytes or a structured
failure, and hooks:

- `failedPrecondition` — fail the reserved row with no event or diagnostic when the source entity is
  gone;
- `afterReserve` — row-scoped writes, such as the scene lane's `image_references`;
- `onReady` — pointer writes once the file exists;
- `onSettled` / `onThrown` — the lane's own event-log payloads. The event log stays **per-lane** by
  ruling; a lane without one, like the chat anchors, gains none;
- `failureDiagnostic` — the warn code a thrown generation failure records. Every generating lane
  carries one: `images.avatar.generate_failed`, `images.variant.generate_failed`, and the entity and
  chat-anchor codes.

Use `generateChecked` for any prompt-composition step; the shell's `saveImageBuffer` owns the atomic
write.

Shared leaf helpers, never re-rolled: `unwrapReplicateImage` (a provider result → bytes-or-throw
with the caller's fallback text), `renderImageIntent` (`images/render-intent.ts` — the seam every
generating lane renders through, after resolving its task's profile with
`resolveImageProfileForTask`; never call `renderWithModel` or the provider directly, or the
profile's controls, the shape negotiation and the crop are all skipped), `readImageBytes` (row bytes
or null), `imageMeta` (jsonb narrowing), `purgeImagesWhere` (caller-owned delete predicate — see
[asset-registry.md](asset-registry.md)), `runInBatches` (`@/lib/batches` — the batch buttons' loop),
and `fnv1aHex` / `fnv1a32` (`@/lib/hash`, a barrel over `@vesper/contracts` — cache keys and seeds,
golden-pinned; never re-roll a hash).

Update the relevant doc in this folder in the same change.
