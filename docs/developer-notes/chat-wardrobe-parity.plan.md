# Chat wardrobe parity — structured worn-state in the chat lane

Status: **next** (queued 2026-07-13 by owner ruling; depends on
[ux-improvements.plan.md](ux-improvements.plan.md) slice 8 — named outfit
presets — shipping first; no code yet).

## Goal

Chat wardrobe today is one free-text string (`character_chat_state.outfit`) plus
a manual `outfit_exposed` toggle; the session lane has the full structured
model (item entities, coverage trees, layers, the exposure classifier in
`items/visibility.ts`). Owner ruling (2026-07-13): chat wardrobe reaches **full
session parity** — item-level worn state, computed exposure, and equip/unequip
editing inside the chat Character sheet.

This is the first concrete step of the broader direction (see `CLAUDE.md`):
**character chat is the test bed for what the world/session model will
eventually look like**. Porting the wardrobe model into chat is how it gets
proven on the future substrate.

## Build order (three rungs, shippable independently)

### Rung 1 — preset as real state

- Chat state stores the **active preset id** (from `profile.outfits`, the UX
  batch's slice 8) instead of only paraphrased text; free text remains as an
  override/fallback for ad-hoc looks.
- The narrator prompt and scene-image prompts render the preset's **actual
  garments** (subtype-led phrases, sensory lines) rather than the paraphrase.
- Outfit changes are whole-outfit swaps: the archivist's outfit-change tracking
  resolves a named preset ("changes into her work clothes" → the `work`
  preset), falling back to free text when nothing matches.
- The `outfit_exposed` toggle stays manual at this rung.

### Rung 2 — item-level worn list + computed exposure

- Chat state holds a list of **worn item ids** (seeded from the active preset).
- The archivist can propose **add/remove of individual garments** ("she slips
  off her jacket" → remove the jacket), rollback-safe via
  `pre_exchange_state`.
- **Per-region exposure is computed** from coverage via the session lane's
  classifier (`items/visibility.ts`) — the manual exposed toggle is replaced,
  and intimacy staging / sensory-focus blocks become coverage-accurate (the
  shared-implementation rule applies: reuse the classifier, never re-fork it).

### Rung 3 — equip/unequip UI (session-panel parity)

- The chat Character sheet gains per-body-location worn-state editing —
  equip/remove per slot, layer visibility — matching the session wardrobe
  panel's capabilities.

## Open questions

- **Narrated-but-unowned garments** — the narrator dresses her in something
  with no item entity ("a borrowed hoodie"). Mint a lightweight chat-scoped
  item, or keep a free-text overlay riding alongside the worn list?
- **Migration of existing chats** — existing free-text outfits: best-effort
  parse into items at rung 2, or leave legacy chats on the free-text path
  until the player re-dresses?
- **Scene-image keying** — `chat_look` cache keys on outfit+exposed today;
  rung 2 changes what "outfit" and "exposed" mean for `meta.lookKey` — decide
  the new key shape at build.

## Not in scope

- Locations, story threads, or any other session system in chat — this plan is
  wardrobe only; further parity steps get their own plans as the test-bed
  direction firms up.
- New wardrobe *vocabulary* (coverage locations, subtypes) — inherited as-is.
