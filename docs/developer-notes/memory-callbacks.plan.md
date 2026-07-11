# Memory callbacks — unprompted "remember when" beats

Status: **next** (planned 2026-07-11, from the character-chat & schema engagement
review — first of the seven-plan batch at the top of [roadmap.md](roadmap.md)
§Next; effort **S**)

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
  most once per `CHAT_CALLBACK_MIN_GAP` exchanges (start 10), only on a **warm
  lull** — no intimate beat in flight, no unanswered character question (reuse
  the span-parser question detection), and suppressed whenever the tail already
  carries a skip note, first-exchange directive, or sensory-focus block
  (callbacks are the lowest-priority tail block; the tail budget wins).
- **Render**: one optional one-turn line in the volatile tail, same shape as the
  sensory allowance: *"If the moment invites it, you might find yourself
  remembering <one-line summary> — one natural aside at most; let it go if the
  scene is moving."*
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

## Open questions

- Cadence and band gating: is 10 exchanges right, and do low-regard bands get
  bittersweet callbacks (history as a weapon in arguments) or none at all?
- Session-lane port: same shape over session episodes once proven here — worth
  a line in that lane's tail, or chat-only forever?

## Cross-links

- [character-drives.plan.md](character-drives.plan.md) — a revealed secret is a
  prime callback candidate once both ship.
- [emotional-weather.plan.md](emotional-weather.plan.md) — a nostalgic callback
  could nudge the persistent feeling; v1 keeps them independent.
