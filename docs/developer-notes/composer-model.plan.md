# Scene composer model — a fast, cheap shot planner

Status: active (planned 2026-08-15)

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
  selects the model ID only; DeepSeek's reasoning-off/low A/B variants are
  probe-only configurations until Slice 4 encodes a winning reasoning policy.
- **The numbers to decide with.** Primary cost and effective primary-plus-fallback
  cost are reported per thousand compositions, alongside the measured production
  fallback rate, so a cheap model that leans heavily on Aion 2.0 cannot look
  artificially cheap.

## Boundaries

### In scope

Which **text** model plans the shot, how candidates are compared, and how one is
selected for a conversation.

### Non-goals

- **Changing what the composer is asked.** The system prompt, the schema, the
  evidence gates and the staging registry are all untouched. This plan changes
  who answers the question, never the question.
- **The image model.** Which model *paints* the scene is a separate, already-live
  per-chat setting, and its own comparison lives in
  [intimate-scene-lora.plan.md](intimate-scene-lora.plan.md).
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
- **Slice 3 — the comparison is run and a verdict recorded.** Status: next —
  owner action, needs an OpenRouter key and costs roughly $2. The result table and
  the per-model verdict land in the spec's results section.
- **Slice 4 — the default moves, or is deliberately kept.** Status: blocked on
  slice 3. Either outcome is a result: if nothing matches Aion 3.0 on the intimate
  beats, "it stays, and here is the evidence" closes this plan just as well. A
  winning floating candidate is pinned to the exact tested snapshot before it
  becomes the production default. If the winning arm also used a non-default
  reasoning profile (the DeepSeek off/low arms), that exact profile is encoded in
  the composer call and parity-probed before promotion; changing only the model
  slug would not reproduce the winning arm.

## Where the work stands

- **[composer-model.spec.md](composer-model.spec.md)** — complete for slices 1–2;
  its results section is empty and is what slice 3 fills.

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
