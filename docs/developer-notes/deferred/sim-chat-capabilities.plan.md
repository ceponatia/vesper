# Sim-chat capability manifest — honest controls first

Status: draft (stub — successor-engine backlog item D17, parked 2026-07-24 from
the successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building)

## What

The transcript API distinguishes the two engines with a single boolean —
`simRouted` (`app/api/chats/[chatId]/route.ts:201`, client schema
`lib/client/api.ts:837`) — and the client gates exactly two things on it:
legacy action chips (`chat-conversation.tsx:1465`) and photo attachments
(`:1567`). Every other control leaks through with legacy semantics:

- **Stop** renders whenever a reply is in flight (`chat-conversation.tsx:1600-1610`)
  but the stop endpoint aborts controllers in the legacy pipeline's in-process
  map (`chat-pipeline.ts:335`, only writer `:1184`) — the sim fork registers
  nothing, so Stop on a sim chat 404s and the client swallows it (`:788`).
  Dead button, zero feedback.
- **Rerun from here** promises resend-and-replace (optimistic snip at
  `chat-conversation.tsx:697`), but `sim-routing.ts:70-73` maps `rerun` →
  `retake` and `runSimChatExchange` has no `messageId` input
  (`sim-exchange.ts:848-864`); retake targets the newest assistant row
  (`:2017-2027`). The snipped lines reappear on `reloadTranscript()` with the
  *latest* reply silently rewritten — a silent wrong result, not an error.
- **Edit/Delete** are gated only on ownership (`messages/[messageId]/route.ts:37,66`)
  and mutate `character_chat_messages` alone — no sim command is reversed. The
  server-side `meta.cutId` linkage exists (`sim-exchange.ts:1148-1154`) but the
  edit path ignores it, and the client schema strips it. World-beat rows are
  editable via the API too (UI hides the action bar, `chat-message.tsx:174-183`).
- **Another take** shows for the last assistant line unconditionally
  (`chat-conversation.tsx:1038-1040`) even when the reply is solo/`cutId:""`
  and retake predictably 409s — see [solo-retake.plan.md](solo-retake.plan.md) (A3).

(HIGH · M — the manifest itself is S; the per-control server guards are the rest)

Note: Continue / Go on / Regenerate showing on sim chats is **deliberate**
(`chat-conversation.tsx:1024-1030`, `sim-routing.ts:63-74`) — not a leak.

## Why it matters

Sim chats currently expose controls that are dead (Stop), silently wrong
(Rerun), or world-desyncing (edit/delete). Making the UI honest is the review's
recommended step one because it needs no engine work — remove/relabel first,
then rebuild each control with real successor semantics (D18 stop, D19
branch-aware rerun/edit).

## Sketch

- Replace the lone `simRouted` boolean with a versioned `capabilities` object
  on the transcript payload (`canStop`, `canAttachPhotos`, `canEditHistory`,
  `canRerunFromMessage`, `canRetakeLatest`, `canForkFromMessage`,
  `canUseWorldActions`, `version`), plus per-message capability hints
  (a co-present cut is retakeable; a solo reply is not — surface the existing
  `meta.cutId` to the client instead of stripping it).
- Server-side guards to match (the API is the real boundary): reject
  edit/delete of world-affecting rows on sim chats (or gate behind an explicit
  "display override" flag with a "world history unchanged" label), reject
  `rerun` with a target `messageId` on sim chats with a structured code
  instead of silently retaking.
- Client renders controls from capabilities, never from lane inference.

## Open questions

- Are assistant-prose edits allowed as labeled display overrides in v1, or
  simply refused until D19's fork-based editing lands?
- Does the manifest ride the transcript GET only, or also the world envelope
  (so the world card and composer share one source)?

## Slices

_(Defined at promotion.)_
