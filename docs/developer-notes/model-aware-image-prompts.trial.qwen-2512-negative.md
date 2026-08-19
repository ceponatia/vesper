# Qwen Image 2512 — negative-prompt trials

Status: closed — negative transport unsupported, clothing wording fixed (2026-08-19)

Companion to [model-aware-image-prompts.plan.md](model-aware-image-prompts.plan.md) §"Stage 6";
instrument: `scripts/eval/prompt-programs/qwen-2512-negative-blocks.ts`.

## The decision this reached

**Qwen Image 2512 ignores its `negative_prompt` field.** The question the trial
program was built to answer — which negative blocks help, which are neutral,
which cause collateral damage — turned out not to apply to this endpoint, because
the channel those blocks would travel does not work.

That is a per-endpoint finding, not a judgement on negative prompting or on the
blocks themselves. The constraints Vesper compiles are still correct; this
endpoint has nowhere to put them.

## Trial A / A2 — the canary

The easiest test that could exist: ask for a red apple, put `red apple, apple` in
the negative field, and see whether the apple survives.

| Arm                              | Seeds | Apple present | Mug preserved |
| -------------------------------- | ----- | ------------- | ------------- |
| no negative, `go_fast: true`     | 10    | 10/10         | 10/10         |
| negative sent, `go_fast: true`   | 10    | 10/10         | 10/10         |
| negative sent, `go_fast: false`  | 6     | 6/6           | 6/6           |

Sixteen renders with a direct contradiction of the positive prompt, and no
steering in either direction. `go_fast: true` is production's setting; the
`false` arm rules out accelerated sampling skipping negative conditioning.

Independent corroboration: upstream reporting finds the same across a CFG sweep
of 1.0–7.0 on a different host and toolchain, and gives the mechanism — the model
was not trained on negative conditioning, the parameter exists for pipeline
compatibility, and the official examples pass a single space.

Evidence: `evidence/qwen-2512-negative-canary/`.

**Verdict: transport unsupported.** The dialect now declares it, every exclusion
drops with a recorded reason, and probing the version cannot change that.

## What the canary retired

Trials C through I were designed to test individual blocks through the dedicated
field. They are **void for this endpoint** — a channel that cannot remove an
apple under direct contradiction will not suppress a mannequin or a watermark.
Roughly 200 paid renders not worth buying. They stay in the harness because a
future endpoint with a working field (SD 3.5, PuLID, Pony) needs exactly these
inductions, and the fixtures are the endpoint-neutral half.

## A correction the canary forced

The first A/B reported that the negative-on compass had weaker dial markings, and
proposed Trial E around it. That reading does not survive. Every OFF/ON pair in
every run differs at byte level — including canary pairs where the content is
provably unsteered — so a changed conditioning tensor perturbs the sampling
trajectory without steering it. The compass showed perturbation, not collateral
damage.

The method error worth keeping: a single image pair was read as a block's effect
without a determinism control (the same arm rendered twice at one seed) to
establish what run-to-run variation looks like. That control belongs in any
future per-block trial.

## Trial B — positive-side transports

With the negative field ruled out, the only channels left are the two the plan's
transport vocabulary offers such an endpoint: **affirmative replacement** (say
what the picture should contain, never naming the unwanted thing) and **inline
exclusion** (name it inside the instruction). The plan makes affirmative the
default and requires a fixed A/B before inline is allowed.

Four arms, six paired seeds, two fixtures, no negative field anywhere. The
`production` arm carries the item lane's shipped prompt verbatim, so the
comparison is a real before/after rather than a recollection.

**Support visible — the failure being tested:**

| Arm         | Scarf | Coat |
| ----------- | ----- | ---- |
| production  | 6/6   | 6/6  |
| neutral     | 0/6   | 0/6  |
| affirmative | 0/6   | 0/6  |
| inline      | 0/6   | 1/6  |

**The finding is about the positive prompt, not the negative channel.** The
shipped wording — "presented on an invisible ghost mannequin, holding the
garment's own shape" — put a plainly visible dress form in every one of twelve
renders. The word "invisible" subtracts nothing; naming the mannequin is what
summons it. Wording that names no support at all drops the failure to zero across
both fixtures.

Collateral was clean everywhere: translucency preserved 6/6 in every scarf arm,
coat shape plausible and the authored scorched cuffs retained 6/6 in every coat
arm. No arm traded the mannequin for a collapsed garment, which was the tradeoff
worth watching for.

**Verdicts:**

- **affirmative replacement — inconclusive.** It matches the neutral baseline at
  0/6, but the baseline failure rate was already zero, so it had nothing to
  improve. Not evidence that it works; evidence that it is not needed here.
- **inline exclusion — harmful, weakly.** The one non-production render with a
  visible support is an inline render (coat s103, a mannequin stand below the
  hem). One occurrence at n=6 is not a rate, but it points the same way as the
  production arm: naming the unwanted object raises its probability. Enough to
  keep the plan's default (affirmative first, inline only on evidence) rather
  than promote inline.
- **the neutral wording — adopted.** `ITEM_PRESENTATION.clothing` now says
  "hanging in its own shape with nothing else in the frame, the garment alone".

Evidence: `evidence/qwen-2512-ghost-mannequin/`.

## What stays owner-gated

- whether the negative pack's blocks stay compiled-but-dropped on this endpoint
  or the binding is retired for it. Keeping them costs nothing at render time and
  preserves the provenance record of what a render would have excluded; retiring
  them removes a channel that will never fire. A product call, not an evidence
  one.
- the endpoints that DO have a working negative field — SD 3.5, PuLID, Pony —
  which each need their own canary before any block trial is worth running there.
  The harness carries trials C–I ready for exactly that.
- the ghost-mannequin fix is live in the item lane, but no library item has been
  re-rendered against it. Existing clothing images still show the dress form
  until they are regenerated.
