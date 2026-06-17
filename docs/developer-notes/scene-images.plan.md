# Scene images — multi-reference & provider plan

Status: **active** (started 2026-06-16) — graduated from the
[deferred.plan.md](deferred.plan.md) parking lot after the PM review. **Task 1
(the provider seam + multi-ref plumbing + `image_references` join table) shipped
2026-06-16**; the Flux/Qwen spikes have scripts ready and await a live run + human
scoring (keys); the ComfyUI research is recorded in spec §7; the §3 guard stays a
deferred pre-production gate.

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
`/image/edit`, one buffer) to a **provider-capability architecture** that can
route a scene to the right backend by its needs (character count, exposure,
reference provenance, location reference), with a queryable record of what each
scene featured. The intimate route stays the product core; hosted multi-ref APIs
serve the SFW lane only; self-hosted ComfyUI is the long-term home for the
uncensored core (spec §5–§7).

## Build order

### 1. Provider layer + multi-reference plumbing + join table  — _shipped 2026-06-16_

The seam everything else slots into (spec §4). Happy-path render output is
unchanged; the new value is the queryable table, the fallback ladder, and the
reason-keyed retry. **Shipped:** `IMAGE_PROVIDERS` capability registry + router
(`server/ai/image-providers.ts`, a typed code registry — not a DB table),
`SceneVisualReference[]` render input + `SceneReference` Gallery DTO
(`contracts/images/scene-reference.ts`), the `image_references` join table
(migration `0004`, FK-cascade) written at render by `recordImageReferences`, the
reason-keyed retry/fallback executor (`executeSceneChain`), the Gallery now
sourcing refs server-side from the table, a one-time backfill
(`scripts/backfill-image-references.ts`), and the docs. `meta.references` is
dropped (see Open questions, resolved).

- `ImageProviderCapabilities` table + a **router** that selects a provider and a
  fallback chain from a `SceneRenderRequest`. Provider SDK calls stay inside
  `src/server/ai` (the `@openrouter`-only boundary; new providers mirror
  `ai/venice.ts`).
- Extend the render input to `SceneVisualReference[]` (`kind`, `imageId`, `role`,
  `characterName?`, `source`, `allowForIntimate`) — the superset of today's
  `SceneReference`.
- **`image_references` join table** (DB workflow per `CLAUDE.md`: `schema.ts` →
  `pnpm db:generate` → review `drizzle/` SQL → `pnpm db:migrate`). Written at
  render in `renderSceneImage`; becomes the queryable source of truth for "what a
  scene featured." Migrate the Gallery filter to query it server-side.
- Implement the **fallback ladder** with a diagnostic per downgrade and the
  reason-keyed retry policy (transient → retry once/twice; content rejection →
  no retry, fall down the ladder), spec §8.3.
- Docs: update [../images.md](../images.md) + [../database.md](../database.md) in
  the same change.

### 2. Flux-on-OpenRouter multi-image spike — _web-research done; script ready; live run pending keys_

SFW-scoped (spec §5). **Resolved (2026-06-16):** the OpenRouter image API via the
Vercel AI SDK `imageModel` caps `maxImagesPerCall` at **1** — our path can't send
two refs. Multi-image Flux lives only in the **BFL direct API**
(`flux-2-pro-preview`, ≤8 refs, async poll, `x-key`), and it's **SFW-only**
(input-moderates nudity). The throwaway spike `scripts/spikes/flux-multiref.ts`
hits BFL directly with two refs (raw fetch); run it with `BFL_API_KEY` set and
score whether it composites both identities. Graduate to a real `ai/bfl.ts`
provider only if SFW two-character output is good — never a new default; the
intimate core stays on Venice/Qwen.

### 3. Qwen-Image reference-sheet test — _done 2026-06-16: contact sheet fails; composite-then-harmonize works_

The direct test of "Strategy B" (spec §6). **Result:** `qwen-image-2-edit` copies
a labeled board verbatim (it's an edit model — it preserves the input); a
label-free board still splits left/right. **What works** is rough-compositing the
subject *into* the scene (feathered cutout on the location) and asking the model
to relight/blend/fix-scale — a true single scene, identity preserved. So the
pre-ComfyUI multi-subject stopgap to plumb is **composite-then-harmonize** (needs
a background-removal step), not a reference sheet. Also surfaced the §8.1
POV-wording bug ("camera" → a literal camera rendered in frame). Scripts:
`scripts/spikes/qwen-reference-sheet.ts` (the original 2-portrait board) +
`scripts/eval/scene-images/refsheet-location-test.ts` / `refsheet-variants.ts`;
outputs in `docs/scene-image-eval/refsheet/`.

### 4. ComfyUI NSFW model research — _done (findings in spec §7)_

**Done (2026-06-16):** recommended stack recorded in spec §7 — base **Chroma**
(photoreal, Apache-friendly) or **Qwen-Image-Edit-2511** (native multi-person);
identity **InfiniteYou**/PuLID-FLUX (Flux) or InstantID+IP-Adapter-FaceID (SDXL);
composition 2-person OpenPose ControlNet + regional IP-Adapter masks; hosting
**RunPod Serverless + Network Volume** (the GPU background worker that triggers the
monorepo split — [monorepo-evaluation.md](monorepo-evaluation.md)). Gating risks
are model licensing + provider adult-content ToS, not the tech.

### 5. Uploaded-avatar intimate guard — _deferred: hard pre-production gate_

**Not built now** — dev has no real users / no real uploads, so the misuse path
has zero chance of firing (spec §3). **Must ship before the app accepts real user
uploads in production.** Default-deny on `source: "generated"` provenance (stamp
it on generation) + keep uploaded references off the uncensored edit path. The §9
eval "safety row" is its acceptance test.

## Cross-cutting invariants (must survive the rework — spec §8)

- **First-person POV** — the viewer never appears; the player's avatar is never a
  reference. Reword `SCENE_POV_RULE` toward camera/viewer language (not "player")
  when multi-ref testing starts, so the image model doesn't mistake a character
  ref for the player and drop them.
- **Session-snapshot freeze** — resolve every character ref through the
  participant snapshot, never the live library portrait (shared/public characters
  must not retroactively change other users' in-progress sessions).
- **Degrade, never fail** — scene images are nice-to-have; a render failure never
  blocks the chat.

## Open questions

- ~~**Flux multi-image reachability** (task 2)~~ — **resolved (2026-06-16):**
  BFL-direct only (the OpenRouter AI-SDK path caps at 1 ref) and SFW-only. See
  spec §5.
- ~~**Reference-sheet viability** (task 3)~~ — **resolved (2026-06-16):** the
  contact-sheet form is a **dead end** on `qwen-image-2-edit` — a labeled board
  comes back copied verbatim (it's an *edit* model; it preserves the board), and a
  label-free board still anchors to a left/right split. **What works instead:**
  **rough-composite the subject(s) into the scene + "harmonize"** — feathering a
  cutout onto the location and asking the edit model to relight/blend/fix-scale
  produced a true single scene with identity preserved (spec §6). The pre-ComfyUI
  multi-subject stopgap to plumb is therefore composite-then-harmonize (needs a
  background-removal step), **not** a reference sheet. Scripts:
  `scripts/eval/scene-images/refsheet-location-test.ts` + `refsheet-variants.ts`;
  outputs in `docs/scene-image-eval/refsheet/`.
- ~~**JSONB vs table source of truth** (task 1)~~ — **resolved (2026-06-16):**
  the `image_references` table is authoritative and `meta.references` is
  **dropped** (no longer written; the Gallery reads the table; a one-time
  backfill copied existing scenes over). Single source of truth — no two
  diverging records.

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
