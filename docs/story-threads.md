# Story threads

Story threads are the game's running list of "what's unresolved or worth tracking" — the missing-brother mystery, an investigation into a shifty captain, a standing interest in a character's social life. They are AI-maintained: the **director** post-turn agent opens, advances, and closes them; the narrator is told about the live ones so the story keeps its threads alive; the player sees them in the World tab and can open any one for the full picture.

This doc is the single source of truth for how threads work end to end. The director's *prompt contract* lives in `engine/prompts/agents.ts` (`DIRECTOR_SYSTEM`); the deterministic *lifecycle* lives in `engine/merge/phases/threads.ts`; the *shape* lives in `contracts/state/session-runtime.ts`.

## The two kinds

Every thread is one of two kinds — this is the single most important distinction:

| kind | what it is | closes? | example |
| --- | --- | --- | --- |
| **investigation** | a question, problem, mystery, or goal with an end state | yes — tracks `closeConditions`, gets `resolve`d when met | "Investigating Captain Thorne", "Repairing Maya's trust", "Council Chamber Wi-Fi" |
| **ongoing** | a standing topic that is only ever updated | no — never auto-resolved, only cools when quiet | "Maya's social life" |

An investigation left open after its need is met is a bug (it re-enters context and gets re-raised as if unsettled — the original Council-Chamber-Wi-Fi report). An ongoing thread that gets "resolved" is the opposite bug. This split is expressed by the **director prompt** (a soft LLM instruction — "ongoing threads are never resolved"); note the deterministic lifecycle does **not** currently guard `resolve` by `kind`, so an LLM (or the admin manual-close route) that resolves an ongoing thread by id silently succeeds — the prompt is the only guardrail today.

## Data model

Threads live in `sessions.runtime.storyThreads` (a JSONB array — **no dedicated table, no vector column**), defined by `storyThreadSchema` (`contracts/state/session-runtime.ts`):

| field | meaning |
| --- | --- |
| `id`, `title` | identity + display name |
| `summary` | rolling synopsis — the *current* state; what the narrator sees; revised as the thread develops |
| `kind` | `investigation` \| `ongoing` (`.catch("investigation")`) |
| `status` | `open` → `cooling` → `resolved` / `archived` |
| `source` | `anchor` (seeded from a world plot anchor) \| `emergent` (director-proposed) \| `player` |
| `question` | investigation only: the core question/goal in one line — anchors dedup and the modal headline |
| `closeConditions` | investigation only: the events that would close it — shown in the modal, weighed by the director |
| `developments[]` | the accumulated log: `{ turn, text, kind }`, oldest→newest, capped at `THREAD_DEVELOPMENTS_CAP` (oldest dropped) |
| `openedAtTurn`, `lastTouchedTurn`, `touchCount` | lifecycle bookkeeping (staleness + recency) |

Every field is `.default()`ed, so threads written before this schema existed parse cleanly through the runtime boundary `parseOr` — **no migration**. Pre-existing threads default to `kind: "investigation"` with an empty `developments[]` and self-heal as the director develops/re-proposes them. (Known wart: an existing ongoing-style thread stays tagged `investigation` until re-proposed; current signals can't re-tag kind.)

`summary` vs `developments`: `summary` is the one-paragraph "where it stands now" (kept lean for the narrator); `developments` is the timeline of how it got there (shown only in the modal). A `develop` updates both.

## Lifecycle

```
                         director threadSignals
   (world anchors)            │
        │  spawn              ▼
        ▼            ┌───────────────────────────────────────────┐
     [open] ──touch──┤ touch   = keep warm (no log entry)          │
        │            │ develop = append a development + revise summary
        │            │ propose = open a NEW thread (semantic-deduped)
        │            │ resolve = close an investigation            │
        │            └───────────────────────────────────────────┘
        │   8 untouched turns
        ▼ (coolThreads)
    [cooling] ──touch/develop──► [open]          [resolved] ──(drops from UI + context)
        │                                            ▲
        └──────────── resolve / manual close ────────┘
```

- **Spawn** (`engine/spawn.ts`): plot anchors seed threads (`source: "anchor"`); priority `active` → `open`, else `cooling`.
- **touch / develop / propose / resolve**: applied deterministically by `applyThreadSignals` (`engine/merge/phases/threads.ts`, pure & unit-tested). `develop` is the major-event path (appends a `{turn, text, kind}` entry, capped, and refreshes recency); `touch` is the cheap keep-warm path (refreshes recency, **no** log entry); `propose` seeds a new thread with kind/question/closeConditions and an opening development; `resolve` flips an investigation to `resolved`.
- **cooling** (`coolThreads`): an `open` thread untouched for `THREAD_COOLING_TURNS` turns demotes to `cooling` — it leaves the narrator context but still shows in the UI and is still offered to the director. Applies to both kinds (a quiet ongoing thread cools out of the way and reactivates when developed).
- **resolve / archive**: only investigations *should* resolve (the reducer does not enforce this by kind — see above). Resolved/archived threads drop from both the narrator context and the status payload, so they vanish from the UI. The **semantic** dedup layer never resurrects a closed thread (its candidate pool is open/cooling only) — but the **exact-title** fallback inside `applyThreadSignals` (`byTitle`) is **not** status-filtered, so a `propose` whose title exactly matches a resolved/archived thread reopens it (`develop` → `refresh` sets `status: "open"`). A code gap worth knowing, not intended behavior.

## Semantic dedup (the duplicate-threads backstop)

Originally threads deduped by **exact title** only, so one subject spawned near-duplicates ("Captain Thorne's unusual directness" / "…quiet contemplation" / "Brian's informal investigation"). Two layers now prevent that, belt-and-suspenders like the item-dedupe ladder:

1. **Director prompt (primary).** The director sees every open/cooling thread with its kind + development count and is told *one subject, one thread* (Rule 5): if a beat belongs to an existing thread, `develop` it rather than `propose` a near-duplicate.
2. **Embedding backstop (`dedupeThreadProposals`, `engine/merge/phases/threads.ts`).** Before the pure reducer runs, each proposal's `title + question + summary` is embedded and compared (in-memory `cosineSimilarity`) against the same text for each **open/cooling** thread. A best match ≥ `THREAD_DEDUPE_MIN_SCORE` is rewritten into a `develop` on that thread (diagnostic `merge.thread.dedup_merged`) instead of opening a duplicate. Conservative threshold so only obvious dupes merge; resolved/archived threads are never candidates; embedding failure degrades to the exact-title guard inside `applyThreadSignals`.

The embedder is injected via `GroundingDeps.embedThreadTexts` (same seam as `fuzzyResolve` for item/location grounding), so the planner stays testable — tests pass a deterministic fake; production wraps `embedTexts`. When no embedder is present, only the exact-title guard applies.

## Director contract

`directorResultSchema.threadSignals` (`contracts/turns/agent-results.ts`) has four channels — see `DIRECTOR_SYSTEM` for the authoritative prompt and worked examples:

| signal | shape | when |
| --- | --- | --- |
| `touch` | `{id?, title, summary?}` | thread still live, nothing major happened — no log entry (an optional `summary` still revises the thread's rolling summary) |
| `develop` | `{id?, title?, entry, entryKind?, summary?}` | a **major** beat: new evidence, a *meaningful* statement, a real development — **not** flavor dialogue |
| `propose` | `{title, kind, question?, summary, closeConditions?}` | a genuinely new thread (sparingly) |
| `resolve` | `string[]` (ids) | investigations whose need is now met |

"Major" is the line that keeps the log signal-rich: a passing mention is a `touch` (or nothing); a clue, an admission, a turning point is a `develop`. The director is also told to **resolve the moment a need is met** (mundane completion counts) and that **ongoing threads are never resolved**.

## Where threads surface

- **Narrator** (`engine/pipeline.ts` → `engine/prompts/narrative.ts`): the top `OPEN_THREADS_IN_CONTEXT` (3) **open** threads by recency ride in the turn context as `title — summary`, third-priority behind the player's input and directives. Cooling/resolved threads are excluded — this is why resolving a thread stops it being re-raised.
- **Director** (`buildDirectorPrompt`): every open/cooling thread, with kind, status, age, touch count, and development count, so it can consolidate (develop, not duplicate) and judge staleness (resolve a met need).

## UI

- **Status payload** (`app/api/sessions/_shared/status-payload.ts`): ships **open + cooling** threads with full detail (kind, question, closeConditions, developments). Resolved/archived are dropped — closing one removes it from the UI automatically.
- **Client** (`lib/client/use-session.ts`, `statusThreadSchema`): forgiving parse of the wire shape.
- **World tab** (`components/play/world-tab.tsx`): each thread is a clickable card (title, kind/cooling tags, 2-line summary clamp).
- **Detail modal** (`components/play/thread-modal.tsx`): built on the shared `Dialog` (Esc / click-out to dismiss). Shows the question, the rolling summary, "What would close this" (investigations), and the full **developments timeline** (newest first) — everything gleaned so far.

### Manual close (dev-only)

Admins get a confirm-gated **"Close thread"** control in the modal footer (the dismiss affordance stays Esc / click-out, so the labels don't collide). It calls `DELETE /api/sessions/:id/threads/:threadId` (`sessionsApi.closeThread`), which is **admin-gated server-side** (`user.role === "admin"`, never the client flag) and owner-scoped via `findOwnedSession`; it flips the thread to `resolved` in `sessions.runtime`. The thread then drops from the next status payload and disappears from the World tab. Unknown thread → 404; non-admin → 403.

## Constants (`engine/constants.ts`)

- `THREAD_COOLING_TURNS = 8` — open → cooling after this many untouched turns.
- `OPEN_THREADS_IN_CONTEXT = 3` — open threads injected into the narrator context.
- `THREAD_DEDUPE_MIN_SCORE = 0.86` — cosine cutoff for folding a proposal into an existing thread (conservative, matches fact supersede).
- `THREAD_DEVELOPMENTS_CAP = 20` — max accumulated developments per thread (oldest dropped).

## Degradation

Threads follow the resilience rules (`docs/resilience.md`): a missing director degrades to no thread changes; an unmatched `touch`/`develop`/`resolve` id logs `merge.thread.unmatched` and is skipped; dedup embedding failure logs `merge.thread.dedup_embed_failed` and falls back to exact-title dedup; the runtime is read through `parseOr` so a malformed thread can't fail a turn. None of these throw.

## Tests

- `engine/merge.test.ts` — `applyThreadSignals` (develop appends/caps/revises, touch logs nothing, propose seeds kind/question/conditions, resolve closes) and `dedupeThreadProposals` (folds near-dupes, skips distinct, never resurrects resolved, degrades on embed failure).
- `engine/prompts/agents.test.ts` — the four-signal contract, the consolidation rule, the resolve rule, and `buildDirectorPrompt`'s kind/development rendering, plus the director prompt budget.
- `app/api/sessions/_shared/status-payload.test.ts` — ships open + cooling with full detail.
- `app/api/sessions/threads-route.int.test.ts` — the admin close route (resolve, 404, 403).
