# Engine Comparison

Engine Comparison is Vesper's legacy-versus-successor migration harness. It lets a normal legacy character chat remain authoritative while the successor simulation independently evaluates the same player turns against a linked simulation branch. The results are recorded for later review; the successor comparison never rewrites the legacy transcript or legacy chat state.

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

- Admin UI: `/admin/shadow` — displayed as **Engine Comparison**.
- Per-chat review: `/admin/shadow/[chatId]`.
- Internal authority value: `successor_shadow`.
- Comparison storage: `sim_shadow_divergences`.
- Analyzer: `apps/web/src/lib/simulation/shadow-parity.ts`.
- Recorder: `apps/web/src/server/engine/sim-shadow.ts`.
- Fixed corpus: `scripts/sim/shadow-corpus.ts`.

These internal names are historical implementation details. New user-facing prose and operational documentation should use **Engine Comparison**, **comparison mode**, **comparison row**, **finding**, and **review status/ruling**.
