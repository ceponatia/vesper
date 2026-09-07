# The conversation page

`/chat/:chatId` (`components/chat/chat-conversation.tsx`,
[../character-chat/README.md](../character-chat/README.md)) is the full-screen play surface.

Below `md` it is a mobile-first single column filling the full viewport (`h-dvh`) — the global
app header is suppressed on this route at that width, so this page's own header is the only
chrome — reverting to `calc(100dvh - 3.25rem)` at `md`+ once that header returns (see the
`app-shell.tsx` comment). The transcript scrolls internally and the composer is pinned to the
bottom edge with iOS safe-area padding; the bottom tab bar is suppressed on this immersive route
at every width.

It is **chatId-driven — the conversation always exists**, created from the Chats hub or the
New-conversation dialog; there is no lazy create. One `GET /api/chats/:chatId` envelope settles
the screen: transcript, chat header (title, archived), and character card (name,
`avatarImageId`, `chatModel`).

The transcript itself is [transcript.md](transcript.md); the successor lane's travel panel is
[world-card.md](world-card.md).

## Component ownership

`ChatConversation` composes the page and owns shared header, world, light-state, dialog,
privacy, and scene-fetch/poll state. It applies the exhaustive `PER_CHAT_DEFAULTS` reset to
page and hook state when the transcript owner's chat identity changes.

- `use-chat-transcript.ts` owns bootstrap, transcript rows, paging, reconciliation, and the
  current visit identity shared by asynchronous work.
- `use-chat-exchange.ts` owns optimistic replies, stream settlement, pacing, Stop, rerun,
  continuation, and take selection. It uses the transcript owner's rows and identity.
- `use-chat-scroll.ts` owns viewport refs, prepend anchors, pinning, and resize correction.
  Its chat-switch layout reset runs before its scroll correction.
- `chat-transcript.tsx` renders rows and scene moments using the page's privacy flag and
  scene list. `chat-composer.tsx` renders and edits the page-owned draft, register, and
  staged attachments. Neither starts another privacy state or scene poll.
- `chat-conversation-menu.tsx` owns menu presentation, the desktop popover, and rename form.

## Header row

A back link to `/chat`, a small portrait (tap → the portrait lightbox), the character name plus
chat title (the auto-title is the character's name when the title is empty), and a persistent
admin-only **`TEST PROMPT · <name> v<n>`** badge whenever this conversation is on a Prompt Lab
prompt (`narrator-prompt-badge.tsx`, linking to that template in the Lab). The badge sits
deliberately outside the closed menu, because an override nobody remembers turning on is how
prompt-specific behavior becomes a false production bug report.

The **menu** — a bottom `Sheet` under `md`, an AccountMenu-style popover at ≥`md` — holds:

- the **narrator model** select (the same curated list and serialized save-on-pick as the editor
  tab);
- the admin-only **Narrator instructions** select
  (`components/chat/narrator-prompt-select.tsx`): which saved Prompt Lab prompt replaces the
  narrator's behavior/craft instructions for THIS conversation, or Vesper's production prompt. One
  read serves both this control and the header badge, so the two cannot disagree;
- **Scenario setup**;
- **Relationship**, which opens the panel below;
- **Character sheet** — the primary's per-character sheet; tapping any roster member's name opens
  THEIR sheet, the same component, `?characterId=`-targeted. It holds axes and texture toward the
  player, meters, conditions, mind note, loops, a **structured Wardrobe editor**
  (`components/characters/chat-wardrobe-editor.tsx`: a preset switcher that dresses her in a named
  look plus per-slot equip/remove over the worn item ids, reusing the outfit tab's slot,
  EntityPicker and `itemsApi` primitives, plus the free-text overlay for ad-hoc garments and the
  exposed-flag fallback used only when nothing is equipped), and a presence toggle at roster > 1.
  The engine readouts — pulse trace, cue-split, memory trace, chat clock, next-turn memory queries
  — are **admin-only**, the same role check as the Inspector;
- an **Inspector** item (admins only) navigating to `/chat/:chatId/inspector`, the memory
  inspector; its `/api/admin/chat-inspector` family is role-gated server-side so it works on the
  deployed build ([../character-chat/api.md](../character-chat/api.md) §Admin routes);
- a **"Let time pass"** chip row (Moments / Hours / Overnight / Days → `POST …/time-skip`, hidden
  on archived chats);
- **Rename** (PATCH `title`), **Archive/Restore**, and **Delete chat…** (confirm dialog → hard
  delete → back to `/chat`).

## Scene images

A collapsible section under the header holding the scene strip, **collapsed by default at every
width**. The toggle is remembered in component state only, and the section heading lives on the
disclosure toggle. The strip's own header row is the Generate button plus a **scene-model
dropdown** — save-on-select through the state PATCH, serialized against rapid picks like the
narrator pick, and **reference-capable models only**
([../images/pipelines/scene-images.md](../images/pipelines/scene-images.md) §The scene model
pick); the picker seam remains for further reference models.

Each non-pending tile carries a hover-reveal **✕** (the same idiom as the gallery tiles) →
confirm dialog → `DELETE /api/gallery/:id`, a full delete of row and file. Because the strip and
the inline transcript moments render from the page's one shared scene list, the image leaves both
— and the Gallery — at once; failed tiles are deletable too, clearing the clutter of a dead
render.

The conversation page owns **one** scene fetch and poll shared by the strip and the inline
transcript moments; `SceneStrip` is presentational over that list — it renders and queues, never
fetches. The poll arms while the GET's **`rendering`** flag is true (a live `chat_scene_image`
job) **or** a pending row exists. The flag is what covers the slow composer step before the
pending image row lands, so a queued render's "Painting…" tile resolves live instead of sitting
until a manual refresh, and an auto-queued or mid-compose-refreshed render still shows the tile
with no local click state.

## Standing portrait

At ≥`lg` the character's `AvatarPanel` portrait sits in a fixed column to the **left of the
transcript**, using the desktop side real estate (`w-52`, `w-64` at ≥`xl`), clickable to enlarge.
Below `lg` the column is hidden entirely — phones reach the full-size portrait by tapping the
**header portrait** or any reply's **circular avatar** (`MessageBubble`'s optional
`onEnlargeAvatar`, passed only when an avatar image exists). All three affordances open the
**same** shared `ImageLightbox`, one instance at the page level.

## Privacy mode

A client-side toggle persisted in `localStorage` (`vesper:privacy-mode`, default off —
`components/hooks/use-privacy-mode.ts`), for keeping the screen safe to have open around company.

On: the standing portrait collapses to nothing (page background, no placeholder chip) leaving a
quiet eye-off toggle in its place; the header portrait and every feed avatar swap the image for a
first-initial monogram (`EntityImage`'s `privacy` prop, deliberately distinct from the
missing-image fallback) and stop opening the lightbox; and the scene-image disclosure, its strip,
and inline scene-moment thumbnails are hidden entirely, so no scene lightbox is reachable either.

The primary toggle sits on the standing portrait (desktop-only real estate); the conversation ⋮
menu carries the same toggle with an on/off label so phones, which have no left aside, can reach
it too. `chat-conversation.tsx` owns the one boolean and passes it down to every consumer as a
prop.

## The right aside — the clock card

A mirror column on the **right** of the transcript (the same `hidden lg:flex` breakpoints and
widths). Its first tenant is the **Story time card**
(`components/chat/chat-clock-card.tsx`): weekday and date (year omitted), clock time, day-part
and "day N", and the four **skip chips** (Moments / Hours / Overnight / Days) right beside the
display that makes them legible. Each chip's tooltip previews its landing ("→ Friday evening"),
and the skip toast names where time landed.

Tapping the date opens the **"Story starts on…"** editor — a themed calendar-grid picker
(`CalendarStartDialog` over `ui/date-picker.tsx`: weekday column headers, ‹ › month paging, a live
weekday-first summary line, and on desktop a typed date field that parses free-form input) →
`ChatStateEdit.calendarStart`. Rebasing re-derives every displayed date, and the year exists only
to pin weekday alignment.

Scenario setup opens the same dialog from a "Story starts" row, so the anchor has two entry
points; on phones, where the aside is hidden, that is the only one — the **Roster sheet does not
show the clock**. The pickup strip's skip chips carry the same landing tooltips.

Below the clock, on successor-engine chats only, sits the **World card**
([world-card.md](world-card.md)).

## Bottom cluster

A slim scenario-premise line (tap → Scenario setup), then the status strip:

- an **ambient story-time chip** — weekday-first, "Fri · 2:10pm", tap → Scenario setup, always
  visible during play so the player cannot silently disagree with the narrator about what day it
  is;
- mood chip, affinity stage chip, and off-baseline meter pips;
- a read-only **outfit chip** — a compact garment summary via `outfitSummary` over the snapshot's
  resolved `outfitLabel` (the rendered worn garments plus overlay, falling back to the free-text
  `outfit` for legacy chats), tapping to expand to the full phrase with an `· exposed` marker when
  set, hidden when the outfit text is empty. Editing stays in the Character sheet; the roster panel
  shows the same per-member outfit as a small line under each name, carried on the GET envelope's
  roster rows.

Then the action affordances:

- a dismissable **"Pick up:" strip** on reopen (`ChatPickupStrip` — Continue is the no-op default;
  Later / Next morning / Days later fire a time skip);
- the one-tap **"Let _name_ speak" banner** when the page opened via a `?say=1` marker tap (sends
  a `continue` beat cued to exactly that open loop; with no loops standing — a milestone-keyed tap
  — it runs the full initiative opener instead; the param is stripped after read);
- the **Prompt _name_** opening-beat button (empty transcript only) and a quiet **Go on →** (idle,
  last line an assistant reply — a `continue` beat: no user bubble, the pulse is skipped, the
  archivist still remembers it);
- the **action chips** ("Offer a drink / Freshen up / Take a breather / Heat things up"), each
  carrying a tooltip `hint` saying what the tap does. A tap is a narrated `action_beat`: the
  character plays a small beat while the chip's deterministic state effect applies pre-narration,
  no player bubble, disabled while a reply streams, and the tapped chip shows a busy spinner;
- then the composer (Enter sends, Shift+Enter newline; a **bookmark button** opens the same
  "Remember this" dialog empty; **Stop** swaps in for Send while a reply streams — what already
  streamed persists as the reply).

A stage-change toast fires when the affinity stage moves.

The composer carries an **OOC assist**: typing `((` auto-inserts the closing `))` with the caret
left between them (Backspace on the empty pair removes both rather than stranding the `))`;
skipped when `))` already follows, and paste is untouched — only a literal `(` keypress triggers
it). While the caret sits inside a `((…))` block the textarea tints amber with an **OOC** badge
cueing that it is a note to the storyteller no one in the scene hears. Caret placement after the
auto-insert is deferred to the next animation frame (the controlled-textarea pattern), and the
in-block check is a cheap bracket-balance probe (`caretInOocBlock`), since the parser is
offset-free.

## Relationship panel

`components/chat/chat-relationship-panel.tsx`, in the shared `Sheet`: stage and affinity, the
history **sparkline**, **milestones** (glyph-badged by kind, newest first), unfinished business
(open loops), the **story so far** (rolling summary) with a **Rebuild from full transcript** lever
(`POST …/summary/rebuild`), and **Export** download links (md/json, with a memory-appendix
checkbox). One `GET …/relationship` settles it.

## Archived conversations

Archived conversations render read-only: a slim "Archived — restore to continue" banner with an
inline Restore, and composer and chips disabled. The server also 409s `chat_archived`.

## Scenario setup

The **Scenario setup** modal holds only the CHAT-WIDE fields: premise, the setting-wide
house-rule cards, the **"Auto-generate a scene at big moments"** toggle (writes `sceneAuto`
`"off"` | `"milestones"`,
[../images/pipelines/scene-images.md](../images/pipelines/scene-images.md) §Trigger and cast), and
a **scene-model** select mirroring the strip's dropdown. Outfit and exposure live on each
member's Character sheet.

It carries the scenario-preset loop: an **Apply preset** select (fills the chat-wide draft; Save
persists) with per-preset delete, and **Save as preset…** capturing the draft plus the primary's
current outfit and relationship as per-character seeds, applied only when a NEW conversation
starts from the preset. The **New-conversation dialog** offers **Start from preset**, seeded
server-side at create.

The character editor's Chat tab links here rather than embedding any of this
([pages.md](pages.md) §The character editor).
