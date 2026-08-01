# Chat wardrobe parity — structured worn-state in the chat lane

Status: **shipped — 2026-07-14** (all three rungs landed in one change; migration
0047). Completion note at the end.

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

## Open questions — RULED (2026-07-14, at build)

- **Narrated-but-unowned garments** — RULED: keep a **free-text overlay riding
  alongside the worn list**, no minted chat-scoped items for v1. The existing
  `character_chat_state.outfit` column is repurposed as that overlay (and the
  legacy whole-look fallback). The archivist's unmatched `added` garments append
  to it (`applyWornGarmentChanges` → `chat_wardrobe.add_overlay` diagnostic); the
  narrator/scene prompt renders `worn garments; overlay`.
- **Migration of existing chats** — RULED: **leave legacy chats on the free-text
  path** (empty `wornItemIds` + `outfit` free text). No sweep, no best-effort
  parse. `resolveChatWardrobe` self-heals: the first preset switch / equip action
  populates `wornItemIds` and the chat crosses to the structured path. The
  outfit-marker heal (`resolveSeededOutfit`) is retained for legacy rows whose
  `outfit` still holds comma-joined ids.
- **Scene-image keying** — RULED: the `chat_look` key is now
  `fnv1a(sorted worn ids | overlay text | coverage fingerprint | sorted appearance overlays)`
  (`chatLookKey`, `images/chat-look.ts`). The coverage fingerprint is the first
  letter of each region's coverage (`exposedRegions` → torso/pelvis/legs/feet),
  so the key tracks computed exposure rather than the old manual boolean. A
  legacy/free-text chat (empty worn list) keys on the overlay alone, so its key
  stays stable across the change.

## Not in scope

- Locations, story threads, or any other session system in chat — this plan is
  wardrobe only; further parity steps get their own plans as the test-bed
  direction firms up.
- New wardrobe *vocabulary* (coverage locations, subtypes) — inherited as-is.
- **Ensemble members' garment-level changes** — deferred: `settleEnsembleMember`
  is pure (no item-loading seam), so a member's whole-look `description` clears
  their worn list to free text and `removed`/`added` deltas are the primary's
  (IO-backed) path only. Members keep full structured worn state that the player
  edits in their sheet; only the archivist's per-member auto-updates degrade.
  (Half closed 2026-08-01: a member's description naming an authored preset now
  re-seeds their worn list exactly like the primary — no item load needed. The
  garment-level deltas remain the primary's path.)

## Completion note (2026-07-14)

Built as one change, all three rungs.

- **State (rung 1/2):** two new columns on `character_chat_state` (migration
  0047) — `worn_item_ids` (jsonb string[]) + `outfit_preset_id` (text). `outfit`
  is repurposed as the free-text overlay/fallback; `outfit_exposed` retained,
  authoritative only on the free-text path. `seedChatState` seeds `wornItemIds`
  from the default preset directly (the id-marker hack is gone for new chats).
  Both fields ride `storedChatStateSchema` ⇒ rollback-safe.
- **The seam:** `src/server/engine/chat-wardrobe.ts` — `resolveChatWardrobe` is
  the ONE place worn state → rendered garment phrase + coverage-computed exposure,
  reusing `wardrobeOutfitText` + `exposedRegions` (session renderers). Consumed by
  the narrator prompt (`promptStateSlice`), the scene image (`queueChatScene` →
  `renderCharacterSceneImage` now takes an `exposure` override), and the look key.
  `resolveSeededOutfit`/`seededOutfitMarker` moved here from `chat-state` to keep
  the load direction one-way (chat-state → chat-wardrobe → images).
- **Archivist (rung 1/2):** `chatArchivist.outfit` gained `removed`/`added`
  garment arrays. `foldOutfitProposal` (finalize): a `description` naming a preset
  seeds the worn list (rung 1); an unmatched description is a free-text full
  replacement; `removed`/`added` fold through the pure
  `applyWornGarmentChanges` (contracts) against the loaded worn items + preset
  pool — unmatched removals skip (diagnostic), unmatched additions → overlay.
- **Exposure (rung 2):** `intimateRegionsBare` + shared `FULLY_COVERED` in
  `contracts/items/visibility.ts`; the manual toggle is superseded by computed
  coverage wherever items are worn.
- **UI (rung 3):** `components/characters/chat-wardrobe-editor.tsx` — per-slot
  equip/remove + a preset switcher + the overlay/exposed fallback, reusing the
  outfit-editor's slot + `EntityPickerDialog` + `itemsApi` primitives (NOT the
  session `participant-card`, which is item-instance-coupled and prod-404'd).
  Wired into the Character sheet (`chat-state-tools.tsx`); the read-only strip
  chip reads a new resolved `outfitLabel` on the snapshot.
- **Tests:** pure — `contracts/items/chat-wardrobe.test.ts` (matcher + reducer +
  exposure, diagnostics asserted), updated `chat-look.test.ts` (new key shape) and
  `chat-state.test.ts` (seed/rhythm/ensemble). Int —
  `engine/chat-wardrobe.int.test.ts` (archivist remove/add/preset-swap + rollback).
