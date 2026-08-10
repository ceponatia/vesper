# Images

`src/server/images/` — full image suite: avatar generation, reference editing (identity-locked portrait variants), and character-chat scene images. All assets are rows in the `images` table with files under `data/` — one registry, one serving route, one lifecycle. (The old app had three parallel ad-hoc systems; don't recreate that.)

## Reading order

| Doc                                              | What it covers                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| [providers.md](providers.md)                     | Replicate: model rows, probing, task profiles, render intents, transport |
| [asset-registry.md](asset-registry.md)           | `images` rows + files: row-before-file, serving gate, deletes, sweep     |
| [pipelines.md](pipelines.md)                     | The lanes: avatars, variants, chat scenes, selfies, anchors, entity art  |
| [identity-packs.md](identity-packs.md)           | Derived face crops: derivation, lifecycle, surfaces, trial harness       |
| [advanced-image-lab.md](advanced-image-lab.md)   | Admin experiment bench: controlled Qwen probes, fixtures, baselines      |
| [vision.md](vision.md)                           | Models reading stored images: portrait→attributes, chat photo reads      |

## Demo mode

No keys → SVG monogram placeholder (deterministic gradient from the entity name) saved through the same registry path, flagged `meta.demo: true`. Every pipeline is exercisable in CI.

## Adding a pipeline

New generation kind = new `images.kind` value + a job type + a prompt builder in `server/images/`, run through the **shared pipeline shell** — `runImagePipeline` (`images/assets.ts`), which owns the reserve → generate → save-or-fail → log sequence in exactly one place (image-pipeline-consolidation plan, audit C1) — never a copied neighbour lane. The lane supplies its row (`CreateImageAssetOptions`), a `produce` returning bytes or a structured failure, and hooks: `failedPrecondition` (fail the reserved row with no event/diagnostic when the source entity is gone), `afterReserve` (row-scoped writes — the scene lane's `image_references`), `onReady` (pointer writes once the file exists), `onSettled`/`onThrown` (the lane's own event-log payloads — the event log stays **per-lane** by ruling; a lane without one, like the chat anchors, gains none), and `failureDiagnostic` (the warn code a thrown generation failure records — every generating lane carries one — `images.avatar.generate_failed`, `images.variant.generate_failed`, and the entity/chat-anchor codes). Use `generateChecked` for any prompt-composition step; the shell's `saveImageBuffer` owns the atomic write. Shared leaf helpers, never re-rolled: `unwrapReplicateImage` (a provider result → bytes-or-throw with the caller's fallback text), `renderImageIntent` (`images/render-intent.ts` — the seam every generating lane renders through, after resolving its task's profile with `resolveImageProfileForTask`; never call `renderWithModel` or the provider directly, or the profile's controls, the shape negotiation and the crop are all skipped), `readImageBytes` (row bytes or null), `imageMeta` (jsonb narrowing), `purgeImagesWhere` (caller-owned delete predicate — see [asset-registry.md](asset-registry.md)), `runInBatches` (`@/lib/batches` — the batch buttons' loop), and `fnv1aHex`/`fnv1a32` (`@/lib/hash` — cache keys/seeds, golden-pinned; never re-roll a hash). Update the relevant doc in this folder.
