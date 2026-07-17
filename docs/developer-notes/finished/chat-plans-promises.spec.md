# Chat plans & promises — spec

Companion to [chat-plans-promises.plan.md](chat-plans-promises.plan.md) (read that
first for the goal and the ensemble angle). This spec records the settled schema and
the rulings on open questions A–F, written as the plan went **active** (2026-07-15).

The one-line frame: **the story makes a commitment → the system records it
deterministically → the story clock makes it come due → the narration honors it.**
scheduled-arrivals reborn on the chat lane, without the location model.

## Where plans live

Plans belong to the **conversation**, like `scene_memory` and `supporting_cast`, so
they ride the chat-wide **scenario** (`character_chats`), not a per-character state row:

- Contract: `contracts/turns/chat-plans.ts` — `ChatPlan`, the schemas, and the pure
  merge / advance / salience functions.
- Storage: one `plans` jsonb column on `character_chats` (migration), `parseOr`'d to
  the empty list at the load boundary (`loadChatScenario`), on `ChatScenario`.
- Rollback: **ride the snapshot** (ruling B) — plans roll back with
  `pre_exchange_scenario` like `scene_memory`, so a regenerated reply that minted a
  plan does not double-mint. (Unlike `supporting_cast`, which is accrete-only /
  author-curated between takes; plans are fiction state.)

## The schema (`ChatPlan`)

```ts
interface ChatPlan {
  id: string;                     // stable, minted at strike (nanoid)
  what: string;                   // "dinner at the pier", "come over Friday"
  participants: string[];         // names: the player, roster members, supporting cast
  where?: string;                 // "the pier", optional
  when: PlanWhen;                 // coarse, keyed to the STORY clock (never wall clock)
  status: "upcoming" | "kept" | "missed" | "canceled";
  struckAtMinutes: number;        // clock_minutes when the plan was struck
}

type PlanWhen =
  | { kind: "scheduled"; targetMinutes: number; label: string } // resolved absolute story-clock target
  | { kind: "unscheduled"; label?: string };                    // "soon" / "sometime" — never goes missed
```

- **`when` (ruling A).** The archivist proposes a plan's timing in an **LLM-friendly
  coarse grammar** — a day-offset (`0`=today, `1`=tomorrow, …) + a **day-part** drawn
  from the schedule-authoring vocabulary (`morning`/`afternoon`/`evening`/`night`,
  `contracts/world/profile.ts`), OR `unscheduled` for "soon"/"sometime". The **fold
  resolves** that against the current `clock_minutes` into an absolute `targetMinutes`
  (day boundary + `dayOffset·1440` + the day-part's `startMinute`), storing both the
  minute (for pure due-ness) and a human `label` (for display + the narrator). The
  archivist never sees clock minutes. A resolved target that lands at/before the strike
  is bumped one day forward (a plan can't be born in the past). `unscheduled` plans
  carry no target and **never go missed** — they linger as intentions and age out.
- **`status`.** `kept` / `canceled` are recognized by the archivist from the fiction;
  `missed` is **deterministic** (the archivist may never propose it); `upcoming` is the
  default. *imminent* and *due now* are **derived, pure, at prompt-build time** from
  `when` vs the clock — never stored.

### Due-ness derivation (pure)

`derivePlanSalience(plans, nowMinutes)` returns, per open (upcoming) or just-resolved
plan, its transient salience from `delta = targetMinutes − now`:

| salience    | condition                                    | narrator directive              |
| ----------- | -------------------------------------------- | ------------------------------- |
| `dueNow`    | `−DUE_WINDOW ≤ delta ≤ 0`                     | the event — it's happening now  |
| `imminent`  | `0 < delta ≤ IMMINENT_WINDOW`                | anticipation before             |
| `justMissed`| `status === "missed"` and freshly so         | the fallout                     |
| `upcoming`  | `delta > IMMINENT_WINDOW`                     | (silent unless a couple nearest)|

Windows (named constants, tunable): `PLAN_IMMINENT_WINDOW_MINUTES = 1440` (within a
day reads as imminent — "tomorrow" anticipates), `PLAN_DUE_WINDOW_MINUTES = 360` (one
day-part at/after the target is "happening now"), `PLAN_JUST_MISSED_WINDOW_MINUTES =
1440` (a miss stays fresh fallout for a day).

### Advancing (deterministic status transitions)

`advancePlans(plans, nowMinutes)` runs in the fold after the clock ticks. An `upcoming`
**scheduled** plan whose `delta < −DUE_WINDOW` (the window fully passed) and which the
archivist did **not** mark kept/canceled this exchange transitions to:

- **`missed`** — when the plan **involves the player** (skipping past Friday's dinner
  *means* something). The transition is the signal the pulse + milestone + "just missed"
  directive key on.
- **`kept`** — when the plan is **NPC↔NPC** (does not involve the player): assume it
  happened off-screen unless the fiction later says otherwise (ruling E — the default
  until [chat-offscreen-life.plan.md](chat-offscreen-life.plan.md)'s meanwhile pass
  decides it). It becomes conversation material / a relationship fact.

`advancePlans` returns the mutated list plus `justResolved: { kept: ChatPlan[]; missed:
ChatPlan[] }` — the exchange's fresh transitions (archivist-recognized **and**
deterministic), consumed by the pulse and the milestone mint.

## Slice map (what got built)

### Slice 1 — substrate

- `contracts/turns/chat-plans.ts` (above) + the `plans` column + `ChatScenario` wiring
  (`loadChatScenario`/`saveChatScenario`/`seedChatScenario` seeds `[]`;
  `rollbackScenario` lets plans ride the anchor).
- Extraction field `plans` — **one module** in `prompts/chat-extractors.ts`, added to the
  **character tracker** leg (commitments are that leg's business; it already carries
  `openLoops`, so the plan-vs-loop distinction lives on one sheet). One field on
  `chatArchivistSchema` (`chatPlanProposalSchema`); the leg is a `pick`, so it follows
  for free. Prompt guidance: a concrete commitment (who + roughly when) files as a
  **plan**; `open_loops` keeps only fuzzy unfinished business — never both for one beat.
  Both input registers count (storyteller-authored narrator-input plans are canon).
  Degraded proposal = no-op.
- The fold in `finalizeChatState`: `mergeChatPlans` (accrete + update by id/normalized
  `what`, resolve `when`, caps) then `advancePlans` (the deterministic transitions).
- The volatile-tail **Plans** block: only what's near this turn — due/imminent/just-missed
  plus at most a couple upcoming — with per-state directives. Silent when nothing is near.

### Slice 2 — consequences & initiative

- **Pulse sees it** (ruling C — model-mediated, no deterministic regard penalty): the
  exchange's `justResolved` reaches the reaction pulse's context (`commitmentsDue`), so a
  stood-up character's `feeling` proposal is informed (`hurt`, cause = the plan). Kept
  plans are warm material the same way. The curve + bruise machinery does the rest.
- **Milestones** (ruling D — new kinds): a kept/missed plan **involving the player**
  mints `plan_kept` / `plan_missed` (glyphs in the relationship panel, callback-boosted
  near `secret_shared`), so "remember our first real date" emerges from the callback
  system for free.
- **Hub + opener**: the "has something to say" derivation gains a plan reason (an
  imminent or just-missed plan outranks open loops); `buildInitiativeCue` gets open
  plans as first-class material ("is tonight still on?" / the cold open after being
  stood up), worded by regard band as usual.

### Slice 3 — ensemble & supporting cast

- Participants resolve against roster + supporting cast (loose, name-normalized). Group
  plans: due-ness + directives are shared; **consequences are per-character** (each
  stood-up participant reacts through their own state row).
- **Arrival license**: a due plan involving an *away* roster member makes them salient
  with an explicit narrated-arrival license (the plan IS the reason they show up) — the
  presence law's one principled exception to don't-teleport. Symmetrically a due plan
  *not* involving the player licenses a present member's exit.
- **NPC↔NPC plans** tracked and resolved (default = assume kept, ruling E) and filed as
  a relationship fact / conversation material.

### Slice 4 — UI

- A compact **Plans** card in the desktop aside / Roster sheet (below Supporting Cast):
  open plans with status glyphs, "+ Add plan," a lightbox editor (what/who/when/status +
  Remove) — author-curated like the supporting cast; saves via the chat-wide
  `ChatStateEdit` half; 409 `chat_busy` while a reply streams.

## Caps & history (ruling F)

- `CHAT_PLANS_MAX = 16` total stored; `CHAT_PLANS_OPEN_MAX = 8` open (`upcoming`) — the
  merge evicts the oldest **open** plan past the open cap and the oldest **plan overall**
  past the total cap. Resolved plans (`kept`/`missed`/`canceled`) are **kept as a short
  history ring** (bounded by the total cap, oldest-out) rather than converted to facts —
  they are prime callback material ("remember our first real date") and the milestone
  already carries the relationship weight.
- Text caps: `PLAN_WHAT_MAX_CHARS = 160`, `PLAN_WHERE_MAX_CHARS = 100`,
  `PLAN_PARTICIPANT_MAX_CHARS = 60` (≤6 participants), `PLAN_LABEL_MAX_CHARS = 60`.

## Not in scope

Same as the plan: no real time / push (nothing reads the wall clock; a plan comes due
when the *story* clock reaches it, and the character speaks of it when the *player* next
acts), no session-lane port yet, no calendar UI.
