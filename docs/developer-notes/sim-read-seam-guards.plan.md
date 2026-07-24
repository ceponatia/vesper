# Sim read hardening — guard the seams, read them fresh, read them once

Status: shipped — 2026-07-24 (graduated same day from successor-engine backlog
items **C14** resilience guards + meters-staleness and **C16** turn-loop read
consolidation — C16 folded in per owner ruling; rulings under §Rulings. All four
slices built by two Opus subagents; five local gates green —
lint/cycles/typecheck/**2534 pure tests**/jscpd. **Leftovers:** the degradation,
integrate-on-read, and composed-flow **integration** tests gate in CI only (no
local Postgres at ship time); Fly UI verification pending; and Unit B flagged a
`route.ts:275` per-request authority double-read as an out-of-scope follow-up.)

## What

Three related defects on the successor **read** paths, all from the 2026-07-23
three-lens review. Two live in the state-read surface
(`src/server/engine/sim-surfaces.ts`), the third in the composed turn loop
(`src/server/engine/sim-exchange.ts`):

1. **Four read-seams 500 the whole state strip (HIGH · S).** `readSimChatPresence`
   (`sim-surfaces.ts:92`), `readSimChatMeters` (`:273`), `readSimChatRelationship`
   (`:316`), and `readSimChatOutfit` (`:360`) do their DB reads and derivations
   with **no degradation wrap** — a raw throw propagates to the route boundary.
   One malformed JSONB row (or a missing branch row — `readDurableBodies` throws
   a bare `"Simulation branch not found"`) takes down the entire response with a
   generic 500. Verified callers: `state/route.ts:150` runs
   `Promise.all([readSimChatMeters, readSimChatRelationship])`, so either throw
   kills the whole state strip; `route.ts:236` runs
   `Promise.all([readSimChatPresence, readSimChatOutfit])`. Direct violation of
   `docs/resilience.md` §7 (degrade at every trust boundary).

2. **Meters are shown stale (MED · S).** `readSimChatMeters` (`:284-287`) returns
   the stored fixed-point rows straight from `readDurableBodies` **without
   integrating to the branch clock** — the comment admits it ("Stored values
   (integrate-on-read is the named refinement)"). The strip shows every meter as
   of the last body *event*, not *now*: hygiene that has drifted for six
   story-hours still reads at its last-written value. The pure integrator exists
   (`integrateMeterValue`, `lib/simulation/bodies.ts` §25.1) and the branch clock
   (`storySecond`) is already in the read's inputs — a wiring gap, not new math.
   **Prerequisite for [physiology.plan.md](deferred/physiology.plan.md)**, which
   reads body state through this same seam.

3. **The turn loop pays for the same reads 3–4× (MED · M), and none of the
   composed choreography is tested (MED · M)** — folded-in C16. A
   departure/accompany turn re-materializes the full space projection several
   times (`readDurableSpaceBranch` call sites in `sim-exchange.ts` — currently
   `:338/1249/1361/1430/1576/1770`, re-verify at build; ~18–30 queries) and
   re-reads chat authority more than once (`:154/:624`). And the composed flows
   have **zero** integration tests — `sim-routes.int.test.ts` stops at R3 slices
   1–2 — so a regression in the §8 fallback/diagnostic paths ships unseen.

## Why it matters

A single bad row should degrade **one** panel, not the strip and the turn behind
it — today the blast radius is the whole GET route, surfacing as an opaque 500
instead of a local, diagnosable "this panel is unavailable." Even on the happy
path the meter chips lie, freezing at the last write while story time moves on,
which reads as a broken simulation. And the departure loop re-derives the same
projection three or four times per turn while its degradation paths run
un-guarded by any test. All three are fixable with machinery that already exists
in the same files and the bodies kernel.

## Design / recommendations

### Slice 1 — wrap-and-degrade the four seams (the resilience fix)

Mirror the already-correct `readSimChatWorld` (`sim-surfaces.ts:143-265`) exactly:

- Keep the **authority guard outside** the try — a `legacy_chat` / `shadow` /
  unrouted chat returning `null` is a legitimate "not a routed chat," not a
  degradation. Only the DB/derivation work goes inside the wrap.
- Wrap that work in `try { … } catch (error) { log.warn("engine.sim", "<seam>
  read degraded to null", { chatId, error: error instanceof Error ?
  error.message : String(error) }); return null }`, one distinct message per
  seam ("presence read…", "meters read…", "relationship read…", "outfit
  read…") so the diagnostic names which surface dropped.
- No caller change required — all four already return `T | null`, and `null` is
  the documented "hide this panel" contract every caller handles. The ad-hoc
  `.catch()` wrappers at `sim-exchange.ts:824/828` (outfit/relationship) become
  redundant once the reads self-degrade — simplify them to a plain `await` in
  the same pass.

Result: a malformed row yields a missing panel + a logged diagnostic, never a
500. Zero happy-path behavior change (pinned by test).

### Slice 2 — integrate meters on read, via one shared view builder

Ruling: **full integration including off-screen self-care, through an extracted
shared helper** (Open question 1, resolved).

- The per-meter `MeterIntegrationView` builder is currently **duplicated** in
  `material-store.ts:815` and `activity-store.ts:578` (resolve the definition
  from `bodyMeterRegistryByVersion` by the row's `registryVersion`, attach that
  meter's modifiers, attach `selfCareAdjustmentsBetween(rhythms, …)` for the
  §25.5 self-care jumps). Extract it into one pure helper in
  `lib/simulation/bodies.ts` — `buildMeterView({ meters, modifiers, rhythms },
  meterKey, horizon): MeterIntegrationView | undefined` — and route **both
  command stores and this read** through it (kills the jscpd-flagged
  duplication; gives physiology a single clean seam).
- `readSimChatMeters` switches from `readDurableBodies` (branch projection, **no
  rhythms**) to `loadActorBody(db(), branchId, primaryActorId)`, which returns
  `{ meters, conditions, modifiers, rhythms }` for exactly the one actor the
  strip needs — a *narrower* query that also carries rhythms for a fully correct
  read. For each meter: `integrateMeterValue(buildMeterView(rows, key,
  storySecond), storySecond) / METER_FIXED_POINT_ONE`. The self-care `horizon`
  need only reach `storySecond` (we integrate *to* now, never into the future).

This read feeds display only — the turn pipeline reads bodies through the
command path, which already integrates — so the fix cannot change turn outcomes.

### Slice 3 — thread the projection through the composed loop (folded C16 perf)

Load the space projection and chat authority **once** at the top of the composed
departure/accompany turn and thread the loaded state through the call sites that
currently re-fetch it (`readDurableSpaceBranch` ×~6, `readChatEngineAuthority`
×2). Split the composition into **pure step-planners** that take the already-loaded
state as an argument rather than re-reading — which is also what makes slice 4's
unit tests possible. Biggest single latency win on the heaviest turn type.

### Slice 4 — cover the composed flows (folded C16 coverage)

Extend `sim-routes.int.test.ts` past R3 slices 1–2 to exercise the composed
departure/accompany/solo choreography end-to-end (self-skips, no live model),
and unit-test the slice-3 pure step-planners' §8 fallback+diagnostic pairs
directly. Related (document, don't fix here): projections are O(state) not
O(events), so `sim_events` being append-only with no retention story is storage
bloat, not latency — note it for a later rollup decision.

## Slices

1. **Resilience guards** — wrap the four seams; per-seam diagnostic; happy-path
   parity test. (HIGH · S) — ship first; unblocks nothing, stops the 500s.
2. **Integrate-on-read meters** — extract `buildMeterView`, rewire the two
   stores to it, integrate `readSimChatMeters` at `storySecond` via
   `loadActorBody`. (MED · S) — the [physiology.plan.md](deferred/physiology.plan.md)
   prerequisite.
3. **Turn-loop read consolidation** — load space + authority once, thread
   through the loop, extract pure step-planners. (MED · M)
4. **Composed-flow coverage** — extend `sim-routes.int.test.ts` + unit-test the
   step-planners' fallback/diagnostic pairs. (MED · M)

Slices 1–2 (`sim-surfaces.ts`) and 3–4 (`sim-exchange.ts`) are independent and
each shippable alone; 1 is the urgent resilience fix, 2 the correctness fix + a
downstream unblock, 3 the latency win, 4 the safety net that 3 makes tractable.

## Testing

- **Degradation (per CLAUDE.md — assert fallback AND diagnostic):** an
  integration case inserting a malformed row for each of the four seams'
  underlying tables, asserting the read returns `null` **and** the `log.warn`
  diagnostic fired (spy) — extends/adds `sim-surfaces.int.test.ts`.
- **Integrate-on-read:** pure unit tests on `buildMeterView` + `integrateMeterValue`
  (drift over N story-seconds; a modifier boundary; a self-care jump) — no
  Postgres. Plus an int case asserting a meter that has drifted since its last
  write reads at its integrated (not stored) value.
- **Parity:** a test pinning that a well-formed routed chat's four reads are
  byte-identical before/after the guard wrap (no happy-path change).
- **Composed flows (slice 4):** the extended `sim-routes.int.test.ts` + the pure
  step-planner unit tests above.

## Rulings

_Resolved 2026-07-24 (owner, via the promotion discussion):_

1. **Meters fix thoroughness** → **full integration incl. self-care through an
   extracted shared `buildMeterView`** (rather than a local builder or drift-only).
   Correct, dedups the two command stores, and forward-compatible for physiology.
2. **Scope** → **fold C16** (turn-loop redundant reads + composed-flow coverage)
   into this plan as slices 3–4, since it's the same read paths / adjacent files.

## Open questions

_None — both resolved above. C16's line refs were captured at parking
(2026-07-23) and have already drifted; re-verify at build (see §What item 3)._
