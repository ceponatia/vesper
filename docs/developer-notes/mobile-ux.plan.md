# Mobile UX pass — clock visibility, privacy mode, touch/overflow defects

Status: active — W1–W4 all implemented 2026-07-19 (full gate green: lint,
cycles, typecheck, 2815 tests, jscpd); awaiting Fly deploy + on-device
verification before shipping.

Branch: `mobile-ux` (worktree off `engine` @ 530751f — matches the deployed build).

Source: 2026-07-19 four-agent mobile audit (chat-lane code audit, rest-of-app code
audit, chat-clock deep-dive, live Fly walkthrough) + owner rulings settled in the
same session. Verification surface is the Fly deploy at a ~390×844 viewport
(`docs/deployment.md`, uxtest account).

## Owner rulings (2026-07-19, settled in-session)

1. **Clock placement.** The "story starts on…" anchor editor moves out of the
   Roster sheet into **Scenario setup** (`chat-scenario-modal.tsx`); the Roster
   sheet drops the clock card entirely. The desktop right-aside clock card stays
   (display + skip chips); its date tap opens the same rebuilt editor dialog.
2. **Calendar-grid picker, not dropdowns.** The anchor editor becomes a themed
   month-grid calendar (new `ui/date-picker.tsx`): weekday column headers so the
   weekday is visible by construction, ‹ › month paging (year rolls over
   naturally; small year stepper for big jumps), a live weekday-first summary
   line ("**Friday**, January 5 — 8:00am"), and on desktop a typed date field
   that parses free-form input and echoes the resolved weekday. **No native
   `<input type="date">`** — iOS renders a wheel with no weekday, defeating the
   point. No weekday→year back-computation; awareness is the goal, not
   weekday-first entry.
3. **Ambient time chip.** The mobile status strip gets a weekday-first story-time
   chip ("Fri · 2:10pm") always visible during play, so the player can't
   silently disagree with the narrator about what day it is (the narrator prompt
   already carries the weekday every turn). Tap opens Scenario setup.
4. **Privacy mode (desktop-visible toggle, persisted, default off).** When on:
   the left-aside standing portrait collapses to nothing (page background —
   *no* "[hidden]" chip), feed avatars render the character's first initial as a
   monogram instead of the image, scene images are hidden entirely, and the
   scene-image strip/dropdown is removed while active (no point showing it).
5. **Editor saves.** Autosave (existing `useAutosave` hook, shipped in
   ux-improvements slice 7) extends to the two editors that missed it: the
   **location editor** and **social-card editor**. The **forge pages keep
   explicit save** — the SaveBar is the review-acceptance step for staged ✦
   drafts, by prior ruling. The SaveBar itself still gets repositioned above the
   mobile bottom tab bar everywhere (it remains the status line + forge review
   button).

## Work packages

**W1 — Clock rework + chat chrome** (`ui/date-picker.tsx` new,
`chat-clock-card.tsx`, `chat-scenario-modal.tsx`, `chat-status.tsx`,
`chat-pickup-strip.tsx`, `chat-conversation.tsx`, `app-shell.tsx`): rulings 1–3,
plus suppressing the global app-shell top header on `/chat/:chatId` (it stacks
~100px of chrome over the chat's own header; the bottom bar is already
suppressed there) and rendering time-skip landing previews inline (they are
`title`-tooltip-only today — invisible on touch).

**W2 — Editor save + dialog/header defects** (`ui/save-bar.tsx`,
`ui/dialog.tsx`, location/social-card editors, editor header rows): ruling 5;
`Dialog` gets a viewport height cap + internal scroll (tall dialogs currently
push their own footer buttons off-screen unreachably); editor header rows wrap
instead of overflowing on long entity names.

**W3 — Touch-target & overflow mechanical fixes** (`ui/button.tsx`,
`ui/textarea.tsx`, `chat-message.tsx`, `chat-state-tools.tsx`, `chats-page.tsx`,
`chat-scene-moments.tsx`, `gallery-page.tsx`, `world-forge-page.tsx`):
coarse-pointer minimum tap size for `Button size="sm"` (28px today, 33+ chat
call sites) and the message action row; `break-words` overflow guard on message
bubbles; scene-moment thumbnails get `overflow-x-auto`; character-sheet slider
rows wrap; chats-list row actions get real tap sizing over the full-card link;
composer textarea auto-grows (`field-sizing-content`); gallery ♥/✕ get
`.hover-reveal` (invisible on touch today); world-forge skeleton width fits the
viewport.

**W4 — Privacy mode + composer layout** (after W1/W3 land; touches the same
chat files): ruling 4, plus the live-walkthrough composer finding — at 390px the
message textarea is squeezed to ~153px because it shares its row with the
persona toggle, two icon buttons, and Send; on phones the textarea gets its own
full-width row with the controls beneath.

Deliberately skipped: session-lane-only issues (play-screen hover-only turn
actions, lore table, cast rows) — lane is headed for deprecation. A polish
bucket (11px text legibility pass, outfit-chip size, lightbox safe-area) is
deferred; resurrect via `deferred.plan.md` if wanted.

Live-walkthrough confirmations (2026-07-19, Fly deploy @ 390×844): clock absent
from persistent chat UI (Roster shows "Monday, January 1 · 8:20am"); character
editor header row overflows (455px scrollWidth vs 390 viewport — W2 fixes);
message actions ~24px (W3); character-sheet slider rows past the dialog edge
(W3); pickup landings hover-only (W1). No console errors. Also noted, deferred:
the chat Inspector menu item opens a new tab (debug-facing, inconsistent with
the other drawer items) and an axe sweep of unlabeled form fields — park both.

## Open questions

- **Session-lane navigation dead-end** — `/sessions/{id}` has no bottom nav, no
  back link, no title; only the wordmark escapes it. The lane is excluded from
  this pass by ruling, but a total dead-end may merit a minimal back-link
  exception. Owner call pending.
- The uxtest QA account no longer shows Tsukikage Onsen / Lysandra Vane (CLAUDE.md
  says it owns them) — only Cassandra, Sabrina Vale, Milo Finch + Corner Café.
  Data drift on Neon? Verify before trusting CLAUDE.md's QA-fixture note.
