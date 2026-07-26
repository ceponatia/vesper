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

- A1 — graduated 2026-07-24 → [../command-integrity.plan.md](../command-integrity.plan.md)
- A2 — graduated 2026-07-24 → [../command-integrity.plan.md](../command-integrity.plan.md)
- A3 [solo-retake.plan.md](solo-retake.plan.md)
- A4 — graduated 2026-07-24 → [../command-integrity.plan.md](../command-integrity.plan.md)
- A5 — graduated 2026-07-23 → [../drain-hardening.honesty.md](../drain-hardening.honesty.md)
- A6 — graduated 2026-07-23 → [../drain-hardening.backoff.md](../drain-hardening.backoff.md)
- A7 — graduated 2026-07-23 → [../drain-hardening.arrival.md](../drain-hardening.arrival.md)
- B8 [starter-world-seeds.plan.md](starter-world-seeds.plan.md)
- B9 [primary-lod-ruling.plan.md](primary-lod-ruling.plan.md)
- B10 [remote-channels.plan.md](remote-channels.plan.md)
- B11 [successor-npc-initiative.plan.md](successor-npc-initiative.plan.md)
- B12 [named-skips.plan.md](named-skips.plan.md)
- B13 [autonomous-npc-travel.plan.md](autonomous-npc-travel.plan.md)
- C14 — graduated 2026-07-24 → [../sim-read-seam-guards.plan.md](../sim-read-seam-guards.plan.md)
- C15 — graduated 2026-07-23 → [../drain-hardening.diagnostics.md](../drain-hardening.diagnostics.md)
- C16 — graduated 2026-07-24 → [../sim-read-seam-guards.plan.md](../sim-read-seam-guards.plan.md) (folded into the C14 plan per owner ruling; stub removed)

**Graduated:** A1+A2+A4 promoted 2026-07-24 as the one command-integrity plan
[../command-integrity.plan.md](../command-integrity.plan.md) (serialize, survive,
atomize; discussion-complete at parking, all three stubs removed).
A5+A6+A7+C15 promoted 2026-07-23
as [../drain-hardening.plan.md](../drain-hardening.plan.md) (owner lifted the
A7 tripwire parking; the bundle rolls out next — the review that triggered
promotion also hardened the stubs' job/leasing/poison-trigger design).
C14+C16 promoted 2026-07-24 as [../sim-read-seam-guards.plan.md](../sim-read-seam-guards.plan.md)
(C16 folded into the C14 plan per owner ruling; its stub removed).

Parked 2026-07-24 from the successor engine & chat-UI product review (a
static 20-item review, code-verified claim-by-claim before parking; items that
duplicated the 2026-07-23 backlog were folded into the stubs above instead of
re-parked — its idempotency/serialization item is A1+A2+A4, its solo-retake
item added the stale-cut addendum to A3, and its partial-travel item's
server half shipped with drain-hardening). Groups: D honest controls ·
E lifecycle integrity · F honest progress & status · G product &
maintainability.

- D17 [sim-chat-capabilities.plan.md](sim-chat-capabilities.plan.md)
- D18 [sim-stop-cancellation.plan.md](sim-stop-cancellation.plan.md)
- D19 [sim-branch-ux.plan.md](sim-branch-ux.plan.md)
- E20 [successor-world-lifecycle.plan.md](successor-world-lifecycle.plan.md)
- F21 [sim-typed-stream.plan.md](sim-typed-stream.plan.md)
- F22 [sim-world-surface-ux.plan.md](sim-world-surface-ux.plan.md)
- F23 [sim-turn-time-honesty.plan.md](sim-turn-time-honesty.plan.md)
- G24 [worlds-dashboard.plan.md](worlds-dashboard.plan.md)
- G25 [chat-conversation-refactor.plan.md](chat-conversation-refactor.plan.md)
- G26 [composer-drafts-ime.plan.md](composer-drafts-ime.plan.md)
- G27 [sim-memory-index-worker.plan.md](sim-memory-index-worker.plan.md)

Added after the review:

- [travel-duration-authoring.plan.md](travel-duration-authoring.plan.md) —
  owner-noted world-authoring system (2026-07-23, recorded during A7's
  flesh-out)
- [location-authoring.plan.md](location-authoring.plan.md) — owner-requested
  location builder (2026-07-23): authored locations outside the entity
  library — spatial model (position/facing/obstacles/line of sight),
  furniture, ownership/residency, upkeep, function typing
- security-authz — graduated 2026-07-25 (same day as parking) →
  [../security-authz.plan.md](../security-authz.plan.md) (S1–S7 from the
  2026-07-25 external static security review; queued at the top of the
  roadmap's Next)
- [physiology.plan.md](physiology.plan.md) — owner-requested physiology
  simulation (2026-07-23): triggered body responses as background processes
  (arousal → blood flow → swelling/lubrication, cold → shivering, fear →
  trembling, …) whose results — not the processes — surface to the narrator;
  generalizes the meter-economy OQ2 ruling into a response registry
- [body-attribute-affordances.plan.md](body-attribute-affordances.plan.md) —
  owner-requested body-attribute physics and visual affordance layer
  (2026-07-26): per-attribute physical contributions composed by
  cross-attribute phenomenon rules, dirtied by live state/environment/pose
  changes and surfaced only as perception-gated structured cues
