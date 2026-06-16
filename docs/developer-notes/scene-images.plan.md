# Scene images — multi-reference & provider plan

Status: **active** (started 2026-06-16) — graduated from the
[deferred.plan.md](deferred.plan.md) parking lot after the PM review.

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

### 1. Provider layer + multi-reference plumbing + join table  — _build now_

The seam everything else slots into (spec §4). No change to default render
behavior yet.

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

### 2. Flux-on-OpenRouter multi-image spike — _greenlit_

SFW-scoped (spec §5). Web-verify the OpenRouter Flux image API fields for
multi-image reference support; **if supported**, a throwaway test script sending
**two** reference images, validating what comes back (does it composite both
identities or drop one?). If OpenRouter doesn't expose it, evaluate a BFL-direct
provider (`ai/bfl.ts`). Do **not** make Flux a new default — the intimate core
stays on Venice/Qwen.

### 3. Qwen-Image reference-sheet test — _greenlit_

The direct test of "Strategy B" (spec §6): send Qwen-Image (Venice) a combined
reference-sheet image (two character portraits + the location/scene panel) with a
compose prompt, validate output quality and identity binding. Decides whether the
reference-sheet path is worth real plumbing as the intimate multi-character
stopgap. Track `meta.copied_reference_sheet` and crop the board frame if echoed.

### 4. ComfyUI NSFW model research — _greenlit_

Determine the best models for a self-hosted ComfyUI intimate pipeline (base
checkpoints + identity adapters + ControlNet/regional tooling), targeting a
**cloud-hosted GPU** (local resources limited). Co-decide with the monorepo-split
trigger (spec §7; [monorepo-evaluation.md](monorepo-evaluation.md)).

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

- **Flux multi-image reachability** (task 2): exposed via OpenRouter, or
  BFL-direct only? Resolved by the spike.
- **Reference-sheet viability** (task 3): does Qwen bind two identities from a
  contact sheet well enough to ship as the intimate stopgap, or is it eval-only
  noise? Resolved by the test.
- **JSONB vs table source of truth** (task 1): once `image_references` is
  authoritative, do we drop `meta.references` or keep it as a denormalized
  render-time convenience? Decide during the build; don't keep two diverging.

## Eval harness

Fixture-driven, human-scored (spec §9) — not a `pnpm test` gate. ~20 fixed scenes
across the routing matrix, saving inputs/provider/prompt/output + manual scores
(identity-A/B, location, clothing, exposure, collage contamination) and the
safety row for task 5.
