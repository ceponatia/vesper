# Intimate-scene LoRA — the acts render in the app

Status: awaiting acceptance — the owner's first `staged_scene` bench run.
Both slices are built; slice 1 is verified live in production, and nothing is
left to code. (Owner-directed 2026-08-15, graduating the routing question from
[finished/scene-composition.plan.md](finished/scene-composition.plan.md).)

Outcome: A player whose chat stages an intimate act gets a scene image that
actually depicts it — rendered through the anatomy-trained LoRA the probes
proved — so that the picture stops downgrading the story's explicit moments
to nervous near-misses.

Technical companion: [intimate-scene-lora.spec.md](intimate-scene-lora.spec.md)

## Why

The scene-composition work proved, across ~45 owner-graded probe renders,
that the staged prompts are right and the stock scene model is the ceiling:
`qwen-image-edit-2511` follows every compositional instruction and cannot
draw explicit anatomy. One LoRA — "Qwen Image Edit 2511 NSFW all inclusive"
v2.0, run through Replicate's LoRA-capable Qwen edit wrapper — rendered
every acceptance act the base model could not, with identity held, on the
same prompts the owner accepted (rulings and render trail:
finished/scene-composition.spec.md §Probe results). Today that LoRA rides
only the eval probe; a player's real render never sees it.

## What the owner gets

- **Intimate staged scenes render through the LoRA automatically.** When a
  chat's scene render carries a surviving intimate staging on the uncensored
  route, the render routes through the LoRA wrapper with the proven weights
  at the proven scale. Every other render — non-intimate stagings, unstaged
  scenes, selfies, moderated rungs — is byte-identical to today.
- **The credential stays out of the database.** The LoRA lives on Civitai
  behind the owner's API token; the stored locator is the public URL, and
  the token joins it only at render time, from the environment — same
  pattern as every other provider secret. Logs and diagnostics only ever
  see the redacted locator.
- **Absence degrades, never fails.** Missing token, missing wrapper model
  row, or an unresolvable LoRA row ⇒ the render proceeds exactly as today on
  the stock model, with a diagnostic saying why.

## Boundaries

In scope: the chat-lane scene render path's model+LoRA routing for intimate
staged renders; the builtin LoRA library row; the one environment reader for
the Civitai token; eval-probe parity so the probe renders what production
renders. Non-goals: no player-facing toggles; no per-staging LoRA table (one
LoRA serves all — the probe evidence that once suggested a split dissolved
when the template hardening fixed doggy on this LoRA); no new providers; no
change to moderated-route behavior; the admin image lab adopts the staged
prompts only when its planned expansion happens (slice 2).

## Slices

- **Slice 1 — the render path routes intimate staged scenes through the
  LoRA.**

  Status: complete — 2026-08-15. Verified on the live deploy: an intimate
  staged chat render reached Replicate as the LoRA wrapper, and the scene
  before it — same chat, no surviving staging — rendered on the stock model
  untouched. Evidence in the spec.

  The wrapper model + LoRA binding replace the stock model for exactly the
  intimate-staged uncensored renders; the builtin library row and the token
  seam land with it; degradations named and tested.

- **Slice 2 — the admin image lab drives the staged prompts.**

  Status: built 2026-08-15 — awaiting the owner's first bench run, which is
  what records the kind as accepted. Scoped that day (owner ruling) as its own
  `staged_scene` lab kind, which removed the dependency on the image-lab
  expansion the slice was originally queued behind.

  The owner picks an intimate staging outright and renders it on the bench —
  the same words and the same LoRA a chat would send, with no chat, no
  composer, and no narration to steer. It answers a question the chat lane
  structurally cannot: whether the LoRA's scale is right, graded across a
  sweep on one staging.

## Success criteria

- **Met 2026-08-15.** An intimate staged chat render on the uncensored route
  reaches Replicate as the LoRA wrapper model with `lora_weights` set
  (verifiable on the image row's recorded model + meta).
- **Met 2026-08-15.** A non-intimate or unstaged render's request is
  byte-identical to today's.
- **Met at build time.** With `CIVITAI_API_TOKEN` unset, every render still
  succeeds on the stock model and the skip is diagnosed — covered by the
  degradation tests, not re-run against production.
- **Met 2026-08-15.** The `CIVITAI_API_TOKEN` Fly secret is set; without it
  production quietly renders as today, which is the designed degradation but
  not the owner's intent.

One thing the run exposed that no criterion asked for: the route's practical
gate is not the LoRA machinery at all, but whether a staging survives the
composer. The first render of the verification took the stock model with every
LoRA leg healthy, because the composer proposed no staging for prose that
described the act only glancingly. Detail in the spec.

## Open questions

- **Should the subject's intimate-anatomy phrasing be suppressed on
  from-behind shots?** Carried from the scene-composition close-out; detail
  in finished/scene-composition.spec.md §Known tensions. The LoRA may change
  the answer — re-grade on post-LoRA renders.
  - No for now.
