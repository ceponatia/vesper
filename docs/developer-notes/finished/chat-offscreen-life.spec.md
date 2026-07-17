# Chat off-screen life — spec

Companion to [chat-offscreen-life.plan.md](chat-offscreen-life.plan.md) (read that first
for the goal and the ensemble angle). Records the rulings on open questions A–F and the
settled build shape, written as the plan shipped (2026-07-15).

The one-line frame: **a player skip crosses the gate → one detached pass proposes what
the cast did off-screen, grounded in what the story already tracks → deterministic folds
persist it into the existing sinks → the next exchange gets one line of texture and the
rest waits in memory.**

## Rulings

- **A. Threshold** — the gate is **cumulative**: the pass arms when
  `clockMinutes − meanwhile_pass_at_minutes ≥ MEANWHILE_GATE_MINUTES` (1440, one story
  day). Stacked overnight skips arm it (three overnights ≥ 1440), not only the `days`
  amount; longer skips still get the same 1–3 developments (bounded texture, not a
  simulation). `armMeanwhilePass`, tested.
- **B. Placement** — a **detached job at skip time** (`chat_meanwhile`, the
  `chat_scene_sketch` pattern: `sessionId: null`, deduped one-live-per-chat, fired
  fire-and-forget from `POST …/time-skip`). Nothing waits on it; the next exchange
  proceeds on grounded improvisation if it hasn't landed. NOT the literal single-column
  CAS, though (feasibility note 4): the pass writes many sinks, so idempotency keys on
  **`meanwhile_pass_at_minutes`** (the job carries the pre-pass value; a moved marker =
  a stale job, dropped) and the scenario-side folds are additionally guarded on
  **`pending_skip_note` still standing** — if an exchange consumed the skip first, the
  cast/plan/note folds drop whole (that exchange's own folds already ran; a late note
  would be stale) and only the marker advances. Facts + member rows land either way.
- **C. Whereabouts storage** — its **own column**: `character_chat_state.whereabouts`
  (text, ≤120 chars, migration 0050) — a phrase, never a location entity. Written by
  the archivist's presence read (the `presence` proposal gained an optional `where` on
  away transitions) and refreshed by the pass for away members; author-correctable via
  `ChatStateEdit.whereabouts`. **Return grounding rides the same field**: a PRESENT
  member with a non-empty whereabouts "just got back" — the tail renders a one-turn
  came-from license and the post-exchange fold clears it. Supporting-cast whereabouts
  accretion also landed: the `cast` proposal + `mergeSupportingCast` now carry/refresh
  the member's `whereabouts` (unlike `relation`, it refreshes — it is current state,
  not authored canon).
- **D. Matrix nudges** — **no** (as leaned): NPC↔NPC developments file as relationship
  **facts** to both members' groups; the authored matrix is never machine-edited.
- **E. Meanwhile-note size** — **one composed line** (≤160 chars), stored as the
  one-shot `character_chats.pending_meanwhile_note`, rendered as a binding tail line in
  both frames beside the skip note and cleared with it. Everything else is memory-only.
- **F. Opener overlap** — when a pass note exists for the gap, it **leads the opener's
  material** and the life-meanwhile license switches to "pick your ONE meanwhile beat
  from it — never invent a different meanwhile" (`buildInitiativeCue`'s `meanwhile`
  input). Same-beat dedupe is by construction: improvisation yields to canon. The
  ordinary-exchange path gets the same rule via the tail's meanwhile line wording.

## Build shape (what shipped, and one deliberate deviation)

- **Contract**: `contracts/turns/chat-meanwhile.ts` — `chatMeanwhileSchema`
  (developments ≤3 with `about[1–2]`/`event` + optional drive/cast/plan bindings,
  whereabouts refreshes, the note), `armMeanwhilePass`, and the pure
  `applyMeanwhilePlanOutcomes` (resolves open plans **not involving the player** by
  normalized `what` — the pass replacing plans & promises ruling E's assume-kept
  default). All caps/lenient-leaf parsing; a bad blob degrades to the empty pass.
- **Job**: `engine/chat-meanwhile.ts` (enqueue + `runChatMeanwhile`) with its prompt in
  `prompts/chat-meanwhile.ts`. The dossier fences each member's rhythm / drives (secrets
  marked `SECRET — never expose it`; the fold additionally **strips** reveal/resolve
  proposals — the drives law owns reveals) / whereabouts, the matrix pair lines, the
  supporting cast, and the gap's eligible NPC↔NPC plans. Budgets:
  `CHAT_MEANWHILE_MAX_OUTPUT_TOKENS`/`_TIMEOUT_MS`; failure code
  `chat_meanwhile.generate` / `.timeout`, `degradeSeverity: "warn"`.
- **Per-member fact routing** (feasibility note 2, now real): each development files as
  a `FactDraft` (`kind: "event"`, or `"relationship"` for a two-name development;
  `tags: ["offscreen"]`, prefixed "While apart (off-screen):") to **every involved
  roster member's own memory group** — away members included, each `witnessedBy`
  themselves — so members know *different things*; cast-only developments file to the
  primary.
- **Member-row writes are targeted columns** (`drives`, `whereabouts` via
  `coalesce`), never whole-row persists — a concurrent exchange's save is never
  clobbered.
- **Deviation from the plan's build note**: the pass is **not** literally "a fourth leg
  composed from the extraction field library's key list" — the library is single-subject
  (every field instruction binds one `ctx.characterName`), and an ensemble-wide pass
  can't reuse those instructions (feasibility note 1). It is a sibling module in the
  library's *style* (one composite schema, fenced dossier, shared folds) with no
  duplicated field instructions — honoring the note's intent (no re-hand-written
  13-field monolith) rather than its letter.

## Grounded improvisation (§1/§4, the no-model-call half)

- `chatSkipNote`'s meanwhile license now grounds explicitly ("your daily rhythm, what
  you want, the people in your life, and any plans you had — never invented strangers").
- The initiative cue gained **supporting-cast material** (names + relations +
  whereabouts) beside the plans/loops/wants/rhythm it already had.
- Every present member gets a **rhythm line** in ordinary turns (1:1: a standing tail
  line; ensemble: a `usual rhythm:` bit in the member state line), grounding
  time-of-day texture in the routine the clock card's story time implies.

## Bounds

≤3 developments per pass · note ≤160 chars · whereabouts ≤120 chars · secrets may
progress, never surface · the pass never promotes cast toward roster weight (details
accrete through the same capped `mergeSupportingCast` as ever) · no wall clock anywhere
(D3/D8 stand — the gate, the gap label, and every fold key to story minutes).
