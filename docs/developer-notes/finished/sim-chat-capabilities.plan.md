# Sim-chat capability manifest — honest controls first

Status: shipped — 2026-07-28 (promoted the same day from successor-engine
backlog item D17; all three slices complete)

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
  and retake predictably 409s — see [solo-retake.plan.md](../deferred/solo-retake.plan.md) (A3).

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

- **Ruled for v1:** successor history edits and deletes are refused rather
  than presented as display-only overrides. D19 can introduce fork-aware
  semantics later without preserving a misleading intermediate contract.
- **Ruled for v1:** the transcript GET owns the capability manifest. The
  composer, message controls, and world entry point consume that shared
  payload; the world envelope remains projection data rather than policy.

## Slices

1. **Contract and enforcement.** Add a versioned transcript capability
   manifest with safe defaults, expose the existing retake linkage needed for
   per-message decisions, and reject unsupported successor mutations at the
   server boundary.
2. **Capability-driven controls.** Render Stop, attachments, edit/delete,
   targeted rerun, latest retake, fork, and world actions from the manifest
   instead of inferring them from the engine lane.
3. **Focused regressions.** Cover legacy compatibility, successor refusal
   codes, and the absence of dead or misleading controls.

## Acceptance

- A successor chat exposes no legacy-only control that will predictably fail,
  target the wrong turn, or desynchronize projected world history.
- Direct API calls receive a structured refusal for unsupported mutations.
- Legacy chats preserve their current controls and mutation behavior.

## Shipped

The transcript now carries a versioned capability manifest. Message actions,
attachments, legacy action beats, Stop, retake, and responsive World access
render from that policy; the old `simRouted` flag remains presentation metadata
only. Successor stop, attachment upload/send, edit, delete, regenerate, and
targeted rerun paths all return the shared structured refusal, while legacy
behavior is unchanged. Retake remains disabled until D19/A3 can prove a
committed cut per reply rather than exposing a control that 409s on solo turns.
