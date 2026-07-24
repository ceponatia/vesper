# Composer input edges — IME composition and per-chat drafts

Status: draft (stub — successor-engine backlog item G26, parked 2026-07-24 from
the successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building)

## What

- The Enter handler sends immediately with no composition guard
  (`chat-conversation.tsx:727-733` — no `e.nativeEvent.isComposing`, no
  `keyCode === 229`; repo-wide grep for `isComposing|compositionstart` is
  empty). Japanese/Chinese/Korean input fires a send on the
  composition-commit Enter, submitting incomplete text. The OOC auto-close
  (`:741`) and backspace-pair (`:749`) handlers are likewise
  composition-blind. (MED · S — affects both lanes)
- Composer text, narrator mode, and staged attachments are plain component
  state: not cleared on chat switch (they leak to the next chat — see G25's
  reset audit) and lost on unmount/reload. No per-chat draft persistence
  exists (the only chat-side `localStorage` use is privacy mode). Staged
  uploaded-but-unsent attachments have no reclaim story. (LOW-MED · S/M)

## Why it matters

The IME defect makes the composer actively hostile to CJK users — a broken
core flow, cheap to fix. Draft loss is routine friction (navigate away,
lose the paragraph).

## Sketch

- Guard all three keydown behaviors on `e.nativeEvent.isComposing` (plus the
  Safari `keyCode 229` quirk if needed).
- Persist `{ text, narratorMode }` per `chatId` (localStorage, debounced),
  restore on mount, clear on successful send. Decide explicitly whether
  staged attachment ids persist (they're server-side uploads — either
  restore them with the draft or reclaim/expire them server-side).

## Open questions

- Draft storage: localStorage only, or server-side so drafts follow the
  account across devices? (localStorage is the S version.)
- Orphaned staged uploads: sweeper, TTL, or attach-at-send refactor?

## Slices

_(Defined at promotion.)_
