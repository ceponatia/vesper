# Chat scene fidelity — outfit tracking, location sketches, identity anchors

Status: shipped — 2026-07-10 (all three slices, same day as planned. Leftovers live in
§Future ideas below — none promoted; the sketch agent's live behavior awaits owner review
on the Fly deploy, alongside the outfit-tracking archivist field on real conversations.)

The chat scene image (and the narrator's scene context) should reflect what the
fiction has actually established — not the character page's defaults and a placeholder
room. Owner request 2026-07-10 (conversation, following the Fly screenshot review in
[narrator-prompt-consolidation.followups.md](narrator-prompt-consolidation.followups.md)).
Three slices, all riding existing machinery (archivist post-turn extraction, chat scene
memory, the detached job queue, the scene composer/render pipeline) — no new lanes.

## Why now / what's wrong

- **Outfit**: `character_chat_state.outfit` (free text + `exposed` toggle) already
  drives both the narrator's "You're wearing…" line and the scene image's
  `outfitDescription` override (`character-scene.ts` deliberately ignores
  `profile.defaultOutfit`). But nothing ever *updates* it after the scenario modal —
  a character who dresses for a date, wakes to a new day, or undresses in an intimate
  scene keeps rendering in the Starting Outfit (or, when that's blank, whatever the
  composer infers — usually the avatar reference's character-page outfit).
- **Location**: `queueChatScene` never passes `room`, so every chat scene renders in
  `DEFAULT_CHAT_ROOM` ("a warm, softly lit room…") even when scene memory has
  established "the kitchen — blue-tiled counter". The accumulated place details never
  reach the image, and time of day is hardcoded to `"day"`.
- **Identity**: the render prompt identity-locks the reference avatar
  (`PORTRAIT_IDENTITY_LOCK`) but describes the *reference* character with no appearance
  text at all (only textual, non-referenced characters get `appearance`) — so renders
  drift slightly on identity-critical features (lip fullness, skin tone).

## Slice 1 — conversation-driven outfit tracking + seed fallback

- **Archivist field 7** (`contracts/turns/chat-archivist.ts` + `prompts/chat-archivist.ts`):
  `"outfit": { "description", "exposed" }`, emitted ONLY when the exchange changed what
  the character wears (dressed, changed, removed clothing — partly or fully). The
  description is a **full replacement** (the complete current look, not a delta), capped
  at `CHAT_OUTFIT_MAX_CHARS`; `exposed` = intimate areas bared. Empty description ⇒ no
  change (the schema's `.catch/.default` makes `{}` the no-op, matching the `scene`
  proposal's lenient shape).
- **Fold-in** (`finalizeChatState`): a non-empty proposal patches `outfit`/`outfitExposed`
  in the guarded save, beside the `attributeOverlays`/`sceneMemory` merges. Degraded
  archivist ⇒ prior values kept. "Another take" rollback already covers it via the
  pre-exchange snapshot.
- **Seed fallback** (`seedChatState`): `outfit` seeds from `profile.defaultOutfit`
  (joined free text) instead of `""` — the owner ruling: Starting Outfit wins when
  written; blank falls back to the character form's outfit, persisted on the first
  state write. The scenario modal shows the seeded text and stays authoritative when
  the author edits it (an explicit save of an emptied field is respected — the author
  chose composer-inference).
- **Image side**: nothing to change — `queueChatScene` already feeds `state.outfit` /
  `outfitExposed` into the render, marked authoritative over the reference avatar's
  clothing.

## Slice 2 — location: scene memory → image, + background sketch agent

2a (deterministic wiring, no new model calls):

- `queueChatScene` derives `room` from the chat state's scene memory current place —
  `sketch` (slice 2b) → else `name — details` — and passes it plus
  `sceneMemory.timeOfDay` to `renderCharacterSceneImage` (new `timeOfDay` input,
  default `"day"` as today). Empty memory keeps `DEFAULT_CHAT_ROOM`.

2b (the sketch agent — owner-described design):

- **Storage**: `ScenePlace.sketch?: string` (cap `SCENE_SKETCH_MAX_CHARS` = 600) on the
  scene-memory jsonb — forward-compatible, no migration.
- **Trigger**: post-turn in `finalizeChatState`, after `mergeSceneMemory`: when the
  merged current place has no sketch, enqueue a detached `chat_scene_sketch` job
  (dedupe: skip when one is already queued/running for the chat — the
  `enqueueChatSummary` shape). Runs in the background; never delays the reply.
- **Agent** (`prompts/chat-scene-sketch.ts`, pure + snapshot-tested; runner in
  `chat-scene-sketch.ts` mirroring `runChatArchivist`'s resilience recipe — agent
  model, timeout, `generateChecked`, degrade-to-diagnostic): input is the place name,
  its established details/connections, time of day, the scenario premise, and the
  recent narration; output `{ "sketch": string }` — 2–4 sentences of concrete visual
  description (layout, light, palette, a few fixtures) that **incorporates every
  established detail and invents only compatible texture**; no people, no events.
- **Write-back**: reload the state row, re-find the place by name, set `sketch` only
  if still absent, save under the per-chat keyed lock. A lost update (an exchange
  racing the write) is self-healing: the trigger re-fires next exchange while the
  sketch is absent. "Another take" rolling back a sketch likewise just re-triggers.
- **Consumption**: the image `room` prefers `sketch` (2a); the narrator's Scene block
  gains a `- Setting sketch: …` reference line (never-recite discipline — the block
  already forbids re-describing).

## Slice 3 — identity anchors in the render prompt

- `identityAnchorSummary()` (`images/prompts.ts`): a short phrase from a whitelist of
  identity-critical attributes — `skin.tone`, `skin.undertone`, `lips.fullness`,
  `lips.shape`, `eyes.color`, `eyes.shape`, `hair.color`, `hair.length`, `hair.style`,
  `face.shape`, `face.freckles` — capped small so the Venice 1500-char budget holds.
- Threaded as `ScenePresentCharacter.identityAnchors` → `SceneCharacterSpec` →
  emitted **only for the identity-locked reference character** right after
  `PORTRAIT_IDENTITY_LOCK`, worded subordinate to the image: *"Same person as the
  reference image — these features confirm it (the reference is authoritative where
  they differ): …"*. Owner constraint: the fields strengthen the lock, never override
  the reference. Wired in both `buildCharacterSceneContext` (chat) and
  `buildSceneComposerContext` (session), and in both the single-reference and
  multi-reference assemble paths.

## Future ideas (not this plan)

- Place `connections` as composition depth cues ("a doorway to the kitchen behind her").
- Sketch regeneration when a place's details grow substantially after the sketch.
- Weather / season as a scene-memory field feeding lighting.
- A `outfitChanged` line in the memory-trace inspector readout.
- Same-turn outfit detection (a deterministic pre-prompt regex like
  `detectSceneMovement`) if the one-exchange lag on archivist-tracked changes annoys.

## Open questions

(none — owner design conversation 2026-07-10 settled scope)
