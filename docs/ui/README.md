# UI

Next.js App Router pages + React 19 + Tailwind 4. Aesthetic: quiet dark "reading room" — ink
background, warm paper accents, serif narrative type (`Source Serif 4` or similar variable
font), sans UI chrome. Design tokens in `globals.css` `@theme`; no component library — small
owned primitives in `apps/web/src/components/ui/`.

## Reading order

| Doc                                | What it covers                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| [pages.md](pages.md)               | The route map, the global header, and the account menu                       |
| [library.md](library.md)           | Library grids, facets, editors, pickers, the portrait studio, the outfit tab |
| [conversation.md](conversation.md) | `/chat/:chatId`: layout, header, scene section, asides, bottom cluster       |
| [transcript.md](transcript.md)     | Message actions, takes, world beats, markup rendering, scrolling, pagination |
| [world-card.md](world-card.md)     | The successor lane's "Where you are" panel: travel, handoffs, activities     |
| [mobile.md](mobile.md)             | One responsive tree: breakpoints, nav modes, the `Sheet` primitive, touch    |
| [conventions.md](conventions.md)   | Data flow, drafts, polling, modal sizing, contrast, model dropdowns          |
