# Drain hardening — follow-ups

Status: **closed — mid-drain retarget built 2026-08-11.** One post-ship item:
the retarget that the [plan](drain-hardening.plan.md)'s slice-4 note left as a
small follow-up on the then-new runner. It is built and int-tested; nothing
here is outstanding.

## Mid-drain retarget (A5 follow-up) — built 2026-08-11

**Gap.** Engine spec [ruling 24](../engine.spec.operations.md) states that the
durable time job "re-reads its target between steps so a mid-drain delay
extends rather than strands", and the [A5/A7 design](drain-hardening.arrival.md)
§Sketch adopted exactly that from the 2026-07-23 review — but the runner
shipped without it. `runClaimedTimeJob`
(`src/server/engine/simulation/time-job-store.ts`) captured
`targetStorySecond` at claim time, so an `enqueueTimeJob` bump landing on a
`processing` row (a delayed arrival, an escalation reaching further) was
ignored: the drain completed at the stale target, and the bumped target
stranded on a `completed` row that nothing would ever re-claim.

**Fix.** The runner treats the target as live:

- Each step opens with a fenced re-read of the row's `target_story_second` —
  the same `id + lease_owner + processing` fence every job write uses — and
  drains to that value. A missing row is an early `lease_lost`.
- The terminal `completed` write additionally fences on the target it drained
  to. A bump that commits while the final step is draining (the common
  single-step case) makes that write miss; the runner re-reads, adopts the
  further target, and keeps draining instead of sealing the bump away on a
  completed row.
- Backoff and progress writes deliberately stay off the target fence: they
  never write `target_story_second` and leave the row active, so a concurrent
  bump survives on the row and is picked up on resume.

Covered by an int test in `time-job-store.int.test.ts`: a target bumped while
the job is `processing` lands the drain on the new target, resolving a trigger
due inside only the extended window.
