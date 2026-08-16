# Chat supporting cast — recurring side characters + narrator input

Status: **shipped — 2026-07-13** (planned and built same day from an owner
report: in a chat with Bella, a mentioned coworker "Abby" was reacted to but
never *written for* — the narrator suppressed side-NPC agency by rule, and the
apart-camera rule 16 gave it no cast to populate the character's side of a
scene cut with. Leftovers: the §Deferred items below — cast images,
promote-to-character, the session-lane analogue.)

## What this is

Two features proven in the chat lane (the test-bed direction, `CLAUDE.md`):

1. **Supporting cast** — a lightweight tier for recurring named side
   characters (the player's coworker, the character's sister) that are NOT
   character entities and NOT romance targets. Exactly the scene-memory
   pattern applied to people: an accumulating, capped, `parseOr`-guarded
   structure on the chat-wide scenario, reconciled post-turn by the archivist,
   rendered as a compact volatile-tail block, and licensed by the rules so the
   narrator may voice and move these people (prose attribution, never a
   `[Name]` tag — the render contract is unchanged).
2. **Narrator input** — a composer toggle (player ↔ narrator) so the player
   can author story narration that is explicitly NOT their own POV: supporting
   NPCs speaking/acting, offscreen developments, general flavor. The system
   stops treating such input as "the player said/did this".

Full characters + the multi-character roster remain the promotion path when a
side character grows into real relationship state; the cast entry becomes seed
material then. Deliberately NOT built: per-cast-member state (meters, regard),
cast images (long-run desirable — parked), and any session-lane analogue.

## Design

### Contract (`src/contracts/turns/chat-supporting-cast.ts`, pure)

- `SupportingCastMember`: `{ name, relation, details[], voice?, whereabouts? }`
  — caps: ≤8 members, ≤6 details each, length caps per field; dedupe
  case-insensitive, oldest-out. `relation` is one phrase ("Riley's coworker and
  close friend"); `voice` how they talk; `whereabouts` where they usually are.
- `chatCastProposalSchema` — the archivist's lenient per-exchange proposal
  (`[{name, relation?, details[]}]`, bad values parse away).
- `mergeSupportingCast(cast, proposal, excludeNames)` — upsert by normalized
  name, details accrete (dedupe + cap), `relation` fills only when empty
  (author edits are canonical), `excludeNames` (roster + player) can never
  become cast members. Pure, tested.

### Storage

- New jsonb column `supporting_cast` on `character_chats` (default `[]`) —
  chat-wide like the rest of the scenario; rides `ChatScenario`,
  `chatScenarioSchema` (heals), seed/load/save, and the `pre_exchange_scenario`
  rollback anchor. **Post-ship fix (2026-07-13):** the cast is EXEMPT from the
  rollback itself (`rollbackScenario`, `chat-state.ts`) — the day-one owner
  test hit it: Abby, added via the panel after a reply landed, vanished when
  that reply was rerun, because the whole-scenario rollback restored a
  pre-Abby anchor. Regenerate/rerun now restore the anchor's clock/scene/skip
  fields while the LIVE cast wins (accrete-only + author-curated ⇒ nothing
  worth undoing); members only leave via the panel's Remove or the cap-of-8
  oldest-out eviction.
- `ChatStateEdit.supportingCast` (chat-wide half) — whole-array replacement,
  the UI's save surface; surfaced on `ChatStateSnapshot`.

### Archivist (field 10)

- `chatArchivistSchema.cast` + degraded default `[]`; prompt teaches: recurring
  NAMED people who are not the roster characters and not the player — introduce
  on first meaningful mention, attach durable details later; never one-scene
  walk-ons (a waiter), never invented. The build prompt lists the known cast
  (so details attach instead of re-minting) and the roster + player names (the
  exclusion). `finalizeChatState` merges via `mergeSupportingCast` beside the
  scene merge; ensemble path unchanged (the shared archivist already owns
  scene-level reads — cast is scene-level).

### Prompt law

- **"Supporting cast" volatile-tail block** (1-on-1 + ensemble), after Scene:
  one line per member (name — relation; details; voice; whereabouts) + the
  license: the narrator may write their dialogue and small actions in prose
  with plain attribution, may give them initiative consistent with what's
  established; they stay supporting (never steal the beat, never override what
  the player writes for them, never act FOR the player).
- **Rule 3 carve-out**: the "keep them unnamed and passing … never invent one"
  clause now applies to *incidental* people only; Supporting-cast members are
  the named exception. Ensemble rule 3 gets the same one-sentence carve-out.
- **Rule 16 extension**: on the character's side of a scene cut, supporting
  cast who'd plausibly be there may appear and carry threads with the character
  — the player's side stays unwritten (the original guard holds).

### Narrator input

- `POST /api/chats/:chatId` gains `inputMode: "player" | "narrator"`
  (default player, send-only). The user line persists byte-verbatim with
  `meta.inputMode: "narrator"`.
- **Model boundary**: history user-lines flagged narrator are wrapped (never
  stored) with a `[Story narration — authored by ${player} as storyteller,
  not ${player} speaking or acting]` header; the current turn additionally
  gets a one-turn tail note stating the perception partition does not apply
  (it is ground truth narration, may voice supporting cast, and the reply
  continues from it rather than answering it).
- **Static legend**: one prefix rule/legend line teaching the marker (both
  1-on-1 and ensemble rules).
- **Post-turn**: the reaction pulse is SKIPPED (no player act — same as a
  "go on" beat; regard/meters/feeling untouched). The archivist runs with the
  player half labeled as storyteller narration so facts are not attributed to
  the player's own speech/actions. Clock ticks normally; selfie offers can't
  fire (pulse-read gate); regenerate/rerun recover the mode from the stored
  meta.
- **UI**: a small You ↔ Narrator toggle by the composer; narrator mode tints
  the textarea, swaps the placeholder, and the sent line renders with a
  "Narration" label (meta-driven). Attach is player-mode-only.

### UI panel (dev/testing visibility — owner request)

`chat-supporting-cast-panel.tsx`, mounted below "In this story" in the desktop
aside AND the Roster sheet: the cast names as rows, "+ Add person", click →
lightbox dialog to view/edit name/relation/details/voice/whereabouts, with
Remove. Saves via the state PATCH (`editState`, chat-wide field) — 409
`chat_busy` surfaces as a toast mid-stream. Erroneous archivist entries are
deleted here; manual additions seed people before first mention.

## Open questions

_None open at build time. Rulings inline above (relation fill-if-empty; pulse
skipped on narrator input; attach disabled in narrator mode; cast images
parked)._

## Deferred

- **Cast member images** (owner: "not needed yet, long-run desirable") — a
  small portrait per member, likely the avatar pipeline's t2i route keyed off
  relation+details; parked until the tier proves itself.
- **Cast promotion flow** — one-tap "promote to character" prefilling a forge
  draft from the cast entry.
- **Session-lane analogue** — waits on the chat-successor direction.

## Cross-links

- [multi-character-chat.plan.md](../finished/multi-character-chat.plan.md) — the
  heavyweight tier this deliberately is not; roster names feed the exclusion.
- [npc-puppeting.deferred.md](../npc-puppeting.deferred.md) — puppet handling is
  about ROSTER characters; supporting cast is shared-authorship by design
  (narrator input is the sanctioned way to author non-player behavior).
- `docs/character-chat/supporting-cast.md` — §Supporting cast + §Narrator input (shipped docs).
