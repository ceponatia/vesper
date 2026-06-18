# Character chat — sessionless 1-on-1 plan

Status: **finished/superseded** (resumed 2026-06-17) — server layer (prompt, stream harness,
sessionless scene render, `character_chat_messages` table + migration `0005`)
was already in place; this pass wired the **route → client → UI** vertical, the
manual scene button, and the Gallery surfacing. Remaining: live smoke test with
a real `OPENROUTER_API_KEY`, and the deferred items below.

This plan uses the topic-named convention (`<topic>.plan.md`) — no `phase-N`.

## Goal

Let an author talk to a saved library character **directly**, with no world and
no game session — a focused way to feel out and tune how faithfully the narrator
voices a character's personality from its saved attributes. Deliberately
isolated from the session engine: **no** turns, episodes, facts, RAG, presence,
wardrobe state, meters, or exposure. A flat message window is the model's only
memory.

It is the cheapest possible loop for the real product question — _does this
character read as themselves?_ — and a natural home for a quick scene image.

## Shape (what's built)

- **Prompt** — `engine/prompts/character-chat.ts` · `buildCharacterChatSystemPrompt`.
  Pure, snapshot-tested. Reuses the _same_ representation the in-game narrator
  gets — resolved attribute values via the registry + deduped `promptHints` as
  phrasing guidance — gated by the realized body (`realizeBody`) so a stale
  attribute (e.g. wings after a species change) never leaks. Drops all session
  machinery. Carries the in-character + `[Name] "…"` dialogue-tag rules.
- **Stream harness** — `engine/character-chat.ts` · `streamCharacterChat`.
  Mirrors `pipeline.liveNarrativeStream` (`streamText` + `openrouter().chat()`
  via the `../ai` barrel, `NARRATIVE_TEMPERATURE`), windowed to
  `CHARACTER_CHAT_HISTORY_TURNS` (40) exchanges. Demo mode yields a deterministic
  in-character placeholder so the tab + tests work with no provider key.
- **Persistence** — `character_chat_messages` (`schema.ts`, migration
  `0005_clean_old_lace.sql`): `{ ownerId, characterId→cascade, role, content,
createdAt }`. The route owns the transcript; clearing deletes rows but leaves
  generated scene images.
- **API** — `api/characters/[id]/chat/route.ts`:
  - `GET` → transcript (oldest-first, capped 500).
  - `POST {content, model?}` → append the user line, then **stream the reply as
    a plain-text token stream**; the full reply is persisted when the stream
    settles. The generator is drained server-side even on client disconnect
    (mirrors `sse.streamTurnEvents`), so the transcript stays whole.
  - `DELETE` → clear the conversation.
  - `api/characters/[id]/chat/scene/route.ts`: `POST` queues a sessionless
    `scene_image` job (`renderCharacterSceneImage`, no session id, centred on the
    last 6 assistant lines); `GET` lists the chat's scenes for polling.
- **Scene render** — `images/character-scene.ts` · `renderCharacterSceneImage`.
  Same two-step pipeline as the in-session scene (compose spec → render with the
  avatar as identity anchor through `scene.renderResolvedScene`), but the single
  subject is the library character and a default room stands in for the place.
  Filed against the character (`kind:"scene"`, `entityKind:"character"`, **no**
  `sessionId`).
- **Client** — `lib/client/api.ts`: `charactersApi.chatTranscript / clearChat /
chatScenes / generateChatScene`, plus `sendCharacterChat()` — a plain-text
  stream consumer (`onChunk` per delta, never throws).
- **UI** — `components/characters/character-chat.tsx`, a **Chat** tab in the
  character editor (saved characters only, like the portrait studio). Transcript
  with avatar bubbles, streaming composer (Enter to send), Clear-chat confirm,
  and a manual **Generate scene** button with a polling scene strip + lightbox.
  - **Model pickers.** A **narrator** `<Select>` over the curated
    `NARRATIVE_MODELS` (lib/narrative-models.ts), passed as `model` on each send;
    and a scene **image-model** `<Select>` (Flux / Qwen-uncensored, the portrait
    studio's `avatarImageModels` + `avatarImageModelLabels`), passed as `model`
    on Generate. The image pick defaults to **Qwen (uncensored)** — it preserves
    the Venice/Qwen-first ladder this tab rendered before the picker existed.
  - **In-progress feedback.** The scene row doesn't exist until the (slow)
    composer step finishes, so the strip shows an **immediate labeled placeholder
    tile** (`PendingSceneTile`, "Painting…") the instant Generate is clicked
    (`showComposing = generating && !hasPendingRow`); the pending DB row's own
    labeled tile takes over once it lands, then ready/failed. A failed render
    keeps its error card (danger-bordered).
- **Gallery** — `/api/gallery` now unions sessionless `entityKind:"character"`
  scenes after the session scenes; `gallery-page.tsx` groups them under a
  **"Character chats"** section. The portrait studio's history excludes
  `kind:"scene"` so chat scenes don't pollute it.

## Decisions

- **Plain-text stream, not SSE.** The reply is just text; a plain `text/plain`
  stream avoids a second event schema. Errors degrade to a short reply / toast
  rather than an error frame — consistent with the app's degradation philosophy.
- **Persist-on-settle, best-effort across disconnect.** Generation _is_ the
  stream here (unlike the turn pipeline, where the engine task is detached before
  the SSE). On a mid-stream client disconnect the server keeps draining and
  persists, but if the platform kills the handler the partial reply is lost — the
  user simply re-sends. Acceptable for a dev-stage authoring tool.
- **Scene images reuse the `scene_image` job type** (no new enum value); the job
  carries `characterId` and no `sessionId`.

## Open questions / deferred

- **Narrator-model picker.** _Resolved (2026-06-17)._ The Chat tab now exposes a
  curated `NARRATIVE_MODELS` select wired into each send; the scene **Generate**
  control gained a Flux/Qwen image-model select threaded server-side
  (`renderCharacterSceneImage` → `renderResolvedScene` → `routeSceneProviders`'s
  `prefer`, docs/images.md). Both are local component state (the tab is
  sessionless — no per-character persistence today).
- **Auto scene every N turns.** Considered; shipped manual-only (cheapest,
  user-controlled). Revisit if the manual button feels too fiddly.
- **Uploaded-avatar intimate guard.** `renderCharacterSceneImage` sets
  `allowForIntimate: true` on the character ref; it inherits the scene-images
  spec §3 deferred guard when that lands.
