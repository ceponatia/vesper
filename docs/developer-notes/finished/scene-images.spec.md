# Scene image references — multi-reference & provider strategy

Status: **active** — _raised 2026-06-16_ in response to external feedback on
scene image generation; **PM-reviewed 2026-06-16** (decisions folded in below).
This is the **design / decision record** (the "truth"); the task list and build
order live in [scene-images.plan.md](scene-images.plan.md). Graduated out of the
[deferred.plan.md](../deferred.plan.md) parking lot 2026-06-16.

> **Pivot (2026-06-19) — drop Flux, Qwen everywhere. SHIPPED 2026-06-19.** Flux
> was removed from the app (it input-moderates nudity and is expensive), making
> **Venice/Qwen the default for every lane** and taking OpenRouter out of the image
> stack. The surveyed **NSFW-capable** models were onboarded (§5 — Seedream
> rejected; Venice's `/image/multi-edit` fills the multi-ref + NSFW gap, wired as a
> per-session single↔multi toggle). §5/§8.3/§10 describe the shipped design; §1
> below now reads as the *historical* pre-pivot baseline (Flux **is** removed in
> code — `server/ai/venice.ts` is the whole image stack). See
> [scene-images.plan.md](scene-images.plan.md) for build status + the multi-pass
> future lever.

Decisions from the PM pass:

- **Build the provider-capability layer + multi-reference plumbing now**, and
  **build the reference join table now** (not deferred) — app-wide metrics /
  queryability is a first-class goal (§4).
- **Spikes are greenlit:** verify OpenRouter Flux multi-image fields + a two-ref
  test script (§5); a Qwen-Image reference-sheet quality test (§6); research the
  best cloud-hosted ComfyUI NSFW models (§7).
- **The uploaded-avatar intimate guard is deferred** (§3) — we are pre-launch in
  dev with no real users and no real uploads, so the misuse path has **zero**
  chance of firing today. It is **not** dropped: it is a **hard pre-production
  gate** (must ship before the app accepts real user uploads / goes to
  production). The fix is fully designed below so it's ready to drop in.

This is my review of the feedback, grounded in the current pipeline
([../images.md](../../character-chat/images.md), `src/server/images/`, `src/server/ai/`).

## 1. What we actually have today (the baseline the feedback describes)

- **Two image backends, selected by ad-hoc branching, no abstraction.** Flux via
  OpenRouter (`imageModel()` in `ai/provider.ts`, default `flux.2-pro`) for
  text-to-image; Venice/Qwen (`veniceEditImage` / `veniceGenerateImage` in
  `ai/venice.ts`) for single-reference edit and uncensored text-to-image. The
  scene renderer picks between them with inline `if` branches in
  `images/scene.ts:96-161`.
- **Single reference is a hard model limit, not a code choice.** `veniceEditImage`
  sends exactly one `image` (`ai/venice.ts:33`); the `/image/edit` shape takes one
  buffer. The feedback reads this correctly.
- **The forward seam already exists.** Scenes already record a typed
  `meta.references` list — `{ kind: "character" | "location", id, name }`
  (`contracts/images/scene-reference.ts`), populated in
  `scene.ts:172-205`. The contract docstring literally says it is "shaped for a
  future multi-reference image model." So the codebase _already anticipates_ this
  work; the feedback is pushing on a door we left open.
- **The intimate route is the product, not an edge case.** Per
  [../README.md](../../README.md), Vesper forks reverie specifically to make
  "uncensored imagery" first-class. That reframes the whole provider question (see
  §5).

## 2. Overall verdict on the feedback

Agree with the architecture: keep single-reference Venice/Qwen, add a
provider-capability layer, add a multi-reference path for SFW multi-character,
and treat self-hosted diffusion as the long-term home for the intimate core.
Agree the reference-sheet "paste portraits" idea is a brittle experiment, not a
production strategy.

Where my original take shifted under PM review:

- **The join table is being built now** (§4). I had argued YAGNI; the PM ruling is
  that app-wide metrics/queryability ("which scenes used this portrait /
  character / location") is worth the table up front. Decision recorded; building
  it.
- **FLUX.2 stays an SFW-only lane, not a candidate default multi-character
  renderer** (§5) — we have direct evidence in our own codebase that flux.2
  input-moderates nudity, and the intimate scene _is_ the core product. The PM
  greenlit a verification spike, scoped to SFW.
- **The feedback omits three invariants** our pipeline enforces — first-person
  POV, session-snapshot freeze, and degrade-never-fail resilience — that a
  multi-reference path can silently break (§8). The PM added concrete guidance on
  all three (POV prompt wording, why the freeze exists, retry policy).
- **The uploaded-avatar intimate guard is deferred** as a pre-production gate, not
  shipped now (§3) — there are no real users in dev.

## 3. The uploaded-avatar intimate guard (deferred — a hard pre-production gate)

**Deferred, not dropped.** We are pre-launch with no real users and no real
uploads, so the misuse path described here cannot fire today — there is zero
chance an uploaded real-person avatar reaches an intimate render in dev. So we
are **not** building the guard now. But this is a **launch blocker**: it must ship
**before the app accepts real user uploads in production**. The analysis below is
kept implementation-ready so it can drop in when that gate comes due.

**The claim is correct and precise.** `renderSceneImage` sets `allowIntimate:
true` for _any_ Venice reference, unconditionally:

```ts
// images/scene.ts:103-106
const prompt = buildSceneRenderPrompt(
  input.plan,
  useReference ? { referenceName: reference.name, allowIntimate: true } : {},
);
```

`allowIntimate` is the switch that injects exposure-gated explicit anatomy via
`intimateSceneAppearance` (`images/prompts.ts:672,677`). The reference avatar
comes from `findParticipantAvatar` → `session_participants.avatarImageId`
(`scene.ts:249-269`), and **that avatar can be an uploaded image** — uploads are
promoted to the canonical avatar (`images/upload.ts:81`) and snapshotted into the
participant at spawn (`engine/spawn.ts:366`). So once real users can upload, an
uploaded real-person face could become the identity anchor for an intimate
render — the non-consensual-intimate-imagery footgun the feedback names.

**The fix is small because the provenance data already exists** — uploads stamp
`meta.source: "upload"` (`upload.ts:54`). Minimal patch:

```ts
const allowIntimate = useReference && isSyntheticReference(reference.row);
```

When this is built, do it as a **default-deny**, not a denylist:

- Generated avatars carry `meta: { style, model, demo }` (`avatar.ts:60`) — **no
  `source` field at all.** Only uploads are tagged. So a denylist
  (`source === "upload"` → no intimate) works _today_ but is fragile: any future
  ingest path (a "composite", an imported entity image, a real photo used as a
  location ref) that forgets the tag silently re-opens the hole.
- The resilient choice — matching our own rules ([../resilience.md](../../resilience.md):
  degraded **defaults**; default-deny at trust boundaries) and the
  forward-compatible-schema preference — is to **stamp positive provenance on
  generation** (`source: "generated"` in `avatar.ts` and `variants.ts`) and gate
  on _that_: `allowIntimate` only when `meta.source === "generated"`. Unknown /
  missing / uploaded → deny. New paths are then safe-by-default.

**The guard is necessary but not sufficient.** Even with `allowIntimate: false`,
an uploaded real face is still sent to the _uncensored_ Venice/Qwen edit model
with `safe_mode` off (`venice.ts:34`). A suggestive pose/setting with no
explicit-anatomy text can still produce problematic output from a real likeness.
So "uploaded avatars are SFW-only" (which I endorse) means more than withholding
anatomy text. When the gate comes due, the chosen rule is:

- **Don't use uploaded references on the uncensored edit path at all** — if the
  only available reference is uploaded, render the scene text-to-image or skip the
  image. Clean invariant: "uncensored edit ⇒ synthetic reference only," owned in
  one place by the provider router (§4). _(Reconcile, 2026-06-19: the original
  "render text-to-image (Flux, which moderates)" no longer applies — Flux is gone.
  The replacement moderating backend is **Venice `safe_mode` on** as a per-request
  knob — `veniceGenerateImage` already reads `VENICE_SAFE_MODE`; see the plan's
  task 4.)_

**Centralize it.** When built, add `isSyntheticAvatar(row): boolean` next to the
asset helpers, used by both the scene render and the provider router, with a unit
test that an uploaded row is never synthetic and a generated row is. This is
exactly the "shared predicate" lesson [../images.md](../../character-chat/images.md) already records
for `intimateAttrRendersExposed` — don't let the rule diverge across call sites.

## 4. Provider-capability abstraction, multi-reference plumbing & the join table (build now)

Strongly agree, and it fits our conventions: registries/capability tables are the
extension point ([../../CLAUDE.md](../../../CLAUDE.md)), and provider SDK calls must
live in `src/server/ai` (the `@openrouter`-only boundary rule — Venice already
obeys it in `ai/venice.ts`). Concretely:

- A `ImageProviderCapabilities` table (the feedback's fields are good:
  `maxReferenceImages`, `supportsReferenceRoles`, `supportsLocationReference`,
  `supportsMask`, `supportsAdultFictionalNudity`,
  `supportsUploadedRealPeopleInNsfw: false`, `maxPromptChars`, `aspectRatios`,
  `policyMode`).
- A **router** that takes a `SceneRenderRequest` (references + content rating +
  frame composition) and selects a provider + a **fallback chain** (§8.3). The
  router's inputs already exist in the pipeline: character count
  (`plan.focal` + `plan.others`), exposure state (`exposedRegions` /
  `formatExposure`), reference provenance (§3), and location-reference
  availability. Routing is computable from data we already produce — low new
  plumbing.
- Extend the render input from "maybe one avatar" to a `SceneVisualReference[]`
  (`kind`, `imageId`, `role`, `characterName?`, `source`, `allowForIntimate`),
  as the feedback proposes. This is the natural superset of today's
  `SceneReference`.

**Decision: build the `image_references` join table now.** I had argued to defer
it (enrich the JSONB list first, add the table only when a reverse-query feature
exists). The PM ruling overrides that: we want to **track as many metrics as
possible across the app**, and "which scenes used this portrait / character /
location" is a query worth having available from day one. So:

- Add an `image_references` table (DB workflow per [../../CLAUDE.md](../../../CLAUDE.md):
  edit `schema.ts` → `pnpm db:generate` → review the SQL in `drizzle/` →
  `pnpm db:migrate`; never `drizzle-kit push`). Columns at least:
  `scene_image_id`, `kind` (`character` | `location` | `style` | `pose` |
  `layout`), `entity_id` (library character/location id, nullable for
  non-entity roles), `role`, `source` (`generated` | `uploaded` | `composite` |
  `entity`), `image_id` (the actual reference asset used). Written at render in
  `renderSceneImage` alongside the asset insert.
- Make the table the **queryable source of truth** for "what a scene featured."
  The Gallery filter ([../images.md](../../character-chat/images.md) §Gallery), today a client-side
  pass over `meta.references`, can move to a server-side query against the table —
  cleaner and it scales.
- Keep `source_image_id` on `images` for edit lineage (unchanged). The JSONB
  `meta.references` can stay as a denormalized render-time convenience or be
  dropped once the table is authoritative — decide during the build; don't keep
  two sources of truth diverging.

## 5. Onboarding additional NSFW image models — provider survey (2026-06-19)

**This section is rewritten under the 2026-06-19 pivot** (Flux removed; Qwen/Venice
the default — see the banner at the top). The old §5 chased Flux as an SFW
multi-character lane; that lane is gone with Flux. The question now is: which
**uncensored** models do we onboard to avoid being single-sourced on Qwen, and can
any *hosted* model give us **multi-reference + NSFW** (two identity anchors for
multi-character intimate scenes)? Findings are source-verified 2026-06-19; this
space moves fast — re-verify model ids/caps/pricing at integration.

### Headline: the multi-reference + NSFW gap IS fillable today

**Venice `POST /image/multi-edit` with `qwen-edit-uncensored` + `safe_mode:false`
takes an `images` array of 1–3 reference images** (schema `minItems:1`,
`maxItems:3`; first = base, rest = edit layers/refs). This is the **only hosted,
already-integrated, uncensored, multi-reference path that exists** — no new vendor,
no new policy risk. It revises the earlier assumption that self-hosted ComfyUI
(§7) was the *only* route to two-character NSFW: **it isn't.** ComfyUI becomes the
**upgrade path** for >3 references or premium multi-subject identity-locking, not
the only option. Caveats: the **3-image cap** is a Venice endpoint limit, and
identity-preservation quality across 2–3 *NSFW* refs is unproven — validate
empirically before relying on it for the core feature.

### Venice — preferred (already integrated)

The live API (`GET /models?type=image`, 2026-06-19) returns 30 image models;
image pricing is per-image USD.

- **Uncensored text-to-image, $0.01/img:** `lustify-v7` / `lustify-v8`
  (API-tagged `traits:["most_uncensored"]`), `lustify-sdxl`, `chroma`,
  `wai-Illustrious` (anime/Illustrious), `z-image-turbo` (fastest), `venice-sd35`.
  Plus `qwen-image` ($0.03), `qwen-image-2` ($0.05, our current default),
  `qwen-image-2-pro` ($0.10). The **lustify set is both cheaper and
  API-flagged most-uncensored** — strong additional t2i options at a fraction of
  qwen-image-2's cost.
- **NSFW posture:** per-request **`safe_mode` (default `true` → blurs adult
  output)**; send `safe_mode:false` for unblurred adult generation. Global hard
  limits (CSAM, minors, real-world violence) always apply.
- **Edit models:** `qwen-edit` *blocks* explicit content; **`qwen-edit-uncensored`**
  is the uncensored variant; the multi-edit enum also lists
  `qwen-image-2-edit`/`-pro-edit`. ⚠️ **We currently edit with `qwen-image-2-edit`**
  (`veniceEditModelId()`) — confirm it is fully uncensored with `safe_mode:false`,
  or switch the edit/scene path to **`qwen-edit-uncensored`**.
- **Onboard:** (a) the lustify t2i set as additional model options behind the
  model-pick seam; (b) `qwen-edit-uncensored` + `/image/multi-edit` as the
  multi-reference provider for multi-character scenes.

### Seedream (ByteDance) — REJECTED for NSFW

Named as a candidate; the answer is **no.** Seedream 4.0 is technically excellent
(unified t2i + edit, **multi-reference up to 10 images**, ~$0.03/img), but
ByteDance applies **three-layer server-side moderation** (prompt + input image +
output image) with explicit-NSFW a non-bypassable hard-block on **every host**
(fal, Replicate, BytePlus/Volcano, OpenRouter). fal's `enable_safety_checker:false`
is a fal-side post-filter toggle, **not** removal of ByteDance's generation-side
moderation. "Seedream 5 NSFW mode" claims trace only to third-party SEO/affiliate
blogs — disregard. **Usable only for strictly-SFW work; unfit for the core.**

### OpenRouter — no uncensored image model

Its image catalog (Gemini "Nano Banana", Flux/BFL, Seedream, GPT-image, Grok,
Recraft, …) routes entirely to **moderating upstreams**; OpenRouter's "uncensored"
listings are **text LLMs only**. So **OpenRouter leaves the image stack** (it
stays for text/LLM), as the pivot plans. *Correction to our prior note:* the
`@openrouter/ai-sdk-provider` `maxImagesPerCall:1` is an **output** cap (1
generated image per call); input/reference `files` are **not** SDK-capped — moot
here since no uncensored model exists, but relevant if OpenRouter is ever used for
SFW multi-ref edits.

### Other providers

- **Replicate — viable new provider.** Its Terms explicitly tolerate pornographic
  output (prohibiting only CSAM/NCII; 18+). Live, API-runnable **uncensored**
  checkpoints: `aisha-ai-official/wai-nsfw-illustrious-v11` (~$0.007),
  `cyber-realistic-pony-v8`, `flux.1dev-uncensored-msfluxnsfw-v3` (~$0.016),
  `delta-lock/noobai-xl` (~$0.008), and many more. **But these are
  text-to-image** — multi-ref + NSFW is unproven there (`OmniGen2` does multi-ref
  but isn't an uncensored fine-tune). Good **diversification / fallback** if Venice
  ever tightens; not a multi-ref answer.
- **fal / Together / getimg / BytePlus — moderate NSFW.** fal hosts the best
  multi-ref editors (Qwen-Edit-2509, Flux Kontext) but its AUP bans explicit
  content and a default classifier replaces flagged output with black images.
  Together/getimg/BytePlus similarly prohibit pornographic output.
- **Novita / Prodia / WaveSpeedAI — unconfirmed.** Permissive tech, ambiguous or
  contradictory ToS. Get the policy in writing (or a clean test result) before
  building on them.
- **RunPod — self-host only** (ComfyUI on uncensored weights): the only *uncapped*
  uncensored multi-character path — §7.

### Why Flux is out (record)

Flux/BFL **input-moderates nudity** (our own pipeline hit the `"Sexual Content"`
rejection — the reason `describeImageGenError` exists) and is expensive. That is
the basis for the 2026-06-19 removal. The earlier BFL-direct multi-ref finding —
`POST api.bfl.ai/v1/flux-2-pro-preview`, ≤8 refs, `x-key`, async submit→poll, but
**SFW-only** — is retained for the record but **no longer pursued**; the spike
(`scripts/spikes/flux-multiref.ts`) is dropped.

Sources (verified 2026-06-19): docs.venice.ai (image/generate · image/edit ·
image/multi-edit; live `/models?type=image`); fal.ai seedream v4 API + AUP;
docs.byteplus.com seedream; apiyi seedream moderation note; openrouter.ai image
collection + flux.2-pro page + `@openrouter/ai-sdk-provider` source; replicate.com
/terms + aisha-ai-official model pages.

## 6. Reference-sheet "Strategy B" — brittle, but one real niche (test greenlit)

I agree with every caution: the model gets a picture of a contact sheet, not
structured slots; it can copy the layout, blend identities, ignore the location
panel, or render the panels as objects. Labeled zones + "do not render as a
collage" help and will sometimes work — best for vibe / hair / body type /
wardrobe / location atmosphere, worst for exact faces and two-people-in-contact.

**Why it's still worth keeping:** it is the _only_ near-term option for
multi-character **intimate** scenes. The hosted multi-ref APIs are all SFW-walled
(§5), and self-hosted ComfyUI (§7) is months out. Today, intimate multi-character
= one Qwen identity anchor + textual others (already shipped, `scene.ts:103-106`
+ `buildSceneRenderPrompt`). The reference-sheet hack on the uncensored Qwen edit
model is the one cheap thing that could give a _second_ identity anchor before
ComfyUI exists.

**Greenlit test (PM):** build a quick test that sends **Qwen-Image a combined
reference-sheet image** (two character portraits + the location, or a scene
panel if the model handles that framing better) with a prompt to compose a
single coherent scene from them, then validate the returned quality. This is the
direct experiment for the hypothesis — run it before committing any
reference-sheet plumbing.

Implementation notes when it graduates: track `meta.copied_reference_sheet:
boolean` as a graded failure mode, and if the model reproduces the board frame,
crop it (we already own webp post-processing in `assets.ts`). It must still obey
the POV rule (§8.1) — the board is reference input, never the composition.

**Test result (2026-06-16) — the contact-sheet form is a dead end on
`qwen-image-2-edit`; "rough-composite-then-harmonize" is the viable replacement.**
Scripts: `scripts/eval/scene-images/refsheet-location-test.ts` (labeled board) +
`refsheet-variants.ts` (the two follow-ups); outputs in
`docs/scene-image-eval/refsheet/`. Single-character + location case:

- **Labeled board → copied verbatim.** A 2-panel board (CHARACTER / LOCATION,
  black label bars) came back as the *same board* — split layout, both label
  bars, panels intact — despite an explicit "do not reproduce the board/labels/
  collage" instruction. `copied_reference_sheet = true`. Venice `/image/edit` is
  an **edit** model: its job is to *preserve* the input, so it preserves the board.
- **Seamless board (no labels/bars) → partial.** Dropping the label bars stopped
  the verbatim copy, but the model still anchored to a **left/right split**
  (person on one side, location on the other) instead of merging them.
- **Composite-into-scene → worked.** Feathering a cutout of the character
  *directly onto the location* (one scene, no panels) and prompting "relight /
  blend the edges / fix scale so she is standing in the space" produced a single
  coherent photo: identity preserved, location as the setting, no border, no
  split. **This plays to the edit model's preserve-and-harmonize strength.**
- **Takeaway:** the stopgap is **not** a reference sheet — it's a
  **rough-composite + harmonize** pass. It generalizes to two characters (paste
  both feathered cutouts into the scene at their positions, then harmonize), and
  needs a **background-removal/segmentation** step for clean cutouts (sharp alone
  can't matte). This is the path worth plumbing if we want a pre-ComfyUI
  multi-subject stopgap. (The original two-portrait contact sheet was not retested
  — given the board-copy result it is very unlikely to beat the composite path.)
- **POV-wording artifact (feeds §8.1):** the prompt "the camera is the viewer's
  eyes" made the model render a **literal DSLR camera floating in the foreground**.
  The §8.1 reword must therefore avoid "camera" as a *depictable noun* — phrase it
  as "shot from the viewer's own eyes; none of the viewer's body is visible."

## 7. Self-hosted ComfyUI — the long-term home for the core (research greenlit)

Agree this is where a romance game with generated adults and occasional nudity
ends up: identity adapters per character (InstantID / IP-Adapter-style),
ControlNet/OpenPose or depth for composition, regional prompting for who-appears-
where, location reference for background, and a content policy we enforce at the
app layer instead of discovering through API rejections. It's a project (GPU
hosting, workflow management, output moderation), not a toggle — agreed.

**Greenlit research (PM):** determine which models are most useful for a
self-hosted ComfyUI **NSFW** scene pipeline (base checkpoints + identity adapters
+ ControlNet/regional tooling). Assume a **cloud-hosted GPU** target — local
resources are limited — so weight the choice toward what runs well on rented
cloud GPUs and what's licensable for this use.

**Research finding (2026-06-16) — recommended stack (verify at build time; this
space moves fast):**

- **Base checkpoint** — pick by lane:
  - **Chroma** (built on FLUX.1-schnell, fully uncensored/anatomical,
    schnell/Apache-friendly lineage, ~12 GB fp8 / 24 GB full) — strongest
    **photoreal NSFW** default with the cleanest commercial-license story.
  - **Qwen-Image-Edit-2511** (20B) — native **multi-person editing + identity
    preservation** without a separate adapter; the emerging shortcut for the
    two-character case (community NSFW variants exist).
  - **SDXL — Pony / Illustrious / NoobAI** lineage — lower VRAM (~8–16 GB) and the
    **most battle-tested regional + identity-adapter ecosystem**, stylized-leaning.
  - Caveat: **FLUX.1-dev base is non-commercial**; prefer Apache-lineage
    (Chroma/schnell, FLUX.2 *klein*) and get **licensing sign-off** — the biggest
    non-technical risk, alongside provider adult-content ToS.
- **Identity adapter (character consistency):** **InfiniteYou** (ByteDance, best
  ID lock on Flux, beats PuLID-FLUX/FLUX-IP-Adapter) → **PuLID-FLUX** (lighter) for
  Flux/Chroma; **InstantID + IP-Adapter-FaceID** for SDXL; Qwen-Edit's built-in
  identity for the Qwen lane.
- **Composition / "who appears where" (2 chars):** 2-person **OpenPose
  ControlNet** (+ depth) → **regional prompting** → **regional IP-Adapter attention
  masks** binding face-A↔left / face-B↔right. SDXL has the most mature regional
  stack today; Qwen-Edit-2511's native multi-person editing is the shortcut.
- **Cloud-GPU hosting (the "second deployable" worker):** **RunPod Serverless +
  Network Volume** (async `/run` → poll, scale-to-zero, cost leader ~$1.9–2.5/hr
  A100-class, ~30 s cold start) maps directly onto the queue/poll shape image
  jobs already use — and is exactly the GPU background worker that
  `monorepo-evaluation.md` parks the split behind. **Modal**
  if cold-start latency hurts UX (~2–5 s, pricier); Replicate/fal easiest but
  costliest; **confirm each provider's adult-content ToS first.**
- **End-to-end:** ComfyUI on RunPod Serverless → Chroma (or Qwen-Edit-2511) →
  InfiniteYou/InstantID identity → 2-person OpenPose ControlNet + regional
  IP-Adapter masks. This is the **uncapped** path for two-character NSFW
  compositing — the **upgrade** beyond Venice's hosted `/image/multi-edit` (§5),
  which already does ≤3 uncensored references but caps there and has unproven
  multi-NSFW-ref identity quality. Use ComfyUI for >3 refs / premium identity-lock;
  the hosted Flux/BFL APIs cannot do NSFW at all.
- Sources: InfiniteYou (github.com/bytedance/InfiniteYou, arxiv 2503.16418);
  Chroma & Flux-uncensored writeups (offlinecreator.com); Qwen-Image-Edit
  (github.com/QwenLM/Qwen-Image, qwenlm.github.io); RunPod Serverless ComfyUI
  (docs.runpod.io, github.com/runpod-workers/worker-comfyui).

Two codebase-specific hooks:

- **It slots in behind the provider abstraction (§4) as one more provider.** Build
  the capability layer first and ComfyUI is "register a provider with
  `maxReferenceImages: N, supportsAdultFictionalNudity: true,
  supportsReferenceRoles: true`," not a rewrite of `scene.ts`.
- **It is plausibly the trigger for the deferred monorepo split.** The
  `monorepo-evaluation.md` note parks the split behind
  "the first second deployable… most likely a background worker." A GPU
  ComfyUI/diffusion worker is exactly that second deployable — and the cloud-GPU
  target above makes it a separate service. Make the two decisions together.

## 8. Invariants the feedback omits (a multi-ref path must preserve these)

1. **First-person player POV is a hard rule.** Every scene is from the player's
   eyes; the player never appears and the player's appearance/wardrobe is never
   fed to the composer or render ([../images.md](../../character-chat/images.md), `SCENE_POV_RULE`).
   A multi-reference provider makes this _easier to break_ — you're now handing it
   2+ character refs + a location, and must guarantee the player's avatar is never
   among them. (It isn't today: refs come from present NPCs + location only,
   `scene.ts:112-115`. The new path must keep that.)
   - **Reword the POV prompt for image models when multi-ref testing starts.**
     `SCENE_POV_RULE` is phrased around the "player." Once we hand an image model
     multiple character references, it may not understand "player" and could
     mistake one of the provided character refs *for* the player and omit them
     from the frame. Reword toward viewer language the image model will act
     on — rather than "player." **But avoid "camera" as a noun:** the §6 test
     (2026-06-16) showed that "the camera is the viewer's eyes" made
     `qwen-image-2-edit` render a **literal DSLR camera floating in the frame**.
     Phrase it as "shot from the viewer's own eyes; none of the viewer's body —
     no hands, arms, or reflection — is visible," not "the camera viewpoint…".
     Test this wording change as part of the multi-ref spikes (§5/§6).
2. **Session-snapshot freeze.** Scene references read the participant's
   spawn-snapshot avatar (`findParticipantAvatar`, `session_participants.avatarImageId`),
   never the live library portrait — a deliberate fix for wrong-character scenes
   when a portrait changes mid-session (`scene.ts:240-269`). A multi-ref builder
   must resolve every character ref through the snapshot, not the library row.
   - **Why this matters beyond mid-session drift:** characters are shared
     publicly — built by one user, played by others. If an author updates a shared
     character's portrait, it must **not** retroactively change every other user's
     in-progress session that uses that character. The freeze is what protects
     that. A future opt-in "update this session to the latest portrait" feature is
     possible, but it must be explicit and per-session — never an implicit live
     pull.
3. **Degrade, never fail.** Per [../resilience.md](../../resilience.md), scene images
   are nice-to-have, not required — they must never disrupt the chat when they
   fail. The router must be a **fallback ladder** with a diagnostic per downgrade,
   mirroring the existing `images.scene_render.reference_fallback` info diag. Under
   the 2026-06-19 pivot the ladder is **all-Venice**: multi-ref edit
   (`/image/multi-edit`, ≤3 refs) → single-ref edit (`venice_edit`) → text-to-image
   (`venice_generate`, Qwen — was Flux) → (demo monogram). Each step `parseOr` at
   the trust boundary, diagnostics over exceptions.
   - **Retry policy (PM):** reduce avoidable failures with a bounded retry keyed
     on the failure reason. A **transient** error (connection/timeout) may retry
     once or twice; after repeated transient failures, log a potential
     service-outage diagnostic. An **outright content rejection** must **not**
     retry — it will only fail again — instead fall down the ladder (skip, or — for
     the §3 uploaded-avatar case only — a moderated render via Venice `safe_mode`).
     The reason classification can reuse `describeImageGenError`'s recovered
     upstream message.

## 9. Eval harness (agree — with a caveat on what's automatable)

Agree completely, and it matches our testing ethos (degradation tests assert
fallback **and** diagnostic code). Caveat: image identity/quality is
**human-scored**, so this is a fixtures + manual-scoring harness, not a `pnpm
test` gate. Concretely:

- ~20 fixed scenes spanning the routing matrix: one character; two clothed; two
  partially clothed; three characters; character+location; location-only; and a
  few high-risk wardrobe/exposure cases. Park them next to the existing
  `scripts/fixtures/` (harbor-house) seed data.
- Save per run: every input reference, provider, prompt, seed/settings, output,
  and manual scores for identity-A, identity-B, location match, clothing
  accuracy, exposure accuracy, and collage contamination.
- **A safety row that becomes live when the §3 guard ships:** "did an
  uploaded/real-face reference ever reach an uncensored or intimate render?" must
  score zero. This row is the acceptance test for the pre-production gate.
- Later you _can_ semi-automate identity scoring (face-embedding distance ref↔output)
  and collage detection, but manual first — don't block on tooling.

## 10. Sequenced work

The authoritative, current task list + status lives in
[scene-images.plan.md](scene-images.plan.md) — maintain it there, not here (this
section is a pointer so the two don't diverge). As of the 2026-06-19 pivot:

- **Done:** the provider-capability layer + multi-reference plumbing + the
  `image_references` join table (§4, shipped 2026-06-16); the Qwen reference-sheet
  test (§6); the ComfyUI NSFW model research (§7); the additional-NSFW-model survey
  (§5).
- **To implement:** remove Flux / make Qwen the default (the pivot); onboard the
  surveyed models — Venice `/image/multi-edit` (multi-ref + NSFW) + the lustify t2i
  set (§5).
- **Deferred / long-term:** the uploaded-avatar intimate guard (§3, a
  pre-production gate); self-hosted ComfyUI (§7, the uncapped multi-character
  upgrade).
- **Dropped:** the Flux-on-OpenRouter / BFL multi-image spike (superseded by the
  Flux removal — §5).

## 11. Filing

- This doc is `scene-images.spec.md` — the design/decision truth. The task list,
  status, and build order are in [scene-images.plan.md](scene-images.plan.md).
- The §3 guard stays tracked here as a pre-production gate (deferred while in
  dev). When the app nears accepting real user uploads, lift it into the plan's
  active work / a fix PR and check the §9 safety row.
- When §4 ships (it's "build now"), update [../images.md](../../character-chat/images.md) +
  [../database.md](../../database.md) for the join table in the same change, per the
  doc-update convention.
