# Shape negotiation

**Shape is negotiated per render, not fixed per model.**

## Resolution order

`resolveRenderTarget` (`packages/image-core/src/render-intent/render-target.ts`) is the ONE seam
every render's target ratio comes from — `planImageRender` calls it and records both the ratio and
its source on the plan. Precedence, highest first:

| Source         | When it applies                                                                   |
| -------------- | --------------------------------------------------------------------------------- |
| `raw`          | The intent explicitly asked for no shape at all (`target: { aspectRatio: null }`) |
| `profile`      | The profile declares its own `controlDefaults.aspectRatio`                        |
| `lane`         | The intent carries an explicit numeric target                                     |
| `task_default` | Neither of the above named a shape — `IMAGE_TASK_TARGET_ASPECTS[task]`            |

`raw` always wins: a bench proving what a model does on its own must stay untouched by anything
downstream of it. A profile's own declared shape then outranks a lane's own hard-coded number —
which is what lets a reviewed custom bucket (832×1216, say) be judged against its own ratio instead
of a generic 3:4 that would crop it. `IMAGE_TASK_TARGET_ASPECTS` is a closed table keyed by
`ImageProfileTask`: `portrait` / `variant` / `scene` / `chat_look` at 3:4, `item` at 1:1, `location`
/ `chat_place` at 3:2, every other task at 3:4. Every production lane still names its target
explicitly today; the table is where a render that does not lands.

## Choosing among what the model offers

`chooseDimensions` extends the `chooseAspect` seam with the profile's dimension controls:

- On **aspect-ratio models** the shape is the closest enum entry (largest exact match preferred),
  while a tier or custom pair rides the mapped control fields.
- On **size-mode models** the enum entries ARE the sizes, so a named tier picks the nearest-area
  entry within the closest-ratio group (largest when unset — the pre-tier behavior), and an
  explicit pair is honored only under the `custom` tier and only when it matches an offered entry
  verbatim.

`width` / `height` require the `custom` tier in both modes: set without it they are dropped with
`requires_custom_resolution` rather than sent under a crop expectation that would be wrong.

One mechanism therefore serves Vesper's 3:4 portraits, Stable Diffusion 3.5 Large (whose enum has
**no** 3:4 — it renders 4:5 and gets cropped), Wan 2.7 (no aspect input; `1536*2048` pixel pairs,
its 2K/4K tiers picking among them), and the entity lanes.

## Asking for no shape at all

`ImageRenderTarget.aspectRatio` takes `null`, which resolves the target as `raw`: no
`aspect_ratio` / `size` key is written, no bucket is picked, and nothing is cropped, so the model
answers at its own default.

Every player-facing lane names a ratio. The admin [Image
Generator](../../image-generator/README.md) is the caller that does not, because a bench that
reshaped a model's output would report Vesper's opinion as the model's.

## Crop placement

`renderWithModel` crops whenever the expected shape misses the target. Where the crop window lands
is `chooseCropPlacement`'s decision (`packages/image-core/src/models/crop-placement.ts`), pure and
separate from `cropToTargetAspect`, which only extracts the rect it is handed:

- **A focal box is known.** The crop window slides along the axis actually being trimmed to
  contain it, clamped to the image; the untrimmed axis is always centered.
- **No focal box.** A too-TALL trim anchors to the TOP for a subject-bearing task (`portrait` /
  `variant` / `scene` / `chat_look` — a composition's head sits near the top of the frame); every
  other task, and a too-WIDE trim regardless of task, centers.

No focal source runs today. The identity pipeline's own detector seam
(`identity/identity-pack-detector.ts`) is a deliberate null — a privacy stance — and the scene
camera stores framing as an enum id, never coordinates, so every render's `focalSource` reads
`"none"`. The wiring exists on `renderWithModel`'s `focal` input for a future, explicitly
authorized detector to fill in.

## What the renderer reports back

`renderWithModel` reports what it did — the aspect field and value it wrote, the ratio it
expected, whether it cropped, and the returned image's own pixel size — so a caller recording
provenance does not have to re-derive any of it. `renderImageIntent` joins that to the plan's own
target resolution and stores the whole thing as `images.meta.render.shape`:

`mode` (`provider_default` / `target_ratio`), `requestedAspect` and `targetSource` (the resolution
above), `sentField` / `sentValue` (what actually reached the provider), `expectedAspect`,
`returned` (the pixel size that came back — the FINAL image, after any local crop), `providerSize`
(the provider's own pixel size BEFORE that crop, or `null` when no crop was attempted or the
buffer could not be decoded — `returned` alone cannot say what a crop removed, since a crop's own
`rect` is always the same size as `returned`), and `crop` — `null` when none was needed, else
`targetRatio`, `placement` (`focal` / `top` / `center`), the exact `rect` extracted, and
`focalSource`. A stored render can therefore answer "was the frame cut, where, and why" without an
operator re-deriving it from the prompt or guessing at the model's own default.
