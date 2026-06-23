# Character chat — light state & the embodied player (brainstorm)

Status: **draft** — brainstorm / not settled. A menu of ideas for growing the
sessionless 1-on-1 chat ([finished/character-chat.plan.md](finished/character-chat.plan.md))
from a stateless transcript into a **light, fun, state-aware** quick chat that
reuses the contracts (meters incl. **hygiene**, affinity, conditions) without
dragging in the full session engine. Also scopes the **placeholder intake** for
a future profile-level *player character* the chat (and sessions) will default
to. Nothing here is committed; promote slices to their own `## Shape` once we
pick a v1.

Topic slug `character-chat-state` (grep `character-chat` finds this and the
finished plan together).

## Why now

The chat is "becoming quite fun as a 1-on-1 quick chat" but is intentionally
**stateless**: a flat `character_chat_messages` log, a lightweight
`streamCharacterChat` path, no meters / conditions / facts / affinity, and the
player is an unnamed *"the user"* (`prompts/character-chat.ts`). Two cheap moves
make it feel **alive** without becoming a session:

1. **Light state** — give the character a small, persistent state blob (meters,
   affinity, a one-line "what's on their mind") that drifts over time and reacts
   to the conversation, surfaced to the prompt the same way the narrator gets it.
2. **An embodied player** — stop addressing a faceless "user." Resolve a
   **player persona** (name + short bio) so the character talks *to someone*.
   Build only the resolver seam now; the full profile-level PC system lands later.

These are also already on the board: light state realises the deferred
**relationship & meter timeline** (UX-audit feature #4, [deferred.plan.md](deferred.plan.md))
at chat scale, and the embodied player is **UX-audit P1 / feature #1**
([ux-audit.intake.md](ux-audit.intake.md)).

## Design principles

- **Light by default, heavy never.** Chats are short and locationless. State is
  a few numbers + one sentence, not a world model.
- **Reuse contracts, add no vocabulary.** Meters/affinity/conditions are pure
  registries (`src/contracts`) that work standalone — a chat just carries a
  `Record<string,number>` and an `affinity:number`. No new meters, no migrations
  to the registries.
- **Deterministic spine, one optional LLM pulse.** Time-drift and stage math are
  free and pure. At most **one** small structured call per exchange reads the
  conversation for deltas — and degrades to drift-only if it times out
  (`docs/resilience.md`).
- **Keep the clean stream.** The plain-text reply stream stays as-is; state is a
  separate concern, never inlined into prose.

## Reuse vs. avoid

| Contract | Standalone? | Use in chat |
| --- | --- | --- |
| **Meters** (`meters/registry.ts`: hygiene, energy, mood, arousal, stress, intoxication) | ✅ pure algebra | **Yes** — carry a subset for the character; `applyMeterDrift` on a clock, `crossedThresholdHints` + `deriveMoodDescriptor` into the prompt |
| **Affinity / stages** (`relationships/stages.ts`, −100…100 → `hostile…smitten`) | ✅ single scalar | **Yes** — the romance arc made legible; `stageForValue` drives a chip + warmth hint |
| **Conditions** (`conditions/condition.ts`, self-expiring) | ✅ needs a clock | **Optional** — light texture ("tipsy", "flustered"); `attributeEffects`/`promptHint` reused |
| **Actions** (`actions/registry.ts`: shower/bathe/nap/share-a-drink) | ✅ data-driven | **Optional** — one-tap "offer" chips that nudge meters deterministically |
| **Attributes / body** | ✅ read-only | Already used by the chat prompt; no change |
| **Facts / RAG** (`facts/taxonomy.ts` + embeddings) | ❌ archivist-/vector-bound | **No** — replace with a one-line "mind note" (below) |
| **Perception / presence / threads** | ❌ session-/location-bound | **No** — out of scope for a 1-on-1 |

## The light-state model

One small persisted blob per `(ownerId, characterId)` — the chat's only memory
beyond the message window:

```ts
type CharacterChatState = {
  meters: Record<string, number>;   // subset of the registry: hygiene, energy, mood, arousal (+ intoxication if drinks)
  affinity: number;                 // −100…100, toward the player persona
  conditions: ActiveCondition[];    // optional, self-expiring on the chat clock
  mindNote: string;                 // 1–3 sentences: "what's on their mind" — the cheap memory
  clockMinutes: number;             // chat-local game clock (drift driver)
  lastInteractionAt: Date;          // wall-clock anchor for between-visit drift
};
```

- **mindNote** is the deliberate, light stand-in for facts/RAG: a couple of
  sentences the pulse keeps current ("She's still teasing you about the snow;
  warming up but guarded"). It rides in the prompt and carries continuity past
  the 40-message window without embeddings or a `facts` table.
  - **Complement, not duplicate** of the running **transcript recap** in
    [character-chat-summary.plan.md](character-chat-summary.plan.md): mindNote =
    current mood/disposition; that summary = factual recap of the older
    transcript. They converge — the summary's fold call can also emit the
    mindNote, and the summary lands as a column on this `character_chat_state`
    row when state ships. (That plan ships independently first.)
- **Clearing the chat resets the state** (it's the same conversation's memory).

### Time model — "they have a life"

Chat has no in-world clock, so synthesise one — this is where the *fun* texture
comes from cheaply:

- **Within a session:** each exchange advances the chat clock a small fixed
  amount (a few game-minutes) so meters drift gently as you talk.
- **Between visits:** map **real** elapsed time since `lastInteractionAt` to
  game-time (capped, e.g. ≤ a game-day per gap) and `applyMeterDrift`. Come back
  next morning and she's freshly bathed (hygiene high), rested (energy high),
  mood reset toward baseline; drop in at 3am and she's sleepy. Arousal/stress
  cool off. All free — it's the existing pure drift functions on a wall-clock
  delta. **Recommended: hybrid (both), capped.**

## The reaction pulse (the "advanced state tracking" engine)

To move state *from the conversation* (not just time), add one **small
structured agent** after the reply settles — far lighter than the session's
4-agent fan-out:

- Input: the last exchange + current state. Output: bounded deltas
  `{ affinityDelta, moodDelta, arousalDelta, addConditions?, mindNote? }`.
- **Reuse the personality §6 likes/dislikes seam** (roadmap #7,
  `personality-and-state`): concept-tag the player's act, let the deterministic
  **affinity-aware curve** decide the reaction magnitude, so the verdict is
  *computed*, not improvised. Chat is the cheapest possible testbed for that loop
  — no session machinery to fight — and a good place to ship personality v1 first.
- **Cadence:** every exchange (most responsive) vs. every N (cheaper). Make it a
  constant; start at every exchange, batch if cost bites.
- **Degraded default:** pulse times out → keep the reply, apply drift only, emit
  a diagnostic. Never blocks or fails the turn.

## Surfacing state to the prompt

Extend `buildCharacterChatSystemPrompt` with a compact **"current state"** block,
built the same way the narrator's is:

- `crossedThresholdHints(meters)` → e.g. hygiene < 0.55 *"noticeably lived-in at
  close range,"* arousal > 0.55 hint, etc.
- `deriveMoodDescriptor(mood, stress, energy)` → *"bright and playful" / "tired
  and a little terse."*
- Affinity stage → a warmth instruction (*"She regards you as a **close**
  friend — tease, don't fawn"*), gated off `stageForValue(affinity)`.
- Active conditions' `promptHint`s; the `mindNote` for continuity.
- Reuse the existing **exposure/intimacy gating** for arousal-driven content so
  chat honours the same tier rules as sessions.

## UI / fun surface

- **Status strip** above the composer: an affinity **stage chip** (heart icon)
  plus a few meter pips (mood, energy, hygiene, arousal) — show a pip only when
  notable to keep it clean.
- **Stage-change toast** — *"Akari now regards you as **warm**."* The single most
  satisfying beat; the romance arc made visible (the deferred timeline idea at
  chat scale).
- **Resume beat** — on reopening after a gap, a state-coloured greeting falls out
  of the prompt naturally ("Mm — just out of the bath, you caught me relaxed").
- **Scene image already reads state-adjacent data** — once meters exist, a chat
  scene can reflect current hygiene/mood/arousal, not just static attributes.
- Optional **action chips** (offer a drink → intoxication↑; suggest she freshen
  up → hygiene reset) — playful, and they *show off* the systems.

## The embodied player — graduated to [player-character.plan.md](player-character.plan.md)

> **Graduated.** This section's idea — a profile-level player character +
> `resolvePlayerPersona` resolver + the chat-prompt seam — is now its own plan,
> [player-character.plan.md](player-character.plan.md) (a profile/settings menu
> hosting a light default player character). That plan delivers the menu,
> storage, resolver, and (recommended) the thin chat-prompt seam below; this
> plan keeps the **light-state** work that *consumes* the resolver. The original
> brainstorm is preserved below for context.

The user wants a **profile-level character the player embodies**, defaulted when
they don't pick a session/world PC, and used as the player in chats. We build the
**seam** now and the system later.

**Today's reality:** the player is faceless. The chat prompt says *"address the
user directly as 'you'"*; sessions already have the `{{player}}` token + the
`OBSERVER_PLAYER_NAME = "the protagonist"` fallback (`src/lib/player-token.ts`),
and facts already carry `subjectKind: "player"`. So a player identity *concept*
exists in the engine — it just has no profile-level home yet.

**Placeholder to add now:**

- A single resolver — `resolvePlayerPersona(ownerId): PlayerPersona` (e.g.
  `src/server/players/` behind a barrel) — the **one** source of truth. Shape it
  forward-compatibly even though v1 is a stub:

  ```ts
  type PlayerPersona = {
    id: string | null;        // null today; a profile-character id later
    name: string;             // today: a neutral default / account display name
    persona?: string;         // short bio/voice; undefined today
    // future: attributes, appearance, avatar — for symmetric rendering
  };
  ```

- **Thread it through the chat route + prompt:** pass the resolved persona into
  `buildCharacterChatSystemPrompt` as a `player` block — *"You are speaking with
  {name}{, who is …persona}; address them as {name}"* — replacing the bare
  "the user" phrasing. This alone fixes the immersion gap (UX-audit P1) and gives
  affinity/mindNote a subject (*toward {name}*).
- **Keep it honest:** v1 returns a placeholder (no real PC), so behaviour barely
  changes — but every consumer (route, prompt, state) already reads the resolved
  persona, so when the real profile-level PC ships, **only `resolvePlayerPersona`
  changes**.
- **Converge with sessions later:** the session wizard's player-pick (UX-audit
  feature #1 / `ux-audit.plan.md` intake fields) should default to this same
  profile persona, and `{{player}}` should resolve through the same resolver.
  This brainstorm only commits the chat-side stub.

When the full system graduates it becomes its own `player-character.plan.md` +
roadmap line; this section is the tombstone pointing there.

## Scope boundaries (what stays out)

No locations, presence, perception, or witness matrix. No facts table, embeddings,
or RAG (the `mindNote` replaces them). No story threads. No 4-agent post-turn
fan-out (one optional pulse instead). The plain-text reply stream is unchanged.
This keeps the chat a *quick chat*, not a session.

## A possible build order

1. **State blob + drift + prompt surfacing** (no LLM): new `character_chat_state`
   row (schema → `db:generate` → review → `db:migrate`), meters subset + affinity
   seeded from the character's authored relationship edge, hybrid time-drift,
   threshold/mood/stage hints in the prompt, status-strip + stage-toast UI.
   *Already feels alive, zero added model cost.*
2. **Player-persona placeholder** — `resolvePlayerPersona` stub + prompt seam.
   **Moved to [player-character.plan.md](player-character.plan.md)** (build steps
   2 & 5 there); it ships with the settings menu, not this plan.
3. **The reaction pulse** — the structured delta agent, ideally on the personality
   §6 curve; degrade to drift-only.
4. **Texture** — light conditions, action chips, mindNote-driven resume beats.

## Open questions

- **Time model:** confirm hybrid (per-exchange tick **and** capped between-visit
  wall-clock drift), and the caps.
- **Affinity decay between visits?** Sessions decay affinity weekly
  (`lastAffinityDecayAt`). Does a romance chat cool off when ignored, or only
  grow? (Pacing/feel call — lean *gentle* decay.)
- **Pulse cadence & cost** — every exchange vs. every N; acceptable per-turn spend.
- **Player state in chat?** v1 tracks the *character's* meters only; does the
  player persona ever carry its own meters/arousal here, or stay a name+bio?
  (Lean: name+bio only for chat — keep it light.)
- **Where the strip lives** — inline above the composer vs. a collapsible side
  panel in the Chat tab.
- **Seed affinity** — start every chat at `stranger` (0), or honour the
  character's authored `relationship` edge toward the player?

## Related

- [finished/character-chat.plan.md](finished/character-chat.plan.md) — the
  stateless v1 this builds on.
- `docs/contracts/meters-actions.md`, `relationships.md`, `conditions.md` — the
  contracts reused here.
- [ux-audit.intake.md](ux-audit.intake.md) P1 / feature #1, `ux-audit.plan.md`
  (player-character intake fields) — the embodied-player gap.
- roadmap #7 `personality-and-state` (likes/dislikes §6 curve) — the pulse engine.
- [deferred.plan.md](deferred.plan.md) "Relationship & meter timeline" — the
  surfacing idea, here at chat scale.
