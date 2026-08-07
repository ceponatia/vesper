# Branch, fork & replay UX — honest history operations for sim chats

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item D19, parked 2026-07-24 from the
successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building.

Outcome (provisional): A player can rerun or edit an earlier turn and have the
story split into a second version from that point, so that revisiting a moment
stops silently contradicting everything that happened after it.

## What

Every primitive this needs already exists and is tested — and none of it has a
route or a client:

- `forkBranch` (`simulation/branch-store.ts:403`) — only non-test caller is the
  soak harness.
- `loadBranchAncestry` (`:142`) / `readBranchAncestryEvents` (`:210`) — used
  internally by audit/memory/snapshot stores only.
- Replay assembly (`assembleBranchState` `:244`, `seedProjectionForReplay`
  `:356`) and snapshot rebuild (`snapshot-store.ts`).
- Persisted `NarrativeCut`s (`narrative-cut-store.ts`) — read in production
  only for retake/rerender.
- `explainItemPlacement` (`audit-store.ts:25`) — zero production callers.

Meanwhile the legacy pipeline itself names branching as the honest fix for
older reruns (`chat-pipeline.ts:1671-1673`, error code `rerun_requires_branch`
— "branch the conversation from this point instead"), and the engine ground
rule agrees ("retake = fork; no in-place rewind leaves later state behind" —
finished/engine.rollout.plan.md §Ground rules). Nothing wires them together.
(MED · L)

## Why it matters

This is the *complete* fix for the two P0 dishonesties D17 only hides:

- **Rerun from here** on a sim chat should create a branch at the selected
  exchange boundary and replay the selected turn there, leaving the original
  timeline intact — the semantics the UI already promises.
- **Editing world-affecting player turns** becomes "edit and fork from here"
  instead of a raw row overwrite that desyncs the world.

And it's the product face of a genuine engine differentiator: branch switcher,
"fork story from here", "what changed this turn?" (event diff per exchange), a
player-safe recent world-history panel, an admin event/correlation trace, and
"why is this item here?" backed by `explainItemPlacement`.

## Sketch

- Message rows gain the linkage the client needs (expose `meta.cutId`; record
  exchange/branch anchor per assistant row) so a fork point is addressable.
- `POST /api/chats/[chatId]/fork` — fork the branch at an exchange boundary,
  clone-or-share the chat row, land the player on the new branch.
- Branch switcher UI (probably on the world card / world sheet) + a compact
  "what changed" read from the event log between two cuts.
- Admin-only: correlation trace + `explainItemPlacement` surfaces.

## Open questions

- Does a fork create a new chat (transcript diverges cleanly; roster of chats
  grows) or a branch-picker inside one chat (transcript must re-render per
  branch)? Quota interaction with E20 either way.
- How much replay cost is acceptable at fork time for long histories —
  snapshots exist (`sim_snapshots`), are they enough?
- Player-safe history: what's the redaction rule for events the player never
  perceived (ties into §20 perception / §24 eligibility)?

## Slices

_(Defined at promotion.)_
