# Intimate-scene LoRA — technical spec

Status: companion to [intimate-scene-lora.plan.md](intimate-scene-lora.plan.md)

The implementation contract for both slices: routing intimate staged chat scene
renders through the LoRA wrapper (slice 1), and the `staged_scene` lab kind
that benches the same prompt and LoRA without a chat (slice 2). The probe
evidence this design rests on is finished/scene-composition.spec.md
§Probe results.

## Scope

The chat-lane scene render path only: `renderCharacterSceneImage`
(`apps/web/src/server/images/character-scene.ts`), `renderResolvedScene`
(`scene.ts`), and the render-intent seam that already carries LoRA bindings
for the lab. Plus one builtin `image_loras` row (data migration) and one
environment reader for the Civitai token. Leaves alone: prompts and
registries (scene-composition's, unchanged), moderated routes, selfies,
`@vesper/image-replicate`. Slice 2 additionally touches the lab's contracts and
recipes in `@vesper/image-core` and adds one lab lane app-side; neither slice
changes the token append, which stays app-side.

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
- **Slice 2 — lab adoption**: built 2026-08-15, **not yet accepted** — the kind
  renders and records a verdict, and no owner bench run has happened. Scoped
  that day (owner ruling) as a first-class `staged_scene` lab kind rather than
  waiting on the lab expansion; design below. No migration. The parity pin runs
  as a census over all 13 registry stagings.

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

## Slice 2 — the `staged_scene` lab kind

Owner ruling (2026-08-15): build staged scenes as their own lab kind now,
rather than waiting on the image-lab expansion the slice was originally queued
behind. The expansion remains unplanned; this slice no longer depends on it.

### What it is

An eighth experiment kind, `staged_scene`, that renders one intimate staging
from the registry on a bench — the same compiled prompt and the same LoRA the
chat lane sends, with no chat, no composer, and no narration to steer. It is
the instrument the chat lane cannot be: the production route only reaches an
intimate render when the composer proposes a staging AND quotes narration
verbatim for it, so grading a staging today means playing a chat until the
composer cooperates. Here the staging is chosen outright.

### Parity is the whole point, and it comes from reuse

Two things must match production exactly, and both are reuse rather than
reimplementation:

- **The words** come from `buildSceneRenderPrompt` (already exported from the
  images barrel) applied to a `SceneRenderPlan` the lane assembles, exactly as
  `scripts/eval/scene-images/orientation-ab.ts` assembles one outside the chat
  lane. The registry owns every explicit word; the lab never paraphrases a
  template.
- **The LoRA** rides `settings.controls.lora`, which `runRecipeIntent` already
  resolves through `resolveImageLoraForRender` — the same seam, the same
  library gates, the same `image_lora.*` refusal codes as the chat route. No
  change to `runRecipeIntent`, and no second binding path to drift.

`resolveIntimateSceneLoraRoute` is deliberately NOT called here: its facts
(`allowIntimate`, `selfie`, `referenceRoute`, `anchored`) are chat-shaped, and
a lab row would have to invent four of them to ask a question it already knows
the answer to. The lane instead states the same claim directly — this row is a
staged intimate render on the wrapper model with the builtin LoRA — and lets
the library seam refuse it if the pinned model cannot carry it.

**No migration.** The recipe's task is `scene`, so the builtin row's existing
`allowed_tasks: ["scene"]` already admits it; the earlier assumption that
slice 2 widens `allowed_tasks` was wrong. `image_lab_experiments.kind` is a
plain `text` column whose enum lives only in TypeScript, so an eighth kind is a
contract edit, not a schema change.

The staging rides the row's **meta bag**, beside `sourceExperimentId` and
`finishingVariant` — not `settings`. `settings` is the per-run knobs overlay,
and the staging is the subject of the run rather than a knob on it; putting it
there would widen the tuning layer to carry what the experiment IS. Both are
equally migration-free.

### Contracts (`packages/image-core/src/lab/`)

- `imageLabExperimentKinds` gains `staged_scene`. The exhaustive dispatch in
  `image-lab-run.ts` is a compile error until its arm lands, which is the point.
- `imageLabCreateExperimentRequestSchema` gains a `staging` field carrying the
  registry id as a **plain string** plus the scene fields the plan needs
  (setting, lighting, time of day). It cannot be typed as `SceneStagingId`: the
  registry is app-side (`apps/web/src/contracts/images/scene-staging.ts`) and
  unreachable from a package. The lane validates the id against the registry and
  refuses an unknown one with the lab's own vocabulary.
- `superRefine` refuses `staging` on every other kind, and refuses a
  `staged_scene` without one — the same shape as the `finishing_pass` rules.
- A recipe profile `staged_scene/<staging-id>`: task `scene`, operation `edit`,
  `multi_reference_compose`, identity reference required, location optional.

### The lane (`apps/web/src/server/images/image-lab-staged.ts`)

1. Read inputs; require exactly one `identity` input bound to a character this
   owner has (`labCharacterNames`, the two-character lane's precedent).
2. Look the staging up in the registry; an unknown id settles `subject_invalid`
   with the id echoed.
3. `resolvePinnedLabModel(row.modelSlug, …)`, then the standard control-binding
   and capacity pre-checks.
4. Assemble a `SceneRenderPlan`: the staging's own camera and viewer parts, the
   focal character's name and appearance, the admin's setting/lighting, and
   exposure set bare for the staging's `requiresBare` regions — a bench row
   states its own exposure rather than deriving one from chat state that does
   not exist.
5. Compile with `buildSceneRenderPrompt(plan, { allowIntimate: true })` and hand
   the result to `runRecipeIntent` as the base prompt.
6. `controls.lora` defaults to the builtin intimate row at its curated default
   scale, and the admin may override the scale within the curated band — which
   is what makes this bench answer "is scale 1 right?", a question the chat lane
   cannot ask at all.

### The verdict vocabulary

Owner ruling (2026-08-15): a staged scene gets its own fourth vocabulary rather
than borrowing one. The existing sets are about questions this kind does not
ask — the probe's `honours_control` would read, a month later, as though a
fixture had been sent when a staged scene sends none, and the two-character set
grades cast handling on a render with one person in it.

It is graded on what these renders actually fail at:

| Verdict            | Means                                            |
| ------------------ | ------------------------------------------------ |
| `act_depicted`     | the act is there — the only promotable outcome   |
| `act_substituted`  | a different act came back                        |
| `anatomy_withheld` | right act, rendered coy — absent or smoothed     |
| `geometry_wrong`   | right act and anatomy, bodies arranged wrong     |
| `identity_lost`    | the act is right, the person is not the one      |
| `inconclusive`     | the member every vocabulary shares               |

The two middle rulings are the pair that earns this vocabulary. Both mean "the
picture is wrong", and they point at **opposite** corrections:
`anatomy_withheld` is the LoRA missing, refused, or scaled too low — the
nervous near-miss this whole plan exists to end — while `geometry_wrong` is the
scale pushed too high. An admin running a scale sweep on one staging is
distinguishing exactly those two, which is the question the chat lane cannot
ask at all.

### Refusals

Each settles on the row pre-spend, in the lab's vocabulary: `input_missing`
(no identity input), `subject_invalid` (unknown staging id, or an identity
image not filed against the named character), `version_unpinned`,
`control_invalid`, `capacity_exceeded`, `settings_unsupported`, plus the
`image_lora.*` codes the library seam raises verbatim.

### Tests

- The compiled prompt for a given staging is **byte-identical** to what the
  chat lane produces for the same plan — the pin that makes this a bench rather
  than a lookalike. It runs as a census over all 13 registry stagings, with the
  chat side earning its staging through the real evidence, cast and coverage
  gates rather than a hand-built plan.
- An unknown staging id refuses without a provider call.
- The LoRA selection reaches `resolveImageLoraForRender` with the builtin id
  and a scale inside the curated band; a scale outside it refuses pre-spend.
- The dispatch is exhaustive (a compile-time guarantee, asserted by the kind
  census test).

### What the bench does NOT reproduce

The parity claim is about the **staged wording and the LoRA binding**, not the
whole production prompt. A bench row reads only the character's name, so the
focal spec carries no `appearance`, `identityAnchors`, `ageAnchor` or
`intimateAppearance` — the likeness rides the required identity reference under
the lock instead. A production chat sends those textual anchors too, so a
verdict here is evidence about the staging and the weights, and not a
prediction of a chat render's identity fidelity. Adding them would mean a
second owner-scoped read of `characters.profile`; it is deliberately left out
rather than overlooked.

The viewer's own exposure is stated bare, matching the probe scripts: without
it `resolveViewerParts` drops `genitals` and the all-or-nothing viewer-part
gate suppresses the staged sentence entirely — a paid render that is not the
experiment the row describes.
