# Turn-loop read consolidation + integration coverage

Status: draft (stub — successor-engine backlog item C16, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

Two halves, both on the composed turn loop:

- **Redundant reads.** A departure/accompany turn re-materializes the full
  space projection 3–4× (~18–30 queries; `readDurableSpaceBranch` call sites in
  `sim-exchange.ts:1076/1230/1364-1379`) and re-reads chat authority 3×.
  Threading the already-loaded projection through the loop is the biggest
  latency win. (M)
- **Missing coverage.** The composed flows have zero integration tests
  (`sim-routes.int.test.ts` stops at R3 slices 1–2); extend it (self-skips
  without Postgres) and extract pure step-planners so the §8 fallback+diagnostic
  pairs become unit-testable. (M)

Related: projections are O(state), not O(events), so `sim_events` being
append-only with no retention story is storage bloat, not latency — document or
add a rollup later.

## Why it matters

The loop pays for the same projection three or four times over on every
departure/accompany turn, and none of the composed choreography is guarded by
tests — so a regression in the fallback paths ships unseen.

## Sketch

Load the space projection and chat authority once, thread them through the
loop's call sites. Split the composition into pure step-planners that take the
loaded state, then cover both the happy path and the degradation pairs in the
extended integration suite plus new unit tests.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
