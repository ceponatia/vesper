# ChatConversation decomposition — an explicit exchange state machine

Status: draft (stub — successor-engine backlog item G25, parked 2026-07-24 from
the successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building)

## What

`components/chat/chat-conversation.tsx` is 2 004 lines; the `ChatConversation`
component spans ~1 650 of them with **51 hooks** (37 `useState` + 14
`useRef`), 3 `useAsyncData`, 2 `usePollWhile`, and ~30 async handlers. It
owns: transcript bootstrap + keyset pagination, scene images + polling, world
reads, streaming, chat-state snapshots, attachments, composer modes
(narrator/OOC), roster sheets, seven dialogs, time skips (dual-lane), and
lifecycle actions. The chat-change reset (`:276-287`) clears 10 of ~25 state
items — `input`, staged `attachments`, `narratorMode`, `oocActive`, open
sheets/dialogs, and `skipBusy` all survive a chat switch (staged photo ids
from the previous chat would be submitted to the new one). (MED · L)

## Why it matters

Every honest-UI item in this batch (D17 capabilities, F21 typed stream, F22
world surface) lands inside this component; each lands cheaper and safer on a
decomposed structure with an explicit exchange state machine. The partial
reset is also a live bug class, not just hygiene.

## Sketch

- Extract hooks: `useTranscript`, `useChatExchange`, `useSuccessorWorld`,
  `useComposerDraft`, `useConversationPanels`; components: `ChatLayout`,
  `ChatComposer`, `WorldSurface`.
- Model exchange state explicitly: `idle → uploading → submitting →
  world_committed → rendering → stopping → failed → settled` — controls and
  recovery derive from the state, not from boolean soup.
- Make chat-change reset structural: keyed state lives in the extracted hooks
  keyed by `chatId`, so a switch can't leak by omission.

## Open questions

- Incremental extraction order — `useTranscript` first (largest win) or
  `useComposerDraft` first (fixes the leak G26 also touches)?
- Does the exchange state machine wait for F21's typed stream (which gives it
  real phase transitions) or ship against the current binary stream first?

## Slices

_(Defined at promotion.)_
