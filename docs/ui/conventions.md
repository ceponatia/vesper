# UI conventions

- **Server components fetch; client components interact.** Data flows in through route handlers
  already shaped for the view — no client-side joins.
- **Client data layer:** plain `fetch` plus small hooks (the chat conversation's transcript and
  stream hooks). No react-query unless pain demands it.
- **Every async surface has a skeleton and an error state**; images always have the monogram
  fallback; missing or legacy data renders as absent, not broken
  ([../resilience.md](../resilience.md) §7).

## Contrast

Secondary-text tokens must clear **WCAG AA** on the dark surfaces they sit on: the faint
`--color-paper-500` is the AA floor (≥4.5:1 on `ink-800` cards and `ink-700` raised surfaces).
Do not reintroduce a dimmer body-text grey.

On top of that floor, an **opt-in high-contrast theme** (header toggle,
`components/shell/contrast-toggle.tsx`) sets `data-contrast="high"` on `<html>`, which
`globals.css` keys a `:root[data-contrast="high"]` block off to lift the quiet `paper` and `ink`
tokens further. The choice persists in `localStorage` and is applied **pre-paint** by an inline
script in the root layout, so there is no flash. The pure read/parse/apply path is
`lib/contrast-theme.ts`.

## Forms and drafts

Controlled state plus zod validation on submit; shared `Field` primitives; a sticky save bar with
dirty-state indication on long editors.

Editor drafts seed from fetched data **exactly once per entity**
(`components/hooks/draft-seed.ts`, applied during render): refetches and silent reloads never
clobber in-progress edits, and navigating between entities drops the stale draft until the new one
loads.

The chat conversation page seeds its transcript and header the same way, and goes one step
further. Because Next reuses the client component across `/chat/[chatId]` param navigations — a
switch is **not** a remount — a `chatId` change resets **every** per-chat item in the same render:
the transcript, the composer draft and staged photo ids, the narrator/OOC register, every busy
flag, and every open sheet or dialog. The list of per-chat items and their at-rest values lives
once in `components/chat/chat-conversation-state.ts` (`PER_CHAT_DEFAULTS`), which both the
`useState` seeds and the reset read, and the reset is keyed by that type so a new piece of
per-chat state cannot leak into the next conversation by omission.

Per-chat **refs** — the regard-band mirror, the scroll pin, the active-stream token — reset in the
matching `chatId`-keyed layout effect. Clearing the stream token also supersedes a reply still
streaming for the chat just left, so it cannot write over the new one.

## Polling

Background-job surfaces poll while pending through
`usePollWhile(active, tick, ms, { maxPolls? })` (`components/hooks/use-poll-while.ts`). The tick
is latest-ref'd so a fresh closure never restarts the interval, and `maxPolls` is the safety cap
(an entity-image generation poll, for example). Do not hand-roll `setInterval` poll loops.

## Modal width

Modal width is `Dialog`'s `size` prop (`components/ui/dialog.tsx`): `md` (default) for
confirmations and one-field forms, `lg` for pickers and reading surfaces, `xl` (desktop-wide,
`max-w-4xl`) for field-heavy sheets — the chat Scenario setup and per-character Character sheet
modals.

**Never override width via a `max-w-*` className.** `cx` is a plain join with no tailwind-merge,
so the caller's cap and the base cap both land on the element and stylesheet order picks the
winner: a `className="max-w-lg"` override silently renders at `max-w-md`.

## Model dropdowns

Curated model dropdowns (narrator, agent, chat) render through `ModelSelect`
(`components/ui/model-select.tsx`). Options come from the shared lists in
`lib/narrative-models.ts` and `lib/agent-models.ts`, and a value **outside** the list still
renders as its own option — the id as-is — so a legacy or env-override id is never silently
swapped.
