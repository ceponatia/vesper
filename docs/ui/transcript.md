# The transcript

The message feed inside [conversation.md](conversation.md): its per-line actions, how a reply's
takes are surfaced, how message text is rendered, and how scrolling and pagination behave.

## Message actions

`MessageBubble`'s hover actions are:

- **Edit** and **Delete** — the poisoned-window recovery levers; both also reconcile the line's
  extracted memory ([../character-chat/post-turn.md](../character-chat/post-turn.md));
- **Rerun** on the user's own lines — re-sends that prompt, dropping everything after it and
  cancelling any in-flight reply. The server still drains and persists the cancelled reply, and
  the transcript reload reconciles;
- **Remember** — opens the "Remember this" dialog prefilled with that line, a pinned player fact
  ([../memory.md](../memory.md) §Pinned facts).

**Another take** sits on the last settled reply and streams the regeneration into the same bubble
in place: state rolls back to the pre-exchange snapshot and the old take's memory is retracted
server-side.

A **takes pager** (`‹ 2/3 ›`) sits in the footer of any reply with recorded takes. Switching is
display-only — state and memory reflect the last *generated* take. For **admins** the pager
carries a muted attribution label for the displayed take (`aion-2.0 · Player Agency Minimal v4` —
`narratorProvenanceLabel`, truncating with the full text on hover), so stepping through takes
shows which narrator model and which Prompt Lab revision wrote each one. A take with no recorded
provenance shows no label at all. A subtle **stopped** chip marks replies the player cut short.

Ready scenes anchored to a message render as **inline scene moments** — a thumbnail row
(`SceneMomentRow`, sharing the page's lightbox) under the line they illustrate. Un-anchored scenes
and those whose anchor dangles stay strip-only.

## World beats

On successor-engine chats, a `MessageBubble` branch renders **world beats**: a muted, centered,
non-bubble system line for travel, time-skip, scene-ended, item-handoff and performed-action
events — "You walk to the town square. · <landing>", "Time passes — it's now <landing>.", "You
hand Mira a small keepsake. · <landing>", "You rest a while. · <landing>".

A beat is an ordinary transcript row (`role: "assistant"`, `meta.worldBeat = { kind }`, the
phrased text on `content` stamped through the shared `formatSimLanding`); the transcript reload
after the command surfaces it. The **refusal** face stays on the world card
([world-card.md](world-card.md)), and the legacy lane surfaces its skips as toasts.

## Markup rendering

Message bodies on **both** sides render through the **markup span renderer**
(`components/characters/message-content.tsx` over the pure, unit-tested `message-markup.ts`,
which reuses `lib/message-spans` — there is no second parser):

- `*thoughts*` and `_italic_` show italic with the sigils hidden;
- `*Name: …*` comms read as a text message, the `Name:` label kept and the body italic;
- `((OOC))` gets an out-of-fiction amber aside, parens hidden;
- speech keeps its quotes and narration renders plainly; blank-line paragraph breaks survive; and
  an unterminated sigil mid-stream stays literal until it closes.

Because the outermost sigil wins, a `_…_` pair nested **inside** a span body — most commonly
quoted speech, `"it's _perfect_!"` — never becomes its own span. Every piece body therefore also
flows through `parseEmphasisRuns` (`lib/message-spans`, unit-tested), which italicizes the run
with the underscores hidden, and flips it upright inside an already-italic body (thought, comms,
OOC) as standard nested-emphasis typography. The exported transcript keeps the **raw** sigils, so
it stays markdown-compatible.

Narrator and character replies — not the player's own bubbles — additionally render as **in-bubble
per-speaker segments** (dialogue attribution: `chat-segments.ts` over `lib/segmenter`,
unit-tested). The `[Name]` tag is hidden behind a small accent speaker label, and in a one-on-one
an untagged **whole-line quote** attributes to the character just like a tag would. Segments stay
INSIDE the one reply bubble — the chat lane is "a story being told", not separate bubbles —
segment content still flows through the span renderer, and a segment that is solely a `*Name: …*`
comms line keeps its comms label rather than doubling it. Re-parsing the growing reply each
streaming render is cheap (the parser is pure) and the unterminated tail stays stable.

## Scrolling and pagination

Auto-scroll is **stick-to-bottom** (`components/chat/use-chat-scroll.ts` over
`lib/scroll-pin.ts`): it pins on new lines only while the
reader is already at the bottom, so scrolling up to reread stops the yanking and surfaces a **"Jump
to latest" pill**. A `ResizeObserver` on the content column re-pins as async content — scene
thumbnails, avatars — grows it after load; without it the initial view lands mid-transcript once
images finish, hiding the newest exchange below the fold.

The GET returns the newest **100-row page**. A **"Load earlier"** button at the top of the
transcript keysets older pages (`?before`,
[../streaming-api.md](../streaming-api.md) §Pagination) with the viewport held in place via a
prepend anchor — never yanked, and the `ResizeObserver` is suppressed during the restore frame. A
player-initiated exchange resets to the newest page and re-pins.

A stream that settles cleanly but delivered **zero tokens** — the server's first-token watchdog
tripping on a stalled provider, so no reply row persists — surfaces an explicit error toast
("<name> didn't reply") instead of the pending bubble silently vanishing.
