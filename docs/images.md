# Images

`src/server/images/` — full image suite: avatar generation, Venice reference editing (identity-locked portrait variants), and in-session scene images. All assets are rows in the `images` table with files under `data/` — one registry, one serving route, one lifecycle. (The old app had three parallel ad-hoc systems; don't recreate that.)

## Asset registry

- File path: `data/images/<ownerId>/<imageId>.webp` (always webp; converted on save). The `images` row carries `kind`, entity linkage, `prompt`, `source_image_id` (edit lineage), `status` (`pending`/`ready`/`failed`), `meta` (model, dimensions, timings).
- **Row before file**: insert the row as `pending` → write `<imageId>.pending.webp` → fsync → rename → update row to `ready`. Every file on disk is always explained by a row; a crash leaves a `pending`/`failed` row, never a mystery file.
- Serving: `GET /api/images/:id/file` (immutable cache headers — content never changes for an id).
- Deleting an entity nulls its `image_id` references and queues file deletion. An idempotent `image_sweep` job (on-demand + periodic) reconciles rows↔files both directions, logging orphans as warnings.
- Failed generations show a "regenerate" affordance (same prompt + parameters re-queued); `scene_image` jobs are idempotent per (session, turn, prompt).

## Pipelines

### Avatar generation (text → image)
Prompt built from the character's resolved attributes via registry `promptHints` (the registry is the single source of phrasing) + style (`realistic`/`stylized`) + bio excerpt + the **default outfit** (item names + sensory appearance, marked authoritative — without it the image model invents clothing that contradicts the saved wardrobe; an outfit lookup failure degrades to the attributes-only prompt with a warn diagnostic, `images.avatar.outfit_load_failed`). The outfit is **occlusion-filtered** first (`visibleAvatarOutfit`, same `resolveWardrobeVisibility` rule as scene images): layers fully hidden under opaque outer layers are omitted — mentioning the t-shirt under a closed abaya makes the model paint the abaya open — sheer-covered items become a vague hint, and coverage-less items (jewelry) stay. OpenRouter `IMAGE_MODEL` (default flux.2-pro), aspect 3:4. Runs as an `avatar` job; the UI polls the image row status.

### Portrait variants (reference edit, Venice)
Pose / outfit / expression / setting variants of the canonical avatar via Venice `VENICE_IMAGE_EDIT_MODEL` (default `qwen-edit-uncensored`): single reference image + instruction, prefixed with the **identity lock** block (preserve face, hair, age, build — port the old `PORTRAIT_IDENTITY_LOCK` wording). Variants accumulate in the character's portrait studio; any variant can be promoted to canonical avatar. Venice constraint: single-reference edit only — re-roll from the canonical portrait rather than chaining edits (drift compounds).

### Scene images (in-session)
Trigger: every N turns (`session.scene.interval`, 0 = off), or when the director flags `imageMoment.worthIt`, or manually.

**Player POV (hard rule)**: every scene image is composed from the player's eyes — first-person POV. The player never appears (no body, no face, no hands), and the player's appearance/wardrobe is never fed to the composer or the render prompt. Both prompts restate the rule verbatim (`SCENE_POV_RULE`).

Pipeline (a `scene_image` job):
1. **Scene composer** (`TOOL_MODEL`, `generateChecked`): its candidate subject pool is **every NPC co-located with the player** — camera location from session state via `activeLocationId`, never from prose — so an NPC in another room can never reach the composer (`buildSceneComposerContext` in `engine/pipeline.ts`). Each present NPC arrives with activity/posture and an **occlusion-filtered** wardrobe (`resolveWardrobeVisibility`, same rule as avatars: hidden layers omitted entirely, sheer-covered items at most a vague hint, coverage-less items kept). The composer also gets the location description/ambient, the session clock's daylight band for lighting, the director's scene summary, and the **last 2 turns' narration** (budgeted excerpts, newest largest). It designates ONE focal character from the pool — or none: an empty room composes a **location-only POV shot**, a legitimate output, not an error — plus which other present NPCs are in frame. The output is clamped server-side (`resolveScenePlan`): a focal name not in the room is replaced by a present NPC (`images.scene_composer.focal_clamped`), invented "others" are dropped (`images.scene_composer.absent_character_dropped`), and every character's outfit phrase is forced from wardrobe state — prose lies.
2. **Render**: Venice is single-reference edit only, so one identity anchor. Focal character has a ready avatar → identity-locked Venice edit with the other featured characters described textually (appearance summary + state-forced outfit + action); focal has no avatar → the first plan-featured other present NPC with a ready avatar becomes the reference (`images.scene_render.reference_fallback`, info) and the focal is described textually; no usable avatar, or no characters at all → OpenRouter text-to-image.
3. Result attaches to the session gallery (`images.session_id`). `/sessions/:id/status` reports the gen state plus `sceneGen.latestImageId` and `sceneGen.gallery` (ready scene images, pre-restart included, capped at 24) — the gallery is DB-backed, so an in-flight render survives page refreshes and resurfaces there when it completes. The status route also self-heals an orphaned `generating` state (no live `scene_image` job → `failed`) so a dead runner never leaves a forever-spinner.

Failures mark the job + image row `failed` with the error; the session is never blocked by image work.

## Demo mode

No keys → SVG monogram placeholder (deterministic gradient from the entity name) saved through the same registry path, flagged `meta.demo: true`. Every pipeline is exercisable in CI.

## Adding a pipeline

New generation kind = new `images.kind` value + a job type + a builder in `server/images/`. Use `generateChecked` for any prompt-composition step and the atomic-write helper for files. Update this doc.
