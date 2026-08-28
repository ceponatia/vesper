# Pages and navigation

## The route map

```
/                        Dashboard: conversations lead ("Continue talking to…"; hidden until a chat exists), then the cast strip
/worlds                  Successor-engine front door (SuccessorWorldsPage): create and open successor-engine chats, each in its own fresh world
/characters              Library grid
/characters/forge        Prose prompt → draft review → save
/characters/:id          Character editor (below)
/personas                Library grid (the player as a library entity — cards show the per-owner-unique `title`, with the in-fiction `name` on the subtitle line)
/personas/:id            Persona editor: profile · body · wardrobe
/chat                    Chats hub (below)
/chat/:chatId            Full-screen conversation (mobile-first; [conversation.md](conversation.md))
/locations, /locations/:id   Lean library + editor (Details · Image tabs)
/items, /items/:id           Lean library + editor (Details · Image tabs)
/gallery                 Tabbed image hub — Scenes · Portraits · Entity art ([../images/pipelines/scene-images.md](../images/pipelines/scene-images.md) §The Gallery hub)
```

## The character editor

`/characters/:id` carries eight tabs: profile · attributes · personality (voice, presentation,
movement) · disposition · outfit · portrait studio · chat. The attributes tab is a registry
picker — a single-open accordion, all sections collapsed initially, every applicable attribute
shown blank-or-set, with body-config and feature overrides at the bottom of the same accordion.

The header carries **✦ Forge the rest** (fill every empty field from the sheet, never
overwrites — saves first, the result lands unsaved for review). Each content tab carries **↻
Re-draft tab** (rewrite that tab narrator-formatted from the whole sheet; manual attribute and
trait values kept, conflicts reported), and the Attributes tab adds **◉ From portrait** once a
ready avatar exists — a vision fill-blanks pass
([../authoring/README.md](../authoring/README.md) §In-sheet forge).

The **Chat** tab is a summary surface, not a play surface: playing happens on `/chat/:chatId`.
It holds a **Chat defaults** card — the narrator-model dropdown (curated `lib/narrative-models.ts`
list; picking saves immediately to `characters.chatModel`, serialized against rapid picks, and
the value is hoisted to the edit page so it survives tab unmounting) plus the authored
**Starting Relationship** stage and one-line note (`profile.playerRelationship`, riding the
editor SaveBar) — and a **Conversations** card listing this character's active chats
(title-or-auto, `timeAgo` stamp, last-line snippet, each linking to `/chat/:id`) with a **New
conversation** button opening the shared `components/chat/new-chat-dialog.tsx`.

## The chats hub

`/chat` (`components/chat/chats-page.tsx`) lists conversation rows — portrait, name and title,
snippet, mood and stage chips, relative time, and a **"has something to say" accent dot**
(`ChatSayMarker`, derived at read time from the row's top open loop, or with no loops the newest
milestone unseen since the chat was last opened via the `milestones_seen_at` cursor, stamped on
conversation mount; no jobs and never the wall clock). Tapping the dot opens
`/chat/:id?say=1`.

The hub carries Active and Archived shelves, rename/archive/delete actions, and **New
conversation** (`?new=<characterId>` opens the dialog pre-picked — the library-card entry
point). The dashboard's conversation rows carry the same marker.

## The global header

`components/shell/app-shell.tsx` links **Chats · Worlds · Library · Gallery** at ≥md.

**Library** is one nav entry spanning the five collection routes — `/characters` (its landing
tab), `/personas`, `/locations`, `/items`, `/social-cards` — which keep their URLs and share a
tab strip inside the library shell (`LIBRARY_TABS` in `entity-library.tsx`; Worlds stays its own
destination, no strip). The nav entry lights for any of them via `NavDest.match`
(`nav-links.ts`, `isNavActive` takes the dest). **Worlds** is the successor engine's front door.

At the right sits the **account dropdown** (`components/shell/account-menu.tsx`): the signed-in
name over a menu of **Settings**, then — for admins only — **Image generator**, **Image lab**,
**Image models**, **Narrator prompts** and **Engine Comparison**, then **Sign out**.

The five admin entries are standalone owner tools rather than account preferences, so they hang
off this menu instead of the Settings page, which keeps only the default-persona pick and
Identity trials. Every one of their pages re-checks the role and their APIs are role-gated
server-side, so hiding the links is tidiness rather than access control.

The menu renders at every width — it is part of the global header, which the immersive
conversation route suppresses below `md` — so the admin tools stay reachable on a phone. On
phones a bottom tab bar or hamburger drawer takes over ([mobile.md](mobile.md)). The Gallery is a
separate page; scene images never appear on the landing dashboard.
