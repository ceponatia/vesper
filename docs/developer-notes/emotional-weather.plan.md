# Emotional weather — persistent feeling, regard momentum, reply pacing

Status: **next** (planned 2026-07-11, from the character-chat & schema engagement
review — seven-plan batch at the top of [roadmap.md](roadmap.md) §Next; effort
**M**)

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

## Open questions

- Compose or supersede `deriveMoodDescriptor`? Lean **compose** — the
  descriptor stays the baseline weather, the feeling is the front passing
  through.
- Bruise tuning: K exchanges? Does a sincere `reassure` act lift it early
  (there is no `apologize` interaction concept today — add one, or let
  `reassure` carry it)?
- Should the feeling feed back into the §6 curve (a hurt character reads
  neutral acts worse)? v1: **no** — avoid runaway loops; revisit with eval data.

## Cross-links

- [chat-selfies.plan.md](chat-selfies.plan.md) /
  [chat-scene-references.plan.md](chat-scene-references.plan.md) — feeling
  feeds `visualStateNote` once present.
- [memory-callbacks.plan.md](memory-callbacks.plan.md) — callbacks stay
  independent of feeling in v1.
