# Successor world engine — the live contract and what remains open

Status: active — the engine runs in production for successor chats. Everything
still open on this track is optional or owner-gated; nothing is mid-build.

Outcome: A developer can find the engine's binding rules in one indexed place and
see at a glance which engine work is still open, so that a change to a running
system is checked against its contract rather than against memory.

## What this plan is

The engine's foundation shipped: gates 0–6 closed 2026-07-16 → 2026-07-21, and
rollout R0–R6 made it the world authority for successor chats. That build history
is archived — [finished/engine/engine-foundation.plan.md](finished/engine/engine-foundation.plan.md)
and its gate docs.

This plan owns what is **still live**: the normative contract every engine change
is measured against, and the short list of work that was deliberately left open.
It exists because those two things outlived the plan that produced them, and a
contract with no owning plan is a floating document nobody maintains.

Two audiences, deliberately separated:

- **How the engine works** — [docs/engine/](../engine/README.md), the reference
  tier. Present tense, no history. This is what to read to understand or change
  the engine.
- **What the engine guarantees** — [engine.spec.md](engine.spec.md) and its six
  cluster files, below. Normative, with stable § numbers that source cites
  directly.

## The contract

[engine.spec.md](engine.spec.md) is the authoritative § → file index over six
cluster files (kernel, world, mind, bodies-materials, LOD, operations). Section
numbering is **global and never renumbers**, which is what makes it safe for
source to cite: 156 call sites across `apps/`, `packages/` and `scripts/` name
sections as `engine.spec §N`, and the index resolves them.

That stability is a constraint on editing, not just a convenience. A new section
joins the cluster file owning its range; a genuinely new domain gets its own
cluster file plus an index row. Sections are never renumbered to close a gap.

Owner rulings live in §39 (`engine.spec.operations.md`) and nowhere else.

## What remains open

- **Gate 7 — institutions and macro simulation.** Status: queued, optional,
  owner-gated. Its sequencing precondition (rollout R6) exited 2026-07-22, so it
  is unblocked, but it opens only on the owner's call. Scope and build order:
  [engine.gate7.institutions.md](engine.gate7.institutions.md).
- **The live paired quality evals.** Status: queued — owner-gated spend. Every
  gate from 4 onward closed on its deterministic exit corpus per the 2026-07-18
  exit-scope ruling; the human-scored comparison was never run. It rides the
  spend list in [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs.
- **Product ruling 12 — route-estimate uncertainty exposure.** Status: blocked on
  the travel work that needs it. The one product ruling still open; recorded in
  `engine.spec.operations.md` §39.
- **The parked improvement backlog.** Status: parked. Post-rollout review
  findings sit as draft stubs under `deferred/` and graduate one at a time on the
  owner's go, never in bulk ([deferred/CLAUDE.md](deferred/CLAUDE.md)).

## Success criteria

- Every engine change is checked against a § the spec actually defines, and a
  `engine.spec §N` citation in source resolves through the index.
- An open item above is either built, or moved to `deferred/` with a reason —
  never left to decay in place.
- The reference tier and the contract do not disagree. Where they do, the spec is
  authoritative and [docs/engine/](../engine/README.md) is the side to correct.

## Open questions

None. Product ruling 12 is tracked above as open work rather than as a question:
it has a decision to make, not an ambiguity to resolve.
