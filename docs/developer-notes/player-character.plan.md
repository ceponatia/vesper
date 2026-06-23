# Default player character — profile/settings menu (plan)

Status: **shipped — 2026-06-23**. Built as recommended: inline persona blob on
`users` (`users.playerPersona`), one `resolvePlayerPersona` resolver, a
`/settings` page reached from the nav account menu, and the chat-prompt seam
folded in (the character now greets the player by name). The open questions were
resolved per the recommendations (inline storage; seam folded here; account-name
fallback; avatar deferred; single persona). Remaining/future: avatar for
symmetric rendering, "promote to a real library character" (the `id`-non-null
graduation), and the session-fallback convergence — none built yet.

Topic slug `player-character` (grep `player-character` finds this; it is the
graduated home of the "embodied player" section brainstormed in
[character-chat-state.plan.md](character-chat-state.plan.md) §"The embodied
player").

## What we're building

A **profile / settings menu**, reached by clicking the user's name in the nav,
whose first occupant is a **default player character**: a small, persistent
persona (name + a short bio/voice) that represents *the player themselves*.

- **Primary consumer: character chat.** Today the 1-on-1 chat addresses a
  faceless *"the user"* (`src/server/engine/prompts/character-chat.ts`, the
  *"address the user directly as 'you'"* rule). With a default player character,
  the character talks *to someone named*, with a little context about who they
  are. This is the immersion fix flagged as **UX-audit P1 / feature #1**.
- **Sessions keep library embodiment.** Picking a library character to embody is
  still the preferred path in sessions (`worlds.playerCharacterId` →
  per-session override → `{{player}}`). The default player character is **not**
  a session feature in v1; it's a chat-first, lightweight self-persona. Future
  convergence (the default persona as a *fallback* when no session/world PC is
  embodied) is noted but out of scope here.

This plan delivers the **menu, the storage, the editor form, and the
`resolvePlayerPersona` resolver**. The *consumption* — threading the persona into
the chat prompt and the light-state work — is the next roadmap item
([character-chat-state.plan.md](character-chat-state.plan.md)). See
[Scope & the boundary with character-chat-state](#scope--the-boundary-with-character-chat-state)
for the one thin seam I recommend pulling forward.

## Design principles

- **Light by default.** "Basic fields needed for character chat" = a name and a
  short persona. Not the full `CharacterProfile` (attributes, body model,
  schedule, outfit). Resist scope creep into a second character editor.
- **One resolver, one source of truth.** Every consumer reads the persona through
  `resolvePlayerPersona(ownerId)` — never the storage directly. When the storage
  grows (inline blob → real character), only the resolver changes.
- **Forward-compatible shape.** The `PlayerPersona` type already drafted in
  character-chat-state is the contract; v1 fills the light fields and leaves
  `id: null` as the seam to a real character later.
- **Resilience rules apply.** `parseOr` the stored blob at the read boundary;
  a malformed/absent persona degrades to a sensible default (the account display
  name), never a thrown turn (`docs/resilience.md`).

## Recommended storage — lightweight persona on the user (lead recommendation)

Store the persona **inline on the `users` row** as a single validated JSONB
column, *not* as a row in the `characters` table.

```ts
// src/contracts/players/persona.ts  (new, pure)
export const playerPersonaSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),   // overrides account name
  persona: z.string().trim().max(2000).default(""),    // short bio/voice
  avatarImageId: z.string().optional(),                // stretch; symmetric render later
});
export type StoredPlayerPersona = z.infer<typeof playerPersonaSchema>;
```

```ts
// schema.ts — add one column to `users`
playerPersona: jsonb("player_persona").notNull().default({}),
```

**Why inline-on-user over an FK to `characters`:**

| | Inline blob (recommended) | FK `users.defaultPlayerCharacterId → characters` |
| --- | --- | --- |
| Matches "basic fields for chat" | ✅ exactly | ❌ pulls in the whole profile |
| Library clutter | ✅ none | ❌ a "self" character shows up in `/characters` (needs a `kind` discriminator + list filtering everywhere) |
| Creation friction | ✅ a 2-field form | ❌ must mint a full character row |
| Forward path | ✅ `resolvePlayerPersona` later prefers a set FK over the blob — clean graduation | already there, but heavy from day one |
| Migration | one nullable column | new FK + discriminator + filters |

The inline blob is the literal realization of the
[character-chat-state.plan.md](character-chat-state.plan.md) `PlayerPersona`
shape: **`id: null` today (inline persona), a character id later** (when someone
wants symmetric rendering, an avatar pipeline, or to *embody this same persona in
a session*). That graduation is additive — add a `defaultPlayerCharacterId` FK,
and have `resolvePlayerPersona` prefer it when set. We don't pay for it now.

The FK approach is the right call **only** if you want the default player
character to be session-embodiable from day one — but you've said sessions prefer
library embodiment, so I'm recommending against it for v1. This is the one
decision I want your sign-off on (Open questions).

## The resolver — the seam everything reads through

```ts
// src/server/players/  (new module, barrel-exported)
export type PlayerPersona = {
  id: string | null;     // null in v1 (inline); a character id after graduation
  name: string;          // never empty — falls back to account name
  persona?: string;      // short bio/voice; undefined when blank
};

export async function resolvePlayerPersona(ownerId: string): Promise<PlayerPersona>;
```

- Reads the `users.playerPersona` blob, `parseOr(playerPersonaSchema, …, {})`.
- `name` = stored `name` ?? account `name` (always non-empty).
- `persona` = stored `persona` trimmed → `undefined` if empty.
- Pure-ish server module under `src/server/players/index.ts`; respects the module
  boundary rules (no component imports it; consumers go through the barrel).
- This is the **single** function the chat route, the future session fallback,
  and any "speaking with {name}" rendering call. Mirrors the role `bundle.ts`'s
  `bundlePlayerName()` plays for sessions.

## UI — the profile/settings menu

**Entry point.** Today `src/components/shell/account-menu.tsx` shows the name +
a Sign-out button, with no click target. Turn the **name into a button** that
opens a small popover menu:

```
[ Brian ▾ ]
  ├─ Player character        → /settings (Player character section)
  ├─ Settings                → /settings  (placeholder for later)
  └─ Sign out
```

Reuse the existing `<Dialog>`/popover patterns from `src/components/ui/`. A
lightweight popover anchored to the name button is enough; no new menu library.

**The page.** A new `/settings` route (`src/app/settings/page.tsx`) — the app's
first settings surface, so keep it a simple single-column page with sectioned
cards. v1 has one section: **Player character**.

**The form** (a focused form, *not* the tabbed `character-editor`):

- **Name** — `<Input>`, placeholder = the account name (so blank ⇒ "use my
  account name").
- **About you / persona** — `<Textarea>`, the short bio + voice the character
  sees. One field; keep it conversational ("a couple of sentences on who you are
  and how you come across").
- *(Stretch)* **Avatar** — reuse the portrait-studio/avatar-image pipeline later
  for symmetric rendering in chat. **Defer from v1.**

Use the standard `<Field>` wrapper + `<Button busy>` save, matching every other
editor. A small **preview line** — *"Akari will know you as **{name}**{, who
…persona}"* — makes the effect legible.

**Mutation.** `PATCH /api/users/me` (new), `withUser`-wrapped, body validated by
`playerPersonaSchema`, writes the `playerPersona` blob. Follows the
character/world PATCH convention exactly (`src/server/api/schemas.ts`).

## Scope & the boundary with character-chat-state

The roadmap says the persona "will be passed into the character chat in the
**next** roadmap item." I agree the **light-state** work
(meters/affinity/mindNote/reaction-pulse) belongs to
[character-chat-state.plan.md](character-chat-state.plan.md). But a default
player character with **no consumer is untestable**, so I recommend pulling
**one thin seam** forward into this plan:

- **Thread `resolvePlayerPersona` into the chat prompt.** Add a `player?: {name,
  persona?}` field to `CharacterChatPromptInput`; the chat route
  (`src/app/api/characters/[id]/chat/route.ts`) resolves it and passes it;
  `buildCharacterChatSystemPrompt` swaps the bare *"the user"* phrasing for
  *"You are speaking with {name}{, who is …persona}; address them as {name}."*

That single seam is exactly **build-order step 2** in character-chat-state
("Player-persona placeholder — `resolvePlayerPersona` stub + prompt seam"). With
it folded here, this plan ships an **end-to-end, demonstrable** feature (create
yourself in settings → the character greets you by name), and the next item is
freed to focus purely on *state*. Everything else in character-chat-state stays
where it is.

If you'd rather keep the chat untouched until the next item, this plan still
stands on its own (menu + storage + resolver), but the only way to *see* it work
would be a unit test on the resolver. **I recommend folding the prompt seam in.**

## Build order

1. **Contract + storage** — `playerPersonaSchema` in `src/contracts/players/`;
   `users.playerPersona` column (schema → `pnpm db:generate` → review SQL →
   `pnpm db:migrate`).
2. **Resolver** — `resolvePlayerPersona` in `src/server/players/` + barrel; unit
   test incl. the empty/malformed → account-name fallback (a degradation test).
3. **PATCH route** — `/api/users/me`, `withUser`, zod-validated.
4. **UI** — account-menu popover → `/settings` page → Player-character form.
5. **Chat seam** (recommended, see scope above) — thread the persona into
   `buildCharacterChatSystemPrompt`; update character-chat-state build-step 2 to
   "done — see player-character.plan.md."
6. `pnpm verify`; commit `feat(player): default player character + settings menu`.

## Open questions

- **Storage shape — needs your call.** Inline blob on `users` (recommended,
  light, no library clutter) vs. an FK to a real `characters` row (heavier, but
  session-embodiable from day one). I recommend the blob and graduating to an FK
  later. **Confirm before step 1.**
- **Chat prompt seam — this plan or the next?** I recommend folding the thin
  prompt seam in here for testability (above). Confirm.
- **Name fallback wording** — when the user leaves name blank, characters use the
  account display name. Acceptable, or should we *require* a name in the form?
- **Avatar in v1?** Recommend deferring; symmetric rendering lands with the
  avatar arc ([avatar-3d.plan.md](avatar-3d.plan.md)).
- **Multiple saved personas?** v1 is a single default (the roadmap says "a
  default player character"). Multiple personas / per-character overrides are a
  clean future extension on the same resolver.

## Related

- [character-chat-state.plan.md](character-chat-state.plan.md) — §"The embodied
  player" graduated into this plan; the light-state work it scopes consumes the
  resolver built here.
- `src/lib/player-token.ts`, `src/server/engine/bundle.ts`
  (`fillBundlePlayerToken`, `bundlePlayerName`) — the **session-side** player
  resolution this mirrors at the user level.
- `worlds.playerCharacterId` (schema) — the world-level default-character analog.
- [ux-audit.plan.md](ux-audit.plan.md) P1 / feature #1 — the faceless-player
  immersion gap this closes.
- `docs/auth.md` — `getCurrentUser()` / `withUser` / `ownerId` patterns the
  PATCH route follows.
