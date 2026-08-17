# Slice 7 narrator trial — visual state vs. no visual state

Status: **closed — round 1 ran 2026-08-17 and returned no verdict** (invalid
induction, $1.21); the owner closed slice 7 on the mechanism the same day and
the harness stays for a later round. Companion to
[visual-state.plan.md](visual-state.plan.md) §"Slice 7 — narrator proving
release". Harness: `scripts/eval/visual-state-cues/`.

## What we asked

Does giving the narrator two things — a short list of visual facts it **must not
contradict**, plus at most two details that just changed or just came into view —
make it contradict the story's own committed state less often, without making it
repeat itself, read worse, or start describing things the player cannot see?

Both arms are the real product path. The only difference between them is whether
those two blocks reach the prompt.

## Outcome

**Owner ruling (2026-08-17): slice 7 closes on the mechanism, not on a measured
benefit.** The repetition finding below was fixed in the projection, and the
feature shipped as a per-conversation switch that is off by default — something
to turn on for one chat and read, rather than something enabled everywhere on a
directional result.

These numbers are not a verdict and must not be quoted as one. The round did not
fail the feature; it failed to be a measurement. The comparison arm — today's
narrator, with no visual blocks — contradicted the committed state only **0.13
times per exchange**, and the trial's own pre-registered gate needs **0.40**
before it will render a verdict at all. That gate exists because of the
affordance-cue trial, which spent four rounds learning that a control arm with
nothing to get wrong makes any improvement unmeasurable.

## What happened

Ten scenes, three exchanges each, both arms: **30 paired exchanges, 60 narrator
generations, 20 blinded audits, 10 preference calls, $1.21.** All seven
self-checks passed before the first billable call.

| measure (per exchange unless noted) | visual   | control  |
| ----------------------------------- | -------- | -------- |
| contradictions                      | **0.067** | **0.133** |
| repetitions                         | **0.100** | **0.000** |
| static restatements                 | 0.000    | 0.000    |
| specificity (1–5)                   | 4.90     | 4.90     |
| naturalness (1–5)                   | 4.90     | 5.00     |
| newly-revealed detail surfaced      | 5 of 9   | 5 of 9   |

Contradictions by kind, counted as whole events over the round:

| kind                    | visual | control |
| ----------------------- | ------ | ------- |
| posture and orientation | 1      | 4       |
| what she is wearing     | 1      | 0       |
| how it is arranged      | 0      | 0       |
| how wet                 | 0      | 0       |
| describing the unseen   | 0      | 0       |

Advisory preference: **control 6, visual 4.**

Every number above is a whole-event count over 30 exchanges, so one event moves
a rate by 0.033. The contradiction columns are 2 events against 4.

## What is worth believing

**The fence stopped the narrator inventing a body.** Every control-arm
contradiction but one was about posture or orientation: it sat a standing
character on the floor, turned an averted face back toward the player, gave her
eyes that met his while her back was turned. The visual arm did that once. This
is a small sample, but it is the most concentrated signal in the round and it is
exactly what the fence was built to do.

**The trial's own instrument is too weak.** Three of five bait families never
tempted the control arm at all — it never misdescribed clothing arrangement,
never overstated wetness, and never described something covered. Either the
scenes were not tempting enough, or today's narrator is already reliable on
those three and the whole feature has less to fix than assumed. **The round
cannot tell those two apart**, and that is the finding to act on.

**Repetition regressed, and the mechanism is identified.** The visual arm
repeated a physical detail across consecutive exchanges three times; the control
arm never did. Reading the transcripts, the repeated detail is in each case one
the **fence** was carrying: an untucked hem, a coat, a soaked shirt. The fence
deliberately has no cooldown — a coat worn for six exchanges is as
contradictable on the seventh — but the narrator does not read it as a fence. It
reads it as a list of things it is welcome to mention, and mentions them again.
On a valid round this alone would fail the trial's repetition guard.

**The cue block did not earn its slot.** Both arms surfaced the just-revealed
detail on 5 of the 9 exchanges where one was named. Being told the detail was
new made no difference to whether it got used. Specificity was identical at 4.90.

## What changed after the round

**The repetition defect is fixed, in the projection.** The owner's ruling was
that a repetition problem belongs to the visual layer rather than to prompt
wording, and that is where it now lives: the projection records every detail it
offered the narrator, and keeps that family out of the fence for exactly one
exchange afterwards. The fence otherwise still never goes quiet. The window is
the shortest one that works, because a fact absent from the fence is a fact the
narrator is free to contradict — and the single exchange it is absent for is the
one immediately after the narrator described it, the least likely moment for it
to contradict itself.

The deterministic checks confirm the loop is closed: the details cued on the
first exchange of a scene no longer reappear in the second exchange's fence.

**What a round 2 would still need**, if the question ever matters enough to
spend on again: the three bait families that never tempted the control arm —
arrangement, wetness and hidden detail — need scenes that pull much harder
toward the wrong claim, with player lines that assert it outright and more
exchanges per scene so the pressure accumulates. That is a matrix change; it
does not touch the projection or the decision rule.

## What this round cannot say

It cannot say the feature works, and it cannot say it does not. Two events
against four is not a rate, and nothing here should be quoted as one. What the
round *did* establish is narrower and worth keeping: the projection puts correct,
visible-only facts in front of the narrator, never described anything the player
could not see, and cost essentially nothing in how the prose reads. That is a
statement about the machinery, not about the benefit, and it is the basis the
slice closed on.

The one statistical claim it supports is the negative one: whatever this feature
is worth, it is not worth much on the three families the control arm never got
wrong.

## Method

Every scene is built from **committed typed state** — real garment instances
with real arrangement and condition, a `body_surface` wetness entry with its
cause, a real `SceneState` with posture, support, facing and proximity — never
from prose, because prose is what this layer refuses to treat as an input.

Both arms receive identical inputs; the only difference is whether the two
rendered blocks reach the prompt, and a self-check asserts that by rebuilding
the control prompt from the visual one. Generation goes through the production
narrator at production temperature; each arm carries its own history, so
repetition is measured over what that arm actually said.

Judging is split: two **arm-blind** per-arm audits produce the numbers, and one
A/B blinded preference call is advisory. Every violation must carry a verbatim
quote and the runner discards the ones it cannot find in the transcript — zero
were discarded this round.

Full design, flags, induction gate and the frozen decision rule:
`scripts/eval/visual-state-cues/README.md`. The round's machine-readable record
is committed at `scripts/eval/visual-state-cues/results/round-1-2026-08-17.json`.

## Round log

| round | date       | verdict            | spend | note                                       |
| ----- | ---------- | ------------------ | ----- | ------------------------------------------ |
| 1     | 2026-08-17 | invalid_induction  | $1.21 | control 0.13/exchange, 3 of 5 families dry |

Campaign spend to date: **$1.24** (one smoke scenario plus one full round).
