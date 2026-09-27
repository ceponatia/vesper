---
name: vesper-scenario-review
description: Adversarially review a substantial Vesper user flow across state transitions and failure recovery. Use for new or changed multi-step workflows; small copy changes and ordinary unit-level review do not need it.
---

# Review a Vesper scenario

Bound the review to one meaningful user goal and the source paths that implement
it. Read the relevant system and UI docs, entrypoints, state owners, authorization
checks, and nearest tests. Do not turn one flow into a repository-wide audit.

Trace the primary path, then select only plausible variants that could lose work,
mislead the user, cross an authorization boundary, or leave inconsistent state:

- entry from each supported navigation path and return/back behavior;
- drafts, refresh, cancellation, and resuming partially completed work;
- duplicate submit, retry, timeout, stale data, and interrupted navigation;
- unauthenticated, unauthorized, missing, and no-longer-eligible resources;
- partial success across client, route, database, job, or provider boundaries;
- empty, loading, error, and degraded states, including fallback diagnostics.

For each material scenario, state the starting facts, user action, expected state
transition, source-backed actual behavior, and recovery path. Distinguish code or
contract facts from hypotheses that require CI or live observation. Do not claim
that reading source proved rendered UI, timing, provider behavior, or deployment.

Report actionable findings first, with paths/lines and the concrete user impact.
Include only scenarios that materially affect correctness, access, recovery, or
friction. A clear result with no findings is valid.

`vesper-testing` owns whether a finding warrants a test, its owning layer, and CI
selection. Do not add tests automatically or prescribe duplicate coverage. Do not
run local application tests, lint, typecheck, builds, integration setup, live UI,
provider calls, or external mutations during this review.

Finish after the bounded goal's meaningful transitions and recovery paths are
accounted for. Identify untested hypotheses and hand implementation, testing, or
live verification to the owning workflow rather than expanding the review.
