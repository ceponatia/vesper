# ChatConversation decomposition — an explicit exchange state machine

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item G25, parked 2026-07-24 from the
successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building.

Outcome (provisional): A developer can change one part of the chat screen — the
composer, the transcript, the world panel — without reading the rest of it, so
that adding a chat feature stops requiring a tour of a two-thousand-line file
and stops leaving one chat's leftovers on screen in the next.

## What

`components/chat/chat-conversation.tsx` is 2 004 lines; the `ChatConversation`
component spans ~1 650 of them with **51 hooks** (37 `useState` + 14
`useRef`), 3 `useAsyncData`, 2 `usePollWhile`, and ~30 async handlers. It
owns: transcript bootstrap + keyset pagination, scene images + polling, world
reads, streaming, chat-state snapshots, attachments, composer modes
(narrator/OOC), roster sheets, seven dialogs, time skips (dual-lane), and
lifecycle actions. (MED · L)

**The chat-change reset half of this shipped 2026-08-02** (out of order, on the
owner's build request — [roadmap.shipped.md](../roadmap.shipped.md)) and is no
longer part of this stub: the partial reset used to clear 10 of ~25 state items,
so `input`, staged `attachments`, `narratorMode`, `oocActive`, open
sheets/dialogs and `skipBusy` all survived a chat switch (staged photo ids from
the previous chat would be submitted to the new one). It is now keyed on
`chatId` and driven by one typed list of per-chat defaults
(`components/chat/chat-conversation-state.ts`), which a decomposition should
absorb rather than re-derive: the extracted hooks own their slice of that list.
The decomposition below — the reason the reset was fragile in the first place —
stays parked.

## Why it matters

Every honest-UI item in this batch (D17 capabilities, F21 typed stream, F22
world surface) lands inside this component; each lands cheaper and safer on a
decomposed structure with an explicit exchange state machine. (The partial
reset was the live bug class here; it shipped separately — see above.)

## Sketch

- Extract hooks: `useTranscript`, `useChatExchange`, `useSuccessorWorld`,
  `useComposerDraft`, `useConversationPanels`; components: `ChatLayout`,
  `ChatComposer`, `WorldSurface`.
- Model exchange state explicitly: `idle → uploading → submitting →
  world_committed → rendering → stopping → failed → settled` — controls and
  recovery derive from the state, not from boolean soup.
- Make chat-change reset structural: the shipped fix is one typed list plus an
  exhaustive reset; extracted hooks should own their slice of it keyed by
  `chatId`, so the list stops needing to be central at all.

## Open questions

- Incremental extraction order — `useTranscript` first (largest win) or
  `useComposerDraft` first (the composer slice G26 also touches)?
- Does the exchange state machine wait for F21's typed stream (which gives it
  real phase transitions) or ship against the current binary stream first?

## Slices

_(Defined at promotion.)_
