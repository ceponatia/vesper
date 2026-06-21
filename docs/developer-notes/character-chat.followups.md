# Character chat — post-ship fixes

Status: **shipped — 2026-06-20**. Fixes to the sessionless 1-on-1 chat
([finished/character-chat.plan.md](finished/character-chat.plan.md)); topic slug
`character-chat`.

## 1. Mature-content refusals + "I'm Claude" (the same root cause)

**Symptom.** A chat that wrote mature content fine one day started refusing it
the next, in a borrowed assistant voice ("I need to stop this roleplay here… I'm
Claude, created by Anthropic, helpful/harmless/honest"). OpenRouter logs
confirmed the selected open models (GLM 5.2, DeepSeek 4 Flash) were the ones hit
— there is **no Anthropic model anywhere in the app** (the gateway is
OpenRouter-only; every id in `lib/narrative-models.ts` / `lib/agent-models.ts` is
non-Anthropic).

**Why "Claude".** The open narrators are trained on large amounts of
Claude/GPT-generated synthetic data, so they (a) frequently *self-identify* as
Claude and (b) inherit Claude/GPT-style **refusal phrasing**. Self-reported
model identity is not evidence of the actual endpoint — the routing logs are.

**Why the refusal.** The session turn engine licenses explicit content
*implicitly* — via the world's style/content directives plus the per-turn
exposure permissions ("intimate detail is permitted", `prompts/narrative.ts`).
The **sessionless chat carries neither**, so a safety-aligned (or
safety-distilled) model had no license and fell back to its trained refusal.

**Why it *stayed* broken.** The flat window is the model's only memory. Once one
refusal is persisted, every later turn shows the model *its own* prior refusal,
which **primes more refusals** — a single unlucky roll poisons the whole
transcript and it never recovers on its own.

**Fix.** `prompts/character-chat.ts` now states the frame explicitly: a
`CONTENT_FRAMING` block (this is adult interactive fiction; romance/intimacy/
explicit content is in scope) plus a `CHAT_RULES` clause forbidding breaking
character to refuse/deflect/moralize — a "no" must be played as the character's
own in-world choice. It only licenses *use* of what the character already has;
intimate anatomy is still gated per character by `realizeBody`, so nothing is
invented. Snapshot-tested in `prompts/character-chat.test.ts`.

## 2. Per-message edit + delete (transcript recovery)

The only prior lever was the whole-conversation `DELETE` (nuke everything) — no
way to clean a single poisoned line. Added:

- **Route** `api/characters/[id]/chat/[messageId]/route.ts` — `PATCH` overwrites
  one message's text in place, `DELETE` removes a single message. Both scoped by
  `ownerId + characterId` (a miss is a 404, never a silent no-op). Sits beside
  the static `chat/scene` segment (static wins; no dynamic-slug conflict).
- **Client** `charactersApi.editChatMessage` / `deleteChatMessage`
  (`lib/client/api.ts`).
- **UI** `components/characters/character-chat.tsx` — hovering a persisted line
  reveals Edit / Delete (edit = inline text-only overwrite; delete = single
  row). Optimistic/streaming/`tmp-` lines expose no actions (no server row yet);
  a successful send now re-fetches the transcript to swap temp-ids for persisted
  ids, so a just-received refusal is immediately editable/deletable.
- **Tests** `chat.int.test.ts` covers PATCH-in-place, single-row DELETE, and
  cross-owner 404.

Design calls (user): delete removes **just that one message** (not a rewind or
paired-delete); edit is **text-only** for **any** message (no regenerate).

## 3. Clear/delete storage hardening (2026-06-21)

A security pass confirmed the three mutations are genuine hard removals (no
soft-delete column, no versioning, no RAG/embedding copy, no content logging —
`character_chat_messages` is overwritten/deleted in place at the SQL layer). Two
gaps were closed:

- **Mid-stream resurrection race.** `POST` persists the assistant reply when the
  stream settles (even after a client disconnect — docs/resilience.md §5), but
  that write wasn't guarded. A clear (`DELETE /chat`) or single-message delete
  landing while the reply was still draining would delete the current rows, then
  the in-flight stream would insert a fresh assistant row into the "cleared"
  conversation. Fix: the user line's id is minted up front (`newId()`), and the
  reply is persisted via an atomic `INSERT … SELECT … WHERE EXISTS (the prompting
  row)` — `persistAssistantReply` in `chat/route.ts`. If the prompt row is gone,
  the write no-ops. (`id` is a JS-side cuid2 `$defaultFn` with no DB default, so
  the raw insert supplies it explicitly.)
- **Chat context surviving in `images.prompt`.** Scene images survive a clear by
  design, but their prompt embeds recent chat lines
  (`renderCharacterSceneImage → recentNarration`), so a cleared conversation
  still showed old context in the gallery enlarge view. Fix: the conversation
  `DELETE` now also resets `images.prompt = ""` for the character's chat scenes
  (`kind="scene"`, `entityKind="character"`). The asset stays; only its derived
  prompt is blanked.

Tests: `chat.int.test.ts` covers the guard (reply persists when the prompt row
exists, drops when it was cleared) and the prompt scrub on clear.

Out of scope (noted, not changed): Postgres hard deletes leave dead tuples until
VACUUM and live on in WAL/backups — the guarantee is logical erasure at the app
layer, not a forensic/secure wipe.

## Still open

- The fuller **exposure/intimacy tiering** for chat (honour the same per-sense
  mask sessions use) remains the light-state work in
  [character-chat-state.plan.md](character-chat-state.plan.md) — sessionless chat
  has no arousal/wardrobe state to gate on yet, so this fix is a static license,
  not a tiered one.
