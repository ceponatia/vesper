# Emotional weather — persistent feeling, regard momentum, reply pacing

Status: **shipped — 2026-07-11** (planned, ruled, and built the same day — the
second of the seven-plan engagement batch. All four slices landed: the pure
`engine/chat-feeling.ts` module (feeling schema, decay, streak/bruise/bias
math) + `character_chat_state.feeling` (migration `0033`); the pulse `feeling`
proposal + the new `apologize` interaction concept + the momentum wiring in
`applyChatPulse` (the trace gains `feeling` + `regardScale`); the composed
Current-state / mood-pin rendering; and the pacing UI (`lib/chat-pacing.ts` +
the reveal-hold in `chat-conversation.tsx`). Eval: the `mt-chat-feeling-hurt`
multi-turn fixture, dry-run validated (the **live judged run is owner-gated
spend**). One deliberate scope note: the state-tools modal can edit `feeling`
via the API (`ChatStateEdit`) but has no dedicated form control yet — add one
if hand-tuning weather becomes routine.)

Emotions in chat are meter-derived and reactive-only: `mood` is one scalar, a
strong beat's deltas start decaying on the next tick, and `deriveMoodDescriptor`
blends mood/stress/energy into a handful of canned phrases. Nothing persists the
way jealousy, hurt, or giddiness actually do, and regard moves on a flat ±5/turn
clamp with no history — no warm streaks, no bruises that heal slowly. This plan
is deliberately **prose/state only**: it does not re-tread the rolled-back
expression-frame avatars ([avatar-3d.plan.md](avatar-3d.plan.md) §Rollback).

## Design

1. **Persistent `feeling`** — new jsonb column on `character_chat_state`:
   `{ label: EmotionLabel, intensity: 0..1, cause: string (≤120 chars),
   setAtExchange: number } | null`, reusing the locked 11-label vocabulary from
   `contracts/mood`. The **pulse** proposes it (schema gains an optional
   `feeling` field: label + cause only — the model still never proposes
   numbers); intensity derives deterministically from the §6 curve outcome
   (|regardDelta|, the strong-reaction threshold, the arousal bump). Decays per
   **exchange**, not clock minutes (≈−0.15/exchange); a stronger new proposal
   replaces it, a same-label proposal refreshes it, and it clears below a floor.
   - Prompt: the tail's "Current state" mood line composes the feeling ("still
     stung from…", "giddy since…") with the meter descriptor; the mood-pin line
     uses it when present. Later feeds `visualStateNote` so selfies/scenes can
     read tearful or bright.
   - Rollback-safe: rides `storedChatStateSchema` + `ChatStateEdit`; shown and
     editable in the state-tools modal.
2. **Regard momentum** — deterministic, applied where the pulse's delta lands
   (`applyChatPulse`, `engine/chat-state.ts`), computed from the existing
   `relationship_history` ring: an EMA of recent deltas gives a warmth-streak
   multiplier on positive deltas (cap ×1.5, still inside the ±5 clamp); a
   **bruise** — a large negative delta landing while regard sits in a high band
   — halves positive deltas for K exchanges and decays alongside the feeling.
3. **Reply pacing (UI slice)** — client-only: typing-indicator hold and stream
   reveal pacing derived from the status payload's feeling/regard band (smitten
   or nervous ⇒ fast and eager; hostile or guarded ⇒ slow, terse). Server work
   is only surfacing `feeling` on the chat status payload. (This folds in the
   "typing rhythm" footnote from the 2026-07-11 review.)

## Slices

1. Contracts + column (migration) + pulse proposal + deterministic
   intensity/decay + prompt composition + tests (including rollback).
2. Momentum + bruise + tests — fixture: identical acts on a warm streak vs a
   cold open produce different cumulative regard; a bruise dampens recovery.
3. Pacing UI + status-payload field.
4. Eval: `chat-feeling-*` fixture — a planted hurt persists across three
   exchanges of neutral input (the narrator colors, without re-litigating).

## Rulings (owner, 2026-07-11)

- **Compose**: the meter descriptor stays the baseline weather; the feeling
  renders on top ("subdued — still stung from …"). Both signals survive.
- **Bruise ≈ 10 exchanges** of damped positive regard gains.
- **Add an `apologize` interaction concept** (registry data edit): a classified
  apology that isn't disliked halves the bruise's remaining life. `reassure`
  stays comfort, not repair.
- **Curve feedback: yes, damped** — feeling valence × intensity adds at most a
  ±10% multiplier to reaction magnitude (amplifies deltas that agree with the
  feeling, damps those that fight it), hard-capped so it can't spiral. This
  went past the plan's lean; the eval fixture watches for runaway.

## Cross-links

- [chat-selfies.plan.md](chat-selfies.plan.md) /
  [chat-scene-references.plan.md](chat-scene-references.plan.md) — feeling
  feeds `visualStateNote` once present.
- [memory-callbacks.plan.md](memory-callbacks.plan.md) — callbacks stay
  independent of feeling in v1.
