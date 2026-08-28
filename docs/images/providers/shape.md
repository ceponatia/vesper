# Shape negotiation

**Shape is negotiated per render, not fixed per model.**

A lane asks for a ratio — 3:4 everywhere except items at 1:1 and locations at 3:2.
`chooseDimensions` extends the `chooseAspect` seam with the profile's dimension controls:

- On **aspect-ratio models** the shape is the closest enum entry (largest exact match preferred),
  while a tier or custom pair rides the mapped control fields.
- On **size-mode models** the enum entries ARE the sizes, so a named tier picks the nearest-area
  entry within the closest-ratio group (largest when unset — the pre-tier behavior), and an
  explicit pair is honored only under the `custom` tier and only when it matches an offered entry
  verbatim.

`width` / `height` require the `custom` tier in both modes: set without it they are dropped with
`requires_custom_resolution` rather than sent under a crop expectation that would be wrong.
`renderWithModel` centre-crops toward the lane's ratio whenever the expected shape misses it.

One mechanism therefore serves Vesper's 3:4 portraits, Stable Diffusion 3.5 Large (whose enum has
**no** 3:4 — it renders 4:5 and gets cropped), Wan 2.7 (no aspect input; `1536*2048` pixel pairs,
its 2K/4K tiers picking among them), and the entity lanes.

## Asking for no shape at all

`ImageRenderTarget.aspectRatio` takes `null`, which writes no `aspect_ratio` / `size` key, picks
no bucket, and crops nothing, so the model answers at its own default.

Every player-facing lane names a ratio. The admin [Image
Generator](../../image-generator/README.md) is the caller that does not, because a bench that
reshaped a model's output would report Vesper's opinion as the model's.

## What the renderer reports back

`renderWithModel` reports what it did — the aspect field and value it wrote, the ratio it
expected, whether it cropped, and the returned image's own pixel size — so a caller recording
provenance does not have to re-derive any of it.
