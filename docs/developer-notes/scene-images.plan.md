# Scene images — multi-reference & provider plan

Status: **active** — Task 1 (provider seam + multi-ref plumbing + `image_references`
join table) **shipped 2026-06-16**. The Qwen reference-sheet and ComfyUI research
spikes are **done** (results below / in the spec). **New direction
(2026-06-19): drop Flux entirely and make Qwen (Venice) the default everywhere**,
then onboard additional NSFW-capable image models — folded in from
[scene-images.notes.md](scene-images.notes.md). The Flux-on-OpenRouter / BFL
multi-image spike is **dropped** (superseded by the Flux removal); the §3
uploaded-avatar guard stays a deferred pre-production gate.

This is the **task list and build order**. The design, the decisions, and the
codebase-grounded rationale live in the spec —
[scene-images.spec.md](scene-images.spec.md) — which is the truth; this plan is
how we execute it. Read the spec first.

> **Naming note.** This plan uses the topic-named convention (`<topic>.plan.md` /
> `<topic>.spec.md`), not the old `phase-N` numbering — see
> [deferred.plan.md](deferred.plan.md) §"Plan docs: drop hard phase numbers" for
> the convention and why we switched.

## Goal

Move scene image rendering from a single hard-coded reference (Venice/Qwen
`/image/edit`, one buffer) to a **provider-capability architecture** that routes a
scene to the right backend by its needs (character count, exposure, reference
provenance, location reference), with a queryable record of what each scene
featured. The intimate route is the product core; **Venice/Qwen is the default for
every lane** (the Flux SFW lane is being removed — see *Current direction*).
Self-hosted ComfyUI is the long-term home for multi-character uncensored
compositing (spec §7).

## Current direction (2026-06-19) — drop Flux, Qwen everywhere

Folded in from [scene-images.notes.md](scene-images.notes.md):

1. **Remove Flux from the app.** Flux (OpenRouter `flux.2-pro`) input-moderates
   nudity — useless for the uncensored core — and is expensive. With it gone,
   **OpenRouter leaves the image stack entirely** (it stays for text/LLM work);
   image generation is **Venice/Qwen end-to-end**.
2. **Qwen becomes the default model** everywhere Flux was. The end-to-end flow is:
   generate the character portrait with **Qwen-Image-2 text-to-image**
   (`veniceGenerateImage`), then **edit/compose the scene with Qwen-Image-2-Edit**
   (`veniceEditImage`) anchored on that existing portrait. The no-reference /
   location-only fallback rung becomes **Qwen text-to-image** (was Flux), so the
   render ladder is all-Venice.
3. **Onboard additional NSFW-capable image models** (preferring Venice/OpenRouter,
   open to others). The high-value gap is a *multi-reference + NSFW* model (two
   identity anchors for multi-character intimate scenes) — Flux's multi-ref was
   SFW-only and never served this. **Surveyed 2026-06-19** (task 3 + spec §5):
   Seedream was evaluated and **rejected** (ByteDance moderates NSFW); the gap is
   instead filled by **Venice `/image/multi-edit`** (≤3 uncensored refs).

This pivot supersedes the old "Flux = SFW lane" framing in the spec (§5, §8.3,
§10, and §7's "only path" claim) — those sections have been reconciled to match;
§1 still describes the current code baseline (Flux is removed by task 2, not yet).

## Build order & status

### Done

#### 1. Provider layer + multi-reference plumbing + join table — _shipped 2026-06-16_

The seam everything else slots into (spec §4). Happy-path render output is
unchanged; the new value is the queryable table, the fallback ladder, and the
reason-keyed retry. **Shipped:**

- `IMAGE_PROVIDERS` capability registry + router
  (`server/ai/image-providers.ts`, a typed code registry — not a DB table).
- `SceneVisualReference[]` render input + `SceneReference` Gallery DTO
  (`contracts/images/scene-reference.ts`) — `kind`, `imageId`, `role`,
  `characterName?`, `source`, `allowForIntimate`.
- The `image_references` join table (migration `0004`, FK-cascade) written at
  render by `recordImageReferences`; the Gallery now sources refs server-side from
  it. A one-time backfill (`scripts/backfill-image-references.ts`) copied existing
  scenes over. `meta.references` is dropped (single source of truth).
- The reason-keyed retry / fallback executor (`executeSceneChain`): transient →
  retry once on the same provider; content rejection → no retry, fall down the
  ladder. Per-downgrade diagnostic.
- Docs updated: [../images.md](../images.md) + [../database.md](../database.md).

> **Reconcile with the Flux removal:** the shipped ladder ends in the
> `flux_openrouter` text-to-image rung. The Flux-removal task below swaps that
> rung for a `venice_generate` (Qwen t2i) rung — the seam itself is unchanged.

#### Qwen-Image reference-sheet test — _done 2026-06-16: contact sheet fails; composite-then-harmonize works_

The direct test of "Strategy B" (spec §6). **Result:** `qwen-image-2-edit` copies
a labeled board verbatim (it's an *edit* model — it preserves the input); a
label-free board still splits left/right. **What works** is rough-compositing the
subject *into* the scene (feathered cutout on the location) and asking the model
to relight/blend/fix-scale — a true single scene, identity preserved. So the
pre-ComfyUI multi-subject stopgap to plumb is **composite-then-harmonize** (needs
a background-removal step), not a reference sheet. Also surfaced the §8.1
POV-wording bug ("camera" → a literal camera rendered in frame). Scripts:
`scripts/spikes/qwen-reference-sheet.ts` + `scripts/eval/scene-images/refsheet-location-test.ts`
/ `refsheet-variants.ts`; outputs in `docs/scene-image-eval/refsheet/`.

> **Likely superseded by task 3.** The composite-then-harmonize stopgap existed
> because no uncensored multi-reference API was available. Venice `/image/multi-edit`
> (≤3 refs, uncensored — spec §5) now is, so prefer sending the location + subject
> cutouts as real reference layers over a single-ref composite hack. Keep the
> POV-wording finding regardless.

#### ComfyUI NSFW model research — _done 2026-06-16 (findings in spec §7)_

Recommended stack recorded in spec §7 — base **Chroma** (photoreal,
Apache-friendly) or **Qwen-Image-Edit-2511** (native multi-person); identity
**InfiniteYou**/PuLID-FLUX (Flux) or InstantID+IP-Adapter-FaceID (SDXL);
composition 2-person OpenPose ControlNet + regional IP-Adapter masks; hosting
**RunPod Serverless + Network Volume** (the GPU background worker that triggers the
monorepo split — [monorepo-evaluation.md](monorepo-evaluation.md)). Gating risks
are model licensing + provider adult-content ToS, not the tech.

### To implement

#### 2. Remove Flux; make Qwen the default — _new (2026-06-19)_

Rip Flux out and route everything through Venice/Qwen. The provider seam (task 1)
already makes this a registry + router edit, not a `scene.ts` rewrite. Touch
points (from a codebase sweep):

- **`server/ai/image-providers.ts`** — drop the `flux_openrouter` provider id,
  caps, and `renderFluxText`. Add a **`venice_generate`** provider backed by
  `veniceGenerateImage` (Qwen-Image-2 t2i, `policyMode: "uncensored"`,
  `maxReferenceImages: 0`). New ladder: `venice_edit` → `venice_generate` → `demo`.
- **`routeSceneProviders` / `SceneImageModel`** — remove the `prefer: "flux"`
  branch (there is no moderated-only path anymore). Keep the model-pick seam but
  re-base it on Qwen + future-onboarded models (task 3), not Flux/Qwen.
- **`server/images/entity.ts`** ⚠️ **don't miss this** — item & location images
  currently render **text-to-image via the OpenRouter Flux helper** (`imageModel()`
  / `imageModelId()`). They're SFW (product/establishing shots) but the backend is
  going away, so they must migrate to **Venice/Qwen t2i** (`veniceGenerateImage`,
  `safe_mode` may be on here) or they break when OpenRouter leaves the image stack.
- **`server/ai/provider.ts`** — remove `MODEL_DEFAULTS.image`/`imageFast`,
  `imageModelId`, and the `imageModel()` OpenRouter image helper **only after** its
  callers (`entity.ts`, `avatar.ts`, `scene.ts`) are migrated to Venice. OpenRouter
  stays for text only.
- **`server/images/scene.ts` / `character-scene.ts`** — drop the
  `?? "flux_openrouter"` primary default, the `imageModelId()` label fallback, and
  the `imageModel === "flux"` skip-anchor branch; the chat scene picker loses its
  Flux option.
- **`server/images/avatar.ts`** — `AvatarImageModel` no longer includes `"flux"`;
  default flips `"flux"` → `"qwen"`; drop the `imageModel()` / `imageModelId()`
  Flux generate + label branches. The `allowIntimate`-false-for-Flux gating becomes
  unconditional on the (now sole) uncensored route.
- **API + client + UI** — `app/api/characters/[id]/avatar/route.ts` and
  `.../chat/scene/route.ts` enums default to `qwen` and drop `flux`;
  `lib/client/api.ts` `avatarImageModels` + labels; `components/characters/portrait-studio.tsx`
  model toggle (remove the Flux option / default to Qwen).
- **Tests** — `image-providers.test.ts`, `scene.test.ts`, `prompts.test.ts` lose
  their Flux assertions; rewrite the t2i-rung cases against `venice_generate`. The
  `errors.test.ts` BFL-Flux-moderation case can be deleted (or repurposed if any
  upstream still surfaces moderation as a parse error).
- **Cleanup** — delete `scripts/spikes/flux-multiref.ts`; update the Flux mentions
  in `contracts/attributes/categories/intimate/index.ts` (comment) and
  [../images.md](../images.md) (the "Model switch", fallback-ladder, and
  "moderation surfaces as a parse error" passages).

> **Keep the model-selection seam.** Don't collapse the model-pick infrastructure
> to a single hard-coded model — task 3 onboards more models behind it. Make the
> `AvatarImageModel` / `SceneImageModel` unions extensible (forward-compatible
> schema preference), with Qwen the default.

#### 3. Onboard additional NSFW-capable image models — _research done 2026-06-19 (spec §5); onboarding to implement_

Find and onboard more uncensored image models so we're not single-sourced on Qwen,
and to chase the multi-reference + NSFW gap. Full survey + sources in **spec §5**.
Headline outcomes:

- **The multi-reference + NSFW gap is fillable today, on Venice** — `POST
  /image/multi-edit` with **`qwen-edit-uncensored`** + `safe_mode:false` takes
  **1–3 reference images** in one call. Already-integrated provider; this is the
  recommended onboarding and it means **ComfyUI is no longer the *only*
  multi-character-NSFW path** (it's the uncapped upgrade, task 5). Cap = 3 refs;
  multi-NSFW-ref identity quality is **unproven — test before depending on it.**
- **Onboard cheaper/more-uncensored Venice t2i:** `lustify-v7`/`lustify-v8`
  (API-tagged `most_uncensored`, **$0.01/img** vs qwen-image-2's $0.05), plus
  `chroma` / `wai-Illustrious` / `z-image-turbo` for style + speed diversity.
- ⚠️ **Verify our current edit model:** we edit with `qwen-image-2-edit` — confirm
  it's fully uncensored at `safe_mode:false`, or switch to `qwen-edit-uncensored`.
- **Seedream — rejected.** ByteDance hard-moderates NSFW at generation on every
  host; not viable for the core (spec §5).
- **OpenRouter — no uncensored image model;** it exits the image stack (per task 2).
- **Replicate — viable *new* provider** (Terms tolerate adult output; Pony /
  Illustrious / NoobAI / uncensored-Flux checkpoints) as diversification/fallback,
  but its uncensored models are t2i only — not a multi-ref answer.

Onboarding mechanics: each model = a new `IMAGE_PROVIDERS` entry + router clause +
(for a new vendor) a provider module mirroring `venice.ts` (never-throws /
diagnostic shape, inside the `src/server/ai` boundary), exposed through the
model-pick seam from task 2. Venice additions need **no new module** — just a
`/image/multi-edit` call + new model ids.

### Deferred / long-term

#### 4. Uploaded-avatar intimate guard — _deferred: hard pre-production gate_

**Not built now** — dev has no real users / no real uploads, so the misuse path
has zero chance of firing (spec §3). **Must ship before the app accepts real user
uploads in production.** Default-deny on `source: "generated"` provenance (stamp
it on generation) + keep uploaded references off the uncensored edit path. The §9
eval "safety row" is its acceptance test.

> **Flux-removal consequence:** the guard's old "if the only reference is uploaded,
> render moderated text-to-image (Flux) or skip" no longer has a moderating
> backend — Flux was it. Replacement: render uploaded-only refs through **Venice
> text-to-image with `safe_mode` forced on** (Venice already has the `safe_mode`
> knob; make it per-request), or **skip the image**. Never route an uploaded real
> likeness to the uncensored path.

#### 5. Self-hosted ComfyUI — _research done (spec §7); the uncapped long-term upgrade_

The **uncapped** path for multi-character **NSFW** compositing — the upgrade beyond
Venice's hosted `/image/multi-edit` (task 3, ≤3 refs). Pursue it when we need >3
references or premium multi-subject identity-locking; until then, Venice multi-edit
covers the two-character case. Slots in behind the provider seam as one more
provider; it's the second deployable that plausibly triggers the
[monorepo-evaluation.md](monorepo-evaluation.md) split — decide the two together.
Stack + hosting recommendation in spec §7.

### Dropped / superseded

#### Flux-on-OpenRouter / BFL multi-image spike — _dropped 2026-06-19 (Flux being removed)_

Was: web-verify Flux multi-image fields, then a two-reference BFL-direct test
(`scripts/spikes/flux-multiref.ts`). **Superseded** — the only reason to pursue it
was an SFW multi-character lane, and Flux is being removed wholesale. The
multi-reference + NSFW need is now chased through the task-3 model survey (hosted)
and task-5 ComfyUI (self-hosted). The 2026-06-16 finding still holds and is worth
keeping for the record: OpenRouter's AI-SDK image path caps `maxImagesPerCall` at
1; multi-image Flux lived only in the BFL direct API and was **SFW-only** (it
input-moderates nudity) — which is exactly why Flux is being dropped (spec §5).

## Cross-cutting invariants (must survive the rework — spec §8)

- **First-person POV** — the viewer never appears; the player's avatar is never a
  reference. Phrase `SCENE_POV_RULE` as "shot from the viewer's own eyes; none of
  the viewer's body is visible" — **avoid "camera" as a noun** (the §6 test made
  the model render a literal DSLR camera in frame).
- **Session-snapshot freeze** — resolve every character ref through the
  participant snapshot, never the live library portrait (shared/public characters
  must not retroactively change other users' in-progress sessions).
- **Degrade, never fail** — scene images are nice-to-have; a render failure never
  blocks the chat. The all-Venice ladder still degrades step-by-step
  (`venice_edit` → `venice_generate` → demo monogram) with a diagnostic per
  downgrade and the reason-keyed retry policy (spec §8.3).

## Open questions

- ~~**Flux multi-image reachability** (old task 2)~~ — **moot (2026-06-19):** Flux
  is being removed. (For the record: BFL-direct only, SFW-only — spec §5.)
- ~~**Reference-sheet viability** (reference-sheet test)~~ — **resolved
  (2026-06-16):** the contact-sheet form is a dead end on `qwen-image-2-edit` (a
  labeled board comes back copied verbatim; a label-free board still splits
  left/right). **What works:** rough-composite the subject(s) into the scene +
  "harmonize" — needs a background-removal step. That's the pre-ComfyUI
  multi-subject stopgap, not a reference sheet (spec §6).
- ~~**JSONB vs table source of truth** (task 1)~~ — **resolved (2026-06-16):** the
  `image_references` table is authoritative; `meta.references` dropped; Gallery
  reads the table; a one-time backfill copied existing scenes over.
- ~~**Does any hosted model deliver multi-reference + NSFW** (task 3)~~ —
  **resolved (2026-06-19): yes — Venice `/image/multi-edit` + `qwen-edit-uncensored`,
  ≤3 refs** (spec §5). Self-hosted ComfyUI is the *uncapped* upgrade, not the only
  path. Open follow-up: empirically validate identity quality across 2–3 NSFW refs.
- **Which Venice edit model for the uncensored path** — confirm `qwen-image-2-edit`
  (current) is uncensored at `safe_mode:false`, or switch to `qwen-edit-uncensored`
  (spec §5).
- **Does any moderated render backend remain after Flux** — needed only by the §3
  guard. Tentative answer: Venice `safe_mode` on (no separate provider needed).
  Confirm when the guard comes due.

## Eval harness

Fixture-driven, human-scored (spec §9) — not a `pnpm test` gate. **Built:**
`scripts/eval/scene-images/` — `fixtures.ts` (the routing matrix: one character;
two clothed; two partial; three characters; character+location; location-only;
high-risk exposure; an uploaded-anchor safety case) + `run.ts` (emits
`manifest.json` with each fixture's routing decision + prompts, and a `scores.csv`
template with the manual-score columns — identity-A/B, location, clothing,
exposure, collage contamination — and the §3 `safety_uploaded_reached_uncensored`
row pre-marked `MUST_BE_NO`). Producing + scoring the real renders is the manual
step (keys + eyes); see `scripts/eval/scene-images/README.md`.
