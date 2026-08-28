# Mobile

One responsive component tree — no separate mobile build. CSS breakpoints reflow the layout and a
few JS hooks switch behaviour.

There is **no user-agent sniffing**: "mobile" is screen width. `useIsMobile()`
(`components/hooks/use-is-mobile.ts`, `matchMedia("(max-width: 767.98px)")`, one hair under
Tailwind `md`/768) drives behaviour, and `md:` / `lg:` utilities drive layout. The root layout
exports a `viewport` with `viewportFit: "cover"`; the bottom bar and chat composer reclaim the iOS
safe area with `env(safe-area-inset-bottom)`.

## Primary nav

`app-shell.tsx`: at ≥`md` the horizontal top-nav shows. Below `md` it swaps to one of two chromes
chosen by a persisted **nav-mode** (`lib/nav-mode.ts`, default `tabs`):

- a fixed **bottom tab bar** (`bottom-tab-bar.tsx`) — Home · Chats · Library · Worlds plus a
  **More** bottom-sheet holding Gallery and the nav-style switch. Chats holds a primary slot, and
  Library covers the four collection routes via `NavDest.match`; or
- a **hamburger + left drawer** (`nav-drawer.tsx`).

`NavMode` is a two-value union, so exactly one chrome ever renders — "both" and "neither" are
unrepresentable. The switch (`nav-mode-toggle.tsx`) lives in both the More sheet and the drawer
footer, so you can always flip out of the current mode.

The bottom bar is **suppressed on the immersive surface** (`/chat/:chatId`, not the `/chat` hub)
so its fixed footer never collides with the composer; the hamburger lives in the header and stays
available everywhere.

## Sheet

`components/ui/sheet.tsx` is an edge-anchored modal (`side` = right / left / bottom) that shares
Dialog's overlay-click, Escape and focus-trap behaviour via the extracted
`components/ui/use-focus-trap.ts` (Dialog uses it too).

The trap focuses the panel **only on the open transition** — its own effect, keyed on `open`
alone, skipped when focus is already inside so an `autoFocus` child wins. Callers pass inline
`onClose` functions, so an effect that depended on `onClose` *and* called `focus()` would re-run
on every parent render and yank focus out of the input being typed in.

Sheet backs the nav drawer, the More overflow, and the conversation page's menu, relationship and
character-sheet sheets.

Its `fixed inset-0` overlay is **portalled to `document.body`** via `createPortal`. The nav drawer
mounts inside the `backdrop-blur` header, and a `backdrop-filter` / `transform` / `filter`
ancestor establishes a containing block for `position: fixed` descendants — without the portal the
overlay collapses to the header's height and the drawer body (links plus the nav-mode switch) is
clipped to a sliver, leaving an apparently-empty hamburger with no way back to the bottom bar.
`document.body` is always a clean viewport-sized containing block.

## Touch

All in `globals.css` under `@media (pointer: coarse)` / `(hover: hover)`:

- small controls opt into a ≥44px tap height with `.touch-target`;
- reveal-on-hover action clusters use `.hover-reveal` — always visible on touch, hover-gated only
  where hover exists (for example the portrait-studio variant actions);
- form fields are pinned to 16px on coarse pointers so focusing them never triggers iOS zoom;
- the dense `Tabs` strip (the 5-tab world and 7-tab character editors) scrolls horizontally and
  keeps the active tab scrolled into view.
