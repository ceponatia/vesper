# Character chat — light state (v1 design detail)

Status: **shipped — 2026-06-24** (slices 1 + 3 + 4; see
[character-chat-state.plan.md](character-chat-state.plan.md) for the build summary +
clarification rulings. Only the state-aware chat scene image was deferred →
[deferred.plan.md](deferred.plan.md)).
Settled mechanics for the v1 slice: a small persisted state row per chat, a free
deterministic time-drift spine, and one optional structured reaction pulse that
moves state *from the conversation* by reusing the personality §6 curve. The
embodied-player half of the original brainstorm already shipped
([player-character.plan.md](player-character.plan.md)); this doc is only the
light-state engine that consumes it.

Everything here reuses existing **pure contracts** — no new meters, no new
interaction concepts, no registry migrations. The only schema change is one new
table.

## 1. The state row

One row per `(ownerId, characterId)` — the chat's only memory beyond the message
window and the [rolling summary](character-chat-summary.plan.md). A **new**
`character_chat_state` table, *not* an extension of `character_chat_summaries`
(keeping the migration a pure CREATE avoids drizzle's rename prompt, and keeps
the pulse independent of the summary fold job). They share a primary key and
coordinated reset semantics: **Reset All** clears both, **Reset Chat** clears the
transcript + summary while preserving state, and **Reset State** re-seeds live
state while preserving the transcript. Converging them into one row is a later
consolidation, noted in the plan.

```ts
// src/server/db/schema.ts
export const characterChatState = pgTable(
  "character_chat_state",
  {
    ownerId: text("owner_id").notNull().references(() => users.id),
    characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
    /** Record<string,number> — the full meter registry, carried verbatim. */
    meters: jsonb("meters").notNull().default({}),
    /** −100…100, the character's feeling toward the player persona. */
    affinity: integer("affinity").notNull().default(0),
    /** ActiveCondition[] — optional light texture, self-expiring on clockMinutes. */
    conditions: jsonb("conditions").notNull().default([]),
    /** 1–3 sentences: "what's on their mind" — the cheap continuity note. */
    mindNote: text("mind_note").notNull().default(""),
    /** Last-turn debug trace for the state tools modal; parsed defensively. */
    lastPulseTrace: jsonb("last_pulse_trace").notNull().default({}),
    /**
     * Player-set scenario framing for *this* chat ("it's the night before she
     * moves away…"). Chat-only by construction — never read by sessions (§1.2).
     * Pre-filled from the authored `playerRelationship.note`, then editable.
     */
    premise: text("premise").notNull().default(""),
    /** Chat-local game clock (drift + condition-expiry driver). */
    clockMinutes: integer("clock_minutes").notNull().default(0),
    /** Wall-clock anchor for between-visit drift; null until the first exchange. */
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.characterId] })],
);
```

- **Carry all registry meters, surface only the notable ones.** Seeding from
  `initialMeters()` (hygiene .9, energy .9, stress .15, arousal 0, intoxication 0,
  mood .5) costs nothing and avoids subset-tracking logic; the prompt + UI filter
  to what's worth saying.
- **No row ⇒ a fresh stateless chat**, exactly today's behaviour. The first POST
  seeds a row (lazy create), so existing chats light up on their next message.
- **Affinity is seeded, not always 0.** The seed reads the character's authored
  `playerRelationship.stage` → `clampAffinity(stageMidpoint(stage))` (default
  `stranger` ⇒ 0 ⇒ unchanged); see §1.1. `mindNote` is **not** seeded from the
  authored note — it starts `""` and is purely dynamic (§6 owns why).
- **No affinity decay between visits** (resolved, §10): chat is a light,
  often-ephemeral test-bed / short-story space, not a persisted arc. Between-visit
  *recovery toward rested* (§3) is meters-only (hygiene/energy/etc.), never affinity.
- **Reset semantics are explicit, not one overloaded clear.** **Reset All** deletes
  messages, summary, and this row. **Reset Chat** deletes messages + summary while
  preserving this row. **Reset State** re-seeds this row from authored defaults
  while preserving the transcript. The unresolved details are called out in the
  plan's clarification section: whether Reset State preserves a player-edited
  premise, and whether Reset Chat clears transcript-derived fields like
  `mindNote`/`lastPulseTrace`.

## 1.1 The authored seed — `playerRelationship` (new profile field)

Where a fresh chat's affinity comes from. A **new field in the character profile
schema** (`characterProfileSchema`, `src/contracts/world/profile.ts`) stores the
authored default stance in the existing `profile` jsonb blob — **no migration**,
and old rows parse unchanged (defaults below). In the editor it appears on the
character-sheet **Chat** tab with the user-facing label **Starting Relationship**.

```ts
// src/contracts/world/profile.ts
/**
 * The character's authored default stance toward the player. v1 seeds character
 * chat: `stage` → the chat's starting affinity (stageMidpoint), and the optional
 * one-line `note` is the chat's default premise (pre-fills the per-chat premise,
 * §1.2). Default `stranger`/"" ⇒ affinity 0 and no default premise ⇒ today's behavior.
 */
playerRelationship: z
  .object({
    stage: stageIdSchema.default("stranger"),              // stageIdSchema = the shared refine+catch (see note)
    note: z.string().max(PLAYER_RELATIONSHIP_NOTE_MAX).default(""),
  })
  .default({}),
```

(`.default({})` on the object + a `.default` on each inner field ⇒ an absent
`playerRelationship` parses to `{ stage: "stranger", note: "" }` — old rows
unchanged.)

- **`stage`** reuses the relationship-stage registry exactly as world-cast seeding
  does: seed `affinity = clampAffinity(stageMidpoint(stage))` when the row is
  created (`stranger` ⇒ 0). This is the *only* thing that touches state.
- **`note`** is the character's authored **default premise** — "her devoted
  bodyguard", "childhood friend who secretly pines for you". It is **not** rendered
  directly; it **pre-fills the per-chat `premise`** (§1.2) when a chat's premise is
  still empty, giving the character a ready-to-play setup the player can edit per
  chat. Empty ⇒ no default ⇒ unchanged.
- **Validation reuse (jscpd):** `authoredRelationshipSchema.stage`
  (`relationships/authored.ts`) already does the `refine(stageById) / .catch
  ("stranger")` dance. Extract that as a shared `stageIdSchema` in
  `relationships/stages.ts` (the refine + catch), reuse it in `authored.ts`, and
  add `.default("stranger")` at this use site — rather than duplicating the refine.
- **Why a profile field, not a world-cast edge.** Standalone characters have no
  `world_cast` row, so the chat seed must live on the character itself. The field
  is named **broadly** (`playerRelationship`, not `chatRelationship`) on purpose:
  it is the character's intrinsic default stance toward the player, and a natural
  later default for `world_cast.relationships` toward `"player"` when none is
  authored — a noted convergence. v1 **consumes it only in chat**.
- **Editor:** a field on the character-sheet **Chat** tab labeled **Starting
  Relationship** (`character-editor.tsx`) — a stage `<select>` (the 11 stage
  labels) + a short one-line note input. `PLAYER_RELATIONSHIP_NOTE_MAX` keeps it a
  premise, not a bio.

## 1.2 The per-chat premise (player-set scenario framing)

The chat's job is testing characters and **player-directed short stories**, so the
single most useful player control is a **premise**: a free-text scenario for *this*
conversation ("it's the night before she moves away forever and you've come to say
goodbye"), set on the Chat page above the composer. It is deliberately **separate
from bio/personality**: those are authored character truth that **sessions consume**,
and a chat scenario must never leak into a session. The premise lives only on the
chat's `character_chat_state.premise` (§1) — chat-scoped, ephemeral, cleared by
**Reset All** — so it is structurally impossible for a session to read it.

- **Why on the chat, not the profile.** A premise is per-conversation and
  disposable — the whole point is to "easily test scenarios", swapping it to re-run
  a character against a new setup. Authoring it on the profile would (a) pollute the
  session-facing fields and (b) force one premise per character. On the state row it
  is naturally one-per-conversation. **Reset All** deletes it; **Reset Chat**
  preserves it so testers can start a new transcript with the same setup.
- **Seeded, then owned by the player.** A fresh row pre-fills `premise` from the
  authored `playerRelationship.note` (§1.1) so a character ships ready-to-play; the
  player then edits it freely. Once set, it is **player-owned**: never copied into
  `mindNote`, never touched by the pulse or drift — it is the stable frame the whole
  chat plays inside, while `mindNote` tracks the *changing* disposition within it.
- **One framing stream, not two.** Collapsing the authored note into "the default
  premise" (rather than rendering both a relationship line *and* a premise) keeps the
  prompt to a single scenario stream (§6) — the note is its seed value, not a second
  rendered block.
- **Set/edit path.** The premise **Save** action calls a small
  `PATCH …/chat/state { premise }` that upserts the row (seeding the rest via
  `seedChatState` if it doesn't exist yet), so the player can set the scene
  **before** the first message; editing mid-chat just reframes subsequent turns.
  Empty premise ⇒ no scenario block ⇒ prompt byte-identical. Whether Save also
  creates a visible transcript entry is a plan clarification; this state path is
  the minimum required write.

## 2. Contracts reused (all pure, all standalone)

| Contract | Module | Use |
| --- | --- | --- |
| `initialMeters`, `meterDefinitions`, `applyMeterDrift`, `crossedThresholdHints`, `deriveMoodDescriptor`, `NEUTRAL_MOOD_METER` | `contracts/meters/registry.ts` | seed, drift, threshold + mood hints |
| `personalizeMeters` | `contracts/personality/modulation.ts` | per-character drift baselines from the profile's `traits` |
| `stageForValue`, `clampAffinity`, `stageMidpoint`, `stageIdSchema` (new, extracted) | `contracts/relationships/stages.ts` | affinity → stage chip + warmth hint; **stage → seed affinity** (§1.1) |
| `characterProfileSchema.playerRelationship` (new field) | `contracts/world/profile.ts` | the authored seed (stage + premise note), §1.1 |
| `isConditionExpired`, `ActiveCondition` | `contracts/conditions/condition.ts` | expire light conditions on the chat clock |
| `resolveSocialReaction`, `evaluateSocialReaction`, `moodNudge`, `moodMeterToFactor` | `contracts/personality/reactions.ts` | the §6 reaction curve — computes affinity + mood deltas |
| `socialTraitScale` | `contracts/personality/modulation.ts` | trait scaling fed to the curve |
| `interactionConceptIds`, `interactionConceptById` | `contracts/personality/interactions.ts` | the concept vocabulary the pulse classifies into |
| `AFFINITY_DELTA_CLAMP` | `server/engine/constants.ts` | per-exchange affinity clamp |
| `resolvePlayerPersona` | `server/players` | already threaded (shipped) — the act's subject |

Deliberately **not** reused: facts / RAG / embeddings (the `mindNote` replaces
them), perception / presence / threads (session-only), and the 4-agent post-turn
fan-out (one optional pulse instead).

## 3. Time model — "they have a life"

Chat has no in-world clock, so synthesise one. **Two regimes, both free** except
where noted:

**Within a visit** — each exchange advances the chat clock a small fixed amount
(`CHAT_TICK_MINUTES`, ≈4 game-min) and decays meters via `applyMeterDrift` over
that tick, against `personalizeMeters(meterDefinitions, profile.traits)`. So she
gets gently, believably less fresh / a touch more tired the longer you talk — the
session decay model, scaled tiny.

**Between visits** — map real elapsed time since `lastInteractionAt` to a recovery
fraction `f = min(1, realElapsedMinutes / CHAT_RESET_MINUTES)` and **lerp each
meter toward its rested value** = `initialMeters()`. This is the key insight the
brainstorm only gestured at: pure `applyMeterDrift` decays *toward grime/
exhaustion* (hygiene/energy poles are 0), which would make an idle character
perpetually filthy — the **opposite** of "come back next morning and she's freshly
bathed." Offscreen she lived her life (slept, bathed, calmed down), so between
visits state **recovers toward rested**, not decays. Reusing `initialMeters()` as
the rest target means **zero new vocabulary**.

- `CHAT_RESET_MINUTES` ≈ a few real hours ⇒ a short break barely moves state; an
  overnight gap fully resets to rested. (Constant in `engine/constants.ts`.)
- Drift is a **pure function of the stored row + elapsed wall-clock**, so it is
  recomputed on read (POST prompt-build *and* the `GET …/chat/state` strip load)
  and only **persisted once**, folded with the pulse at turn end (§5). No
  mid-turn write.
- Conditions past `clockMinutes` expire during the within-visit tick
  (`isConditionExpired`).

## 4. The reaction pulse — "advanced state tracking", cheaply

One **small structured agent** after the reply settles. To keep the verdict
*computed, not improvised* (the brainstorm's requirement, and what the session
loop does), the agent does **only** the cheap generative parts; the deterministic
§6 curve produces every number:

- **Agent output** (`contracts/turns/chat-pulse.ts`, fully `.default()`ed so
  parsed-empty IS the degraded fallback, per `docs/resilience.md` §3):
  ```ts
  export const chatPulseSchema = z.object({
    /** The player's primary act toward the character, classified into the concept vocabulary; null ⇒ none. */
    playerAct: z.object({ concept: z.string().min(1) }).nullable().default(null),
    /** Refreshed 1–3 sentence "what's on their mind"; "" ⇒ keep prior. */
    mindNote: z.string().max(CHAT_MIND_NOTE_MAX_CHARS).default(""),
  });
  ```
- **Deterministic curve** (no LLM), a single-act mirror of merge.ts
  `planReactionAffinity`:
  ```ts
  const reaction = resolveSocialReaction(
    { concept, target: character.name },
    { tags: [], preferences: profile.preferences, cards: [] },
  );
  if (reaction) {
    const evaluated = evaluateSocialReaction(
      reaction, state.affinity, moodMeterToFactor(state.meters.mood ?? NEUTRAL_MOOD_METER),
      socialTraitScale(reaction, profile.traits),
    );
    const signed = evaluated.valence === "dislike" ? -evaluated.magnitude : evaluated.magnitude;
    affinityDelta = clamp(Math.round(signed), -AFFINITY_DELTA_CLAMP, AFFINITY_DELTA_CLAMP);
    moodDelta = moodNudge(evaluated); // 0–1 scale
  }
  ```
  An unrecognised / null `playerAct` ⇒ no affinity/mood move (just the mindNote
  refresh + drift) — chat is the cheapest possible testbed for the §6 loop with no
  session machinery to fight.
- **Last-turn trace:** persist a small `lastPulseTrace` beside the updated state
  for the state tools modal: classified concept (if any), valence, affinity/mood
  deltas, changed fields, and a degradation diagnostic when applicable. The first
  version can derive "why" from the deterministic concept/valence/preference path;
  the plan keeps open whether the pulse should later emit an explicit explanation.
- **Model + cadence:** the cheap agent model, reasoning off, low-latency routing —
  the exact `runIntake` recipe (`disableReasoning`, `lowLatencyRouting`,
  `repair: false`, a timeout). Every exchange in v1 (a constant
  `CHAT_PULSE_EVERY_N = 1`; batch later if cost bites).
- **Where it runs:** inline in the stream finalizer, **after** the reply has fully
  streamed to the client and `persistAssistantReply` has run. The client already
  holds every token, so this server-side work is invisible to perceived latency;
  it only delays `controller.close()`. One DB write (drift folded with deltas)
  closes the turn, so state is current before the next exchange — no detached-job
  lag.
- **Degraded default (mandatory):** pulse times out / degrades ⇒ keep the reply,
  persist **drift-only** state with `lastInteractionAt = now`, emit a
  `chat_state.pulse.degraded` diagnostic. Never blocks or fails the turn. The
  worst case is exactly drift-only state — still "alive", just not conversation-reactive that turn.
- **Clear race:** guard the state write on the prompting user-message row still
  existing (the same `INSERT … WHERE EXISTS` shape as `persistAssistantReply`), so
  a clear landing mid-stream doesn't resurrect a state row.

## 5. State lifecycle in the route

`POST /api/characters/:id/chat` gains, around the existing stream:

1. **Load + drift (turn start):** `loadChatState` (or seed if absent —
   `initialMeters()`, `affinity = clampAffinity(stageMidpoint(profile.playerRelationship.stage))`,
   and `premise` pre-filled from `playerRelationship.note`,
   §1.1–1.2). Apply between-visit recovery from `lastInteractionAt → now`, then the
   within-visit tick + condition expiry ⇒ `driftedState` (pure; not yet persisted).
   (The premise may also have been set ahead of the first message via `PATCH
   …/chat/state`, §1.2 — same `seedChatState` path.)
2. **Surface to the prompt:** pass `driftedState` into
   `buildCharacterChatSystemPrompt` as a `state` block (§6). Stream the reply as
   today.
3. **Finalizer (turn end):** after `persistAssistantReply`, run the pulse on
   `driftedState` + the just-finished exchange → apply `affinityDelta` /
   `moodDelta` / `mindNote` / any `addConditions`, set `lastInteractionAt = now`,
   `upsert` the row (guarded on the prompt row). Degrade to drift-only on pulse
   failure.

New `GET /api/characters/:id/chat/state` → `{ meters, affinity, stage, conditions,
mindNote, premise, lastPulseTrace }` for the strip, premise bar, and state tools
modal, applying the **same** drift-on-read so the UI shows current values after a
gap even before the next send. Returns a rested-default snapshot when no row
exists. The client refetches it on load and after each send (the reply stream stays
plain text — design principle "keep the clean stream").

`PATCH …/chat/state { premise }` powers the premise **Save** action. It upserts the
row and leaves the first player prompt to the player.

Reset actions share the same route family but are explicit in the UI and API:

- **Reset All** — delete messages + summary + state row; this is the old clear-chat
  behavior with clearer copy.
- **Reset Chat** — delete messages + summary, keep the state row so testers can
  preserve the current disposition/premise while starting a fresh transcript.
- **Reset State** — re-seed the row from authored defaults (§1.1) while keeping the
  transcript. It reuses the same pure seed path as lazy create. The plan keeps open
  whether a player-edited premise is reset to the authored default or preserved.

**Prompt Character** is the opening-beat action: save the current premise, then run
the same chat stream path with no user-authored dialogue line, asking the narrator
for a character-authored opening turn grounded in the premise + seeded warmth. The
plan keeps open the exact transcript representation for the premise/setup marker.

## 6. Surfacing state to the prompt

Extend `CharacterChatPromptInput` with an optional `state` block; absent ⇒ the
prompt is byte-identical to today (existing snapshots hold). The builder owns the
surfacing (it already imports `@/contracts`), so it is snapshot-tested in one
place:

```ts
state?: {
  meters: Record<string, number>;
  affinity: number;
  conditions: ActiveCondition[];
  mindNote?: string;
  premise?: string;   // the per-chat scenario framing (§1.2)
};
```

Rendered as a compact **"Current state"** section, mirroring the narrator's:

- `crossedThresholdHints(meters)` — hygiene/energy/stress/arousal/intoxication
  lines when crossed.
- `deriveMoodDescriptor(meters)` — "bright and playful" / "tired and a little
  terse" (blends mood × energy × stress; "" when an even keel).
- `stageForValue(affinity)` → a **warmth instruction** keyed off the stage id
  (`warmthHintForStage` — new prompt copy in the builder), e.g. *"She regards you
  as a **close** friend — tease, don't fawn."*
- active conditions' `promptHint`s; the `mindNote` for continuity.
- Arousal-driven phrasing rides the chat's existing content framing + the body
  gating already in the builder (`realizeBody`) — no new exposure machinery; the
  same tier rules as the stateless chat.

The **premise** (§1.2) renders as one prominent, fenced **scenario block** near the
top of the prompt (after identity, before the dialogue) — *"Scenario for this chat:
…"* — read from `state.premise`. It is the strongest framing in the prompt: the
situation the whole conversation plays inside. Empty ⇒ no block ⇒ byte-identical.

**Field ownership (five context streams — keep them from bleeding).** With the seed
field + premise added, the chat prompt carries five free-text inputs; each owns one
job so the prompt stays legible and nothing duplicates:

| Stream | Source | Nature | Job |
| --- | --- | --- | --- |
| player persona/bio | `resolvePlayerPersona` | static | *who* the player is |
| premise | `state.premise` (seeded from `playerRelationship.note`) | static per chat, player-set | *the scenario* this chat plays inside |
| `mindNote` | the pulse | dynamic | *current* disposition / what's on their mind |
| stage warmth hint | `affinity` (state) | dynamic | how warmly to *behave* now |
| rolling summary | summary fold job | dynamic | factual recap of older transcript |

(`playerRelationship.note` isn't a sixth stream — it's the premise's seed value, not
a separately rendered block.)

## 7. UI

- **Premise bar** above the composer (`character-chat.tsx`): a collapsible
  "Scenario" field holding `state.premise`, pre-filled from the authored default
  (§1.2) and editable any time — the player sets the scene before sending, or swaps
  it to re-test. **Save** persists via `PATCH …/chat/state { premise }`.
  **Prompt Character** saves, then asks for a character-authored opening turn.
  Kept subtle (collapsed when empty) so casual chats aren't cluttered; it's the
  headline control for the "easily test scenarios" use.
- **Status strip** above the composer (`character-chat.tsx`): an affinity **stage
  chip** (heart icon, `stageForValue(affinity).label`) + meter **pips** (mood,
  energy, hygiene, arousal) shown **only when notable** (off-baseline) to stay
  clean. Fed by `GET …/chat/state`, refetched after each send.
- **Stage-change toast** — compare prior stage to the post-send stage; on change,
  *"Akari now regards you as **warm**."* The single most satisfying beat — the
  romance arc made visible (the deferred relationship-timeline idea at chat scale).
- **Resume beat** — falls out of the prompt naturally from the drifted state +
  mindNote on reopening after a gap; no extra code.

Test-bed affordances (slice 4 — chat's stated purpose is testing characters &
player-directed short stories, so these earn their place here):

- **Reset menu** — replace the old clear affordance with **Reset All** (messages +
  summary + state), **Reset Chat** (messages + summary only), and **Reset State**
  (state only, re-seeded from authored defaults; premise behavior to confirm in
  the plan clarification).
- **State tools modal** (author/dev) — inspect and edit the current state:
  affinity/stage, meters, conditions, premise, and `mindNote` at minimum. The
  plan keeps open whether clock/last-interaction controls belong in v1. Once the
  pulse lands, include the **last-turn trace** from §4: classified concept, valence,
  deltas, changed fields, and degradation diagnostic.
- **Opening beat** — **Prompt Character** lets a fresh chat with a premise or
  non-`stranger` starting relationship begin with a scenario-colored character
  turn instead of waiting for the player's first line.

## 8. Module layout

- `src/contracts/turns/chat-pulse.ts` — `chatPulseSchema`, `degradedChatPulse`,
  the `chatPulseTraceSchema`/`emptyChatPulseTrace` (the persisted last-turn trace),
  and the char caps `CHAT_MIND_NOTE_MAX_CHARS` + `CHAT_PREMISE_MAX_CHARS`. Pure.
  (The caps live here, not `engine/constants.ts` as listed below: the schema needs
  the mindNote cap and the client chat UI needs the premise cap, and neither a
  contract nor a component may import a server module — module-boundary lint.)
- `src/server/engine/chat-state.ts` — `loadChatState`, `seedChatState`,
  `driftChatState` (pure, exported for tests), `runChatPulse`, `saveChatState`.
  Barrel via `engine/index.ts`.
- `src/server/engine/prompts/chat-state.ts` — `CHAT_PULSE_SYSTEM`,
  `buildChatPulsePrompt`. Pure, snapshot-tested.
- Edits: `contracts/world/profile.ts` (new `playerRelationship` field +
  `PLAYER_RELATIONSHIP_NOTE_MAX`), `contracts/relationships/stages.ts` (extract a
  shared `stageIdSchema`, reused by `authored.ts`), `prompts/character-chat.ts`
  (state block + premise/scenario block), the chat `route.ts` (lifecycle + DELETE
  reset actions + new GET + `PATCH …/chat/state` for the premise + Prompt
  Character opening), `engine/constants.ts` (`CHAT_TICK_MINUTES`,
  `CHAT_RESET_MINUTES`, `CHAT_PULSE_EVERY_N`, `CHAT_MIND_NOTE_MAX_CHARS`,
  `CHAT_PREMISE_MAX_CHARS`), `character-editor.tsx` (the **Starting Relationship**
  field on the Chat tab) + `character-chat.tsx` (premise bar + Save/Prompt
  Character + reset menu + state tools modal + strip + toast), `lib/client/api.ts`
  (state fetch + premise PATCH + reset actions).

## 9. Resilience & tests

Per `docs/resilience.md`: `parseOr` the stored `meters`/`conditions`/persona at
every read boundary; the pulse degrades to drift-only with a diagnostic; a
malformed row seeds rested defaults rather than throwing.

- **Pure unit:** `driftChatState` — within-visit decay, between-visit recovery
  toward rested, the cap, condition expiry. `seedChatState` — affinity =
  `stageMidpoint` of the authored stage; **`stranger`/absent ⇒ 0 (default
  unchanged)**; a malformed `playerRelationship` self-heals to `stranger`.
  `runChatPulse` curve math for a liked/disliked/neutral/unrecognised act (assert
  it matches the §4 numbers). The prompt builder snapshot with/without the state
  block **and** with/without a `premise` (empty ⇒ byte-identical). `seedChatState`
  pre-fills `premise` from `playerRelationship.note`.
- **Degradation:** pulse timeout/demo ⇒ drift-only state **and** the
  `chat_state.pulse.degraded` diagnostic code (the mandated assert-both shape).
- **Integration:** POST seeds a row (affinity from the authored stage); a second
  POST after a simulated gap shows recovery but **affinity unchanged** (no decay);
  `PATCH …/chat/state { premise }` before any message creates the row and the
  premise then surfaces in the next turn's prompt; the premise **survives the
  pulse** (unchanged by it); **Reset All** deletes messages + summary + state;
  **Reset Chat** deletes messages + summary while preserving state; **Reset State**
  re-seeds state while preserving the transcript; **Prompt Character** saves the
  premise and starts a character-authored opening turn; the GET reflects
  drift-on-read and includes the last-turn trace after a pulse.

## 10. Resolved decisions (see the plan for implementation clarifications)

Most of the brainstorm's questions are settled here: hybrid time model
(per-exchange tick **and** capped between-visit recovery toward rested); pulse
every exchange on the cheap model, degrade to drift-only; player carries
name+bio only (no player meters in chat); strip inline above the composer.

The product-feel calls the plan carried are now **resolved**:

- **Affinity decay on neglect → none.** Chat is a light, often-ephemeral test-bed
  / player-directed short-story space, not a persisted relationship arc, so a
  "gone cold after a week" beat is unwanted. Affinity moves only via the pulse;
  between-visit recovery (§3) is meters-only.
- **Seed affinity → from the authored `playerRelationship` field** (§1.1): the
  stage seeds via `stageMidpoint` (default `stranger` ⇒ 0 ⇒ unchanged); its
  optional `note` is the chat's authored default premise (§1.2), not a separate
  prompt line. The field is stored as `playerRelationship` but shown on the Chat
  tab as **Starting Relationship**; the plan asks whether the persisted key should
  also be renamed.
- **Per-chat premise → on the chat-state row, set from the Chat page** (§1.2): a
  player-set, chat-only scenario field, pre-filled from the authored note and
  rendered as the prompt's single scenario stream. Chat-only by construction — it
  lives nowhere a session reads — so testing scenarios can't pollute bio/personality.
- **Reset actions → Reset All / Reset Chat / Reset State** (§5/§7), replacing the
  old overloaded clear-chat action.
- **State tools modal → yes** (§7), including editable state fields and a last-turn
  debug readout once the pulse exists.
- **Opening beat → Save + Prompt Character** (§5/§7), so the player can either set
  the premise and speak first or ask the character to lead.

The remaining plan clarifications are implementation details: internal key naming,
premise behavior during Reset State, which dynamic fields Reset Chat clears, Save's
transcript representation, last-turn explanation source, and state tools visibility
/ field coverage. None block slices 1/3.
