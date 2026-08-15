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

- **Slice 1 — render-path routing + builtin row + token seam**: built
  2026-08-15, **verified live in production 2026-08-15**. `scene-lora.ts` owns
  the route (trigger mirrors the staged sentence's own gates; four degradation
  legs, each `lora_unavailable` with a named `leg`); `lora-credentials.ts` is
  the one `CIVITAI_API_TOKEN` reader, applied at the render-intent seam
  downstream of both LoRA resolution paths; migration
  `drizzle/0108_intimate-scene-lora.sql` seeds the builtin row (public locator,
  band 0.5–1.5 around the probed default 1, `allowed_tasks: ["scene"]`
  fail-closed, no trigger words — the probe graded the unchanged prompt). 49
  tests. Production evidence: [the live-route run](#live-route-verification-2026-08-15).
- **Slice 2 — lab adoption**: blocked on the image-lab expansion; widens the
  builtin row's `allowed_tasks` rather than adding a second row.

## Live-route verification (2026-08-15)

An intimate staged chat render on the Fly deploy took the LoRA route end to
end, on the QA account's Sabrina Vale cast.

| Field            | Value                                          |
| ---------------- | ---------------------------------------------- |
| Image row        | `bvzh3lhu4e0i5e3fsxzvkbib` — kind scene, ready |
| `meta.model`     | `replicate/qwen/qwen-image-edit-plus-lora`     |
| `meta.lora`      | `imglorqwennsfwallinclv20`                     |
| `meta.staging`   | `astride_viewer_facing`                        |
| `meta.camera`    | low / close / toward_viewer — set by staging   |
| Diagnostic       | `images.scene_render.lora_route`, scale 1      |

Three facts the run settled:

- **The control render is the contrast.** The immediately preceding scene in
  the same chat (`iji1lpio7903ew9lw0dukile`) carried no surviving staging and
  rendered on the stock `qwen/qwen-image-edit-2511` with no LoRA — the
  untouched-request criterion, observed rather than argued.
- **A staging owns the shot.** The control's camera was `eye_level`; the staged
  render's was the registry's `low`, confirming the camera override.
- **Redaction holds.** The `lora_route` log line carries the LoRA id, the slug,
  and the scale, and no locator or token.

### Deploy-time state, corrected

The earlier claim that two deploy-time pieces were outstanding was wrong on the
first: the wrapper model row was already registered on the production registry
on 2026-08-11 during the probe work, with probed `loraWeights`/`loraScale`
bindings — it is the only registry row whose `advancedCapabilities.controls`
are non-empty. Only the `CIVITAI_API_TOKEN` Fly secret was genuinely missing,
and it was set on 2026-08-15 before this run.

### What gates the route in practice

Every LoRA leg was healthy on the first attempt of the run; the render still
took the stock model, because **no staging survived the composer gates**. The
binding constraint on seeing the LoRA fire is therefore upstream, in
scene-composition: the composer must propose a staging AND quote narration
verbatim for it. Reaching it took an explicitly staged act in the player's own
words — "astride", by itself, did not match `astride_viewer_facing`, whose
template describes penetration. A render that comes back LoRA-free with **no**
`lora_unavailable` line was dropped there, and the composer's staging-drop
diagnostics never reach the process log on the chat path (`queueChatScene`
passes no sink), so `meta.staging` is the only signal.

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

The Fly secret is set (2026-08-15): `fly secrets set CIVITAI_API_TOKEN=…`,
value from the owner's Civitai account. A rebuilt or re-secreted environment
needs it again — without it every render degrades to the stock model by design,
diagnosed as `leg: "credential"`.

## Fixtures and tests

- Routing: intimate staged + uncensored ⇒ wrapper model + binding; each
  degradation leg ⇒ stock render + `lora_unavailable`; non-intimate staging,
  unstaged, selfie, moderated ⇒ untouched request (byte-equality pin).
- Token append: locator stored without token; provider input carries it when
  the env reader answers; diagnostics never contain it (redaction pin).
- The sanitize retry renders LoRA-free.
- Probe parity: `intimate-model-ab.ts`'s lora arm and the production route
  build the same wrapper+weights request shape for the same beat.
