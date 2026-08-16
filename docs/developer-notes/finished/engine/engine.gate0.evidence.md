# Engine plan — Gate 0: establish trustworthy evidence

Status: **ADVANCE — closed 2026-07-16.** See the exact evidence and bounded follow-ups in
[finished/engine/gate0.closeout.md](../../finished/engine/gate0.closeout.md). This status
permitted Gate 1 only; no spike was promoted to production.

Part of the [engine.plan.md](engine.plan.md) gate set (split 2026-07-21; one doc per
gate — see the hub's gate index). Sequencing and current status live in
[roadmap.md](../../roadmap.md) and the hub; normative contracts live in the
[engine.spec.md](../../engine.spec.md) §-index.

## Gate 0 — establish trustworthy evidence

Rough effort: **3–6 developer-days**, excluding the already queued meter plan.

### G0.1 Repair the known invariant

Ship the group-retake repair above and preserve a regression fixture with at least two
non-primary members whose mutable fields change during the discarded response.

### G0.2 Build the baseline harness

Create a fixed scenario corpus and capture:

- input messages and authored setup;
- deterministic state before and after each turn;
- rendered transcript;
- model, prompt, and completion tokens by leg;
- p50 and p95 end-to-end latency;
- model-call count and degraded-leg count;
- contradiction, perspective leak, and hard-effect repair counts.

The harness must replay a pinned case without editing fixtures by hand.

### G0.3 Run three sub-day spikes

**Witness eligibility spike.** In the old session lane only, make viewpoint identity a
SQL eligibility condition before vector ranking. Preserve explicitly global or authored
records. Use the existing concealment fixture to verify that an observer can retrieve a
transfer and a non-observer cannot.

**Schedule-kind shadow spike.** Run inferScheduleKind without causing effects. Review its
confusion matrix across authored profiles, especially ambiguous activity prose. Any
false-positive hard physiological or location effect fails the spike.

**Grounded-context ablation.** Give the current narrator one deterministic, redacted
context difference—such as daylight/privacy or the owner-approved 6am-versus-8am body
state—without adding a model call. Compare baseline and treatment transcripts blindly.

### Gate 0 exit

- retakes restore all member state;
- baseline data is reproducible;
- at least one spike improves a declared quality dimension without a deterministic leak;
- no spike is silently promoted into production based on anecdotes.

If viewpoint filtering provides no measurable benefit in the controlled scenario, revise
the proposed belief slice before building its tables.

