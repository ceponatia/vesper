# Character chat — light state (plan)

Status: **shipped — 2026-06-24** (slices 1 + 3 + 4). Slices 1 (state row + drift +
prompt surfacing + UI) and 3 (the reaction pulse) shipped first: the
`character_chat_state` table + migration `drizzle/0013`, `engine/chat-state.ts`
(seed/load/drift/pulse/save), the `playerRelationship` profile field + Chat-tab
editor, the per-chat premise, the prompt `state` + scenario blocks, `GET …/chat/state`,
the three reset scopes, and the premise bar + status strip + stage toast. **Slice 4**
then added the texture (**arousal-from-intimate-acts**, **action chips** — offer a
drink → intoxication↑ etc., **light conditions** wired through drift/prompt/modal) and
the test-bed affordances (a **state-tools modal** for all owners — inspect/edit
affinity/meters/conditions/mindNote/premise + the read-only last-turn debug trace —
generalized `PATCH …/chat/state` + a `POST …/chat/state {action}`, and the
**Prompt Character** opening beat via `POST …/chat {open:true}`). The one deferred
piece is the **state-aware chat scene image** → [deferred.plan.md](deferred.plan.md).
The mechanics are fixed in [character-chat-state.spec.md](character-chat-state.spec.md).
Grow the sessionless 1-on-1 chat
([finished/character-chat.plan.md](finished/character-chat.plan.md)) from a
stateless transcript into a **light, fun, state-aware** quick chat that reuses
the contracts (meters incl. **hygiene**, affinity, conditions) without dragging
in the full session engine.

Topic slug `character-chat-state` (grep `character-chat` finds this, the spec, and
the finished plan together).

## What changed since the brainstorm (current reality)

- **The embodied player shipped.** The brainstorm's "address someone named, not a
  faceless _the user_" half graduated to
  [player-character.plan.md](player-character.plan.md) and **shipped 2026-06-23**:
  `resolvePlayerPersona` is the single resolver, threaded through the chat route
  and `buildCharacterChatSystemPrompt` (`player` block). The chat now greets the
  player by name. **Build-order step 2 is done** — this plan no longer touches the
  player persona; it _consumes_ the resolved name as the affinity/mindNote subject.
- **The rolling summary shipped** ([character-chat-summary.plan.md](character-chat-summary.plan.md)):
  `character_chat_summaries` + a watermark already carry factual continuity past
  the 40-message window. The `mindNote` here is its **complement** (current
  mood/disposition, not a factual recap), a sibling row for now; converging them
  into one `character_chat_state` row is a noted later consolidation.
- What's left for this plan is purely the **light-state engine**: a small state
  row, a free time-drift spine, and one optional reaction pulse.

## Why it's worth doing

The chat is "becoming quite fun as a 1-on-1 quick chat" but is **stateless**: a
flat `character_chat_messages` log, the lightweight `streamCharacterChat` path,
no meters / conditions / affinity. Light state makes the same chat feel **alive**
for near-zero cost and realises the deferred **relationship & meter timeline**
(UX-audit feature #4, [deferred.plan.md](deferred.plan.md)) at chat scale. It is
also the cheapest possible testbed for the personality §6 likes/dislikes curve
(`personality-and-state`) — no session machinery to fight.

## Design principles

- **Light by default, heavy never.** State is a few numbers + one sentence, not a
  world model. Chats stay short and locationless.
- **Reuse contracts, add no vocabulary.** Meters/affinity/conditions/concepts are
  pure registries that already work standalone; the only schema change is one new
  table. No new meters, no new concepts, no registry migrations.
- **Deterministic spine, one optional LLM pulse.** Time-drift and the §6 curve are
  free and pure. At most **one** small structured call per exchange reads the
  conversation, and it only _classifies + writes the mind-note_ — the curve
  computes every number. Degrades to drift-only on timeout (`docs/resilience.md`).
- **Keep the clean stream.** The plain-text reply stream is unchanged; state is a
  separate concern (a sibling `GET …/chat/state`), never inlined into prose.

## v1 decisions (resolved)

Settled in the spec; the highlights:

- **State** = one `character_chat_state` row per `(owner, character)`: full meter
  set (seeded from `initialMeters()`), `affinity`, optional `conditions`, a 1–3
  sentence `mindNote`, a chat clock, and a `lastInteractionAt` anchor.
- **Seed & decay** = affinity seeds from a **new authored `playerRelationship`
  field on the character profile**, edited on the character-sheet **Chat** tab as
  **Starting Relationship** (a relationship `stage` → `stageMidpoint`, default
  `stranger` ⇒ 0 ⇒ today's behavior; + an optional one-line `note` that serves as
  the chat's **default premise**), so a "warm" character feels warm from message
  one — no pulse needed (slice 1 already pays off). **No between-visit decay**:
  chat is a light, often-ephemeral test-bed / player-directed short-story space,
  not a persisted relationship arc (resolved below; detail in the spec).
- **Premise** = a per-chat, player-set **scenario field on the Chat page** (above
  the composer), stored on the chat-state row — **chat-only by construction**, so
  it never leaks into the session-facing bio/personality. Pre-filled from the
  authored `playerRelationship.note`, then freely editable, so every chat can run a
  different scenario ("easily test scenarios"). It's the headline player control;
  detail in spec §1.2.
- **Time** = hybrid. Within a visit, a small per-exchange tick decays meters
  (`applyMeterDrift` over personalized baselines). Between visits, state
  **recovers toward rested** (`initialMeters()`), capped — so an idle character
  comes back freshly bathed and rested, not perpetually filthy. Drift is pure and
  recomputed on read; one write per turn.
- **Pulse** = the cheap agent model (the `runIntake` recipe: reasoning off, low
  latency, timeout) classifies the player's act into an interaction concept and
  refreshes the mindNote; the deterministic §6 curve turns that into affinity +
  mood deltas. Runs inline in the stream finalizer after the reply flushes
  (invisible latency). Every exchange in v1.
- **Surfacing** = a "Current state" block in the chat prompt (threshold + mood +
  stage warmth + condition hints + mindNote), built by the prompt builder from
  pure contracts; a status strip + stage-change toast in the UI.
- **Player** carries name+bio only in chat (no player meters in v1).

## Build order

1. **State row + drift + prompt surfacing + UI** (no LLM): the
   `character_chat_state` table (schema → `pnpm db:generate` → review SQL →
   `pnpm db:migrate`), the new `playerRelationship` profile field + Chat-tab
   editor labeled **Starting Relationship** that **seeds** the row's affinity, the
   per-chat **premise** (state column + Chat-page field + `PATCH …/chat/state`),
   seed/load/drift in `engine/chat-state.ts`, the prompt `state` + premise blocks,
   the `GET …/chat/state` route, reset actions (**Reset All**, **Reset Chat**,
   **Reset State**), and the premise bar + status strip + stage toast. _Already
   feels alive, zero added model cost._
2. **~~Player-persona placeholder~~ — done.** Shipped in
   [player-character.plan.md](player-character.plan.md) (resolver + prompt seam).
3. **The reaction pulse** — `chatPulseSchema`, the pulse agent + prompt, the §6
   curve application in the stream finalizer; degrade to drift-only with a
   diagnostic.
4. **Texture** (optional, after playtest) — light conditions, action chips (offer
   a drink → intoxication↑), arousal-from-intimate-acts, mindNote-driven resume
   beats, a state-aware chat scene image, and the **test-bed affordances**: a state
   tools modal, last-turn debug readout, and premise-driven **Prompt Character**
   opening beat.

Slices 1 and 3 are each independently shippable (1 with no model cost at all).

## Scope boundaries (what stays out)

No locations, presence, perception, or witness matrix. No facts table, embeddings,
or RAG (the `mindNote` replaces them). No story threads. No 4-agent post-turn
fan-out (one optional pulse instead). No player-side meters. The plain-text reply
stream is unchanged. This keeps the chat a _quick chat_, not a session.

## Resolved (folded into the spec)

- **Affinity decay between visits? → No decay.** Character chat is a simpler,
  often-**ephemeral** interaction ("likely not persisted") — its job is to **test
  characters** and to host **player-directed short stories**, not to model a
  persisted relationship arc. A "came back after a week and she's gone cold"
  feel-bad has no place here. (Recovery _toward rested_ in the time model still
  applies — that's hygiene/energy, not affinity.) Ruling in spec §10; time model §3.
- **Seed affinity → seed from a new authored profile field.** A character now
  carries a **`playerRelationship`** field on its profile (character-sheet
  **Chat** tab, labeled **Starting Relationship**): a relationship `stage` that
  seeds the chat's starting affinity via `stageMidpoint` (default `stranger` ⇒ 0
  ⇒ unchanged), and an optional one-line `note` (the chat's authored default
  premise). Mechanics + schema in spec §1.1; editor + prompt placement in §6/§7.
- **Per-chat premise → yes, on the Chat page (not the profile).** A free-text
  scenario field above the composer, stored on the chat-state row — **chat-only by
  construction**, so a chat scenario can never leak into the session-facing
  bio/personality, and every chat can run a different setup. Pre-filled from the
  authored `playerRelationship.note`, then player-editable. This also **collapsed
  the earlier "keep the note?" question**: the note isn't a second prompt stream,
  it's the premise's default value. Mechanics in spec §1.2.
- **Reset controls → split the old clear action into three explicit actions.**
  Rename the current clear affordance to **Reset All**: delete messages, summary,
  and state. Add **Reset State**: re-seed live state from authored defaults while
  keeping the transcript. Add **Reset Chat**: clear past messages and summary
  while keeping the state row, so testers can preserve the current disposition/
  premise while starting a new transcript.
- **State tools modal → yes.** Add a modal where authors can inspect and edit the
  current state fields (affinity/stage, meters, conditions, premise, mindNote).
  Once the pulse lands, include a last-turn debug section showing what changed and
  why: classified concept, valence, deltas, and any degradation diagnostic.
- **Premise actions → Save + Prompt Character.** Put **Save** and **Prompt
  Character** next to the premise. Save stores the premise and leaves the first
  player prompt to the player. Prompt Character stores the premise, then asks the
  narrator for a character-authored opening turn using the premise and seeded
  warmth.

## Clarifications — rulings made during the slice 1 + 3 build (2026-06-24)

These did not block the plan shape; resolved as built (slice-4 items noted where
the modal/Prompt-Character work will land):

- **Internal name vs. UI label → kept `playerRelationship`.** The persisted profile
  key stays `playerRelationship` (intrinsic stance toward the player, broader than
  chat); the Chat-tab label is **Starting Relationship** (the stage `<select>`) plus
  a **Default scenario** note input. Not renamed.
- **Reset State and premise → full re-seed (premise resets to the authored default).**
  Implemented as **deleting the state row** (`?scope=state`): the next read/exchange
  lazily re-seeds everything — affinity/meters/conditions/mindNote **and** premise —
  from the authored defaults, transcript intact. To keep a player-edited premise while
  starting a new transcript, use **Reset Chat** instead.
- **Reset Chat and dynamic state → keeps the entire state row intact.** `?scope=chat`
  deletes only messages + summary (+ scrubs scene-image prompts); the state row —
  affinity, meters, premise, `mindNote`, and `lastPulseTrace` — is preserved, so the
  tester resumes the same disposition on a fresh transcript.
- **Save transcript semantics → state-only.** `PATCH …/chat/state { premise }` upserts
  the row and writes no transcript entry. (**Prompt Character**, the action that starts
  a model turn, is slice 4.)
- **Last-turn debug explanation → deterministic.** The persisted `lastPulseTrace`
  records the classified `concept`, resolved `valence`, the signed `affinityDelta` /
  `moodDelta`, the `changed` fields, and a `degraded` flag + `diagnostic` — all derived
  from the concept/valence/curve path; the pulse emits no free-text "why". The
  state-tools modal that renders it is slice 4.
- **State tools visibility / edit surface → deferred to slice 4.** The modal isn't
  built yet; the trace it will read is already persisted. Open for slice 4: owner-vs-
  admin visibility, and whether it edits clock/last-interaction alongside
  affinity/meters/conditions/mindNote/premise.

### Implementation note — constant placement (deviation from spec §8)

`CHAT_MIND_NOTE_MAX_CHARS` and `CHAT_PREMISE_MAX_CHARS` live in the pure contract
`contracts/turns/chat-pulse.ts`, **not** `engine/constants.ts` as §8 listed: the
pulse schema needs the mindNote cap and the chat UI/composer needs the premise cap,
and neither a contract nor a client component may import a server module (the
module-boundary lint). The cadence/timing constants (`CHAT_TICK_MINUTES`,
`CHAT_RESET_MINUTES`, `CHAT_PULSE_EVERY_N`, `CHAT_PULSE_TIMEOUT_MS`,
`CHAT_PULSE_MAX_OUTPUT_TOKENS`) stay in `engine/constants.ts`.

(Everything else — time model, pulse cadence/cost, player-state-in-chat, strip
placement — is resolved in the spec §10.)

## Related

- [character-chat-state.spec.md](character-chat-state.spec.md) — the settled v1
  mechanics (schema, drift, pulse, surfacing, tests).
- [finished/character-chat.plan.md](finished/character-chat.plan.md) — the
  stateless v1 this builds on.
- [player-character.plan.md](player-character.plan.md) — the embodied player
  (shipped), whose `resolvePlayerPersona` this consumes.
- [character-chat-summary.plan.md](character-chat-summary.plan.md) — the rolling
  recap the `mindNote` complements.
- `docs/contracts/meters-actions.md`, `relationships.md`, `conditions.md`;
  `personality-and-state` §6 (the curve) — the contracts reused.
- [deferred.plan.md](deferred.plan.md) "Relationship & meter timeline" — the
  surfacing idea, here at chat scale.
