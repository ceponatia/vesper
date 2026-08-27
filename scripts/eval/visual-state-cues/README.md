# Visual-state narrator trial

The owner-gated live comparison for **slice 7** of the visual-state work: does
visual-state narration — a must-not-contradict **fence** plus at most two
change-gated **cues** — reduce contradictions of committed visual state without
costing repetition, naturalness, or hidden-detail discipline?

The harness always builds both arms itself, so it does not read the
per-conversation switch that gates the feature in production.

Round 1 (2026-08-17) ran and returned `invalid_induction`; slice 7 then closed on
the mechanism rather than on a measured benefit, and the feature shipped as a
per-conversation switch that is off by default.

This harness is kept, not retired: the question it asks is still open, and the
matrix is the expensive half of asking it again.

## Run

```bash
pnpm eval:visual-state-cues --dry-run
```

```bash
pnpm eval:visual-state-cues
```

Other flags: `--scenario <substring>` (a single scenario; the five-family
coverage check is skipped so a cheap smoke test is possible), `--no-judge`,
`--out <dir>` (default `data/eval/visual-state-cues`, or `EVAL_OUT`),
`--chat-model`, `--judge-model`, `--concurrency N` (default 3).

`--dry-run` writes `matrix.json`; a live run writes **`trial.json`** (the full
audit: prompts, replies, raw judge answers) **and `summary.json`** (the same
round with the narration removed). `data/` is gitignored, so after a real round
copy `summary.json` to `results/round-<n>-<YYYY-MM-DD>.json` and commit it.

**Not wired into CI, ever.** It spends money and measures a judgment
call. The fixture guard (`harness.test.ts`) *is* pure and runs in `pnpm test`, so
a projection change that breaks the matrix is visible without spending anything.

## Design

**Both arms are the production path.** `buildVisualStateShadow` (assembly,
composition, visibility, attention, selection), `renderChatVisualStateLines`
(the narrator projection) and `buildCharacterChatSystemPrompt` are all the real
functions; the harness assembles only the state slice the database-bound
pipeline would have loaded, and hands the same object to both arms. A self-check
asserts the visual prompt is the control prompt with exactly the two blocks (and
the allowance carve-out) spliced in.

**Bait, not scenery.** Every scenario belongs to a bait family naming the wrong
claim its scene invites — `garment_presence`, `arrangement`, `wetness`,
`body_language`, `hidden_detail` — and arms that bait per exchange. This is the
affordance-cue rematch's lesson inherited: a matrix that never tempts leaves the
treated arm nothing to reduce.

**`sceneFacts` is the both-arms channel.** The narrator prompt carries no wetness
line and no arrangement line outside the visual blocks, so without true scene
detail in the Scene block the control arm could not misdescribe a state it had
never been told about.

**Judging is split.** Two arm-blind per-arm contradiction audits produce the
numbers (a comparative call cannot report an absolute rate); one A/B blinded
preference call is advisory. Every `violated` verdict must carry a verbatim
quote, and the runner **discards violations whose quote it cannot find**.

`hidden_detail` runs the other way from the rest: there the correct behaviour is
silence, and a violation is the narrator describing what the observer cannot see.
`revealed_detail` is not a violation dimension at all — it is the newly-revealed
axis, asked as a positive and **reported, never gated**.

## Induction gate (checked before any verdict)

- control-arm contradictions ≥ **0.40/exchange**, and
- ≥3 of the 5 bait families show ≥1 control-arm violation.

If either fails the run reports `verdict: "invalid_induction"` and renders no
feature verdict. The follow-up iterates the **matrix**, never the projection and
never the decision rule.

## Decision rule (frozen 2026-08-17, before the first billable call)

On a **valid** round, the path passes iff all three guards hold **and** either
track passes.

Guards:

1. visual-arm repetitions exceed control's by ≤ **0.05**/exchange;
2. visual-arm naturalness ≥ control's − **0.25**;
3. visual-arm `hidden_detail` violations ≤ control's — the fence may never make
   leakage worse.

Tracks:

- **contradiction** — visual-arm contradictions ≤ **60%** of control's;
- **specificity** — specificity gain ≥ **0.5** AND contradictions not worse than
  control's.

The two tracks are the plan's "reduced contradictions **or** clearly better
grounded detail without raising repetition". The specificity track requires
contradictions not to regress because the spec's promotion rule is explicit that
**specificity alone cannot pass** — that is exactly how the affordance-cue trial
failed.

Changing any number here requires an owner ruling.

## Caveats

- The narrator runs at production temperature and OpenRouter exposes no seed, so
  generation is **not** reproducible. Everything upstream of the model call is
  deterministic: same fixtures, same reads, same lines, same prompts, same A/B
  blinding.
- A round is a *directional* sample. 30 paired exchanges means a per-exchange
  rate moves in steps of 0.033; treat a gap of a few hundredths as noise.
- The audit is one model. Blinding, per-exchange ground truth and quote
  verification guard against label bias and invention, not against a systematic
  blind spot shared across its calls.
- There is **no byte-identical silence control** here, unlike the affordance
  trial. The fence fires whenever anything is visible, so the arms always differ
  by at least the fence. The preference call's own split is the only label-noise
  read available.
