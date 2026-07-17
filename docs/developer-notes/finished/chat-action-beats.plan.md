# Chat action beats — promote the action chips to narrated beats

Status: **shipped — 2026-07-14.** A chip tap is now an `action_beat` exchange
through the chat pipeline: no persisted player line, a server-built register-aware
cue (`engine/chat-action-beat.ts` `buildActionBeatCue`), the narrator plays it as a
normal one-beat reply, and the chip's deterministic effect (`applyChatAction`) applies
to the drifted state pre-narration — rollback-safe via the pre-exchange snapshot, the
chip id riding the reply's `meta.actionBeat` so "another take" reproduces cue + effect
(re-applied exactly once). The old POST `…/state {action}` deterministic-only endpoint
+ its `chatsApi.applyAction` client were **removed** (superseded). Chips gained tooltip
`hint` copy. Tests: cue snapshot per chip (`chat-action-beat.test.ts`), effect + rollback
+ busy-409 int (`chat-state.int.test.ts`). Rulings recorded below.

Spawned 2026-07-13 from the [ux-improvements.plan.md](ux-improvements.plan.md) slice-4 ruling.

## Goal

The four chat action chips — "Offer a drink / Freshen up / Take a breather /
Heat things up" — are test-bed deterministic state nudges
(`contracts/turns/chat-pulse.ts:33`) rendered with no explanation
(`chat-status.tsx` `ActionChips`): tapping one silently mutates state and the
transcript never acknowledges it. Owner ruling (2026-07-13): promote them to
**real narrated beats** — a chip tap becomes an exchange the narrator plays,
with the deterministic state effect kept.

## Design sketch

Follow the established server-built-cue exchange pattern (the reopen opener in
`chat-initiative.ts`, the "Prompt character" `open` kind):

- A chip tap submits a new exchange kind (e.g. `action_beat`) carrying the chip
  id. No persisted player line — the server builds a short synthetic cue
  describing the player's gesture ("you offer her a drink"), the narrator
  renders the beat as a normal reply, and the deterministic state nudge applies
  with the exchange (rollback-safe via the existing `pre_exchange_state`
  machinery).
- One-beat restraint, same as the opener: the cue licenses a small scene beat,
  not a scene change.
- Chips gain visible affordance polish as part of this (label/tooltip copy that
  says what the tap will do) — the interim tooltip-only pass was explicitly
  declined in the UX batch ruling.
- Multi-character chats: the beat targets the character the chip context
  implies (default: the primary / the roster member whose strip hosts the
  chips) — settle at build. **Ruling (2026-07-14): the beat targets the primary**
  — the status strip that hosts the chips reads the primary's state, so the cue and
  the `applyChatAction` effect both key on `owned.participant.characterId`; other
  roster members neither pulse nor take the effect on an action beat (the action
  names no one, so the referenced-only fan-out simply doesn't reach them).

## Build order

1. Exchange kind + lock handling in `engine/chat-pipeline.ts` (reuses the
   keyed-lock + stream plumbing; a busy chat 409s like any other submit).
2. Per-chip cue builder (server-side, register-aware — apart vs co-present).
3. Keep/attach the deterministic state effect; decide ordering (state applied
   pre-narration so the reply reflects it, mirroring the current nudge).
4. Transcript + UI: the beat renders as a normal reply; chip affordance copy.
5. Tests: cue snapshot per chip, state-effect + rollback int test, busy-chat
   409.
6. Docs: `character-chat/pipeline.md` (exchange kinds), `ui.md` (chips), `prompts.md`
   (the cue).

## Rulings

- **Chip set stays fixed at four for v1** (2026-07-14 — took the plan's default).
  No context-dependent hiding (e.g. "Heat things up" at hostile regard); the chip
  set is the static `CHAT_ACTIONS` registry. A later slice can gate visibility if
  the fixed set proves wrong.
- **Multi-character targeting: the primary** (see the design-sketch note above).
