# Engine Comparison

Engine Comparison is Vesper's legacy-versus-successor migration harness. It lets a normal legacy character chat remain authoritative while the successor simulation independently evaluates the same player turns against a dedicated mirror world. The results are recorded for later review; the successor comparison never rewrites the legacy transcript or legacy chat state.

The feature was originally called **Shadow Parity**. That name is retired in user-facing documentation and UI because it obscured the purpose of the system and implied that the two engines are expected to be identical. Internal identifiers such as `successor_shadow`, `/admin/shadow`, `sim_shadow_divergences`, and `shadow-parity.ts` remain for compatibility unless a separate refactor changes them.

## What the system is for

Engine Comparison answers a migration question:

> Given the same player turn, what does the legacy chat lane do, what does the successor engine do, and is any difference a problem?

Legacy is a control sample, **not automatically the correct answer**. A difference can mean any of the following:

- the successor has a defect or missing contract;
- legacy has stale or undesirable behavior that the successor correctly avoids;
- both outputs are valid but different;
- the automated comparison found no issue and the row simply has not been reviewed yet.

The purpose of review is therefore to understand differences, not to force the successor to reproduce legacy behavior byte-for-byte.

## Starting Engine Comparison

Engine Comparison is an **admin-only development feature** and currently supports **one-on-one legacy conversations only**. The comparison recorder is pair-based; group chats are refused rather than producing incomplete evidence.

### New conversation

In **New conversation**, select one character and enable **Run Engine Comparison** before choosing **Start chatting**.

Vesper creates the ordinary legacy chat first, then creates and attaches its comparison mirror. If mirror setup fails after the chat was created, the dialog keeps that chat and offers to retry comparison setup rather than creating a duplicate conversation.

### Existing conversation

Open **Account menu → Engine Comparison**. Under **Start or stop comparison**:

1. choose an active conversation;
2. confirm the conversation is eligible;
3. choose **Start comparison**.

No simulation identifiers need to be entered manually. The service creates the mirror, maps the player and primary character actors, and selects the historical internal `successor_shadow` authority value in one setup flow.

### What the mirror starts with

An existing chat's mirror is initialized from the chat's **current comparable legacy state**, not from the ordinary successor starter world. It carries:

- the resolved player name/persona identity and primary character name;
- the current story clock and calendar date;
- whether the primary character is currently present with the player;
- the primary character's current body-meter values for meters the successor body contract knows;
- the primary character's current **structured** worn wardrobe.

The mirror deliberately does **not** mint the normal starter world's neighbor, keepsake, meal, commitments, routines, authored lore, or other invented setting facts. Those would contaminate the comparison before the first turn.

Free-text-only outfit prose is not converted into durable garments. Without structured item coverage there is no trustworthy way to infer a slot/coverage graph. If that matters to a test, move the outfit into structured wardrobe state before starting comparison or treat the missing clothing state as a known test limitation.

After initialization, the two lanes evolve independently from the same compared player turns. Legacy time skips are explicitly mirrored so clock deltas stay meaningful. Engine Comparison is not a continuous bidirectional state synchronizer.

### Stopping comparison

Use the same **Engine Comparison** launcher and choose **Stop comparison**.

Stopping:

- returns the conversation to ordinary `legacy_chat` authority;
- removes the mirror branch/actor mappings from the chat;
- deletes a mirror world that was created by the Engine Comparison service;
- **keeps all recorded comparison rows and rulings** for later review.

A historical/manually mapped comparison world is unlinked but is not destructively deleted unless the service can prove it owns that world.

## What runs during a comparison

A chat in the internal `successor_shadow` authority mode continues to run the legacy pipeline normally. After a plain-send exchange settles, Vesper runs a detached successor comparison against the linked mirror branch and records four rows for the exchange:

| Domain | What is compared | How it is judged |
| --- | --- | --- |
| Prose | Legacy reply vs successor render | Human review; the analyzer only detects render failures |
| Presence | Legacy roster presence vs successor physical/engagement truth | Recorder can identify mismatches |
| Meters | Legacy 0..1 meters vs successor fixed-point body meters normalized to 0..1 | Analyzer flags shared-meter differences beyond the configured tolerance and missing mirror meters |
| Clock | Story-time movement in each lane | Analyzer compares successive deltas rather than incompatible absolute clock values |

A legacy time skip is mirrored onto the comparison branch so clock movement remains comparable.

### Important limitation

Comparison mode is intentionally a migration harness, not a second fully authoritative play session. The comparison leg is detached, skips live deliberation, and does not necessarily exercise every successor-only admission or recall path. Treat it as evidence about the compared domains, not proof that an authoritative successor turn would be byte-for-byte identical to the comparison render.

## Two kinds of evidence

Engine Comparison is designed around both repeatable and exploratory evidence:

1. **Fixed comparison corpus** — `pnpm sim:shadow-corpus` runs the versioned scripted scenario in `scripts/sim/shadow-corpus.ts`. Use this as the regression check for known behavior.
2. **Played sessions** — normal comparison-mode conversations exercise combinations that the fixed corpus does not anticipate. Use these to discover migration gaps and narration problems during real play.

Neither replaces the other. A clean fixed corpus can miss a problem that appears only in a long or unusual conversation, while free play is too variable to serve as a deterministic regression test.

## Review terminology

The database still stores the original three `verdict` values for compatibility. The Engine Comparison UI gives them clearer meanings:

| UI status | Stored value | Meaning |
| --- | --- | --- |
| **Unreviewed** | `open` | No final decision has been recorded. Also use this while a required fix is still outstanding. |
| **Accepted / no fix needed** | `intentional` | The row was reviewed and is acceptable. This includes a clean comparison or a deliberate/harmless difference. |
| **Fixed & verified** | `fixed` | The row exposed a real defect, the defect was corrected, and a follow-up comparison verified the correction. |

A row being **Unreviewed does not mean Vesper detected a bug**. All rows begin in that state. Separately, the comparison report surfaces automatically detected unresolved findings from clock, meters, presence, and successor render failures.

Do not mark a row **Fixed & verified** merely because you decided that it *needs* a fix. Leave it Unreviewed until the implementation is changed and the result has been checked again.

## Operator workflow

For the day-to-day procedure, see [playtesting.md](playtesting.md).

For the ruling decision process and examples, see [rulings.md](rulings.md).

## Current surfaces and internal names

- Admin UI and existing-chat launcher: `/admin/shadow` — displayed as **Engine Comparison**.
- Per-chat review: `/admin/shadow/[chatId]`.
- Admin session API: `/api/admin/self/engine-comparison/[chatId]`.
- Internal authority value: `successor_shadow`.
- Comparison storage: `sim_shadow_divergences`.
- Mirror provisioner: `apps/web/src/server/engine/simulation/comparison-world.ts`.
- Session service: `apps/web/src/server/engine/engine-comparison.ts`.
- Analyzer: `apps/web/src/lib/simulation/shadow-parity.ts`.
- Recorder: `apps/web/src/server/engine/sim-shadow.ts`.
- Fixed corpus: `scripts/sim/shadow-corpus.ts`.

These internal names are historical implementation details. New user-facing prose and operational documentation should use **Engine Comparison**, **comparison mode**, **comparison row**, **finding**, and **review status/ruling**.
