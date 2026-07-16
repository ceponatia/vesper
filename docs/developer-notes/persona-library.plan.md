# Persona library — the player as a first-class library entity (plan)

Status: **shipped — 2026-07-16** (all eight slices, branch `worktree-persona-library`).
Written the same day from an owner brainstorm ask. Supersedes the shipped
[player-character.plan.md](finished/player-character.plan.md), whose own Open
questions anticipated exactly this ("Multiple saved personas? … a clean future
extension on the same resolver") and whose `id: null` field was left as the
graduation seam.

> **Completion note.** Built as planned; the design below stands. What landed:
> `personaProfileSchema` + `personaToCharacterProfile`
> (`contracts/players/persona-profile.ts`), the `personas` table (migration **0051**,
> `(owner_id, title)` UNIQUE), CRUD with a typed 409 on title collision, the
> `/personas` library tab, the three-tab `PersonaEditor`, the `resolveChatPersona`
> ladder + the backfill that retired the blob (**0052** backfills, **0053** drops),
> the per-chat "Playing as" pick, and the player wardrobe + undressing fold.
>
> **Not run: `pnpm db:migrate`** — no local Postgres in the worktree; the Fly deploy
> applies 0051–0053. The persona **route** tests live in
> `app/api/library-routes.int.test.ts` and self-skip without a database, so they have
> **never executed** — run `pnpm test:int` against a migrated DB before trusting them.
>
> **Deviations from the plan, all deliberate:**
> - **Two migrations, not one.** Adding `default_persona_id` while dropping
>   `player_persona` on the same table is exactly the rename-vs-create prompt CLAUDE.md
>   says to stop on; split, each diff is unambiguous.
> - **The backfill is DML inside 0052, not a script.** 0053 drops the column and Fly
>   runs `db:migrate` unattended — a script would be one forgotten command away from
>   dropping the data. Backfilled ids are `gen_random_uuid()::text` (SQL can't make
>   cuid2; nothing validates id *format*).
> - **`ChatPlayerState.seeded`** — an addition the plan didn't foresee. See
>   [The player's wardrobe](#player-wardrobe-in-chat).
> - **The blob contract was deleted, not deprecated** (no readers left).
>
> **Follow-ups worth knowing:** the persona `avatar_image_id` column exists but no
> pipeline fills it; `voice` shipped always-on (the recommendation below); the
> `imageReveal`/POV consumer is [scene-pov-embodiment.plan.md](scene-pov-embodiment.plan.md)
> slices 2–4, now unblocked.

Topic slug `persona-library` (grep `persona` finds this plus
`contracts/players/persona-profile.ts`, `contracts/players/chat-player-state.ts` and
`server/players/persona.ts`). The scene-image consumer is a separate, dependent plan:
[scene-pov-embodiment.plan.md](scene-pov-embodiment.plan.md).

## What we're building

Promote the player from a **single inline blob** (`users.playerPersona` —
`{name?, persona}`, one per account, edited in `/settings`) to a **library
entity**: many saved personas, each with a body, a wardrobe, and a bio, picked
per chat. The character stops talking to a name and starts talking to *someone
with a body that the fiction can undress*.

Four things this unlocks that the blob cannot:

1. **Many personas, one name.** Play "Brian, 22" and "Brian, 40" without the
   library fighting over the name.
2. **A body.** Physical attributes from the existing registry — the prerequisite
   for POV scene images (the dependent plan).
3. **A wardrobe.** Equippable clothing like a character, with coverage — which is
   what makes "she pulls your shirt off" a *state change* rather than prose that
   evaporates.
4. **Per-chat embodiment.** Different persona per conversation.

**Deliberately NOT in scope:** personality, demeanor, drives, social cards,
schedule, relationships, traits, voice anchors, micro-exemplars. The narrator
never generates the player's dialogue — the player writes it — so every field
that exists to *voice* a character is dead weight on a persona. See
[Field selection](#field-selection-what-a-persona-keeps-and-why).

## Design principles

- **Reuse the character contracts through an adapter, never a fork.** The
  wardrobe seam, the attribute picker, the outfit editor, the appearance
  summarizer, and the exposure classifier all already exist and all already take
  a `CharacterProfile`. One adapter function buys all of them. jscpd is a gate —
  do not re-implement any of it.
- **Title is a database concern, not a fiction concern.** It exists so `name` can
  repeat. It must be **structurally impossible** for it to reach an agent — not a
  rule, a shape (see [The title field](#the-title-field)).
- **Coverage is computed, never toggled.** The player's exposure comes from worn
  items' coverage via the session classifier (`items/visibility.ts`). No manual
  "exposed" flag on the player — that flag exists on characters only as the
  free-text-path fallback, and the player has no free-text path.
- **Chat lane only.** The session lane already embodies the player as a real
  library character (`worlds.playerCharacterId`, `spawn.ts` `playerOutfitIds`) —
  a different, older answer to the same question. Per CLAUDE.md product
  direction, chat leads and the lanes stay separate. Convergence is a later
  question, and this plan's adapter is the seam that would serve it.
- **Resilience rules apply.** Every read `parseOr`s; a missing/garbage persona
  degrades down a ladder to the account name, never a failed turn.

## Storage

### The `personas` table

Mirrors `characters` (`schema.ts:127-162`) minus the character-only columns:

```ts
export const personas = pgTable(
  "personas",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    /** Per-owner-unique library label. NEVER reaches a prompt — see the plan. */
    title: text("title").notNull(),
    /** The in-fiction name characters address. Freely repeatable across personas. */
    name: text("name").notNull(),
    profile: jsonb("profile").notNull().default({}),  // PersonaProfile
    tags: jsonb("tags").notNull().default([]),
    avatarImageId: text("avatar_image_id"),
    searchEmbedding: vector("search_embedding", { dimensions: 1536 }),
    embedder: text("embedder"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("personas_owner_title_unique").on(t.ownerId, t.title)],
);
```

Notes:

- **No `visibility` / `clonedFromId` in v1.** A persona is *you*; public sharing
  is not an obvious want. Additive later if asked.
- The composite unique's **leading column doubles as the owner lookup index**, so
  no separate `personas_owner_idx` is needed — the same reasoning recorded at
  `schema.ts:914`/`976` for `session_participants_name_unique`.
- Precedent for `(scope, label)` uniqueness:
  `uniqueIndex("session_participants_name_unique").on(t.sessionId, t.displayName)`
  (`schema.ts:915`). There is no existing `(owner_id, X)` unique in the schema —
  this is the first, and it is a direct transposition.

### The title field

The owner's phrasing was "a title field as a primary key (under owner)". Made
concrete: **`id` stays the primary key** — every FK, image linkage, route param,
and `image_references` row already assumes an opaque id, and renaming a persona's
title must not orphan them. `(owner_id, title)` becomes a **UNIQUE constraint**,
which is what the requirement actually needs (no duplication errors) at no cost
to the entity conventions.

**Title never reaching an agent is structural, not a rule.** The resolver returns
`PlayerPersona`, and title is simply not a field on it:

```ts
export interface PlayerPersona {
  id: string | null;
  name: string;
  persona?: string;
  // …new fields below. `title` is deliberately absent.
}
```

Every prompt consumer already reads through that shape
(`chat-pipeline.ts:965`, `:1866`; `prompts/character-chat.ts:75-81`), so title
has no path to a prompt without someone adding a field. Back it with one test
asserting a persona whose title is a distinctive sentinel never appears in
`buildCharacterChatPromptParts` output.

**UX:** title is the library card label, name is the in-fiction name. The form
pre-fills title from name on first entry; a collision returns a typed conflict
the form renders inline ("You already have a persona titled 'Brian'"). Both
required.

### Field selection: what a persona keeps, and why

| Field | Keep? | Why |
| --- | --- | --- |
| `name` | ✅ | What the character calls you. |
| `bio` | ✅ | The blob's `persona` text, graduated. Who you are. |
| `attributes` | ✅ | The body. The whole point of the scene-image plan. |
| `speciesId` / `heritageId` / `bodyPlanId` | ✅ | Drive `realizedBodyForProfile` → `isAttributeApplicable`; without them `AttributePicker` can't decide which attributes apply. Default `human` / `humanoid`. |
| `intimateRegions` | ✅ | **This is where "male-oriented" lives** (`profile.ts:247`) — it is *data*, already, selecting which intimate anatomy the body has. No new vocabulary needed. |
| `bodyFeatures` | ✅ | Non-human morphology; free with the picker. |
| `outfits` | ✅ | The wardrobe presets the equip flow draws from (`profile.ts:318`). |
| `voice` | ✅ | The legacy free-text note (`profile.ts:186`). The narrator *does* describe the player's voice ("your voice goes rough") even though it never writes their dialogue. |
| `intimacy` | ✅ | **Re-purposed semantics** — see below. |
| `personality`, `drives`, traits, cards, schedule, relationships | ❌ | The narrator never voices or drives the player. |
| `voiceAnchors`, `microExemplars` | ❌ | Both exist to shape *generated dialogue*. The player writes their own lines. Dead weight. |

**`intimacy` means something different on a persona.** On a character it is "how
they read as a lover — preferences, temperament", surfaced to the narrator only
at the intimate exposure tier via `buildIntimateDispositionBlock`
(`profile.ts:188-196`). On a persona it is **what the player likes** — guidance
for how the NPC should treat them. Same gate (intimate tier only), different
framing, so it needs its **own block builder**, not a reuse:

- character → "This is how *they* behave in intimacy."
- persona → "This is what *they respond to*. Play toward it."

### The contract + the adapter

```ts
// src/contracts/players/persona-profile.ts (new, pure)
export const personaProfileSchema = z.object({
  bio: z.string().default(""),
  voice: z.string().optional(),
  intimacy: z.string().optional(),
  speciesId: z.string().default("human"),
  heritageId: z.string().optional(),
  bodyPlanId: z.string().default(DEFAULT_BODY_PLAN_ID),
  intimateRegions: z.array(z.string()).default([]),
  bodyFeatures: z.array(z.string()).optional(),
  attributes: z.array(attributeValueSchema).default([]),
  outfits: z.array(outfitPresetSchema).default([]),
});
export type PersonaProfile = z.infer<typeof personaProfileSchema>;

/** The ONE seam that lets every character-shaped consumer take a persona unforked. */
export function personaToCharacterProfile(p: PersonaProfile): CharacterProfile;
```

The adapter fills character-only fields with their schema defaults. That single
function is what lets these run **unchanged** on a persona:

- `resolveChatWardrobe(state, ownerId, profile, sink)` — `chat-wardrobe.ts:102`
  (reads `profile.outfits`)
- `characterAppearanceSummary(attrs, max, allowIntimate, profile)` — needs the
  profile for `realizedBodyForProfile`
- `sceneRevealAppearance(...)`, `identityAnchorSummary(...)`
- `AttributePicker` (`attribute-picker.tsx`) and `OutfitEditor`
  (`outfit-editor.tsx`) — both already pure props-in/callback-out, no
  `characterId` coupling

## The resolver ladder

`resolvePlayerPersona(ownerId)` becomes `resolveChatPersona({ chatId, ownerId })`,
degrading (never throwing) down:

1. The chat's `personaId` → a loaded, owned `personas` row.
2. The owner's `users.default_persona_id` → a loaded, owned row.
3. The account display name (`FALLBACK_PLAYER_NAME` = "the visitor" behind it).

**The legacy blob is migrated, then deleted.** CLAUDE.md is explicit — prefer
removing old code over wrappers. A one-time backfill script mints one persona per
user with a non-empty `users.playerPersona` (title = name, name = name,
`profile.bio` = the blob's `persona`), sets `users.default_persona_id`, then the
`player_persona` column is dropped. No permanent 4th rung.

## Player wardrobe in chat

Today `character_chat_state` is `(chat_id, character_id)`-keyed and the player has
no row — confirmed: there is **no** player clothing concept anywhere in the chat
lane. The player is *chat-wide* (one player, many roster characters), so their
state belongs on `character_chats`, where the other chat-wide state already moved
(premise, sceneMemory, clockMinutes).

**One jsonb column, not five.** Following the `sceneMemory` precedent ("rides ONE
jsonb column so field additions are never migrations") and the
forward-compatible-schema preference:

```ts
// character_chats
playerState: jsonb("player_state").notNull().default({}),
```

```ts
export const chatPlayerStateSchema = z.object({
  personaId: z.string().catch("").default(""),
  wornItemIds: z.array(z.string()).catch([]).default([]),
  outfitPresetId: z.string().catch("").default(""),
  /** Narrated-but-unowned garments ("a borrowed hoodie") — same ruling as the character path. */
  overlay: z.string().catch("").default(""),
});
```

**Structured-only — no free-text fallback, no manual `exposed` toggle.** A
persona is a library entity with real outfit presets, so the structured path
always applies. Exposure is always `exposedRegions(worn)`. This is what makes the
scene plan's coverage gate unfakeable.

**`seeded` — the field this plan missed.** Built and shipped; recorded here because
it is the one thing the design got wrong by omission. An empty `wornItemIds` is
ambiguous: it means **"not dressed yet"** before the wardrobe is initialized and
**"stripped"** after it, and those must not render the same way. Without the flag a
fresh chat — or a persona whose wardrobe was never authored — reads as *naked*, which
is a spectacularly wrong default once a scene image is looking at it. So:

- `seeded: false` ⇒ `playerWornIds` resolves the persona's **default outfit preset**
  rather than the empty list.
- It flips `true` on the first real change, so the seed materializes on a **write**,
  never as a side effect of a read (deliberately unlike the character side's
  `resolveSeededOutfit`, which heals during a load).
- Switching persona resets it to `false` — the worn list described the person who was
  wearing it, so the new persona arrives in their own clothes.

### Undressing

The archivist already sees the whole exchange — the player's input *and* the
reply — so **one field covers both directions** ("I pull off my shirt" and "she
tugs your shirt over your head"):

```ts
// chatArchivistSchema, sibling to the existing `outfit` (chat-archivist.ts:112)
playerOutfit: z.object({
  description: z.string().catch("").default(""),   // whole-look swap
  removed: z.array(...).catch([]).default([]),      // garment deltas
  added: z.array(...).catch([]).default([]),
}).catch({...}).default({...}),
```

Note the **absent `exposed`** — deliberate, per above.

The fold is a sibling to `foldOutfitProposal` (`chat-state.ts:1374`) and reuses
the existing pure reducer `applyWornGarmentChanges`
(`contracts/items/chat-wardrobe.ts:89`) verbatim — it takes
`{wornIds, worn, pool, change, overlay, sink}` and is already generic, with
nothing character-specific in it. The pool is the persona's `outfits` flattened,
minus what is already worn. Unmatched removals skip with a diagnostic; unmatched
additions ride the overlay — same rulings as the character path.

Two details that are easy to miss:

- **Runs once per exchange, at chat level.** `settleEnsembleMember` is per-member
  and deliberately doesn't apply deltas; the player fold belongs in the primary
  archivist path only.
- **It must join the rollback snapshot.** `character_chats.preExchangeScenario`
  is the "another take" rollback. If `playerState` isn't snapshotted there, a
  discarded reply leaves the player permanently undressed by a beat that no
  longer exists.

## Prompt seam

`prompts/character-chat.ts` already fences the persona as untrusted and renders
it as `About {name} (the person you're speaking with)` (`:1594-1627`, and the
ensemble twin at `:1963-2030`). Extend that block with:

- **What you're wearing** — the resolved garment phrase from
  `resolveChatWardrobe`, so the NPC can reference and remove it coherently.
- **Voice** — free-text, always on.
- **Intimate disposition** — gated to the intimate exposure tier, its own builder
  (see [Field selection](#field-selection-what-a-persona-keeps-and-why)).

The physical attributes do **not** all belong in the narrator prompt — that is a
wall of text for a body the narrator only glances at. Recommend a compact
appearance line via the existing `characterAppearanceSummary` on the adapted
profile, and let the *scene-image* plan consume the full set.

## Build order

1. **Contract + adapter** — `personaProfileSchema`, `personaToCharacterProfile`,
   unit tests on the adapter. Pure; no DB.
2. **Table + migration** — `personas` in `schema.ts`, barrel export, kind unions
   (`LibraryKind` at `memory/library-search.ts:10` + both `TABLE_NAMES` maps —
   `api/library.ts:20-25` and `library-search.ts:18`); `pnpm db:generate` →
   review SQL → `pnpm db:migrate`. **Owner runs `db:generate`** (a new table is
   exactly the ambiguous create-vs-rename case CLAUDE.md says to stop on).
3. **CRUD routes** — `api/personas/route.ts` + `[id]/route.ts`, modeled on
   `items`/`locations` (simpler templates than the `characters` tree). Typed 409
   on title collision. `personasApi` in `lib/client/api.ts`.
4. **Library UI** — `/personas` page, `LibraryEntity` union + `configs` entry +
   `LIBRARY_TABS` row (`entity-library.tsx:293`), `/personas` into
   `LIBRARY_DEST.match` (`nav-links.ts:20`).
5. **Editor** — `PersonaEditor`, tabs: Profile (title/name/bio/voice/intimacy) ·
   Body (`AttributePicker scope="body"`) · Wardrobe (`OutfitEditor`). Both
   pickers embed as-is.
6. **Resolver + backfill** — `resolveChatPersona` ladder, `users.default_persona_id`,
   backfill script, drop `users.player_persona`, retire the `/settings` form for a
   default-persona **picker**.
7. **Chat pick** — `character_chats.playerState.personaId`, a "Playing as" select
   in `ChatScenarioModal` (`chat-scenario-modal.tsx` — the chat-wide config
   surface, alongside premise), defaulted from the owner's default persona.
8. **Player wardrobe** — `playerState` worn list, `playerOutfit` on the archivist +
   prompt rule, the fold, the rollback snapshot, prompt seam. Degradation tests.

Slices 1–5 are the library and stand alone (a persona you can build but not yet
play as). 6–8 are the chat wiring. The dependent scene work is
[scene-pov-embodiment.plan.md](scene-pov-embodiment.plan.md).

## Open questions

- ~~**Narrow `PersonaProfile` + adapter, or a full `CharacterProfile`?**~~ **Ruled
  2026-07-16 (owner): narrow + adapter.** Built as
  `contracts/players/persona-profile.ts`. One refinement found in build: the adapter
  parses **through `characterProfileSchema`** rather than spreading a hand-written
  defaults object, so a new character field can never silently leave it behind; its
  optional fields are conditionally spread, because zod keeps an
  explicitly-`undefined` key and the output must be indistinguishable from a normal
  parse.
- ~~**Keep a default persona at all?**~~ **Built: yes** (`users.default_persona_id`),
  the ladder's middle rung — one-time setup still works and the per-chat pick is an
  override, not a chore on every new conversation. Shipped on the recommendation; say
  if the `/settings` picker should go away and every chat should pick for itself.
- ~~**Is `voice` always-on, or intimate-gated like `intimacy`?**~~ **Built: always-on**
  — a voice is a voice; intimacy is merely where it matters most. Worth revisiting only
  if it proves noisy in ordinary scenes.
- ~~**The persona's `intimacy` has no gate, only wording.**~~ **Fixed 2026-07-16 (owner
  ask): the chat lane now has a real gate**, `chatSceneIsIntimate`
  (`contracts/turns/chat-intimacy.ts`) — either party's coverage-computed bare state, or
  arousal ≥ 0.55. Below it the note is zero tokens rather than text the model is asked to
  ignore. It served both lanes as predicted: the same gate finally surfaces the
  **character's** `profile.intimacy` + species archetype in chat, closing the leftover
  [intimacy-notes.plan.md](intimacy-notes.plan.md) §Chat-lane port recorded. This plan's
  slice 8 is what made it possible — the player's coverage is one of the three signals,
  and before the player had a wardrobe the gate would have been half-blind.
- **Persona avatars?** The column exists, unused — **still open**. The scene plan needs
  *attributes*, not a portrait, and a player portrait implies symmetric rendering (a
  whole arc — `avatar-3d.plan.md`). Deferred, column kept.
- ~~**Migration number.**~~ **Resolved: this took 0051–0053** — `0051` creates
  `personas`, `0052` adds `default_persona_id` + `player_state` **and backfills the
  blob**, `0053` drops `player_persona`. Split because one users-column add beside a
  users-column drop is the ambiguous rename case. [chat-meter-economy.plan.md](chat-meter-economy.plan.md)
  is now **0054+** (its doc still says 0052 — repoint it when that plan starts, rather
  than churning it again from here).

## Related

- [finished/player-character.plan.md](finished/player-character.plan.md) — the
  shipped blob this supersedes; its Open questions called this shot.
- [scene-pov-embodiment.plan.md](scene-pov-embodiment.plan.md) — the dependent
  consumer: persona body + coverage → POV scene images.
- [chat-wardrobe-parity.plan.md](chat-wardrobe-parity.plan.md) —
  the character-side wardrobe this mirrors; `chat-wardrobe.ts` is the seam and
  `applyWornGarmentChanges` the reducer, both reused whole.
- `src/server/engine/spawn.ts` (`playerOutfitIds`), `worlds.playerCharacterId` —
  the **session** lane's older answer to player embodiment. Kept separate.
- [world-engine-refactor.plan.md](world-engine-refactor.plan.md) — the successor
  umbrella; an embodied player is a piece of that north star.
</content>
