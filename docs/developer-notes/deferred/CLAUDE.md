# deferred/ — plan stubs and drafts awaiting promotion

This folder contains **plan stubs and drafts for later promotion into real
plans on the roadmap**. Every file here is `Status: draft` — a placeholder
capturing a parked idea's what/why plus the plan-template skeleton. Nothing
here is settled, scheduled, or on the roadmap, and **nothing here gets built
from the stub**.

Rules for agents working in this folder:

- **Do not build from a stub.** Building requires promotion first, on the
  owner's request (usually after a fleshing-out discussion).
- **Promotion:** flesh the stub into a real plan, `git mv` it up to
  `docs/developer-notes/<topic>.plan.md` (add a `<topic>.spec.md` beside it
  when design detail warrants one), set `Status: next` (or `active`), add the
  corresponding [../roadmap.md](../roadmap.md) line, and leave a one-line
  "graduated → …" tombstone in [../deferred.plan.md](../deferred.plan.md)'s
  anchor section for this backlog.
- New parked ideas MAY be added here as stubs using the same template
  (`Status: draft` + What / Why it matters / Sketch / Open questions / Slices)
  with a matching line in ../deferred.plan.md.
- File:line refs inside stubs are review evidence captured at parking time —
  **re-verify on promotion**; the code moves.

## Current stubs

Parked 2026-07-23 from the three-lens successor-engine review (correctness ·
simulation fidelity · resilience/perf), run the day the world-UI slices 0–5
shipped. Groups: A bugs first · B living world · C hardening & perf.

- A1 [sim-command-idempotency.plan.md](sim-command-idempotency.plan.md)
- A2 [turn-clock-race.plan.md](turn-clock-race.plan.md)
- A3 [solo-retake.plan.md](solo-retake.plan.md)
- A4 [move-together-atomicity.plan.md](move-together-atomicity.plan.md)
- A5 [drain-chunking.plan.md](drain-chunking.plan.md)
- A6 [drain-trigger-backoff.plan.md](drain-trigger-backoff.plan.md)
- A7 [arrival-target-mismatch.plan.md](arrival-target-mismatch.plan.md)
- B8 [starter-world-seeds.plan.md](starter-world-seeds.plan.md)
- B9 [primary-lod-ruling.plan.md](primary-lod-ruling.plan.md)
- B10 [remote-channels.plan.md](remote-channels.plan.md)
- B11 [successor-npc-initiative.plan.md](successor-npc-initiative.plan.md)
- B12 [named-skips.plan.md](named-skips.plan.md)
- B13 [autonomous-npc-travel.plan.md](autonomous-npc-travel.plan.md)
- C14 [sim-read-seam-guards.plan.md](sim-read-seam-guards.plan.md)
- C15 [composition-diagnostics.plan.md](composition-diagnostics.plan.md)
- C16 [turn-loop-efficiency.plan.md](turn-loop-efficiency.plan.md)

Fleshed out (still parked): A7 (2026-07-23 — owner rulings recorded in the
stub; A5+A6+A7 graduate together as one drain-hardening plan).

Added after the review:

- [travel-duration-authoring.plan.md](travel-duration-authoring.plan.md) —
  owner-noted world-authoring system (2026-07-23, recorded during A7's
  flesh-out)
