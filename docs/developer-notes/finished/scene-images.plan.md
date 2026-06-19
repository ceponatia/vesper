# Scene images — multi-reference & provider plan

Status: **shipped — 2026-06-19** (moved to `finished/`). The whole build arc
shipped; the two never-built long-term items (the uploaded-avatar pre-production
guard and self-hosted ComfyUI) **parked to [deferred.plan.md](../deferred.plan.md)**.
Task 1 (provider seam + multi-ref plumbing + `image_references` join table)
**shipped 2026-06-16**. The Qwen reference-sheet and ComfyUI research spikes are
**done** (results below / in the spec). **Task 2 (drop Flux, Qwen the default
everywhere) + Task 3 (onboard Venice `/image/multi-edit` + the lustify t2i set)
shipped 2026-06-19**, with the multi-reference path wired in as a **per-session
toggle** (single-character ↔ multi-reference) on the Scene tab. The
Flux-on-OpenRouter / BFL multi-image spike was **dropped** (superseded by the Flux
removal).

> **Completion note (2026-06-19).** Flux/OpenRouter is gone from the image stack:
> every lane is Venice/Qwen (`server/ai/venice.ts`). The render ladder is now
> `venice_multi_edit` (mode `multi`, ≤3 refs) → `venice_edit` (single anchor) →
> `venice_generate` (Qwen t2i) → demo monogram. The portrait studio's model picker
> became a Venice t2i model set (qwen default + lustify/chroma/illustrious/turbo,
> `contracts/images/image-models.ts`); avatar generation is now unconditionally
> uncensored (exposure-gating unchanged). Item/location images moved to Venice
> t2i. The session toggle lives on `SceneGenState.referenceMode` and is set via
> `POST /api/sessions/:id/scene {action:"setReferenceMode"}`. **Leftover:**
> multi-NSFW-ref identity quality is unvalidated (spec §5 open follow-up) — the
> code degrades to single-edit when <2 reference images exist, so the toggle never
> blocks a render, but the two-character identity-lock quality needs a real render
> pass to judge. The §6 multi-pass idea (below) is the next lever if it disappoints.

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

> **Reconciled (2026-06-19):** the original shipped ladder ended in the
> `flux_openrouter` text-to-image rung. Task 2 swapped that rung for
> `venice_generate` (Qwen t2i) and task 3 added `venice_multi_edit` on top — the
> seam itself is unchanged.

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

### Done (the 2026-06-19 pivot)

#### 2. Remove Flux; make Qwen the default — _shipped 2026-06-19_

Flux is out and everything routes through Venice/Qwen. **Shipped:**

- `server/ai/image-providers.ts` — `flux_openrouter` + `renderFluxText` dropped;
  `venice_generate` (Qwen t2i) is the new last AI rung and `venice_multi_edit`
  (task 3) the new top rung. The `prefer: "flux"|"qwen"` model-family pick became
  a `mode: "single"|"multi"` reference-mode pick (`SceneRenderRequest.mode`).
- `server/ai/provider.ts` — `imageModel()` / `imageModelId()` / `MODEL_DEFAULTS.image*`
  removed; OpenRouter is text-only now.
- `server/images/{avatar,entity,scene,character-scene}.ts` — avatar + entity
  images render via `veniceGenerateImage`; the scene ladder + prompts re-based on
  Venice; the chat scene picker's Flux option removed (it's single-reference).
- `AvatarImageModel` became the extensible Venice t2i set
  (`contracts/images/image-models.ts`): `qwen` (default) + `lustify` / `chroma` /
  `illustrious` / `turbo`, resolved to model ids by `veniceT2IModelId`. The
  portrait-studio + avatar route default to `qwen`.
- Avatar generation passes `allowIntimate` unconditionally (every route is the
  sole uncensored one now); exposure-gating inside `buildAvatarPrompt` is unchanged.
- Tests rewritten (`image-providers.test.ts` routing, `scene.test.ts` chain ids,
  `prompts.test.ts` route labels + new multi-ref cases); `scripts/spikes/flux-multiref.ts`
  deleted; the intimate-categories + images.md Flux passages reconciled.

The retained build-order notes below are the historical touch-point list.

<details><summary>Original touch points (for the record)</summary>

The provider seam (task 1) made this a registry + router edit, not a `scene.ts`
rewrite. Touch points (from the codebase sweep):

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
> `AvatarImageModel` / reference-mode unions extensible (forward-compatible
> schema preference), with Qwen the default.

</details>

#### 3. Onboard additional NSFW-capable image models — _shipped 2026-06-19_

Onboarded the surveyed Venice models so we're not single-sourced on one model and
to fill the multi-reference + NSFW gap. **Shipped:**

- **Multi-reference + NSFW path:** `veniceMultiEditImage` (`POST /image/multi-edit`,
  `modelId: qwen-edit-uncensored` via `veniceMultiEditModelId`, `safe_mode` off,
  1–3 reference images) backs the new `venice_multi_edit` provider. Wired in as a
  **per-session toggle** (`SceneGenState.referenceMode` `single`|`multi`) on the
  Scene tab — `multi` sends every present character's avatar + the location image
  (capped at 3, characters prioritised), `single` keeps the one-anchor edit.
  Degrades to single-edit when <2 reference images exist. **API field gotcha
  confirmed at integration:** multi-edit takes **`modelId`** (not `model`) and
  **`output_format`** (not `format`); the single `/image/edit` endpoint still
  takes `model`/`format` (don't touch those). First image = base canvas.
- **Cheaper/more-uncensored Venice t2i onboarded** as portrait-studio model
  options (`contracts/images/image-models.ts` → `veniceT2IModelId`): `lustify`
  (`lustify-v8`, API-flagged most-uncensored, ~$0.01/img), `chroma` (photoreal),
  `illustrious` (`wai-Illustrious`, anime), `turbo` (`z-image-turbo`, fastest),
  alongside the default `qwen`. A wrong/retired id degrades to a failed row, so
  onboarding another is a one-line edit in the resolver.
- **Seedream — rejected** (ByteDance hard-moderates NSFW; spec §5). **OpenRouter**
  left the image stack. **Replicate** stays a viable future diversification
  provider (t2i only) — not onboarded now.

**Open follow-up (carried):** multi-NSFW-ref identity quality is unvalidated.
⚠️ also still open: confirm the single-edit `qwen-image-2-edit` is fully
uncensored at `safe_mode:false` or switch it to `qwen-edit-uncensored` (the
multi-edit path already uses the uncensored variant; both are env-overridable —
`VENICE_IMAGE_EDIT_MODEL` / `VENICE_MULTI_EDIT_MODEL`).

> **Future lever — multi-pass scene compositing for >2 characters + a location.**
> Venice `/image/multi-edit` caps at 3 references, so a scene with 3+ characters
> plus a location image can't fit everyone in one call (today the location is
> dropped first, then overflow characters fall to textual description). A future
> upgrade: render in **passes** — send 2 characters + the location to the model
> for a first composite, then **loop that output back in** as the new base image
> together with the remaining character(s), using a **different instruction that
> describes the task better** ("add this person to the existing scene, preserving
> everyone already present" rather than "compose these references together").
> Each pass stays within the 3-ref cap while accreting subjects. This is the
> hosted-API analogue of the §6 composite-then-harmonize finding and a cheaper
> stepping stone than jumping straight to self-hosted ComfyUI (task 5) for the
> 3+-character case. Validate the 2-character single-pass quality first — if it's
> good, the multi-pass extension is worth building; if not, ComfyUI is the path.

Onboarding mechanics (for the next model): each = a new `IMAGE_PROVIDERS` entry +
router clause + (for a new vendor) a provider module mirroring `venice.ts`
(never-throws / diagnostic shape, inside the `src/server/ai` boundary), exposed
through the model-pick seam. Venice additions need **no new module** — just a new
model id in `veniceT2IModelId` (t2i) or a new endpoint call (like multi-edit).

### Deferred / long-term — _parked to [deferred.plan.md](../deferred.plan.md) (2026-06-19)_

The two never-built long-term items left this plan when it shipped and now live in
the parking lot under "Scene image: multi-reference & provider strategy":

- **Uploaded-avatar intimate guard** — a hard pre-production gate (default-deny on
  generated provenance; uploaded references off the uncensored path). Full design
  in [scene-images.spec.md](scene-images.spec.md) §3.
- **Self-hosted ComfyUI** — the uncapped multi-character-NSFW upgrade beyond
  Venice's hosted `/image/multi-edit` (>3 refs / premium identity-lock). Stack +
  hosting in [scene-images.spec.md](scene-images.spec.md) §7; ties to the
  monorepo "second deployable" trigger.

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
  (`venice_multi_edit` → `venice_edit` → `venice_generate` → demo monogram) with a
  diagnostic per downgrade and the reason-keyed retry policy (spec §8.3). The
  multi-reference toggle never blocks a render either — `multi` degrades to the
  single ladder when fewer than two reference images are available.

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
  ≤3 refs**, now shipped behind the session toggle (spec §5). Self-hosted ComfyUI
  is the *uncapped* upgrade, not the only path. **Open follow-up (carried):**
  empirically validate identity quality across 2–3 NSFW refs — the code degrades
  to single-edit when <2 images exist, so the toggle never blocks, but the
  two-character lock quality is unjudged. If it disappoints, the **multi-pass**
  idea in task 3 is the next lever before ComfyUI.
- **Which Venice edit model for the uncensored path** (carried) — confirm the
  single-edit `qwen-image-2-edit` (current `VENICE_IMAGE_EDIT_MODEL` default) is
  uncensored at `safe_mode:false`, or switch it to `qwen-edit-uncensored`. The
  multi-edit path already defaults to `qwen-edit-uncensored`; both are
  env-overridable.
- **Does any moderated render backend remain after Flux** — needed only by the §3
  guard. Tentative answer: Venice `safe_mode` on (no separate provider needed —
  `veniceGenerateImage` already honors `VENICE_SAFE_MODE`, per-request knob is a
  small add). Confirm when the guard comes due.

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
