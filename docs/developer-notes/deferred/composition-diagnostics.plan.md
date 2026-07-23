# Make composition half-failures observable

Status: draft (successor-engine backlog item C15, parked 2026-07-23; **fleshed
out 2026-07-23 — owner rulings 1–3 recorded below**; still parked — promote per
[CLAUDE.md](CLAUDE.md) before building. Per ruling 3 it graduates as part of
the **drain-hardening bundle with A5
[drain-chunking](drain-chunking.plan.md) + A6
[drain-trigger-backoff](drain-trigger-backoff.plan.md) + A7
[arrival-target-mismatch](arrival-target-mismatch.plan.md)**, inheriting that
bundle's timing — see A7 ruling 4's tripwire.)

## What

Half-failures in turn composition are invisible in production: the resilience
design (degrade, keep the turn alive) is working as intended while hiding its
own failures. Verified evidence (file:line captured 2026-07-23 — re-verify on
promotion):

- **Eight log-only fallback sites**, `log.warn` and nothing else:
  - departure choreography — end-engagement fallback
    (`sim-exchange.ts:1113`), move not accepted → plain solo render (`:1161`),
    arrival drain did not converge (`:1171`);
  - walk-with-me — end-engagement fallback (`:1305`), primary move not
    accepted → player travels alone (`:1356`), drain did not converge
    (`:1368`), co-present scene did not reopen after arrival (`:1481`);
  - world beats — beat write degraded after the command already succeeded
    (`sim-beats.ts:97`).
- **Solo diagnostics are collected, returned, and then dropped**: the solo
  path assembles `[...solo.diagnostics, ...rendered.diagnostics]`
  (`sim-exchange.ts:1733`) and returns them in the API result, but
  `persistAssistantReply`'s meta omits them (`:1741-1747`) — the evidence
  lives for one HTTP round-trip. The co-present path likewise persists no
  diagnostics (`:996-1004`).
- **The precedent is already built**: agent-failure telemetry writes durable
  `agent_failure`/`agent_run` rows into the existing `events` table
  (deliberately no migration — "a debug surface must not cost a migration"),
  fire-and-forget, tallied per-leg in the admin chat inspector
  (`server/ai/agent-failures.ts`, `contracts/turns/agent-failure.ts`). It was
  built because the archivist leg timed out in production **for days** and was
  only caught by a chance `fly logs` grep — C15 is the same blindfold one
  layer up, at the choreography level. (HIGH · S/M)

## Why it matters

Degradation is silent: the turn still ships, but there is no signal that a
composition leg fell back. Diagnosing "why did she travel alone?" after the
fact is impossible when the evidence never left the request logs — and there
is no way to know whether the other parked drain fixes are urgent in practice
because nobody can count how often live turns degrade.

## Owner rulings (2026-07-23 — copy into engine.spec §39 at promotion)

1. **Record on both surfaces.** Each degradation lands (a) in the affected
   message's persisted meta — open any suspicious beat and see exactly what
   degraded and why — and (b) as a durable tally row for the admin inspector,
   so trends ("traveled-alone fired 14 times this week") are visible at a
   glance. One shared collector feeds both.
2. **Admin-only.** Players see only the honest prose, exactly as today; no
   player-facing hint, notice, or retry affordance. The records exist purely
   for diagnosis and counting — consistent with the §14.4 public-face rules.
3. **Graduates inside the drain-hardening bundle** (A5+A6+A7+C15), inheriting
   its timing. Natural synergy: A5's `drainedShort` honesty outcome becomes
   one of the recorded codes.

## Sketch

- **A sibling event type, not new agent-failure legs**: the agent-failure
  vocabulary (timeout / api_error / parse_failed + provider causes) describes
  model calls and doesn't fit choreography fallbacks. Add a
  `composition_fallback` event type with its own small pure contract in
  `contracts/turns/` (site, fallback code, chatId, messageId when known,
  detail, at), recorded fire-and-forget through the same `events`-table
  pattern — no migration.
- **A closed fallback-code vocabulary** (registry-style data edit to extend):
  roughly `end_engagement_fallback`, `move_rejected_solo_render`,
  `traveled_alone`, `drain_diverged`, `drain_short` (A5's outcome),
  `scene_reopen_failed`, `beat_write_degraded` — stable codes are what make
  the tally meaningful.
- **A collector threaded through the choreographies** (the solo path already
  threads `solo.diagnostics` — same shape), landing in reply meta at both
  `persistAssistantReply` sites (co-present and solo, which today drops what
  it already collected) and mirrored into the events rows. The API response
  keeps returning diagnostics as it does today.
- **Inspector tally section** beside the agent-failure tallies, with human
  labels per code (the `LEG_LABELS` precedent).
- Degradation tests assert the fallback **and** the recorded code
  (docs/resilience.md law) — the existing degradation tests for these paths
  gain one assertion each.

## Slices

Sized for the bundled drain-hardening plan.

1. **Contract + recorder** — the `composition_fallback` contract and code
   vocabulary, the fire-and-forget recorder, and wiring at the eight warn
   sites (each keeps its `log.warn`).
2. **Reply-meta persistence** — thread the collector to both persist sites;
   stop dropping the solo diagnostics that are already in hand.
3. **Inspector tally** — the admin surface beside agent failures, filterable
   by chat like the existing tallies.

## Open questions

- Code granularity: per-site codes (as sketched) vs site+code pairs (one
  `traveled_alone` code with a `site: accompany` field) — decide when writing
  the contract.
- Should `writeWorldBeat` record its own degradation internally (it knows the
  most) or leave recording to call sites (which know the choreography
  context)? Leaning internal, with the chatId it already holds.
