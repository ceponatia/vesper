# Intimate-scene LoRA — technical spec

Status: companion to [intimate-scene-lora.plan.md](intimate-scene-lora.plan.md)

The implementation contract for slice 1: routing intimate staged chat scene
renders through the LoRA wrapper. The probe evidence this design rests on is
finished/scene-composition.spec.md §Probe results.

## Scope

The chat-lane scene render path only: `renderCharacterSceneImage`
(`apps/web/src/server/images/character-scene.ts`), `renderResolvedScene`
(`scene.ts`), and the render-intent seam that already carries LoRA bindings
for the lab. Plus one builtin `image_loras` row (data migration) and one
environment reader for the Civitai token. Leaves alone: prompts and
registries (scene-composition's, unchanged), moderated routes, selfies, the
lab (slice 2), `@vesper/image-core` and `@vesper/image-replicate` (no package
changes — the token append happens app-side).

## Implementation status

- **Slice 1 — render-path routing + builtin row + token seam**: in progress.
- **Slice 2 — lab adoption**: blocked on the image-lab expansion; nothing
  specified yet.

## Decisions (probe-settled, 2026-08-15)

- **One LoRA for every intimate staging**: "Qwen Image Edit 2511 NSFW all
  inclusive" v2.0 — Civitai model 2700552, version 3160956 — at scale 1.
  The per-staging split once considered is dead: the template hardening
  fixed the one beat (doggy) where another LoRA had led, on this LoRA, 4/4.
- **Routing trigger**: the resolved plan carries `staging` with
  `intimate: true` AND the render is the uncensored reference route (the
  same condition that emits the staging sentence). Non-intimate stagings,
  unstaged scenes, selfies, moderated rungs: byte-identical behavior.
- **Wrapper model**: `qwen/qwen-image-edit-plus-lora` at its probed pin
  (docs/image-models/qwen-image-edit-plus-lora.md) — resolved from the model
  registry BY SLUG at render time, the lab's own pattern; it stays off every
  picker surface. Its 2509-generation identity trade is accepted (owner
  acceptance covered renders made on it).
- **Secret handling**: the stored locator is the PUBLIC download URL
  (`https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor`);
  `CIVITAI_API_TOKEN` is read from the environment by ONE app-side accessor
  and appended as the `token` query parameter at the moment the binding maps
  to provider input. The token never lands in the database, an image row, or
  a log line (`redactImageLoraLocator` already strips query strings).

## Algorithm (slice 1)

1. `renderCharacterSceneImage` resolves the scene profile as today. After
   `composeSceneSpec`, if `plan.staging?.intimate === true` and the resolved
   route is the uncensored reference path, attempt the LoRA route:
   a. resolve the wrapper model row by base slug from the registry;
   b. resolve the builtin LoRA row through `resolveImageLoraForRender`
      (the library seam — registry membership, version binding, scale band);
   c. read the token accessor; if present, thread the binding + the
      token-completed locator into the render.
2. Any miss in (a)–(c) ⇒ render exactly as today on the stock profile, with
   one info diagnostic naming the missing leg.
3. The content-rejection selfie/sanitize retry already strips `staging`;
   a stripped plan no longer satisfies the trigger, so the retry naturally
   renders LoRA-free on the stock model.
4. The image row records the wrapper model slug (existing `modelFor`) and
   the resolved LoRA id in `meta` beside the existing `{camera, staging}`.

## Resilience

| Code                                        | Severity | Cause                                                    |
| ------------------------------------------- | -------- | -------------------------------------------------------- |
| `images.scene_render.lora_route`            | info     | Intimate staged render routed through the LoRA wrapper.  |
| `images.scene_render.lora_unavailable`      | info     | Token, wrapper row, or LoRA row missing — stock render.  |

Degradation tests assert the fallback AND the code (docs/resilience.md).

## Persistence

One hand-written data migration (0104's precedent) inserting the builtin
`image_loras` row: label, `https_url` locator (public URL, no token), scale
band 0.5–1.5 with default 1, builtin true. No schema change.

## Deploy note

Production needs the Fly secret set before the LoRA route can fire:
`fly secrets set CIVITAI_API_TOKEN=…` (value from the owner's Civitai
account). Until then every render degrades to today's behavior by design.

## Fixtures and tests

- Routing: intimate staged + uncensored ⇒ wrapper model + binding; each
  degradation leg ⇒ stock render + `lora_unavailable`; non-intimate staging,
  unstaged, selfie, moderated ⇒ untouched request (byte-equality pin).
- Token append: locator stored without token; provider input carries it when
  the env reader answers; diagnostics never contain it (redaction pin).
- The sanitize retry renders LoRA-free.
- Probe parity: `intimate-model-ab.ts`'s lora arm and the production route
  build the same wrapper+weights request shape for the same beat.
