# Memory callbacks — unprompted "remember when" beats

Status: **shipped — 2026-07-11** (planned, ruled, and built the same day — the
first of the seven-plan engagement batch. Both slices landed: the pure
gate/selector/ring module (`engine/chat-callback.ts`, migration `0032`), the
retrieval leg + tail line, and the `chat-callback-warm`/`-cold` eval fixtures
with the deterministic `callbackCue` metric. Leftover: the **live judged eval
run is owner-gated spend** (`pnpm eval:narration --scenarios chat-callback
--judge`) — the fixtures are dry-run validated. Design refinement recorded
below: milestones boost episodes via `source_message_id` rather than forming
their own candidate pool — they carry no embedding or clock of their own.)

Fused RAG recall (`retrieveChatMemory`) is strictly input-relevance-driven: the
character only ever remembers what the current message is already about, so
shared history never resurfaces on its own and unprompted "remember when…"
moments — among the strongest intimacy signals a companion can produce — never
happen. Everything needed already exists: episodes, milestones
(`contracts/relationships/history.ts`), the chat clock for "that first morning,
weeks ago" texture, and the one-turn-cue tail-line shape (the sensory
allowance).

## Design

- **Selection** (new pure helper + one retrieval leg in `engine/chat-memory.ts`):
  candidate pool = ready episodes older than K exchanges, plus milestones
  (`stage_up` / `strong_reaction` / `player_marked` / `familiarity_up`). Score =
  salience (milestone-kind weight) × age preference (older wins) × **topic
  distance** — penalize similarity to the current input embedding (already
  computed for recall; reuse the vector). A callback should be a tangent, not an
  echo of what retrieval will surface anyway.
- **Cadence gate** (sibling of the reply gates in `engine/chat-intent.ts`): at
  most once per `CHAT_CALLBACK_MIN_GAP` exchanges (10, ruled), only on a
  **lull** — no intimate beat in flight, no unanswered character question
  (reuse the span-parser question detection), and suppressed whenever the tail
  already carries a skip note, first-exchange directive, or sensory-focus block
  (callbacks are the lowest-priority tail block; the tail budget wins). No
  regard-band requirement (ruled) — the band picks the wording instead.
- **Render**: one optional one-turn line in the volatile tail, same shape as the
  sensory allowance, **worded by regard band** (ruled): warm bands get the
  nostalgic aside (*"If the moment invites it, you might find yourself
  remembering <one-line summary> — one natural aside at most; let it go if the
  scene is moving."*); neutral bands a plain remembering; low/hostile bands a
  pointed edge (the memory may surface as evidence or a wound, never warmth the
  character doesn't feel).
- **Anti-repeat**: `callback_history` ring (≤20 `{ref, atExchange}`) — a new
  jsonb column on `character_chat_state`, included in `storedChatStateSchema`
  (so "another take" rolls a burned callback back), `ChatStateEdit`, and the
  state-tools modal.
- **Degradation**: empty pool or failed retrieval ⇒ no line; diagnostic only on
  failure (`chat_memory.callback.failed`), silence on the ordinary skip path.

## Slices

1. Selection + cadence gate + tail line + `callback_history` column (migration,
   standard workflow) + pure tests (gate math, ring, rollback).
2. Eval fixture (`chat-callback-*`) + deterministic metric: the callback lands
   as ≤1 line, references the planted past episode, and is not about the
   current topic (anti-echo assert).

## Rulings (owner, 2026-07-11)

- **Cadence:** minimum gap ~10 exchanges between callbacks, plus the lull gate.
- **Band gating:** callbacks fire at **all** regard bands, with the cue line's
  wording colored by band — warm nostalgia when close, neutral in the middle,
  pointed/bittersweet when cold (history as a weapon in arguments is in scope).
- **Session port:** chat-only for now; revisit as its own small slice once the
  mechanic is proven here (episodes + milestones are richest in chat).

## Cross-links

- [character-drives.plan.md](character-drives.plan.md) — a revealed secret is a
  prime callback candidate once both ship.
- [emotional-weather.plan.md](emotional-weather.plan.md) — a nostalgic callback
  could nudge the persistent feeling; v1 keeps them independent.
