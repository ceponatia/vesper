# Scene composer model — a fast, cheap shot planner

Status: shipped — 2026-08-15. All four slices built, and accepted by owner
ruling (2026-08-15): the A/B re-run already taken is the verdict, and the
confirming re-run this plan had reserved is **waived** rather than pending.
Accepted with one element knowingly open — both paid runs were measured on the
pre-fix prompt and grader, so their per-axis staging and camera numbers stay
instrument-bound (the reasoning why the promotion survives that, and what it
rests on instead, is in the spec's Results section). Two things outlived the
plan and neither blocks it: the deployed build has not yet been watched for the
terser composer prose recorded in
[composer-model.spec.md](composer-model.spec.md) §"Per-arm verdicts", and the
`~deepseek/deepseek-v4-flash-latest` row stays curated as the way to try a newer
snapshot on one conversation. A regression in either becomes
`composer-model.followups.md`.

Outcome: The owner can run one command that scores every candidate shot-planning
model against today's on the same intimate scenes, and can switch a live
conversation onto a winner from the chat menu, so that scene images stop waiting
on the slowest and priciest model in the app.

## Why

Before any scene image is painted, a text model reads the conversation and writes
down what the picture should show: who is in it, what they are doing, where the
camera stands, and — during intimate play — which act is being staged. That step
is the **scene composer**, and it runs on Aion 3.0.

Aion 3.0 was chosen for one good reason: it does not flinch. A cautious model
reads the most explicit stretch of a chat and answers with vague poses — "close
to the viewer", "intimate with the viewer" — and the render then produces a nude
portrait of the right person in the right room at the wrong moment. That is a
grounding failure before it is a moderation one, and it is why the composer was
moved onto its own model in the first place.

The cost of that choice is now the complaint. Aion 3.0 is **extremely slow**
(owner report 2026-08-15), and it is the most expensive model in the app by a
wide margin: roughly forty times the token price of the flash-tier model the
in-session agents already run on. Its endpoint also *requires* reasoning — it
rejects any attempt to turn it off — so every composition silently pays for a
reasoning trace nothing ever reads. The player waits for it before the picture
even starts rendering.

Nobody has ever measured whether a cheap model would do the same job. The
composer's answer is a structured object, not prose, so most of what makes one
good is checkable in code — which means this is measurable, and cheaply.

## What the owner gets

- **A one-command comparison.** `composer-model-eval.ts` runs every candidate
  against the shipped default on the same seven fixture scenes — three ordinary
  shots and the four explicitly intimate acceptance scenes — then reports how
  often each model answered, how often production would actually invoke the
  fallback, how often it got the shot right, how fast it was, and what both the
  primary and the full two-rung ladder actually cost.
- **A verdict that can be checked.** The grade is not an opinion. Each model's
  answer is run through the same code that runs in production, so a model only
  scores a point for a camera angle, a staged act, or a quoted piece of evidence
  that the real pipeline would have accepted.
- **A per-conversation switch.** The chat menu gains an admin-only picker for
  which model plans the shot. A candidate model can be tried on a real
  conversation without a deploy, and switched back the same way. The picker
  selects the model only; how that model is called — whether it reasons before
  answering — follows from the probe and lives in code, so an operator cannot
  accidentally select a configuration nobody measured.
- **The numbers to decide with.** Primary cost and effective primary-plus-fallback
  cost are reported per thousand compositions, alongside the measured production
  fallback rate, so a cheap model that leans heavily on Aion 2.0 cannot look
  artificially cheap.

## Boundaries

### In scope

Which **text** model plans the shot, how candidates are compared, and how one is
selected for a conversation.

### Non-goals

- **Changing what the composer is asked.** This plan changes who answers the
  question, never the question: the schema and the evidence gates are untouched,
  and no arm is compared against a different rulebook than another.

  **Scoped exception, 2026-08-15 — the vocabularies were described.** The first
  paid run showed the composer had been handed bare ids for the staging catalog
  and the camera axes, which is not a question so much as a missing definition:
  `kneeling_before_viewer_guided` differed from its sibling by one adjective
  explained nowhere the model could see. Every arm failed the same way, so the
  run was measuring the prompt. The registries now carry selection hints and the
  prompt renders them, and the staging rule asks for the quote that separates
  sibling variants. What the composer is *asked to decide* is unchanged — the
  same ids, the same gates, the same authority — but it can now tell the options
  apart.

  The cost of the exception is stated plainly because it is the reason for the
  non-goal: **runs from before and after this change are not comparable.** The
  fix is not to compare them. Every arm re-runs on the current prompt, and the
  earlier numbers stand only where the change cannot reach them (see
  "Where the work stands").
- **The image model.** Which model *paints* the scene is a separate, already-live
  per-chat setting, and its own comparison lives in
  [intimate-scene-lora.plan.md](../intimate-scene-lora.plan.md).
- **Judging the prose with another model.** An LLM judge was considered and
  declined (owner ruling 2026-08-15): the mechanical checks plus a printed
  side-by-side are the instrument, and a judge would add a second model's
  opinion to a measurement that does not need one.
- **Rendering images from the candidates' specs.** Also declined for now. If two
  arms tie on every mechanical check, that is when pictures would settle it.

## Slices

- **Slice 1 — the composer's model is a curated candidate list, and a conversation
  can be switched onto any of it.** Status: complete — 2026-08-15. Seven
  owner-approved candidates are named in one place with operator guidance; an
  admin picks one per conversation from the chat menu; an uncurated value can
  never reach the provider. Membership in the shortlist is not a validation
  verdict — promotion to the app default is what requires the A/B.
- **Slice 2 — the comparison exists and grades itself honestly.** Status:
  complete — 2026-08-15. The A/B asks every arm the real question and grades the
  answer through the production resolver. It refuses to spend anything if its own
  answer key cannot be satisfied, or if the control is missing from the run. The
  owner entrypoint adds production fallback-rate and effective ladder-cost
  reporting without changing that grading path.
- **Slice 3 — the comparison is run and a verdict recorded.** Status: complete —
  2026-08-15, with a caveat that is written down rather than smoothed over. Two
  paid runs happened; both were measured on the **pre-fix** prompt and grader,
  so neither is the clean re-run this plan asked for. The verdict and the exact
  limits of what those numbers support are recorded in the spec's results
  section. Owner ruling (2026-08-15): **that verdict is accepted and the
  confirming re-run is waived** — the ranking held across both runs and the
  latency and cost gaps are structural, so the ~$0.19 would buy tidier evidence
  for a decision it could not plausibly reverse.
- **Slice 4 — the default moves, or is deliberately kept.** Status: complete —
  2026-08-15. The default moved to DeepSeek 4 Flash, pinned to the tested
  snapshot (`deepseek/deepseek-v4-flash-0731`, which is what the probe's floating
  alias resolved to) and carrying the winning arm's **reasoning-off** call
  configuration, because the model slug alone would not reproduce the arm that
  won. Aion 2.0 stays the refusal rung: the measured fallback rate was 0 in 56
  calls, against the owner's 10% review threshold. Aion 3.0 remains selectable
  per conversation.

## Where the work stands

- **[composer-model.spec.md](composer-model.spec.md)** — complete for all four
  slices. Its results section carries the verdict, the numbers, and the
  instrument caveat below.

**Both paid runs (2026-08-15) were measured on the pre-fix prompt and grader.**
The second run re-ran the superseded instrument with a narrower arm set rather
than re-running on the current prompt, which is not what this plan asked for and
is recorded as such. The rule that follows is therefore about *which* comparisons
are legitimate, not about discarding the runs: **no number from either run may be
compared against a run on the current prompt.** The two runs may be compared with
each other, because they carried the same handicap.

The promotion rests on the two things that survive that limit — a ranking stable
across both runs, and latency and cost gaps no prompt wording can close. Every
per-axis number remains instrument-bound until a re-run.

The first run found three faults, two in the instrument and one in the prompt,
and all three are fixed:

- Every arm was marked wrong on the camera because a single check combined three
  axes, one of which the app deliberately leaves to taste. Orientation, height
  and distance are now graded separately, and distance is reported without
  moving the score.
- `oral_guided` failed every run for every arm because it and `oral` were told
  the same story and expected different answers. The two beats now differ by the
  detail that separates them — the viewer's hand on her head.
- The prompt named the staging and camera vocabularies without defining them, so
  models chose between ids like `kneeling_before_viewer` and
  `kneeling_before_viewer_guided` on the strength of a suffix. Both vocabularies
  now ship a registry-owned description that the prompt renders.

Instrument-bound **in full**, not axis by axis: the third fix changes what every
arm is shown on every beat, so it can move any staging or camera answer anywhere
in the matrix. Both runs were internally fair — every arm carried the same
handicap — but they ranked models on a prompt that no longer exists, which makes
each of them evidence about that prompt wherever the prompt could reach.

The promotion was made anyway, deliberately and on the record, because the two
grounds it rests on are ones the prompt cannot reach: the winner matched or beat
the control on **both** runs, and its 12× latency and 88× cost advantages come
from the control's mandatory reasoning rather than from anything the composer is
asked. Owner ruling (2026-08-15): those two grounds are accepted as the verdict
and the confirming re-run is waived. The per-axis numbers stay caveated wherever
they are quoted — that limit is a property of the data, and accepting the
decision does not retire it.

## Success criteria

- Running the A/B with no provider key prints the exact prompts and spends
  nothing, so the wording is reviewable for free.
- Every candidate's score can be traced to a named check, and every failed check
  names the production diagnostic that produced it.
- Switching a conversation's composer model changes which model the next scene
  render asks, and taking "another take" on a reply does not revert the pick.
- After slice 3, the owner can state — from the table, not from impression —
  whether a cheaper model holds the four intimate scenes, how often it would
  invoke the fallback, and what the complete ladder costs at that measured rate.
- The production default cannot be a floating latest alias; the winning snapshot
  is pinned before promotion.
- Promotion reproduces the **whole winning call configuration**, not merely its
  model slug. If a reasoning-off/low arm wins, production adopts that setting and
  a targeted parity run confirms it before the default moves.

## Owner decisions — 2026-08-15

- **Keep Aion 2.0 as the fallback unless the winning primary actually leans on it.**
  The eval reports the exact production fallback trigger separately from its
  broader quality score. If the measured fallback invocation rate is **10% or
  higher**, review and test a replacement second rung before promoting that
  primary; below 10%, keep Aion 2.0 rather than optimizing a rare path
  pre-emptively. DeepSeek is expected to refuse rarely, but the measured rate —
  not that expectation — makes the call.
- **Pin the winner before it becomes the default.** Floating aliases remain useful
  as eval/admin candidates because they follow new releases automatically. If a
  floating candidate wins, resolve and use the exact snapshot that was tested for
  the production default. A test prevents a `~...-latest`/`-latest` id from being
  promoted accidentally. Where the winning A/B arm also changes reasoning, pin
  that call behavior too; the model ID alone is not the tested product.

## Technical companion

[composer-model.spec.md](composer-model.spec.md) — the candidate list, the seam and
its fallback rung, the persistence and admin surface, and the A/B's arms, answer
keys, grading rules, and ladder-economics report.
